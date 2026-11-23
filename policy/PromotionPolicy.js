'use strict';
/**
 * PROMOTION POLICY
 * Decide si el resultado provisional de una etapa puede promoverse al Estado
 * canónico. commit() solo se llama después de que esta política lo autorice.
 *
 * Ref: Implementation Specification EPIC 06 (PromotionPolicy); P-01.
 *
 * Regla central: un estado provisional no puede volverse canónico si:
 *   1. El gate de salida de la etapa no fue aprobado (outcome !== 'approved').
 *   2. La postcondición del contrato no se satisface.
 *   3. Existe un error pendiente sin recuperar (_error).
 *
 * El OrchestratorService invoca evaluatePromotion() antes de commit().
 */

const { validateOutput }  = require('../contracts/ContractDTOs');
const { GATE_OUTCOMES }   = require('./GatePolicy');

const PROMOTION_STATUS = Object.freeze({
  APPROVED:  'approved',
  REJECTED:  'rejected',
});

function promotionResult(status, razon, detalles = []) {
  return Object.freeze({ status, razon, detalles });
}

const PromotionPolicy = {

  /**
   * Evalúa si el resultado de una etapa puede promoverse al Estado canónico.
   * @param {string}     etapa
   * @param {object}     state      — CognitiveState con el resultado provisional
   * @param {GateResult} gateResult — resultado del gate de salida de la etapa
   * @returns {PromotionResult}
   */
  evaluatePromotion(etapa, state, gateResult) {
    const detalles = [];

    // 1. Estado con error no puede promoverse
    if (state._error) {
      return promotionResult(PROMOTION_STATUS.REJECTED,
        `Estado tiene _error pendiente sin recuperar: ${state._error}`);
    }

    // 2. Gate de salida debe estar aprobado (approved o warning son ok; rejected no)
    if (gateResult && gateResult.outcome === GATE_OUTCOMES.REJECTED && gateResult.bloqueante) {
      return promotionResult(PROMOTION_STATUS.REJECTED,
        `Gate de salida rechazado para etapa '${etapa}': ${gateResult.razon}`,
        gateResult.detalles || []);
    }

    // 3. DTO de salida debe ser válido
    const outputValidation = validateOutput(etapa, state);
    if (!outputValidation.valid) {
      return promotionResult(PROMOTION_STATUS.REJECTED,
        `Postcondición de salida no cumplida para '${etapa}'`,
        outputValidation.errors);
    }

    // 4. Warnings se registran pero no bloquean la promoción
    if (gateResult && gateResult.outcome === GATE_OUTCOMES.WARNING) {
      detalles.push(`Advertencia: ${gateResult.razon}`);
    }

    return promotionResult(PROMOTION_STATUS.APPROVED,
      `Etapa '${etapa}' aprobada para promoción al Estado canónico`,
      detalles);
  },

  PROMOTION_STATUS,
};

module.exports = { PromotionPolicy, PROMOTION_STATUS };
