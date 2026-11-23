'use strict';

/**
 * FRONTEND ADAPTER
 * Capa de compatibilidad entre CognitivoApiServer y la UI actual (circulo_v0).
 *
 * Responsabilidad:
 *   - Traducir DTOs de la API al formato esperado por la UI existente.
 *   - Exponer estados de UI: loading, paused, blocked, completed, error.
 *   - Soportar reanudación desde pipelineCheckpoint y agoraCheckpoint.
 *   - Nunca duplicar lógica de contratos, gates, policies ni orquestación.
 *
 * NO modifica circulo_v0.html ni circulo_e2e.html.
 * Esta capa es la que reemplazaría conceptualmente el acceso directo a callAI()
 * en el momento en que la UI se migre a la API nueva.
 *
 * Ref: Roadmap Fase 5 — tarea 5.3.
 */

const { CognitiveApiClient } = require('./CognitiveApiClient');

// ── Estados de UI ──────────────────────────────────────────────────────────────

const UI_STATE = Object.freeze({
  IDLE:      'idle',
  LOADING:   'loading',
  PAUSED:    'paused',
  BLOCKED:   'blocked',
  COMPLETED: 'completed',
  ERROR:     'error',
});

// Mapa de PIPELINE_STATUS → UI_STATE
const PIPELINE_TO_UI = Object.freeze({
  completed:       UI_STATE.COMPLETED,
  paused_hitl:     UI_STATE.PAUSED,
  stopped_gate:    UI_STATE.BLOCKED,
  stopped_budget:  UI_STATE.BLOCKED,
  stopped_error:   UI_STATE.ERROR,
  resumed:         UI_STATE.LOADING,
});

// ── FrontendAdapter ────────────────────────────────────────────────────────────

class FrontendAdapter {
  /**
   * @param {CognitiveApiClient} apiClient
   * @param {Function}           [onStateChange]  — cb(uiState, data) para la UI
   */
  constructor(apiClient, onStateChange = null) {
    if (!(apiClient instanceof CognitiveApiClient))
      throw new Error('FrontendAdapter: apiClient debe ser instancia de CognitiveApiClient');

    this._client         = apiClient;
    this._onStateChange  = onStateChange || (() => {});
    this._uiState        = UI_STATE.IDLE;
    this._lastResult     = null;
    this._sessionId      = null;
  }

  // ── API pública ────────────────────────────────────────────────────────────

  /** Estado actual de la UI */
  get uiState()     { return this._uiState; }
  get sessionId()   { return this._sessionId; }
  get lastResult()  { return this._lastResult; }

  /**
   * Inicia el pipeline para una sesión.
   * Equivale conceptualmente a lo que callAI() inicia en circulo_v0.
   */
  async start(sessionId, input = {}) {
    this._sessionId = sessionId;
    this._transition(UI_STATE.LOADING, null);

    const response = await this._client.runPipeline(sessionId, input);
    return this._handlePipelineResponse(response);
  }

  /**
   * Reanuda desde el último checkpoint.
   * Resuelve la pausa después de que el experto tomó una decisión HITL.
   */
  async resume(sessionId) {
    this._sessionId = sessionId;
    this._transition(UI_STATE.LOADING, null);

    const response = await this._client.runPipeline(sessionId, { resume: true });
    return this._handlePipelineResponse(response);
  }

  /**
   * Obtiene el estado actual de la sesión.
   * Replica el rol de `window.__seleccion` y similares — pero desde la API.
   */
  async fetchState(sessionId) {
    const response = await this._client.getState(sessionId);
    if (!response.ok) {
      if (response.error?.code === 'SESSION_NOT_FOUND') return null;
      throw new Error(`API error: ${response.error?.message}`);
    }
    return response.data;
  }

  /**
   * Obtiene el log de auditoría de la sesión.
   */
  async fetchAudit(sessionId) {
    const response = await this._client.getAudit(sessionId);
    if (!response.ok) return null;
    return response.data;
  }

  /**
   * Obtiene los eventos de la sesión.
   */
  async fetchEvents(sessionId) {
    const response = await this._client.getEvents(sessionId);
    if (!response.ok) return [];
    return response.data.eventos || [];
  }

  /**
   * Determina si la sesión puede reanudarse.
   * Usa pipelineCheckpoint y agoraCheckpoint del StateDTO.
   */
  canResume(stateDTO) {
    if (!stateDTO) return false;
    return !!(stateDTO.pipelineCheckpoint || stateDTO.agoraCheckpoint);
  }

  /**
   * Describe el checkpoint actual en lenguaje legible para la UI.
   * Sin jerga técnica — Ley de Invisibilidad.
   */
  describeCheckpoint(stateDTO) {
    if (!stateDTO) return null;
    const cp = stateDTO.pipelineCheckpoint;
    const ac = stateDTO.agoraCheckpoint;

    const labels = {
      comprension: 'Análisis del conocimiento completado',
      potenciacion:'Propuestas de enriquecimiento pendientes de revisión',
      contextual:  'Análisis de contexto completado',
      agora:       'Producto en construcción',
      inferencia:  'Definiendo perfil del alumno',
      opciones:    'Selección de posicionamiento pendiente',
      arquitectura:'Selección de camino de aprendizaje pendiente',
      evidencia:   'Definición de evidencias completada',
      forma:       'Estructura del producto definida',
      desarrollo:  'Contenido en desarrollo',
      bonus:       'Acompañante estratégico definido',
      blueprint:   'Producto completado',
    };

    if (ac) return labels[ac] || `Pausado en: ${ac}`;
    if (cp) return labels[cp] || `Completado hasta: ${cp}`;
    return null;
  }

  /**
   * Construye el resumen del producto compatible con el formato que
   * circulo_v0 espera en `window.__formaProducto`.
   * Sin modificar la UI — esta función produce el objeto equivalente.
   */
  toFormaProductoCompat(stateDTO) {
    // El StateDTO no expone formaProducto directamente (solo hasFormaProducto)
    // Esta función señala que para obtenerlo se necesita una llamada adicional al API
    // o acceso al state completo. En circulo_v0 migrado, reemplazaría window.__formaProducto.
    return {
      disponible: stateDTO?.hasFormaProducto ?? false,
      sesionId:   stateDTO?.sesionId         ?? null,
      // El contenido real se obtiene vía GET /state/:sessionId con campos expandidos
      _nota: 'Obtener vía GET /state/:sessionId',
    };
  }

  // ── Helpers internos ───────────────────────────────────────────────────────

  _handlePipelineResponse(response) {
    if (!response.ok) {
      const msg = response.error?.message || 'Error desconocido';
      this._transition(UI_STATE.ERROR, { message: msg, code: response.error?.code });
      return { uiState: UI_STATE.ERROR, message: msg };
    }

    const result = response.data;
    const uiSt   = PIPELINE_TO_UI[result.status] || UI_STATE.ERROR;

    this._lastResult = result;
    this._transition(uiSt, result);

    return {
      uiState:    uiSt,
      status:     result.status,
      razon:      result.razon       || null,
      checkpoint: result.etapaAlcanzada || null,
      completed:  uiSt === UI_STATE.COMPLETED,
      paused:     uiSt === UI_STATE.PAUSED,
      blocked:    uiSt === UI_STATE.BLOCKED,
    };
  }

  _transition(newState, data) {
    this._uiState = newState;
    try { this._onStateChange(newState, data); } catch { /* UI errors no bloquean el cliente */ }
  }
}

module.exports = { FrontendAdapter, UI_STATE, PIPELINE_TO_UI };
