'use strict';

/**
 * VALIDADOR SEMÁNTICO DE NOVEDAD COGNITIVA DE UN RESIDUO.
 *
 * C007 — human canary v5, defecto SAME_TURN_SATISFACTION_MASKED_BY_NEW_
 * TYPED_RESIDUE.
 *
 * Un turno puede, a la vez: (a) satisfacer el unknown que motivó la
 * pregunta anterior (relacionRespuestaDirigida=ATIENDE_OBJETIVO, unknown
 * cerrado con evidencia), y (b) proponer una oportunidad/residuo nueva con
 * identidad tipada perfectamente válida (gain.residuoSemantico.oportunidadRef
 * === oportunidad.idTemporal). Esa identidad nueva demuestra que el vínculo
 * es válido — nunca que la dirección cognitiva que representa sea
 * realmente nueva. Sin este puerto, un candidato que en sustancia repite lo
 * que la propia respuesta acaba de satisfacer podía materializar un
 * SemanticUnknown nuevo y volver a cobrar exactamente lo mismo con otro
 * disfraz léxico.
 *
 * Puerto estrecho, mismo patrón deliberado que ValidadorSemanticoDeltaConceptos.js
 * y ValidadorSemanticoMutacionConcepto.js: no produce candidatos, no
 * propone otro WHAT, no decide movimiento ni redacta nada — adjudica
 * ÚNICAMENTE si el residuo candidato representa una faceta cognitiva
 * genuinamente distinta de la necesidad recién satisfecha en este mismo
 * turno, o si en sustancia es esa misma necesidad reformulada. Invocación
 * SEPARADA del productor que propuso el candidato — nunca el mismo acto.
 *
 * Prohibido explícitamente (ver tarea): comparación de texto/keywords,
 * similitud léxica, embeddings, distancia de edición, o tratar una
 * dimensión/anchor/identidad distinta como prueba de novedad por sí sola.
 * Esas señales nunca llegan a este prompt como criterio — el juicio es
 * puramente sobre si la evidencia ya dada deja o no una pregunta legítima
 * sin responder.
 */

const VALIDADOR_ID = 'validador_novedad_cognitiva_residuo';
const VALIDADOR_VERSION = '1';

const VEREDICTOS_VALIDOS = Object.freeze([
  'DISTINCT_COGNITIVE_RESIDUE',
  'REPHRASED_SATISFIED_NEED',
  'INSUFFICIENT_NOVELTY_BASIS',
]);

function buildSystemPromptNovedadResiduo({ satisfiedNeed, userEvidence, candidateResidue }) {
  return `Eres un ADJUDICADOR. No propones preguntas, no produces un WHAT nuevo, no decides movimiento ni redactas nada visible. Tu ÚNICA tarea: decidir si el residuo candidato de abajo representa una pregunta cognitiva genuinamente distinta de la necesidad que la propia respuesta del experto acaba de satisfacer este mismo turno, o si en sustancia es esa misma necesidad pedida de nuevo con otras palabras.

NECESIDAD YA SATISFECHA ESTE TURNO:
- objetivo: "${(satisfiedNeed && satisfiedNeed.semanticTarget) || '(no declarado)'}"
- evidencia que se pedía: "${(satisfiedNeed && satisfiedNeed.expectedEvidence) || '(no declarado)'}"

EVIDENCIA LITERAL QUE EL EXPERTO ACABA DE DAR ESTE TURNO (única fuente de verdad sobre lo que realmente dijo):
"${userEvidence || ''}"

RESIDUO CANDIDATO PROPUESTO EN EL MISMO TURNO:
- qué pide: "${(candidateResidue && candidateResidue.semanticTarget) || '(no declarado)'}"
- referente: "${(candidateResidue && candidateResidue.referenteSemantico) || '(no declarado)'}"
- evidencia que busca: "${(candidateResidue && candidateResidue.evidenciaBuscada) || '(no declarado)'}"

Decide comparando exclusivamente SIGNIFICADO, nunca palabras: ¿la evidencia que el experto ya dio deja sin responder lo que el residuo candidato pide, o ya lo contiene en sustancia (aunque use otras palabras)? Una identidad nueva, una dimensión distinta, un anclaje distinto o un wording distinto NUNCA son por sí solos prueba de novedad — ignóralos como criterio; solo el contenido cognitivo importa. Si la evidencia ya dada responde plenamente lo que el candidato pide (aunque con otro vocabulario), es una reformulación. Si el candidato pide genuinamente algo que la evidencia dada no cubre — otra condición, otro paso, otro caso, otra faceta real — es distinto. Si no tienes base suficiente para decidir con confianza razonable, no asumas novedad.

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor:
{ "veredicto": "DISTINCT_COGNITIVE_RESIDUE" | "REPHRASED_SATISFIED_NEED" | "INSUFFICIENT_NOVELTY_BASIS", "razon": "<una frase breve>" }`;
}

/**
 * Única llamada real al LLM de este módulo — de solo lectura, sin capacidad
 * de producir nada. Falla cerrado hacia INSUFFICIENT_NOVELTY_BASIS ante
 * cualquier error de transporte, parseo, o forma de respuesta inesperada —
 * el candidato nunca obtiene el beneficio de la duda por un fallo del
 * verificador.
 */
async function validarNovedadCognitivaResiduo({
  llmService, satisfiedNeed = null, userEvidence = null, candidateResidue = null,
  turnoOrigenId = null, turnoId = null,
}) {
  const failClosed = (codigoRazon) => ({
    veredicto: 'INSUFFICIENT_NOVELTY_BASIS', razon: null,
    validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, turnoOrigenId, codigoRazon,
  });
  if (!satisfiedNeed || !candidateResidue) return failClosed('ENTRADA_INCOMPLETA');

  const system = buildSystemPromptNovedadResiduo({ satisfiedNeed, userEvidence, candidateResidue });
  let r;
  try {
    r = await llmService.call({
      system, userMsg: userEvidence || '', label: 'validador_novedad_cognitiva_residuo',
      callProfile: 'VEREDICTO_ESTRUCTURADO', turnoId,
    });
  } catch (e) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  const parsed = r && r.parsed;
  if (!parsed || typeof parsed !== 'object' || !VEREDICTOS_VALIDOS.includes(parsed.veredicto)) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  return {
    veredicto: parsed.veredicto,
    razon: typeof parsed.razon === 'string' ? parsed.razon.trim() : null,
    validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, turnoOrigenId, codigoRazon: null,
  };
}

module.exports = {
  VALIDADOR_ID, VALIDADOR_VERSION, VEREDICTOS_VALIDOS,
  buildSystemPromptNovedadResiduo, validarNovedadCognitivaResiduo,
};
