'use strict';

/**
 * Dominio de sucesión transformacional C1-4.
 *
 * Construye una propuesta C1-1 nueva y una procedencia de corrección
 * separada. No autoriza, invalida, supera ni reemplaza la versión anterior.
 */

const runtime = require('./_AfirmacionTransformacionalDestinoProcessLocal');

function crearPropuestaSucesoraTransformacional(params = {}) {
  return runtime.crearPropuestaSucesoraTransformacionalInterna(params);
}

function obtenerProcedenciaCorreccionTransformacional(entidad) {
  return runtime.obtenerProcedenciaCorreccionTransformacionalInterna(entidad);
}

module.exports = {
  crearPropuestaSucesoraTransformacional,
  obtenerProcedenciaCorreccionTransformacional,
};
