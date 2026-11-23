'use strict';

/**
 * Repositorio durable aislado de AfirmacionTransformacionalDestino.
 *
 * Persiste fotografías completas ya producidas por el dominio C1. No ejecuta
 * transiciones, no concede autoridad normativa y no almacena capabilities.
 * La conexión puede pertenecer al CognitiveUnitOfWork; en ese caso este
 * repositorio nunca abre transacciones ni cierra la conexión compartida.
 */

const Database = require('better-sqlite3');
const schema = require('../schemas/AfirmacionTransformacionalDestino');
const runtime = require('../domain/_AfirmacionTransformacionalDestinoProcessLocal');

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS destino_afirmaciones_transformacionales (
    sesion_id          TEXT    NOT NULL,
    afirmacion_id      TEXT    NOT NULL,
    version            INTEGER NOT NULL,
    estado_normativo   TEXT    NOT NULL,
    reemplaza_a_id     TEXT,
    schema_version     INTEGER NOT NULL,
    contenido_json     TEXT    NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now','utc')),
    PRIMARY KEY (sesion_id, afirmacion_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_afirmaciones_identidad_global
    ON destino_afirmaciones_transformacionales(afirmacion_id);

  CREATE INDEX IF NOT EXISTS idx_destino_afirmaciones_sesion_orden
    ON destino_afirmaciones_transformacionales
       (sesion_id, version, created_at, afirmacion_id);

  CREATE TABLE IF NOT EXISTS destino_afirmacion_materializaciones (
    registro_id TEXT PRIMARY KEY NOT NULL, sesion_id TEXT NOT NULL,
    afirmacion_id TEXT NOT NULL UNIQUE, contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (sesion_id, afirmacion_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
  CREATE TABLE IF NOT EXISTS destino_afirmacion_veredictos (
    registro_id TEXT PRIMARY KEY NOT NULL, sesion_id TEXT NOT NULL,
    afirmacion_id TEXT NOT NULL UNIQUE, contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (sesion_id, afirmacion_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
  CREATE TABLE IF NOT EXISTS destino_afirmacion_presentaciones_roundtrip (
    presentacion_id TEXT PRIMARY KEY NOT NULL, sesion_id TEXT NOT NULL,
    afirmacion_id TEXT NOT NULL, contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    UNIQUE (afirmacion_id, presentacion_id),
    FOREIGN KEY (sesion_id, afirmacion_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
  CREATE TABLE IF NOT EXISTS destino_afirmacion_resultados_roundtrip (
    registro_id TEXT PRIMARY KEY NOT NULL, sesion_id TEXT NOT NULL,
    afirmacion_id TEXT NOT NULL, presentacion_id TEXT NOT NULL,
    contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (presentacion_id)
      REFERENCES destino_afirmacion_presentaciones_roundtrip(presentacion_id),
    FOREIGN KEY (sesion_id, afirmacion_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
  CREATE TABLE IF NOT EXISTS destino_afirmacion_sucesiones (
    registro_roundtrip_id TEXT PRIMARY KEY NOT NULL, sesion_id TEXT NOT NULL,
    afirmacion_anterior_id TEXT NOT NULL, afirmacion_sucesora_id TEXT NOT NULL UNIQUE,
    contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (registro_roundtrip_id)
      REFERENCES destino_afirmacion_resultados_roundtrip(registro_id),
    FOREIGN KEY (sesion_id, afirmacion_anterior_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id),
    FOREIGN KEY (sesion_id, afirmacion_sucesora_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
`;

const VIGENCIA_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS destino_afirmacion_cabezas (
    sesion_id TEXT PRIMARY KEY NOT NULL,
    afirmacion_id TEXT NOT NULL,
    revision_cabeza INTEGER NOT NULL CHECK (revision_cabeza >= 1),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (sesion_id, afirmacion_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );

  CREATE TABLE IF NOT EXISTS destino_afirmacion_activaciones (
    activacion_id TEXT PRIMARY KEY NOT NULL,
    sesion_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('ACTIVACION_INICIAL', 'REEMPLAZO', 'REEMPLAZO_PREAUTORIZACION')),
    afirmacion_anterior_id TEXT,
    afirmacion_nueva_id TEXT NOT NULL,
    registro_veredicto_id TEXT,
    revision_anterior INTEGER NOT NULL CHECK (revision_anterior >= 0),
    revision_resultante INTEGER NOT NULL CHECK (revision_resultante >= 1),
    origen TEXT NOT NULL CHECK (origen IN ('VEREDICTO_C1', 'MIGRACION_AB')),
    contenido_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (sesion_id, afirmacion_nueva_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id),
    FOREIGN KEY (registro_veredicto_id)
      REFERENCES destino_afirmacion_veredictos(registro_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_activaciones_revision_sesion
    ON destino_afirmacion_activaciones(sesion_id, revision_resultante);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_activaciones_veredicto
    ON destino_afirmacion_activaciones(registro_veredicto_id)
    WHERE registro_veredicto_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS destino_afirmacion_vigencia_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now','utc'))
  );
`;

// S1_R_INCREMENTO_1 — persistencia durable de reparación transformacional
// (rechazo de una Afirmación AUTORIZADA con alcance RELACION). Ninguna tabla
// existente puede representarla: la Afirmación/Presentación no tienen
// concepto de "cuestionada sin sucesora todavía", y la Hipótesis nunca tuvo
// tabla propia (process-local por diseño, ver CicloHipotesisTransformacionalDestinoOrquestacion.js)
// — por eso una Hipótesis sucesora rechazada tampoco tiene autoridad durable
// reutilizable; se modela como relación hija append-only, nunca como un
// array JSON reescrito dentro de la fila de reparación (cada rechazo de
// sucesora es un hecho causal independiente, con su propia identidad e
// idempotencia). Sin migración de datos preexistentes (nunca existió esta
// tabla) — CREATE TABLE IF NOT EXISTS directo, mismo patrón que SCHEMA_SQL,
// sin necesitar el mecanismo de instalar-y-migrar de VIGENCIA_SCHEMA_SQL.
const S1R_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS destino_afirmacion_reparaciones_s1r (
    reparacion_id              TEXT    PRIMARY KEY NOT NULL,
    sesion_id                  TEXT    NOT NULL,
    afirmacion_origen_id       TEXT    NOT NULL,
    afirmacion_origen_version  INTEGER NOT NULL,
    presentacion_origen_id     TEXT    NOT NULL,
    alcance                    TEXT    NOT NULL CHECK (alcance IN ('RELACION')),
    correccion_detalle         TEXT    NOT NULL,
    abierta_en_turno_id        TEXT    NOT NULL,
    estado                     TEXT    NOT NULL CHECK (estado IN ('ABIERTA', 'RESUELTA')),
    hipotesis_sucesora_id      TEXT,
    hipotesis_sucesora_version INTEGER,
    hipotesis_sucesora_roles_json           TEXT,
    hipotesis_sucesora_turno_presentacion_id TEXT,
    afirmacion_sucesora_id     TEXT,
    created_at                 TEXT    NOT NULL DEFAULT (datetime('now','utc')),
    resuelta_en                TEXT,
    resuelta_en_turno_id       TEXT,
    FOREIGN KEY (sesion_id, afirmacion_origen_id)
      REFERENCES destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_reparaciones_s1r_afirmacion
    ON destino_afirmacion_reparaciones_s1r(afirmacion_origen_id, afirmacion_origen_version);

  CREATE TABLE IF NOT EXISTS destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas (
    registro_id           TEXT    PRIMARY KEY NOT NULL,
    reparacion_id         TEXT    NOT NULL,
    hipotesis_id          TEXT    NOT NULL,
    hipotesis_version     INTEGER NOT NULL,
    rechazada_en_turno_id TEXT    NOT NULL,
    correccion_detalle    TEXT,
    roles_json            TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now','utc')),
    FOREIGN KEY (reparacion_id)
      REFERENCES destino_afirmacion_reparaciones_s1r(reparacion_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_s1r_sucesora_rechazada_identidad
    ON destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas(reparacion_id, hipotesis_id, hipotesis_version);
`;

function esObjeto(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ordenarCanonico(value) {
  if (Array.isArray(value)) return value.map(ordenarCanonico);
  if (esObjeto(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(clave => [clave, ordenarCanonico(value[clave])]),
    );
  }
  return value;
}

function serializarCanonico(value) {
  return JSON.stringify(ordenarCanonico(value));
}

function congelarLectura(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(congelarLectura);
  return Object.freeze(value);
}

function validarContextoSesion(sesionId) {
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('SqliteAfirmacionTransformacionalDestinoRepository: sesionId es requerido');
  }
}

class SqliteAfirmacionTransformacionalDestinoRepository {
  /** @param {string|Database} dbPathOrConnection */
  constructor(dbPathOrConnection) {
    if (!dbPathOrConnection) {
      throw new Error(
        'SqliteAfirmacionTransformacionalDestinoRepository: dbPath o conexión son requeridos.',
      );
    }
    if (typeof dbPathOrConnection === 'string') {
      this._db = new Database(dbPathOrConnection);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('foreign_keys = ON');
      this._ownsConnection = true;
      this._dbPath = dbPathOrConnection;
    } else {
      this._db = dbPathOrConnection;
      this._ownsConnection = false;
      this._dbPath = dbPathOrConnection.name;
    }

    try {
      this._db.exec(SCHEMA_SQL);
      this._asegurarIndiceRoundTripPorPresentacion();
      this._instalarYMigrarVigenciaC();
      this._db.exec(S1R_SCHEMA_SQL);
      this._instalarYMigrarColumnasS1RIncremento3();
    } catch (error) {
      if (this._ownsConnection) this._db.close();
      throw error;
    }
    this._stmtInsert = this._db.prepare(`
      INSERT INTO destino_afirmaciones_transformacionales
        (sesion_id, afirmacion_id, version, estado_normativo,
         reemplaza_a_id, schema_version, contenido_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtById = this._db.prepare(`
      SELECT * FROM destino_afirmaciones_transformacionales
       WHERE sesion_id = ? AND afirmacion_id = ?
    `);
    this._stmtBySession = this._db.prepare(`
      SELECT * FROM destino_afirmaciones_transformacionales
       WHERE sesion_id = ?
       ORDER BY version ASC, created_at ASC, afirmacion_id ASC
    `);
    this._stmtCountBySession = this._db.prepare(`
      SELECT COUNT(*) AS n FROM destino_afirmaciones_transformacionales
       WHERE sesion_id = ?
    `);
    this._stmtByGlobalId = this._db.prepare(`
      SELECT * FROM destino_afirmaciones_transformacionales
       WHERE afirmacion_id = ?
    `);
    this._stmtUpdateSnapshot = this._db.prepare(`
      UPDATE destino_afirmaciones_transformacionales
         SET estado_normativo = ?, contenido_json = ?, reemplaza_a_id = ?
       WHERE sesion_id = ? AND afirmacion_id = ?
         AND estado_normativo = ? AND contenido_json = ?
    `);
    this._stmtHeadBySession = this._db.prepare(`
      SELECT * FROM destino_afirmacion_cabezas WHERE sesion_id = ?
    `);
    this._stmtInsertHead = this._db.prepare(`
      INSERT INTO destino_afirmacion_cabezas
        (sesion_id, afirmacion_id, revision_cabeza)
      SELECT ?, ?, 1
       WHERE NOT EXISTS (
         SELECT 1 FROM destino_afirmacion_cabezas WHERE sesion_id = ?
       )
    `);
    this._stmtReplaceHead = this._db.prepare(`
      UPDATE destino_afirmacion_cabezas
         SET afirmacion_id = ?, revision_cabeza = revision_cabeza + 1,
             updated_at = datetime('now','utc')
       WHERE sesion_id = ? AND afirmacion_id = ? AND revision_cabeza = ?
    `);
    this._stmtActivationById = this._db.prepare(`
      SELECT * FROM destino_afirmacion_activaciones WHERE activacion_id = ?
    `);
    this._stmtInsertActivation = this._db.prepare(`
      INSERT INTO destino_afirmacion_activaciones
        (activacion_id, sesion_id, tipo, afirmacion_anterior_id,
         afirmacion_nueva_id, registro_veredicto_id, revision_anterior,
         revision_resultante, origen, contenido_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._causales = {
      materializacion: this._prepararTablaCausal(
        'destino_afirmacion_materializaciones', 'registro_id',
      ),
      veredicto: this._prepararTablaCausal('destino_afirmacion_veredictos', 'registro_id'),
      presentacion: this._prepararTablaCausal(
        'destino_afirmacion_presentaciones_roundtrip', 'presentacion_id',
      ),
      roundtrip: this._prepararTablaCausal(
        'destino_afirmacion_resultados_roundtrip', 'registro_id',
      ),
      sucesion: this._prepararTablaCausal(
        'destino_afirmacion_sucesiones', 'registro_roundtrip_id',
      ),
    };
    this._stmtRoundTripByPresentacion = this._db.prepare(`
      SELECT * FROM destino_afirmacion_resultados_roundtrip
       WHERE presentacion_id = ?
    `);
    // S1_R_INCREMENTO_1 — reparación transformacional (rechazo de Afirmación
    // AUTORIZADA, alcance RELACION). Ver S1R_SCHEMA_SQL para el porqué de
    // cada tabla.
    this._stmtInsertReparacionS1R = this._db.prepare(`
      INSERT INTO destino_afirmacion_reparaciones_s1r
        (reparacion_id, sesion_id, afirmacion_origen_id, afirmacion_origen_version,
         presentacion_origen_id, alcance, correccion_detalle, abierta_en_turno_id, estado,
         componente_relacional)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ABIERTA', ?)
    `);
    this._stmtReparacionS1RById = this._db.prepare(`
      SELECT * FROM destino_afirmacion_reparaciones_s1r WHERE reparacion_id = ?
    `);
    this._stmtReparacionS1RAbiertaPorAfirmacion = this._db.prepare(`
      SELECT * FROM destino_afirmacion_reparaciones_s1r
       WHERE afirmacion_origen_id = ? AND afirmacion_origen_version = ? AND estado = ?
    `);
    this._stmtResolverReparacionS1R = this._db.prepare(`
      UPDATE destino_afirmacion_reparaciones_s1r
         SET estado = 'RESUELTA', afirmacion_sucesora_id = ?, resuelta_en = datetime('now','utc'),
             resuelta_en_turno_id = ?
       WHERE reparacion_id = ?
    `);
    this._stmtInsertSucesoraRechazadaS1R = this._db.prepare(`
      INSERT INTO destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas
        (registro_id, reparacion_id, hipotesis_id, hipotesis_version,
         rechazada_en_turno_id, correccion_detalle, roles_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtSucesoraRechazadaS1RById = this._db.prepare(`
      SELECT * FROM destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas WHERE registro_id = ?
    `);
    this._stmtSucesorasRechazadasS1RPorReparacion = this._db.prepare(`
      SELECT * FROM destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas
       WHERE reparacion_id = ? ORDER BY created_at, rowid
    `);
    // S1_R_INCREMENTO_3 — al menos un slot de "candidata sucesora pendiente"
    // por reparación (invariante: a lo sumo una Hipótesis CANDIDATA viva a
    // la vez para una misma R). Nunca resuelve R, nunca instala Afirmación —
    // solo registra durablemente cuál candidata está pendiente de veredicto,
    // para que sea recuperable tras reinicio sin depender de emisionesLegitimas
    // (process-local).
    this._stmtRegistrarHipotesisSucesoraCandidataS1R = this._db.prepare(`
      UPDATE destino_afirmacion_reparaciones_s1r
         SET hipotesis_sucesora_id = ?, hipotesis_sucesora_version = ?,
             hipotesis_sucesora_roles_json = ?, hipotesis_sucesora_turno_presentacion_id = ?
       WHERE reparacion_id = ? AND sesion_id = ? AND estado = 'ABIERTA'
    `);
    this._stmtLimpiarHipotesisSucesoraCandidataS1R = this._db.prepare(`
      UPDATE destino_afirmacion_reparaciones_s1r
         SET hipotesis_sucesora_id = NULL, hipotesis_sucesora_version = NULL,
             hipotesis_sucesora_roles_json = NULL, hipotesis_sucesora_turno_presentacion_id = NULL
       WHERE reparacion_id = ? AND sesion_id = ? AND estado = 'ABIERTA'
    `);
  }

  _prepararTablaCausal(tabla, clave) {
    return {
      byId: this._db.prepare(`SELECT * FROM ${tabla} WHERE ${clave} = ?`),
      insert: columnas => {
        const nombres = Object.keys(columnas);
        this._db.prepare(
          `INSERT INTO ${tabla} (${nombres.join(', ')}) VALUES (${nombres.map(() => '?').join(', ')})`,
        ).run(...nombres.map(nombre => columnas[nombre]));
      },
    };
  }

  _asegurarIndiceRoundTripPorPresentacion() {
    const duplicadas = this._db.prepare(`
      SELECT presentacion_id, COUNT(*) AS cantidad
        FROM destino_afirmacion_resultados_roundtrip
       GROUP BY presentacion_id
      HAVING COUNT(*) > 1
       ORDER BY presentacion_id
    `).all();
    if (duplicadas.length > 0) {
      const detalle = duplicadas
        .map(row => `${row.presentacion_id}(${row.cantidad})`)
        .join(', ');
      throw new Error(
        `C1 durable: MIGRACION_ROUNDTRIP_PRESENTACIONES_DUPLICADAS ${detalle}`,
      );
    }
    this._db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_destino_roundtrip_presentacion_unica
        ON destino_afirmacion_resultados_roundtrip(presentacion_id)
    `);
    const indice = this._db.prepare(
      "PRAGMA index_list('destino_afirmacion_resultados_roundtrip')",
    ).all().find(row => row.name === 'idx_destino_roundtrip_presentacion_unica');
    const columnas = indice
      ? this._db.prepare(
        "PRAGMA index_info('idx_destino_roundtrip_presentacion_unica')",
      ).all().map(row => row.name)
      : [];
    if (
      !indice
      || indice.unique !== 1
      || columnas.length !== 1
      || columnas[0] !== 'presentacion_id'
    ) {
      throw new Error(
        'C1 durable: MIGRACION_INDICE_ROUNDTRIP_INCOMPATIBLE ' +
        `unique=${indice ? indice.unique : 'ausente'} columnas=${columnas.join(',') || 'ninguna'}`,
      );
    }
  }

  _instalarYMigrarVigenciaC() {
    const instalar = this._db.transaction(() => {
      this._db.exec(VIGENCIA_SCHEMA_SQL);
      this._validarSchemaVigenciaC();
      const meta = this._db.prepare(
        'SELECT version FROM destino_afirmacion_vigencia_meta WHERE id = 1',
      ).get();
      if (meta) {
        if (meta.version !== 1) {
          throw new Error(`C1 durable: VERSION_VIGENCIA_NO_SOPORTADA ${meta.version}`);
        }
        return;
      }
      const sesiones = this._db.prepare(`
        SELECT DISTINCT sesion_id
          FROM destino_afirmaciones_transformacionales
         WHERE estado_normativo = 'AUTORIZADA'
         ORDER BY sesion_id
      `).all();
      for (const { sesion_id: sesionId } of sesiones) {
        const candidatas = this._derivarCabezaMigracion(sesionId);
        const cabeza = candidatas[0];
        const activacionId =
          `activacion_destino:migracion_ab:${encodeURIComponent(sesionId)}:${encodeURIComponent(cabeza.id)}`;
        const contenido = {
          activacionId,
          sesionId,
          tipo: 'ACTIVACION_INICIAL',
          afirmacionAnteriorId: null,
          afirmacionNuevaId: cabeza.id,
          registroVeredictoId: cabeza.registroVeredictoId,
          revisionAnterior: 0,
          revisionResultante: 1,
          origen: 'MIGRACION_AB',
        };
        this._db.prepare(`
          INSERT INTO destino_afirmacion_cabezas
            (sesion_id, afirmacion_id, revision_cabeza)
          VALUES (?, ?, 1)
        `).run(sesionId, cabeza.id);
        this._db.prepare(`
          INSERT INTO destino_afirmacion_activaciones
            (activacion_id, sesion_id, tipo, afirmacion_anterior_id,
             afirmacion_nueva_id, registro_veredicto_id, revision_anterior,
             revision_resultante, origen, contenido_json)
          VALUES (?, ?, 'ACTIVACION_INICIAL', NULL, ?, ?, 0, 1, 'MIGRACION_AB', ?)
        `).run(
          activacionId, sesionId, cabeza.id, cabeza.registroVeredictoId,
          serializarCanonico(contenido),
        );
      }
      this._db.prepare(
        'INSERT INTO destino_afirmacion_vigencia_meta (id, version) VALUES (1, 1)',
      ).run();
    });
    instalar();
  }

  // S1_R_INCREMENTO_3 — columnas nuevas sobre tablas S1R ya existentes
  // (CREATE TABLE IF NOT EXISTS no las agrega a una base ya creada por el
  // Incremento 1/2). Idempotente: solo altera si la columna todavía no
  // existe — nunca falla en una base ya migrada.
  _instalarYMigrarColumnasS1RIncremento3() {
    const agregarSiFalta = (tabla, columna, definicion) => {
      const existentes = this._db.prepare(`PRAGMA table_info('${tabla}')`).all().map(row => row.name);
      if (!existentes.includes(columna)) {
        this._db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
      }
    };
    agregarSiFalta('destino_afirmacion_reparaciones_s1r', 'hipotesis_sucesora_roles_json', 'TEXT');
    agregarSiFalta('destino_afirmacion_reparaciones_s1r', 'hipotesis_sucesora_turno_presentacion_id', 'TEXT');
    agregarSiFalta('destino_afirmacion_reparaciones_s1r_sucesoras_rechazadas', 'roles_json', 'TEXT');
    // S1_R_INCREMENTO_4 — turno real de resolución (confirmación de la
    // Hipótesis sucesora) — `resuelta_en` (timestamp) ya existía; ningún
    // campo trazaba el turno causal hasta ahora.
    agregarSiFalta('destino_afirmacion_reparaciones_s1r', 'resuelta_en_turno_id', 'TEXT');
    // S1-R-SCOPE1 — componente relacional afectado (mismo vocabulario que
    // VALIDANDO_RELACION_TRANSFORMACIONAL ya usa para "corrige": ver
    // COMPONENTES_RELACIONALES en ProgresoConversacionalPolicy.js —
    // 'mecanismo_resultado' | 'resultado_observabilidad'), NULLABLE a
    // propósito: una reparación abierta antes de este incremento (o cuyo
    // veredicto no lo declaró) nunca lo tuvo — null es un hecho legítimo,
    // nunca un error. Gobierna qué rol de la Hipótesis sucesora queda
    // excluido de reutilización (ver exclusionesResultadoPorReparacion en
    // InteraccionCognitivaWriter.js) — nunca decide nada por sí sola sobre
    // el grafo ni sobre otras sesiones.
    agregarSiFalta('destino_afirmacion_reparaciones_s1r', 'componente_relacional', 'TEXT');
  }

  _validarSchemaVigenciaC() {
    this._validarTablaExacta('destino_afirmacion_cabezas', [
      ['sesion_id', 'TEXT', 1, 1, null],
      ['afirmacion_id', 'TEXT', 1, 0, null],
      ['revision_cabeza', 'INTEGER', 1, 0, null],
      ['updated_at', 'TEXT', 1, 0, "datetime('now','utc')"],
    ], 'MIGRACION_TABLA_CABEZAS_INCOMPATIBLE');
    this._validarTablaExacta('destino_afirmacion_activaciones', [
      ['activacion_id', 'TEXT', 1, 1, null],
      ['sesion_id', 'TEXT', 1, 0, null],
      ['tipo', 'TEXT', 1, 0, null],
      ['afirmacion_anterior_id', 'TEXT', 0, 0, null],
      ['afirmacion_nueva_id', 'TEXT', 1, 0, null],
      ['registro_veredicto_id', 'TEXT', 0, 0, null],
      ['revision_anterior', 'INTEGER', 1, 0, null],
      ['revision_resultante', 'INTEGER', 1, 0, null],
      ['origen', 'TEXT', 1, 0, null],
      ['contenido_json', 'TEXT', 1, 0, null],
      ['created_at', 'TEXT', 1, 0, "datetime('now','utc')"],
    ], 'MIGRACION_TABLA_ACTIVACIONES_INCOMPATIBLE');
    this._validarTablaExacta('destino_afirmacion_vigencia_meta', [
      ['id', 'INTEGER', 0, 1, null],
      ['version', 'INTEGER', 1, 0, null],
      ['migrated_at', 'TEXT', 1, 0, "datetime('now','utc')"],
    ], 'MIGRACION_TABLA_VIGENCIA_META_INCOMPATIBLE');
    this._validarDefinicionTabla(
      'destino_afirmacion_cabezas',
      [
        'check (revision_cabeza >= 1)',
        'foreign key (sesion_id, afirmacion_id) references ' +
          'destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)',
      ],
      'MIGRACION_TABLA_CABEZAS_INCOMPATIBLE',
    );
    this._validarDefinicionTabla(
      'destino_afirmacion_activaciones',
      [
        "check (tipo in ('activacion_inicial', 'reemplazo', 'reemplazo_preautorizacion'))",
        'check (revision_anterior >= 0)',
        'check (revision_resultante >= 1)',
        "check (origen in ('veredicto_c1', 'migracion_ab'))",
        'foreign key (sesion_id, afirmacion_nueva_id) references ' +
          'destino_afirmaciones_transformacionales(sesion_id, afirmacion_id)',
        'foreign key (registro_veredicto_id) references ' +
          'destino_afirmacion_veredictos(registro_id)',
      ],
      'MIGRACION_TABLA_ACTIVACIONES_INCOMPATIBLE',
    );
    this._validarDefinicionTabla(
      'destino_afirmacion_vigencia_meta',
      ['check (id = 1)'],
      'MIGRACION_TABLA_VIGENCIA_META_INCOMPATIBLE',
    );

    this._validarIndiceExacto({
      tabla: 'destino_afirmacion_activaciones',
      nombre: 'idx_destino_activaciones_revision_sesion',
      columnas: ['sesion_id', 'revision_resultante'],
      parcial: false,
    });
    this._validarIndiceExacto({
      tabla: 'destino_afirmacion_activaciones',
      nombre: 'idx_destino_activaciones_veredicto',
      columnas: ['registro_veredicto_id'],
      parcial: true,
      clausulaWhere: 'where registro_veredicto_id is not null',
    });
  }

  _validarTablaExacta(tabla, esperadas, codigo) {
    const existentes = this._db.prepare(`PRAGMA table_info('${tabla}')`).all()
      .map(row => [
        row.name, String(row.type).toUpperCase(), row.notnull, row.pk, row.dflt_value,
      ]);
    const coincide = (
      existentes.length === esperadas.length
      && esperadas.every((esperada, indice) =>
        esperada.every((valor, campo) => existentes[indice][campo] === valor))
    );
    if (!coincide) {
      throw new Error(
        `C1 durable: ${codigo} columnas=${JSON.stringify(existentes)}`,
      );
    }
  }

  _validarDefinicionTabla(tabla, fragmentos, codigo) {
    const row = this._db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(tabla);
    const normalizado = String(row && row.sql || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .trim()
      .toLowerCase();
    if (!row || !fragmentos.every(fragmento => normalizado.includes(fragmento))) {
      throw new Error(`C1 durable: ${codigo} definicion=${normalizado || 'ausente'}`);
    }
  }

  _validarIndiceExacto({
    tabla, nombre, columnas, parcial, clausulaWhere,
  }) {
    const indice = this._db.prepare(`PRAGMA index_list('${tabla}')`).all()
      .find(row => row.name === nombre);
    const existentes = indice
      ? this._db.prepare(`PRAGMA index_info('${nombre}')`).all().map(row => row.name)
      : [];
    const sql = indice
      ? this._db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(nombre)
      : null;
    const normalizado = String(sql && sql.sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const whereValido = !parcial || (
      normalizado.includes(clausulaWhere)
      && normalizado.slice(normalizado.indexOf(' where ') + 7).trim()
        === clausulaWhere.replace(/^where\s+/, '')
    );
    if (
      !indice
      || indice.unique !== 1
      || Boolean(indice.partial) !== parcial
      || existentes.length !== columnas.length
      || !columnas.every((columna, index) => existentes[index] === columna)
      || !whereValido
    ) {
      throw new Error(
        'C1 durable: MIGRACION_INDICE_ACTIVACIONES_INCOMPATIBLE ' +
        `indice=${nombre} unique=${indice ? indice.unique : 'ausente'} ` +
        `partial=${indice ? indice.partial : 'ausente'} ` +
        `columnas=${existentes.join(',') || 'ninguna'}`,
      );
    }
  }

  _derivarCabezaMigracion(sesionId) {
    const filas = this._db.prepare(`
      SELECT * FROM destino_afirmaciones_transformacionales
       WHERE sesion_id = ? AND estado_normativo = 'AUTORIZADA'
    `).all(sesionId);
    const autorizadas = new Map();
    const errores = [];
    for (const fila of filas) {
      let contenido;
      try {
        contenido = JSON.parse(fila.contenido_json);
      } catch {
        errores.push(`${fila.afirmacion_id}:snapshot-inválido`);
        continue;
      }
      const materializacion = this._db.prepare(`
        SELECT * FROM destino_afirmacion_materializaciones WHERE afirmacion_id = ?
      `).get(fila.afirmacion_id);
      const veredicto = this._db.prepare(`
        SELECT * FROM destino_afirmacion_veredictos WHERE afirmacion_id = ?
      `).get(fila.afirmacion_id);
      let veredictoContenido;
      let materializacionContenido;
      try {
        veredictoContenido = veredicto ? JSON.parse(veredicto.contenido_json) : null;
        materializacionContenido =
          materializacion ? JSON.parse(materializacion.contenido_json) : null;
      } catch {
        veredictoContenido = null;
        materializacionContenido = null;
      }
      const validacion = schema.validarAfirmacionTransformacionalDestino(contenido);
      if (
        serializarCanonico(contenido) !== fila.contenido_json
        || !validacion.valid
        || contenido.id !== fila.afirmacion_id
        || contenido.version !== fila.version
        || contenido.estado !== 'AUTORIZADA'
        || (contenido.reemplazaAId || null) !== (fila.reemplaza_a_id || null)
        || !materializacion
        || materializacion.sesion_id !== sesionId
        || !materializacionContenido
        || serializarCanonico(materializacionContenido) !== materializacion.contenido_json
        || materializacionContenido.afirmacionId !== fila.afirmacion_id
        || materializacionContenido.estadoPrevio !== 'PROPUESTA'
        || materializacionContenido.estadoPosterior !== 'MATERIALIZADA_PENDIENTE'
        || !veredicto
        || veredicto.sesion_id !== sesionId
        || !veredictoContenido
        || serializarCanonico(veredictoContenido) !== veredicto.contenido_json
        || veredictoContenido.id !== veredicto.registro_id
        || veredictoContenido.afirmacionId !== fila.afirmacion_id
        || veredictoContenido.version !== fila.version
        || veredictoContenido.tipo !== 'CONFIRMACION_EXPLICITA'
      ) {
        errores.push(`${fila.afirmacion_id}:causa-autorización-inválida`);
        continue;
      }
      autorizadas.set(fila.afirmacion_id, {
        id: fila.afirmacion_id,
        version: fila.version,
        reemplazaAId: fila.reemplaza_a_id,
        registroVeredictoId: veredicto.registro_id,
      });
    }

    const hijosAutorizados = new Map();
    const raices = [];
    for (const afirmacion of autorizadas.values()) {
      if (!afirmacion.reemplazaAId) {
        raices.push(afirmacion);
        continue;
      }
      const anterior = autorizadas.get(afirmacion.reemplazaAId);
      const sucesion = this._db.prepare(`
        SELECT * FROM destino_afirmacion_sucesiones
         WHERE sesion_id = ? AND afirmacion_sucesora_id = ?
      `).get(sesionId, afirmacion.id);
      const roundTrip = sucesion
        ? this._db.prepare(`
          SELECT * FROM destino_afirmacion_resultados_roundtrip
           WHERE registro_id = ?
        `).get(sucesion.registro_roundtrip_id)
        : null;
      let sucesionContenido;
      let roundTripContenido;
      try {
        sucesionContenido = sucesion ? JSON.parse(sucesion.contenido_json) : null;
        roundTripContenido = roundTrip ? JSON.parse(roundTrip.contenido_json) : null;
      } catch {
        sucesionContenido = null;
        roundTripContenido = null;
      }
      if (
        !anterior
        || !sucesion
        || sucesion.afirmacion_anterior_id !== afirmacion.reemplazaAId
        || !sucesionContenido
        || serializarCanonico(sucesionContenido) !== sucesion.contenido_json
        || sucesionContenido.afirmacionAnteriorId !== afirmacion.reemplazaAId
        || sucesionContenido.reemplazaAId !== afirmacion.reemplazaAId
        || sucesionContenido.versionPropuesta !== afirmacion.version
        || !roundTrip
        || roundTrip.sesion_id !== sesionId
        || roundTrip.afirmacion_id !== afirmacion.reemplazaAId
        || !roundTripContenido
        || serializarCanonico(roundTripContenido) !== roundTrip.contenido_json
        || roundTripContenido.resultado !== 'CORRECCION_SEMANTICA'
        || afirmacion.version !== anterior.version + 1
      ) {
        errores.push(`${afirmacion.id}:sucesión-autorizada-inválida`);
        continue;
      }
      const hijos = hijosAutorizados.get(anterior.id) || [];
      hijos.push(afirmacion);
      hijosAutorizados.set(anterior.id, hijos);
    }
    for (const [anteriorId, hijos] of hijosAutorizados) {
      if (hijos.length > 1) errores.push(`${anteriorId}:bifurcación-autorizada`);
    }
    const extremos = [...autorizadas.values()].filter(
      afirmacion => !(hijosAutorizados.get(afirmacion.id) || []).length,
    );
    if (raices.length !== 1 || extremos.length !== 1 || errores.length > 0) {
      throw new Error(
        'C1 durable: MIGRACION_VIGENCIA_DESTINO_AMBIGUA ' +
        `sesionId=${sesionId} raices=${raices.map(item => item.id).join(',') || 'ninguna'} ` +
        `extremos=${extremos.map(item => item.id).join(',') || 'ninguno'} ` +
        `causas=${errores.join(',') || 'estructura-competidora'}`,
      );
    }
    return extremos;
  }

  save(afirmacion, { sesionId } = {}) {
    validarContextoSesion(sesionId);
    const validacion = schema.validarAfirmacionTransformacionalDestino(afirmacion);
    if (!validacion.valid) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository.save: entidad inválida — ${validacion.errors.join('; ')}`,
      );
    }
    const contenidoCanonico = serializarCanonico(afirmacion);
    const existente = this._stmtByGlobalId.get(afirmacion.id);
    if (existente) {
      if (existente.sesion_id !== sesionId) {
        throw new Error(
          `SqliteAfirmacionTransformacionalDestinoRepository: AFIRMACION_PERTENECE_A_OTRA_SESION ${afirmacion.id}`,
        );
      }
      this._asegurarEquivalencia(existente, afirmacion, contenidoCanonico);
      runtime.acreditarEntidadParaPersistenciaInterna({ entidad: afirmacion, sesionId });
      return afirmacion;
    }
    if (afirmacion.estado !== 'PROPUESTA') {
      throw new Error(
        'SqliteAfirmacionTransformacionalDestinoRepository.save: ESTADO_INICIAL_DEBE_SER_PROPUESTA',
      );
    }
    // El primer compromiso continúa siendo una frontera aislada, todavía no
    // autenticada por sesión productiva. Desde B solo puede introducir una
    // PROPUESTA; todo estado posterior exige su operación causal.
    runtime.acreditarEntidadParaPersistenciaInterna({ entidad: afirmacion, sesionId });
    this._verificarSucesionDurable(afirmacion, sesionId);

    try {
      this._stmtInsert.run(
        sesionId,
        afirmacion.id,
        afirmacion.version,
        afirmacion.estado,
        afirmacion.reemplazaAId || null,
        SCHEMA_VERSION,
        contenidoCanonico,
      );
    } catch (error) {
      if (!String(error && error.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
      const concurrente = this._stmtByGlobalId.get(afirmacion.id);
      if (!concurrente) throw error;
      if (concurrente.sesion_id !== sesionId) {
        throw new Error(
          `SqliteAfirmacionTransformacionalDestinoRepository: AFIRMACION_PERTENECE_A_OTRA_SESION ${afirmacion.id}`,
        );
      }
      this._asegurarEquivalencia(concurrente, afirmacion, contenidoCanonico);
    }
    return afirmacion;
  }

  findById(sesionId, afirmacionId) {
    validarContextoSesion(sesionId);
    if (typeof afirmacionId !== 'string' || !afirmacionId.trim()) {
      throw new Error(
        'SqliteAfirmacionTransformacionalDestinoRepository.findById: afirmacionId es requerido',
      );
    }
    const row = this._stmtById.get(sesionId, afirmacionId);
    return row ? this._rehidratar(row) : null;
  }

  listBySession(sesionId) {
    validarContextoSesion(sesionId);
    return Object.freeze(this._stmtBySession.all(sesionId).map(row => this._rehidratar(row)));
  }

  countBySession(sesionId) {
    validarContextoSesion(sesionId);
    return this._stmtCountBySession.get(sesionId).n;
  }

  findHeadBySession(sesionId) {
    validarContextoSesion(sesionId);
    const head = this._stmtHeadBySession.get(sesionId);
    const historia = this._leerHistoriaVigenciaValidada(sesionId, head);
    if (!head) return null;
    const afirmacion = this.findById(sesionId, head.afirmacion_id);
    if (!afirmacion || afirmacion.estado !== 'AUTORIZADA') {
      throw new Error('C1 durable: CABEZA_VIGENTE_INCOHERENTE');
    }
    return congelarLectura({
      sesionId,
      afirmacion,
      revisionCabeza: head.revision_cabeza,
    });
  }

  listActivationHistory(sesionId) {
    validarContextoSesion(sesionId);
    return this._leerHistoriaVigenciaValidada(
      sesionId,
      this._stmtHeadBySession.get(sesionId),
    );
  }

  commitMaterialization({ sesionId, fotografiaAnterior, fotografiaResultante } = {}) {
    this._exigirTransaccion('commitMaterialization');
    const registro = runtime.obtenerMaterializacionParaPersistenciaInterna({
      anterior: fotografiaAnterior,
      resultante: fotografiaResultante,
    });
    if (!registro) throw new Error('C1 durable: MATERIALIZACION_SIN_INTEGRIDAD_PROCESS_LOCAL');
    return this._commitTransition({
      sesionId,
      fotografiaAnterior,
      fotografiaResultante,
      registro,
      causal: 'materializacion',
      columnas: {
        registro_id: registro.id,
        sesion_id: sesionId,
        afirmacion_id: fotografiaAnterior.id,
        contenido_json: serializarCanonico(registro),
      },
    });
  }

  commitVerdict({
    sesionId, fotografiaAnterior, registroVeredicto, fotografiaResultante,
    cabezaEsperadaId, revisionCabezaEsperada,
  } = {}) {
    this._exigirTransaccion('commitVerdict');
    const registro = runtime.obtenerVeredictoParaPersistenciaInterna({
      anterior: fotografiaAnterior,
      registroVeredicto,
      resultante: fotografiaResultante,
    });
    if (!registro) throw new Error('C1 durable: VEREDICTO_SIN_INTEGRIDAD_PROCESS_LOCAL');
    const estadosPorVeredicto = {
      CONFIRMACION_EXPLICITA: 'AUTORIZADA',
      RECHAZO_EXPLICITO: 'RECHAZADA',
    };
    const esperado = estadosPorVeredicto[registro.tipo];
    if (!esperado) throw new Error('C1 durable: TIPO_VEREDICTO_NO_SOPORTADO');
    if (fotografiaResultante.estado !== esperado) {
      throw new Error('C1 durable: VEREDICTO_Y_RESULTADO_INCOHERENTES');
    }
    if (esperado === 'AUTORIZADA') {
      return this._commitAuthorizationWithHead({
        sesionId,
        fotografiaAnterior,
        fotografiaResultante,
        registro,
        cabezaEsperadaId,
        revisionCabezaEsperada,
      });
    }
    return this._commitTransition({
      sesionId,
      fotografiaAnterior,
      fotografiaResultante,
      registro,
      causal: 'veredicto',
      columnas: {
        registro_id: registro.id,
        sesion_id: sesionId,
        afirmacion_id: fotografiaAnterior.id,
        contenido_json: serializarCanonico(registro),
      },
    });
  }

  /**
   * C6-vertical-2 (preservación de identidad en sustitución preautorización
   * de cabeza) — operación DISTINTA de commitSuccessor, para el acto de
   * dominio exacto: H es la cabeza vigente, B es una MATERIALIZADA_PENDIENTE
   * cuya fotografía normativa (cabezaBaseId/cabezaBaseRevision) ya apuntaba
   * a H desde su nacimiento, y el usuario confirma B. La MISMA B — mismo id,
   * misma version, misma fotografía — pasa a AUTORIZADA y sustituye a H como
   * cabeza. Nunca crea una entidad nueva, nunca usa
   * destino_afirmacion_sucesiones (esa tabla prueba una corrección
   * POST-autorización real, con presentación y round-trip genuinos — aquí no
   * existe ninguno de los dos). La prueba de genealogía vive, de forma
   * durable, en la propia fila de B (reemplazaAId + cabezaBaseId/
   * cabezaBaseRevision, ya validados por el schema).
   *
   * El CAS es el mismo primitivo que usa _commitAuthorizationWithHead
   * (_stmtReplaceHead), aplicado contra cabezaEsperadaId/
   * revisionCabezaEsperada — si la cabeza cambió mientras tanto, falla con
   * CAS_CABEZA_NO_COINCIDE y toda la transacción se revierte: B permanece
   * MATERIALIZADA_PENDIENTE, sin reemplazaAId persistido, H sigue cabeza.
   *
   * H nunca se muta: igual que en _commitAuthorizationWithHead, solo se
   * mueve el puntero de destino_afirmacion_cabezas y se añade una fila de
   * historial en destino_afirmacion_activaciones — la propia fila de H
   * (estado_normativo) permanece AUTORIZADA para siempre.
   */
  commitAuthorizationReplacingHead({
    sesionId, fotografiaAnterior, registroVeredicto, fotografiaResultante,
    cabezaEsperadaId, revisionCabezaEsperada,
  } = {}) {
    this._exigirTransaccion('commitAuthorizationReplacingHead');
    validarContextoSesion(sesionId);
    const registro = runtime.obtenerVeredictoParaPersistenciaInterna({
      anterior: fotografiaAnterior,
      registroVeredicto,
      resultante: fotografiaResultante,
    });
    if (!registro) throw new Error('C1 durable: VEREDICTO_SIN_INTEGRIDAD_PROCESS_LOCAL');
    if (registro.tipo !== 'CONFIRMACION_EXPLICITA') {
      throw new Error('C1 durable: TIPO_VEREDICTO_NO_SOPORTADO_PARA_REEMPLAZO_PREAUTORIZACION');
    }
    if (fotografiaResultante.estado !== 'AUTORIZADA') {
      throw new Error('C1 durable: VEREDICTO_Y_RESULTADO_INCOHERENTES');
    }
    if (
      fotografiaAnterior.id !== fotografiaResultante.id
      || fotografiaAnterior.version !== fotografiaResultante.version
    ) throw new Error('C1 durable: IDENTIDAD_DE_TRANSICION_INCOHERENTE');
    if (
      !cabezaEsperadaId
      || !Number.isInteger(revisionCabezaEsperada)
      || revisionCabezaEsperada < 1
      || fotografiaAnterior.cabezaBaseId !== cabezaEsperadaId
      || fotografiaAnterior.cabezaBaseRevision !== revisionCabezaEsperada
      || fotografiaResultante.cabezaBaseId !== cabezaEsperadaId
      || fotografiaResultante.cabezaBaseRevision !== revisionCabezaEsperada
      || fotografiaResultante.reemplazaAId !== cabezaEsperadaId
    ) throw new Error('C1 durable: CABEZA_BASE_INCOHERENTE');

    const columnasVeredicto = {
      registro_id: registro.id,
      sesion_id: sesionId,
      afirmacion_id: fotografiaAnterior.id,
      contenido_json: serializarCanonico(registro),
    };
    const activacionId = `activacion_destino:${encodeURIComponent(registro.id)}`;
    const revisionResultante = revisionCabezaEsperada + 1;
    const activacion = {
      activacionId,
      sesionId,
      tipo: 'REEMPLAZO_PREAUTORIZACION',
      afirmacionAnteriorId: cabezaEsperadaId,
      afirmacionNuevaId: fotografiaResultante.id,
      registroVeredictoId: registro.id,
      revisionAnterior: revisionCabezaEsperada,
      revisionResultante,
      origen: 'VEREDICTO_C1',
    };

    const actual = this._stmtByGlobalId.get(fotografiaAnterior.id);
    if (!actual || actual.sesion_id !== sesionId) {
      throw new Error('C1 durable: AFIRMACION_NO_COMPROMETIDA_EN_SESION');
    }
    const antes = serializarCanonico(fotografiaAnterior);
    const despues = serializarCanonico(fotografiaResultante);
    const causalExistente = this._causales.veredicto.byId.get(registro.id);
    const activacionExistente = this._stmtActivationById.get(activacionId);
    const contenidoActivacion = serializarCanonico(activacion);

    if (actual.contenido_json === despues) {
      const cabeza = this._stmtHeadBySession.get(sesionId);
      if (
        !causalExistente
        || causalExistente.contenido_json !== columnasVeredicto.contenido_json
        || !activacionExistente
        || activacionExistente.contenido_json !== contenidoActivacion
        || !cabeza
        || cabeza.afirmacion_id !== fotografiaResultante.id
        || cabeza.revision_cabeza !== revisionResultante
      ) throw new Error('C1 durable: AUTORIZACION_SIN_VIGENCIA_COHERENTE');
      return fotografiaResultante;
    }
    if (actual.contenido_json !== antes) {
      throw new Error('C1 durable: ESTADO_PREVIO_INESPERADO');
    }
    if (causalExistente || activacionExistente) {
      throw new Error('C1 durable: COLISION_DIVERGENTE_ACTIVACION');
    }

    this._guardarCausal('veredicto', registro.id, columnasVeredicto);
    const cambio = this._stmtUpdateSnapshot.run(
      fotografiaResultante.estado,
      despues,
      fotografiaResultante.reemplazaAId || null,
      sesionId,
      fotografiaAnterior.id,
      fotografiaAnterior.estado,
      antes,
    );
    if (cambio.changes !== 1) throw new Error('C1 durable: CONFLICTO_CONCURRENTE');

    const cambioCabeza = this._stmtReplaceHead.run(
      fotografiaResultante.id,
      sesionId,
      cabezaEsperadaId,
      revisionCabezaEsperada,
    );
    if (cambioCabeza.changes !== 1) {
      throw new Error('C1 durable: CAS_CABEZA_NO_COINCIDE');
    }

    this._stmtInsertActivation.run(
      activacionId,
      sesionId,
      activacion.tipo,
      activacion.afirmacionAnteriorId,
      activacion.afirmacionNuevaId,
      activacion.registroVeredictoId,
      activacion.revisionAnterior,
      activacion.revisionResultante,
      activacion.origen,
      contenidoActivacion,
    );
    runtime.acreditarEntidadParaPersistenciaInterna({
      entidad: fotografiaResultante, sesionId,
    });
    return fotografiaResultante;
  }

  /**
   * S1_R_INCREMENTO_4 — AUTORIZADA → SUPERADA: transición declarada en el
   * schema (TRANSICIONES_DECLARADAS.AUTORIZADA) desde su origen, nunca antes
   * exigida por ningún runtime — commitAuthorizationReplacingHead (arriba)
   * mueve la cabeza vigente vía CAS pero JAMÁS toca la fila de la Afirmación
   * reemplazada; su estado_normativo se quedaba en 'AUTORIZADA' para
   * siempre. Método deliberadamente SEPARADO de commitAuthorizationReplacingHead
   * (nunca fusionado): ese método también sirve la sustitución preautorización
   * de cabeza (C6-vertical-2 — arranque, cuando cabezaBaseId coincide por
   * timing, no por rechazo real) y NUNCA debe marcar nada como SUPERADA en
   * ese caso — solo el llamador productivo real (la resolución de una
   * reparación S1-R) decide cuándo esto aplica.
   *
   * Conserva `autorizacion` intacta (verdad histórica inmutable — ver
   * validarAutorizacion en el schema, extendido para aceptar SUPERADA) y
   * `origen`/`constituyentes`/`enlacesCausales` sin cambio alguno; solo
   * `estado` transiciona. CAS real contra el snapshot exacto ya persistido
   * — mismo patrón que el resto del repositorio, nunca una relectura
   * optimista sin verificación.
   */
  marcarAfirmacionSuperadaPorSucesion({ sesionId, afirmacionId, afirmacionSustitutaId } = {}) {
    this._exigirTransaccion('marcarAfirmacionSuperadaPorSucesion');
    validarContextoSesion(sesionId);
    if (typeof afirmacionId !== 'string' || !afirmacionId.trim()) {
      throw new Error('C1 durable: AFIRMACION_SUPERADA_ID_REQUERIDO');
    }
    if (typeof afirmacionSustitutaId !== 'string' || !afirmacionSustitutaId.trim()) {
      throw new Error('C1 durable: AFIRMACION_SUSTITUTA_REQUERIDA');
    }
    if (afirmacionSustitutaId === afirmacionId) {
      throw new Error('C1 durable: AFIRMACION_SUSTITUTA_NO_PUEDE_COINCIDIR_CON_LA_SUPERADA');
    }
    const afirmacion = this.findById(sesionId, afirmacionId);
    if (!afirmacion) throw new Error('C1 durable: AFIRMACION_SUPERADA_NO_ENCONTRADA');
    if (afirmacion.estado === 'SUPERADA') {
      // Idempotente: la MISMA transición ya ocurrió (retry/recuperación) —
      // nunca se re-aplica ni se trata como error.
      return afirmacion;
    }
    if (afirmacion.estado !== 'AUTORIZADA') {
      throw new Error(`C1 durable: ESTADO_PREVIO_INVALIDO_PARA_SUPERAR (${afirmacion.estado})`);
    }
    const antes = serializarCanonico(afirmacion);
    const siguiente = { ...afirmacion, estado: 'SUPERADA' };
    const validacion = schema.validarAfirmacionTransformacionalDestino(siguiente);
    if (!validacion.valid) {
      throw new Error(`C1 durable: AFIRMACION_SUPERADA_INVALIDA — ${validacion.errors.join('; ')}`);
    }
    const despues = serializarCanonico(siguiente);
    const cambio = this._stmtUpdateSnapshot.run(
      'SUPERADA', despues, siguiente.reemplazaAId || null,
      sesionId, afirmacionId, 'AUTORIZADA', antes,
    );
    if (cambio.changes !== 1) throw new Error('C1 durable: CONFLICTO_CONCURRENTE');
    // rehidratarEntidadComprometidaInterna (nunca acreditar a mano): revalida,
    // congela y registra en entidadesLegitimas — mismo primitivo de dominio
    // que _rehidratar ya usa en cada lectura; `siguiente` es un objeto NUEVO
    // (nunca el mismo que `afirmacion`, que _rehidratar ya había registrado),
    // así que acreditar directamente habría fallado (ENTIDAD_SIN_INTEGRIDAD_PROCESS_LOCAL).
    return runtime.rehidratarEntidadComprometidaInterna({ entidad: siguiente, sesionId });
  }

  saveRoundTripPresentation({ sesionId, afirmacion, presentacion } = {}) {
    this._exigirTransaccion('saveRoundTripPresentation');
    const registro = runtime.obtenerPresentacionParaPersistenciaInterna({
      afirmacion, presentacion,
    });
    if (!registro) throw new Error('C1 durable: PRESENTACION_SIN_INTEGRIDAD_PROCESS_LOCAL');
    this._asegurarEntidadComprometida(sesionId, afirmacion);
    const identidadEstructurada = runtime.obtenerIdentidadPresentacionParaPersistenciaInterna({
      sesionId, afirmacion, presentacion,
    });
    const id = identidadEstructurada || [
      'presentacion_roundtrip',
      encodeURIComponent(afirmacion.id),
      `v${afirmacion.version}`,
      encodeURIComponent(presentacion.turnoPresentacionId),
    ].join(':');
    const contenido = presentacion;
    this._guardarCausal('presentacion', id, {
      presentacion_id: id,
      sesion_id: sesionId,
      afirmacion_id: afirmacion.id,
      contenido_json: serializarCanonico(contenido),
    });
    return Object.freeze({ id, ...presentacion });
  }

  saveRoundTripResult({
    sesionId, afirmacion, presentacion, registroRoundTrip,
  } = {}) {
    this._exigirTransaccion('saveRoundTripResult');
    const registro = runtime.obtenerRoundTripParaPersistenciaInterna({
      afirmacion, presentacion, registroRoundTrip,
    });
    if (!registro) throw new Error('C1 durable: ROUNDTRIP_SIN_INTEGRIDAD_PROCESS_LOCAL');
    this._asegurarEntidadComprometida(sesionId, afirmacion);
    const identidadEstructurada = runtime.obtenerIdentidadPresentacionParaPersistenciaInterna({
      sesionId, afirmacion, presentacion,
    });
    const presentacionId = identidadEstructurada || [
      'presentacion_roundtrip',
      encodeURIComponent(afirmacion.id),
      `v${afirmacion.version}`,
      encodeURIComponent(presentacion.turnoPresentacionId),
    ].join(':');
    if (!this._causales.presentacion.byId.get(presentacionId)) {
      throw new Error('C1 durable: PRESENTACION_NO_PERSISTIDA');
    }
    const resultadoExistente = this._stmtRoundTripByPresentacion.get(presentacionId);
    if (resultadoExistente && resultadoExistente.registro_id !== registro.id) {
      throw new Error('C1 durable: PRESENTACION_YA_EVALUADA');
    }
    this._guardarCausal('roundtrip', registro.id, {
      registro_id: registro.id,
      sesion_id: sesionId,
      afirmacion_id: afirmacion.id,
      presentacion_id: presentacionId,
      contenido_json: serializarCanonico(registro),
    });
    return registro;
  }

  commitSuccessor({
    sesionId, afirmacionAnterior, presentacion, registroRoundTrip, propuestaSucesora,
  } = {}) {
    this._exigirTransaccion('commitSuccessor');
    const procedencia = runtime.obtenerSucesionParaPersistenciaInterna({
      afirmacionAnterior, presentacion, registroRoundTrip, propuestaSucesora,
    });
    if (!procedencia) throw new Error('C1 durable: SUCESION_SIN_INTEGRIDAD_PROCESS_LOCAL');
    this._asegurarEntidadComprometida(sesionId, afirmacionAnterior);
    if (!this._causales.roundtrip.byId.get(registroRoundTrip.id)) {
      throw new Error('C1 durable: ROUNDTRIP_CORRECTIVO_NO_PERSISTIDO');
    }
    if (
      propuestaSucesora.reemplazaAId !== afirmacionAnterior.id
      || propuestaSucesora.version !== afirmacionAnterior.version + 1
    ) throw new Error('C1 durable: CADENA_DE_SUCESION_INCOHERENTE');

    const existente = this._causales.sucesion.byId.get(registroRoundTrip.id);
    const contenido = serializarCanonico(procedencia);
    if (existente) {
      if (
        existente.sesion_id !== sesionId
        || existente.afirmacion_anterior_id !== afirmacionAnterior.id
        || existente.afirmacion_sucesora_id !== propuestaSucesora.id
        || existente.contenido_json !== contenido
      ) throw new Error('C1 durable: COLISION_DIVERGENTE_SUCESION');
      return propuestaSucesora;
    }
    this.save(propuestaSucesora, { sesionId });
    this._causales.sucesion.insert({
      registro_roundtrip_id: registroRoundTrip.id,
      sesion_id: sesionId,
      afirmacion_anterior_id: afirmacionAnterior.id,
      afirmacion_sucesora_id: propuestaSucesora.id,
      contenido_json: contenido,
    });
    return propuestaSucesora;
  }

  getCausalHistory(sesionId, afirmacionId) {
    this._asegurarFilaDeSesion(sesionId, afirmacionId);
    const leer = (tabla, columna = 'afirmacion_id') => this._db.prepare(
      `SELECT * FROM ${tabla} WHERE ${columna} = ? ORDER BY created_at, rowid`,
    ).all(afirmacionId);
    return Object.freeze({
      materializaciones: Object.freeze(leer('destino_afirmacion_materializaciones')
        .map(row => this._rehidratarMaterializacion(row))),
      veredictos: Object.freeze(leer('destino_afirmacion_veredictos')
        .map(row => this._rehidratarVeredicto(row))),
      presentaciones: Object.freeze(leer('destino_afirmacion_presentaciones_roundtrip')
        .map(row => this._rehidratarPresentacion(row))),
      roundTrips: Object.freeze(leer('destino_afirmacion_resultados_roundtrip')
        .map(row => this._rehidratarRoundTrip(row))),
      sucesionesOriginadas: Object.freeze(
        leer('destino_afirmacion_sucesiones', 'afirmacion_anterior_id')
          .map(row => this._rehidratarSucesion(row)),
      ),
    });
  }

  // ── S1_R_INCREMENTO_1 — reparación transformacional ──────────────────────
  // Ninguna de estas operaciones decide protocolo, produce mensajes ni abre
  // Hipótesis — persistencia pura, con las mismas garantías de identidad y
  // fallo cerrado que el resto del repositorio. Las de escritura exigen
  // transacción (CognitiveUnitOfWork.ejecutar); las de lectura no, para
  // poder consultarse fuera de transacción igual que findHeadBySession/
  // getCausalHistory (necesario para producirSintesisDestinoAutorizadaDesdeRepositorio,
  // que corre en la fase "fuera de transacción" del Writer).

  _reparacionS1RId({ sesionId, afirmacionOrigenId, afirmacionOrigenVersion }) {
    return [
      'reparacion_s1r', encodeURIComponent(sesionId),
      encodeURIComponent(afirmacionOrigenId), `v${afirmacionOrigenVersion}`,
    ].join(':');
  }

  /**
   * Abre (o recupera idempotentemente) la reparación S1-R de una Afirmación
   * AUTORIZADA. Identidad determinística por (sesionId, afirmacionOrigenId,
   * afirmacionOrigenVersion) — a lo sumo una fila por esa tripleta, sea cual
   * sea su estado. Una segunda apertura idéntica NUNCA crea una fila nueva
   * ni reescribe la existente (incluida una ya RESUELTA — nunca se reabre).
   */
  abrirReparacionS1R({
    sesionId, afirmacionOrigenId, afirmacionOrigenVersion, presentacionOrigenId,
    alcance, correccionDetalle, turnoId,
    // S1-R-SCOPE1 — 'mecanismo_resultado' | 'resultado_observabilidad' | null
    // (default). Nunca validado contra un catálogo aquí — el llamador
    // (InteraccionCognitivaWriter.js) ya lo valida contra el mismo
    // COMPONENTES_RELACIONALES que VALIDANDO_RELACION_TRANSFORMACIONAL usa;
    // este repositorio solo persiste lo que recibe, como con correccionDetalle.
    componenteRelacional = null,
  } = {}) {
    this._exigirTransaccion('abrirReparacionS1R');
    validarContextoSesion(sesionId);
    if (typeof afirmacionOrigenId !== 'string' || !afirmacionOrigenId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_AFIRMACION_ORIGEN_REQUERIDA');
    }
    if (!Number.isInteger(afirmacionOrigenVersion) || afirmacionOrigenVersion < 1) {
      throw new Error('C1 durable: REPARACION_S1R_VERSION_INVALIDA');
    }
    if (typeof presentacionOrigenId !== 'string' || !presentacionOrigenId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_PRESENTACION_ORIGEN_REQUERIDA');
    }
    // S1-R v1: único alcance autorizado (ver decisión de producto) — nunca
    // se infiere ni se acepta otro valor.
    if (alcance !== 'RELACION') {
      throw new Error('C1 durable: REPARACION_S1R_ALCANCE_INVALIDO');
    }
    if (typeof correccionDetalle !== 'string' || !correccionDetalle.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_CORRECCION_DETALLE_REQUERIDA');
    }
    if (typeof turnoId !== 'string' || !turnoId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_TURNO_REQUERIDO');
    }
    // Fail-closed: la Afirmación origen debe existir y pertenecer a esta
    // sesión — mismo guardia que el resto del repositorio.
    this._asegurarFilaDeSesion(sesionId, afirmacionOrigenId);

    const reparacionId = this._reparacionS1RId({ sesionId, afirmacionOrigenId, afirmacionOrigenVersion });
    const existente = this._stmtReparacionS1RById.get(reparacionId);
    if (existente) {
      if (
        existente.sesion_id !== sesionId
        || existente.afirmacion_origen_id !== afirmacionOrigenId
        || existente.afirmacion_origen_version !== afirmacionOrigenVersion
      ) throw new Error('C1 durable: REPARACION_S1R_IDENTIDAD_INCOHERENTE');
      // Idempotente: apertura repetida (o incluso ya RESUELTA) — nunca
      // reescribe, nunca reabre, nunca crea una segunda fila.
      return this._rehidratarReparacionS1R(existente);
    }
    this._stmtInsertReparacionS1R.run(
      reparacionId, sesionId, afirmacionOrigenId, afirmacionOrigenVersion,
      presentacionOrigenId, alcance, correccionDetalle, turnoId,
      componenteRelacional || null,
    );
    return this._rehidratarReparacionS1R(this._stmtReparacionS1RById.get(reparacionId));
  }

  /** Lectura pura — nunca exige transacción. `null` si no hay ninguna ABIERTA para esa identidad exacta. */
  findReparacionAbiertaPorAfirmacion(sesionId, afirmacionOrigenId, afirmacionOrigenVersion) {
    validarContextoSesion(sesionId);
    const row = this._stmtReparacionS1RAbiertaPorAfirmacion.get(afirmacionOrigenId, afirmacionOrigenVersion, 'ABIERTA');
    if (!row) return null;
    // Fail-closed: nunca cruza sesión, aunque el índice sea global.
    if (row.sesion_id !== sesionId) return null;
    return this._rehidratarReparacionS1R(row);
  }

  /** Lectura pura — nunca exige transacción. */
  findReparacionPorId(sesionId, reparacionId) {
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) return null;
    const row = this._stmtReparacionS1RById.get(reparacionId);
    if (!row || row.sesion_id !== sesionId) return null;
    return this._rehidratarReparacionS1R(row);
  }

  /** Lectura durable de todas las reparaciones S1-R ABIERTAS de una sesión. */
  findReparacionesAbiertasPorSesion(sesionId) {
    validarContextoSesion(sesionId);
    return this._db.prepare(`
      SELECT * FROM destino_afirmacion_reparaciones_s1r
       WHERE sesion_id = ? AND estado = 'ABIERTA'
       ORDER BY created_at, rowid
    `).all(sesionId).map(row => this._rehidratarReparacionS1R(row));
  }

  /**
   * Marca una reparación ABIERTA como RESUELTA, enlazándola a la Afirmación
   * sucesora ya AUTORIZADA. Idempotente: reenviar la misma resolución exacta
   * es un no-op; una resolución divergente (otra sucesora) falla cerrado —
   * nunca sobrescribe. No implementa ni exige la sucesión en sí — el
   * llamador ya debe traer `afirmacionSucesoraId` real y persistido (ver
   * `_asegurarFilaDeSesion` más abajo, mismo guardia que el resto del
   * repositorio).
   *
   * S1_R_INCREMENTO_4 — primer llamador productivo: `turnoId` (nuevo,
   * opcional — preserva byte a byte las llamadas del Incremento 1 que no lo
   * traían) es el turno REAL en el que el experto confirmó la Hipótesis
   * sucesora — trazabilidad causal mínima que faltaba (`resuelta_en` ya
   * existía como timestamp, sin turno). `null` cuando el llamador no lo trae.
   */
  resolverReparacionS1R({
    sesionId, reparacionId, afirmacionSucesoraId, turnoId = null,
  } = {}) {
    this._exigirTransaccion('resolverReparacionS1R');
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_ID_REQUERIDO');
    }
    if (typeof afirmacionSucesoraId !== 'string' || !afirmacionSucesoraId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_SUCESORA_REQUERIDA');
    }
    if (turnoId !== null && (typeof turnoId !== 'string' || !turnoId.trim())) {
      throw new Error('C1 durable: REPARACION_S1R_TURNO_RESOLUCION_INVALIDO');
    }
    const existente = this._stmtReparacionS1RById.get(reparacionId);
    if (!existente || existente.sesion_id !== sesionId) {
      throw new Error('C1 durable: REPARACION_S1R_NO_ENCONTRADA');
    }
    if (existente.estado === 'RESUELTA') {
      if (existente.afirmacion_sucesora_id !== afirmacionSucesoraId) {
        throw new Error('C1 durable: REPARACION_S1R_YA_RESUELTA_CON_OTRA_SUCESORA');
      }
      return this._rehidratarReparacionS1R(existente);
    }
    this._asegurarFilaDeSesion(sesionId, afirmacionSucesoraId);
    this._stmtResolverReparacionS1R.run(afirmacionSucesoraId, turnoId, reparacionId);
    return this._rehidratarReparacionS1R(this._stmtReparacionS1RById.get(reparacionId));
  }

  /**
   * Registra, de forma append-only, que una Hipótesis candidata a sucesora
   * fue rechazada dentro de una reparación ABIERTA. Cada rechazo es un hecho
   * causal independiente (nunca un array mutable dentro de la reparación) —
   * identidad determinística por (reparacionId, hipotesisId, hipotesisVersion),
   * idempotente ante retry.
   *
   * S1_R_INCREMENTO_3 — `roles` (opcional, `{inicioConceptoIds, ...}`) se
   * persiste como `roles_json` cuando el llamador lo trae: es lo mínimo que
   * permite, tras un reinicio, reconstruir la memoria negativa real
   * (huellasRechazadas, process-local) reproduciendo la MISMA construcción
   * + rechazo deterministas — nunca comparación de texto, nunca un campo
   * nuevo en el schema de Hipótesis. `null` (default) preserva el contrato
   * exacto del Incremento 1 — la llamada directa desde pruebas de ese
   * incremento sigue funcionando sin cambios.
   */
  registrarHipotesisSucesoraRechazada({
    sesionId, reparacionId, hipotesisId, hipotesisVersion, turnoId, correccionDetalle = null, roles = null,
  } = {}) {
    this._exigirTransaccion('registrarHipotesisSucesoraRechazada');
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_ID_REQUERIDO');
    }
    const reparacion = this._stmtReparacionS1RById.get(reparacionId);
    if (!reparacion || reparacion.sesion_id !== sesionId) {
      throw new Error('C1 durable: REPARACION_S1R_NO_ENCONTRADA');
    }
    if (typeof hipotesisId !== 'string' || !hipotesisId.trim()) {
      throw new Error('C1 durable: SUCESORA_RECHAZADA_HIPOTESIS_ID_REQUERIDO');
    }
    if (!Number.isInteger(hipotesisVersion) || hipotesisVersion < 1) {
      throw new Error('C1 durable: SUCESORA_RECHAZADA_HIPOTESIS_VERSION_INVALIDA');
    }
    if (typeof turnoId !== 'string' || !turnoId.trim()) {
      throw new Error('C1 durable: SUCESORA_RECHAZADA_TURNO_REQUERIDO');
    }
    const rolesJson = roles ? serializarCanonico(roles) : null;
    const registroId = [
      's1r_sucesora_rechazada', reparacionId, encodeURIComponent(hipotesisId), `v${hipotesisVersion}`,
    ].join(':');
    const existente = this._stmtSucesoraRechazadaS1RById.get(registroId);
    if (existente) return this._rehidratarSucesoraRechazadaS1R(existente);
    this._stmtInsertSucesoraRechazadaS1R.run(
      registroId, reparacionId, hipotesisId, hipotesisVersion, turnoId, correccionDetalle, rolesJson,
    );
    return this._rehidratarSucesoraRechazadaS1R(this._stmtSucesoraRechazadaS1RById.get(registroId));
  }

  /** Lectura pura — nunca exige transacción. Orden causal (created_at, rowid). */
  listarHipotesisSucesorasRechazadas(sesionId, reparacionId) {
    validarContextoSesion(sesionId);
    const reparacion = this._stmtReparacionS1RById.get(reparacionId);
    if (!reparacion || reparacion.sesion_id !== sesionId) return Object.freeze([]);
    return Object.freeze(
      this._stmtSucesorasRechazadasS1RPorReparacion.all(reparacionId)
        .map(row => this._rehidratarSucesoraRechazadaS1R(row)),
    );
  }

  /**
   * S1_R_INCREMENTO_3 — registra durablemente cuál Hipótesis sucesora está
   * actualmente CANDIDATA (pendiente de veredicto) para esta reparación —
   * a lo sumo una a la vez, invariante que el llamador garantiza (nunca
   * llama esto mientras otra sigue sin resolver, ver orquestación). `roles`
   * es lo mínimo necesario para, tras un reinicio, re-derivar la misma
   * Hipótesis (misma construcción determinista) sin depender de
   * emisionesLegitimas (process-local, ver auditoría previa) — nunca un
   * snapshot completo, nunca un campo nuevo en el schema de Hipótesis.
   */
  registrarHipotesisSucesoraCandidata({
    sesionId, reparacionId, hipotesisId, hipotesisVersion, roles, turnoPresentacionId,
  } = {}) {
    this._exigirTransaccion('registrarHipotesisSucesoraCandidata');
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_ID_REQUERIDO');
    }
    if (typeof hipotesisId !== 'string' || !hipotesisId.trim()) {
      throw new Error('C1 durable: SUCESORA_CANDIDATA_HIPOTESIS_ID_REQUERIDO');
    }
    if (!Number.isInteger(hipotesisVersion) || hipotesisVersion < 1) {
      throw new Error('C1 durable: SUCESORA_CANDIDATA_HIPOTESIS_VERSION_INVALIDA');
    }
    if (!roles || typeof roles !== 'object') {
      throw new Error('C1 durable: SUCESORA_CANDIDATA_ROLES_REQUERIDOS');
    }
    if (typeof turnoPresentacionId !== 'string' || !turnoPresentacionId.trim()) {
      throw new Error('C1 durable: SUCESORA_CANDIDATA_TURNO_PRESENTACION_REQUERIDO');
    }
    const reparacion = this._stmtReparacionS1RById.get(reparacionId);
    if (!reparacion || reparacion.sesion_id !== sesionId) {
      throw new Error('C1 durable: REPARACION_S1R_NO_ENCONTRADA');
    }
    if (reparacion.estado !== 'ABIERTA') {
      throw new Error('C1 durable: REPARACION_S1R_NO_ABIERTA');
    }
    const resultado = this._stmtRegistrarHipotesisSucesoraCandidataS1R.run(
      hipotesisId, hipotesisVersion, serializarCanonico(roles), turnoPresentacionId, reparacionId, sesionId,
    );
    if (resultado.changes !== 1) {
      throw new Error('C1 durable: SUCESORA_CANDIDATA_NO_ACTUALIZADA');
    }
    return this._rehidratarReparacionS1R(this._stmtReparacionS1RById.get(reparacionId));
  }

  /**
   * S1_R_INCREMENTO_3 — limpia el slot de candidata pendiente (tras un
   * rechazo ya registrado en registrarHipotesisSucesoraRechazada, en la
   * MISMA transacción) — nunca resuelve R, nunca toca afirmacion_sucesora_id.
   */
  limpiarHipotesisSucesoraCandidata({ sesionId, reparacionId } = {}) {
    this._exigirTransaccion('limpiarHipotesisSucesoraCandidata');
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) {
      throw new Error('C1 durable: REPARACION_S1R_ID_REQUERIDO');
    }
    const reparacion = this._stmtReparacionS1RById.get(reparacionId);
    if (!reparacion || reparacion.sesion_id !== sesionId) {
      throw new Error('C1 durable: REPARACION_S1R_NO_ENCONTRADA');
    }
    this._stmtLimpiarHipotesisSucesoraCandidataS1R.run(reparacionId, sesionId);
    return this._rehidratarReparacionS1R(this._stmtReparacionS1RById.get(reparacionId));
  }

  /** Lectura pura — nunca exige transacción. `null` si no hay candidata pendiente. */
  obtenerHipotesisSucesoraCandidata(sesionId, reparacionId) {
    validarContextoSesion(sesionId);
    if (typeof reparacionId !== 'string' || !reparacionId.trim()) return null;
    const row = this._stmtReparacionS1RById.get(reparacionId);
    if (!row || row.sesion_id !== sesionId) return null;
    if (!row.hipotesis_sucesora_id || row.estado !== 'ABIERTA') return null;
    return congelarLectura({
      hipotesisId: row.hipotesis_sucesora_id,
      hipotesisVersion: row.hipotesis_sucesora_version,
      roles: JSON.parse(row.hipotesis_sucesora_roles_json),
      turnoPresentacionId: row.hipotesis_sucesora_turno_presentacion_id,
    });
  }

  _rehidratarReparacionS1R(row) {
    return congelarLectura({
      reparacionId: row.reparacion_id,
      sesionId: row.sesion_id,
      afirmacionOrigenId: row.afirmacion_origen_id,
      afirmacionOrigenVersion: row.afirmacion_origen_version,
      presentacionOrigenId: row.presentacion_origen_id,
      alcance: row.alcance,
      correccionDetalle: row.correccion_detalle,
      // S1-R-SCOPE1 — null en filas anteriores a este incremento, o cuando
      // el veredicto que abrió la reparación no lo declaró.
      componenteRelacional: row.componente_relacional || null,
      abiertaEnTurnoId: row.abierta_en_turno_id,
      estado: row.estado,
      hipotesisSucesoraId: row.hipotesis_sucesora_id,
      hipotesisSucesoraVersion: row.hipotesis_sucesora_version,
      hipotesisSucesoraRoles: row.hipotesis_sucesora_roles_json ? JSON.parse(row.hipotesis_sucesora_roles_json) : null,
      hipotesisSucesoraTurnoPresentacionId: row.hipotesis_sucesora_turno_presentacion_id,
      afirmacionSucesoraId: row.afirmacion_sucesora_id,
      creadaEn: row.created_at,
      resueltaEn: row.resuelta_en,
      resueltaEnTurnoId: row.resuelta_en_turno_id,
    });
  }

  _rehidratarSucesoraRechazadaS1R(row) {
    return congelarLectura({
      registroId: row.registro_id,
      reparacionId: row.reparacion_id,
      hipotesisId: row.hipotesis_id,
      hipotesisVersion: row.hipotesis_version,
      rechazadaEnTurnoId: row.rechazada_en_turno_id,
      correccionDetalle: row.correccion_detalle,
      roles: row.roles_json ? JSON.parse(row.roles_json) : null,
      creadaEn: row.created_at,
    });
  }

  close() {
    if (this._ownsConnection) this._db.close();
  }

  get dbPath() {
    return this._dbPath;
  }

  _commitAuthorizationWithHead({
    sesionId,
    fotografiaAnterior,
    fotografiaResultante,
    registro,
    cabezaEsperadaId,
    revisionCabezaEsperada,
  }) {
    validarContextoSesion(sesionId);
    const esSucesora = !!fotografiaResultante.reemplazaAId;
    if (esSucesora) {
      if (
        cabezaEsperadaId !== fotografiaResultante.reemplazaAId
        || !Number.isInteger(revisionCabezaEsperada)
        || revisionCabezaEsperada < 1
      ) throw new Error('C1 durable: CABEZA_ESPERADA_INVALIDA');
      this._asegurarSucesionParaActivacion(
        sesionId, fotografiaResultante.reemplazaAId, fotografiaResultante.id,
      );
    } else if (cabezaEsperadaId !== null || revisionCabezaEsperada !== 0) {
      throw new Error('C1 durable: CABEZA_INICIAL_ESPERADA_INVALIDA');
    }

    const columnasVeredicto = {
      registro_id: registro.id,
      sesion_id: sesionId,
      afirmacion_id: fotografiaAnterior.id,
      contenido_json: serializarCanonico(registro),
    };
    const activacionId = `activacion_destino:${encodeURIComponent(registro.id)}`;
    const revisionResultante = esSucesora ? revisionCabezaEsperada + 1 : 1;
    const activacion = {
      activacionId,
      sesionId,
      tipo: esSucesora ? 'REEMPLAZO' : 'ACTIVACION_INICIAL',
      afirmacionAnteriorId: esSucesora ? cabezaEsperadaId : null,
      afirmacionNuevaId: fotografiaResultante.id,
      registroVeredictoId: registro.id,
      revisionAnterior: esSucesora ? revisionCabezaEsperada : 0,
      revisionResultante,
      origen: 'VEREDICTO_C1',
    };

    const actual = this._stmtByGlobalId.get(fotografiaAnterior.id);
    if (!actual || actual.sesion_id !== sesionId) {
      throw new Error('C1 durable: AFIRMACION_NO_COMPROMETIDA_EN_SESION');
    }
    const antes = serializarCanonico(fotografiaAnterior);
    const despues = serializarCanonico(fotografiaResultante);
    const causalExistente = this._causales.veredicto.byId.get(registro.id);
    const activacionExistente = this._stmtActivationById.get(activacionId);
    const contenidoActivacion = serializarCanonico(activacion);

    if (actual.contenido_json === despues) {
      const cabeza = this._stmtHeadBySession.get(sesionId);
      if (
        !causalExistente
        || causalExistente.contenido_json !== columnasVeredicto.contenido_json
        || !activacionExistente
        || activacionExistente.contenido_json !== contenidoActivacion
        || !cabeza
        || cabeza.afirmacion_id !== fotografiaResultante.id
        || cabeza.revision_cabeza !== revisionResultante
      ) throw new Error('C1 durable: AUTORIZACION_SIN_VIGENCIA_COHERENTE');
      return fotografiaResultante;
    }
    if (actual.contenido_json !== antes) {
      throw new Error('C1 durable: ESTADO_PREVIO_INESPERADO');
    }
    if (causalExistente || activacionExistente) {
      throw new Error('C1 durable: COLISION_DIVERGENTE_ACTIVACION');
    }

    this._guardarCausal('veredicto', registro.id, columnasVeredicto);
    const cambio = this._stmtUpdateSnapshot.run(
      fotografiaResultante.estado,
      despues,
      fotografiaResultante.reemplazaAId || null,
      sesionId,
      fotografiaAnterior.id,
      fotografiaAnterior.estado,
      antes,
    );
    if (cambio.changes !== 1) throw new Error('C1 durable: CONFLICTO_CONCURRENTE');

    const cambioCabeza = esSucesora
      ? this._stmtReplaceHead.run(
        fotografiaResultante.id,
        sesionId,
        cabezaEsperadaId,
        revisionCabezaEsperada,
      )
      : this._stmtInsertHead.run(sesionId, fotografiaResultante.id, sesionId);
    if (cambioCabeza.changes !== 1) {
      throw new Error('C1 durable: CAS_CABEZA_NO_COINCIDE');
    }

    this._stmtInsertActivation.run(
      activacionId,
      sesionId,
      activacion.tipo,
      activacion.afirmacionAnteriorId,
      activacion.afirmacionNuevaId,
      activacion.registroVeredictoId,
      activacion.revisionAnterior,
      activacion.revisionResultante,
      activacion.origen,
      contenidoActivacion,
    );
    runtime.acreditarEntidadParaPersistenciaInterna({
      entidad: fotografiaResultante, sesionId,
    });
    return fotografiaResultante;
  }

  _asegurarSucesionParaActivacion(sesionId, anteriorId, sucesoraId) {
    const sucesion = this._db.prepare(`
      SELECT * FROM destino_afirmacion_sucesiones
       WHERE sesion_id = ? AND afirmacion_anterior_id = ? AND afirmacion_sucesora_id = ?
    `).get(sesionId, anteriorId, sucesoraId);
    if (!sucesion) throw new Error('C1 durable: SUCESION_NO_COMPROMETIDA');
    this._rehidratarSucesion(sucesion);
  }

  _leerHistoriaVigenciaValidada(sesionId, head) {
    const rows = this._db.prepare(`
      SELECT * FROM destino_afirmacion_activaciones
       WHERE sesion_id = ?
       ORDER BY revision_resultante ASC, created_at ASC, activacion_id ASC
    `).all(sesionId);
    if (rows.length === 0) {
      if (head) throw new Error('C1 durable: HISTORIA_VIGENCIA_DESTINO_INCOHERENTE');
      return Object.freeze([]);
    }
    if (!head) throw new Error('C1 durable: HISTORIA_VIGENCIA_DESTINO_INCOHERENTE');

    const historia = rows.map(row => this._rehidratarActivacion(row));
    historia.forEach((activacion, index) => {
      if (index === 0) {
        if (
          activacion.tipo !== 'ACTIVACION_INICIAL'
          || activacion.afirmacionAnteriorId !== null
          || activacion.revisionAnterior !== 0
          || activacion.revisionResultante !== 1
        ) throw new Error('C1 durable: HISTORIA_VIGENCIA_DESTINO_INCOHERENTE');
        return;
      }
      const anterior = historia[index - 1];
      if (
        (activacion.tipo !== 'REEMPLAZO' && activacion.tipo !== 'REEMPLAZO_PREAUTORIZACION')
        || activacion.revisionAnterior !== anterior.revisionResultante
        || activacion.revisionResultante !== anterior.revisionResultante + 1
        || activacion.afirmacionAnteriorId !== anterior.afirmacionNuevaId
      ) throw new Error('C1 durable: HISTORIA_VIGENCIA_DESTINO_INCOHERENTE');
    });
    const ultima = historia[historia.length - 1];
    if (
      ultima.afirmacionNuevaId !== head.afirmacion_id
      || ultima.revisionResultante !== head.revision_cabeza
    ) throw new Error('C1 durable: HISTORIA_VIGENCIA_DESTINO_INCOHERENTE');
    return Object.freeze(historia);
  }

  _rehidratarActivacion(row) {
    const contenido = this._parsearCanonico(row, 'ACTIVACION');
    const cabezaNueva = this._asegurarFilaDeSesion(row.sesion_id, row.afirmacion_nueva_id);
    const tipos = new Set(['ACTIVACION_INICIAL', 'REEMPLAZO', 'REEMPLAZO_PREAUTORIZACION']);
    const origenes = new Set(['VEREDICTO_C1', 'MIGRACION_AB']);
    // S1_R_INCREMENTO_4 — cabezaNueva.estado_normativo también acepta
    // 'SUPERADA': un registro de activación describe un hecho HISTÓRICO
    // ("esta Afirmación fue instalada, legítimamente AUTORIZADA, en esta
    // revisión") — que una revisión posterior la haya superado (ver
    // marcarAfirmacionSuperadaPorSucesion) no lo deshace. Solo la ÚLTIMA
    // activación de la cadena debe apuntar a la cabeza REALMENTE vigente
    // hoy — eso ya lo exige, por separado, la comparación contra `head` más
    // abajo (ultima.afirmacionNuevaId/revisionResultante) — nunca esta
    // verificación por-fila, que es histórica, no de vigencia actual.
    if (
      contenido.activacionId !== row.activacion_id
      || contenido.sesionId !== row.sesion_id
      || contenido.tipo !== row.tipo
      || (contenido.afirmacionAnteriorId || null) !== (row.afirmacion_anterior_id || null)
      || contenido.afirmacionNuevaId !== row.afirmacion_nueva_id
      || (contenido.registroVeredictoId || null) !== (row.registro_veredicto_id || null)
      || contenido.revisionAnterior !== row.revision_anterior
      || contenido.revisionResultante !== row.revision_resultante
      || contenido.origen !== row.origen
      || !tipos.has(row.tipo)
      || !origenes.has(row.origen)
      || (cabezaNueva.estado_normativo !== 'AUTORIZADA' && cabezaNueva.estado_normativo !== 'SUPERADA')
      || row.revision_resultante !== row.revision_anterior + 1
    ) throw new Error('C1 durable: ACTIVACION_INCOHERENTE');
    this._validarVeredictoCausalActivacion(row);
    if (row.tipo === 'ACTIVACION_INICIAL' && row.afirmacion_anterior_id !== null) {
      throw new Error('C1 durable: ACTIVACION_INICIAL_CON_ANTERIOR');
    }
    if (row.tipo === 'REEMPLAZO' || row.tipo === 'REEMPLAZO_PREAUTORIZACION') {
      if (!row.afirmacion_anterior_id) throw new Error('C1 durable: REEMPLAZO_SIN_ANTERIOR');
      if (row.tipo === 'REEMPLAZO') {
        this._asegurarSucesionParaActivacion(
          row.sesion_id, row.afirmacion_anterior_id, row.afirmacion_nueva_id,
        );
      } else {
        // REEMPLAZO_PREAUTORIZACION: la genealogía normativa vive en la
        // propia afirmación nueva (reemplazaAId + cabezaBaseId/
        // cabezaBaseRevision, ya validados por el schema) — nunca requiere
        // una fila de sucesión post-round-trip, que describe un acto
        // domain-level distinto (ver commitAuthorizationReplacingHead).
        this._asegurarReemplazoPreautorizacionCoherente(
          row.sesion_id, row.afirmacion_anterior_id, row.afirmacion_nueva_id,
        );
      }
    }
    return congelarLectura(contenido);
  }

  _asegurarReemplazoPreautorizacionCoherente(sesionId, anteriorId, sucesoraId) {
    const fila = this._asegurarFilaDeSesion(sesionId, sucesoraId);
    const contenido = this._parsearCanonico(fila, 'AFIRMACION_SUCESORA_PREAUTORIZACION');
    if (
      contenido.reemplazaAId !== anteriorId
      || contenido.cabezaBaseId !== anteriorId
      || !Number.isInteger(contenido.cabezaBaseRevision)
      || contenido.cabezaBaseRevision < 1
    ) throw new Error('C1 durable: REEMPLAZO_PREAUTORIZACION_INCOHERENTE');
  }

  _validarVeredictoCausalActivacion(activacion) {
    if (!activacion.registro_veredicto_id) {
      throw new Error('C1 durable: ACTIVACION_SIN_VEREDICTO_CAUSAL_COHERENTE');
    }
    const veredicto = this._causales.veredicto.byId.get(
      activacion.registro_veredicto_id,
    );
    if (
      !veredicto
      || veredicto.registro_id !== activacion.registro_veredicto_id
      || veredicto.sesion_id !== activacion.sesion_id
      || veredicto.afirmacion_id !== activacion.afirmacion_nueva_id
    ) {
      throw new Error('C1 durable: ACTIVACION_SIN_VEREDICTO_CAUSAL_COHERENTE');
    }
    try {
      const contenido = this._rehidratarVeredicto(veredicto);
      if (
        contenido.tipo !== 'CONFIRMACION_EXPLICITA'
        || contenido.afirmacionId !== activacion.afirmacion_nueva_id
        || contenido.id !== activacion.registro_veredicto_id
      ) {
        throw new Error('veredicto incompatible');
      }
    } catch {
      throw new Error('C1 durable: ACTIVACION_SIN_VEREDICTO_CAUSAL_COHERENTE');
    }
  }

  _commitTransition({
    sesionId, fotografiaAnterior, fotografiaResultante, registro, causal, columnas,
  }) {
    validarContextoSesion(sesionId);
    if (
      fotografiaAnterior.id !== fotografiaResultante.id
      || fotografiaAnterior.version !== fotografiaResultante.version
    ) throw new Error('C1 durable: IDENTIDAD_DE_TRANSICION_INCOHERENTE');
    const actual = this._stmtByGlobalId.get(fotografiaAnterior.id);
    if (!actual || actual.sesion_id !== sesionId) {
      throw new Error('C1 durable: AFIRMACION_NO_COMPROMETIDA_EN_SESION');
    }
    const antes = serializarCanonico(fotografiaAnterior);
    const despues = serializarCanonico(fotografiaResultante);
    const causalExistente = this._causales[causal].byId.get(registro.id);
    if (causalExistente && causalExistente.contenido_json !== columnas.contenido_json) {
      throw new Error(`C1 durable: COLISION_DIVERGENTE_${causal.toUpperCase()}`);
    }
    if (actual.contenido_json === despues) {
      if (!causalExistente || causalExistente.contenido_json !== columnas.contenido_json) {
        throw new Error('C1 durable: ESTADO_SIN_CAUSA_COHERENTE');
      }
      return fotografiaResultante;
    }
    if (actual.contenido_json !== antes) throw new Error('C1 durable: ESTADO_PREVIO_INESPERADO');
    this._guardarCausal(causal, registro.id, columnas);
    const cambio = this._stmtUpdateSnapshot.run(
      fotografiaResultante.estado,
      despues,
      fotografiaResultante.reemplazaAId || null,
      sesionId,
      fotografiaAnterior.id,
      fotografiaAnterior.estado,
      antes,
    );
    if (cambio.changes !== 1) throw new Error('C1 durable: CONFLICTO_CONCURRENTE');
    runtime.acreditarEntidadParaPersistenciaInterna({
      entidad: fotografiaResultante, sesionId,
    });
    return fotografiaResultante;
  }

  _guardarCausal(tipo, id, columnas) {
    const existente = this._causales[tipo].byId.get(id);
    if (existente) {
      const coincide = Object.entries(columnas).every(
        ([clave, valor]) => existente[clave] === valor,
      );
      if (!coincide) throw new Error(`C1 durable: COLISION_DIVERGENTE_${tipo.toUpperCase()}`);
      return;
    }
    this._causales[tipo].insert(columnas);
  }

  _asegurarEntidadComprometida(sesionId, afirmacion) {
    validarContextoSesion(sesionId);
    const row = this._asegurarFilaDeSesion(sesionId, afirmacion.id);
    if (row.contenido_json !== serializarCanonico(afirmacion)) {
      throw new Error('C1 durable: FOTOGRAFIA_DURABLE_DISTINTA');
    }
  }

  _asegurarFilaDeSesion(sesionId, afirmacionId) {
    validarContextoSesion(sesionId);
    const row = this._stmtByGlobalId.get(afirmacionId);
    if (!row) throw new Error('C1 durable: AFIRMACION_NO_PERSISTIDA');
    if (row.sesion_id !== sesionId) throw new Error('C1 durable: REGISTRO_PERTENECE_A_OTRA_SESION');
    return row;
  }

  _exigirTransaccion(operacion) {
    if (!this._db.inTransaction) {
      throw new Error(`C1 durable: ${operacion} requiere CognitiveUnitOfWork`);
    }
  }

  _parsearCanonico(row, tipo) {
    let contenido;
    try {
      contenido = JSON.parse(row.contenido_json);
    } catch {
      throw new Error(`C1 durable: ${tipo}_JSON_INVALIDO`);
    }
    if (serializarCanonico(contenido) !== row.contenido_json) {
      throw new Error(`C1 durable: ${tipo}_NO_CANONICO`);
    }
    return contenido;
  }

  _validarPertenenciaCausal(row, contenido, tipo) {
    if (
      !row.sesion_id || !row.afirmacion_id
      || (contenido.sesionId !== undefined && contenido.sesionId !== row.sesion_id)
      || contenido.afirmacionId !== row.afirmacion_id
      || (contenido.presentacionId !== undefined && contenido.presentacionId !== row.presentacion_id)
    ) throw new Error(`C1 durable: ${tipo}_IDENTIDAD_INCOHERENTE`);
    this._asegurarFilaDeSesion(row.sesion_id, row.afirmacion_id);
  }

  _rehidratarMaterializacion(row) {
    const contenido = this._parsearCanonico(row, 'MATERIALIZACION');
    this._validarPertenenciaCausal(row, contenido, 'MATERIALIZACION');
    const idEsperado =
      `materializacion_transformacional:${encodeURIComponent(row.afirmacion_id)}:v${contenido.version}`;
    if (
      row.registro_id !== idEsperado
      || contenido.id !== row.registro_id
      || contenido.estadoPrevio !== 'PROPUESTA'
      || contenido.estadoPosterior !== 'MATERIALIZADA_PENDIENTE'
      || typeof contenido.turnoMaterializacionId !== 'string'
    ) throw new Error('C1 durable: MATERIALIZACION_INCOHERENTE');
    return congelarLectura(contenido);
  }

  _rehidratarVeredicto(row) {
    const contenido = this._parsearCanonico(row, 'VEREDICTO');
    this._validarPertenenciaCausal(row, contenido, 'VEREDICTO');
    const estadoPorTipo = {
      CONFIRMACION_EXPLICITA: 'AUTORIZADA',
      RECHAZO_EXPLICITO: 'RECHAZADA',
    };
    if (
      contenido.id !== row.registro_id
      || !estadoPorTipo[contenido.tipo]
      || typeof contenido.turnoId !== 'string'
      || !Array.isArray(contenido.evidenciaAtribucion)
    ) throw new Error('C1 durable: VEREDICTO_INCOHERENTE');
    const afirmacion = this._stmtByGlobalId.get(row.afirmacion_id);
    // S1_R_INCREMENTO_4 — un veredicto CONFIRMACION_EXPLICITA sigue siendo
    // histórico-correcto aunque la Afirmación que autorizó haya sido
    // superada DESPUÉS (marcarAfirmacionSuperadaPorSucesion) — el veredicto
    // describe el hecho de que, en su momento, fue AUTORIZADA; "SUPERADA"
    // es una revisión posterior, no una negación de esa autorización.
    const superadaValidaComoAutorizada = contenido.tipo === 'CONFIRMACION_EXPLICITA'
      && afirmacion.estado_normativo === 'SUPERADA';
    if (afirmacion.estado_normativo !== estadoPorTipo[contenido.tipo] && !superadaValidaComoAutorizada) {
      throw new Error('C1 durable: VEREDICTO_Y_ESTADO_DURABLE_INCOHERENTES');
    }
    return congelarLectura(contenido);
  }

  _rehidratarPresentacion(row) {
    const contenido = this._parsearCanonico(row, 'PRESENTACION');
    this._validarPertenenciaCausal(row, contenido, 'PRESENTACION');
    if (contenido.schemaVersion === 2) {
      const afirmacion = this.findById(row.sesion_id, row.afirmacion_id);
      runtime.validarPresentacionEstructuradaInterna({ contenido, row, afirmacion });
      return congelarLectura(contenido);
    }
    const idEsperado = [
      'presentacion_roundtrip',
      encodeURIComponent(contenido.afirmacionId),
      `v${contenido.afirmacionVersion}`,
      encodeURIComponent(contenido.turnoPresentacionId),
    ].join(':');
    if (
      row.presentacion_id !== idEsperado
      || typeof contenido.formulacionPresentada !== 'string'
    ) throw new Error('C1 durable: PRESENTACION_INCOHERENTE');
    return congelarLectura({
      presentacionId: row.presentacion_id,
      sesionId: row.sesion_id,
      ...contenido,
    });
  }

  _rehidratarRoundTrip(row) {
    const contenido = this._parsearCanonico(row, 'ROUNDTRIP');
    this._validarPertenenciaCausal(row, contenido, 'ROUNDTRIP');
    const permitidos = new Set([
      'RECONOCIDA_SIN_CORRECCION',
      'CORRECCION_SEMANTICA',
      'RECHAZADA',
      'SIN_EVIDENCIA',
    ]);
    const presentacion = this._causales.presentacion.byId.get(row.presentacion_id);
    if (
      contenido.id !== row.registro_id
      || !permitidos.has(contenido.resultado)
      || !presentacion
      || presentacion.sesion_id !== row.sesion_id
      || presentacion.afirmacion_id !== row.afirmacion_id
    ) throw new Error('C1 durable: ROUNDTRIP_INCOHERENTE');
    const presentacionContenido = this._parsearCanonico(presentacion, 'PRESENTACION');
    const formulacionPersistida = presentacionContenido.schemaVersion === 2
      ? presentacionContenido.textoRenderizadoExacto
      : presentacionContenido.formulacionPresentada;
    if (
      contenido.turnoPresentacionId !== presentacionContenido.turnoPresentacionId
      || contenido.formulacionPresentada !== formulacionPersistida
    ) throw new Error('C1 durable: ROUNDTRIP_Y_PRESENTACION_INCOHERENTES');
    return congelarLectura({ ...contenido, presentacionId: row.presentacion_id });
  }

  _rehidratarSucesion(row) {
    const contenido = this._parsearCanonico(row, 'SUCESION');
    const anterior = this._asegurarFilaDeSesion(row.sesion_id, row.afirmacion_anterior_id);
    const sucesora = this._asegurarFilaDeSesion(row.sesion_id, row.afirmacion_sucesora_id);
    const roundTrip = this._causales.roundtrip.byId.get(row.registro_roundtrip_id);
    if (!roundTrip || roundTrip.sesion_id !== row.sesion_id
      || roundTrip.afirmacion_id !== row.afirmacion_anterior_id) {
      throw new Error('C1 durable: SUCESION_ROUNDTRIP_INCOHERENTE');
    }
    const rtContenido = this._rehidratarRoundTrip(roundTrip);
    const sucesoraContenido = this._parsearCanonico(sucesora, 'AFIRMACION_SUCESORA');
    if (
      rtContenido.resultado !== 'CORRECCION_SEMANTICA'
      || contenido.registroRoundTripId !== row.registro_roundtrip_id
      || contenido.afirmacionAnteriorId !== row.afirmacion_anterior_id
      || contenido.reemplazaAId !== row.afirmacion_anterior_id
      || sucesoraContenido.reemplazaAId !== row.afirmacion_anterior_id
      || sucesoraContenido.version !== anterior.version + 1
      || contenido.versionPropuesta !== sucesoraContenido.version
    ) throw new Error('C1 durable: SUCESION_INCOHERENTE');
    return congelarLectura(contenido);
  }

  _asegurarEquivalencia(row, afirmacion, contenidoCanonico) {
    const coincide = (
      row.schema_version === SCHEMA_VERSION
      && row.afirmacion_id === afirmacion.id
      && row.version === afirmacion.version
      && row.estado_normativo === afirmacion.estado
      && (row.reemplaza_a_id || null) === (afirmacion.reemplazaAId || null)
      && row.contenido_json === contenidoCanonico
    );
    if (!coincide) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: COLISION_DIVERGENTE para ${row.afirmacion_id}`,
      );
    }
  }

  _rehidratar(row) {
    if (row.schema_version !== SCHEMA_VERSION) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: SCHEMA_VERSION_NO_SOPORTADA ${row.schema_version}`,
      );
    }
    let datos;
    try {
      datos = JSON.parse(row.contenido_json);
    } catch (error) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: CONTENIDO_JSON_INVALIDO — ${error.message}`,
      );
    }
    const canonico = serializarCanonico(datos);
    if (
      canonico !== row.contenido_json
      || datos.id !== row.afirmacion_id
      || datos.version !== row.version
      || datos.estado !== row.estado_normativo
      || (datos.reemplazaAId || null) !== (row.reemplaza_a_id || null)
    ) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: INTEGRIDAD_DURABLE_INVALIDA para ${row.afirmacion_id}`,
      );
    }
    const validacion = schema.validarAfirmacionTransformacionalDestino(datos);
    if (!validacion.valid) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: snapshot inválido — ${validacion.errors.join('; ')}`,
      );
    }
    this._verificarSucesionDurable(datos, row.sesion_id);
    return runtime.rehidratarEntidadComprometidaInterna({
      entidad: datos,
      sesionId: row.sesion_id,
    });
  }

  _verificarSucesionDurable(afirmacion, sesionId) {
    if (!afirmacion.reemplazaAId) return;
    const predecesora = this._stmtByGlobalId.get(afirmacion.reemplazaAId);
    if (!predecesora) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: PREDECESORA_NO_PERSISTIDA ${afirmacion.reemplazaAId}`,
      );
    }
    if (predecesora.sesion_id !== sesionId) {
      throw new Error(
        `SqliteAfirmacionTransformacionalDestinoRepository: PREDECESORA_PERTENECE_A_OTRA_SESION ${afirmacion.reemplazaAId}`,
      );
    }
  }

}

module.exports = {
  SqliteAfirmacionTransformacionalDestinoRepository,
};
