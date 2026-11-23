'use strict';

/**
 * SQLITE STATE REPOSITORY
 * Persistencia durable del Estado Cognitivo.
 * Sobrevive al reinicio del proceso — los datos viven en un archivo .db en disco.
 *
 * Misma interfaz que StateRepository (en memoria):
 *   save(sesionId, json), load(sesionId) → json|null
 *   loadVersion, getHistory, countVersions, canRestore, listSessions, countSessions
 *
 * Tecnología: better-sqlite3 (API sincrónica — sin callbacks, sin Promises).
 * El archivo de DB se especifica en el constructor; el directorio debe existir.
 *
 * Ref: Principio de Independencia Tecnológica (Doc 5) — la implementación cambia,
 *      la responsabilidad permanece. CognitiveStateService no sabe si usa esta
 *      clase o StateRepository (en memoria).
 */

const Database = require('better-sqlite3');
const { deserializeState, isConsistentState } = require('../schemas/CognitiveState');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS state_versions (
    sesion_id   TEXT    NOT NULL,
    version_id  TEXT    NOT NULL,
    json_data   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','utc')),
    PRIMARY KEY (sesion_id, version_id)
  );

  CREATE TABLE IF NOT EXISTS state_current (
    sesion_id   TEXT    PRIMARY KEY,
    version_id  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','utc'))
  );

  CREATE INDEX IF NOT EXISTS idx_versions_sesion
    ON state_versions(sesion_id, created_at);
`;

class SqliteStateRepository {
  /**
   * @param {string|Database} dbPathOrConnection — ruta al archivo SQLite
   *   (abre y posee su propia conexión, comportamiento histórico) o una
   *   conexión better-sqlite3 ya abierta (no la posee, nunca la cierra —
   *   para uso vía CognitiveUnitOfWork).
   */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection)
      throw new Error('SqliteStateRepository: dbPath o conexión son requeridos.');

    if (typeof dbPathOrConnection === 'string') {
      this._db = new Database(dbPathOrConnection);
      this._db.pragma('journal_mode = WAL');   // escrituras concurrentes más seguras
      this._db.pragma('foreign_keys = ON');
      this._ownsConnection = true;
      this._dbPath = dbPathOrConnection;
    } else {
      this._db = dbPathOrConnection;
      this._ownsConnection = false;
      this._dbPath = dbPathOrConnection.name;
    }
    this._db.exec(SCHEMA_SQL);

    // Prepared statements (compilados una vez, ejecutados muchas veces)
    this._stmtInsertVersion = this._db.prepare(`
      INSERT OR IGNORE INTO state_versions (sesion_id, version_id, json_data, created_at)
      VALUES (?, ?, ?, datetime('now','utc'))
    `);
    this._stmtUpsertCurrent = this._db.prepare(`
      INSERT INTO state_current (sesion_id, version_id, updated_at)
      VALUES (?, ?, datetime('now','utc'))
      ON CONFLICT(sesion_id) DO UPDATE SET
        version_id = excluded.version_id,
        updated_at = excluded.updated_at
    `);
    this._stmtGetCurrent = this._db.prepare(`
      SELECT sv.json_data
        FROM state_current sc
        JOIN state_versions sv
          ON sv.sesion_id = sc.sesion_id AND sv.version_id = sc.version_id
       WHERE sc.sesion_id = ?
    `);
    this._stmtGetVersion = this._db.prepare(`
      SELECT json_data FROM state_versions
       WHERE sesion_id = ? AND version_id = ?
    `);
    this._stmtGetHistory = this._db.prepare(`
      SELECT version_id FROM state_versions
       WHERE sesion_id = ?
       ORDER BY created_at ASC
    `);
    this._stmtListSessions = this._db.prepare(`
      SELECT DISTINCT sesion_id FROM state_current ORDER BY updated_at DESC
    `);
    this._stmtCountSessions = this._db.prepare(`
      SELECT COUNT(*) AS n FROM state_current
    `);

    // Transacción atómica: insertar versión + actualizar current
    this._txSave = this._db.transaction((sesionId, versionId, json) => {
      this._stmtInsertVersion.run(sesionId, versionId, json);
      this._stmtUpsertCurrent.run(sesionId, versionId);
    });
  }

  /**
   * Persiste el estado. Append-only por versión (INSERT OR IGNORE).
   * Actualiza el puntero current a la nueva versión.
   */
  save(sesionId, json) {
    if (!sesionId || typeof sesionId !== 'string')
      throw new Error('SqliteStateRepository.save: sesionId es requerido.');
    if (!json || typeof json !== 'string')
      throw new Error('SqliteStateRepository.save: json es requerido.');

    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error(`SqliteStateRepository.save: JSON inválido — ${e.message}`); }

    if (!parsed.versionId)
      throw new Error('SqliteStateRepository.save: el estado no tiene versionId.');

    this._txSave(sesionId, parsed.versionId, json);
  }

  /** Carga el estado más reciente. @returns {string|null} */
  load(sesionId) {
    const row = this._stmtGetCurrent.get(sesionId);
    return row ? row.json_data : null;
  }

  /** Carga una versión específica. @returns {string|null} */
  loadVersion(sesionId, versionId) {
    const row = this._stmtGetVersion.get(sesionId, versionId);
    return row ? row.json_data : null;
  }

  /** Historial de versionIds en orden cronológico. */
  getHistory(sesionId) {
    return this._stmtGetHistory.all(sesionId).map(r => r.version_id);
  }

  countVersions(sesionId) { return this.getHistory(sesionId).length; }

  canRestore(sesionId) {
    const json = this.load(sesionId);
    if (!json) return false;
    try { return isConsistentState(deserializeState(json)); }
    catch { return false; }
  }

  listSessions() {
    return this._stmtListSessions.all().map(r => r.sesion_id);
  }

  countSessions() {
    return this._stmtCountSessions.get().n;
  }

  /** Cierra la conexión solo si esta instancia la abrió (dbPath string). */
  close() {
    if (this._ownsConnection) this._db.close();
  }

  get dbPath() { return this._dbPath; }
}

module.exports = { SqliteStateRepository };
