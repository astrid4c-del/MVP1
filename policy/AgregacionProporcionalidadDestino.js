'use strict';

/**
 * circulomejora006_reporte04 — agregación pura de los 4 resultados por
 * unidad (INICIO/MECANISMO/RESULTADO/OBSERVABILIDAD) en un veredicto único
 * de proporcionalidad para la presentación/Afirmación.
 *
 * Regla — mismo patrón que BaseDefendibleDestinoPolicy.js (cualquier señal
 * negativa de cualquier constituyente bloquea el conjunto; nunca promedio,
 * nunca mayoría, nunca score):
 *   alguna unidad EXCEDE_SOPORTE            → NO_DEMOSTRADA
 *   ninguna excede + alguna INDETERMINADA   → INDETERMINADA
 *   las cuatro PROPORCIONADA                → DEMOSTRADA
 *
 * Nunca persiste nada — es un reductor puro sobre resultados ya calculados.
 */

const {
  CONTRATO_VERSION, ROLES_UNIDAD_PROPORCIONALIDAD,
} = require('../schemas/CriterioProporcionalidadDestino');

function resultadoIncompleto({ afirmacionId, presentacionId, revisionEvaluada, resultadosPorUnidad }) {
  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId,
    presentacionId,
    revisionEvaluada,
    estado: 'INDETERMINADA',
    resultadosPorUnidad: Object.freeze([...(Array.isArray(resultadosPorUnidad) ? resultadosPorUnidad : [])]),
    dimensionesExceso: Object.freeze([]),
    razones: Object.freeze(['RESULTADOS_POR_UNIDAD_INCOMPLETOS']),
  });
}

/**
 * @param {object} params
 * @param {Array<object>} params.resultadosPorUnidad — resultados de
 *   validarProporcionalidadDestino (o construidos directamente para
 *   unidades bloqueadas), exactamente uno por rol de ROLES_UNIDAD_PROPORCIONALIDAD.
 * @param {string} params.afirmacionId
 * @param {string} params.presentacionId
 * @param {number} params.revisionEvaluada
 * @returns {object} veredicto agregado — nunca lanza.
 */
function agregarProporcionalidadDestino({
  resultadosPorUnidad, afirmacionId, presentacionId, revisionEvaluada,
} = {}) {
  const contexto = { afirmacionId, presentacionId, revisionEvaluada, resultadosPorUnidad };

  if (!Array.isArray(resultadosPorUnidad) || resultadosPorUnidad.length !== 4) {
    return resultadoIncompleto(contexto);
  }
  const roles = resultadosPorUnidad.map(r => r && r.rol);
  if (new Set(roles).size !== 4 || !ROLES_UNIDAD_PROPORCIONALIDAD.every(rol => roles.includes(rol))) {
    return resultadoIncompleto(contexto);
  }
  const identidadCoherente = resultadosPorUnidad.every(r => (
    r && r.afirmacionId === afirmacionId && r.presentacionId === presentacionId && r.revisionEvaluada === revisionEvaluada
  ));
  if (!identidadCoherente) {
    return resultadoIncompleto(contexto);
  }

  const algunaExcede = resultadosPorUnidad.some(r => r.estado === 'EXCEDE_SOPORTE');
  const algunaIndeterminada = resultadosPorUnidad.some(r => r.estado === 'INDETERMINADA');
  const estado = algunaExcede ? 'NO_DEMOSTRADA' : (algunaIndeterminada ? 'INDETERMINADA' : 'DEMOSTRADA');

  const dimensionesExceso = Object.freeze([
    ...new Set(resultadosPorUnidad.flatMap(r => r.dimensionesExceso || [])),
  ]);
  const razones = Object.freeze([...new Set(resultadosPorUnidad.map(r => r.razon))]);

  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId,
    presentacionId,
    revisionEvaluada,
    estado,
    resultadosPorUnidad: Object.freeze([...resultadosPorUnidad]),
    dimensionesExceso,
    razones,
  });
}

module.exports = {
  agregarProporcionalidadDestino,
};
