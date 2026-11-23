'use strict';

/**
 * REQUIRED_MISSION_FALLBACK_TARGET_BINDING (C007, Daniel-adjudicated, real
 * evidence: logistica_c1 turn 9). prepararOportunidadTipadaDesdeDireccion
 * (ObjetivoConversacionalPolicy.js) fires when a REQUIRED mission dimension
 * is still pending and the ordinary Producer proposed nothing usable this
 * turn -- it is legitimate common-core mechanics that a required obligation
 * exists independent of the Producer's own (possibly mistaken) judgment.
 * What it must NOT do is decide, by itself, WHICH of several eligible
 * governed concepts this turn's intervention is concretely about:
 * EXECUTABLE_WHAT REQUIRES_MINIMUM_SUFFICIENT_TARGET_IDENTITY. Real evidence:
 * with 13 eligible anchors and no target-selection step, the frozen contract
 * carried only a generic role ("EXPERTO") and static grammar guidance text
 * ("comprender cómo ocurre la acción autorizada") as its entire target
 * identity -- Realizer and (correctly-bound, post-7d381f2) Fidelity each
 * reacted reasonably to that ambiguity and still produced 4/4 genuine
 * disagreements, because neither was ever given one concrete thing to agree
 * ABOUT.
 *
 * This module is the ONE additional step: given a required mission need
 * (mission/dimension/operation already decided upstream -- this module never
 * decides those, and CANNOT cancel the need: BINDER_CAN_CANCEL_REQUIRED_NEED
 * is structurally NO, since this function has no "no target"/"no need"
 * output at all) and a FINITE set of already-admissible candidate concepts
 * (already filtered by anclajesElegiblesParaOperacion -- this module never
 * judges eligibility, only picks among what's already eligible), select
 * exactly ONE of them as the concrete target.
 *
 * Same deliberate pattern as ValidadorSoporteSemanticoGanancia.js's
 * seleccionarSoporteSemanticoCorregido: an enum-constrained native schema
 * that can never mint an id nobody offered it and can never select more than
 * one. The caller (InteraccionCognitivaWriter.js) is the only place that
 * decides target CARDINALITY (0/1/>1) and therefore the only place that
 * decides whether this function is even invoked -- it is never called with
 * zero or exactly one candidate.
 */

const TARGET_BINDER_ID = 'vinculacion_objetivo_necesidad_requerida';
const TARGET_BINDER_VERSION = '1';
const TARGET_BINDER_MAX_INTENTOS = 2;

// TARGET_BINDER_USES_VALID_PROVIDER_INPUT_AND_PRESERVES_FAILURE_CLASS (C007,
// LOGISTICA_C1_T37). The binder's whole semantic contract lives in its system
// prompt; the provider only needs a NON-EMPTY user turn (Gemini rejects an
// empty `contents` text with HTTP 400 "Request has empty input." -- 8/8
// executed binder calls failed that way). This message is deliberately
// neutral and subordinate: it names no candidate, mission, dimension or
// operation, and adds no instruction the system prompt does not already carry.
const TARGET_BINDER_USER_MESSAGE = 'Ejecuta la selección solicitada según las instrucciones del sistema.';

// PROVIDER_FAILURE != SEMANTIC_NO_SELECTION. A provider failure (HTTP 400/429/
// 5xx, timeout, transport, aborted preflight) says nothing about the
// candidates; a semantic failure is a response that WAS returned and did not
// select a legal candidate. Provider categories come from LLMErrorTaxonomy
// (STRUCTURED_RESPONSE_INVALID is the only one that describes a returned
// response, so it stays on the semantic/schema side).
const CLASE_FALLO_PROVEEDOR = 'PROVIDER_FAILURE';
const CLASE_FALLO_SEMANTICO = 'SEMANTIC_NO_SELECTION';
const CODIGO_FALLO_DE_PROVEEDOR = 'FALLO_DE_PROVEEDOR';

function buildTargetBinderSchema(idsPermitidos) {
  return Object.freeze({
    type: 'OBJECT',
    properties: {
      targetConceptId: { type: 'STRING', enum: [...idsPermitidos] },
    },
    required: ['targetConceptId'],
  });
}

function buildSystemPromptVinculacionObjetivo({ mission, dimension, operation, necesidadTexto, candidatos }) {
  const lista = (candidatos || [])
    .map((c, i) => `  ${i + 1}. [${c.id}] "${c.descripcion}"`).join('\n');
  return `Eres Círculo. VINCULACION_OBJETIVO_NECESIDAD_REQUERIDA. Una necesidad cognitiva de misión YA FUE DECIDIDA como requerida -- nunca decides si existe, nunca la cancelas, nunca propones una alternativa a ella. Tu ÚNICA tarea: de la lista de conceptos YA GOBERNADOS y ya elegibles de abajo, elegir CUÁL de ellos es el objeto concreto sobre el que recae esta necesidad -- nunca inventar un id nuevo, nunca crear un concepto, nunca elegir más de uno.

MISIÓN: ${mission}
DIMENSIÓN REQUERIDA: ${dimension}
OPERACIÓN: ${operation}
NECESIDAD (guía general de la gramática, no un objetivo concreto por sí sola): "${necesidadTexto || ''}"

CONCEPTOS YA GOBERNADOS Y ELEGIBLES (única lista permitida; selecciona por id exacto EL MÁS APROPIADO como objeto concreto de esta necesidad):
${lista || '  (ninguno)'}

Elige el concepto que mejor representa la cosa concreta (la acción, práctica o criterio ya autorizado) sobre la que esta necesidad debe indagar -- no el más reciente, no el primero de la lista, no por similitud léxica superficial: el que semánticamente es EL OBJETO de "${dimension}" dentro de "${mission}".

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor.`;
}

/**
 * TARGET_BINDER_PROPOSES -> DECISION_AUTHORIZES -> CONTRACT_FREEZES ->
 * DOWNSTREAM_TRANSPORTS. This function only ever proposes; the caller treats
 * its output as untrusted until the defensive re-check below passes (the
 * enum-constrained schema already prevents an out-of-set id from a
 * compliant provider, but a malformed/tampered response is never trusted
 * past this boundary either way). Bounded same-call retry (never escalates
 * to a different mechanism, never falls back to "all candidates") mirrors
 * the existing seleccionarSoporteSemanticoCorregido/validador-fidelidad
 * conventions. Fails closed -- {valido:false, targetConceptId:null} -- on
 * any transport/parse/out-of-set failure; the caller (never this function)
 * decides what "no valid binding" means for the turn (REQUIRED_MISSION_
 * FALLBACK_TARGET_BINDING: it means no executable opportunity materializes
 * this turn, same as the pre-existing zero-candidate case -- never a
 * broad/unbound opportunity reaching execution).
 */
async function vincularObjetivoConcretoNecesidadRequerida({
  llmService, mission, dimension, operation, necesidadTexto = null, candidatos = [], turnoId = null,
}) {
  const failClosed = (codigoRazon, { claseFallo = null, errorCategory = null } = {}) => ({
    targetConceptId: null, valido: false,
    binderId: TARGET_BINDER_ID, binderVersion: TARGET_BINDER_VERSION, codigoRazon,
    claseFallo, errorCategory,
  });
  const falloDeProveedor = (errorCategory) => failClosed(CODIGO_FALLO_DE_PROVEEDOR, {
    claseFallo: CLASE_FALLO_PROVEEDOR, errorCategory: errorCategory || 'PROVIDER_TRANSPORT_ERROR',
  });
  if (!Array.isArray(candidatos) || candidatos.length === 0) return failClosed('SIN_CANDIDATOS');
  const idsPermitidos = candidatos.map(c => c && c.id).filter(Boolean);
  const idsPermitidosSet = new Set(idsPermitidos);
  if (idsPermitidosSet.size === 0) return failClosed('SIN_CANDIDATOS');

  const system = buildSystemPromptVinculacionObjetivo({ mission, dimension, operation, necesidadTexto, candidatos });
  let ultimoCodigoRazon = 'RESPUESTA_INVALIDA_O_NO_PARSEABLE';
  for (let intento = 0; intento < TARGET_BINDER_MAX_INTENTOS; intento += 1) {
    let r = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await llmService.call({
        system, userMsg: TARGET_BINDER_USER_MESSAGE, label: TARGET_BINDER_ID,
        callProfile: 'VEREDICTO_ESTRUCTURADO', responseMimeType: 'application/json',
        responseSchema: buildTargetBinderSchema(idsPermitidos), turnoId,
      });
    } catch (e) {
      // A thrown call never returned a response: transport/provider side.
      return falloDeProveedor((e && e.errorCategory) || null);
    }
    const parsed = r && r.parsed;
    if (parsed && typeof parsed.targetConceptId === 'string' && idsPermitidosSet.has(parsed.targetConceptId)) {
      return {
        targetConceptId: parsed.targetConceptId, valido: true,
        binderId: TARGET_BINDER_ID, binderVersion: TARGET_BINDER_VERSION, codigoRazon: null,
        claseFallo: null, errorCategory: null,
      };
    }
    if (!parsed) {
      // No parsed response. LLMService has ALREADY applied the project's
      // retry / model policy for this call; repeating it here would only
      // multiply provider load. Provider category => provider failure (stop);
      // STRUCTURED_RESPONSE_INVALID (a response arrived but was not JSON) or
      // no category at all => the existing semantic/schema outcome.
      const categoria = r && r.errorCategory ? r.errorCategory : null;
      if ((r && r.aborted) || (categoria && categoria !== 'STRUCTURED_RESPONSE_INVALID')) {
        return falloDeProveedor(categoria);
      }
      ultimoCodigoRazon = 'RESPUESTA_INVALIDA_O_NO_PARSEABLE';
      continue;
    }
    ultimoCodigoRazon = 'RESPUESTA_FUERA_DE_CANDIDATOS';
  }
  return failClosed(ultimoCodigoRazon, { claseFallo: CLASE_FALLO_SEMANTICO });
}

/**
 * MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET (C007,
 * LOGISTICA_C1_T19_ASK_VALUE_OF_KNOWN_REALIZATION_FIDELITY, VKN-C). The SAME
 * binder, applied to a Producer-proposed value act: which governed entity is
 * the required facet {mission, dimension} ABOUT?
 *
 * Authority chain: required mission need -> admissible governed target set ->
 * concrete semantic target binding -> Decision. This function owns only the
 * CARDINALITY RULE of the last step (the same TARGET_CARDINALITY_RULE the
 * fallback applies in ObjetivoConversacionalPolicy):
 *   - one admissible target  -> UNIQUELY_AUTHORIZED, no model call;
 *   - several                -> bounded SEMANTIC_BINDING (the enum-constrained
 *                               binder above, which can neither mint an id nor
 *                               cancel the need);
 *   - none / binder failure  -> fail closed ({valido:false}).
 * Never the first anchor, the latest concept, slot order or lexical
 * similarity: FIRST_ANCHOR != TARGET_AUTHORITY, MISSION_NEED_AUTHORITY !=
 * TARGET_SELECTION_AUTHORITY.
 */
async function resolverVinculacionObjetivoDeActoDeValor({
  llmService, mission, dimension, operation, necesidadTexto = null, candidatos = [], turnoId = null,
}) {
  const unicos = [];
  const vistos = new Set();
  (Array.isArray(candidatos) ? candidatos : []).forEach((c) => {
    if (c && typeof c.id === 'string' && c.id && !vistos.has(c.id)) { vistos.add(c.id); unicos.push(c); }
  });
  const base = { mission, dimension, binderId: TARGET_BINDER_ID, binderVersion: TARGET_BINDER_VERSION };
  if (unicos.length === 0) {
    return { ...base, valido: false, source: null, targetConceptId: null, codigoRazon: 'SIN_CANDIDATOS', claseFallo: CLASE_FALLO_SEMANTICO, errorCategory: null };
  }
  if (unicos.length === 1) {
    return { ...base, valido: true, source: 'UNIQUELY_AUTHORIZED', targetConceptId: unicos[0].id, codigoRazon: null };
  }
  const vinculacion = await vincularObjetivoConcretoNecesidadRequerida({
    llmService, mission, dimension, operation, necesidadTexto, candidatos: unicos, turnoId,
  });
  return vinculacion.valido
    ? { ...base, valido: true, source: 'SEMANTIC_BINDING', targetConceptId: vinculacion.targetConceptId, codigoRazon: null, claseFallo: null, errorCategory: null }
    : {
        ...base, valido: false, source: null, targetConceptId: null, codigoRazon: vinculacion.codigoRazon,
        claseFallo: vinculacion.claseFallo || null, errorCategory: vinculacion.errorCategory || null,
      };
}

module.exports = {
  resolverVinculacionObjetivoDeActoDeValor,
  TARGET_BINDER_ID, TARGET_BINDER_VERSION, TARGET_BINDER_MAX_INTENTOS, TARGET_BINDER_USER_MESSAGE,
  CLASE_FALLO_PROVEEDOR, CLASE_FALLO_SEMANTICO, CODIGO_FALLO_DE_PROVEEDOR,
  buildTargetBinderSchema, buildSystemPromptVinculacionObjetivo,
  vincularObjetivoConcretoNecesidadRequerida,
};
