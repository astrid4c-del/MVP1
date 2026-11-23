'use strict';

/**
 * COGNITIVO API SERVER
 * Capa HTTP mínima sobre PipelineApplicationService.
 * Node.js http nativo — sin framework externo.
 * Repositorios inyectables para tests deterministas.
 *
 * Endpoints:
 *   GET  /state/:sessionId   — CognitiveState canónico (DTO legado de depuración/pipeline)
 *   GET  /session/:sesionId  — memoria durable canónica (Incremento 5; DTO mínimo,
 *                              nombres reales de CognitiveState — no confundir con /state)
 *   GET  /session/:sesionId/turnos — transcript, paginado por cursor (Incremento 5)
 *   GET  /session/:sesionId/hydration — reconstrucción completa vía SessionHydrator (Incremento 7a)
 *   POST /pipeline           — iniciar o reanudar pipeline
 *   POST /grammar-turn       — un solo turno de una gramática (destino..darvida)
 *   POST /trace              — observabilidad pura: hechos que solo el cliente
 *                              conoce (p.ej. transición de gramática). No lee
 *                              ni muta CognitiveState.
 *   GET  /events/:sessionId  — eventos de la sesión
 *   GET  /audit/:sessionId   — reconstrucción estructurada de la ejecución
 *   GET  /sessions           — diagnóstico del Alpha: lista de sesiones (ver nota abajo)
 *   GET  /diagnostico/:sessionId — diagnóstico del Alpha: latencia/errores por sesión (ver nota abajo)
 *
 * NOTA — /sessions y /diagnostico/:sessionId son herramientas de diagnóstico
 * interno para el Alpha, no una segunda API de negocio: no agregan tabla ni
 * instrumentación nueva (derivan todo de /events y de los repositorios que
 * ya existen) y el frontend de Círculo (circulo_v0_bridge.html) nunca las
 * consume — solo existen para inspeccionar una conversación real sin entrar
 * a SQLite a mano. Sin autenticación, igual que el resto de esta API: no
 * exponerlas en un dominio público sin al menos una restricción de acceso
 * (ver aviso en DECISIONS.md, D-038).
 *
 * Sin lógica cognitiva en handlers.
 * Sin autenticación (Fase 6+).
 * Ref: Roadmap Fase 5 — tarea 5.2; NEXT_TASK.md — corrección del flujo
 *      conversacional, Task 1.
 */

const http = require('http');
const {
  okResponse, errorResponse, stateDTO, sessionDTO, turnoDTO, pipelineResultDTO, grammarTurnDTO, eventDTO, auditDTO,
  sessionSummaryDTO, diagnosticoDTO,
} = require('./ApiDTOs');
const { SLOTS_BY_GRAMATICA, validateGramaticaComplete } = require('../schemas/AgoraSlots');
const { GRAMATICA_DEFS }        = require('../agora/AgoraPrompts');
const { createEvent }           = require('../schemas/Event');
const { deserializeState, createInitialState } = require('../schemas/CognitiveState');
const { SessionHydrator } = require('../pipeline/SessionHydrator');

// GET /session/:id/turnos — límites de paginación (Incremento 5).
const DEFAULT_TURNOS_LIMIT = 50;
const MAX_TURNOS_LIMIT     = 200;

// CORS: habilita que un frontend servido desde otro origen (p.ej. el smoke test
// local en http://127.0.0.1:8080) pueda llamar a esta API en http://localhost:3000.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS };

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON inválido en el cuerpo')); }
    });
    req.on('error', reject);
  });
}

function parseRoute(url) {
  const [path, qs] = (url || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, qs };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleGetState(res, sessionId, stateRepository) {
  const json = stateRepository.load(sessionId);
  if (!json) return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));
  const { deserializeState } = require('../schemas/CognitiveState');
  const state = deserializeState(json);
  send(res, 200, okResponse(stateDTO(state)));
}

/**
 * GET /session/:sesionId — Incremento 5.
 * Fuente de verdad de solo lectura para el estado vigente de una sesión.
 * Nunca crea la sesión ni ninguna versión: state ya existente o 404.
 */
async function handleGetSession(res, sessionId, stateRepository) {
  const json = stateRepository.load(sessionId);
  if (!json) return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));
  const state = deserializeState(json);
  send(res, 200, { ok: true, session: sessionDTO(state) });
}

async function handleGetSessionOutput(res, sessionId, stateRepository) {
  const json = stateRepository.load(sessionId);
  if (!json) return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));
  const state = deserializeState(json);
  if (!state.downstreamResult)
    return send(res, 404, errorResponse('DOWNSTREAM_RESULT_NOT_AVAILABLE', 'La sesión aún no tiene un resultado downstream recuperable'));
  send(res, 200, okResponse(JSON.parse(JSON.stringify(state.downstreamResult))));
}

/** Entero válido para 'after'/'limit': solo dígitos, sin signo, sin decimales. */
function parsePositiveIntParam(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * GET /session/:sesionId/turnos — Incremento 5.
 * Transcript paginado por cursor, derivado EXCLUSIVAMENTE de Turnos
 * persistidos (nunca de eventos ni del estado actual) — ver
 * SqliteTurnoRepository.paginarAscendente.
 */
async function handleGetSessionTurnos(res, sessionId, qs, stateRepository, turnoRepository) {
  if (!turnoRepository)
    return send(res, 500, errorResponse('SESSION_TURNOS_NOT_CONFIGURED',
      'El servidor no tiene configurado turnoRepository para /session/:id/turnos'));

  // Existencia de la sesión: mismo criterio que /session/:id (el estado
  // canónico es la fuente de verdad de "esta sesión existe"), no un conteo
  // de turnos — una sesión existente sin turnos todavía es un 200 válido.
  const json = stateRepository.load(sessionId);
  if (!json) return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));

  const params = new URLSearchParams(qs || '');

  let after = 0;
  if (params.has('after')) {
    const parsed = parsePositiveIntParam(params.get('after'));
    if (parsed === null)
      return send(res, 400, errorResponse('INVALID_CURSOR', `'after' debe ser un entero no negativo: '${params.get('after')}'`));
    after = parsed;
  }

  let limit = DEFAULT_TURNOS_LIMIT;
  if (params.has('limit')) {
    const parsed = parsePositiveIntParam(params.get('limit'));
    if (parsed === null || parsed < 1)
      return send(res, 400, errorResponse('INVALID_LIMIT', `'limit' debe ser un entero positivo: '${params.get('limit')}'`));
    limit = Math.min(parsed, MAX_TURNOS_LIMIT); // límite máximo protegido en servidor
  }

  // Se pide una fila de más para saber si hay una página siguiente sin
  // adivinar ni hacer un segundo round-trip.
  const pagina = turnoRepository.paginarAscendente(sessionId, after, limit + 1);
  const hayMas = pagina.length > limit;
  const turnosPagina = hayMas ? pagina.slice(0, limit) : pagina;
  const turnos = turnosPagina.map(turnoDTO);
  const nextCursor = hayMas ? turnos[turnos.length - 1].numeroDeTurno : null;

  send(res, 200, { ok: true, turnos, nextCursor });
}

/**
 * POST /pipeline — iniciar o reanudar el pipeline pre-Agora (comprension →
 * potenciacion → contextual → Modelo Agora) o reanudar una pausa HITL.
 *
 * Incremento 8 (retiro de segunda autoridad de escritura de slots):
 * este handler ya no acepta `startFrom` ni `slots` en el body. Antes,
 * startFrom:'agora' + slots permitía a un cliente HTTP sintetizar e
 * inyectar directamente los 16 slots canónicos de una sesión, saltándose
 * /grammar-turn — una segunda puerta capaz de ordenar una escritura sobre
 * CognitiveState. Se confirmó (auditoría de consumidores) que el bridge
 * real (build_bridge.js) nunca ejercitó ese camino: su única llamada a
 * /pipeline es `{ sessionId, resume: true }` para reanudar tras la pausa
 * HITL de selección de avatar/promesa. No había consumidor de producción
 * que perder. PipelineApplicationService.preloadSlots() (el método que
 * ejecutaba esa escritura) fue eliminado junto con este camino — ver su
 * nota de retiro. El downstream (Modelo Agora) solo se alcanza ahora vía
 * runFromAgora(), invocado exclusivamente en proceso por
 * PipelineDownstreamDispatcher tras el cierre real de las 5 gramáticas.
 */
async function handlePostPipeline(res, body, pipelineService) {
  const { sessionId, expertoId, resume } = body || {};
  if (!sessionId || typeof sessionId !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'sessionId' es requerido en el cuerpo"));

  let result;
  try {
    if (resume) {
      result = await pipelineService.resume(sessionId);
    } else {
      result = await pipelineService.run(sessionId, expertoId || null);
    }
  } catch (e) {
    return send(res, 500, errorResponse('PIPELINE_ERROR', e.message));
  }
  send(res, 200, okResponse(pipelineResultDTO(result)));
}

/**
 * POST /grammar-turn — ejecuta exactamente UNA etapa de gramática (destino..darvida).
 *
 * Incremento 4: el punto de entrada cambió de OrchestratorService.executeStage()
 * (vía el camino legado) a InteraccionCognitivaWriter.procesar() — la autoridad
 * sobre estado/Turno/Gate/gramática/slots es exclusivamente del backend desde
 * este incremento. El writer siempre deriva la gramática activa de
 * state.gramaticaActiva; nada en el body del cliente participa en esa decisión.
 *
 * Incremento 8 (retiro de compatibilidad muerta): `etapa` y `understood` ya
 * no se leen ni se validan aquí. El bridge legado (build_bridge.js) todavía
 * los incluye en el body por costumbre histórica — son ignorados sin efecto,
 * lo cual no rompe ese consumidor (el contrato HTTP nunca dependió de que el
 * servidor los rechazara). El cliente nunca necesitó enviarlos para que el
 * turno se procesara correctamente.
 *
 * El resto de esta función solo traduce el resultado del writer al mismo
 * contrato HTTP de siempre (grammarTurnDTO), incluyendo la reconstrucción
 * fiel del caso "el LLM no respondió" — el camino legado nunca devolvía un
 * error HTTP en ese caso: el executor simplemente no actualizaba slots y el
 * Gate terminaba rechazando sobre el estado sin cambios (200, con el mensaje
 * "Gate de salida fallido: ..."). Se reconstruye ese mismo resultado aquí
 * para no introducir ninguna diferencia observable — ver
 * responderComoGateFallidoLegado.
 *
 * Ref: NEXT_TASK.md — corrección del flujo conversacional, Task 1; Incremento 4.
 */
async function handlePostGrammarTurn(res, body, { stateRepository, writer }) {
  const { sessionId, mensajeUsuario, turnoClienteId } = body || {};

  if (!sessionId || typeof sessionId !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'sessionId' es requerido en el cuerpo"));

  if (!mensajeUsuario || typeof mensajeUsuario !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'mensajeUsuario' es requerido en el cuerpo"));

  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §5 — turnoClienteId pasa a ser
  // obligatorio: es la base de la admisión durable de EntradaConversacional
  // (ver InteraccionCognitivaWriter._validarEntrada, que ya lo exige — este
  // chequeo solo adelanta el mismo requisito a un 400 explícito en el
  // límite HTTP, en vez de dejar que se convierta en un 500 genérico).
  if (!turnoClienteId || typeof turnoClienteId !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'turnoClienteId' es requerido en el cuerpo"));

  if (!writer)
    return send(res, 500, errorResponse('GRAMMAR_TURN_NOT_CONFIGURED',
      'El servidor no tiene configurado InteraccionCognitivaWriter para /grammar-turn'));

  let resultado;
  try {
    resultado = await writer.procesar({
      sesionId: sessionId,
      mensajeUsuario,
      turnoClienteId,
    });
  } catch (e) {
    return send(res, 500, errorResponse('GRAMMAR_TURN_ERROR', e.message));
  }

  if (!resultado.ok) {
    if (resultado.codigo === 'LLM_UNAVAILABLE')
      return responderComoGateFallidoLegado(res, sessionId, stateRepository);
    return send(res, resultado.httpStatus, errorResponse(resultado.codigo, resultado.mensaje));
  }

  // P0-A (OPCION_C -- ADAPTACION_EXPLICITA_DEL_RESULTADO_BLOQUEADO_EN_EL_ENTRY_POINT):
  // resultado.ok===true no es una única forma -- InteraccionCognitivaWriter
  // la usa tanto para TURNO_CONFIRMADO (Turno persistido) como para
  // PROCESAMIENTO_BLOQUEADO_SIN_TURNO (p.ej. IDENTIDAD_DE_EMISION_NO_VERIFICABLE
  // o CONTRATO_INVALIDO en _procesarValidacionRelacionTransformacionalDestino,
  // que por diseño nunca persisten Turno ni emiten transición -- ver su
  // propio docstring). Tratar ambas formas como si fueran una sola (leer
  // resultado.turno.gramatica incondicionalmente) causaba un TypeError real
  // (reproducido y documentado) apenas la sesión llegaba a esa rama. Nunca
  // se corrige fabricando un Turno sintético -- eso inventaría una entidad
  // que el Writer decidió explícitamente no crear. En cambio, `turno` y
  // `state` se resuelven cada uno contra su disponibilidad real, nunca
  // asumida: ninguno de los dos está garantizado en las 5 formas de retorno
  // ok:true del Writer (turno falta en la rama bloqueada; state falta en la
  // reconstrucción idempotente de un reintento -- ver
  // _reconstruirResultadoIdempotente, que deliberadamente no relee el
  // estado actual de la sesión).
  let gramaticaReal;
  if (resultado.turno) {
    // Variante TURNO_DISPONIBLE (el camino normal, incluida la
    // reconstrucción idempotente) -- comportamiento intacto.
    gramaticaReal = resultado.turno.gramatica;
  } else if (resultado.protocolo && resultado.protocolo.causa && resultado.state) {
    // Variante BLOQUEO_ESTRUCTURADO_SIN_TURNO -- no hay Turno porque no se
    // creó ninguno; nunca se sustituye por uno fabricado. gramaticaActiva
    // es la gramática VIGENTE DE LA SESIÓN (nunca la de un Turno
    // inexistente) -- se usa exclusivamente para proyectar esta respuesta
    // HTTP de bloqueo, nunca como reemplazo general de turno.gramatica.
    gramaticaReal = resultado.state.gramaticaActiva;
  } else {
    // Variante RESULTADO_INCONSISTENTE -- ni Turno ni causa estructurada
    // reconocible: nunca se asume 'destino' ni ningún valor por defecto;
    // falla explícito para que la violación de contrato sea detectable.
    return send(res, 500, errorResponse('WRITER_RESULTADO_INCONSISTENTE',
      'InteraccionCognitivaWriter devolvió ok:true sin turno y sin causa estructurada reconocible en protocolo.causa -- contrato violado.'));
  }

  // Misma disyunción para `entendido`: state solo falta en la
  // reconstrucción idempotente (turno SIEMPRE presente ahí), que ya trae su
  // propio equivalente autoritativo (turno.aportesBrutos, expuesto como
  // resultado.entendido) -- nunca se reconstruye a mano en su ausencia.
  const entendido = resultado.state
    ? Object.fromEntries(
        (SLOTS_BY_GRAMATICA[gramaticaReal] || []).map(k => [k, resultado.state.slots[k] ?? null])
      )
    : resultado.entendido;

  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — contrato de fallo explícito.
  // `resultado.entradaRegistrada !== undefined` distingue la forma NUEVA
  // (InteraccionCognitivaWriter._procesarValidacionRelacionTransformacionalDestino,
  // rama sin Turno) de la forma normal TURNO_DISPONIBLE, en vez de inferirlo
  // de la ausencia de resultado.turno (que también es cierta en la
  // reconstrucción idempotente, un caso de ÉXITO). Nunca `mensaje:null`
  // indistinguible de una respuesta cognitiva vacía: procesamientoCompletado
  // siempre viaja, true o false, explícito.
  const esFormaDeFalloExplicito = resultado.entradaRegistrada !== undefined;
  const durabilidad = esFormaDeFalloExplicito
    ? {
        entradaRegistrada: resultado.entradaRegistrada,
        procesamientoCompletado: resultado.procesamientoCompletado,
        respuestaGenerada: resultado.respuestaGenerada,
        causa: (resultado.protocolo && resultado.protocolo.causa) || null,
        errorCategory: (resultado.protocolo && resultado.protocolo.errorCategory) || null,
        retryable: (resultado.protocolo && resultado.protocolo.retryable) ?? null,
        turnoClienteId: resultado.turnoClienteId || null,
        turnoId: resultado.turnoId || null,
      }
    : {
        // Camino normal (Turno persistido, incluida la reconstrucción
        // idempotente) — el mensaje SIEMPRE es una respuesta cognitiva real.
        entradaRegistrada: true,
        procesamientoCompletado: true,
        respuestaGenerada: true,
        causa: null,
        errorCategory: null,
        retryable: null,
        turnoClienteId: (resultado.turno && resultado.turno.turnoClienteId) || turnoClienteId || null,
        turnoId: (resultado.turno && resultado.turno.turnoId) || null,
      };

  send(res, 200, okResponse(grammarTurnDTO({
    mensaje: resultado.mensaje,
    entendido,
    // Misma limitación conocida que ya existía: el crudo "proponiendo_cierre"
    // del LLM no se expone todavía fuera de sus efectos sobre el estado.
    proponiendoCierre: false,
    completeFlag: GRAMATICA_DEFS[gramaticaReal].completeFlag,
    completed: resultado.gramaticaCompletada,
    ...durabilidad,
  })));
}

/**
 * Reconstruye, byte a byte en estructura, la respuesta que el camino legado
 * producía cuando el LLM no devolvía una respuesta cognitiva válida (Gate
 * evaluado sobre el estado sin cambios). No relee ningún resultado del LLM
 * — solo el estado ya persistido — porque no hay ninguna respuesta cognitiva
 * que traducir.
 */
async function responderComoGateFallidoLegado(res, sessionId, stateRepository) {
  const json = stateRepository.load(sessionId);
  const state = json ? deserializeState(json) : createInitialState({ sesionId: sessionId });
  // gramaticaActiva es la única autoridad: writer.procesar() solo llega a
  // LLM_UNAVAILABLE tras intentar llamar al LLM sobre una gramática activa
  // real (si no hubiera gramática activa, el writer responde 409 antes de
  // intentar la llamada — ver InteraccionCognitivaWriter), así que este
  // fallback a 'destino' es defensivo, no una ruta alcanzable en la práctica.
  const gramatica = state.gramaticaActiva || 'destino';

  const { missing } = validateGramaticaComplete(state.slots, gramatica);
  const mensaje = `Gate de salida fallido: [${gramatica}] slots: incompletos: [${missing.join(', ')}]`;
  const entendido = Object.fromEntries((SLOTS_BY_GRAMATICA[gramatica] || []).map(k => [k, state.slots[k] ?? null]));

  send(res, 200, okResponse(grammarTurnDTO({
    mensaje,
    entendido,
    proponiendoCierre: false,
    completeFlag: (GRAMATICA_DEFS[gramatica] || {}).completeFlag || null,
    completed: false,
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — este camino legado
    // (LLM_UNAVAILABLE, ver docstring de handlePostGrammarTurn) nunca
    // produjo una respuesta cognitiva real: dejar los defaults de
    // grammarTurnDTO (todo `true`) aquí afirmaría, incorrectamente, que el
    // procesamiento se completó. entradaRegistrada queda en su default
    // `true` (esta rama solo es alcanzable tras admisión, dentro de
    // _procesarBajoExclusividad) — solo procesamientoCompletado/
    // respuestaGenerada se corrigen explícitamente a `false`.
    procesamientoCompletado: false,
    respuestaGenerada: false,
  })));
}

/**
 * POST /trace — sumidero exclusivo de observabilidad para hechos que solo el
 * cliente puede conocer (p.ej. la transición de gramática, que vive en
 * currentStateIdx dentro de circulo_v0.html/bridge, no en el Motor).
 * Escribe un Event y responde 200. No lee ni modifica CognitiveState, no toca
 * stateService/orchestrator/pipelineService, no participa en ninguna decisión.
 * Instrumentación pura — Objetivo de observabilidad end-to-end, no una Task de
 * corrección de comportamiento.
 */
async function handlePostTrace(res, body, { eventBus }) {
  const { sessionId, evento, datos } = body || {};

  if (!sessionId || typeof sessionId !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'sessionId' es requerido en el cuerpo"));
  if (!evento || typeof evento !== 'string')
    return send(res, 400, errorResponse('INVALID_INPUT', "'evento' es requerido en el cuerpo"));
  if (!eventBus)
    return send(res, 500, errorResponse('TRACE_NOT_CONFIGURED', 'El servidor no tiene configurado eventBus para /trace'));

  try {
    eventBus.emit(createEvent({ tipo: evento, sesionId: sessionId, payload: (datos && typeof datos === 'object') ? datos : {} }));
  } catch (e) {
    return send(res, 400, errorResponse('INVALID_TRACE_EVENT', e.message));
  }

  send(res, 200, okResponse({ recibido: true }));
}

/**
 * GET /session/:sesionId/hydration — Incremento 7a.
 * Único punto HTTP de rehidratación completa: delega enteramente en
 * SessionHydrator (Incremento 6), no reconstruye nada por su cuenta. Misma
 * forma de respuesta que produce el hydrator — ningún DTO paralelo.
 */
async function handleGetSessionHydration(res, sessionId, hydrator) {
  if (!hydrator)
    return send(res, 500, errorResponse('HYDRATION_NOT_CONFIGURED',
      'El servidor no tiene configurado SessionHydrator para /session/:id/hydration'));

  const r = hydrator.hidratar(sessionId);
  if (!r.ok)
    return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));

  send(res, 200, { ok: true, session: r.session });
}

/**
 * GET /sessions — diagnóstico del Alpha. Reutiliza exclusivamente
 * stateRepo.listSessions()/load() y turnoRepo.countBySesion() — ya
 * existían, sin usar desde ningún endpoint. No es una API de negocio: ver
 * nota al inicio del archivo.
 */
async function handleGetSessions(res, stateRepository, turnoRepository) {
  if (typeof stateRepository.listSessions !== 'function')
    return send(res, 501, errorResponse('NOT_SUPPORTED', 'Este stateRepository no implementa listSessions()'));

  const ids = stateRepository.listSessions();
  const resumen = ids
    .map(id => {
      const json = stateRepository.load(id);
      if (!json) return null;
      const state = deserializeState(json);
      const totalTurnos = turnoRepository ? turnoRepository.countBySesion(id) : null;
      return sessionSummaryDTO(state, totalTurnos);
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.actualizadoEn) - new Date(a.actualizadoEn));

  send(res, 200, okResponse({ total: resumen.length, sesiones: resumen }));
}

/**
 * GET /diagnostico/:sessionId — diagnóstico del Alpha. Deriva todo de
 * eventRepository.findBySesion() (lo mismo que ya devuelve /events) — ver
 * diagnosticoDTO en ApiDTOs.js y la nota al inicio del archivo.
 */
async function handleGetDiagnostico(res, sessionId, eventRepository) {
  const events = eventRepository.findBySesion(sessionId);
  if (events.length === 0)
    return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));
  send(res, 200, okResponse(diagnosticoDTO(sessionId, events)));
}

async function handleGetEvents(res, sessionId, eventRepository) {
  const events = eventRepository.findBySesion(sessionId);
  send(res, 200, okResponse({ sesionId: sessionId, total: events.length, eventos: events.map(eventDTO) }));
}

async function handleGetAudit(res, sessionId, stateRepository, eventRepository, pipelineService) {
  const json   = stateRepository.load(sessionId);
  const events = eventRepository.findBySesion(sessionId);
  if (!json && events.length === 0)
    return send(res, 404, errorResponse('SESSION_NOT_FOUND', `Sesión '${sessionId}' no encontrada`));

  const { deserializeState } = require('../schemas/CognitiveState');
  const state = json ? deserializeState(json) : null;

  // Reunir datos de observabilidad desde el pipelineService si están disponibles
  let observabilityParams = null;
  if (pipelineService && typeof pipelineService.observabilitySnapshot === 'function') {
    try { observabilityParams = pipelineService.observabilitySnapshot(); } catch { /* opcional */ }
  }

  send(res, 200, okResponse(auditDTO(sessionId, state, events, observabilityParams)));
}

// ── CognitivoApiServer ────────────────────────────────────────────────────────

class CognitivoApiServer {
  /**
   * @param {object} config
   * @param {CognitiveSessionRegistry} [config.sessionRegistry] — provee, por
   *   sessionId, el bundle {pipelineService, orchestrator, llmService} de ESA
   *   Sesión Cognitiva. Reemplaza a pasar un pipelineService/orchestrator/
   *   llmService fijos y compartidos por todas las sesiones (la causa raíz de
   *   la contaminación cruzada de _log documentada en la autopsia del Smoke
   *   Test #2 — ver CognitiveSessionRegistry.js).
   * @param {PipelineApplicationService} [config.pipelineService] — legado:
   *   un único pipelineService fijo, compartido por todas las sesiones. Se
   *   mantiene solo por compatibilidad con instanciaciones/tests existentes
   *   que no conocen el concepto de Sesión Cognitiva. Ignorado si se pasa
   *   sessionRegistry.
   * @param {StateRepository|SqliteStateRepository} config.stateRepository
   * @param {EventRepository|SqliteEventRepository} config.eventRepository
   * @param {SqliteTurnoRepository} [config.turnoRepository] — requerido solo para GET /session/:id/turnos (Incremento 5)
   * @param {number}  [config.port]
   * @param {CognitiveStateService} [config.stateService]  — requerido solo para /grammar-turn
   * @param {OrchestratorService}   [config.orchestrator]  — legado, ver pipelineService
   * @param {LLMService}            [config.llmService]    — legado, ver pipelineService
   * @param {EventBus}              [config.eventBus]      — requerido solo para /trace (observabilidad)
   * @param {string}                [config.llmProvider]   — solo para GET /health (diagnóstico del Alpha)
   * @param {string}                [config.llmModel]      — solo para GET /health (diagnóstico del Alpha)
   */
  constructor({
    sessionRegistry = null, pipelineService = null, stateRepository, eventRepository, turnoRepository = null, port = 3000,
    stateService = null, orchestrator = null, llmService = null, eventBus = null,
    llmProvider = null, llmModel = null,
  }) {
    if (!sessionRegistry && !pipelineService)
      throw new Error('CognitivoApiServer: se requiere sessionRegistry (o, en modo legado, pipelineService)');
    if (!stateRepository)  throw new Error('CognitivoApiServer: stateRepository es requerido');
    if (!eventRepository)  throw new Error('CognitivoApiServer: eventRepository es requerido');

    this._stateRepo    = stateRepository;
    this._eventRepo    = eventRepository;
    this._port         = port;
    this._server       = null;
    this._llmProvider  = llmProvider;
    this._llmModel     = llmModel;
    // Requerido solo para /grammar-turn (Task 1).
    this._stateService = stateService;
    // Opcional: solo necesario para /trace (observabilidad end-to-end).
    this._eventBus      = eventBus;
    // Opcional: solo necesario para GET /session/:id/turnos (Incremento 5).
    // El mismo turnoRepo que usa InteraccionCognitivaWriter (vía
    // CognitiveUnitOfWork) — ver buildServer() en bin/start-server.js.
    this._turnoRepo      = turnoRepository;
    // Opcional: solo necesario para GET /session/:id/hydration (Incremento
    // 7a). Mismos repositorios ya inyectados arriba — SessionHydrator nunca
    // abre una conexión propia.
    this._hydrator = turnoRepository ? new SessionHydrator({ stateRepository, turnoRepository, eventRepository }) : null;

    // Ciclo de vida de Sesión Cognitiva: si no se provee un sessionRegistry
    // real, se envuelve el bundle fijo legado en un registry trivial de una
    // sola "sesión" — mismo comportamiento de siempre para instanciaciones
    // existentes que aún no conocen el concepto.
    this._sessionRegistry = sessionRegistry || {
      get: () => ({ pipelineService, orchestrator, llmService }),
    };
  }

  /**
   * Procesa una request. Expuesto para tests sin levantar un puerto real.
   */
  async handleRequest(req, res) {
    const { parts, qs } = parseRoute(req.url);
    const method    = req.method.toUpperCase();

    // Preflight CORS: responder antes de tocar cualquier ruta o lógica de negocio.
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    try {
      // GET /state/:sessionId
      if (method === 'GET' && parts[0] === 'state' && parts[1]) {
        return await handleGetState(res, parts[1], this._stateRepo);
      }

      // GET /session/:sesionId/turnos — Incremento 5 (evaluar ANTES que
      // /session/:sesionId a secas, o "turnos" se leería como el sesionId).
      if (method === 'GET' && parts[0] === 'session' && parts[1] && parts[2] === 'turnos' && parts.length === 3) {
        return await handleGetSessionTurnos(res, parts[1], qs, this._stateRepo, this._turnoRepo);
      }

      if (method === 'GET' && parts[0] === 'session' && parts[1] && parts[2] === 'output' && parts.length === 3) {
        return await handleGetSessionOutput(res, parts[1], this._stateRepo);
      }

      // GET /session/:sesionId/hydration — Incremento 7a (misma razón: antes
      // que /session/:sesionId a secas).
      if (method === 'GET' && parts[0] === 'session' && parts[1] && parts[2] === 'hydration' && parts.length === 3) {
        return await handleGetSessionHydration(res, parts[1], this._hydrator);
      }

      // GET /session/:sesionId — Incremento 5
      if (method === 'GET' && parts[0] === 'session' && parts[1] && parts.length === 2) {
        return await handleGetSession(res, parts[1], this._stateRepo);
      }

      // POST /pipeline
      if (method === 'POST' && parts[0] === 'pipeline') {
        let body;
        try { body = await readBody(req); }
        catch { return send(res, 400, errorResponse('INVALID_JSON', 'JSON inválido en el cuerpo')); }
        const bundle = this._sessionRegistry.get(body && typeof body.sessionId === 'string' ? body.sessionId : null);
        return await handlePostPipeline(res, body, bundle.pipelineService);
      }

      // POST /grammar-turn
      if (method === 'POST' && parts[0] === 'grammar-turn') {
        let body;
        try { body = await readBody(req); }
        catch { return send(res, 400, errorResponse('INVALID_JSON', 'JSON inválido en el cuerpo')); }
        const bundle = this._sessionRegistry.get(body && typeof body.sessionId === 'string' ? body.sessionId : null);
        return await handlePostGrammarTurn(res, body, {
          stateRepository: this._stateRepo,
          writer: bundle.writer,
        });
      }

      // POST /trace — observabilidad pura (ver handlePostTrace)
      if (method === 'POST' && parts[0] === 'trace') {
        let body;
        try { body = await readBody(req); }
        catch { return send(res, 400, errorResponse('INVALID_JSON', 'JSON inválido en el cuerpo')); }
        return await handlePostTrace(res, body, { eventBus: this._eventBus });
      }

      // GET /events/:sessionId
      if (method === 'GET' && parts[0] === 'events' && parts[1]) {
        return await handleGetEvents(res, parts[1], this._eventRepo);
      }

      // GET /audit/:sessionId
      if (method === 'GET' && parts[0] === 'audit' && parts[1]) {
        return await handleGetAudit(res, parts[1], this._stateRepo, this._eventRepo, this._sessionRegistry.get(parts[1]).pipelineService);
      }

      // GET /sessions — diagnóstico del Alpha (ver nota al inicio del archivo)
      if (method === 'GET' && parts[0] === 'sessions' && parts.length === 1) {
        return await handleGetSessions(res, this._stateRepo, this._turnoRepo);
      }

      // GET /diagnostico/:sessionId — diagnóstico del Alpha (ver nota al inicio del archivo)
      if (method === 'GET' && parts[0] === 'diagnostico' && parts[1]) {
        return await handleGetDiagnostico(res, parts[1], this._eventRepo);
      }

      // GET /health
      if (method === 'GET' && parts[0] === 'health') {
        return send(res, 200, okResponse({
          status: 'ok', ts: new Date().toISOString(),
          llmProvider: this._llmProvider, llmModel: this._llmModel,
        }));
      }

      send(res, 404, errorResponse('NOT_FOUND', `${method} /${parts.join('/')} no existe`));
    } catch (e) {
      send(res, 500, errorResponse('INTERNAL_ERROR', e.message));
    }
  }

  /** Levanta el servidor en el puerto (y host, opcional) configurado. */
  listen(port = this._port, host) {
    this._server = http.createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      const onListening = () => resolve(this);
      if (host) this._server.listen(port, host, onListening);
      else      this._server.listen(port, onListening);
      this._server.once('error', reject);
    });
  }

  /** Cierra el servidor. */
  close() {
    return new Promise((resolve) => {
      if (this._server) this._server.close(() => resolve());
      else resolve();
    });
  }

  get port() { return this._port; }
}

module.exports = { CognitivoApiServer };
