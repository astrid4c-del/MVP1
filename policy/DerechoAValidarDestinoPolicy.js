'use strict';

const { incertidumbresRelevantesAbiertas } = require('../state/GrafoProyeccion');

/**
 * Composición process-local del derecho a poner una Hipótesis de DESTINO a
 * prueba. No afirma, sintetiza ni produce superficie: solo compone bloqueos
 * ya gobernados sobre la candidata concreta.
 */
function evaluarDerechoAValidarDestino({
  candidata,
  grafoActual,
  reparacionesInterpretativasPendientes = [],
} = {}) {
  const bloqueos = [];
  if (!candidata || candidata.estado !== 'CANDIDATA_DISPONIBLE') {
    bloqueos.push('CANDIDATA_NO_DISPONIBLE');
  }
  const roles = candidata && candidata.roles;
  const soporteIds = new Set(Object.values(roles || {}).flatMap(ids => Array.isArray(ids) ? ids : []));
  const conceptos = grafoActual && Array.isArray(grafoActual.conceptos) ? grafoActual.conceptos : [];
  if (candidata && candidata.estado === 'CANDIDATA_DISPONIBLE') {
    for (const id of soporteIds) {
      const concepto = conceptos.find(c => c.id === id);
      if (!concepto || concepto.activo !== true || concepto.autoridad !== 'experto') {
        bloqueos.push(`SOPORTE_NO_AUTORIZADO:${id}`);
      }
    }
  }
  const incertidumbres = incertidumbresRelevantesAbiertas(grafoActual, 'destino');
  if (incertidumbres.some(u => Array.isArray(u.sobreConceptos) && u.sobreConceptos.some(id => soporteIds.has(id)))) {
    bloqueos.push('INCERTIDUMBRE_RELEVANTE_APLICABLE');
  }
  if (Array.isArray(reparacionesInterpretativasPendientes) && reparacionesInterpretativasPendientes.length > 0) {
    bloqueos.push('REPARACION_INTERPRETATIVA_PENDIENTE');
  }
  return Object.freeze({ elegible: bloqueos.length === 0, bloqueos: Object.freeze(bloqueos) });
}

module.exports = { evaluarDerechoAValidarDestino };
