'use strict';

/**
 * Adjudica el derecho semántico de una oportunidad propuesta por Capa 1.
 * No selecciona movimiento, no reescribe la oportunidad y no produce copy.
 */

const ADJUDICADOR_ID = 'adjudicador_semantico_oportunidad_conversacional';
const ADJUDICADOR_VERSION = '1';

function construirPrompt({ materialAutorizado = [], relacionesAutorizadas = [], mision, necesidad, oportunidad }) {
  const hechos = materialAutorizado.map(h => `- [${h.id}] ${h.descripcion}`).join('\n') || '(ninguno)';
  const relaciones = relacionesAutorizadas.map(r => `- [${r.id}] ${r.tipo}: ${r.origen} → ${r.destino}`).join('\n') || '(ninguna)';
  return `Eres un ADJUDICADOR SEMÁNTICO DE OPORTUNIDADES CONVERSACIONALES. No eres el generador, no produces alternativas, no reescribes la oportunidad y no formulas preguntas visibles. Descompón la oportunidad: identifica las bases autorizadas que usa y TODA estructura factual adicional que presupone como existente. No decidas admisibilidad: el código derivará el veredicto.

MATERIAL AUTORIZADO (única base factual):
${hechos}

RELACIONES AUTORIZADAS:
${relaciones}

MISIÓN: ${mision || '(no especificada)'}
NECESIDAD ACTUAL: ${necesidad || '(no especificada)'}

OPORTUNIDAD A ADJUDICAR:
- foco: ${oportunidad.focoExploracion || ''}
- desconocidoObjetivo: ${oportunidad.desconocidoObjetivo || ''}
- evidenciaBuscada: ${oportunidad.evidenciaBuscada || ''}

PREGUNTAR LO DESCONOCIDO no autoriza PRESUPONER LA FORMA DE LO DESCONOCIDO. Registra como estructura adicional cualquier entidad, método, herramienta, criterio, dato, indicador, causa, historia o relación factual que la oportunidad trate como existente y que no sea una base autorizada. No registres como estructura adicional el propio hecho autorizado, la acción autorizada, ni la mera posibilidad de describir cómo ocurre esa acción: abrir el cómo de un hecho no afirma una forma adicional. Cuando la oportunidad solo pide describir cómo se ejecuta una acción ya autorizada, sin nombrar una estructura factual concreta, la lista de estructuras adicionales debe ser []. No evalúes estilo ni interés.

Responde SOLO este JSON:
{
  "basesAutorizadasUsadas": [{"conceptoId":"id autorizado","proposicion":"..."}],
  "estructurasAdicionalesPresupuestas": [{"proposicion":"...","soporteConceptoIds":[],"soporteRelacionIds":[]}],
  "razon": "..."
}`;
}

async function adjudicarOportunidadSemantica({ llmService, materialAutorizado = [], relacionesAutorizadas = [], mision, necesidad, oportunidad, turnoId = null }) {
  const fail = razon => ({ admisible: false, basesAutorizadasUsadas: [], estructurasAdicionalesPresupuestas: [], presuposicionesNoAutorizadas: [], razon, adjudicadorId: ADJUDICADOR_ID, adjudicadorVersion: ADJUDICADOR_VERSION });
  if (!llmService || !oportunidad || typeof oportunidad !== 'object') return fail('ENTRADA_INVALIDA');
  let resultado;
  try {
    resultado = await llmService.call({
      system: construirPrompt({ materialAutorizado, relacionesAutorizadas, mision, necesidad, oportunidad }),
      userMsg: 'Adjudica la oportunidad estructurada indicada.',
      label: ADJUDICADOR_ID,
      callProfile: 'VEREDICTO_ESTRUCTURADO',
      turnoId,
    });
  } catch (e) {
    return fail('ADJUDICACION_NO_DISPONIBLE');
  }
  const parsed = resultado && resultado.parsed;
  if (!parsed || !Array.isArray(parsed.basesAutorizadasUsadas) || !Array.isArray(parsed.estructurasAdicionalesPresupuestas)) {
    return fail('RESPUESTA_INVALIDA');
  }
  const idsConceptos = new Set(materialAutorizado.map(h => h.id));
  const idsRelaciones = new Set(relacionesAutorizadas.map(r => r.id));
  const bases = parsed.basesAutorizadasUsadas.filter(b => b && idsConceptos.has(b.conceptoId)
    && typeof b.proposicion === 'string').map(b => ({ conceptoId: b.conceptoId, proposicion: b.proposicion }));
  const estructuras = parsed.estructurasAdicionalesPresupuestas.filter(e => e && typeof e.proposicion === 'string')
    .map(e => ({
      proposicion: e.proposicion,
      soporteConceptoIds: Array.isArray(e.soporteConceptoIds) ? e.soporteConceptoIds.filter(id => idsConceptos.has(id)) : [],
      soporteRelacionIds: Array.isArray(e.soporteRelacionIds) ? e.soporteRelacionIds.filter(id => idsRelaciones.has(id)) : [],
    }));
  const sinSoporte = estructuras.filter(e => e.soporteConceptoIds.length === 0 && e.soporteRelacionIds.length === 0);
  return {
    admisible: estructuras.length === 0 || sinSoporte.length === 0,
    basesAutorizadasUsadas: bases,
    estructurasAdicionalesPresupuestas: estructuras,
    presuposicionesNoAutorizadas: sinSoporte.map(e => e.proposicion),
    razon: typeof parsed.razon === 'string' ? parsed.razon : null,
    adjudicadorId: ADJUDICADOR_ID,
    adjudicadorVersion: ADJUDICADOR_VERSION,
  };
}

module.exports = { ADJUDICADOR_ID, ADJUDICADOR_VERSION, construirPrompt, adjudicarOportunidadSemantica };
