'use strict';

/**
 * Frontera estable del ciclo inicial de AfirmacionTransformacionalDestino.
 *
 * Su identidad privada acredita únicamente INTEGRIDAD_PROCESS_LOCAL:
 * la instancia fue creada/materializada por esta frontera durante esta
 * ejecución. No autentica conocimiento, turnos, sesiones ni persistencia.
 */

const runtime = require('./_AfirmacionTransformacionalDestinoProcessLocal');

module.exports = {
  crearPropuestaTransformacional: runtime.crearPropuestaTransformacional,
  materializarPropuestaTransformacional: runtime.materializarPropuestaTransformacional,
};
