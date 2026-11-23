'use strict';

/**
 * PIPELINE OBSERVABILITY REPORT
 * Agrega en una única vista estructurada la información que ya producen:
 *   - OrchestratorService.executionLog  (duración por etapa, result)
 *   - OrchestratorService.budgetSnapshot (tokens, reintentos por etapa)
 *   - LLMService (callCount, httpRequests, reintentos, rawResults con clasificación)
 *   - EventRepository (events: gate.approved, gate.rejected, intelligence.*, llm.*)
 *   - PipelineApplicationService.executionLog (etapas pre-Agora)
 *   - CognitiveState (checkpoints, sesionId)
 *
 * No duplica instrumentación. Reutiliza datos existentes.
 * No realiza llamadas LLM. No requiere UI.
 *
 * Ref: Task 6.3A.
 */

/**
 * Construye el reporte completo de observabilidad de una ejecución del pipeline.
 *
 * @param {object}   params
 * @param {object}   params.state            — CognitiveState
 * @param {object[]} params.events           — eventos del EventRepository (findBySesion)
 * @param {object[]} [params.orchestratorLog]— OrchestratorService.executionLog
 * @param {object}   [params.budgetSnapshot] — OrchestratorService.budgetSnapshot
 * @param {object[]} [params.pipelineLog]    — PipelineApplicationService.executionLog
 * @param {object}   [params.llmStats]       — { callCount, httpRequests, reintentos, rawResults }
 * @returns {ObservabilityReport}
 */
function buildObservabilityReport({
  state,
  events         = [],
  orchestratorLog = [],
  budgetSnapshot  = null,
  pipelineLog     = [],
  llmStats        = null,
}) {
  const sesionId    = state?.sesionId || null;
  const creadoEn    = state?.creadoEn || null;
  const actualizadoEn = state?.actualizadoEn || null;

  // ── 1. Duración total ──────────────────────────────────────────────────────
  // Derivada de creadoEn y actualizadoEn del state, o del log si disponible
  const duracionTotal = (creadoEn && actualizadoEn)
    ? new Date(actualizadoEn).getTime() - new Date(creadoEn).getTime()
    : null;

  // ── 2. Duración por etapa (del orchestratorLog) ────────────────────────────
  const etapas = orchestratorLog.map(entry => ({
    etapa:       entry.etapa,
    resultado:   entry.result,
    duracionMs:  entry.duration || null,
    correlationId: entry.correlationId || null,
    razon:       entry.razon || null,
  }));

  // Añadir etapas pre-Agora del pipelineLog
  const etapasPre = pipelineLog.map(entry => ({
    etapa:         entry.etapa,
    resultado:     entry.status,
    duracionMs:    entry.duracionMs    || null,   // instrumentado en Task 6.3C
    correlationId: entry.correlationId || null,
    razon:         entry.razon         || null,
  }));

  // ── 3. Tokens (del budgetSnapshot y llmStats) ─────────────────────────────
  const tokensPorEtapa = budgetSnapshot?.costByStage || {};
  const tokensTotal    = budgetSnapshot?.totalTokensUsed || 0;
  const requestsTotal  = budgetSnapshot?.totalRequests   || 0;

  // Tokens del LLMService (por label = etapa)
  const llmCallCount    = llmStats?.callCount    || 0;
  const llmHttpRequests = llmStats?.httpRequests || 0;
  const llmReintentos   = llmStats?.reintentos   || 0;

  // Clasificaciones de las respuestas LLM
  const clasificaciones = llmStats?.rawResults
    ? Object.entries(llmStats.rawResults).map(([label, data]) => ({
        etapa:         label,
        intentos:      (data.intentos || []).length,
        clasificacion: (data.intentos || []).map(i => i.clasificacion).filter(Boolean),
        parseOk:       data.parsed !== null,
      }))
    : [];

  // ── 4. Gates desde eventos ─────────────────────────────────────────────────
  const gatesAprobados = events
    .filter(ev => ev.tipo === 'gate.approved')
    .map(ev => ({
      etapa:         ev.payload?.etapa         || null,
      correlationId: ev.payload?.correlationId || null,
      ts:            ev.creadoEn,
    }));

  const gatesRechazados = events
    .filter(ev => ev.tipo === 'gate.rejected')
    .map(ev => ({
      etapa:         ev.payload?.etapa         || null,
      correlationId: ev.payload?.correlationId || null,
      razon:         ev.payload?.razon         || ev.payload?.errors?.join('; ') || null,
      ts:            ev.creadoEn,
    }));

  // ── 5. Errores desde eventos ───────────────────────────────────────────────
  const erroresLLM = events
    .filter(ev => ev.tipo === 'llm.failed')
    .map(ev => ({
      etapa:  ev.payload?.label  || null,
      razon:  ev.payload?.razon  || null,
      marcadores: ev.payload?.marcadores || null,
      ts:     ev.creadoEn,
    }));

  const erroresPipeline = [...etapas, ...etapasPre]
    .filter(e => e.resultado && e.resultado.includes('error'))
    .map(e => ({ etapa: e.etapa, razon: e.razon }));

  // ── 6. Checkpoints alcanzados ──────────────────────────────────────────────
  const checkpoints = {
    pipeline: state?.pipelineCheckpoint || null,
    agora:    state?.agoraCheckpoint    || null,
    historial: events
      .filter(ev => ev.tipo === 'state.committed')
      .map(ev => ({ motivacion: ev.payload?.motivacion, ts: ev.creadoEn })),
  };

  // ── 7. Resumen de eventos por tipo ────────────────────────────────────────
  const eventosPorTipo = {};
  events.forEach(ev => { eventosPorTipo[ev.tipo] = (eventosPorTipo[ev.tipo] || 0) + 1; });

  return Object.freeze({
    // Identificación
    sesionId,
    generadoEn:    new Date().toISOString(),

    // Duración
    duracionTotalMs: duracionTotal,
    etapas:          Object.freeze([...etapasPre, ...etapas]),

    // Tokens y llamadas
    tokens: Object.freeze({
      total:         tokensTotal,
      porEtapa:      Object.freeze({ ...tokensPorEtapa }),
      requests:      requestsTotal,
    }),

    // LLM
    llm: Object.freeze({
      llamadas:       llmCallCount,
      httpRequests:   llmHttpRequests,
      reintentos:     llmReintentos,
      clasificaciones: Object.freeze(clasificaciones),
    }),

    // Gates
    gates: Object.freeze({
      aprobados:  Object.freeze(gatesAprobados),
      rechazados: Object.freeze(gatesRechazados),
      totalAprobados:  gatesAprobados.length,
      totalRechazados: gatesRechazados.length,
    }),

    // Errores
    errores: Object.freeze({
      llm:      Object.freeze(erroresLLM),
      pipeline: Object.freeze(erroresPipeline),
      total:    erroresLLM.length + erroresPipeline.length,
    }),

    // Checkpoints
    checkpoints: Object.freeze(checkpoints),

    // Eventos
    eventosPorTipo: Object.freeze(eventosPorTipo),
    totalEventos:   events.length,
  });
}

/**
 * Extrae llmStats del LLMService si está disponible.
 * Helper para no acceder a propiedades privadas directamente.
 */
function extractLlmStats(llmService) {
  if (!llmService) return null;
  return {
    callCount:    llmService.callCount    || 0,
    httpRequests: llmService.httpRequests || 0,
    reintentos:   llmService.reintentos   || 0,
    rawResults:   llmService.rawResults   || {},
  };
}

module.exports = { buildObservabilityReport, extractLlmStats };
