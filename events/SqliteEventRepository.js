'use strict';

/**
 * SQLITE EVENT REPOSITORY
 * Persistencia durable de Eventos Cognitivos.
 * Sobrevive al reinicio del proceso. Append-only permanente.
 *
 * Misma interfaz que EventRepository (en memoria):
 *   save(event), findBySesion, findBySesionAndType, findByType,
 *   findByCorrelation, lastOfType, count, countBySesion
 *
 * Ref: EPIC 04; Principio de Trazabilidad (Doc 2).
 */

const Database = require('better-sqlite3');
const { validateEvent, VALID_EVENT_TYPES } = require('../schemas/Event');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cognitive_events (
    id              TEXT    PRIMARY KEY,
    tipo            TEXT    NOT NULL,
    sesion_id       TEXT    NOT NULL,
    version_id      TEXT,
    correlation_id  TEXT,
    turno_id        TEXT,
    payload_json    TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_sesion
    ON cognitive_events(sesion_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_tipo
    ON cognitive_events(tipo);
  CREATE INDEX IF NOT EXISTS idx_events_correlation
    ON cognitive_events(sesion_id, correlation_id);
`;

/**
 * Migración aditiva mínima: una base ya creada antes del Incremento 2 no
 * tiene la columna turno_id (CREATE TABLE IF NOT EXISTS no la agrega a una
 * tabla que ya existe). Se agrega aquí si falta, sin tocar filas existentes.
 * El índice sobre turno_id se crea DESPUÉS de garantizar la columna — si
 * viviera en SCHEMA_SQL (que se ejecuta antes que esta función), CREATE
 * INDEX fallaría en una base legado donde la columna todavía no existe.
 */
function asegurarColumnaTurnoId(db) {
  const columnas = db.prepare(`PRAGMA table_info(cognitive_events)`).all();
  const yaExiste = columnas.some(c => c.name === 'turno_id');
  if (!yaExiste) db.exec(`ALTER TABLE cognitive_events ADD COLUMN turno_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_turno ON cognitive_events(sesion_id, turno_id)`);
}

class SqliteEventRepository {
  /**
   * @param {string|Database} dbPathOrConnection — ruta al mismo archivo que
   *   SqliteStateRepository (abre y posee su propia conexión, comportamiento
   *   histórico) o una conexión better-sqlite3 ya abierta (no la posee,
   *   nunca la cierra — para uso vía CognitiveUnitOfWork).
   */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection)
      throw new Error('SqliteEventRepository: dbPath o conexión son requeridos.');

    if (typeof dbPathOrConnection === 'string') {
      this._db = new Database(dbPathOrConnection);
      this._db.pragma('journal_mode = WAL');
      this._ownsConnection = true;
      this._dbPath = dbPathOrConnection;
    } else {
      this._db = dbPathOrConnection;
      this._ownsConnection = false;
      this._dbPath = dbPathOrConnection.name;
    }
    this._db.exec(SCHEMA_SQL);
    asegurarColumnaTurnoId(this._db);

    this._stmtInsert = this._db.prepare(`
      INSERT OR IGNORE INTO cognitive_events
        (id, tipo, sesion_id, version_id, correlation_id, turno_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtBySesion = this._db.prepare(`
      SELECT * FROM cognitive_events WHERE sesion_id = ? ORDER BY created_at ASC
    `);
    this._stmtBySesionAndType = this._db.prepare(`
      SELECT * FROM cognitive_events
       WHERE sesion_id = ? AND tipo = ? ORDER BY created_at ASC
    `);
    this._stmtByType = this._db.prepare(`
      SELECT * FROM cognitive_events WHERE tipo = ? ORDER BY created_at ASC
    `);
    this._stmtByCorrelation = this._db.prepare(`
      SELECT * FROM cognitive_events
       WHERE sesion_id = ? AND correlation_id = ? ORDER BY created_at ASC
    `);
    this._stmtLastOfType = this._db.prepare(`
      SELECT * FROM cognitive_events
       WHERE sesion_id = ? AND tipo = ? ORDER BY created_at DESC LIMIT 1
    `);
    this._stmtByTurnoId = this._db.prepare(`
      SELECT * FROM cognitive_events
       WHERE sesion_id = ? AND turno_id = ? ORDER BY created_at ASC
    `);
    this._stmtCount = this._db.prepare(`
      SELECT COUNT(*) AS n FROM cognitive_events
    `);
    this._stmtCountBySesion = this._db.prepare(`
      SELECT COUNT(*) AS n FROM cognitive_events WHERE sesion_id = ?
    `);
  }

  save(event) {
    const { valid, errors } = validateEvent(event);
    if (!valid)
      throw new Error(`SqliteEventRepository.save: evento inválido — ${errors.join('; ')}`);

    this._stmtInsert.run(
      event.id,
      event.tipo,
      event.sesionId,
      event.versionId   || null,
      event.correlationId || null,
      event.turnoId     || null,
      JSON.stringify(event.payload || {}),
      event.creadoEn
    );
    return event;
  }

  findBySesion(sesionId) {
    return this._stmtBySesion.all(sesionId).map(r => this._hydrate(r));
  }

  findBySesionAndType(sesionId, tipo) {
    return this._stmtBySesionAndType.all(sesionId, tipo).map(r => this._hydrate(r));
  }

  findByType(tipo) {
    return this._stmtByType.all(tipo).map(r => this._hydrate(r));
  }

  findByCorrelation(sesionId, correlationId) {
    return this._stmtByCorrelation.all(sesionId, correlationId).map(r => this._hydrate(r));
  }

  lastOfType(sesionId, tipo) {
    const row = this._stmtLastOfType.get(sesionId, tipo);
    return row ? this._hydrate(row) : null;
  }

  /**
   * Todos los eventos vinculados a un Turno cognitivo específico, en orden
   * cronológico. Base de la reconstrucción idempotente (Incremento 3): dado
   * un Turno ya persistido, sus eventos asociados alcanzan para reconstruir
   * el resultado de esa interacción sin leer el estado actual de la sesión.
   */
  findByTurnoId(sesionId, turnoId) {
    return this._stmtByTurnoId.all(sesionId, turnoId).map(r => this._hydrate(r));
  }

  count()               { return this._stmtCount.get().n; }
  countBySesion(sesionId) { return this._stmtCountBySesion.get(sesionId).n; }

  /** Cierra la conexión solo si esta instancia la abrió (dbPath string). */
  close() {
    if (this._ownsConnection) this._db.close();
  }
  get dbPath() { return this._dbPath; }

  _hydrate(row) {
    return Object.freeze({
      id:            row.id,
      tipo:          row.tipo,
      sesionId:      row.sesion_id,
      versionId:     row.version_id   || null,
      correlationId: row.correlation_id || null,
      turnoId:       row.turno_id || null,
      payload:       Object.freeze(JSON.parse(row.payload_json || '{}')),
      creadoEn:      row.created_at,
    });
  }
}

module.exports = { SqliteEventRepository };
