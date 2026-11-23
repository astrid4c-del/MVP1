'use strict';

/**
 * Dominio de presentación determinista del round-trip transformacional.
 *
 * No redacta ni reformula: presenta exactamente formulacionPropuesta y
 * conserva únicamente integridad process-local por identidad.
 *
 * C5-vertical-1 (sucesión normativa tras reformulación) —
 * registrarEvaluacionRoundTripTransformacional se expone aquí sin cambio de
 * comportamiento: ya aceptaba `clasificacion` como parámetro directo (nunca
 * la deriva con una gramática de regex propia — esa gramática vive
 * exclusivamente en RoundTripTransformacionalPolicy.evaluarRoundTripTransformacional,
 * que sigue intacta). Esta exposición permite que un caller con una
 * clasificación YA REAL (p.ej. la confirmación de una reformulación
 * preautorización) registre el round-trip sin re-parsear texto con una
 * segunda gramática — mismo principio ya aplicado a
 * evaluarVeredictoTransformacionalDesdeProtocolo.
 */

const runtime = require('./_AfirmacionTransformacionalDestinoProcessLocal');

module.exports = {
  crearPresentacionRoundTripTransformacional: runtime.crearPresentacionRoundTripTransformacional,
  registrarEvaluacionRoundTripTransformacional: runtime.registrarEvaluacionRoundTripTransformacional,
};
