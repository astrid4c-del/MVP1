'use strict';

/**
 * SQLITE TURNO REPOSITORY
 * Persistencia durable, append-only, de Turnos (intercambios cognitivos
 * reales — nunca intentos técnicos fallidos, ver Incremento 3).
 *
 * Acepta un dbPath (string, abre y posee su propia conexión — comportamiento
 * histórico, retrocompatible) o una conexión better-sqlite3 ya abierta
 * (no la posee, nunca la cierra — para uso vía CognitiveUnitOfWork).
 *
 * Dos restricciones UNIQUE son la última defensa contra duplicados:
 *   (sesion_id, numero_de_turno) — un número de turno no se repite en una sesión
 *   (sesion_id, turno_cliente_id) — idempotencia ante reintentos del cliente
 * Esta última ignora NULLs (turnoClienteId es opcional durante la transición
 * de contrato de /grammar-turn — Incremento 4).
 */

const Database = require('better-sqlite3');
const { validateTurno } = require('../schemas/Turno');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cognitive_turnos (
    turno_id                  TEXT    PRIMARY KEY NOT NULL,
    sesion_id                 TEXT    NOT NULL,
    turno_cliente_id          TEXT,
    numero_de_turno           INTEGER NOT NULL,
    gramatica                 TEXT    NOT NULL,
    etapa_cognitiva_asociada  TEXT    NOT NULL,
    mensaje_experto           TEXT    NOT NULL,
    mensaje_circulo           TEXT    NOT NULL,
    aportes_brutos_json       TEXT    NOT NULL DEFAULT '{}',
    created_at                TEXT    NOT NULL,
    UNIQUE (sesion_id, numero_de_turno)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_sesion_cliente
    ON cognitive_turnos(sesion_id, turno_cliente_id)
    WHERE turno_cliente_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_turnos_sesion
    ON cognitive_turnos(sesion_id, numero_de_turno);
`;

class SqliteTurnoRepository {
  /**
   * @param {string|Database} dbPathOrConnection
   */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection)
      throw new Error('SqliteTurnoRepository: dbPath o conexión son requeridos.');

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
      INSERT INTO cognitive_turnos
        (turno_id, sesion_id, turno_cliente_id, numero_de_turno, gramatica,
         etapa_cognitiva_asociada, mensaje_experto, mensaje_circulo,
         aportes_brutos_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtBySesion = this._db.prepare(`
      SELECT * FROM cognitive_turnos WHERE sesion_id = ? ORDER BY numero_de_turno ASC
    `);
    this._stmtByTurnoClienteId = this._db.prepare(`
      SELECT * FROM cognitive_turnos WHERE sesion_id = ? AND turno_cliente_id = ?
    `);
    this._stmtUltimoNumero = this._db.prepare(`
      SELECT MAX(numero_de_turno) AS n FROM cognitive_turnos WHERE sesion_id = ?
    `);
    this._stmtPaginaAntesDe = this._db.prepare(`
      SELECT * FROM cognitive_turnos
       WHERE sesion_id = ? AND numero_de_turno < ?
       ORDER BY numero_de_turno DESC LIMIT ?
    `);
    this._stmtPaginaDesdeElInicio = this._db.prepare(`
      SELECT * FROM cognitive_turnos
       WHERE sesion_id = ?
       ORDER BY numero_de_turno DESC LIMIT ?
    `);
    this._stmtPaginaAscendente = this._db.prepare(`
      SELECT * FROM cognitive_turnos
       WHERE sesion_id = ? AND numero_de_turno > ?
       ORDER BY numero_de_turno ASC LIMIT ?
    `);
    this._stmtCount = this._db.prepare(`SELECT COUNT(*) AS n FROM cognitive_turnos`);
    this._stmtCountBySesion = this._db.prepare(`
      SELECT COUNT(*) AS n FROM cognitive_turnos WHERE sesion_id = ?
    `);
  }

  /**
   * Persiste un Turno. Nunca se actualiza ni se borra (append-only real: no
   * existe método update/delete en esta clase). Lanza si viola alguna de las
   * dos restricciones UNIQUE (duplicado de numeroDeTurno o de turnoClienteId).
   */
  save(turno) {
    const { valid, errors } = validateTurno(turno);
    if (!valid)
      throw new Error(`SqliteTurnoRepository.save: turno inválido — ${errors.join('; ')}`);

    this._stmtInsert.run(
      turno.turnoId,
      turno.sesionId,
      turno.turnoClienteId || null,
      turno.numeroDeTurno,
      turno.gramatica,
      turno.etapaCognitivaAsociada,
      turno.mensajeExperto,
      turno.mensajeCirculo,
      JSON.stringify(turno.aportesBrutos || {}),
      turno.creadoEn,
    );
    return turno;
  }

  /** Todos los turnos de una sesión, en orden cronológico ascendente. */
  findBySesion(sesionId) {
    return this._stmtBySesion.all(sesionId).map(r => this._hydrate(r));
  }

  /**
   * Busca el Turno ya persistido para (sesionId, turnoClienteId), o null si
   * no existe todavía. Es la base de la idempotencia de /grammar-turn.
   */
  findByTurnoClienteId(sesionId, turnoClienteId) {
    if (!turnoClienteId) return null;
    const row = this._stmtByTurnoClienteId.get(sesionId, turnoClienteId);
    return row ? this._hydrate(row) : null;
  }

  /** Próximo numeroDeTurno disponible para una sesión (1 si no tiene turnos). */
  proximoNumeroDeTurno(sesionId) {
    const row = this._stmtUltimoNumero.get(sesionId);
    return (row && row.n) ? row.n + 1 : 1;
  }

  /**
   * Página de turnos por cursor, en orden cronológico inverso (los más
   * recientes primero) — pensada para reconstruir el transcript "hacia
   * arriba" sin depender de offsets que se desincronizan si se agregan
   * turnos nuevos mientras se pagina.
   * @param {string} sesionId
   * @param {string|null} antesDe — turnoId cursor, o null para la primera página
   * @param {number} limite
   */
  paginar(sesionId, antesDe, limite) {
    if (antesDe) {
      const cursor = this._db.prepare(`SELECT numero_de_turno FROM cognitive_turnos WHERE turno_id = ?`).get(antesDe);
      const numeroCursor = cursor ? cursor.numero_de_turno : Number.MAX_SAFE_INTEGER;
      return this._stmtPaginaAntesDe.all(sesionId, numeroCursor, limite).map(r => this._hydrate(r));
    }
    return this._stmtPaginaDesdeElInicio.all(sesionId, limite).map(r => this._hydrate(r));
  }

  /**
   * Página de turnos por cursor, en orden cronológico ASCENDENTE — la forma
   * que necesita un transcript (reconstruir la conversación en el orden en
   * que ocurrió). Reutiliza la misma tabla, el mismo índice
   * (idx_turnos_sesion, sobre sesion_id+numero_de_turno) y el mismo patrón
   * de _hydrate/prepared statement que paginar() (Incremento 4: capacidad ya
   * creada, variante ascendente para GET /session/:id/turnos — Incremento 5).
   * El cursor es el propio numeroDeTurno (entero, denso, nunca reutilizado
   * por la restricción UNIQUE): a diferencia de paginar() no hace falta
   * resolver un turnoId primero, así que un cursor fuera de rango
   * simplemente no devuelve turnos posteriores a él — nunca cae de vuelta
   * al principio de la sesión.
   * @param {string} sesionId
   * @param {number} despuesDe — numeroDeTurno cursor (0 = desde el principio)
   * @param {number} limite
   */
  paginarAscendente(sesionId, despuesDe, limite) {
    return this._stmtPaginaAscendente.all(sesionId, despuesDe, limite).map(r => this._hydrate(r));
  }

  count()                 { return this._stmtCount.get().n; }
  countBySesion(sesionId) { return this._stmtCountBySesion.get(sesionId).n; }

  /** Cierra la conexión solo si esta instancia la abrió (dbPath string). */
  close() {
    if (this._ownsConnection) this._db.close();
  }

  get dbPath() { return this._dbPath; }

  _hydrate(row) {
    return Object.freeze({
      turnoId:        row.turno_id,
      sesionId:       row.sesion_id,
      turnoClienteId: row.turno_cliente_id || null,
      numeroDeTurno:  row.numero_de_turno,
      gramatica:      row.gramatica,
      etapaCognitivaAsociada: row.etapa_cognitiva_asociada,
      mensajeExperto: row.mensaje_experto,
      mensajeCirculo: row.mensaje_circulo,
      aportesBrutos:  Object.freeze(JSON.parse(row.aportes_brutos_json || '{}')),
      creadoEn:       row.created_at,
    });
  }
}

module.exports = { SqliteTurnoRepository };
