'use strict';

const runtime = require('./_AfirmacionTransformacionalDestinoProcessLocal');

module.exports = {
  crearPresentacionTransformacionalEstructurada:
    runtime.crearPresentacionTransformacionalEstructurada,
  // circulomejora006_reporte01 (Paso 1 — convergencia Hipótesis→Afirmación):
  // forma simple de presentación durable (round-trip), ya existente en el
  // runtime desde antes de este incremento — solo se amplía la fachada
  // pública para exponerla, sin tocar el runtime.
  crearPresentacionRoundTripTransformacional:
    runtime.crearPresentacionRoundTripTransformacional,
};
