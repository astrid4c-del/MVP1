'use strict';

/**
 * circulomejora006_act07c — selección determinista de la unidad de
 * observabilidad. Función pura: no invoca al evaluador, no invoca al
 * validador, no conoce LLM ni I/O. La unidad se decide exclusivamente por
 * `modoObservabilidad` — nunca por heurística sobre contenido.
 *
 *   CONSTITUYENTE_SEPARADO → constituyentes.observabilidad
 *   INTEGRADA_EN_RESULTADO → constituyentes.resultado
 *
 * El evaluador semántico nunca recibe `afirmacion` completa: solo recibe lo
 * que esta función devuelve.
 */

function esSoporteValido(soporte) {
  return !!soporte && typeof soporte === 'object'
    && Array.isArray(soporte.conceptoIds) && Array.isArray(soporte.referenciasLiterales);
}

function seleccionarUnidadObservabilidad(afirmacion) {
  if (!afirmacion || typeof afirmacion !== 'object') {
    throw new Error('SELECCION_OBSERVABILIDAD_AFIRMACION_INVALIDA');
  }
  const modo = afirmacion.modoObservabilidad;
  if (modo !== 'CONSTITUYENTE_SEPARADO' && modo !== 'INTEGRADA_EN_RESULTADO') {
    throw new Error('SELECCION_OBSERVABILIDAD_MODO_INCONSISTENTE');
  }
  const constituyentes = afirmacion.constituyentes;
  const tipo = modo === 'CONSTITUYENTE_SEPARADO' ? 'OBSERVABILIDAD' : 'RESULTADO';
  const soporte = modo === 'CONSTITUYENTE_SEPARADO'
    ? constituyentes && constituyentes.observabilidad
    : constituyentes && constituyentes.resultado;
  if (!esSoporteValido(soporte)) {
    throw new Error('SELECCION_OBSERVABILIDAD_UNIDAD_INEXISTENTE');
  }
  return Object.freeze({
    tipo,
    soporte: Object.freeze({
      conceptoIds: Object.freeze([...soporte.conceptoIds]),
      referenciasLiterales: Object.freeze(soporte.referenciasLiterales.map(referencia => Object.freeze({ ...referencia }))),
    }),
  });
}

module.exports = { seleccionarUnidadObservabilidad };
