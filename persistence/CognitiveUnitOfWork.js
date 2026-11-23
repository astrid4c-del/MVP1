'use strict';

/**
 * COGNITIVE UNIT OF WORK
 * Único dueño de la conexión SQLite compartida entre Turno/Estado/Eventos,
 * outbox y afirmaciones transformacionales, y único punto del sistema que
 * abre transacciones sobre ella.
 *
 * Ningún servicio de dominio (p.ej. el futuro InteraccionCognitivaWriter,
 * Incremento 3) debe llamar a db.transaction directamente ni construir sus
 * propios repositorios sobre una conexión propia — todos reciben, a través
 * de ejecutar(), los repositorios ya ligados a ESTA conexión.
 *
 * Los repositorios (SqliteStateRepository, SqliteEventRepository,
 * SqliteTurnoRepository) reciben la conexión y nunca la cierran por su
 * cuenta — su close() es un no-op cuando la conexión no les pertenece. Solo
 * cerrar() aquí cierra la conexión real, y debe usarse únicamente al apagar
 * el proceso.
 */

const Database = require('better-sqlite3');
const { SqliteStateRepository } = require('./SqliteStateRepository');
const { SqliteEventRepository } = require('../events/SqliteEventRepository');
const { SqliteTurnoRepository } = require('./SqliteTurnoRepository');
const { SqliteDownstreamOutboxRepository } = require('./SqliteDownstreamOutboxRepository');
const {
  SqliteAfirmacionTransformacionalDestinoRepository,
} = require('./SqliteAfirmacionTransformacionalDestinoRepository');
const {
  SqliteEntradaConversacionalRepository,
} = require('./SqliteEntradaConversacionalRepository');
const { PersistenceOperationalError } = require('./PersistenceOperationalError');

class CognitiveUnitOfWork {
  /**
   * @param {string} dbPath — ruta al archivo SQLite compartido.
   */
  constructor(dbPath) {
    if (!dbPath || typeof dbPath !== 'string')
      throw new Error('CognitiveUnitOfWork: dbPath es requerido.');

    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._dbPath = dbPath;

    // Repositorios ligados a la única conexión — ninguno la posee.
    this.stateRepo = new SqliteStateRepository(this._db);
    this.eventRepo = new SqliteEventRepository(this._db);
    this.turnoRepo = new SqliteTurnoRepository(this._db);
    // Incremento 7 (corrección post-revisión): outbox durable de solicitudes
    // downstream — ver SqliteDownstreamOutboxRepository para el porqué no
    // basta con un campo embebido en el JSON versionado del estado.
    this.outboxRepo = new SqliteDownstreamOutboxRepository(this._db);
    this.afirmacionTransformacionalRepo =
      new SqliteAfirmacionTransformacionalDestinoRepository(this._db);
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 — misma conexión/transacción que
    // el resto: la admisión de una entrada y, más tarde, la confirmación del
    // Turno final que la completa, participan cada una de su propia
    // transacción de esta misma unidad de trabajo (ver
    // InteraccionCognitivaWriter — nunca la misma transacción para ambas).
    this.entradaConversacionalRepo = new SqliteEntradaConversacionalRepository(this._db);
  }

  /**
   * Ejecuta fn dentro de una única transacción SQLite. fn recibe
   * los repositorios de esta instancia — todos ligados a la misma conexión —
   * para que cada escritura que fn realice participe de la misma transacción
   * (todo o nada).
   *
   * CONTRATO OBLIGATORIO: fn debe ser síncrona. better-sqlite3 no soporta
   * transacciones asíncronas — si fn devolviera una Promise, better-sqlite3
   * la trataría como el valor de retorno normal de una función síncrona y
   * haría commit inmediatamente con lo que fn ya haya escrito hasta ese
   * punto, mientras la continuación real de fn (después de cualquier await)
   * seguiría ejecutándose más tarde, YA FUERA de la transacción — un commit
   * parcial silencioso. Por eso, si fn devuelve algo thenable, ejecutar()
   * lanza de inmediato (dentro de la transacción, provocando rollback de
   * cualquier escritura previa de fn) en vez de permitir ese escenario.
   * Ninguna llamada externa (red, LLM) ni ningún await puede ocurrir dentro
   * de fn — los servicios deben obtener primero cualquier resultado externo
   * y recién después llamar a ejecutar() con una función corta y síncrona
   * que solo escriba en los repositorios.
   *
   * Nota para el Incremento 3 (InteraccionCognitivaWriter): este método
   * garantiza atomicidad e idempotencia por (sesionId, turnoClienteId), pero
   * NO serializa interacciones distintas sobre la misma sesión — dos
   * turnoClienteId diferentes de la misma sesión pueden, hoy, leer y
   * transformar el mismo estado canónico concurrentemente sin detección. El
   * Incremento 3 debe resolver esto como una responsabilidad separada de la
   * deduplicación (serialización por sesionId), no incluida en este método.
   *
   * @param {(repos: {turnoRepo, stateRepo, eventRepo, outboxRepo}) => any} fn
   * @returns lo que fn devuelva
   */
  ejecutar(fn) {
    const repos = {
      turnoRepo: this.turnoRepo,
      stateRepo: this.stateRepo,
      eventRepo: this.eventRepo,
      outboxRepo: this.outboxRepo,
      afirmacionTransformacionalRepo: this.afirmacionTransformacionalRepo,
      entradaConversacionalRepo: this.entradaConversacionalRepo,
    };
    const transaccion = this._db.transaction(() => {
      const resultado = fn(repos);
      if (resultado && typeof resultado.then === 'function') {
        throw new Error(
          'CognitiveUnitOfWork.ejecutar: fn debe ser síncrona (se recibió una Promise/thenable). ' +
          'Ninguna llamada externa ni await puede ocurrir dentro de una transacción SQLite — ' +
          'obtén primero los resultados externos y luego ejecuta una transacción corta y síncrona.'
        );
      }
      return resultado;
    });
    try {
      return transaccion();
    } catch (error) {
      // better-sqlite3 expone los fallos del motor con códigos SQLITE_*.
      // Los errores de programación no llevan ese contrato y se propagan
      // intactos para conservar fail-fast.
      if (error && typeof error.code === 'string' && /^SQLITE_/.test(error.code)) {
        throw new PersistenceOperationalError(error.message, { cause: error, code: error.code });
      }
      throw error;
    }
  }

  /** Cierra la única conexión compartida. Usar solo al apagar el proceso. */
  cerrar() {
    this._db.close();
  }

  get dbPath() { return this._dbPath; }
}

module.exports = { CognitiveUnitOfWork };
