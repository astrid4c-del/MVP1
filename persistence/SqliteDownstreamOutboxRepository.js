'use strict';

/**
 * SQLITE DOWNSTREAM OUTBOX REPOSITORY
 * Mecanismo durable de despacho para "conversación completada → pipeline
 * downstream solicitado" (Incremento 7d, corrección post-revisión).
 *
 * Por qué existe (no basta con state.pipelineStatus): el estado canónico
 * vive como JSON versionado (state_versions/state_current) — cada commit
 * crea una fila NUEVA, nunca hay un UPDATE condicional sobre un campo
 * embebido en ese JSON. Eso hace imposible una reclamación atómica
 * "solo si sigue en pending" contra ese modelo. Esta tabla, en cambio, es
 * una fila mutable por sesión con su propio 'status' — el UPDATE con WHERE
 * de reclamar() ES el compare-and-set real, y SQLite (incluso en WAL, desde
 * conexiones de procesos distintos) serializa esa sentencia como una unidad
 * — es la garantía mínima que pide un outbox, sin infraestructura distinta
 * a la que ya usa el resto del proyecto.
 *
 * state.pipelineStatus (Incremento 2) sigue siendo el modelo de LECTURA
 * expuesto a la UI (sessionDTO) — esta tabla es el mecanismo de DESPACHO
 * interno; ambos se mantienen sincronizados por PipelineDownstreamDispatcher,
 * pero nunca son la misma fuente de verdad para la misma pregunta: esta
 * tabla contesta "¿quién puede ejecutar esto ahora, sin pisar a otro
 * proceso?", pipelineStatus contesta "¿en qué fase visible está?".
 *
 * turno_id es la clave idempotente estable por sesión: es el Turno que
 * confirmó la última gramática, generado exactamente una vez por el writer.
 * PipelineApplicationService.runFromAgora la recibe (Incremento 7,
 * corrección) para poder correlacionar/auditar reintentos — ver nota de
 * alcance en PipelineDownstreamDispatcher sobre los límites reales de esa
 * idempotencia (el proveedor LLM no ofrece deduplicación por clave).
 */

const Database = require('better-sqlite3');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS downstream_requests (
    sesion_id   TEXT    PRIMARY KEY,
    turno_id    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    claimed_by  TEXT,
    claimed_at  TEXT,
    intentos    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_downstream_requests_status
    ON downstream_requests(status, created_at);
`;

const ESTADOS_RECLAMABLES = Object.freeze(['pending', 'fallido']);

class SqliteDownstreamOutboxRepository {
  /** @param {string|Database} dbPathOrConnection */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection)
      throw new Error('SqliteDownstreamOutboxRepository: dbPath o conexión son requeridos.');

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

    this._stmtRegistrar = this._db.prepare(`
      INSERT OR IGNORE INTO downstream_requests
        (sesion_id, turno_id, status, intentos, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?)
    `);
    this._stmtObtener = this._db.prepare(`SELECT * FROM downstream_requests WHERE sesion_id = ?`);
    this._stmtReclamar = this._db.prepare(`
      UPDATE downstream_requests
         SET status = 'claimed', claimed_by = ?, claimed_at = ?, intentos = intentos + 1, updated_at = ?
       WHERE sesion_id = ?
         AND (status IN ('pending', 'fallido') OR (status = 'claimed' AND claimed_at < ?))
    `);
    this._stmtListarReclamables = this._db.prepare(`
      SELECT sesion_id FROM downstream_requests
       WHERE status IN ('pending', 'fallido') OR (status = 'claimed' AND claimed_at < ?)
       ORDER BY created_at ASC
       LIMIT ?
    `);
    this._stmtMarcarCompletado = this._db.prepare(`
      UPDATE downstream_requests SET status = 'completado', updated_at = ? WHERE sesion_id = ?
    `);
    this._stmtMarcarFallido = this._db.prepare(`
      UPDATE downstream_requests SET status = 'fallido', updated_at = ? WHERE sesion_id = ?
    `);
  }

  /**
   * Registra la solicitud durable — se llama DENTRO de la transacción del
   * writer, misma conexión, atómico con pipelineStatus:'pending' y el
   * Turno que cerró la conversación. INSERT OR IGNORE: sesion_id es PK, así
   * que una segunda llamada para la MISMA sesión (no debería ocurrir, pero
   * es la garantía real) nunca crea una segunda solicitud lógica.
   */
  registrar({ sesionId, turnoId }) {
    const ahora = new Date().toISOString();
    this._stmtRegistrar.run(sesionId, turnoId, ahora, ahora);
  }

  obtener(sesionId) {
    const row = this._stmtObtener.get(sesionId);
    return row ? this._hydrate(row) : null;
  }

  /**
   * Reclamación atómica — el compare-and-set real. 'pending' o 'fallido' se
   * reclaman siempre; un 'claimed' se reclama de nuevo SOLO si su
   * claimed_at es anterior al umbral de abandono (staleBeforeIso) — así se
   * recupera una ejecución cuyo proceso murió a mitad de camino, sin
   * necesitar que ese proceso avise nada.
   * @returns {boolean} true si ESTE llamado ganó la reclamación.
   */
  reclamar(sesionId, claimedBy, staleBeforeIso) {
    const ahora = new Date().toISOString();
    const info = this._stmtReclamar.run(claimedBy, ahora, ahora, sesionId, staleBeforeIso);
    return info.changes > 0;
  }

  /** Candidatos reclamables (pendientes, fallidos, o claimed abandonados) — no reclama, solo lista. */
  listarReclamables({ limite = 50, staleBeforeIso }) {
    return this._stmtListarReclamables.all(staleBeforeIso, limite).map(r => r.sesion_id);
  }

  marcarCompletado(sesionId) {
    this._stmtMarcarCompletado.run(new Date().toISOString(), sesionId);
  }

  marcarFallido(sesionId) {
    this._stmtMarcarFallido.run(new Date().toISOString(), sesionId);
  }

  close() {
    if (this._ownsConnection) this._db.close();
  }

  get dbPath() { return this._dbPath; }

  _hydrate(row) {
    return Object.freeze({
      sesionId: row.sesion_id,
      turnoId: row.turno_id,
      status: row.status,
      claimedBy: row.claimed_by || null,
      claimedAt: row.claimed_at || null,
      intentos: row.intentos,
      creadoEn: row.created_at,
      actualizadoEn: row.updated_at,
    });
  }
}

module.exports = { SqliteDownstreamOutboxRepository, ESTADOS_RECLAMABLES };
