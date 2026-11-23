'use strict';

/**
 * DOWNSTREAM TRIGGER POLICY
 * Autoridad de aplicación para la transición "conversación cognitiva
 * completada → pipeline downstream solicitado" (Incremento 7d).
 *
 * Pura: no persiste, no ejecuta nada externo, no conoce SQLite ni HTTP.
 * InteraccionCognitivaWriter invoca esta función DENTRO de su propia
 * transacción y aplica el veredicto — la decisión y el registro durable de
 * que el downstream fue solicitado quedan así atómicos con la aprobación
 * del Gate que cierra DAR VIDA, sin que este archivo sepa nada de
 * transacciones. Deliberadamente separada de GatePolicy (decide sobre una
 * gramática) y de SlotSynthesisPolicy (decide sobre un slot): esta decide
 * sobre el ciclo de vida de la CONVERSACIÓN completa.
 */

/**
 * @param {object} params
 * @param {string}  params.gramaticaActivaAlInicio — gramática que este turno confirmó
 * @param {boolean} params.gateAprobado            — si el Gate aprobó esa gramática en este turno
 * @param {string|null} params.gramaticaSiguiente  — gramática siguiente ya decidida por decidirInteraccion (null tras darvida)
 * @param {string}  params.pipelineStatusActual     — state.pipelineStatus ANTES de este turno
 * @returns {boolean} true solo si corresponde solicitar el downstream ahora
 */
function debeSolicitarDownstream({ gramaticaActivaAlInicio, gateAprobado, gramaticaSiguiente, pipelineStatusActual }) {
  return (
    gramaticaActivaAlInicio === 'darvida' &&
    gateAprobado === true &&
    gramaticaSiguiente === null &&
    pipelineStatusActual === 'ninguno'
  );
}

module.exports = { debeSolicitarDownstream };
