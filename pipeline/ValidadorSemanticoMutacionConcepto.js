'use strict';

/**
 * VALIDADOR SEMÁNTICO DE MUTACIÓN DE CONCEPTO.
 *
 * DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final —
 * CITA_LITERAL_ESPECIFICA_NO_EQUIVALE_A_CORRECCION_DEL_CONCEPTO).
 *
 * La ronda anterior demostró que "porQue" es un fragmento literal del
 * mensaje, y que ese fragmento no es el mensaje completo, NO demuestra que
 * el fragmento diga algo sobre el concepto que pretende invalidar — una
 * cita corta, literal y totalmente ajena al concepto todavía aprobaba la
 * mutación. La autoridad de admisión de una mutación destructiva no puede
 * ser la propia declaración del productor que la propone.
 *
 * Este archivo es un PUERTO ESTRECHO, no un segundo sistema paralelo: no
 * produce conceptos, no propone mutaciones, no completa conocimiento, no
 * reescribe la interpretación, no elige Movimiento, no formula preguntas,
 * no modifica ningún delta. Solo adjudica — dado un concepto existente y un
 * fragmento literal ya verificado como presente en el mensaje — si ese
 * fragmento modifica semánticamente ESE concepto, y de qué forma.
 *
 * Investigación previa a este archivo (ver auditoría del incremento)
 * confirmó que NINGÚN mecanismo existente en el repo hace esto a nivel de
 * concepto específico — el más cercano, ContratoRespuestaDirigidaPolicy
 * (T-DIM2), valida a nivel de DIMENSIÓN (¿algún concepto nuevo cae en la
 * dimensión objetivo?), nunca a nivel de "¿este fragmento corrige a ESTE
 * concreto concepto?". Por eso este puerto es nuevo — pero deliberadamente
 * angosto: una sola responsabilidad, una sola llamada, sin autoridad de
 * producción.
 *
 * Independencia requerida: de AUTORIDAD y CONTROL DE FLUJO, no
 * necesariamente de proveedor/modelo subyacente — es una invocación
 * SEPARADA, con su propio prompt, su propio contrato y su propio
 * resultado, que nunca puede ser el mismo acto que propuso la mutación.
 *
 * Prefiltro estructural (determinista, NUNCA invoca el LLM si falla) primero
 * — el LLM solo se llama para el residuo genuinamente ambiguo, exactamente
 * como pide la autoridad: "no llames al LLM; rechaza la parte destructiva".
 */

const crypto = require('crypto');
const { contenidoEsExtractivo } = require('../state/GrafoConocimientoPolicy');

const TIPOS_IMPACTO = Object.freeze(['CORRIGE', 'RECHAZA', 'REEMPLAZA', 'DECLARA_NO_VIGENTE', 'NINGUNO']);
const RESULTADOS = Object.freeze(['VALIDADA', 'NO_VALIDADA', 'INCONCLUSA']);

const VALIDADOR_ID = 'validador_semantico_mutacion_concepto';
const VALIDADOR_VERSION = '1';

function normalizarParaHash(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Identidad estable de UNA validación — sesión + turno de origen + concepto
 * afectado + impacto propuesto + hash de la evidencia citada. Misma
 * identidad ⇒ mismo veredicto reutilizado, nunca una segunda llamada (ver
 * "Durabilidad e idempotencia" de la autoridad).
 */
function identidadValidacionMutacion({ sesionId, turnoOrigenId, conceptoAfectadoId, tipoImpactoPropuesto, evidenciaTextual }) {
  const hash = crypto.createHash('sha256')
    .update(normalizarParaHash(evidenciaTextual))
    .digest('hex').slice(0, 16);
  return `${sesionId}:${turnoOrigenId}:${conceptoAfectadoId}:${tipoImpactoPropuesto}:${hash}`;
}

/**
 * Prefiltro estructural determinista — nunca semántico, nunca léxico sobre
 * el CONTENIDO del fragmento (no juzga relevancia: eso es trabajo exclusivo
 * del adjudicador). Solo verifica precondiciones mecánicas. Si cualquiera
 * falla, la operación destructiva se rechaza sin gastar una llamada al LLM.
 */
function prefiltroEstructuralMutacion({
  concepto, dimensionAfectada, tipoImpactoPropuesto, evidenciaTextual, mensajeUsuario,
  origenProductor, turnoOrigenId, esDestructiva,
}) {
  if (!concepto || typeof concepto.id !== 'string') return { pasa: false, razon: 'CONCEPTO_INEXISTENTE' };
  if (!dimensionAfectada) return { pasa: false, razon: 'DIMENSION_NO_RESUELTA' };
  if (!TIPOS_IMPACTO.includes(tipoImpactoPropuesto)) return { pasa: false, razon: 'TIPO_IMPACTO_FUERA_DE_CATALOGO' };
  if (!contenidoEsExtractivo(evidenciaTextual, mensajeUsuario)) return { pasa: false, razon: 'EVIDENCIA_NO_LITERAL' };
  if (normalizarParaHash(evidenciaTextual) === normalizarParaHash(mensajeUsuario)) return { pasa: false, razon: 'EVIDENCIA_ES_MENSAJE_COMPLETO' };
  if (!origenProductor) return { pasa: false, razon: 'PRODUCTOR_NO_IDENTIFICADO' };
  if (!turnoOrigenId) return { pasa: false, razon: 'TURNO_ORIGEN_AUSENTE' };
  if (!esDestructiva) return { pasa: false, razon: 'OPERACION_NO_DESTRUCTIVA' };
  return { pasa: true, razon: null };
}

function buildSystemPromptValidadorSemantico({ concepto, dimensionAfectada, tipoImpactoPropuesto, evidenciaTextual, mensajeUsuario }) {
  return `Eres un ADJUDICADOR. No produces conocimiento, no propones mutaciones, no formulas preguntas, no completas información, no reescribes nada, no eliges movimiento conversacional, no modificas ningún delta. Tu ÚNICA tarea: determinar si el FRAGMENTO LITERAL citado del usuario, tal como aparece, modifica semánticamente el CONCEPTO EXISTENTE indicado, y de qué forma.

CONCEPTO EXISTENTE (representación durable actual — nunca la reinterpretes ni la completes):
- id: ${concepto.id}
- dimensión: ${dimensionAfectada}
- descripción vigente: "${concepto.descripcion}"

IMPACTO PROPUESTO POR EL PRODUCTOR (a verificar, nunca a asumir como cierto): ${tipoImpactoPropuesto}

FRAGMENTO LITERAL CITADO (ya verificado como presente en el mensaje — tu trabajo es juzgar su RELEVANCIA semántica sobre el concepto indicado, nunca su literalidad, que ya está confirmada):
"${evidenciaTextual}"

MENSAJE COMPLETO DEL USUARIO (contexto único, nunca autoridad por sí solo):
"${mensajeUsuario}"

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor ni explicación adicional:
{
  "resultado": "VALIDADA" | "NO_VALIDADA" | "INCONCLUSA",
  "conceptoAfectadoId": "${concepto.id}",
  "tipoImpactoConfirmado": "CORRIGE" | "RECHAZA" | "REEMPLAZA" | "DECLARA_NO_VIGENTE" | "NINGUNO",
  "evidenciaTextualValidada": "<el mismo fragmento, o el subfragmento exacto dentro de él que realmente sustenta tu juicio>",
  "codigoRazon": "<código breve en mayúsculas, ej. FRAGMENTO_ES_SOBRE_OTRO_TEMA, FRAGMENTO_CONTRADICE_DESCRIPCION_VIGENTE, FRAGMENTO_NO_MENCIONA_EL_CONCEPTO, FRAGMENTO_CONFIRMA_CORRECCION_EXPLICITA>"
}

Marca VALIDADA solo si el fragmento, leído en su propio contexto, habla GENUINAMENTE del concepto indicado (nunca de otro tema, aunque comparta palabras) y su contenido es incompatible con la descripción vigente de forma consistente con el impacto propuesto. Si el fragmento es literal pero trata de un tema distinto, responde NO_VALIDADA con tipoImpactoConfirmado="NINGUNO". Si no puedes determinarlo con confianza razonable, responde INCONCLUSA — nunca adivines a favor de la mutación.

ADVERTENCIA CRÍTICA — un CAMBIO A TRAVÉS DEL TIEMPO nunca es una CONTRADICCIÓN: si el concepto pertenece a la dimensión "antes" (una situación que existía ANTES de la experiencia que el usuario está describiendo) y el fragmento citado describe lo que el usuario siente, hace o logra AHORA/DESPUÉS/CON EL TIEMPO (p.ej. "ahora coso con confianza", "ya no me pasa eso", "con el tiempo aprendí"), eso es la narrativa esperada de UN CAMBIO — el hecho "antes" sigue siendo históricamente cierto y NUNCA queda contradicho por describir el estado POSTERIOR. Esto NO es VALIDADA — es NO_VALIDADA, codigoRazon="FRAGMENTO_DESCRIBE_CAMBIO_POSTERIOR_NO_CORRIGE_EL_HECHO_ANTES". Una corrección GENUINA de "antes" requiere que el usuario diga algo sobre CÓMO ERA la situación EN SÍ (p.ej. "en realidad sí confiaba", "no fue exactamente así como lo viví antes", "me equivoqué al describir cómo era antes") — nunca una descripción de cómo está ahora. La misma lógica aplica, simétricamente, a cualquier otra dimensión con una narrativa temporal propia: el contenido de una etapa POSTERIOR nunca invalida, por sí solo, el hecho de una etapa ANTERIOR.`;
}

/**
 * Única llamada real al LLM de este módulo — de solo lectura, sin
 * capacidad de producir nada. Falla cerrado (INCONCLUSA) ante cualquier
 * error de transporte, parseo, o forma de respuesta inesperada — nunca
 * asume autorización por defecto.
 */
async function validarSemanticamenteMutacion({
  llmService, concepto, dimensionAfectada, tipoImpactoPropuesto, evidenciaTextual, mensajeUsuario, turnoOrigenId, origenProductor,
  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 3) — identidad interna
  // reservada en admisión, exclusivamente para correlacionar los eventos
  // llm.* de esta llamada. turnoOrigenId (identidad de dominio, basada en
  // turnoClienteId) no cambia de significado.
  turnoId = null,
}) {
  const system = buildSystemPromptValidadorSemantico({ concepto, dimensionAfectada, tipoImpactoPropuesto, evidenciaTextual, mensajeUsuario });
  const base = {
    conceptoAfectadoId: concepto.id,
    validadorId: VALIDADOR_ID,
    validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true,
    turnoOrigenId, origenProductor, dimensionAfectada,
  };
  let r;
  try {
    r = await llmService.call({ system, userMsg: mensajeUsuario, label: 'validador_semantico_mutacion', callProfile: 'VEREDICTO_ESTRUCTURADO', turnoId });
  } catch (e) {
    r = null;
  }
  const parsed = r && r.parsed;
  if (!parsed || !RESULTADOS.includes(parsed.resultado)) {
    return { ...base, resultado: 'INCONCLUSA', tipoImpactoConfirmado: 'NINGUNO', codigoRazon: 'RESPUESTA_INVALIDA_O_NO_PARSEABLE', evidenciaTextualValidada: null };
  }
  if (typeof parsed.conceptoAfectadoId !== 'string' || parsed.conceptoAfectadoId !== concepto.id) {
    return { ...base, resultado: 'INCONCLUSA', tipoImpactoConfirmado: 'NINGUNO', codigoRazon: 'CONCEPTO_DECLARADO_NO_COINCIDE', evidenciaTextualValidada: null };
  }
  if (!TIPOS_IMPACTO.includes(parsed.tipoImpactoConfirmado)) {
    return { ...base, resultado: 'INCONCLUSA', tipoImpactoConfirmado: 'NINGUNO', codigoRazon: 'TIPO_IMPACTO_CONFIRMADO_FUERA_DE_CATALOGO', evidenciaTextualValidada: null };
  }
  return {
    ...base,
    resultado: parsed.resultado,
    tipoImpactoConfirmado: parsed.tipoImpactoConfirmado,
    evidenciaTextualValidada: typeof parsed.evidenciaTextualValidada === 'string' ? parsed.evidenciaTextualValidada : null,
    codigoRazon: typeof parsed.codigoRazon === 'string' ? parsed.codigoRazon : null,
  };
}

/**
 * Único punto que decide si un veredicto ya obtenido (nuevo o reutilizado
 * de la autoridad durable) autoriza aplicar la mutación propuesta. Extraído
 * como función nombrada y exportada -- nunca duplicada inline en el
 * llamador -- para que la condición sea unívocamente verificable: VALIDADA,
 * sobre el MISMO concepto, con el MISMO impacto propuesto, y
 * validadorDistintoDelProductor===true. Cualquier discordancia, en
 * cualquiera de los cuatro campos, rechaza -- nunca autoriza por defecto.
 */
function decidirAceptacionMutacion(veredicto, conceptoAfectadoId, tipoImpactoPropuesto) {
  return !!veredicto
    && veredicto.resultado === 'VALIDADA'
    && veredicto.conceptoAfectadoId === conceptoAfectadoId
    && veredicto.tipoImpactoConfirmado === tipoImpactoPropuesto
    && veredicto.validadorDistintoDelProductor === true;
}

module.exports = {
  TIPOS_IMPACTO, RESULTADOS, VALIDADOR_ID, VALIDADOR_VERSION,
  identidadValidacionMutacion, prefiltroEstructuralMutacion, validarSemanticamenteMutacion,
  buildSystemPromptValidadorSemantico, normalizarParaHash, decidirAceptacionMutacion,
};
