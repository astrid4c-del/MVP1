'use strict';

/**
 * Política normativa estrecha de C1-4.
 *
 * Verifica que un round-trip legítimo produjo CORRECCION_SEMANTICA y emite
 * una capability process-local para crear una única propuesta sucesora.
 */

const runtime = require('../domain/_AfirmacionTransformacionalDestinoProcessLocal');

function prepararCorreccionTransformacional(params = {}) {
  return runtime.prepararCorreccionTransformacionalInterna(params);
}

module.exports = {
  prepararCorreccionTransformacional,
};
