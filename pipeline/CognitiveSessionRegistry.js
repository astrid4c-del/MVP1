'use strict';

/**
 * COGNITIVE SESSION REGISTRY
 * Modela explícitamente el ciclo de vida de una "Sesión Cognitiva" en el
 * servidor: cada sessionId obtiene su propio bundle de ejecución en memoria
 * (OrchestratorService, BudgetPolicy, LLMService y el PipelineApplicationService
 * que los envuelve), creado perezosamente la primera vez que esa sesión se
 * toca y cacheado para las llamadas siguientes.
 *
 * Motivación (autopsia Smoke Test #2): antes de este registry, un único
 * OrchestratorService (y su `_log` interno) se construía una sola vez al
 * arrancar el servidor y se compartía entre TODAS las sesiones del proceso.
 * `_log` nunca se reseteaba, así que una etapa completada por la Sesión A
 * contaminaba la evaluación HITL de la misma etapa en la Sesión B. El registry
 * elimina esa clase de bug por construcción: no hay ningún estado de ejecución
 * compartido entre sesiones — cada una tiene su propio Orchestrator/Budget/LLM
 * desde el primer request.
 *
 * CognitiveStateService (y sus repositorios SQLite) NO se gestionan aquí:
 * ya son correctamente compartidos, porque toda su lectura/escritura pasa por
 * `sessionId` como parámetro explícito hacia la base de datos — nunca guardan
 * estado de una sesión en memoria de instancia.
 *
 * Nota de diseño: los bundles se acumulan en memoria por la vida del proceso
 * (no hay expiración/LRU). Aceptable para el estado actual del proyecto —
 * igual que los eventos SQLite, que tampoco se purgan — pero es una limitación
 * conocida si el servidor corre mucho tiempo con muchas sesiones distintas.
 */
class CognitiveSessionRegistry {
  /**
   * @param {(sessionId: string) => object} bundleFactory — construye un bundle
   *   fresco de dependencias para una sesión nueva. No debe tener efectos
   *   secundarios sobre otras sesiones.
   */
  constructor(bundleFactory) {
    if (typeof bundleFactory !== 'function')
      throw new Error('CognitiveSessionRegistry: bundleFactory debe ser una función');
    this._bundleFactory = bundleFactory;
    this._bundles = new Map();
  }

  /**
   * Devuelve el bundle de la sesión, creándolo si es la primera vez que se ve
   * este sessionId en este proceso.
   */
  get(sessionId) {
    if (!this._bundles.has(sessionId)) {
      this._bundles.set(sessionId, this._bundleFactory(sessionId));
    }
    return this._bundles.get(sessionId);
  }

  has(sessionId) {
    return this._bundles.has(sessionId);
  }

  get size() {
    return this._bundles.size;
  }
}

module.exports = { CognitiveSessionRegistry };
