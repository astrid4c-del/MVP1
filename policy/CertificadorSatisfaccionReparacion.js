'use strict';

// Frontera compartida de evidencia: las fuentes (reconciliación/veredicto o
// respuesta dirigida) aportan una proposición; esta función solo la acepta
// cuando puede vincularla estructuralmente a la reparación concreta.
const FUENTES_AUTORIZADAS = Object.freeze(['RECONCILIACION', 'RESPUESTA_DIRIGIDA']);

// Normaliza la salida semántica de VEREDICTO/RespuestaDirigida antes de que
// Círculo le asigne una fuente. No concede autoridad ni muta R.
function normalizarPropuestaSatisfaccion({ reparacion, propuesta, materialIdsDisponibles = [] } = {}) {
  if (!reparacion || !propuesta || reparacion.estado === 'RESUELTA') return null;
  if (propuesta.intentoInterpretacionId !== reparacion.intentoInterpretacionId) return null;
  if (!reparacion.criterioSatisfaccion
      || reparacion.criterioSatisfaccion.intentoInterpretacionId !== propuesta.intentoInterpretacionId) return null;
  const disponibles = new Set((materialIdsDisponibles || [])
    .map(material => (typeof material === 'string' ? material : material && material.id))
    .filter(Boolean));
  const declarados = Array.isArray(propuesta.materialIds) ? propuesta.materialIds : null;
  if (!declarados || declarados.length === 0) return null;
  const materialIds = [...new Set(declarados)];
  // ALL_OR_NOTHING: una referencia ausente, nula o no resoluble invalida la
  // propuesta completa. Duplicados exactos son redundancia y se deduplican;
  // nunca se certifica un subconjunto tras descartar una referencia inválida.
  if (propuesta.satisface !== true
      || declarados.some(id => typeof id !== 'string' || !id.trim() || !disponibles.has(id))) return null;
  return Object.freeze({
    obligacionId: reparacion.obligacionId,
    intentoInterpretacionId: reparacion.intentoInterpretacionId,
    materialIds: Object.freeze(materialIds),
    satisface: true,
  });
}

function certificarSatisfaccionReparacion({
  reparacion,
  criterioSatisfaccion,
  obligacionId,
  intentoInterpretacionId,
  materialIds = [],
  materialesDisponibles = [],
  satisface = false,
  fuente,
} = {}) {
  if (!reparacion || reparacion.estado === 'RESUELTA') return null;
  if (!criterioSatisfaccion || criterioSatisfaccion.tipo !== 'CORREGIR_INTERPRETACION') return null;
  if (criterioSatisfaccion.intentoInterpretacionId !== reparacion.intentoInterpretacionId) return null;
  if (typeof reparacion.obligacionId !== 'string' || obligacionId !== reparacion.obligacionId) return null;
  if (intentoInterpretacionId !== reparacion.intentoInterpretacionId) return null;
  if (!FUENTES_AUTORIZADAS.includes(fuente) || satisface !== true) return null;

  const disponibles = new Set((materialesDisponibles || [])
    .map(material => (typeof material === 'string' ? material : material && material.id))
    .filter(Boolean));
  if (!Array.isArray(materialIds) || materialIds.length === 0) return null;
  const ids = [...new Set(materialIds)];
  if (materialIds.some(id => typeof id !== 'string' || !id.trim() || !disponibles.has(id))) return null;

  return Object.freeze({
    obligacionId,
    intentoInterpretacionId,
    criterioSatisfaccion: Object.freeze({
      tipo: criterioSatisfaccion.tipo,
      intentoInterpretacionId: criterioSatisfaccion.intentoInterpretacionId,
    }),
    materialIds: Object.freeze(ids),
    satisface: true,
    fuente,
  });
}

module.exports = { FUENTES_AUTORIZADAS, normalizarPropuestaSatisfaccion, certificarSatisfaccionReparacion };
