'use strict';

/**
 * EVENT BUS
 * Conecta el CognitiveStateService con el EventRepository.
 * Implementa la interfaz { emit(event) } que el servicio requiere.
 * Soporta múltiples listeners para extensibilidad.
 * Ref: EPIC 04; Arquitectura Técnica (Doc 5) — Parte III, Eventos Cognitivos.
 */

const { EventRepository } = require('./EventRepository');

class EventBus {
  /**
   * @param {EventRepository} repository
   */
  constructor(repository) {
    // Acepta cualquier objeto que implemente la interfaz de EventRepository:
    // { save(event), findBySesion(sesionId) }
    // Esto permite SqliteEventRepository o cualquier implementación futura.
    if (!repository || typeof repository.save !== 'function' || typeof repository.findBySesion !== 'function')
      throw new Error('EventBus: repository debe implementar { save, findBySesion }');
    this._repo      = repository;
    this._listeners = []; // fn(event) → void
  }

  /**
   * Emite un evento: lo persiste y notifica a los listeners.
   * @param {object} event — objeto Event del schema
   */
  emit(event) {
    this._repo.save(event);
    this._listeners.forEach(fn => {
      try { fn(event); }
      catch (e) { /* listeners nunca bloquean el pipeline */ }
    });
  }

  /**
   * Registra un listener para observabilidad / debugging.
   * @param {function} fn — recibe el evento emitido
   */
  addListener(fn) {
    if (typeof fn !== 'function')
      throw new Error('EventBus.addListener: fn debe ser función');
    this._listeners.push(fn);
  }

  /**
   * Acceso al repositorio para consultas.
   */
  get repository() {
    return this._repo;
  }
}

module.exports = { EventBus };
