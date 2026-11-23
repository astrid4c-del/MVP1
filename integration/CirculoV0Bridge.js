'use strict';

/**
 * CIRCULO V0 BRIDGE
 * Puente de integración entre circulo_v0.html y el Motor Cognitivo.
 *
 * Objetivo (Goal 6.1):
 *   Conectar el flujo de circulo_v0 con FrontendAdapter + CognitiveApiClient
 *   sin modificar circulo_v0.html.
 *
 * Estrategia:
 *   circulo_v0 usa callAI(sys, messages) para todas las llamadas al LLM.
 *   Este bridge provee:
 *     1. createCallAIBridge(adapter, sessionId) — reemplaza callAI() con
 *        llamadas a FrontendAdapter cuando el contexto lo permite.
 *     2. mapV0StateToApiInput(v0State) — traduce el estado interno de v0
 *        (currentStateIdx, slots, history) al input que la API espera.
 *     3. mapApiResultToV0Reply(result) — traduce el resultado de la API
 *        al formato { mensaje, entendido } que v0 espera de callAI().
 *
 * NO modifica circulo_v0.html ni circulo_e2e.html.
 * NO duplica lógica del PipelineApplicationService, Orchestrator ni Policies.
 * El usuario no percibe ningún cambio en la experiencia.
 *
 * Modo de uso (en un entorno que carga v0 + el motor):
 *   const bridge = createV0Bridge({ apiBaseUrl, fetchImpl, onStateChange });
 *   // Interceptar callAI en el scope de v0:
 *   window.callAI = bridge.callAIReplacement;
 *   // El resto de circulo_v0 no cambia.
 *
 * Ref: Roadmap Fase 6 — Goal 6.1.
 */

const { CognitiveApiClient } = require('../client/CognitiveApiClient');
const { FrontendAdapter, UI_STATE } = require('../client/FrontendAdapter');

// ── Mapa de gramáticas de v0 a etapas del Motor ───────────────────────────────

const V0_STATE_TO_MOTOR_STAGE = Object.freeze({
  destino:   'destino',
  destilar:  'destilar',
  traducir:  'traducir',
  ascenso:   'ascenso',
  darvida:   'darvida',
});

// ── Traducción de estado v0 → input de la API ─────────────────────────────────

/**
 * Convierte el estado interno de circulo_v0 al input que espera POST /pipeline.
 *
 * @param {object} v0State — estado interno de v0 tal como se conoce en su scope:
 *   { currentStateIdx, stateOrder, slots, history, understood }
 * @param {string} sessionId
 * @returns {object} input para CognitiveApiClient.runPipeline()
 */
function mapV0StateToApiInput(v0State, sessionId) {
  const { currentStateIdx = 0, stateOrder = [], slots = {}, resume = false } = v0State || {};
  const etapaActual = stateOrder[currentStateIdx] || 'destino';

  return {
    sessionId,
    expertoId:   v0State?.expertoId || null,
    etapaActual: V0_STATE_TO_MOTOR_STAGE[etapaActual] || etapaActual,
    slots:       Object.fromEntries(Object.entries(slots).filter(([, v]) => v !== null && v !== '')),
    resume,
  };
}

// Los 16 slots canónicos del Modelo Agora (mismo orden que circulo_v0)
const ALL_SLOTS = Object.freeze([
  'conocimiento','antes','despues','evidencia',
  'obvio','errores','esencia',
  'relevancia','mundo_real','secuencia',
  'ensayo','prueba_propia','escalon',
  'voz','momento_solo','vida_propia',
]);

/**
 * Construye el objeto `entendido` compatible con circulo_v0 a partir
 * de los slots del StateDTO.
 * - Slots presentes con valor no nulo/vacío se incluyen.
 * - Slots faltantes (compatibilidad hacia atrás) se inicializan a null.
 *
 * @param {object|null} slots — state.slots del StateDTO
 * @returns {object} entendido con los 16 slots
 */
function buildEntendido(slots) {
  if (!slots || typeof slots !== 'object') {
    return Object.fromEntries(ALL_SLOTS.map(k => [k, null]));
  }
  return Object.fromEntries(
    ALL_SLOTS.map(k => [k, (slots[k] !== undefined && slots[k] !== '') ? slots[k] : null])
  );
}

/**
 * Convierte el resultado de la API al formato { mensaje, entendido }
 * que circulo_v0 espera de callAI().
 *
 * @param {object} apiResult  — resultado de FrontendAdapter._handlePipelineResponse()
 * @param {string} fallbackMsg
 * @param {object} [stateDTO] — StateDTO de GET /state — proporciona los slots para entendido
 * @returns {{ mensaje: string, entendido: object }}
 */
function mapApiResultToV0Reply(apiResult, fallbackMsg = 'Procesando…', stateDTO = null) {
  if (!apiResult || apiResult.uiState === UI_STATE.ERROR) {
    return {
      mensaje:   apiResult?.message || fallbackMsg,
      entendido: buildEntendido(stateDTO?.slots || null),
    };
  }

  const checkpointLabel = {
    completed: '¡Listo! Hemos avanzado a la siguiente etapa.',
    paused:    'Tomemos un momento para revisar esto juntos.',
    blocked:   'Necesito un poco más de información para continuar.',
  }[apiResult.uiState] || fallbackMsg;

  // Construir entendido desde el StateDTO cuando está disponible
  const entendido = buildEntendido(stateDTO?.slots || null);

  return { mensaje: checkpointLabel, entendido };
}

// ── Bridge factory ────────────────────────────────────────────────────────────

/**
 * Crea el puente de integración completo.
 *
 * @param {object}   config
 * @param {string}   config.apiBaseUrl   — URL del CognitivoApiServer
 * @param {Function} config.fetchImpl    — fetch inyectable
 * @param {Function} [config.onStateChange] — cb(uiState, data) para la UI
 * @returns {CirculoV0Bridge}
 */
function createV0Bridge({ apiBaseUrl, fetchImpl, onStateChange = null }) {
  if (!apiBaseUrl) throw new Error('CirculoV0Bridge: apiBaseUrl es requerido');
  if (!fetchImpl)  throw new Error('CirculoV0Bridge: fetchImpl es requerido');

  const client  = new CognitiveApiClient(apiBaseUrl, fetchImpl);
  const adapter = new FrontendAdapter(client, onStateChange);

  // ── Reemplazo de callAI() ────────────────────────────────────────────────

  /**
   * Reemplazo de callAI(sys, messages) de circulo_v0.
   * Misma firma. Devuelve { mensaje, entendido } como la original.
   *
   * En la migración completa (Goal 6.2+), sys y messages se procesarían
   * para extraer el estado de la gramática actual y enrutarlos al motor.
   * En Goal 6.1, la función delega al motor y mapea la respuesta.
   *
   * @param {string}   sys       — system prompt del estado actual de v0
   * @param {object[]} messages  — historial de la conversación
   * @param {string}   sessionId — ID de la sesión cognitiva
   * @param {object}   [v0State] — estado interno de v0 (opcional)
   */
  async function callAIReplacement(sys, messages, sessionId, v0State = null) {
    const input  = mapV0StateToApiInput({ ...(v0State || {}), sessionId }, sessionId);
    const result = await adapter.start(sessionId, input);
    // Usar el StateDTO incrustado en la respuesta de POST /pipeline (Task 6.2B1).
    // Fallback: si la respuesta no incluye state (respuesta antigua), GET /state.
    let stateDTO = adapter._lastResult?.state || null;
    if (!stateDTO && (result.uiState === UI_STATE.COMPLETED || result.uiState === UI_STATE.PAUSED)) {
      try { stateDTO = await adapter.fetchState(sessionId); } catch { /* degradación segura */ }
    }
    return mapApiResultToV0Reply(result, 'Sigo pensando… cuéntame un poco más.', stateDTO);
  }

  // ── API de estado y auditoría ────────────────────────────────────────────

  async function fetchCurrentState(sessionId) {
    return adapter.fetchState(sessionId);
  }

  async function fetchAudit(sessionId) {
    return adapter.fetchAudit(sessionId);
  }

  function canResume(stateDTO) {
    return adapter.canResume(stateDTO);
  }

  function describeCheckpoint(stateDTO) {
    return adapter.describeCheckpoint(stateDTO);
  }

  return Object.freeze({
    // Reemplazo funcional de callAI()
    callAIReplacement,
    // Acceso al estado y auditoría
    fetchCurrentState,
    fetchAudit,
    canResume,
    describeCheckpoint,
    // Acceso al adaptador para casos avanzados
    adapter,
    client,
    // Helpers de traducción (exportados para tests)
    mapV0StateToApiInput,
    mapApiResultToV0Reply,
  });
}

module.exports = {
  createV0Bridge,
  mapV0StateToApiInput,
  mapApiResultToV0Reply,
  buildEntendido,
  ALL_SLOTS,
  V0_STATE_TO_MOTOR_STAGE,
};
