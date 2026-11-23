'use strict';

/**
 * PIPELINE APPLICATION SERVICE
 * Servicio de aplicación que encadena en orden:
 *   ComprensionIntelligence → PotenciacionIntelligence → ContextualIntelligence → Modelo Agora
 *
 * Responsabilidad:
 *   - Coordinar las 4 Inteligencias sobre el CognitiveState.
 *   - Usar OrchestratorService para Modelo Agora (contratos, gates, HITL, BudgetPolicy).
 *   - Aplicar PromotionPolicy y AuthorityPolicy en las Inteligencias previas al Agora.
 *   - Persistir commits y eventos en cada fase.
 *   - Detenerse ante gates bloqueantes o fallos de PromotionPolicy.
 *   - Permitir reanudación desde el último estado válido (checkpointEtapa en state).
 *
 * No implementa paralelismo (P-03 diferido).
 * No construye APIs ni frontend.
 *
 * Ref: Roadmap Fase 5 — tarea 5.1; Engineering Blueprint Cap. 5.
 */

const { PromotionPolicy, PROMOTION_STATUS } = require('../policy/PromotionPolicy');
const { STAGE_RESULT }                       = require('../orchestrator/OrchestratorService');

// Etapas propias del pipeline de aplicación (previas al Modelo Agora)
const PRE_AGORA_STAGES = Object.freeze(['comprension', 'potenciacion', 'contextual']);

// Estados de resultado del pipeline de aplicación
const PIPELINE_STATUS = Object.freeze({
  COMPLETED:       'completed',
  PAUSED_HITL:     'paused_hitl',
  STOPPED_GATE:    'stopped_gate',
  STOPPED_BUDGET:  'stopped_budget',
  STOPPED_ERROR:   'stopped_error',
  RESUMED:         'resumed',
});

class PipelineApplicationService {
  /**
   * @param {object} config
   * @param {CognitiveStateService}      config.stateService
   * @param {OrchestratorService}        config.orchestrator
   * @param {ComprensionIntelligence}    config.comprension
   * @param {PotenciacionIntelligence}   config.potenciacion
   * @param {ContextualIntelligence}     config.contextual
   * @param {Function}                   config.agoraExecutor  — executor del Modelo Agora (AgoraStages.execute)
   * @param {object}                     [config.contextualInputs] — fuentes inyectables para ContextualIntelligence
   */
  constructor({
    stateService,
    orchestrator,
    comprension,
    potenciacion,
    contextual,
    agoraExecutor,
    contextualInputs = null,
    llmService       = null,   // opcional — para llmStats en observabilitySnapshot
  }) {
    if (!stateService)  throw new Error('PipelineApplicationService: stateService es requerido');
    if (!orchestrator)  throw new Error('PipelineApplicationService: orchestrator es requerido');
    if (!comprension)   throw new Error('PipelineApplicationService: comprension es requerido');
    if (!potenciacion)  throw new Error('PipelineApplicationService: potenciacion es requerido');
    if (!contextual)    throw new Error('PipelineApplicationService: contextual es requerido');
    if (!agoraExecutor || typeof agoraExecutor !== 'function')
      throw new Error('PipelineApplicationService: agoraExecutor debe ser función');

    this._svc            = stateService;
    this._orch           = orchestrator;
    this._comprension    = comprension;
    this._potenciacion   = potenciacion;
    this._contextual     = contextual;
    this._agoraExecutor  = agoraExecutor;
    this._contextInputs  = contextualInputs;
    this._llmService     = llmService;   // opcional — LLMService para métricas
    this._log            = [];   // historial auditable de la ejecución completa
  }

  // ── Entrada principal ──────────────────────────────────────────────────────

  /**
   * Ejecuta el pipeline completo o lo reanuda desde el último checkpoint.
   *
   * @param {string}  sesionId
   * @param {string}  [expertoId]
   * @returns {Promise<PipelineResult>}
   */
  async run(sesionId, expertoId = null) {
    // Cargar o crear el estado
    let state = this._svc.loadState(sesionId)
              ?? this._svc.createSession(sesionId, expertoId);

    // Determinar desde qué etapa reanudar
    const checkpoint = state.pipelineCheckpoint || null;
    const etapaInicio = checkpoint ? this._nextAfter(checkpoint) : 'comprension';

    this._log = [];
    return this._execute(state, etapaInicio);
  }

  // ── Ejecución interna ──────────────────────────────────────────────────────

  async _execute(state, etapaInicio) {
    const etapasOrden = [...PRE_AGORA_STAGES, 'agora'];
    const inicio      = etapasOrden.indexOf(etapaInicio);
    const plan        = etapasOrden.slice(inicio >= 0 ? inicio : 0);

    for (const etapa of plan) {
      let result;
      if (etapa === 'agora') {
        result = await this._runAgora(state);
      } else {
        const _t0 = Date.now();
        const _corrId = `${etapa}_${_t0}`;
        result = await this._runPreAgora(state, etapa);
        result = { ...result, duracionMs: Date.now() - _t0, correlationId: _corrId };
      }

      this._log.push({ etapa, ...result });

      if (result.status !== PIPELINE_STATUS.COMPLETED) {
        return this._buildResult(result.status, state, result.razon);
      }
    }

    return this._buildResult(PIPELINE_STATUS.COMPLETED, state, 'Pipeline completo');
  }

  // ── Fase pre-Agora (Comprensión → Potenciación → Contextual) ──────────────

  async _runPreAgora(state, etapa) {
    let output, errores;

    try {
      switch (etapa) {
        case 'comprension': {
          ({ knowledgeGraph: output, errores } = await this._comprension.comprend(state));
          if (!output) return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: `Comprensión falló: ${errores.join('; ')}` };
          // PromotionPolicy — el KG provisional siempre puede asignarse (status provisional es válido)
          // Incremento 1 (Grafo de Conocimiento vivo): se escribe en
          // knowledgeGraphReconstruido, NUNCA en knowledgeGraph — ese campo
          // es el grafo vivo canónico construido durante EXPLORANDO; esta
          // reconstrucción offline es un objeto separado a propósito, para
          // que ComprensionIntelligence nunca sustituya, sobrescriba ni
          // compita con el estado canónico (frontera aprobada).
          state.knowledgeGraphReconstruido = output;
          this._svc.commit(state, 'ComprensionIntelligence completada');
          this._markCheckpoint(state, 'comprension');
          return { status: PIPELINE_STATUS.COMPLETED };
        }

        case 'potenciacion': {
          const kg = state.knowledgeGraphReconstruido;
          if (!kg) return { status: PIPELINE_STATUS.STOPPED_GATE, razon: 'Potenciación requiere knowledgeGraphReconstruido — ejecuta comprensión primero' };
          ({ enhancedKnowledge: output, errores } = await this._potenciacion.potenciar(kg, state));
          if (!output) return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: `Potenciación falló: ${errores.join('; ')}` };
          // PromotionPolicy: EK sin propuestas → aprueba directamente
          const promoResult = this._potenciacion.promote(output, state);
          if (promoResult.status === PROMOTION_STATUS.REJECTED && output.propuestas.length > 0) {
            // Hay propuestas pendientes de decisión → HITL implícito
            state.enhancedKnowledge = output;
            this._svc.commit(state, 'PotenciacionIntelligence — propuestas pendientes de aprobación');
            this._markCheckpoint(state, 'potenciacion');
            return { status: PIPELINE_STATUS.PAUSED_HITL, razon: promoResult.razon };
          }
          state.enhancedKnowledge = output;
          this._svc.commit(state, 'PotenciacionIntelligence completada');
          this._markCheckpoint(state, 'potenciacion');
          return { status: PIPELINE_STATUS.COMPLETED };
        }

        case 'contextual': {
          const fakeGate = { outcome: 'approved', bloqueante: false, razon: 'ContextModel válido', detalles: [] };
          const promotion = PromotionPolicy.evaluatePromotion('contextual', state, fakeGate);
          if (promotion.status === PROMOTION_STATUS.REJECTED && state._error) {
            return { status: PIPELINE_STATUS.STOPPED_GATE, razon: promotion.razon };
          }
          ({ contextModel: output, errores } = await this._contextual.analizar(
            state, state.knowledgeGraphReconstruido, state.enhancedKnowledge, this._contextInputs
          ));
          if (!output) return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: `Contextual falló: ${errores.join('; ')}` };
          // Auto-promover si tiene fuentes; si no, se registra provisional sin bloquear
          state.contexto = output;
          this._svc.commit(state, 'ContextualIntelligence completada');
          this._markCheckpoint(state, 'contextual');
          return { status: PIPELINE_STATUS.COMPLETED };
        }

        default:
          return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: `Etapa pre-Agora desconocida: ${etapa}` };
      }
    } catch (e) {
      return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: `Error en ${etapa}: ${e.message}` };
    }
  }

  // ── Fase Modelo Agora ──────────────────────────────────────────────────────

  async _runAgora(state) {
    // El Orquestador ya tiene su plan configurado; ejecutar desde la etapa actual o desde el inicio
    const desde = state.agoraCheckpoint || null;
    if (desde) {
      this._orch.buildPartialPlan(this._remainingAgoraStages(desde));
    } else {
      this._orch.buildPlan('inferencia'); // las 5 gramáticas son pre-pipeline; Agora comienza en inferencia
    }

    const history = await this._orch.run(state, this._agoraExecutor);

    const lastResult = history[history.length - 1];

    // Detectar HITL
    const hitlPaused = history.find(h => h.result === STAGE_RESULT.HITL_PAUSED);
    if (hitlPaused) {
      state.agoraCheckpoint = hitlPaused.etapa;
      this._svc.commit(state, `Modelo Agora pausado en HITL: ${hitlPaused.etapa}`);
      return { status: PIPELINE_STATUS.PAUSED_HITL, razon: hitlPaused.razon, history };
    }

    const gateFailed = history.find(h => h.result === STAGE_RESULT.GATE_FAILED);
    if (gateFailed) {
      return { status: PIPELINE_STATUS.STOPPED_GATE, razon: gateFailed.razon, history };
    }

    const budgetEx = history.find(h => h.result === STAGE_RESULT.BUDGET_EXHAUSTED);
    if (budgetEx) {
      return { status: PIPELINE_STATUS.STOPPED_BUDGET, razon: budgetEx.razon, history };
    }

    const error = history.find(h => h.result === STAGE_RESULT.ERROR);
    if (error) {
      return { status: PIPELINE_STATUS.STOPPED_ERROR, razon: error.razon, history };
    }

    // Limpiar checkpoint Agora si completó
    state.agoraCheckpoint = null;
    this._markCheckpoint(state, 'agora');
    return { status: PIPELINE_STATUS.COMPLETED, history };
  }

  // ── Entrada directa al Modelo Agora (Task 6.5B2B) ────────────────────────────

  /**
   * Ejecuta el Modelo Agora directamente desde inferencia, omitiendo las etapas
   * pre-Agora (comprension, potenciacion, contextual).
   * Requiere los 16 slots llenos en el estado ya persistido.
   * @param {string} sesionId
   * @param {object} [opts]
   * @param {string|null} [opts.idempotencyKey] — clave de correlación estable
   *   por sesión (Incremento 7d, corrección post-revisión — normalmente el
   *   turnoId que confirmó la última gramática). Se registra en el log de
   *   ejecución y en el resultado para auditar/correlacionar reintentos —
   *   NO deduplica llamadas al proveedor LLM: LLMService/Anthropic no
   *   ofrecen una clave de idempotencia real en ese punto. La garantía de
   *   "una sola solicitud lógica" vive en el outbox (sesion_id como clave
   *   primaria), no aquí — esta clave es para trazabilidad, no un mecanismo
   *   de deduplicación de efectos externos.
   * @returns {Promise<PipelineResult>}
   */
  async runFromAgora(sesionId, { idempotencyKey = null } = {}) {
    const { countFilledSlots, ALL_SLOT_KEYS } = require('../schemas/AgoraSlots');
    const state = this._svc.loadState(sesionId)
                ?? this._svc.createSession(sesionId, null);

    // Validar slots completos antes de entrar al Modelo Agora
    const filled = countFilledSlots(state.slots);
    if (filled < ALL_SLOT_KEYS.length) {
      const faltantes = ALL_SLOT_KEYS.filter(k => !state.slots[k] || !String(state.slots[k]).trim());
      return this._buildResult('stopped_gate', state,
        `Slots incompletos para iniciar el Modelo Agora. Faltan: ${faltantes.join(', ')}`, { idempotencyKey });
    }

    this._log = [];
    // Marcar checkpoint: las etapas pre-Agora se consideran completadas
    this._markCheckpoint(state, 'contextual');
    this._svc.commit(state, `Inicio directo en Modelo Agora (startFrom=agora)${idempotencyKey ? ` [idempotencyKey=${idempotencyKey}]` : ''}`);

    const agoraResult = await this._runAgora(state);
    this._log.push({ etapa: 'agora', idempotencyKey, ...agoraResult });

    if (agoraResult.status !== PIPELINE_STATUS.COMPLETED) {
      return this._buildResult(agoraResult.status, state, agoraResult.razon, { idempotencyKey });
    }
    return this._buildResult(PIPELINE_STATUS.COMPLETED, state, 'Pipeline completo (startFrom=agora)', { idempotencyKey });
  }

  // preloadSlots() retirado — Incremento 8 (segunda autoridad de escritura
  // de slots). Permitía a un cliente HTTP (POST /pipeline con slots en el
  // body) inyectar directamente los 16 slots canónicos, en paralelo a
  // /grammar-turn. Sin consumidor de producción demostrado (build_bridge.js
  // nunca lo usó). runFromAgora() lee exclusivamente los slots ya
  // persistidos por /grammar-turn — no hay ningún camino restante que
  // permita a un cliente ordenar una escritura de slots fuera de esa ruta.

  // ── Reanudación ────────────────────────────────────────────────────────────

  /**
   * Reanuda el pipeline desde una sesión persistida.
   * Equivale a run() pero parte del estado persistido.
   */
  async resume(sesionId) {
    const state = this._svc.loadState(sesionId);
    if (!state) throw new Error(`PipelineApplicationService.resume: sesión '${sesionId}' no encontrada`);
    const checkpoint = state.pipelineCheckpoint || null;
    const etapaInicio = checkpoint ? this._nextAfter(checkpoint) : 'comprension';
    this._log = [];
    return this._execute(state, etapaInicio);
  }

  // ── Auditoría ──────────────────────────────────────────────────────────────

  get executionLog() { return [...this._log]; }

  /**
   * Snapshot de observabilidad — reúne datos disponibles sin exponer internos.
   * Usado por GET /audit para construir el reporte consolidado.
   */
  observabilitySnapshot() {
    const { extractLlmStats } = require('./PipelineObservabilityReport');
    return {
      pipelineLog:    [...this._log],
      orchestratorLog:this._orch?.executionLog || [],
      budgetSnapshot: this._orch?.budgetSnapshot || null,
      llmStats:       extractLlmStats(this._llmService),   // null si no fue inyectado
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _markCheckpoint(state, etapa) {
    state.pipelineCheckpoint = etapa;
    // No llamamos commit aquí — el caller ya lo hizo
  }

  _nextAfter(etapa) {
    const orden = [...PRE_AGORA_STAGES, 'agora'];
    const idx   = orden.indexOf(etapa);
    return idx >= 0 && idx < orden.length - 1 ? orden[idx + 1] : 'comprension';
  }

  _remainingAgoraStages(desde) {
    const agoraOrder = [
      'inferencia','opciones','arquitectura','evidencia',
      'forma','desarrollo','bonus','blueprint',
    ];
    const idx = agoraOrder.indexOf(desde);
    return idx >= 0 ? agoraOrder.slice(idx) : agoraOrder;
  }

  _buildResult(status, state, razon, extra = {}) {
    return Object.freeze({
      status,
      razon,
      sesionId:         state.sesionId,
      etapaAlcanzada:   state.pipelineCheckpoint || null,
      // Incremento 1: este campo alimenta result.knowledgeGraph → ApiDTOs
      // hasKnowledgeGraph — deriva de la reconstrucción offline (frontera
      // aprobada), nunca del grafo vivo canónico.
      knowledgeGraph:   state.knowledgeGraphReconstruido || null,
      enhancedKnowledge:state.enhancedKnowledge || null,
      contexto:         state.contexto          || null,
      formaProducto:    state.formaProducto     || null,
      desarrolloResultados: state.desarrolloResultados || [],
      log:              [...this._log],
      ...extra,          // p.ej. idempotencyKey (Incremento 7d, correlación de reintentos)
      _state:           state,   // referencia al CognitiveState — para StateDTO en la API
    });
  }
}

module.exports = { PipelineApplicationService, PIPELINE_STATUS, PRE_AGORA_STAGES };
