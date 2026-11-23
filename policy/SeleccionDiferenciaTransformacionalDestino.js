'use strict';

/**
 * circulomejora006_reporte07 — selección determinista de la tríada de
 * diferencia transformacional. Función pura: no invoca al evaluador, no
 * invoca al validador, no conoce LLM ni I/O. Nunca decide si existe
 * transformación — solo empaqueta evidencia ya resuelta y detecta,
 * estructuralmente, cuándo la tríada no puede evaluarse.
 *
 * Diferencia estructural frente a SeleccionProporcionalidadDestino.js/
 * SeleccionEspecificidadDestino.js (nunca reutilizados tal cual): esos dos
 * producen CUATRO registros independientes, uno por unidad visible. Este
 * selector produce UNA SOLA selección compuesta — la pregunta de
 * diferencia transformacional es una propiedad de la RELACIÓN entre
 * INICIO/MECANISMO/RESULTADO, nunca una propiedad aislada de una unidad.
 * OBSERVABILIDAD nunca se incluye — no participa en la pregunta semántica
 * (ver auditoría previa: tiene su propio criterio, ortogonal).
 *
 * Fuente ÚNICA de evidencia resuelta: la salida de
 * TrazabilidadPresentacionC1Projection.proyectarTrazabilidadPresentacionC1
 * — nunca se duplica esa resolución (autoridad/activo/rechazado/no-resuelto/
 * contradicciones ya vienen calculadas ahí, por unidad).
 *
 * Los enlaces causales (inicioAMecanismo/mecanismoAResultado) se adjuntan
 * ÚNICAMENTE como topología (conjuntos de conceptoIds) — nunca como texto:
 * `contenidoVisibleEstructurado` de un ENLACE_CAUSAL es siempre null en la
 * presentación productiva (ver Paso 2A) y este módulo nunca inventa uno.
 */

const { ROLES_TRIADA_DIFERENCIA } = require('../schemas/CriterioDiferenciaTransformacionalDestino');

const CLAVE_ENLACE = Object.freeze({
  INICIO_A_MECANISMO: 'inicioAMecanismo',
  MECANISMO_A_RESULTADO: 'mecanismoAResultado',
});

function congelar(valor) {
  return Object.freeze({ ...valor });
}

function bloqueada({
  afirmacionId, presentacionId, revisionEvaluada, razonBloqueo, rolBloqueante = null,
}) {
  return congelar({
    bloqueada: true, razonBloqueo, rolBloqueante, afirmacionId, presentacionId, revisionEvaluada,
  });
}

/**
 * ¿Este soporte, tal como lo resolvió la trazabilidad, tiene autoridad
 * válida? Mismo criterio que los selectores de Proporcionalidad/
 * Especificidad: EXCLUSIVAMENTE autoridad==='experto', activo, no rechazado.
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
 * Verifica el estado estructural de una unidad de la tríada (texto,
 * soportes, autoridad, contradicciones) — devuelve una razón de bloqueo o
 * null si está en condiciones de evaluarse.
 */
function razonBloqueoDeUnidad(unidad) {
  if (typeof unidad.textoVisibleExacto !== 'string' || !unidad.textoVisibleExacto.trim()) {
    return 'UNIDAD_SIN_TEXTO_VISIBLE';
  }
  const conceptoIds = (unidad.soportesDeclarados && unidad.soportesDeclarados.conceptoIds) || [];
  if (conceptoIds.length === 0) return 'UNIDAD_SIN_SOPORTES';
  if (unidad.conceptosNoResueltos.length > 0) return 'SOPORTE_NO_RESUELTO';
  if (unidad.conceptosInactivos.length > 0) return 'SOPORTE_INACTIVO';
  if (unidad.conceptosRechazados.length > 0) return 'SOPORTE_RECHAZADO';
  if (soporteSinAutoridadValida(unidad) || unidad.conceptosAutorizados.length !== conceptoIds.length) {
    return 'SOPORTE_SIN_AUTORIDAD_VALIDA';
  }
  if (unidad.contradiccionesCandidatas.length > 0) return 'CONTRADICCION_ACTIVA_VINCULADA';
  return null;
}

function empaquetarUnidad(unidad) {
  return congelar({
    rol: unidad.rol,
    unidadLocalId: unidad.unidadLocalId,
    texto: unidad.textoVisibleExacto,
  });
}

function empaquetarSoportes(unidad) {
  return congelar({
    conceptoIds: Object.freeze([...unidad.soportesDeclarados.conceptoIds]),
    conceptosAutorizados: Object.freeze(unidad.conceptosAutorizados.map(c => congelar({ id: c.id, descripcion: c.descripcion }))),
  });
}

/**
 * Selecciona la tríada INICIO/MECANISMO/RESULTADO de una presentación ya
 * trazada, más la topología de sus dos enlaces causales adyacentes. Nunca
 * produce cuatro resultados — produce UNA selección compuesta, bloqueada
 * (con razón cerrada) o lista para evaluar.
 *
 * @param {object} params
 * @param {object} params.trazabilidad — salida EXACTA de
 *   proyectarTrazabilidadPresentacionC1({uow, sesionId, afirmacionId, presentacionId}).
 * @returns {object} selección compuesta.
 */
function seleccionarDiferenciaTransformacionalDestino({ trazabilidad } = {}) {
  if (!trazabilidad || typeof trazabilidad !== 'object' || !Array.isArray(trazabilidad.unidades)) {
    throw new Error('SELECCION_DIFERENCIA_TRAZABILIDAD_INVALIDA');
  }
  const {
    afirmacionId, presentacionId, afirmacionVersion: revisionEvaluada, esCabezaVigente,
  } = trazabilidad;
  const base = { afirmacionId, presentacionId, revisionEvaluada };

  const porRol = {};
  let hayDuplicada = false;
  trazabilidad.unidades.filter(u => u.tipo === 'CONSTITUYENTE' && ROLES_TRIADA_DIFERENCIA.includes(u.rol)).forEach(unidad => {
    if (Object.prototype.hasOwnProperty.call(porRol, unidad.rol)) hayDuplicada = true;
    else porRol[unidad.rol] = unidad;
  });
  if (hayDuplicada) return bloqueada({ ...base, razonBloqueo: 'UNIDAD_DUPLICADA' });
  if (!ROLES_TRIADA_DIFERENCIA.every(rol => porRol[rol])) {
    return bloqueada({ ...base, razonBloqueo: 'PRESENTACION_INCOMPLETA' });
  }
  if (!esCabezaVigente) return bloqueada({ ...base, razonBloqueo: 'REVISION_YA_NO_VIGENTE' });

  for (const rol of ROLES_TRIADA_DIFERENCIA) {
    const razon = razonBloqueoDeUnidad(porRol[rol]);
    if (razon) return bloqueada({ ...base, razonBloqueo: razon, rolBloqueante: rol });
  }

  const enlaceInicioAMecanismo = trazabilidad.unidades.find(u => u.tipo === 'ENLACE_CAUSAL' && u.rol === 'INICIO_A_MECANISMO');
  const enlaceMecanismoAResultado = trazabilidad.unidades.find(u => u.tipo === 'ENLACE_CAUSAL' && u.rol === 'MECANISMO_A_RESULTADO');
  const idsEnlace = enlace => new Set((enlace && enlace.soportesDeclarados && enlace.soportesDeclarados.conceptoIds) || []);
  const idsEnlaceIM = idsEnlace(enlaceInicioAMecanismo);
  const idsEnlaceMR = idsEnlace(enlaceMecanismoAResultado);
  if (!enlaceInicioAMecanismo || idsEnlaceIM.size === 0) {
    return bloqueada({ ...base, razonBloqueo: 'ENLACE_INICIO_A_MECANISMO_AUSENTE' });
  }
  if (!enlaceMecanismoAResultado || idsEnlaceMR.size === 0) {
    return bloqueada({ ...base, razonBloqueo: 'ENLACE_MECANISMO_A_RESULTADO_AUSENTE' });
  }

  const idsInicio = new Set(porRol.INICIO.soportesDeclarados.conceptoIds);
  const idsMecanismo = new Set(porRol.MECANISMO.soportesDeclarados.conceptoIds);
  const idsResultado = new Set(porRol.RESULTADO.soportesDeclarados.conceptoIds);
  const imCorresponde = [...idsInicio].some(id => idsEnlaceIM.has(id)) && [...idsMecanismo].some(id => idsEnlaceIM.has(id));
  const mrCorresponde = [...idsMecanismo].some(id => idsEnlaceMR.has(id)) && [...idsResultado].some(id => idsEnlaceMR.has(id));
  if (!imCorresponde || !mrCorresponde) {
    return bloqueada({ ...base, razonBloqueo: 'ENLACE_NO_CORRESPONDE_A_CONCEPTOS_ESPERADOS' });
  }

  return congelar({
    bloqueada: false,
    razonBloqueo: null,
    rolBloqueante: null,
    afirmacionId,
    presentacionId,
    revisionEvaluada,
    inicio: empaquetarUnidad(porRol.INICIO),
    mecanismo: empaquetarUnidad(porRol.MECANISMO),
    resultado: empaquetarUnidad(porRol.RESULTADO),
    soportesInicio: empaquetarSoportes(porRol.INICIO),
    soportesMecanismo: empaquetarSoportes(porRol.MECANISMO),
    soportesResultado: empaquetarSoportes(porRol.RESULTADO),
    enlacesTopologia: congelar({
      [CLAVE_ENLACE.INICIO_A_MECANISMO]: Object.freeze([...idsEnlaceIM]),
      [CLAVE_ENLACE.MECANISMO_A_RESULTADO]: Object.freeze([...idsEnlaceMR]),
    }),
  });
}

module.exports = {
  seleccionarDiferenciaTransformacionalDestino,
};
