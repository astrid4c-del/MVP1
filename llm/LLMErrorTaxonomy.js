'use strict';

/**
 * TAXONOMÍA DE ERROR DEL LLM.
 *
 * GEMINI_PROVIDER_ESTABILIDAD_1. FASE_46 encontró tres contaminantes de
 * infraestructura mezclados en un único síntoma genérico ("Gate de salida
 * fallido"): modelo por defecto deprecado, ausencia de clasificación clara
 * de por qué falló una llamada, y presupuesto de output insuficiente bajo
 * modelos con "thinking". El sistema necesita poder distinguir "el modelo no
 * funciona" de "el contenido cognitivo falló" — esta es la única fuente de
 * verdad para esa distinción.
 *
 * Cada proveedor (GeminiProvider, AnthropicProvider) traduce SU PROPIO
 * vocabulario de error nativo (Gemini: data.error.status como
 * "RESOURCE_EXHAUSTED"/"PERMISSION_DENIED"/...; Anthropic: data.error.type
 * como "rate_limit_error"/"authentication_error"/...) a una de estas
 * categorías compartidas — nunca al revés: ni LLMService ni
 * InteraccionCognitivaWriter conocen el vocabulario nativo de ningún
 * proveedor concreto.
 *
 * STRUCTURED_RESPONSE_INVALID es la única categoría que NO clasifica ningún
 * proveedor — es responsabilidad exclusiva de LLMService (el contrato JSON
 * que Círculo exige nunca lo conoce el proveedor, que solo transporta texto).
 */

const ERROR_CATEGORIES = Object.freeze({
  // El modelo solicitado no existe, fue retirado, o no está disponible para
  // esta cuenta/región (p.ej. Gemini NOT_FOUND, Anthropic not_found_error).
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  // Credenciales ausentes, inválidas, o sin permiso para el recurso
  // solicitado (p.ej. Gemini PERMISSION_DENIED/UNAUTHENTICATED, Anthropic
  // authentication_error/permission_error).
  AUTH_CONFIGURATION_ERROR: 'AUTH_CONFIGURATION_ERROR',
  // Cuota agotada o límite de tasa excedido (p.ej. Gemini RESOURCE_EXHAUSTED,
  // Anthropic rate_limit_error/overloaded_error).
  QUOTA_OR_RATE_LIMIT: 'QUOTA_OR_RATE_LIMIT',
  // La respuesta se cortó por presupuesto de salida antes de completar el
  // contrato (p.ej. Gemini finishReason=MAX_TOKENS, Anthropic
  // stop_reason=max_tokens) — nunca confundido con contenido inválido: el
  // modelo funcionó, el presupuesto no alcanzó.
  MODEL_RESPONSE_TRUNCATED: 'MODEL_RESPONSE_TRUNCATED',
  // El proveedor respondió con éxito (HTTP ok, sin error de API, sin
  // truncamiento) pero el texto no contiene el JSON que Círculo exige, o no
  // es sintácticamente válido — exclusivo de LLMService, ningún proveedor
  // puede saberlo por sí mismo.
  STRUCTURED_RESPONSE_INVALID: 'STRUCTURED_RESPONSE_INVALID',
  // Cualquier otro fallo de transporte/API que no encaje en las categorías
  // anteriores (error de red, HTTP 5xx genérico, código de error del
  // proveedor no reconocido) — nunca el default silencioso de "todo lo
  // demás pasa"; se usa solo cuando el proveedor confirma que hubo un error
  // real y no puede clasificarlo con más precisión.
  PROVIDER_TRANSPORT_ERROR: 'PROVIDER_TRANSPORT_ERROR',
  // C007 human canary v9 — FIDELITY_LATENCY_CONTAINMENT. El executor nunca
  // respondió dentro del deadline de ejecución configurado para ESA llamada
  // (LLMService.call({ timeoutMs })) y la llamada fue abortada explícitamente
  // (AbortController) — nunca un error de transporte "normal" del proveedor,
  // que ya tiene su propia categoría (PROVIDER_TRANSPORT_ERROR): esto es
  // SLOW_EXECUTOR, no UNBOUNDED_USER_WAIT. Solo se produce cuando el
  // llamador opta explícitamente por un deadline; sin `timeoutMs`, ninguna
  // llamada (Producer, Realizer, reconciliación) puede generar esta
  // categoría — su comportamiento queda exactamente igual que antes.
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
});

const ERROR_CATEGORY_VALUES = Object.freeze(Object.values(ERROR_CATEGORIES));

module.exports = { ERROR_CATEGORIES, ERROR_CATEGORY_VALUES };
