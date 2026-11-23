'use strict';

/**
 * API DTOs
 * Estructuras de respuesta canónicas de la API del Motor Cognitivo.
 * Los handlers solo construyen estas estructuras — nunca exponen entidades internas.
 * Ref: Principio de Invisibilidad; Ley de Contrato entre Etapas.
 */

// ── Respuesta OK ──────────────────────────────────────────────────────────────

function okResponse(data) {
  return { ok: true, data };
}

// ── Respuesta de error estructurada ──────────────────────────────────────────

function errorResponse(code, message, detalles = null) {
  const r = { ok: false, error: { code, message } };
  if (detalles !== null) r.error.detalles = detalles;
  return r;
}

// ── DTO de CognitiveState (sin entidades mutables ni campos efímeros) ─────────

function stateDTO(state) {
  if (!state) return null;

  // Copias serializables de objetos downstream (null-safe, sin referencias mutables)
  const arquitecturaElegida = state.arquitecturaElegida
    ? JSON.parse(JSON.stringify(state.arquitecturaElegida)) : null;
  const evidenciasModulos = Array.isArray(state.evidenciasModulos)
    ? JSON.parse(JSON.stringify(state.evidenciasModulos)) : [];
  const formaProducto = state.formaProducto
    ? JSON.parse(JSON.stringify(state.formaProducto)) : null;
  const desarrolloResultados = Array.isArray(state.desarrolloResultados)
    ? JSON.parse(JSON.stringify(state.desarrolloResultados)) : [];
  const bonus = state.bonus
    ? JSON.parse(JSON.stringify(state.bonus)) : null;
  const avatarInferido = state.avatarInferido && Object.keys(state.avatarInferido).length > 0
    ? JSON.parse(JSON.stringify(state.avatarInferido)) : null;
  const promesaInferida = state.promesaInferida
    ? JSON.parse(JSON.stringify(state.promesaInferida)) : null;
  const downstreamResult = state.downstreamResult
    ? JSON.parse(JSON.stringify(state.downstreamResult)) : null;

  return {
    // Campos existentes (compatibilidad)
    sesionId:          state.sesionId,
    expertoId:         state.expertoId      || null,
    versionId:         state.versionId,
    etapaActual:       state.etapaActual,
    pipelineCheckpoint:state.pipelineCheckpoint || null,
    agoraCheckpoint:   state.agoraCheckpoint    || null,
    slots:             { ...state.slots },
    avatarElegido:     state.avatarElegido   ? JSON.parse(JSON.stringify(state.avatarElegido))  : null,
    promesaElegida:    state.promesaElegida  ? JSON.parse(JSON.stringify(state.promesaElegida)) : null,
    // Incremento 1 (Grafo de Conocimiento vivo): state.knowledgeGraph es
    // ahora el grafo vivo canónico, no-null desde el primer turno — este
    // flag conserva su significado heredado ("¿ComprensionIntelligence ya
    // corrió?"), así que deriva de knowledgeGraphReconstruido, nunca del
    // grafo vivo.
    hasKnowledgeGraph: !!state.knowledgeGraphReconstruido,
    hasEnhancedKnowledge: !!state.enhancedKnowledge,
    hasContexto:       !!state.contexto,
    hasFormaProducto:  !!state.formaProducto,
    desarrolloModulos: (state.desarrolloResultados || []).length,
    actualizadoEn:     state.actualizadoEn,
    creadoEn:          state.creadoEn,
    // Campos downstream del Modelo Agora (Task 6.5B2C)
    avatarInferido,
    promesaInferida,
    arquitecturaElegida,
    evidenciasModulos,
    formaProducto,
    desarrolloResultados,
    bonus,
    downstreamResult,
  };
}

// ── DTO de sesión (estado canónico — Incremento 5) ────────────────────────────
// Deliberadamente DISTINTO de stateDTO: stateDTO es el DTO legado de
// depuración/pipeline (banderas hasX, checkpoints, campos downstream de
// Agora). sessionDTO es la lectura mínima de la memoria durable que
// InteraccionCognitivaWriter ya mantiene — usa exactamente los nombres de
// CognitiveState.js, sin inventar una segunda semántica de estado.

function sessionDTO(state) {
  if (!state) return null;
  return {
    sesionId:              state.sesionId,
    gramaticaActiva:       state.gramaticaActiva,
    gramaticasCompletadas: [...(state.gramaticasCompletadas || [])],
    status:                state.status,
    pipelineStatus:        state.pipelineStatus,
    slots:                 { ...state.slots },
    versionId:             state.versionId,
    versionPreviaId:       state.versionPreviaId || null,
    creadoEn:              state.creadoEn,
    actualizadoEn:         state.actualizadoEn,
    downstreamResult:       state.downstreamResult ? JSON.parse(JSON.stringify(state.downstreamResult)) : null,
  };
}

// ── DTO de Turno (transcript — Incremento 5) ──────────────────────────────────
// Copia serializable de un Turno persistido (que ya viene Object.freeze()ado
// desde SqliteTurnoRepository) — nunca el objeto interno original, para que
// mutar la respuesta HTTP no pueda tocar el historial real.

function turnoDTO(turno) {
  return {
    turnoId:               turno.turnoId,
    sesionId:               turno.sesionId,
    turnoClienteId:         turno.turnoClienteId || null,
    numeroDeTurno:          turno.numeroDeTurno,
    gramatica:              turno.gramatica,
    etapaCognitivaAsociada: turno.etapaCognitivaAsociada,
    mensajeExperto:         turno.mensajeExperto,
    mensajeCirculo:         turno.mensajeCirculo,
    aportesBrutos:          { ...turno.aportesBrutos },
    creadoEn:               turno.creadoEn,
  };
}

// ── DTO de resultado del pipeline ─────────────────────────────────────────────

function pipelineResultDTO(result) {
  return {
    status:            result.status,
    razon:             result.razon    || null,
    sesionId:          result.sesionId || null,
    etapaAlcanzada:    result.etapaAlcanzada || null,
    hasKnowledgeGraph: !!result.knowledgeGraph,
    hasEnhancedKnowledge: !!result.enhancedKnowledge,
    hasContexto:       !!result.contexto,
    hasFormaProducto:  !!result.formaProducto,
    desarrolloModulos: (result.desarrolloResultados || []).length,
    log:               (result.log || []).map(l => ({ etapa: l.etapa, status: l.status })),
    // StateDTO incrustado: elimina la segunda llamada GET /state del cliente
    // Si _state no está disponible (respuesta antigua), el campo es null (fallback compatible).
    state:             result._state ? stateDTO(result._state) : null,
  };
}

// ── DTO de turno de gramática (Task 1 — /grammar-turn) ────────────────────────
// Forma exacta que espera sendMsg() de v0: mensaje/entendido/proponiendo_cierre
// + completeFlag (nombre del flag, p.ej. "destino_completo") + completed (boolean).

// DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — entradaRegistrada/
// procesamientoCompletado/respuestaGenerada/causa/errorCategory/retryable/
// turnoClienteId/turnoId: contrato de fallo explícito, nunca `ok:true` como
// equivalente de "procesamiento exitoso". Cuando el caller no los provee
// (callers legado que todavía no conocen este contrato), los tres booleanos
// caen a `true` — el único valor compatible con "esto siempre fue un éxito"
// antes de que este campo existiera; nunca `false` por defecto, que
// fabricaría un fallo que nadie reportó.
function grammarTurnDTO({
  mensaje, entendido, proponiendoCierre, completeFlag, completed,
  entradaRegistrada = true, procesamientoCompletado = true, respuestaGenerada = true,
  causa = null, errorCategory = null, retryable = null,
  turnoClienteId = null, turnoId = null,
}) {
  return {
    mensaje,
    entendido: { ...entendido },
    proponiendo_cierre: !!proponiendoCierre,
    completeFlag,
    completed: !!completed,
    entradaRegistrada: !!entradaRegistrada,
    procesamientoCompletado: !!procesamientoCompletado,
    respuestaGenerada: !!respuestaGenerada,
    causa,
    errorCategory,
    retryable,
    turnoClienteId,
    turnoId,
  };
}

// ── DTO de evento ─────────────────────────────────────────────────────────────

function eventDTO(ev) {
  return {
    id:            ev.id,
    tipo:          ev.tipo,
    sesionId:      ev.sesionId,
    versionId:     ev.versionId    || null,
    correlationId: ev.correlationId || null,
    payload:       ev.payload      || {},
    creadoEn:      ev.creadoEn,
  };
}

// ── DTO de auditoría ──────────────────────────────────────────────────────────

const { buildObservabilityReport } = require('../pipeline/PipelineObservabilityReport');

function auditDTO(sesionId, state, events, observabilityParams = null) {
  const byType = {};
  (events || []).forEach(ev => {
    byType[ev.tipo] = (byType[ev.tipo] || 0) + 1;
  });

  return {
    sesionId,
    versionActual:     state ? state.versionId  : null,
    etapaActual:       state ? state.etapaActual : null,
    pipelineCheckpoint:state ? (state.pipelineCheckpoint || null) : null,
    agoraCheckpoint:   state ? (state.agoraCheckpoint    || null) : null,
    totalEventos:      (events || []).length,
    eventosPorTipo:    byType,
    decisiones:        (state?.decisiones  || []).map(d => ({ id:d.id, etapa:d.etapa, estado:d.estado, autoridad:d.autoridad })),
    evidencias:        (state?.evidencias  || []).map(e => ({ id:e.id, tipo:e.tipo,   confianza:e.confianza })),
    materialesPendientes: state?.materialesPendientes || [],
    ultimosEventos:    (events || []).slice(-10).map(eventDTO),
    // Reporte de observabilidad consolidado (disponible cuando se pasan parámetros extra)
    observabilidad: observabilityParams
      ? buildObservabilityReport({ state, events: events || [], ...observabilityParams })
      : null,
  };
}

// ── Diagnóstico del Alpha (herramienta interna — ver nota en CognitivoApiServer) ──

/**
 * GET /sessions — resumen mínimo por sesión, reutilizando exclusivamente
 * datos ya persistidos (stateRepo.listSessions/load, turnoRepo.countBySesion).
 * No agrega ninguna tabla ni campo nuevo.
 */
function sessionSummaryDTO(state, totalTurnos) {
  if (!state) return null;
  return {
    sesionId:        state.sesionId,
    gramaticaActiva: state.gramaticaActiva,
    status:          state.status,
    totalTurnos:     totalTurnos,
    actualizadoEn:   state.actualizadoEn,
  };
}

/**
 * GET /diagnostico/:sessionId — deriva latencia y resultado de cada llamada
 * LLM emparejando cronológicamente "llm.called" con el "llm.succeeded" /
 * "llm.failed" siguiente del mismo label (las llamadas de una misma sesión
 * son siempre secuenciales, nunca concurrentes — ver LLMService/writer).
 * No lee ningún dato que /events no exponga ya; solo lo reordena.
 */
function diagnosticoDTO(sesionId, events) {
  const ordenados = [...(events || [])].sort((a, b) => new Date(a.creadoEn) - new Date(b.creadoEn));
  const pendientePorLabel = {};
  const llamadasLlm = [];
  const errores = [];

  for (const ev of ordenados) {
    if (ev.tipo === 'llm.called') {
      const label = ev.payload && ev.payload.label;
      if (label) pendientePorLabel[label] = ev.creadoEn;
      continue;
    }
    if (ev.tipo === 'llm.succeeded' || ev.tipo === 'llm.failed') {
      const label = ev.payload && ev.payload.label;
      const inicio = label ? pendientePorLabel[label] : null;
      const latenciaMs = inicio ? (new Date(ev.creadoEn) - new Date(inicio)) : null;
      llamadasLlm.push({
        label:       label || null,
        resultado:   ev.tipo === 'llm.succeeded' ? 'succeeded' : 'failed',
        latenciaMs,
        detalle:     ev.tipo === 'llm.succeeded' ? (ev.payload && ev.payload.clasificacion) : (ev.payload && ev.payload.razon),
        creadoEn:    ev.creadoEn,
      });
      if (label) delete pendientePorLabel[label];
      if (ev.tipo === 'llm.failed') errores.push({ tipo: ev.tipo, label: label || null, detalle: ev.payload && ev.payload.razon, creadoEn: ev.creadoEn });
      continue;
    }
    if (ev.tipo === 'gate.rejected' || /\.failed$/.test(ev.tipo) || /error/i.test(ev.tipo)) {
      errores.push({ tipo: ev.tipo, detalle: ev.payload || null, creadoEn: ev.creadoEn });
    }
  }

  return {
    sesionId,
    totalEventos:  ordenados.length,
    primerEvento:  ordenados[0] ? ordenados[0].creadoEn : null,
    ultimoEvento:  ordenados.length > 0 ? ordenados[ordenados.length - 1].creadoEn : null,
    llamadasLlm,
    errores,
  };
}

module.exports = {
  okResponse, errorResponse, stateDTO, sessionDTO, turnoDTO, pipelineResultDTO, grammarTurnDTO, eventDTO, auditDTO,
  sessionSummaryDTO, diagnosticoDTO,
};
