'use strict';

/**
 * Primera regla sustantiva de la dimensión contractual 'soporteConceptual'
 * (ver DefendibilidadC1.js). Opción A, aprobada explícitamente: evalúa
 * ÚNICAMENTE si, entre las referencias conceptuales que una unidad ya
 * proyectada declara, existe respaldo experto vigente y verificable —
 * nunca cobertura integral de la unidad. El modelo actual no distingue
 * conceptos nucleares, accesorios, requeridos ni sustituibles (ver
 * _AfirmacionTransformacionalDestinoProcessLocal.js), así que SUFICIENTE
 * nunca debe leerse ni documentarse como "la unidad está completamente
 * cubierta" — solo como "existe al menos un concepto autorizado".
 *
 * Dimensión de contrato: 'soporteConceptual' (DefendibilidadC1.js).
 * Operación concreta disponible hoy: evaluar presencia de respaldo experto.
 *
 * Entrada: exactamente una unidad ya proyectada por
 * TrazabilidadPresentacionC1Projection (un elemento de su array
 * `unidades`). Nunca lee KnowledgeGraph, CognitiveObject, AuthorityPolicy,
 * SQLite, UnitOfWork ni estado global — consume únicamente los buckets
 * conceptuales que la proyección ya resolvió.
 */

const { esEstadoValidoParaDimension } = require('../schemas/DefendibilidadC1');

const DIMENSION = 'soporteConceptual';

const RAZONES_SOPORTE_CONCEPTUAL_C1 = Object.freeze([
  'RESPALDO_EXPERTO_PRESENTE',
  'SIN_RESPALDO_EXPERTO_VERIFICABLE',
  'CONCEPTO_NO_RESUELTO_SIN_RESPALDO_ALTERNATIVO',
]);

const BUCKETS_REQUERIDOS = Object.freeze([
  'conceptosAutorizados',
  'conceptosNoResueltos',
  'conceptosInferidos',
  'conceptosEvidenciaVerificable',
  'conceptosIA',
  'conceptosInactivos',
  'conceptosRechazados',
]);

function validarUnidadProyectada(unidad) {
  if (!unidad || typeof unidad !== 'object' || Array.isArray(unidad)) {
    throw new Error('SOPORTE_CONCEPTUAL_C1_UNIDAD_INVALIDA');
  }
  BUCKETS_REQUERIDOS.forEach(campo => {
    if (!Array.isArray(unidad[campo])) {
      throw new Error(`SOPORTE_CONCEPTUAL_C1_BUCKET_INVALIDO:${campo}`);
    }
  });
}

/**
 * Precondición de aplicabilidad (Especificación §4): la policy solo tiene
 * un resultado normativo válido cuando la unidad declara al menos una
 * referencia conceptual — conceptos resueltos de cualquier categoría
 * relevante, más las referencias no resueltas. conceptosAutoridadInvalida
 * queda fuera de esta suma y de toda la regla: es estructuralmente
 * inalcanzable (deserializeState ya rechaza cualquier autoridad fuera del
 * enum antes de que exista una vista que esta policy pueda consumir) y no
 * pertenece al dominio epistémico de esta dimensión.
 */
function totalReferenciasConceptuales(unidad) {
  return unidad.conceptosAutorizados.length
    + unidad.conceptosInferidos.length
    + unidad.conceptosEvidenciaVerificable.length
    + unidad.conceptosIA.length
    + unidad.conceptosInactivos.length
    + unidad.conceptosRechazados.length
    + unidad.conceptosNoResueltos.length;
}

/**
 * Evalúa presencia de respaldo experto (dimensión 'soporteConceptual') para
 * una unidad ya proyectada. Prioridad de evaluación (Especificación §8):
 *   1. validar entrada y aplicabilidad;
 *   2. si existe autorizado → SUFICIENTE (la coexistencia de inferidos, ia,
 *      evidencia verificable, rechazados, inactivos o no resueltos nunca
 *      degrada este resultado — esta regla no afirma cobertura, solo
 *      presencia);
 *   3. si no existe autorizado y hay no resueltos → INDETERMINADO (una
 *      referencia no resuelta todavía podría corresponder a un concepto
 *      experto y cambiar el resultado);
 *   4. si todo lo declarado está resuelto y no existe autorizado →
 *      INSUFICIENTE.
 *
 * Cuando la unidad no declara ninguna referencia conceptual (el caso de
 * una unidad sostenida únicamente mediante referenciasLiterales), esta
 * dimensión no tiene un resultado normativo válido — el vocabulario
 * consolidado de DefendibilidadC1 no contiene NO_APLICA para
 * 'soporteConceptual', así que la no aplicabilidad se expresa rechazando
 * la invocación, nunca convirtiéndola en INSUFICIENTE.
 *
 * @param {object} unidad — un elemento de proyectarTrazabilidadPresentacionC1(...).unidades
 * @returns {{ dimension: 'soporteConceptual', estado: string, razones: string[] }} congelado
 */
function evaluarPresenciaRespaldoExpertoC1(unidad) {
  validarUnidadProyectada(unidad);

  if (totalReferenciasConceptuales(unidad) === 0) {
    throw new Error('SOPORTE_CONCEPTUAL_C1_NO_APLICA');
  }

  let estado;
  let razon;
  if (unidad.conceptosAutorizados.length > 0) {
    estado = 'SUFICIENTE';
    razon = 'RESPALDO_EXPERTO_PRESENTE';
  } else if (unidad.conceptosNoResueltos.length > 0) {
    estado = 'INDETERMINADO';
    razon = 'CONCEPTO_NO_RESUELTO_SIN_RESPALDO_ALTERNATIVO';
  } else {
    estado = 'INSUFICIENTE';
    razon = 'SIN_RESPALDO_EXPERTO_VERIFICABLE';
  }

  if (!esEstadoValidoParaDimension(DIMENSION, estado)) {
    throw new Error('SOPORTE_CONCEPTUAL_C1_ESTADO_NO_VALIDO_PARA_DIMENSION');
  }

  return Object.freeze({
    dimension: DIMENSION,
    estado,
    razones: Object.freeze([razon]),
  });
}

module.exports = {
  RAZONES_SOPORTE_CONCEPTUAL_C1,
  evaluarPresenciaRespaldoExpertoC1,
};
