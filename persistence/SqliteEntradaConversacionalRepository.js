'use strict';

/**
 * SQLITE ENTRADA CONVERSACIONAL REPOSITORY
 * DURABILIDAD_ENTRADA_CONVERSACIONAL_1 — persistencia durable de
 * EntradaConversacional: "el usuario dijo X", admitida ANTES de cualquier
 * operación falible/cognitiva/LLM (ver InteraccionCognitivaWriter).
 *
 * Nunca se borra. `mensajeUsuario`, `sesionId`, `turnoClienteId`, `turnoId`
 * y `expertoId` son inmutables una vez insertados (esa es la entrada misma:
 * un hecho). Lo único que esta clase actualiza tras el insert es
 * `estadoProcesamiento` y sus campos de causa — el estado DEL PROCESAMIENTO,
 * nunca de la entrada.
 *
 * UNIQUE (sesion_id, turno_cliente_id): misma base de idempotencia que
 * cognitive_turnos, aplicada un paso antes — turnoClienteId es obligatorio
 * en este camino (ver Turno/SqliteTurnoRepository, cuyo índice sigue siendo
 * parcial por compatibilidad con callers legado que no pasan por
 * InteraccionCognitivaWriter.procesar()).
 */

const Database = require('better-sqlite3');
const { validateEntradaConversacional } = require('../schemas/EntradaConversacional');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cognitive_entradas_conversacionales (
    turno_id                TEXT    PRIMARY KEY NOT NULL,
    sesion_id                TEXT    NOT NULL,
    turno_cliente_id          TEXT    NOT NULL,
    mensaje_usuario           TEXT    NOT NULL,
    experto_id                TEXT,
    estado_procesamiento      TEXT    NOT NULL DEFAULT 'PENDIENTE',
    ultima_causa_fallo        TEXT,
    ultima_categoria_fallo    TEXT,
    retryable                 INTEGER,
    created_at                TEXT    NOT NULL,
    updated_at                TEXT    NOT NULL,
    UNIQUE (sesion_id, turno_cliente_id)
  );

  CREATE INDEX IF NOT EXISTS idx_entradas_sesion
    ON cognitive_entradas_conversacionales(sesion_id, created_at);
`;

class SqliteEntradaConversacionalRepository {
  /**
   * @param {string|Database} dbPathOrConnection
   */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection)
      throw new Error('SqliteEntradaConversacionalRepository: dbPath o conexión son requeridos.');

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

    this._stmtInsert = this._db.prepare(`
      INSERT INTO cognitive_entradas_conversacionales
        (turno_id, sesion_id, turno_cliente_id, mensaje_usuario, experto_id,
         estado_procesamiento, ultima_causa_fallo, ultima_categoria_fallo, retryable,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtByTurnoClienteId = this._db.prepare(`
      SELECT * FROM cognitive_entradas_conversacionales WHERE sesion_id = ? AND turno_cliente_id = ?
    `);
    this._stmtByTurnoId = this._db.prepare(`
      SELECT * FROM cognitive_entradas_conversacionales WHERE turno_id = ?
    `);
    this._stmtMarcarEstado = this._db.prepare(`
      UPDATE cognitive_entradas_conversacionales
         SET estado_procesamiento = ?, ultima_causa_fallo = ?, ultima_categoria_fallo = ?,
             retryable = ?, updated_at = ?
       WHERE turno_id = ?
    `);
  }

  /** Persiste una EntradaConversacional nueva. Nunca se usa para actualizar (ver marcarEstado). */
  save(entrada) {
    const { valid, errors } = validateEntradaConversacional(entrada);
    if (!valid)
      throw new Error(`SqliteEntradaConversacionalRepository.save: entrada inválida — ${errors.join('; ')}`);

    this._stmtInsert.run(
      entrada.turnoId,
      entrada.sesionId,
      entrada.turnoClienteId,
      entrada.mensajeUsuario,
      entrada.expertoId || null,
      entrada.estadoProcesamiento,
      entrada.ultimaCausaFallo || null,
      entrada.ultimaCategoriaFallo || null,
      entrada.retryable === null || entrada.retryable === undefined ? null : (entrada.retryable ? 1 : 0),
      entrada.creadoEn,
      entrada.actualizadoEn,
    );
    return entrada;
  }

  /** Base de la idempotencia de admisión — ver InteraccionCognitivaWriter. */
  findByTurnoClienteId(sesionId, turnoClienteId) {
    if (!turnoClienteId) return null;
    const row = this._stmtByTurnoClienteId.get(sesionId, turnoClienteId);
    return row ? this._hydrate(row) : null;
  }

  findByTurnoId(turnoId) {
    const row = this._stmtByTurnoId.get(turnoId);
    return row ? this._hydrate(row) : null;
  }

  /**
   * Único método que muta una fila ya insertada — exclusivamente
   * `estadoProcesamiento` y sus campos de causa, nunca `mensajeUsuario` ni
   * ninguna otra identidad. `updatedEn` explícito (no `new Date()` interno)
   * para que la misma transacción síncrona que invoca esto pueda mantener
   * un único timestamp coherente con el resto de sus escrituras.
   */
  marcarEstado({ turnoId, estadoProcesamiento, ultimaCausaFallo = null, ultimaCategoriaFallo = null, retryable = null, actualizadoEn }) {
    this._stmtMarcarEstado.run(
      estadoProcesamiento,
      ultimaCausaFallo,
      ultimaCategoriaFallo,
      retryable === null || retryable === undefined ? null : (retryable ? 1 : 0),
      actualizadoEn || new Date().toISOString(),
      turnoId,
    );
  }

  /** Cierra la conexión solo si esta instancia la abrió (dbPath string). */
  close() {
    if (this._ownsConnection) this._db.close();
  }

  get dbPath() { return this._dbPath; }

  _hydrate(row) {
    return Object.freeze({
      turnoId:              row.turno_id,
      sesionId:             row.sesion_id,
      turnoClienteId:       row.turno_cliente_id,
      mensajeUsuario:       row.mensaje_usuario,
      expertoId:            row.experto_id || null,
      estadoProcesamiento:  row.estado_procesamiento,
      ultimaCausaFallo:     row.ultima_causa_fallo || null,
      ultimaCategoriaFallo: row.ultima_categoria_fallo || null,
      retryable:            row.retryable === null || row.retryable === undefined ? null : !!row.retryable,
      creadoEn:             row.created_at,
      actualizadoEn:        row.updated_at,
    });
  }
}

module.exports = { SqliteEntradaConversacionalRepository };
