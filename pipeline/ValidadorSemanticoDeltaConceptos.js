'use strict';

/**
 * VALIDADOR SEMÁNTICO DE DELTA DE CONCEPTOS.
 *
 * DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1.
 *
 * FASE_46 (auditoría de producto real) encontró un turno donde el generador
 * declaró `procedencia: "slot:antes"` para evidencia que, leída en su propio
 * contexto, pertenecía semánticamente a "después" — y aplicarDelta, que
 * transporta `procedencia` verbatim sin verificarla, la persistió tal cual.
 * DESTINO_INTEGRIDAD_ENRUTAMIENTO_DIMENSIONAL_1/DESTINO_MODELO_AUTORIDAD_
 * DIMENSIONAL_1 reprodujeron el defecto mecánicamente y confirmaron la causa
 * raíz: el generador es hoy la ÚNICA autoridad sobre a qué dimensión
 * pertenece un concepto nuevo, sin ningún mecanismo independiente que la
 * contraste — el mismo hueco que existía para "autoridad" (experto/inferido)
 * antes de `autoridadGobernada`, ahora para "a qué dimensión pertenece".
 *
 * Este archivo es un PUERTO ESTRECHO, exactamente como
 * ValidadorSemanticoMutacionConcepto.js (mismo patrón, deliberadamente): no
 * produce conceptos, no propone dimensiones nuevas, no decide movimiento
 * conversacional, no formula preguntas, no modifica ningún delta por su
 * cuenta, no mantiene autoridad sobre "identidad conceptual" — solo adjudica
 * DIMENSION_GOBERNADA a partir de DIMENSION_PROPUESTA + el mensaje real +
 * el objetivo que gobernó el turno, y detecta (sin decidir fusionar) cuándo
 * dos conceptos propuestos en el mismo turno son, en sustancia, la misma
 * extracción citada dos veces.
 *
 * IMPORTANTE — extracción no es semántica: `contenidoEsExtractivo` (usado
 * por autoridadGobernada) certifica que un texto aparece literalmente en el
 * mensaje del usuario. Nunca certifica a qué dimensión pertenece ese texto.
 * Por eso este adjudicador es una autoridad DISTINTA — nunca una extensión
 * de esa verificación extractiva.
 *
 * Independencia requerida: de AUTORIDAD y CONTROL DE FLUJO, no
 * necesariamente de proveedor/modelo subyacente — invocación SEPARADA, con
 * su propio prompt y su propio resultado, nunca el mismo acto que propuso
 * los conceptos.
 */

const { normalizarParaHash } = require('./ValidadorSemanticoMutacionConcepto');

const VALIDADOR_ID = 'validador_semantico_delta_conceptos';
const VALIDADOR_VERSION = '1';

/**
 * Identidad estable de UNA adjudicación de dimensión — sesión + turno de
 * origen + hash del lote de conceptos evaluados (idTemporal+descripcion de
 * cada uno, en orden). No se persiste como autoridad durable entre turnos
 * (a diferencia de la mutación destructiva): cada turno propone conceptos
 * nuevos con idTemporal nuevos, así que no hay identidad estable cross-turno
 * que reutilizar — esta función existe para trazabilidad/depuración, no
 * para idempotencia entre llamadas.
 */
function identidadValidacionDimension({ sesionId, turnoOrigenId, conceptosPropuestos }) {
  const firma = (conceptosPropuestos || [])
    .map(c => `${c.idTemporal || ''}:${normalizarParaHash(c.descripcion)}`)
    .join('|');
  const hash = require('crypto').createHash('sha256').update(firma).digest('hex').slice(0, 16);
  return `${sesionId}:${turnoOrigenId}:${hash}`;
}

function buildSystemPromptValidadorDimension({
  mensajeUsuario, objetivoSolicitado, relacionRespuestaDirigidaDeclarada, dimensionesLegales, conceptosPropuestos,
}) {
  const bloqueDimensiones = dimensionesLegales
    .map(d => `- "${d.clave}": ${d.descripcion}`)
    .join('\n');
  const bloqueObjetivo = objetivoSolicitado
    ? `La pregunta/intervención del turno anterior apuntaba a la dimensión "${objetivoSolicitado}".`
    : 'No había ninguna dimensión objetivo vigente este turno (p. ej. primer turno, o el sistema no dirigió la pregunta a una dimensión concreta).';
  const bloqueRelacion = relacionRespuestaDirigidaDeclarada
    ? `\nEl propio generador ya declaró, a nivel de TURNO (no de concepto), que su respuesta "${relacionRespuestaDirigidaDeclarada.relacion}" respecto a esa pregunta — úsalo como contexto, nunca como veredicto: tu trabajo es decidir la dimensión de CADA concepto individual, no repetir esa declaración de turno.`
    : '';
  const bloqueConceptos = conceptosPropuestos
    .map((c, i) => `${i + 1}. idTemporal="${c.idTemporal}" | dimensión declarada por el generador: "${c.dimensionPropuesta || '(ninguna)'}" | descripción: "${c.descripcion}"`)
    .join('\n');

  return `Eres un ADJUDICADOR. No produces conceptos, no propones dimensiones nuevas fuera del catálogo dado, no decides movimiento conversacional, no formulas preguntas, no reescribes descripciones, no fusionas nada por tu cuenta. Tu ÚNICA tarea, por cada concepto propuesto abajo: determinar a qué dimensión pertenece REALMENTE su contenido (puede coincidir o no con la que el generador declaró), y señalar — nunca decidir — cuándo dos conceptos del mismo lote son la MISMA extracción citada dos veces.

DIMENSIONES LEGALES DE ESTA GRAMÁTICA (el único catálogo permitido para "dimensionGobernada"):
${bloqueDimensiones}

${bloqueObjetivo}${bloqueRelacion}

MENSAJE COMPLETO DEL USUARIO ESTE TURNO (única fuente de verdad sobre lo que realmente dijo):
"${mensajeUsuario}"

CONCEPTOS PROPUESTOS ESTE TURNO (evalúa cada uno de forma independiente, salvo la detección de identidad entre ellos):
${bloqueConceptos}

Para cada concepto, decide "dimensionGobernada": la clave EXACTA de una de las dimensiones legales listadas arriba cuyo contenido genuinamente corresponde a lo que ese concepto describe — sin importar cuál haya declarado el generador, y sin importar cuál era la dimensión objetivo del turno (un experto puede legítimamente responder sobre otra dimensión). Si el contenido del concepto no te permite determinar con confianza razonable a cuál de las dimensiones legales pertenece, responde "dimensionGobernada": null (ambigua) — nunca adivines.

Para "identidadRespectoA": si dos o más conceptos de este mismo lote son, en sustancia, la MISMA extracción del mensaje citada más de una vez (no dos ideas distintas que comparten evidencia — la MISMA idea repetida), en el concepto REDUNDANTE (el que agrega cero información nueva respecto al otro) pon el idTemporal del concepto que debe conservarse; en el concepto que se conserva, deja "identidadRespectoA": null. Si tienes cualquier duda de que sean dos aportes distintos apoyados en evidencia parecida (en vez de la misma cita repetida), responde null en ambos — nunca fusiones por similitud de texto.

Responde EXCLUSIVAMENTE este JSON, sin texto libre alrededor:
{
  "conceptos": [
    { "idTemporal": "<idTemporal exacto>", "dimensionGobernada": "<una clave del catálogo o null>", "identidadRespectoA": "<idTemporal de otro concepto de este lote, o null>" }
  ]
}`;
}

/**
 * Única llamada real al LLM de este módulo — de solo lectura, sin capacidad
 * de producir nada. Falla cerrado (todo el lote queda sin dimensión
 * gobernada) ante cualquier error de transporte, parseo, o forma de
 * respuesta inesperada — nunca asume una dimensión por defecto.
 */
async function validarSemanticamenteDelta({
  llmService, mensajeUsuario, objetivoSolicitado, relacionRespuestaDirigidaDeclarada,
  dimensionesLegales, conceptosPropuestos, turnoOrigenId,
  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 3) — identidad interna
  // reservada en admisión (ver InteraccionCognitivaWriter), exclusivamente
  // para correlacionar los eventos llm.* de esta llamada con la
  // EntradaConversacional que la originó. Nunca sustituye a turnoOrigenId
  // (identidad de dominio de este módulo, basada en turnoClienteId — sin
  // cambios en su significado ni en el resto del contrato).
  turnoId = null,
}) {
  const claveALegales = new Set(dimensionesLegales.map(d => d.clave));
  const idsDelLote = new Set(conceptosPropuestos.map(c => c.idTemporal));
  const failClosed = (codigoRazon) => ({
    conceptos: conceptosPropuestos.map(c => ({
      idTemporal: c.idTemporal, dimensionGobernada: null, identidadRespectoA: null,
    })),
    validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, turnoOrigenId, codigoRazon,
  });

  const system = buildSystemPromptValidadorDimension({
    mensajeUsuario, objetivoSolicitado, relacionRespuestaDirigidaDeclarada, dimensionesLegales, conceptosPropuestos,
  });
  let r;
  try {
    r = await llmService.call({
      system, userMsg: mensajeUsuario, label: 'validador_semantico_delta_conceptos',
      callProfile: 'VEREDICTO_ESTRUCTURADO', itemCount: conceptosPropuestos.length, turnoId,
    });
  } catch (e) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }
  const parsed = r && r.parsed;
  if (!parsed || !Array.isArray(parsed.conceptos)) {
    return failClosed('RESPUESTA_INVALIDA_O_NO_PARSEABLE');
  }

  const porId = new Map();
  for (const entrada of parsed.conceptos) {
    if (!entrada || typeof entrada.idTemporal !== 'string' || !idsDelLote.has(entrada.idTemporal)) continue;
    porId.set(entrada.idTemporal, entrada);
  }

  const conceptos = conceptosPropuestos.map((c) => {
    const entrada = porId.get(c.idTemporal);
    if (!entrada) {
      // El adjudicador nunca se pronunció sobre este concepto — fail-closed
      // SOLO para él, nunca para el resto del lote que sí respondió.
      return { idTemporal: c.idTemporal, dimensionGobernada: null, identidadRespectoA: null };
    }
    const dimensionGobernada = typeof entrada.dimensionGobernada === 'string' && claveALegales.has(entrada.dimensionGobernada)
      ? entrada.dimensionGobernada : null;
    const identidadDeclarada = typeof entrada.identidadRespectoA === 'string' ? entrada.identidadRespectoA : null;
    // Solo se acepta identidadRespectoA si apunta a OTRO concepto real del
    // mismo lote — nunca a sí mismo, nunca a un id inventado.
    const identidadRespectoA = (identidadDeclarada && identidadDeclarada !== c.idTemporal && idsDelLote.has(identidadDeclarada))
      ? identidadDeclarada : null;
    return { idTemporal: c.idTemporal, dimensionGobernada, identidadRespectoA };
  });

  return {
    conceptos, validadorId: VALIDADOR_ID, validadorVersion: VALIDADOR_VERSION,
    validadorDistintoDelProductor: true, turnoOrigenId, codigoRazon: null,
  };
}

module.exports = {
  VALIDADOR_ID, VALIDADOR_VERSION,
  identidadValidacionDimension, buildSystemPromptValidadorDimension, validarSemanticamenteDelta,
};
