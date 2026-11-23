'use strict';

/**
 * VALIDADOR + CORRECCIÓN DE SOPORTE SEMÁNTICO DE UNA GANANCIA GOBERNADA.
 *
 * C007 — PRODUCER_CROSS_FIELD_EVIDENCE_STALENESS (Daniel-adjudicated, real
 * evidence: logistica_c0 turn 10). REFERENTIAL_SUPPORT_VALIDITY !=
 * SEMANTIC_SUPPORT_VALIDITY: validarIntegridadReferencialRepresentacionProductor
 * already proves a cited evidenciaConceptoId RESOLVES against something real
 * (durable graph or this same output's own conceptosNuevos) — it never asks
 * whether that concept actually SUBSTANTIATES the specific gain proposition
 * that cites it. A real, resolvable, but off-topic concept (a stale durable
 * concept from an earlier turn, cited instead of — or alongside — the
 * concept(s) this turn's own gain is actually about) can silently become
 * `soporteConceptoIds`, and downstream `materialAfirmableParaActo` then
 * projects that WRONG material as the Realizer's entire content authority.
 * Both Realizer (faithfully rendering what it was given) and Fidelity
 * (correctly rejecting a restatement that never expresses the contracted
 * gain) behave exactly as designed in that case — this module closes the
 * real, upstream gap: nothing previously asked "does this exact concept
 * substantiate THIS exact gain."
 *
 * Two narrow, single-purpose LLM adjudicators, same deliberate pattern as
 * ValidadorNovedadCognitivaResiduo.js / ValidadorSemanticoDeltaConceptos.js:
 * neither produces a new gain, neither picks the next cognitive act, neither
 * creates a concept, neither authorizes visible wording. GAIN SUPPORT != GAIN
 * WORDING AUTHORITY is untouched -- these adjudicators only ever gate WHICH
 * already-resolved concept ids are legitimate soporteConceptoIds for a gain
 * whose own texto (WHAT) is frozen and never regenerated here.
 *
 *   1. validarSoporteSemanticoGanancia -- judges the CURRENTLY-cited support
 *      set as a whole: does it substantiate this exact gain? Fails closed
 *      (never trusts the benefit of the doubt) on any transport/parse issue.
 *   2. seleccionarSoporteSemanticoCorregido -- REPAIR MAY PROPOSE SUPPORT !=
 *      SUPPORT IS GOVERNED: given the frozen gain WHAT and a FINITE, already
 *      pre-authorized list of candidate concepts (durable governed concepts
 *      + this output's own conceptosNuevos that independently pass ordinary
 *      grounding), selects (via an enum-constrained schema -- it can never
 *      mint an id nobody offered it) which of those ALREADY-LEGITIMATE
 *      candidates, if any, actually substantiate the gain. Its own selection
 *      is never trusted directly -- the caller must referentially AND
 *      semantically re-validate before treating corrected support as
 *      governed (validarSoporteSemanticoGanancia runs again on its output).
 *
 * PRODUCER_CROSS_FIELD_EVIDENCE_STALENESS_VALIDATOR_RELIABILITY (C007,
 * Daniel-adjudicated, real evidence: logistica_c0 fresh-live turn 3,
 * session live_complete_logistica_c0_11ec6033). THEMATIC_RELATEDNESS !=
 * SUBSTANTIVE_SUPPORT: validarSoporteSemanticoGanancia above ran, received
 * the correct gananciaTexto and correct candidatosSoporte, and asked
 * exactly the right discriminating question -- but a single LLM verdict on
 * a real cross-turn citation (a governed concept from an EARLIER committed
 * turn, thematically adjacent to but substantively different from the
 * frozen gain) came back SUPPORTS_GAIN when it should not have. This is not
 * a defect in that validator's contract or prompt -- it is a reliability
 * gap in trusting a single positive verdict for exactly this narrow,
 * demonstrated risk class: HIGH_RISK_CROSS_TURN_SUPPORT (see
 * esSoporteCrossTurnoDeAltoRiesgo below). CROSS_TURN_SUPPORT MAY BE VALID
 * (memory belongs to Círculo -- this never prohibits citing an earlier
 * turn's governed knowledge); it just requires higher confidence before it
 * becomes visible authority.
 *
 *   3. desafiarSoporteCrossTurnoGanancia -- CHALLENGE_CROSS_TURN_GAIN_SUPPORT,
 *      an adversarial corroborator, never a duplicate of #1's prompt: it is
 *      told to assume the proposed support may be merely thematically
 *      related and to try to FALSIFY substantive support, decomposing the
 *      frozen gain into its own material claims and requiring each one be
 *      grounded in an exact, quotable span of a cited concept's OWN
 *      governed description. It sees ONLY the frozen gain text and the
 *      exact cited support concepts (id + governed description) -- no
 *      alternate candidates, no Producer JSON, no Decision, no visible
 *      wording -- so it cannot rewrite the gain, cannot choose replacement
 *      support, cannot create a concept, cannot authorize wording. Its own
 *      claimed evidence spans are never trusted directly either -- see
 *      spansEvidenciaFundamentadosYCoberturaCompleta, the deterministic,
 *      non-LLM check the caller runs on this function's output before ever
 *      treating a positive verdict as authorization.
 */

const VALIDADOR_ID = 'validador_soporte_semantico_ganancia';
const VALIDADOR_VERSION = '1';
const SELECTOR_ID = 'seleccion_soporte_semantico_ganancia';
const SELECTOR_VERSION = '1';

const VEREDICTOS_SOPORTE_VALIDOS = Object.freeze([
  'SUPPORTS_GAIN', 'CONTRADICTS_GAIN', 'OFF_TOPIC_SUPPORT',
]);

function buildSystemPromptSoporteSemantico({ gananciaTexto, candidatosSoporte, mensajeUsuario }) {
  const listaCandidatos = (candidatosSoporte || [])
    .map((c, i) => `  ${i + 1}. [${c.id}] "${c.descripcion}"`).join('\n');
  return `Eres un ADJUDICADOR. No propones una ganancia nueva, no eliges el próximo acto cognitivo, no creas conceptos, no redactas nada visible. Tu ÚNICA tarea: decidir si el conjunto de conceptos gobernados de abajo SUSTANCIA realmente la ganancia cognitiva ya congelada, o si es evidencia real pero fuera de tema (de otro momento/criterio de la conversación) para esa ganancia específica.

GANANCIA COGNITIVA CONGELADA (el WHAT ya decidido; nunca lo reescribas ni lo evalúes por su redacción):
"${gananciaTexto}"

CONCEPTOS GOBERNADOS CITADOS COMO SOPORTE DE ESA GANANCIA (ya existen y son reales; tu única pregunta es si sustentan ESTA ganancia, no si existen):
${listaCandidatos || '  (ninguno)'}

MENSAJE REAL DEL EXPERTO ESTE TURNO (contexto, nunca autoridad por sí solo):
"${mensajeUsuario || ''}"

Decide comparando exclusivamente SIGNIFICADO: ¿lo que dicen estos conceptos, en conjunto, es efectivamente la evidencia que sustenta la afirmación de la ganancia congelada? Una coincidencia temática superficial, un concepto real pero de otro criterio/ejemplo/momento de la conversación, o evidencia que contradice la ganancia, NUNCA cuentan como soporte válido. Ignora antigüedad, proximidad de turno o quién lo citó -- juzga solo si el contenido sustenta la ganancia.

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor:
{ "veredicto": "SUPPORTS_GAIN" | "CONTRADICTS_GAIN" | "OFF_TOPIC_SUPPORT", "razon": "<una frase breve>" }`;
}

/**
 * Única llamada real al LLM de este verificador -- de solo lectura, sin
 * capacidad de producir nada. Falla cerrado (soporteValido:false) ante
 * cualquier error de transporte, parseo, o forma de respuesta inesperada --
 * el soporte citado nunca obtiene el beneficio de la duda por un fallo del
 * verificador.
 */
async function validarSoporteSemanticoGanancia({
  llmService, gananciaTexto, candidatosSoporte = [], mensajeUsuario = null, turnoId = null,
}) {
  const failClosed = (codigoRazon) => ({
    soporteValido: false, veredicto: null, razon: null,
    validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, codigoRazon,
  });
  if (typeof gananciaTexto !== 'string' || !gananciaTexto.trim()) return failClosed('GANANCIA_AUSENTE');
  if (!Array.isArray(candidatosSoporte) || candidatosSoporte.length === 0) return failClosed('SOPORTE_AUSENTE');

  const system = buildSystemPromptSoporteSemantico({ gananciaTexto, candidatosSoporte, mensajeUsuario });
  let r;
  try {
    r = await llmService.call({
      system, userMsg: mensajeUsuario || '', label: VALIDADOR_ID,
      callProfile: 'VEREDICTO_ESTRUCTURADO', turnoId,
    });
  } catch (e) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  const parsed = r && r.parsed;
  if (!parsed || typeof parsed !== 'object' || !VEREDICTOS_SOPORTE_VALIDOS.includes(parsed.veredicto)) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  return {
    soporteValido: parsed.veredicto === 'SUPPORTS_GAIN',
    veredicto: parsed.veredicto,
    razon: typeof parsed.razon === 'string' ? parsed.razon.trim() : null,
    validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, codigoRazon: null,
  };
}

function buildSelectorSchema(idsPermitidos) {
  return Object.freeze({
    type: 'OBJECT',
    properties: {
      idsSeleccionados: {
        type: 'ARRAY',
        items: { type: 'STRING', enum: [...idsPermitidos] },
      },
      ningunoLegitimo: { type: 'BOOLEAN' },
    },
    required: ['idsSeleccionados', 'ningunoLegitimo'],
  });
}

function buildSystemPromptSeleccionSoporte({ gananciaTexto, candidatosLegitimos, mensajeUsuario }) {
  const lista = (candidatosLegitimos || [])
    .map((c, i) => `  ${i + 1}. [${c.id}] "${c.descripcion}"`).join('\n');
  return `Eres Círculo. REPARACION_SOPORTE_SEMANTICO_GANANCIA. La ganancia cognitiva de abajo ya está congelada -- NUNCA la reescribas, ni propongas otra. Tu única tarea: de la lista de conceptos YA GOBERNADOS y legítimos de abajo, seleccionar cuáles (si alguno) sustancian realmente esa ganancia. Solo puedes elegir ids de la lista -- nunca inventar uno nuevo, nunca crear un concepto, nunca proponer una relación.

GANANCIA COGNITIVA CONGELADA (nunca la cambies):
"${gananciaTexto}"

CONCEPTOS YA GOBERNADOS Y ELEGIBLES (única lista permitida; selecciona por id exacto):
${lista || '  (ninguno)'}

MENSAJE REAL DEL EXPERTO ESTE TURNO (contexto, nunca autoridad por sí solo):
"${mensajeUsuario || ''}"

Si ninguno de estos conceptos sustancia realmente la ganancia, marca "ningunoLegitimo": true y deja "idsSeleccionados" vacío -- nunca fuerces una selección solo para llenar el campo.

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor.`;
}

/**
 * REPAIR MAY PROPOSE SUPPORT != SUPPORT IS GOVERNED -- this function's own
 * selection is never trusted as final; the caller re-runs
 * validarSoporteSemanticoGanancia on whatever it returns before treating the
 * correction as governed. Schema-enum-constrained to `candidatosLegitimos`
 * only -- structurally cannot mint an id nobody offered it, cannot create a
 * concept, cannot rewrite the gain. Fails closed to
 * {idsSeleccionados:[], ningunoLegitimo:true} on any transport/parse issue.
 */
async function seleccionarSoporteSemanticoCorregido({
  llmService, gananciaTexto, candidatosLegitimos = [], mensajeUsuario = null, turnoId = null,
}) {
  const failClosed = (codigoRazon) => ({
    idsSeleccionados: [], ningunoLegitimo: true,
    selectorId: SELECTOR_ID, selectorVersion: SELECTOR_VERSION, codigoRazon,
  });
  if (typeof gananciaTexto !== 'string' || !gananciaTexto.trim()) return failClosed('GANANCIA_AUSENTE');
  if (!Array.isArray(candidatosLegitimos) || candidatosLegitimos.length === 0) return failClosed('SIN_CANDIDATOS_LEGITIMOS');

  const idsPermitidos = candidatosLegitimos.map(c => c.id).filter(Boolean);
  const system = buildSystemPromptSeleccionSoporte({ gananciaTexto, candidatosLegitimos, mensajeUsuario });
  let r;
  try {
    r = await llmService.call({
      system, userMsg: mensajeUsuario || '', label: SELECTOR_ID,
      callProfile: 'VEREDICTO_ESTRUCTURADO', responseMimeType: 'application/json',
      responseSchema: buildSelectorSchema(idsPermitidos), turnoId,
    });
  } catch (e) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  const parsed = r && r.parsed;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.idsSeleccionados)) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  // DEFENSIVE_RE-CHECK -- the schema already enum-constrains this; never
  // trust a malformed/tampered response past that boundary.
  const idsPermitidosSet = new Set(idsPermitidos);
  const idsSeleccionados = parsed.idsSeleccionados.filter(id => idsPermitidosSet.has(id));
  if (parsed.ningunoLegitimo === true || idsSeleccionados.length === 0) {
    return { idsSeleccionados: [], ningunoLegitimo: true, selectorId: SELECTOR_ID, selectorVersion: SELECTOR_VERSION, codigoRazon: null };
  }
  return { idsSeleccionados, ningunoLegitimo: false, selectorId: SELECTOR_ID, selectorVersion: SELECTOR_VERSION, codigoRazon: null };
}

const CHALLENGE_ID = 'desafio_soporte_cross_turno_ganancia';
const CHALLENGE_VERSION = '1';

/**
 * HIGH_RISK_CROSS_TURN_SUPPORT (narrowest demonstrated risk class): the gain
 * belongs to the current turn (always true for a candidate reaching this
 * gate -- gananciaCognitiva is only ever a this-turn proposal) AND at least
 * one cited support concept's OWN durable provenance field says it was
 * governed in an EARLIER committed turn. Reuses concepto.turnoOrigenId --
 * the existing, already-populated authority (GrafoConocimientoPolicy.js,
 * "el turno real que originó este concepto") -- never inferred from string
 * id shape/age. A concept with unavailable/unknown provenance (turnoOrigenId
 * null -- pre-existing data from before this field existed) is treated
 * conservatively as NOT-verified-current-turn: this only ever ADDS a
 * corroboration step, never blocks anything outright, so treating unknown
 * provenance as higher-risk is the safe direction. Does NOT trigger merely
 * because ids differ, support is non-lexical, or same-turn conceptosNuevos
 * also exist alongside it -- and never auto-prefers current-turn concepts.
 * @param {Array<{id, turnoOrigenId}>} candidatosSoporte
 * @param {string} turnoClienteId -- the CURRENT turn's own client id
 */
function esSoporteCrossTurnoDeAltoRiesgo(candidatosSoporte, turnoClienteId) {
  return (candidatosSoporte || []).some(c => c && c.turnoOrigenId !== turnoClienteId);
}

function buildChallengeSchema(idsPermitidos) {
  return Object.freeze({
    type: 'OBJECT',
    properties: {
      supportValid: { type: 'BOOLEAN' },
      materialGainClaims: { type: 'ARRAY', items: { type: 'STRING' } },
      supportEvidence: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            gainClaim: { type: 'STRING' },
            supportConceptId: { type: 'STRING', enum: [...idsPermitidos] },
            evidenceSpan: { type: 'STRING' },
          },
          required: ['gainClaim', 'supportConceptId', 'evidenceSpan'],
        },
      },
      unsupportedMaterialClaims: { type: 'ARRAY', items: { type: 'STRING' } },
      reason: { type: 'STRING' },
    },
    required: ['supportValid', 'materialGainClaims', 'supportEvidence', 'unsupportedMaterialClaims', 'reason'],
  });
}

function buildSystemPromptDesafioSoporteCrossTurno({ gananciaTexto, candidatosSoporte }) {
  const lista = (candidatosSoporte || [])
    .map((c, i) => `  ${i + 1}. [${c.id}] "${c.descripcion}"`).join('\n');
  return `Eres un ADJUDICADOR ADVERSARIAL. Tu trabajo es INTENTAR REFUTAR, no confirmar, que el soporte citado abajo sustancia realmente la ganancia cognitiva congelada. Asume que el soporte propuesto puede ser meramente temáticamente relacionado -- tu tarea es intentar falsificar la afirmación de que sustancia sustantivamente esta ganancia exacta. No propones una ganancia nueva, no eliges el próximo acto cognitivo, no creas conceptos, no seleccionas soporte alternativo, no redactas nada visible.

GANANCIA COGNITIVA CONGELADA (nunca la reescribas):
"${gananciaTexto}"

PASO 1 -- DESCOMPONE la ganancia en sus afirmaciones materiales distintas y verificables (materialGainClaims). Cada afirmación debe ser una unidad de significado concreta que la ganancia sostiene (p.ej. una ganancia sobre "detectar X mediante Y y Z" tiene AL MENOS dos afirmaciones materiales: una sobre X/Y y otra sobre Z).

CONCEPTOS GOBERNADOS CITADOS COMO SOPORTE (única fuente permitida de evidencia -- no existe otro soporte disponible):
${lista || '  (ninguno)'}

PASO 2 -- Para CADA afirmación material, busca si algún concepto citado la sustenta genuinamente por SIGNIFICADO (no exige las mismas palabras -- una paráfrasis semánticamente equivalente cuenta). Si la encuentras, registra en "supportEvidence" un objeto con: "gainClaim" (copiado EXACTAMENTE de materialGainClaims), "supportConceptId" (el id exacto del concepto citado), y "evidenceSpan" (un fragmento LITERAL, palabra por palabra, copiado directamente de la descripción de ESE concepto -- nunca de la ganancia, nunca parafraseado, nunca inventado; si no puedes citar un fragmento literal real que sustente la afirmación, esa afirmación NO tiene soporte).

PASO 3 -- Cualquier afirmación material que ningún concepto citado sustente, listala en "unsupportedMaterialClaims".

"supportValid" debe ser true SOLO si unsupportedMaterialClaims está vacío Y cada afirmación material tiene al menos una entrada de soporte genuina en supportEvidence. Si tienes cualquier duda razonable, o si el soporte es solo una coincidencia temática superficial (mismo tema general, distinto criterio/ejemplo/momento), marca supportValid:false.

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor.`;
}

/**
 * CHALLENGE_CROSS_TURN_GAIN_SUPPORT -- see module docstring. Fails closed
 * (supportValid:false, empty claim/evidence arrays) on any transport/parse
 * issue -- PROVIDER FAILURE != SEMANTIC VERDICT, this NEVER downgrades a
 * transport failure into a semantic OFF_TOPIC_SUPPORT-shaped verdict, it
 * simply yields no corroboration, which the caller then treats exactly like
 * any other failed corroboration (falls through to the existing correction
 * path) -- no unbounded retry lives here.
 */
async function desafiarSoporteCrossTurnoGanancia({
  llmService, gananciaTexto, candidatosSoporte = [], turnoId = null,
}) {
  const failClosed = (codigoRazon) => ({
    supportValid: false, materialGainClaims: [], supportEvidence: [], unsupportedMaterialClaims: [], reason: null,
    challengeId: CHALLENGE_ID, challengeVersion: CHALLENGE_VERSION, codigoRazon,
  });
  if (typeof gananciaTexto !== 'string' || !gananciaTexto.trim()) return failClosed('GANANCIA_AUSENTE');
  if (!Array.isArray(candidatosSoporte) || candidatosSoporte.length === 0) return failClosed('SOPORTE_AUSENTE');

  const idsPermitidos = candidatosSoporte.map(c => c.id).filter(Boolean);
  const system = buildSystemPromptDesafioSoporteCrossTurno({ gananciaTexto, candidatosSoporte });
  let r;
  try {
    r = await llmService.call({
      system, userMsg: '', label: CHALLENGE_ID,
      callProfile: 'VEREDICTO_ESTRUCTURADO', responseMimeType: 'application/json',
      responseSchema: buildChallengeSchema(idsPermitidos), turnoId,
    });
  } catch (e) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  const parsed = r && r.parsed;
  if (!parsed || typeof parsed !== 'object'
    || typeof parsed.supportValid !== 'boolean'
    || !Array.isArray(parsed.materialGainClaims)
    || !Array.isArray(parsed.supportEvidence)
    || !Array.isArray(parsed.unsupportedMaterialClaims)) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  // DEFENSIVE_RE-CHECK -- the schema already enum-constrains supportConceptId;
  // never trust a malformed/tampered response past that boundary.
  const idsPermitidosSet = new Set(idsPermitidos);
  const supportEvidence = parsed.supportEvidence.filter(e => e && idsPermitidosSet.has(e.supportConceptId)
    && typeof e.gainClaim === 'string' && typeof e.evidenceSpan === 'string');
  return {
    supportValid: parsed.supportValid === true,
    materialGainClaims: parsed.materialGainClaims.filter(c => typeof c === 'string'),
    supportEvidence,
    unsupportedMaterialClaims: parsed.unsupportedMaterialClaims.filter(c => typeof c === 'string'),
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : null,
    challengeId: CHALLENGE_ID, challengeVersion: CHALLENGE_VERSION, codigoRazon: null,
  };
}

/**
 * DETERMINISTIC, non-LLM grounding check -- the exact mechanism that would
 * have caught turn 3's real hallucination ("the support mentions visual
 * detection and material accumulation" when it does not). For every
 * supportEvidence entry, evidenceSpan MUST be an EXACT (case/whitespace-
 * normalized) substring of the descripcion of the concept it cites --
 * looked up by id in candidatosSoporte, never trusted from the challenge's
 * own echo. Any entry that fails this fails the WHOLE corroboration closed
 * (a single fabricated span invalidates the response -- it is never
 * partially trusted). An exact span is evidence FOR the judgment; it does
 * NOT require the gain itself to use identical wording -- semantic
 * equivalence in gainClaim vs. the gain text remains the LLM's own call.
 * Also enforces MATERIAL_CLAIM_COVERAGE: unsupportedMaterialClaims must be
 * empty AND every materialGainClaim must have at least one grounded
 * (span-verified) supportEvidence entry -- partial support never
 * authorizes the whole gain.
 */
function spansEvidenciaFundamentadosYCoberturaCompleta(desafio, candidatosSoporte) {
  if (!desafio || desafio.supportValid !== true) return false;
  if (!Array.isArray(desafio.unsupportedMaterialClaims) || desafio.unsupportedMaterialClaims.length > 0) return false;
  if (!Array.isArray(desafio.materialGainClaims) || desafio.materialGainClaims.length === 0) return false;
  if (!Array.isArray(desafio.supportEvidence) || desafio.supportEvidence.length === 0) return false;

  const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const descripcionPorId = new Map((candidatosSoporte || []).map(c => [c.id, normalizar(c.descripcion)]));

  const claimsFundamentados = new Set();
  for (const entrada of desafio.supportEvidence) {
    const descripcionNormalizada = descripcionPorId.get(entrada.supportConceptId);
    if (descripcionNormalizada === undefined) return false; // cites a concept never offered — fail closed
    const spanNormalizado = normalizar(entrada.evidenceSpan);
    if (!spanNormalizado || !descripcionNormalizada.includes(spanNormalizado)) return false; // fabricated span
    claimsFundamentados.add(entrada.gainClaim);
  }
  return desafio.materialGainClaims.every(claim => claimsFundamentados.has(claim));
}

module.exports = {
  VALIDADOR_ID, VALIDADOR_VERSION, SELECTOR_ID, SELECTOR_VERSION, VEREDICTOS_SOPORTE_VALIDOS,
  buildSystemPromptSoporteSemantico, validarSoporteSemanticoGanancia,
  buildSelectorSchema, buildSystemPromptSeleccionSoporte, seleccionarSoporteSemanticoCorregido,
  CHALLENGE_ID, CHALLENGE_VERSION,
  esSoporteCrossTurnoDeAltoRiesgo, buildChallengeSchema, buildSystemPromptDesafioSoporteCrossTurno,
  desafiarSoporteCrossTurnoGanancia, spansEvidenciaFundamentadosYCoberturaCompleta,
};
