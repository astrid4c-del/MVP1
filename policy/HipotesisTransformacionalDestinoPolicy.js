'use strict';

/**
 * Fachada pública de HipotesisTransformacionalDestino.
 *
 * Capacidad aislada: representa una propuesta explícita de relación entre
 * los cuatro roles causales de 'destino' (inicio/mecanismo/resultado/
 * observabilidad), con identidad, vigencia y autoridad propias — nunca
 * modifica la autoridad de los conceptos que referencia, nunca escribe en
 * el grafo, nunca decide causalidad leyendo texto. No conecta persistencia,
 * autorización, materialización, proyección, compositor ni Writer — esas
 * integraciones pertenecen a un incremento posterior.
 */

const runtime = require('../domain/_HipotesisTransformacionalDestinoProcessLocal');

module.exports = {
  crearHipotesisTransformacionalDestino: runtime.crearHipotesisTransformacionalDestinoInterna,
  confirmarHipotesisTransformacionalDestino: runtime.confirmarHipotesisTransformacionalDestinoInterna,
  rechazarHipotesisTransformacionalDestino: runtime.rechazarHipotesisTransformacionalDestinoInterna,
  obsoletarHipotesisPorCambioDeConcepto: runtime.obsoletarHipotesisPorCambioDeConceptoInterna,
  relacionProduceAutorizadaParaResultado: runtime.relacionProduceAutorizadaParaResultado,
};
