'use strict';

/**
 * ANTHROPIC PROVIDER
 * Adaptador de proveedor para la API de Mensajes de Anthropic.
 * Construye el request y normaliza la respuesta a la forma interna que
 * LLMService ya consume ({ error, errorType, errorMessage, text, stopReason, usage }).
 *
 * Es el proveedor por defecto de LLMService — este archivo es una extracción
 * literal de la lógica que antes vivía inline en LLMService.call()/callAuditor(),
 * sin cambiar ningún campo, valor por defecto ni comportamiento observable.
 */

const { ERROR_CATEGORIES } = require('../LLMErrorTaxonomy');

const DEFAULT_MODEL   = 'claude-sonnet-4-6';
const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const PROVIDER_NAME   = 'anthropic';

/**
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.userMsg
 * @param {string} [params.model]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {object|null} [params.callProfile] — LLM_CALL_PROFILE_GOVERNANCE_1:
 *   aceptado por paridad de contrato con GeminiProvider.buildRequest, pero
 *   deliberadamente IGNORADO — ver thinkingPolicyAplicada abajo.
 * @returns {{ url: string, body: object, thinkingPolicyAplicada: object }}
 */
function buildRequest({ system, userMsg, model, maxTokens, temperature, callProfile = null }) {
  const body = {
    model:      model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages:   [{ role: 'user', content: userMsg }],
  };
  if (temperature !== undefined) body.temperature = temperature;
  // LLM_CALL_PROFILE_GOVERNANCE_1 — Anthropic no tiene una propiedad
  // equivalente a Gemini thinkingConfig que esté activa POR DEFECTO: sin
  // un parámetro `thinking:{...}` explícito (que este código nunca envía),
  // Claude no consume el presupuesto de salida con razonamiento invisible.
  // El riesgo que motiva este incremento (ver FASE_46B) es específico del
  // comportamiento de Gemini 2.5+. "No exigir que todos los providers
  // implementen knobs que no poseen" — este provider deliberadamente no
  // traduce callProfile.toleranciaThinking a ninguna propiedad del request.
  const thinkingPolicyAplicada = { aplicada: false, config: null, motivo: 'proveedor_sin_thinking_por_defecto' };
  return { url: DEFAULT_API_URL, body, thinkingPolicyAplicada };
}

/**
 * @param {object} data — cuerpo JSON ya parseado de la respuesta HTTP
 * @returns {{ error:boolean, errorType:string|null, errorMessage:string|null,
 *             text:string|null, stopReason:string|null,
 *             usage:{input_tokens:number,output_tokens:number}|null,
 *             modelVersion:string|null }}
 *   modelVersion — LLM_CALL_PROFILE_GOVERNANCE_1 (Fase 4): el campo
 *   `model` que Anthropic devuelve en toda respuesta exitosa, confirmando
 *   qué modelo sirvió el request — mismo propósito observacional que
 *   GeminiProvider.parseResponse (auditoría/trazabilidad, nunca reconstruye
 *   el request ya enviado).
 */
function parseResponse(data) {
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    error:        !!data.error,
    errorType:    data.error?.type    || null,
    errorMessage: data.error?.message || null,
    text:         text || null,
    stopReason:   data.stop_reason    || null,
    usage:        data.usage          || null,
    modelVersion: data.model || null,
  };
}

/**
 * GEMINI_PROVIDER_ESTABILIDAD_1 — mismo contrato que GeminiProvider.classifyError,
 * traduciendo el vocabulario nativo de Anthropic (data.error.type,
 * stop_reason) a la taxonomía compartida. Nunca clasifica
 * STRUCTURED_RESPONSE_INVALID.
 * @param {object} params
 * @param {number|null} params.httpStatus
 * @param {string|null} params.errorType — parseResponse(...).errorType
 * @param {string|null} params.stopReason — parseResponse(...).stopReason
 * @returns {string|null}
 */
function classifyError({ httpStatus, errorType, stopReason }) {
  if (errorType) {
    switch (errorType) {
      case 'not_found_error':
        return ERROR_CATEGORIES.MODEL_UNAVAILABLE;
      case 'authentication_error':
      case 'permission_error':
        return ERROR_CATEGORIES.AUTH_CONFIGURATION_ERROR;
      case 'rate_limit_error':
      case 'overloaded_error':
        return ERROR_CATEGORIES.QUOTA_OR_RATE_LIMIT;
      default:
        // invalid_request_error, api_error, o cualquier tipo nuevo que
        // Anthropic introduzca sin que esta tabla lo sepa todavía --
        // mismo criterio que GeminiProvider: catch-all honesto, nunca una
        // categoría más específica sin evidencia.
        return ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
    }
  }
  if (stopReason === 'max_tokens') return ERROR_CATEGORIES.MODEL_RESPONSE_TRUNCATED;
  if (httpStatus != null && httpStatus >= 400) return ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
  return null;
}

module.exports = { buildRequest, parseResponse, classifyError, DEFAULT_MODEL, DEFAULT_API_URL, PROVIDER_NAME };
