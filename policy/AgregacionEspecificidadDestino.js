'use strict';

/**
 * circulomejora006_reporte05 — agregación pura de los 4 resultados por
 * unidad (INICIO/MECANISMO/RESULTADO/OBSERVABILIDAD) en un veredicto único
 * de especificidad para la presentación/Afirmación.
 *
 * Regla — mismo patrón que AgregacionProporcionalidadDestino.js/
 * BaseDefendibleDestinoPolicy.js (cualquier señal negativa de cualquier
 * unidad bloquea el conjunto; nunca promedio, nunca mayoría, nunca score):
 *   alguna unidad GENERICA                → NO_DEMOSTRADA
 *   ninguna genérica + alguna INDETERMINADA → INDETERMINADA
 *   las cuatro ESPECIFICA                  → DEMOSTRADA
 *
 * Deliberadamente sin un estado 'ESPECIFICA_EN_CONTEXTO': la dependencia
 * cruzada entre unidades ya la resuelve el evaluador (que lee las cuatro
 * unidades visibles antes de emitir el veredicto de la unidad objetivo) —
 * ver EvaluadorEspecificidadDestino.js. Nunca persiste nada.
 */

const {
  CONTRATO_VERSION, ROLES_UNIDAD_ESPECIFICIDAD,
} = require('../schemas/CriterioEspecificidadDestino');

function resultadoIncompleto({ afirmacionId, presentacionId, revisionEvaluada, resultadosPorUnidad }) {
  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId,
    presentacionId,
    revisionEvaluada,
    estado: 'INDETERMINADA',
    resultadosPorUnidad: Object.freeze([...(Array.isArray(resultadosPorUnidad) ? resultadosPorUnidad : [])]),
    dimensionesAcumuladas: Object.freeze([]),
    razones: Object.freeze(['RESULTADOS_POR_UNIDAD_INCOMPLETOS']),
  });
}

/**
 * @param {object} params
 * @param {Array<object>} params.resultadosPorUnidad — resultados de
 *   validarEspecificidadDestino (o construidos directamente para unidades
 *   bloqueadas), exactamente uno por rol de ROLES_UNIDAD_ESPECIFICIDAD.
 * @param {string} params.afirmacionId
 * @param {string} params.presentacionId
 * @param {number} params.revisionEvaluada
 * @returns {object} veredicto agregado — nunca lanza.
 */
function agregarEspecificidadDestino({
  resultadosPorUnidad, afirmacionId, presentacionId, revisionEvaluada,
} = {}) {
  const contexto = { afirmacionId, presentacionId, revisionEvaluada, resultadosPorUnidad };

  if (!Array.isArray(resultadosPorUnidad) || resultadosPorUnidad.length !== 4) {
    return resultadoIncompleto(contexto);
  }
  const roles = resultadosPorUnidad.map(r => r && r.rol);
  if (new Set(roles).size !== 4 || !ROLES_UNIDAD_ESPECIFICIDAD.every(rol => roles.includes(rol))) {
    return resultadoIncompleto(contexto);
  }
  const identidadCoherente = resultadosPorUnidad.every(r => (
    r && r.afirmacionId === afirmacionId && r.presentacionId === presentacionId && r.revisionEvaluada === revisionEvaluada
  ));
  if (!identidadCoherente) {
    return resultadoIncompleto(contexto);
  }

  const algunaGenerica = resultadosPorUnidad.some(r => r.estado === 'GENERICA');
  const algunaIndeterminada = resultadosPorUnidad.some(r => r.estado === 'INDETERMINADA');
  const estado = algunaGenerica ? 'NO_DEMOSTRADA' : (algunaIndeterminada ? 'INDETERMINADA' : 'DEMOSTRADA');

  const dimensionesAcumuladas = Object.freeze([
    ...new Set(resultadosPorUnidad.flatMap(r => r.dimensionesGenericidad || [])),
  ]);
  const razones = Object.freeze([...new Set(resultadosPorUnidad.map(r => r.razon))]);

  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId,
    presentacionId,
    revisionEvaluada,
    estado,
    resultadosPorUnidad: Object.freeze([...resultadosPorUnidad]),
    dimensionesAcumuladas,
    razones,
  });
}

module.exports = {
  agregarEspecificidadDestino,
};
