'use strict';

/**
 * STATE REPOSITORY
 * Persiste el Estado Cognitivo con historial completo de versiones.
 * Nunca sobrescribe. Siempre versiona.
 * Ref: EPIC 05; Principio de Persistencia (Doc 2); Principio de Recuperabilidad (Doc 2).
 *
 * Implementación en memoria para Sprint 1.
 * La interfaz es la misma que usará la implementación con Supabase en producción.
 * Cumple el contrato que CognitiveStateService requiere: { save(id, json), load(id) → json|null }.
 *
 * Adicionalmente expone:
 *   - getHistory(sesionId) → versiones ordenadas
 *   - loadVersion(sesionId, versionId) → snapshot de una versión específica
 *   - canRestore(sesionId) → boolean
 */

const { deserializeState, isConsistentState } = require('../schemas/CognitiveState');

class StateRepository {
  constructor() {
    // Map<sesionId, { current: json, versions: Map<versionId, json> }>
    this._store = new Map();
  }

  /**
   * Persiste el estado. Guarda la versión actual Y mantiene el historial.
   * Nunca elimina versiones anteriores.
   * @param {string} sesionId
   * @param {string} json — producido por serializeState()
   */
  save(sesionId, json) {
    if (!sesionId || typeof sesionId !== 'string')
      throw new Error(`StateRepository.save: sesionId es requerido.`);
    if (!json || typeof json !== 'string')
      throw new Error(`StateRepository.save: json es requerido.`);

    // Parsear para extraer versionId (validar que es JSON válido con versionId)
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error(`StateRepository.save: JSON inválido — ${e.message}`); }

    if (!parsed.versionId)
      throw new Error(`StateRepository.save: el estado no tiene versionId.`);

    if (!this._store.has(sesionId)) {
      this._store.set(sesionId, { current: null, versions: new Map() });
    }
    const entry = this._store.get(sesionId);

    // No sobrescribir una versión ya existente (append-only por versión)
    if (entry.versions.has(parsed.versionId)) {
      // Actualizar current pero no la versión histórica
      entry.current = json;
      return;
    }

    entry.versions.set(parsed.versionId, json);
    entry.current = json;
  }

  /**
   * Carga el estado más reciente de una sesión.
   * @returns {string|null} JSON del estado o null si no existe
   */
  load(sesionId) {
    const entry = this._store.get(sesionId);
    return entry?.current || null;
  }

  /**
   * Carga una versión específica del estado.
   * @returns {string|null}
   */
  loadVersion(sesionId, versionId) {
    const entry = this._store.get(sesionId);
    if (!entry) return null;
    return entry.versions.get(versionId) || null;
  }

  /**
   * Devuelve el historial de versiones de una sesión (versionIds en orden de inserción).
   */
  getHistory(sesionId) {
    const entry = this._store.get(sesionId);
    if (!entry) return [];
    return Array.from(entry.versions.keys());
  }

  /**
   * Número total de versiones almacenadas para una sesión.
   */
  countVersions(sesionId) {
    return this.getHistory(sesionId).length;
  }

  /**
   * Devuelve true si la sesión tiene al menos un estado persistido y consistente.
   */
  canRestore(sesionId) {
    const json = this.load(sesionId);
    if (!json) return false;
    try {
      const state = deserializeState(json);
      return isConsistentState(state);
    } catch {
      return false;
    }
  }

  /**
   * Lista todas las sesiones con estados persistidos.
   */
  listSessions() {
    return Array.from(this._store.keys());
  }

  /**
   * Número total de sesiones.
   */
  countSessions() {
    return this._store.size;
  }
}

module.exports = { StateRepository };
