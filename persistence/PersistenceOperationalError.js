'use strict';

/** Error tipado para fallos operacionales de almacenamiento.
 *
 * Solo estos errores pueden cruzar un boundary de persistencia y convertirse
 * en un resultado fail-closed. Los errores de programación permanecen
 * visibles y no se degradan silenciosamente.
 */
class PersistenceOperationalError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PersistenceOperationalError';
    this.code = options.code || 'PERSISTENCE_ERROR';
    this.operational = true;
  }
}

function esFalloOperacionalPersistencia(error) {
  return error instanceof PersistenceOperationalError
    || !!(error && typeof error.code === 'string' && /^SQLITE_/.test(error.code));
}

module.exports = { PersistenceOperationalError, esFalloOperacionalPersistencia };
