'use strict';

/**
 * Aplicador normativo estrecho de C1-2.
 *
 * Consume una capability opaca emitida por la política para una fotografía,
 * comando y registro exactos. No expone emisión ni certificación.
 */

const runtime = require('./_AfirmacionTransformacionalDestinoProcessLocal');

module.exports = {
  aplicarDecisionNormativaTransformacional: runtime.aplicarDecisionNormativaTransformacional,
};
