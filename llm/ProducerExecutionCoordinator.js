'use strict';

const crypto = require('crypto');

const PRODUCER_FAILURE_CLASSES = Object.freeze({
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  PRODUCER_CAPABILITY_FAILURE: 'PRODUCER_CAPABILITY_FAILURE',
  CIRCULO_COGNITIVE_FAILURE: 'CIRCULO_COGNITIVE_FAILURE',
});

function stableTaskIdentity(contract) {
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

class ProducerExecutionCoordinator {
  // C007 — PRODUCER MULTI-EXECUTOR RECOVERY. `additionalExecutors` generalizes
  // the pool beyond primary+fallback: SAME_GOVERNED_TASK -> EXECUTOR_1 ->
  // bounded attempts -> EXECUTOR_2 -> bounded attempts -> EXECUTOR_3 -> ... ->
  // exhausted. Every existing call site (`{primary, fallback}`, no third
  // argument) is byte-for-byte unaffected: with additionalExecutors empty,
  // the pool is still exactly [primary, fallback] and the escalation cap
  // below reduces to the original "at most one escalation" — this is a
  // neutral extension, never a behavior change for Fidelity/Realizer or any
  // existing Producer configuration. The coordinator itself stays executor-
  // agnostic: no provider/model name is hardcoded here, only `call()`-shaped
  // objects handed in by the caller.
  constructor({ primary, fallback = null, additionalExecutors = [] } = {}) {
    if (!primary || typeof primary.call !== 'function') {
      throw new Error('ProducerExecutionCoordinator: primary debe implementar call().');
    }
    if (fallback && typeof fallback.call !== 'function') {
      throw new Error('ProducerExecutionCoordinator: fallback debe implementar call().');
    }
    for (const executor of additionalExecutors) {
      if (!executor || typeof executor.call !== 'function') {
        throw new Error('ProducerExecutionCoordinator: cada additionalExecutor debe implementar call().');
      }
    }
    this._executors = [primary, fallback, ...additionalExecutors].filter(Boolean);
  }

  beginTask(contract) {
    const frozenContract = deepFreeze(JSON.parse(JSON.stringify(contract)));
    const taskId = stableTaskIdentity(frozenContract);
    let index = 0;
    let escalations = 0;
    const maxEscalations = this._executors.length - 1;
    return {
      taskId,
      contract: frozenContract,
      current: () => this._executors[index],
      canEscalate: () => escalations < maxEscalations && index + 1 < this._executors.length,
      escalate: failureClass => {
        if (![PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE,
          PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE].includes(failureClass)) return false;
        if (escalations >= maxEscalations || index + 1 >= this._executors.length) return false;
        index += 1;
        escalations += 1;
        return true;
      },
      get escalationCount() { return escalations; },
    };
  }
}

module.exports = { ProducerExecutionCoordinator, PRODUCER_FAILURE_CLASSES, stableTaskIdentity };
