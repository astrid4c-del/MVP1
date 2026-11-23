'use strict';

/**
 * PERFILES DE LLAMADA LLM.
 *
 * LLM_CALL_PROFILE_GOVERNANCE_1 — FASE_46B demostró que presupuestos de
 * generación/thinking dispersos por caso de uso (números mágicos locales:
 * MAX_TOKENS_VEREDICTO=700, 600 de reconciliación,
 * TOKENS_CONTRATO_ESTRUCTURADO_GRAMATICA=2000, etc.) no protegen contra el
 * riesgo real: un modelo con "thinking" no gobernado puede consumir casi
 * todo un presupuesto pequeño (672 de 700 tokens fueron razonamiento
 * invisible, cero salida real) sin que el caso de uso tenga forma de
 * saberlo ni de defenderse — el número por sí solo nunca fue la causa raíz.
 *
 * Frontera adoptada (Fase 3 del incremento):
 *   CASO_DE_USO -> callProfile -> LLMService -> Provider -> request
 *   específico del provider/modelo.
 *
 * Un caso de uso declara QUÉ TIPO DE TRABAJO necesita ("necesito un
 * veredicto estructurado"), NUNCA maxTokens/thinkingBudget/nombre de
 * modelo concreto — ver Test L (Writer/casos de uso no conocen
 * thinkingConfig/thinkingBudget/modelos Gemini). Esa traducción vive
 * exclusivamente en LLMService (resuelve el presupuesto del perfil) y en
 * cada Provider (traduce tolerancia de thinking a SU propio mecanismo,
 * cuando lo tiene — ver GeminiProvider.resolverPoliticaThinking /
 * AnthropicProvider.buildRequest).
 *
 * Perfiles derivados del inventario real (Fase 1) de los 8 call-sites
 * vivos alcanzables desde /grammar-turn — nunca adoptados por nombre de
 * gramática ni por call-site individual. Los 11 call-sites de
 * AgoraStages.js/Intelligence (PotenciacionIntelligence,
 * ComprensionIntelligence, ContextualIntelligence, TransformationIntelligence)
 * quedan EXCLUIDOS de esta derivación por decisión explícita: no son
 * alcanzables desde el camino vivo (PipelineApplicationService está
 * marcado "legado" en CognitivoApiServer.js y start-server.js documenta
 * que /grammar-turn usa InteraccionCognitivaWriter en su lugar desde el
 * Incremento 4) — ver CAMINO_LEGACY_REACHABLE_DESDE_GRAMMAR_TURN: NO.
 *
 * Campos:
 *   FORMATO — 'JSON' (sin prosa libre) | 'JSON_CON_PROSA' (JSON con un
 *     campo de texto destinado a mostrarse al usuario).
 *   COMPLEJIDAD — 'baja'|'media'|'alta'. Documental: explica el porqué del
 *     presupuesto elegido, no gobierna nada por sí sola.
 *   TOLERANCIA_A_THINKING — 'ninguna' (nada que razonar — realización
 *     pura de algo ya decidido), 'acotada' (razonamiento interno puede
 *     tener valor real, pero NUNCA debe poder consumir el presupuesto de
 *     salida útil — exactamente el fallo de FASE_46B), 'libre' (sin
 *     restricción — ningún perfil actual lo usa; existe para que un
 *     futuro perfil legítimamente exploratorio pueda declararlo sin
 *     inventar un cuarto valor sobre la marcha).
 *   PRESUPUESTO_SALIDA_BASE — piso de maxOutputTokens para itemCount=0.
 *   ESCALA_POR_ITEM — tokens adicionales por elemento de lote (0 si el
 *     contrato del perfil nunca varía por lote).
 *
 * No maximiza indiscriminadamente: cada base es un piso derivado del
 * máximo ya usado dentro de esa familia (ver auditoría Fase 1), con
 * margen para que un modelo cuya capacidad de thinking no puede
 * confirmarse (ver GeminiProvider) no reproduzca el truncamiento de
 * FASE_46B — no una garantía absoluta, un piso razonado.
 */

const CALL_PROFILES = Object.freeze({
  // Familia: reconciliación histórica, veredicto relacional (el call-site
  // de FASE_46B), su reintento de reemplazo, y los dos adjudicadores
  // semánticos (delta de conceptos por lote, mutación de concepto único).
  // Ninguno produce prosa para el usuario — solo juicio estructurado sobre
  // contexto ya dado. Máximo previo dentro de la familia: 700
  // (MAX_TOKENS_VEREDICTO, el que truncó). escalaPorItem preserva la
  // necesidad real de tamaño variable del adjudicador por lote (antes
  // "200 + 150*N" local) como política del perfil, no como fórmula
  // dispersa en el call-site.
  VEREDICTO_ESTRUCTURADO: Object.freeze({
    nombre: 'VEREDICTO_ESTRUCTURADO',
    formato: 'JSON',
    complejidad: 'alta',
    toleranciaThinking: 'acotada',
    presupuestoSalidaBase: 1000,
    escalaPorItem: 150,
  }),
  // Familia: construcción principal (legado y V2/contrato-por-estado) —
  // produce, en una sola llamada, extracción estructurada (slots,
  // next_user_action, gobernanza) Y el mensaje conversacional visible.
  // Máximo previo: 2000 (TOKENS_CONTRATO_ESTRUCTURADO_GRAMATICA), sin
  // evidencia de truncamiento en FASE_46B — se preserva sin inflar.
  GENERACION_COGNITIVA_ESTRUCTURADA: Object.freeze({
    nombre: 'GENERACION_COGNITIVA_ESTRUCTURADA',
    formato: 'JSON_CON_PROSA',
    complejidad: 'alta',
    toleranciaThinking: 'acotada',
    presupuestoSalidaBase: 2000,
    escalaPorItem: 0,
  }),
  // Familia: realizador-conversacional — nada que decidir, solo redactar
  // el mensaje final ya resuelto por otras piezas (movimiento/objetivo/
  // observación). Máximo previo: 300, sin evidencia de truncamiento; el
  // propio call-site ya absorbe el riesgo con maxRetries:1 + fallback
  // determinista arquitectónico (ver InteraccionCognitivaWriter.js) — se
  // preserva sin inflar.
  REALIZACION_CONVERSACIONAL: Object.freeze({
    nombre: 'REALIZACION_CONVERSACIONAL',
    formato: 'JSON_CON_PROSA',
    complejidad: 'baja',
    toleranciaThinking: 'ninguna',
    presupuestoSalidaBase: 300,
    escalaPorItem: 0,
  }),
  VALIDACION_FIDELIDAD_REALIZACION: Object.freeze({
    nombre: 'VALIDACION_FIDELIDAD_REALIZACION',
    formato: 'JSON_ESTRUCTURADO',
    complejidad: 'baja',
    toleranciaThinking: 'ninguna',
    // El veredicto debe caber incluso cuando el contrato proyectado incluye
    // material scoped y contexto reciente; 120 truncaba JSON válido en Gemini.
    presupuestoSalidaBase: 300,
    escalaPorItem: 0,
  }),
});

/**
 * @param {string} callProfileName
 * @returns {object} el perfil congelado
 * @throws si el nombre no existe — nunca un fallback silencioso a un
 *   perfil por defecto (Fase 7, "no fallback silencioso").
 */
function resolveProfile(callProfileName) {
  const profile = CALL_PROFILES[callProfileName];
  if (!profile) {
    throw new Error(
      `CallProfiles: callProfile desconocido "${callProfileName}" — `
      + `valores válidos: ${Object.keys(CALL_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

/**
 * @param {string} callProfileName
 * @param {object} [opts]
 * @param {number} [opts.itemCount] — tamaño de lote, solo relevante para
 *   perfiles con escalaPorItem>0 (VEREDICTO_ESTRUCTURADO, adjudicación por
 *   lote). 0 (default) para llamadas de un solo ítem.
 * @returns {number} maxOutputTokens resuelto para esta llamada
 */
function resolveOutputBudget(callProfileName, { itemCount = 0 } = {}) {
  const profile = resolveProfile(callProfileName);
  return profile.presupuestoSalidaBase + profile.escalaPorItem * itemCount;
}

module.exports = { CALL_PROFILES, resolveProfile, resolveOutputBudget };
