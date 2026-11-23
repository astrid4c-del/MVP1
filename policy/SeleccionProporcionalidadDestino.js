'use strict';

/**
 * circulomejora006_reporte04 — selección determinista de las unidades de
 * proporcionalidad. Función pura: no invoca al evaluador, no invoca al
 * validador, no conoce LLM ni I/O. Nunca decide semántica (modalidad,
 * causalidad, alcance, condicionalidad) — solo empaqueta evidencia ya
 * resuelta y detecta, estructuralmente, cuándo una unidad no puede
 * evaluarse en absoluto.
 *
 * Fuente ÚNICA de evidencia resuelta: la salida de
 * TrazabilidadPresentacionC1Projection.proyectarTrazabilidadPresentacionC1
 * — nunca se duplica esa resolución (autoridad/activo/rechazado/no-resuelto/
 * contradicciones ya vienen calculadas ahí, por unidad). Este módulo solo
 * consume el shape ESTRUCTURADO de esa proyección (nunca su texto
 * narrativo).
 *
 * Una unidad sin soportes (o con cualquier otra irregularidad estructural)
 * NUNCA desaparece de la selección — se devuelve explícitamente bloqueada,
 * con una razón cerrada, para que el llamador la traduzca en un resultado
 * INDETERMINADA sin invocar nunca al LLM.
 */

const { ROLES_UNIDAD_PROPORCIONALIDAD } = require('../schemas/CriterioProporcionalidadDestino');

// Enlaces estructurales adyacentes a cada constituyente — mismo orden causal
// que la plantilla (_FormulacionTransformacionalDestinoTemplate.js). Nunca
// contienen texto propio; se adjuntan solo como contexto (ver docstring de
// EvaluadorProporcionalidadDestino.js — nunca se les atribuye una frase).
const ENLACES_ADYACENTES_POR_ROL = Object.freeze({
  INICIO: Object.freeze(['INICIO_A_MECANISMO']),
  MECANISMO: Object.freeze(['INICIO_A_MECANISMO', 'MECANISMO_A_RESULTADO']),
  RESULTADO: Object.freeze(['MECANISMO_A_RESULTADO', 'RESULTADO_A_OBSERVABILIDAD']),
  OBSERVABILIDAD: Object.freeze(['RESULTADO_A_OBSERVABILIDAD']),
});

function congelar(valor) {
  return Object.freeze({ ...valor });
}

function bloqueada({
  rol, afirmacionId, presentacionId, revisionEvaluada, unidadLocalId, razonBloqueo,
}) {
  return congelar({
    bloqueada: true, razonBloqueo, rol, afirmacionId, presentacionId, revisionEvaluada,
    unidadLocalId: unidadLocalId || null,
  });
}

/**
 * ¿Este soporte, tal como lo resolvió la trazabilidad, tiene autoridad
 * válida para sostener un juicio de proporcionalidad? Mismo criterio que
 * "autorizado" en el resto de BaseDefendibleDestinoPolicy/D1.7-B: EXCLUSIVAMENTE
 * autoridad==='experto', activo, no rechazado. Cualquier otra clasificación
 * (inferido/ia/evidencia_verificable/autoridad inválida) bloquea.
 */
function soporteSinAutoridadValida(unidadTrazabilidad) {
  return (
    unidadTrazabilidad.conceptosInferidos.length > 0
    || unidadTrazabilidad.conceptosIA.length > 0
    || unidadTrazabilidad.conceptosEvidenciaVerificable.length > 0
    || unidadTrazabilidad.conceptosAutoridadInvalida.length > 0
  );
}

/**
 * Selecciona las 4 unidades visibles (constituyentes) de una presentación
 * ya trazada — nunca los enlaces (sin texto propio, ver docstring de
 * cabecera). Cada resultado es, o bien una selección lista para evaluar, o
 * bien una selección explícitamente bloqueada con razón cerrada — nunca un
 * elemento ausente.
 *
 * @param {object} params
 * @param {object} params.trazabilidad — salida EXACTA de
 *   proyectarTrazabilidadPresentacionC1({uow, sesionId, afirmacionId, presentacionId}).
 * @returns {Array<object>} 4 registros, en orden INICIO→MECANISMO→RESULTADO→OBSERVABILIDAD.
 */
function seleccionarUnidadesProporcionalidadDestino({ trazabilidad } = {}) {
  if (!trazabilidad || typeof trazabilidad !== 'object' || !Array.isArray(trazabilidad.unidades)) {
    throw new Error('SELECCION_PROPORCIONALIDAD_TRAZABILIDAD_INVALIDA');
  }
  const {
    afirmacionId, presentacionId, afirmacionVersion: revisionEvaluada, esCabezaVigente,
  } = trazabilidad;

  return ROLES_UNIDAD_PROPORCIONALIDAD.map(rol => {
    const base = {
      rol, afirmacionId, presentacionId, revisionEvaluada,
    };
    const unidad = trazabilidad.unidades.find(u => u.tipo === 'CONSTITUYENTE' && u.rol === rol);
    if (!unidad) {
      return bloqueada({ ...base, razonBloqueo: 'UNIDAD_NO_PERTENECE_A_PRESENTACION' });
    }
    const { unidadLocalId } = unidad;
    if (!esCabezaVigente) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'REVISION_YA_NO_VIGENTE' });
    }
    if (typeof unidad.textoVisibleExacto !== 'string' || !unidad.textoVisibleExacto.trim()) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'UNIDAD_SIN_TEXTO_VISIBLE' });
    }
    const conceptoIds = (unidad.soportesDeclarados && unidad.soportesDeclarados.conceptoIds) || [];
    const referenciasLiterales = (unidad.soportesDeclarados && unidad.soportesDeclarados.referenciasLiterales) || [];
    if (conceptoIds.length === 0) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'UNIDAD_SIN_SOPORTES' });
    }
    if (unidad.conceptosNoResueltos.length > 0) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'SOPORTE_NO_RESUELTO' });
    }
    if (unidad.conceptosInactivos.length > 0) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'SOPORTE_INACTIVO' });
    }
    if (unidad.conceptosRechazados.length > 0) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'SOPORTE_RECHAZADO' });
    }
    if (soporteSinAutoridadValida(unidad) || unidad.conceptosAutorizados.length !== conceptoIds.length) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'SOPORTE_SIN_AUTORIDAD_VALIDA' });
    }
    if (unidad.contradiccionesCandidatas.length > 0) {
      return bloqueada({ ...base, unidadLocalId, razonBloqueo: 'CONTRADICCION_ACTIVA_VINCULADA' });
    }

    const contextoRelacional = Object.freeze(
      ENLACES_ADYACENTES_POR_ROL[rol].map(rolEnlace => {
        const enlace = trazabilidad.unidades.find(u => u.tipo === 'ENLACE_CAUSAL' && u.rol === rolEnlace);
        return congelar({
          rol: rolEnlace,
          conceptoIds: Object.freeze([...((enlace && enlace.soportesDeclarados && enlace.soportesDeclarados.conceptoIds) || [])]),
        });
      }),
    );

    return congelar({
      bloqueada: false,
      razonBloqueo: null,
      rol,
      afirmacionId,
      presentacionId,
      revisionEvaluada,
      unidadLocalId,
      textoVisible: unidad.textoVisibleExacto,
      conceptoIds: Object.freeze([...conceptoIds]),
      referenciasLiterales: Object.freeze(referenciasLiterales.map(ref => congelar({ ...ref }))),
      conceptosAutorizados: Object.freeze(unidad.conceptosAutorizados.map(c => congelar({ id: c.id, descripcion: c.descripcion }))),
      contextoRelacional,
    });
  });
}

module.exports = {
  seleccionarUnidadesProporcionalidadDestino,
};
