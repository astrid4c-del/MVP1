'use strict';

/**
 * EVENT REPOSITORY
 * Almacena Eventos Cognitivos de forma append-only (nunca sobrescribe).
 * Permite consultar por sesión, tipo, correlationId y rango de tiempo.
 * Ref: EPIC 04; Principio de Observabilidad (Doc 2); Principio de Trazabilidad (Doc 2).
 *
 * Esta implementación usa almacenamiento en memoria (para Sprint 1).
 * La interfaz es la misma que usará la implementación con BD en producción.
 * La implementación podrá cambiar; la responsabilidad permanecerá constante.
 * Ref: Arquitectura Técnica (Doc 5) — Principio de Independencia Tecnológica.
 */

const { validateEvent, VALID_EVENT_TYPES } = require('../schemas/Event');

class EventRepository {
  constructor() {
    // Almacenamiento: Map<sesionId, Event[]>
    this._store = new Map();
    // Índice global por tipo para consultas cruzadas
    this._byType = new Map();
    VALID_EVENT_TYPES.forEach(t => this._byType.set(t, []));
  }

  /**
   * Persiste un evento. Append-only: nunca modifica eventos existentes.
   * @param {object} event — objeto Event del schema
   * @throws {Error} si el evento es inválido
   */
  save(event) {
    const { valid, errors } = validateEvent(event);
    if (!valid)
      throw new Error(`EventRepository.save: evento inválido — ${errors.join('; ')}`);

    // Por sesión
    if (!this._store.has(event.sesionId))
      this._store.set(event.sesionId, []);
    this._store.get(event.sesionId).push(Object.freeze({ ...event }));

    // Por tipo
    if (!this._byType.has(event.tipo))
      this._byType.set(event.tipo, []);
    this._byType.get(event.tipo).push(Object.freeze({ ...event }));

    return event;
  }

  /**
   * Devuelve todos los eventos de una sesión, en orden cronológico.
   */
  findBySesion(sesionId) {
    return this._store.get(sesionId) || [];
  }

  /**
   * Devuelve eventos de una sesión filtrados por tipo.
   */
  findBySesionAndType(sesionId, tipo) {
    return (this._store.get(sesionId) || []).filter(e => e.tipo === tipo);
  }

  /**
   * Devuelve todos los eventos de un tipo dado (a través de sesiones).
   */
  findByType(tipo) {
    return this._byType.get(tipo) || [];
  }

  /**
   * Devuelve eventos de una sesión agrupados por correlationId.
   * Útil para reconstruir operaciones compuestas.
   */
  findByCorrelation(sesionId, correlationId) {
    return (this._store.get(sesionId) || [])
      .filter(e => e.correlationId === correlationId);
  }

  /**
   * Devuelve el último evento de un tipo en una sesión.
   */
  lastOfType(sesionId, tipo) {
    const events = this.findBySesionAndType(sesionId, tipo);
    return events.length > 0 ? events[events.length - 1] : null;
  }

  /**
   * Número total de eventos almacenados.
   */
  count() {
    let total = 0;
    this._store.forEach(arr => { total += arr.length; });
    return total;
  }

  /**
   * Número de eventos de una sesión.
   */
  countBySesion(sesionId) {
    return (this._store.get(sesionId) || []).length;
  }
}

module.exports = { EventRepository };
