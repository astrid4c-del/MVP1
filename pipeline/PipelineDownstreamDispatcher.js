'use strict';

/**
 * PIPELINE DOWNSTREAM DISPATCHER
 * Ejecución del downstream solicitado por DownstreamTriggerPolicy —
 * Incremento 7d, corrección post-revisión.
 *
 * Reemplaza a PipelineDownstreamRunner: aquella versión solo ofrecía un
 * despacho inmediato en memoria, invocado una vez desde el writer — si el
 * proceso caía entre el commit de "pending" y esa invocación, nadie volvía
 * a ejecutar el downstream. Esta versión separa con claridad dos caminos
 * que comparten la misma reclamación atómica (SqliteDownstreamOutboxRepository):
 *
 *   - despacharInmediato(sesionId): optimización de latencia — se llama justo
 *     después del commit del writer. Es SOLO eso, una optimización: si
 *     pierde la reclamación (alguien más la tiene) no hace nada, y si el
 *     proceso muere antes de que esta llamada siquiera ocurra, la solicitud
 *     sigue durable en el outbox.
 *   - recuperarPendientes(): barrido explícito — se invoca al arrancar el
 *     servidor y, en tests, directamente. Encuentra sesiones con solicitud
 *     'pending', 'fallido' (reintentable), o 'claimed' abandonada (el
 *     proceso que la reclamó murió antes de resolverla — se detecta por
 *     antigüedad de claimed_at, sin heartbeats ni infraestructura extra) y
 *     las ejecuta. Sin polling continuo: es una función invocable, no un loop.
 *
 * La reclamación en sí (pending|fallido|claimed-abandonado → claimed) ocurre
 * en un único UPDATE...WHERE dentro de SqliteDownstreamOutboxRepository —
 * eso es lo que garantiza que, entre cualquier número de dispatchers
 * compitiendo (mismo proceso, procesos distintos, inmediato vs recuperación),
 * solo uno gane por cada intento de reclamación.
 *
 * Alcance real de "exactamente una vez" (para no prometer de más): se
 * garantiza reclamación única durable por intento, y una única fila lógica
 * de solicitud por sesión (sesion_id es PK del outbox). NO se garantiza que
 * el proveedor LLM subyacente sea idempotente ante un reintento — Anthropic
 * no ofrece una clave de deduplicación de llamadas. turnoId (el Turno que
 * confirmó DAR VIDA) se usa como clave de correlación estable por sesión —
 * se pasa a PipelineApplicationService.runFromAgora para auditoría/logging
 * de reintentos, no como promesa de deduplicación de efectos externos.
 */

const { createEvent } = require('../schemas/Event');

const LEASE_ABANDONO_MS = 2 * 60 * 1000; // umbral para considerar 'claimed' abandonado (proceso caído)

function generarDispatcherId() {
  return `disp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

class PipelineDownstreamDispatcher {
  /**
   * @param {object} config
   * @param {import('../state/CognitiveStateService').CognitiveStateService} config.stateService
   * @param {import('../events/EventBus').EventBus} config.eventBus
   * @param {import('../persistence/SqliteDownstreamOutboxRepository').SqliteDownstreamOutboxRepository} config.outboxRepository
   * @param {(sesionId: string) => import('./PipelineApplicationService').PipelineApplicationService} config.pipelineServiceFactory
   *   — el downstream de cada sesión corre con SU PROPIO pipelineService
   *   (ver CognitiveSessionRegistry): este dispatcher es único y compartido
   *   entre sesiones, así que recibe una fábrica en vez de una instancia fija.
   * @param {string} [config.dispatcherId] — identidad de este dispatcher para
   *   claimed_by (auditoría de qué proceso/instancia ejecutó qué). Por
   *   defecto, única por proceso.
   */
  constructor({ stateService, eventBus, outboxRepository, pipelineServiceFactory, dispatcherId }) {
    if (!stateService) throw new Error('PipelineDownstreamDispatcher: stateService es requerido.');
    if (!eventBus) throw new Error('PipelineDownstreamDispatcher: eventBus es requerido.');
    if (!outboxRepository) throw new Error('PipelineDownstreamDispatcher: outboxRepository es requerido.');
    if (typeof pipelineServiceFactory !== 'function')
      throw new Error('PipelineDownstreamDispatcher: pipelineServiceFactory debe ser una función.');

    this._svc = stateService;
    this._bus = eventBus;
    this._outbox = outboxRepository;
    this._pipelineServiceFactory = pipelineServiceFactory;
    this._dispatcherId = dispatcherId || generarDispatcherId();
  }

  get dispatcherId() { return this._dispatcherId; }

  /** Optimización inmediata — ver nota de cabecera. Nunca lanza. */
  async despacharInmediato(sesionId) {
    return this._intentarReclamarYEjecutar(sesionId);
  }

  /**
   * Barrido de recuperación — ver nota de cabecera. Invocable al arrancar
   * el servidor y explícitamente desde tests. No hace polling por su cuenta:
   * una llamada, un barrido.
   * @returns {{ candidatos:number, recuperadas:number }}
   */
  async recuperarPendientes({ limite = 50 } = {}) {
    const staleBeforeIso = this._umbralAbandono();
    const candidatos = this._outbox.listarReclamables({ limite, staleBeforeIso });
    let recuperadas = 0;
    for (const sesionId of candidatos) {
      const gano = await this._intentarReclamarYEjecutar(sesionId);
      if (gano) recuperadas++;
    }
    return { candidatos: candidatos.length, recuperadas };
  }

  _umbralAbandono() {
    return new Date(Date.now() - LEASE_ABANDONO_MS).toISOString();
  }

  /**
   * Único punto que reclama y ejecuta. La reclamación (this._outbox.reclamar)
   * es la operación atómica real — un UPDATE...WHERE de una sola sentencia,
   * serializado por SQLite incluso entre conexiones de procesos distintos.
   * Todo lo demás en este método solo se alcanza si ESTE llamado ganó.
   * @returns {boolean} true si este llamado reclamó y procesó la sesión
   *   (con éxito o con fallo — "true" es "yo fui quien lo tomó", no "salió bien").
   */
  async _intentarReclamarYEjecutar(sesionId) {
    const gano = this._outbox.reclamar(sesionId, this._dispatcherId, this._umbralAbandono());
    if (!gano) return false; // otro proceso/dispatcher ya lo tiene — no es un error, es el diseño

    const registro = this._outbox.obtener(sesionId);
    this._bus.emit(createEvent({
      tipo: 'downstream.claimed', sesionId,
      payload: { claimedBy: this._dispatcherId, intentos: registro ? registro.intentos : null },
    }));

    const state = this._svc.loadState(sesionId);
    if (!state) {
      // Sesión inexistente (no debería ocurrir: el outbox se registra en la
      // misma transacción que crea el estado) — se marca fallido para no
      // dejar una reclamación colgada, sin intentar ejecutar nada.
      this._outbox.marcarFallido(sesionId);
      return true;
    }

    this._transicionarEstado(state, 'ejecutando', 'downstream.started', {});

    const pipelineService = this._pipelineServiceFactory(sesionId);
    // Clave de correlación estable por sesión — ver límite real de
    // idempotencia en la nota de cabecera del archivo.
    const idempotencyKey = registro ? registro.turnoId : sesionId;

    let resultado;
    try {
      resultado = await pipelineService.runFromAgora(sesionId, { idempotencyKey });
    } catch (e) {
      const estadoFresco = this._svc.loadState(sesionId) || state;
      this._transicionarEstado(estadoFresco, 'fallido', 'downstream.failed', { razon: e.message });
      this._outbox.marcarFallido(sesionId);
      return true;
    }

    const estadoFresco = this._svc.loadState(sesionId) || state;
    if (resultado.status === 'completed') {
      const envelope = {
        sessionId: sesionId,
        requestId: idempotencyKey,
        status: 'completed',
        completedAt: new Date().toISOString(),
        outputType: 'AGORA_PIPELINE_RESULT',
        outputRef: { sesionId, pipelineCheckpoint: resultado.etapaAlcanzada || 'agora' },
        payload: {
          knowledgeGraph: resultado.knowledgeGraph || null,
          enhancedKnowledge: resultado.enhancedKnowledge || null,
          contexto: resultado.contexto || null,
          formaProducto: resultado.formaProducto || null,
          desarrolloResultados: resultado.desarrolloResultados || [],
        },
      };
      estadoFresco.downstreamResult = envelope;
      this._transicionarEstado(estadoFresco, 'completado', 'downstream.completed', {});
      this._outbox.marcarCompletado(sesionId);
    } else if (resultado.status === 'paused_hitl') {
      // Límite conocido, documentado desde el diseño original (Incremento
      // 7d): la reanudación HITL vía /pipeline{resume:true} no está cableada
      // a esta transición — pipelineStatus se queda en 'ejecutando' y la
      // fila del outbox en 'claimed' hasta que se resuelva o quede
      // suficientemente vieja para que un barrido futuro la retome.
    } else {
      this._transicionarEstado(estadoFresco, 'fallido', 'downstream.failed', { razon: resultado.razon || resultado.status });
      this._outbox.marcarFallido(sesionId);
    }
    return true;
  }

  _transicionarEstado(state, nuevoStatus, tipoEvento, datosExtra) {
    const anterior = state.pipelineStatus;
    state.pipelineStatus = nuevoStatus;
    this._svc.commit(state, `Downstream: ${anterior} → ${nuevoStatus}`);
    this._bus.emit(createEvent({
      tipo: tipoEvento, sesionId: state.sesionId,
      payload: { anterior, nuevo: nuevoStatus, ...datosExtra },
    }));
  }
}

module.exports = { PipelineDownstreamDispatcher };
