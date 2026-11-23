'use strict';

/**
 * SESSION HYDRATOR
 * Único componente capaz de reconstruir una Sesión Cognitiva completa —
 * estado vigente + transcript — exclusivamente a partir de lo persistido
 * por el backend. Prepara la restauración de una conversación sin depender
 * de nada que viva en el navegador (currentStateIdx, understood, etapa).
 *
 * Responsabilidad única: LEER y COMBINAR. No es un tercer punto de decisión:
 * - El estado vigente sale de CognitiveState tal cual está persistido —
 *   nunca se recalculan slots, gramática, Gate ni pipeline a partir del
 *   transcript. Esa autoridad ya vive en InteraccionCognitivaWriter/GatePolicy
 *   (Incremento 3-4) y este componente no la duplica.
 * - El transcript sale exclusivamente de Turnos — nunca de eventos ni del
 *   estado actual (misma regla que GET /session/:id/turnos, Incremento 5).
 * - Reutiliza sessionDTO/turnoDTO (Incremento 5): la representación
 *   hidratada es, por construcción, la misma forma que ya exponen
 *   GET /session/:id y GET /session/:id/turnos — no una tercera semántica.
 *
 * Nunca escribe: ningún método de este archivo llama a stateRepository.save,
 * turnoRepository.save, ni a ningún emisor de eventos.
 *
 * Discrepancias entre estado y transcript (p.ej. una gramática que el
 * estado marca como completada pero de la que no hay evidencia en ningún
 * Turno) se detectan y se reportan en `consistencia` — nunca se corrigen
 * automáticamente. El estado canónico siempre prevalece en `estadoVigente`.
 *
 * `kickoff` (Incremento 7, corrección post-revisión): el mensaje de
 * apertura de Círculo no es un Turno (no hay mensajeExperto real — Círculo
 * habla primero) y por diseño el transcript sigue viniendo EXCLUSIVAMENTE
 * de Turnos, sin excepción. El bridge lo reporta como evento
 * 'conversacion.iniciada' (vía /trace, la misma vía de observabilidad pura
 * que ya existía) porque el backend no puede observarlo por sí mismo. Se
 * expone en un campo `kickoff` APARTE de `transcript` — nunca mezclado —
 * así que sigue sin haber una segunda fuente para el transcript, solo una
 * pieza adicional, explícitamente distinta, para que el bridge pueda
 * mostrar la apertura tal cual fue en vez de perderla al restaurar.
 * eventRepository es OPCIONAL: sin él, `kickoff` queda null (compatible
 * con el uso anterior a esta corrección).
 */

const { deserializeState } = require('../schemas/CognitiveState');
const { sessionDTO, turnoDTO } = require('../api/ApiDTOs');

// Tamaño de lote interno para agotar la paginación de turnoRepository —
// detalle de implementación, nunca se expone: el Hydrator siempre devuelve
// el transcript completo.
const LOTE_INTERNO = 500;

/**
 * Reúne el transcript completo de una sesión agotando
 * turnoRepository.paginarAscendente (capacidad ya creada en el Incremento 5)
 * — ninguna consulta SQL nueva.
 */
function cargarTranscriptCompleto(turnoRepository, sesionId) {
  const turnos = [];
  let cursor = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const lote = turnoRepository.paginarAscendente(sesionId, cursor, LOTE_INTERNO);
    if (lote.length === 0) break;
    turnos.push(...lote);
    if (lote.length < LOTE_INTERNO) break;
    cursor = lote[lote.length - 1].numeroDeTurno;
  }
  return turnos;
}

/**
 * Verifica consistencia entre el estado canónico y el transcript. Solo
 * detecta y describe — nunca modifica ninguno de los dos lados.
 * @returns {string[]} errores (vacío si no se encontró ninguna discrepancia)
 */
function detectarInconsistencias(state, transcriptOrdenado) {
  const errores = [];

  // 1. Integridad propia del transcript: numeroDeTurno debe ser una
  // secuencia densa 1..N, sin huecos ni duplicados. Puede romperse solo por
  // corrupción de datos o manipulación directa fuera del writer — nunca en
  // operación normal (proximoNumeroDeTurno + UNIQUE lo garantizan).
  let anterior = 0;
  transcriptOrdenado.forEach((t) => {
    if (t.numeroDeTurno !== anterior + 1) {
      errores.push(
        `Salto en numeroDeTurno: tras ${anterior}, se esperaba ${anterior + 1} y se encontró ${t.numeroDeTurno}`
      );
    }
    anterior = t.numeroDeTurno;
  });

  // 2. state.gramaticasCompletadas afirma que ciertas gramáticas ya
  // cerraron — debe existir al menos un Turno real de cada una en el
  // transcript como evidencia. Es un chequeo referencial (¿hay evidencia
  // para lo que el estado afirma?), no una regla de negocio nueva sobre
  // cuándo debe completarse una gramática — esa decisión sigue siendo
  // exclusiva de GatePolicy.
  const gramaticasEnTranscript = new Set(transcriptOrdenado.map((t) => t.gramatica));
  (state.gramaticasCompletadas || []).forEach((g) => {
    if (!gramaticasEnTranscript.has(g)) {
      errores.push(`gramaticasCompletadas incluye '${g}' pero el transcript no tiene ningún Turno de esa gramática`);
    }
  });

  return errores;
}

/**
 * Función pura: combina un CognitiveState ya deserializado y un transcript
 * ya cargado en la representación lista para la UI. Sin I/O — testable de
 * forma directa, sin base de datos.
 * @param {object} params
 * @param {object} params.state   — CognitiveState deserializado
 * @param {object[]} params.turnos — Turnos de la sesión, en cualquier orden
 * @param {{gramatica:string, mensaje:string}|null} [params.kickoff] — evento
 *   'conversacion.iniciada' ya cargado, o null/undefined si no existe. Nunca
 *   se mezcla en `transcript`.
 * @returns {object} representación hidratada
 */
function reconstruirSesion({ state, turnos, kickoff = null }) {
  const transcriptOrdenado = [...turnos].sort((a, b) => a.numeroDeTurno - b.numeroDeTurno);
  const errores = detectarInconsistencias(state, transcriptOrdenado);

  return {
    sesionId: state.sesionId,
    // El estado canónico prevalece siempre — misma forma que sessionDTO,
    // nunca recalculado a partir del transcript.
    estadoVigente: sessionDTO(state),
    transcript: transcriptOrdenado.map(turnoDTO),
    // Campo aparte, deliberadamente — ver nota de cabecera sobre por qué
    // esto no es (ni debe volverse) una segunda fuente del transcript.
    kickoff: kickoff ? { gramatica: kickoff.gramatica, mensaje: kickoff.mensaje } : null,
    consistencia: { ok: errores.length === 0, errores },
  };
}

class SessionHydrator {
  /**
   * @param {object} config
   * @param {import('../persistence/SqliteStateRepository').SqliteStateRepository} config.stateRepository
   * @param {import('../persistence/SqliteTurnoRepository').SqliteTurnoRepository} config.turnoRepository
   * @param {import('../events/SqliteEventRepository').SqliteEventRepository} [config.eventRepository]
   *   — opcional; habilita `session.kickoff` (Incremento 7, corrección
   *   post-revisión). Solo se usa para leer 'conversacion.iniciada' — nunca
   *   para derivar el transcript, que sigue viniendo exclusivamente de Turnos.
   */
  constructor({ stateRepository, turnoRepository, eventRepository = null }) {
    if (!stateRepository) throw new Error('SessionHydrator: stateRepository es requerido.');
    if (!turnoRepository) throw new Error('SessionHydrator: turnoRepository es requerido.');
    this._stateRepo = stateRepository;
    this._turnoRepo = turnoRepository;
    this._eventRepo = eventRepository;
  }

  /**
   * Reconstruye una Sesión Cognitiva completa desde lo persistido. Nunca
   * escribe: ni Turnos, ni eventos, ni versiones de estado.
   * @param {string} sesionId
   * @returns {{ ok:true, session:object } | { ok:false, codigo:'SESSION_NOT_FOUND' }}
   */
  hidratar(sesionId) {
    const json = this._stateRepo.load(sesionId);
    if (!json) return { ok: false, codigo: 'SESSION_NOT_FOUND' };

    const state  = deserializeState(json);
    const turnos = cargarTranscriptCompleto(this._turnoRepo, sesionId);
    const kickoff = this._cargarKickoff(sesionId);

    return { ok: true, session: reconstruirSesion({ state, turnos, kickoff }) };
  }

  /** El primer (y único esperado) 'conversacion.iniciada' de la sesión, o null. */
  _cargarKickoff(sesionId) {
    if (!this._eventRepo) return null;
    const eventos = this._eventRepo.findBySesionAndType(sesionId, 'conversacion.iniciada');
    if (!eventos || eventos.length === 0) return null;
    return eventos[0].payload || null;
  }
}

module.exports = { SessionHydrator, reconstruirSesion };
