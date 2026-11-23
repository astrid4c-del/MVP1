'use strict';

/**
 * S1 — elegibilidad referencial de la síntesis final DESTINO.
 * Solo consulta el historial durable de rechazos; no compara texto, no llama
 * al LLM y no muta estado ni concede autoridad.
 */
function fuenteSemanticaAfirmacion(afirmacionId, afirmacionVersion) {
  if (typeof afirmacionId !== 'string' || !afirmacionId.trim()
      || !Number.isInteger(afirmacionVersion) || afirmacionVersion < 1) return null;
  return Object.freeze({ tipo: 'AFIRMACION_TRANSFORMACIONAL', id: afirmacionId, version: afirmacionVersion });
}

function fuenteFueRechazada(eventRepo, sesionId, fuente) {
  if (!eventRepo || !fuente) return false;
  return eventRepo.findBySesionAndType(sesionId, 'sintesis.correccion_recibida').some(evento => {
    const p = evento && evento.payload;
    const f = p && p.fuenteSemantica;
    const desacuerdoSemantico = p && (p.tipo === 'rechaza'
      || (p.tipo === 'corrige' && p.impactoCambio === 'SEMANTICO'));
    return p && p.gramaticaActiva === 'destino' && desacuerdoSemantico
      && f && f.tipo === fuente.tipo && f.id === fuente.id && f.version === fuente.version;
  });
}

function evaluarElegibilidadFuenteSintesis({ eventRepo, sesionId, fuenteSemantica } = {}) {
  if (!fuenteSemantica || fuenteSemantica.tipo !== 'AFIRMACION_TRANSFORMACIONAL'
      || typeof fuenteSemantica.id !== 'string' || !Number.isInteger(fuenteSemantica.version)) {
    return Object.freeze({ elegible: false, razon: 'FUENTE_SEMANTICA_INVALIDA' });
  }
  if (fuenteFueRechazada(eventRepo, sesionId, fuenteSemantica)) {
    return Object.freeze({ elegible: false, razon: 'FUENTE_SEMANTICA_RECHAZADA' });
  }
  return Object.freeze({ elegible: true, razon: null });
}

module.exports = { fuenteSemanticaAfirmacion, fuenteFueRechazada, evaluarElegibilidadFuenteSintesis };
