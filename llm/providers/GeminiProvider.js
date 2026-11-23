'use strict';

/**
 * GEMINI PROVIDER
 * Adaptador de proveedor para la API de Google AI Studio (Generative Language API).
 * Construye el request con el formato oficial de Gemini (generateContent) y
 * normaliza la respuesta a la MISMA forma interna que ya consume LLMService
 * ({ error, errorType, errorMessage, text, stopReason, usage }) — el mismo
 * contrato que usa AnthropicProvider. LLMService no distingue de qué proveedor
 * vino esa forma normalizada.
 *
 * Mapeo de campos propios de Gemini al contrato interno:
 *   - finishReason (p.ej. "STOP", "MAX_TOKENS", "SAFETY")  -> stopReason
 *   - usageMetadata.promptTokenCount                       -> usage.input_tokens
 *   - usageMetadata.candidatesTokenCount                   -> usage.output_tokens
 *   - candidates[0].content.parts[].text (concatenado)     -> text
 *   - error.status || error.code                           -> errorType
 */

const { ERROR_CATEGORIES } = require('../LLMErrorTaxonomy');

// GEMINI_PROVIDER_ESTABILIDAD_1 — único lugar donde vive este string: si
// Google retira/reemplaza este modelo, se actualiza AQUÍ, nunca disperso.
// La robustez real del sistema no depende de que este valor nunca quede
// obsoleto (eso volverá a pasar) — depende de que CIRCULO_LLM_MODEL permita
// sobreescribirlo sin tocar código, de que el modelo efectivo quede
// trazable en cada llamada (ver LLMService._emit), y de que un modelo caído
// se clasifique como MODEL_UNAVAILABLE en vez de fallar en silencio bajo un
// mensaje genérico.
//
// 'gemini-2.5-flash' (default anterior) quedó confirmado deprecado por
// llamada REAL durante el smoke de este incremento: HTTP 404 NOT_FOUND,
// "This model models/gemini-2.5-flash is no longer available to new
// users." — exactamente el defecto que este incremento existe para
// resolver, y prueba de que la clasificación MODEL_UNAVAILABLE funciona
// end-to-end contra la API real, no solo en mocks.
//
// 'gemini-flash-latest' (default actual) es un ALIAS que Google mantiene
// apuntando al modelo flash vigente — no una versión fijada que volverá a
// deprecarse de la misma forma. Verificado por llamada real durante el
// mismo smoke: HTTP 200, JSON completo, finishReason=STOP, sin
// truncamiento. Esto reduce el riesgo de obsolescencia (Google resuelve el
// alias, no nosotros) pero NO lo elimina — si Google retira el propio
// alias, el mecanismo de clasificación/override sigue siendo la defensa
// real, no este string.
const DEFAULT_MODEL = 'gemini-flash-latest';
const API_BASE       = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROVIDER_NAME  = 'gemini';

// GEMINI_PROVIDER_ESTABILIDAD_1 — capacidad de "thinking" (presupuesto de
// razonamiento interno antes de producir la respuesta visible): existe
// desde la familia 2.5 en adelante, NO en 2.0/1.5. Enviar thinkingConfig a
// un modelo que no lo soporta es un parámetro inválido (falla la llamada) —
// nunca se envía fuera de esta tabla. Los modelos "flash" de la familia 2.5
// permiten thinkingBudget:0 (desactivarlo por completo); los "pro" exigen
// un mínimo distinto de cero y no se desactivan aquí — Círculo nunca se
// beneficia de thinking extendido en contratos JSON de un solo turno
// deterministas, así que se desactiva donde es seguro hacerlo y se omite
// por completo donde no. Tabla explícita y documentada — única fuente de
// verdad, actualizar aquí cuando cambie el catálogo de modelos de Google.
//
// LLM_CALL_PROFILE_GOVERNANCE_1 — conservada BYTE A BYTE como camino de
// compatibilidad para llamadas SIN callProfile (los 11 call-sites legacy
// de AgoraStages/Intelligence, excluidos de este incremento por decisión
// explícita — CAMINO_LEGACY_REACHABLE_DESDE_GRAMMAR_TURN: NO). Las
// llamadas migradas usan resolverPoliticaThinking (abajo), que además
// reconoce los ALIAS que este mismo archivo configura por defecto — el
// gap exacto que causó FASE_46B: DEFAULT_MODEL ('gemini-flash-latest') no
// era nunca una clave de esta tabla, así que thinkingBudget:0 nunca se
// enviaba para el modelo que el sistema usa por defecto.
const THINKING_CONFIG_POR_MODELO = Object.freeze({
  'gemini-2.5-flash':      { thinkingBudget: 0 },
  'gemini-2.5-flash-lite': { thinkingBudget: 0 },
});

function thinkingConfigParaModelo(model) {
  return THINKING_CONFIG_POR_MODELO[model] || null;
}

// LLM_CALL_PROFILE_GOVERNANCE_1 (Fase 5) — identificadores donde Círculo
// CONFIRMA que thinkingConfig es controlable: las mismas versiones exactas
// de THINKING_CONFIG_POR_MODELO, MÁS los alias que este despliegue
// configura por defecto (DEFAULT_MODEL y su equivalente "lite"). No es
// introspección de capacidades (la API de Gemini no la ofrece) ni una
// tabla que crece con cada versión nueva que Google publique — es la
// lista acotada y explícita de identificadores que ESTE despliegue puede
// llegar a solicitar, ampliada a mano cuando se confirme un caso nuevo,
// igual que la tabla anterior. Un alias o versión nueva NO entra aquí
// automáticamente: si no está en la lista, no se envía thinkingConfig
// (nunca un parámetro inválido) y el presupuesto de salida del perfil ya
// es el piso robusto que absorbe ese caso (ver CallProfiles.js).
// C007 — GEMINI MODEL CAPABILITY HANDLING (human product canary gate).
// 'gemini-3-flash-preview' y 'gemini-3.5-flash' confirmados por llamada
// REAL contra la API (generateContent, sin mocks): sin thinkingConfig,
// ambos consumen ~140-160 tokens invisibles de "thoughtsTokenCount" por
// defecto en cada respuesta, incluso ante un prompt trivial — exactamente
// el mecanismo que agota presupuestos de perfil acotados (300-2000 tokens)
// antes de emitir el JSON contratado (MODEL_RESPONSE_TRUNCATED/MAX_TOKENS,
// nunca antes atribuido a esto por no reconocerlos aquí). Con
// thinkingConfig:{thinkingBudget:1} el consumo de thoughtsTokenCount
// desaparece por completo (mismo HTTP 200/finishReason STOP) — la MISMA
// forma de control ya confirmada para gemini-flash-latest/gemini-2.5-flash.
// PROVIDER_CAPABILITY, no una tabla que crece a ciegas: cada entrada exige
// esta misma verificación real antes de añadirse, nunca coincidencia de
// nombre o familia sin evidencia — un modelo YA estable hoy sin control
// (p.ej. gemini-3.1-flash-lite) permanece deliberadamente FUERA de esta
// lista hasta que exista evidencia equivalente de que lo necesita; añadirlo
// sin esa evidencia arriesgaría cambiar el comportamiento de un executor
// que ya funciona (ver EXECUTOR_COMPATIBILITY_MUST_FOLLOW_PROVIDER_
// CAPABILITY_NOT_STALE_MODEL_NAME_KNOWLEDGE — la evidencia es la capacidad
// demostrada, nunca una suposición por versión o familia).
const MODELOS_GEMINI_CON_THINKING_CONTROLABLE = Object.freeze([
  ...Object.keys(THINKING_CONFIG_POR_MODELO),
  'gemini-flash-latest', 'gemini-flash-lite-latest',
  'gemini-3-flash-preview', 'gemini-3.5-flash',
]);

// LLM_CALL_PROFILE_GOVERNANCE_1 — smoke real contra la API (verificación
// posterior al diseño de este incremento, no una suposición): con el
// modelo que gemini-flash-latest resuelve HOY (gemini-3.6-flash),
// thinkingBudget:0 -- el valor que THINKING_CONFIG_POR_MODELO usa para
// gemini-2.5-flash -- es RECHAZADO por la API (400 INVALID_ARGUMENT,
// "Request contains an invalid argument"). thinkingBudget:1 SÍ es válido
// y sigue cumpliendo el objetivo (acotar, no necesariamente anular, el
// razonamiento invisible -- ver toleranciaThinking en CallProfiles.js:
// "impida que pensamiento invisible consuma casi todo el presupuesto
// útil", nunca exige exactamente cero). Deliberadamente el MISMO valor
// para toda la tabla de arriba (incluidas las versiones exactas heredadas
// de THINKING_CONFIG_POR_MODELO): 0 nunca se reverificó hoy contra la API
// real para esas versiones, y mantener un único valor confirmado es más
// seguro que confiar en un valor por versión sin evidencia vigente.
const THINKING_BUDGET_ACOTADO_CALLPROFILE = 1;

/**
 * LLM_CALL_PROFILE_GOVERNANCE_1 — traduce callProfile.toleranciaThinking a
 * la propiedad nativa de Gemini, cuando el modelo configurado es uno
 * donde esa traducción se sabe segura. Nunca inventa capacidad: si el
 * modelo no está en MODELOS_GEMINI_CON_THINKING_CONTROLABLE, no se envía
 * ninguna configuración (evita un parámetro inválido) — el perfil ya
 * provee un presupuesto de salida suficientemente robusto para ese caso.
 * @param {string} model — modelo configurado (ya resuelto con DEFAULT_MODEL)
 * @param {object|null} callProfile — perfil de CallProfiles.js, o null
 *   para el camino legacy sin perfil (preserva THINKING_CONFIG_POR_MODELO
 *   exactamente como antes de este incremento).
 * @returns {{ aplicada: boolean, config: object|null, motivo: string }}
 */
function resolverPoliticaThinking(model, callProfile) {
  if (!callProfile) {
    const config = thinkingConfigParaModelo(model);
    return config
      ? { aplicada: true, config, motivo: 'modelo_conocido_sin_callProfile' }
      : { aplicada: false, config: null, motivo: 'modelo_no_reconocido_sin_callProfile' };
  }
  if (!MODELOS_GEMINI_CON_THINKING_CONTROLABLE.includes(model)) {
    return { aplicada: false, config: null, motivo: 'modelo_no_reconocido_como_controlable' };
  }
  // 'ninguna'/'acotada' se traducen hoy al mismo valor: Círculo nunca se
  // beneficia de thinking extendido en contratos JSON de un solo turno
  // deterministas (mismo criterio documentado arriba en este archivo) —
  // 'libre' (ningún perfil actual lo declara) no restringe nada.
  if (callProfile.toleranciaThinking === 'libre') {
    return { aplicada: false, config: null, motivo: 'tolerancia_libre_sin_restriccion' };
  }
  return {
    aplicada: true, config: { thinkingBudget: THINKING_BUDGET_ACOTADO_CALLPROFILE },
    motivo: `tolerancia_${callProfile.toleranciaThinking}`,
  };
}

/**
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.userMsg
 * @param {string} [params.model]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {object|null} [params.callProfile] — LLM_CALL_PROFILE_GOVERNANCE_1:
 *   perfil resuelto de CallProfiles.js, o null/omitido para el camino
 *   legacy sin perfil (comportamiento byte a byte anterior).
 * @param {string} [params.responseMimeType] — native structured-output MIME type.
 * @param {object} [params.responseSchema] — native Gemini response schema.
 * @returns {{ url: string, body: object, thinkingPolicyAplicada: object }}
 */
function buildRequest({ system, userMsg, model, maxTokens, temperature, callProfile = null,
  responseMimeType, responseSchema } = {}) {
  const modeloEfectivo = model || DEFAULT_MODEL;
  const generationConfig = {};
  if (maxTokens !== undefined)   generationConfig.maxOutputTokens = maxTokens;
  if (temperature !== undefined) generationConfig.temperature     = temperature;
  const thinkingPolicyAplicada = resolverPoliticaThinking(modeloEfectivo, callProfile);
  if (thinkingPolicyAplicada.aplicada) generationConfig.thinkingConfig = thinkingPolicyAplicada.config;
  // Opt-in only: legacy provider calls retain their previous request shape.
  if (responseMimeType !== undefined) generationConfig.responseMimeType = responseMimeType;
  if (responseSchema !== undefined) generationConfig.responseSchema = responseSchema;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents:           [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig,
  };

  const url = `${API_BASE}/${modeloEfectivo}:generateContent`;
  return { url, body, thinkingPolicyAplicada };
}

/**
 * @param {object} data — cuerpo JSON ya parseado de la respuesta HTTP
 * @returns {{ error:boolean, errorType:string|null, errorMessage:string|null,
 *             text:string|null, stopReason:string|null,
 *             usage:{input_tokens:number,output_tokens:number}|null,
 *             modelVersion:string|null }}
 *   modelVersion — LLM_CALL_PROFILE_GOVERNANCE_1 (Fase 4, modelo
 *   configurado vs modelo efectivo): Gemini reporta en `data.modelVersion`
 *   a qué versión concreta resolvió el alias solicitado (p.ej.
 *   'gemini-flash-latest' -> 'gemini-3.6-flash', la evidencia exacta de
 *   FASE_46B). Nunca se usa para reconstruir el request ya enviado — solo
 *   observabilidad/auditoría posterior. `null` cuando el proveedor no lo
 *   incluyó (respuesta de error, por ejemplo).
 */
function parseResponse(data) {
  if (data.error) {
    return {
      error:        true,
      errorType:    data.error.status || (data.error.code != null ? String(data.error.code) : null) || 'unknown_error',
      errorMessage: data.error.message || null,
      text:         null,
      stopReason:   null,
      usage:        null,
      modelVersion: data.modelVersion || null,
    };
  }

  const candidate = (data.candidates || [])[0] || null;
  const parts     = candidate?.content?.parts || [];
  const text      = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
  const usageMeta = data.usageMetadata || null;

  return {
    error:        false,
    errorType:    null,
    errorMessage: null,
    text:         text || null,
    stopReason:   candidate?.finishReason || null,
    usage:        usageMeta ? {
      input_tokens:  usageMeta.promptTokenCount     ?? null,
      output_tokens: usageMeta.candidatesTokenCount ?? null,
    } : null,
    modelVersion: data.modelVersion || null,
  };
}

/**
 * GEMINI_PROVIDER_ESTABILIDAD_1 — traduce el vocabulario nativo de error de
 * Gemini (data.error.status, httpStatus, finishReason) a la taxonomía
 * compartida (ver LLMErrorTaxonomy). Nunca clasifica STRUCTURED_RESPONSE_INVALID
 * -- eso depende del contrato JSON de Círculo, que este proveedor no conoce.
 * `null` cuando no hay ningún error/truncamiento que clasificar (llamada
 * exitosa con contenido completo) -- LLMService decide entonces si el texto
 * recibido es válido.
 * @param {object} params
 * @param {number|null} params.httpStatus
 * @param {string|null} params.errorType — parseResponse(...).errorType
 * @param {string|null} params.stopReason — parseResponse(...).stopReason
 * @returns {string|null} una clave de ERROR_CATEGORIES, o null
 */
function classifyError({ httpStatus, errorType, stopReason }) {
  if (errorType) {
    switch (errorType) {
      case 'NOT_FOUND':
        return ERROR_CATEGORIES.MODEL_UNAVAILABLE;
      case 'PERMISSION_DENIED':
      case 'UNAUTHENTICATED':
        return ERROR_CATEGORIES.AUTH_CONFIGURATION_ERROR;
      case 'RESOURCE_EXHAUSTED':
        return ERROR_CATEGORIES.QUOTA_OR_RATE_LIMIT;
      default:
        // INVALID_ARGUMENT, UNAVAILABLE, DEADLINE_EXCEEDED, INTERNAL,
        // cualquier código HTTP de error sin status reconocido, o un
        // status nuevo que Google introduzca sin que esta tabla lo sepa
        // todavía -- nunca se adivina una categoría más específica sin
        // evidencia; PROVIDER_TRANSPORT_ERROR es el catch-all honesto
        // para "hubo un error real, no sabemos precisar más".
        return ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
    }
  }
  if (stopReason === 'MAX_TOKENS') return ERROR_CATEGORIES.MODEL_RESPONSE_TRUNCATED;
  if (httpStatus != null && httpStatus >= 400) return ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
  return null;
}

module.exports = {
  buildRequest, parseResponse, classifyError, thinkingConfigParaModelo,
  resolverPoliticaThinking,
  DEFAULT_MODEL, API_BASE, THINKING_CONFIG_POR_MODELO,
  MODELOS_GEMINI_CON_THINKING_CONTROLABLE, THINKING_BUDGET_ACOTADO_CALLPROFILE,
  PROVIDER_NAME,
};
