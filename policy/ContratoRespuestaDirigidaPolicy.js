'use strict';

/**
 * CONTRATO CAUSAL DE RESPUESTA A INTERVENCIÓN DIRIGIDA (T-DIM2,
 * circulomejora006).
 *
 * T-DIM0 (auditoría previa) encontró la causa raíz de la atribución
 * dimensional incorrecta observada en `a4r_rechazo` (turnos 9 y 10): el
 * gate anterior (`atiendeDimensionObjetivo`/`porQueNoCapturaDimensionObjetivo`/
 * `atribucionSinJustificar`) solo verificaba PRESENCIA de un concepto nuevo
 * en la dimensión objetivo — nunca exigía que Capa 1 declarara, de forma
 * verificable, CÓMO se relaciona la respuesta de este turno con la pregunta
 * dirigida del turno anterior — y, agotados los reintentos, aceptaba el
 * turno de todos modos (fail-open silencioso).
 *
 * Este módulo reemplaza esa verificación por un contrato más fuerte: Capa 1
 * debe declarar explícitamente la relación (catálogo cerrado), y esa
 * declaración debe ser estructuralmente consistente con lo que Capa 1 mismo
 * propuso en `conceptosNuevos` — nunca una afirmación decorativa. El Writer
 * (InteraccionCognitivaWriter.js) valida; nunca reclasifica semánticamente
 * ni fabrica la dimensión correcta.
 *
 * Deliberadamente sin I/O: el llamador (InteraccionCognitivaWriter) ya
 * resolvió, contra autoridades durables existentes (Turno, EventRepository.
 * lastOfType, CognitiveState.protocoloIntencionCierre/protocoloDimensionEnFoco
 * — T-DIM2 Fase 1 confirmó que NINGÚN campo persistido nuevo es necesario),
 * los datos crudos que este módulo solo ensambla y valida.
 */

const { esFragmentoLiteral } = require('./SenalCierreConversacionalPolicy');
const { OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA } = require('../state/DecisorIntervencionConversacional');

// Catálogo cerrado (T-DIM2 Fase 2) — nunca un valor libre.
const RELACIONES_RESPUESTA_DIRIGIDA = Object.freeze([
  'ATIENDE_OBJETIVO',
  'ATIENDE_PARCIALMENTE',
  'APORTA_OTRA_DIMENSION',
  'MEZCLA_DIMENSIONES',
  'CAMBIA_DE_TEMA',
  'RECHAZA_PREMISA',
  'NO_PUEDE_RESPONDER',
  'AMBIGUA',
]);

// Únicas relaciones cuya declaración exige, sin excepción, evidencia real
// vinculada a la dimensión objetivo (T-DIM2 Fase 4) — el resto (información
// legítima sobre otra dimensión, cambio de tema, rechazo de premisa,
// incapacidad de responder, ambigüedad genuina) nunca lleva esa carga: son
// relaciones válidas por sí mismas, no una falla a justificar.
const RELACIONES_QUE_EXIGEN_EVIDENCIA_OBJETIVO = Object.freeze([
  'ATIENDE_OBJETIVO',
  'ATIENDE_PARCIALMENTE',
  'MEZCLA_DIMENSIONES',
]);

const DIAGNOSTICOS_RELACION_RESPUESTA_DIRIGIDA = Object.freeze({
  RELACION_POSITIVA_SIN_SOPORTE_ESTRUCTURADO: 'RELACION_POSITIVA_SIN_SOPORTE_ESTRUCTURADO',
  // OPEN_SEARCH support mode: a distinct code on purpose -- the dimension-
  // bound support repair keys on RELACION_POSITIVA_SIN_SOPORTE_ESTRUCTURADO and
  // can never satisfy a contract that has no dimension, so it must not fire.
  RELACION_POSITIVA_SIN_SOPORTE_BUSQUEDA_ABIERTA: 'RELACION_POSITIVA_SIN_SOPORTE_BUSQUEDA_ABIERTA',
});

// TARGETLESS_DIRECTED_RESPONSE_REQUIRES_DIMENSION_SUPPORT (C007, Daniel-
// adjudicated, real evidence: logistica_c0 fresh-live turn 12, session
// live_complete_logistica_c0_11ec6033). TARGETLESS_ACT != UNSUPPORTED_ACT.
// PROPOSE_MISSION_CLOSURE legitimately has no target/dimension by its own
// canonical contract (it proposes closing the whole mission, not a single
// dimension) yet still legitimately expects a directed next-turn response
// (accept/correct/reject the closure) -- the SAME "positive relation"
// vocabulary (ATIENDE_OBJETIVO/ATIENDE_PARCIALMENTE/MEZCLA_DIMENSIONES)
// every dimension-bound operator already uses. The dimension-bound support
// check below (conceptosEnObjetivo filtered by dimensionDeProcedencia ===
// contrato.dimensionObjetivo) is mathematically unsatisfiable whenever
// dimensionObjetivo is null -- true ONLY for this class of act; every other
// directed-response-expecting operator (ASK_HOW/ASK_EXISTENCE/ASK_VALUE_OF_
// KNOWN/ASK_EVIDENCE/REPAIR_UNDERSTANDING) always carries a real dimension.
// Explicit, narrow allow-list -- no speculation about future operators, and
// a null dimensionObjetivo for any operator NOT on this list still fails
// closed exactly as before (DIRECTED_RESPONSE_SUPPORT MAY_BE DIMENSION_
// BOUND OR ACT_BOUND, but ACT_BOUND_RESPONSE_SUPPORT DOES_NOT_CREATE A FAKE
// DIMENSION -- this never manufactures a dimensionObjetivo value).
const OPERADORES_CON_RESPUESTA_DIRIGIDA_SIN_DIMENSION = Object.freeze([
  'PROPOSE_MISSION_CLOSURE',
]);

function actoAdmiteRespuestaDirigidaSinDimension(actoCognitivoVisible) {
  return !!(actoCognitivoVisible
    && OPERADORES_CON_RESPUESTA_DIRIGIDA_SIN_DIMENSION.includes(actoCognitivoVisible.operator));
}

// DIRECTED_RESPONSE_SUPPORT_FOLLOWS_PREVIOUS_ACT_AUTHORITY (C007,
// logistica_c1 turn 5, T5-I). The support a positive directed relation must
// have is a property of the PREVIOUS CONTRACTED ACT, not a universal
// "slot:<dimensionObjetivo>" requirement:
//
//   DIMENSION_BOUND       the previous act owns a native dimension: positive
//                         relations need governed support coherent with
//                         slot:<dimensionObjetivo> (unchanged, never weakened).
//   ACT_BOUND_SIN_DIMENSION  PROPOSE_MISSION_CLOSURE (certified separate path,
//                         unchanged: literal evidence only).
//   OPEN_SEARCH           the previous act is a canonical ASK_EXISTENCE whose
//                         structured epistemic mode is OPEN_SEARCH and whose
//                         target is a free-text search target that is NOT a
//                         governed id: the request is intentionally open, so
//                         there is no dimension to bind support to. Support
//                         must then be governed CURRENT-TURN material that is
//                         anchored in the very passage the relation cites.
//
// dimensionObjetivo === null BY ITSELF authorizes nothing: the validator must
// know WHY it is null. A null dimension without the explicit structured
// OPEN_SEARCH authority (operator + epistemic mode + a target the pipeline
// verified is not a governed id) is a missing-dimension accident and keeps the
// exact dimension-bound contract: fail closed as before.
const MODOS_SOPORTE_RESPUESTA_DIRIGIDA = Object.freeze({
  DIMENSION_BOUND: 'DIMENSION_BOUND',
  ACT_BOUND_SIN_DIMENSION: 'ACT_BOUND_SIN_DIMENSION',
  OPEN_SEARCH: 'OPEN_SEARCH',
});

/**
 * Pipeline-side evidence for the OPEN_SEARCH authority: the frozen act's target
 * is a non-empty search target that is not the id of any governed concept or
 * uncertainty (so the missing dimension is "nothing to resolve", not "a
 * governed entity whose dimension got lost"). Pure; reads structured fields only.
 */
function objetivoDeActoEsBusquedaAbiertaNoGobernada(acto, grafo) {
  if (!acto || acto.operator !== 'ASK_EXISTENCE' || acto.epistemicRequirement !== 'OPEN_SEARCH') return false;
  const target = typeof acto.target === 'string' ? acto.target.trim() : '';
  if (!target) return false;
  const conceptos = grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [];
  const incertidumbres = grafo && Array.isArray(grafo.incertidumbres) ? grafo.incertidumbres : [];
  return !conceptos.some(c => c && c.id === target) && !incertidumbres.some(u => u && u.id === target);
}

function resolverModoSoporteRespuestaDirigida(contrato) {
  if (!contrato || contrato.dimensionObjetivo != null) return MODOS_SOPORTE_RESPUESTA_DIRIGIDA.DIMENSION_BOUND;
  const acto = contrato.actoCognitivoVisible;
  if (actoAdmiteRespuestaDirigidaSinDimension(acto)) return MODOS_SOPORTE_RESPUESTA_DIRIGIDA.ACT_BOUND_SIN_DIMENSION;
  if (contrato.objetivoAbiertoNoGobernado === true
    && acto && acto.operator === 'ASK_EXISTENCE' && acto.epistemicRequirement === 'OPEN_SEARCH'
    && typeof acto.target === 'string' && acto.target.trim()) {
    return MODOS_SOPORTE_RESPUESTA_DIRIGIDA.OPEN_SEARCH;
  }
  return MODOS_SOPORTE_RESPUESTA_DIRIGIDA.DIMENSION_BOUND;
}

// Comparison-only normalization (identical to esFragmentoLiteral's): used to
// place two literal passages of the SAME user message on one coordinate system.
function normalizarParaComparacion(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function rangoLiteralEnMensaje(mensajeNormalizado, fragmento) {
  const f = normalizarParaComparacion(fragmento);
  if (!f) return null;
  const i = mensajeNormalizado.indexOf(f);
  return i < 0 ? null : [i, i + f.length];
}

/**
 * OPEN_SEARCH support: a positive relation needs at least one GOVERNED
 * current-turn concept (a conceptosNuevos entry of this turn) that is a
 * literal passage of the user's message AND overlaps the passage the relation
 * itself cites as evidence. Declared conceptosQueAtienden must all resolve to
 * this turn's concepts (no dangling ids) and are then the only candidates.
 * Structural (identity + span overlap on the user's own message), never lexical
 * or semantic: the relation's meaning remains the Producer's declaration,
 * verified downstream like any other.
 */
function evaluarSoporteBusquedaAbierta({ relacionDeclarada, mensajeUsuario, conceptosNuevosEsteTurno }) {
  const conceptos = Array.isArray(conceptosNuevosEsteTurno) ? conceptosNuevosEsteTurno.filter(Boolean) : [];
  const declaradas = Array.isArray(relacionDeclarada.conceptosQueAtienden) && relacionDeclarada.conceptosQueAtienden.length > 0
    ? relacionDeclarada.conceptosQueAtienden : null;
  let candidatos = conceptos;
  if (declaradas) {
    const porId = new Map(conceptos.map(c => [c.idTemporal || c.id, c]).filter(([id]) => id));
    if (!declaradas.every(id => porId.has(id))) return { valido: false, causa: 'REFERENCIA_NO_RESUELTA' };
    candidatos = declaradas.map(id => porId.get(id));
  }
  if (candidatos.length === 0) return { valido: false, causa: 'SIN_CONCEPTOS_GOBERNADOS_DEL_TURNO' };
  const mensaje = normalizarParaComparacion(mensajeUsuario);
  const rangoRelacion = rangoLiteralEnMensaje(mensaje, relacionDeclarada.evidenciaTextual);
  if (!rangoRelacion) return { valido: false, causa: 'EVIDENCIA_NO_LITERAL' };
  const ancla = candidatos.some((c) => {
    const r = rangoLiteralEnMensaje(mensaje, c.descripcion);
    return r && r[0] < rangoRelacion[1] && rangoRelacion[0] < r[1];
  });
  return ancla ? { valido: true, causa: null } : { valido: false, causa: 'SOPORTE_NO_ANCLADO_EN_LA_EVIDENCIA_CITADA' };
}

// Función cognitiva que cada movimiento de DESTINO persigue cuando dirige
// una pregunta — usada únicamente para poblar `funcionEsperada` del
// contrato reconstruido, nunca para decidir nada (observabilidad/contexto).
const FUNCION_ESPERADA_POR_MOVIMIENTO = Object.freeze({
  PEDIR_CONTEXTO: 'OBTENER_CONTEXTO_CONCRETO',
  PEDIR_EJEMPLO: 'OBTENER_EJEMPLO_CONCRETO',
  REPARAR_TRAS_RECHAZO: 'OBTENER_CORRECCION_TRAS_RECHAZO',
  PROPONER_INTERPRETACION: 'OBTENER_VEREDICTO_SOBRE_INTERPRETACION',
  REFLEJAR_Y_PROFUNDIZAR: 'PROFUNDIZAR_EVIDENCIA_ESTABLECIDA',
  SOLICITAR_VEREDICTO_INTERPRETACION: 'OBTENER_VEREDICTO_SOBRE_INTERPRETACION',
  // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 — nunca un "movimiento" real
  // (no pasa por decidirMovimientoDestino, no exige Movimiento activo): mismo
  // patrón que REPARAR_TRAS_RECHAZO, una etiqueta sintética para la MISMA
  // función cognitiva ("obtener el reemplazo pendiente de una corrección"),
  // reutilizada aquí porque la corrección de concepto es, causalmente, la
  // misma familia de intervención dirigida (ver InteraccionCognitivaWriter.js,
  // fuenteEsCorreccionConceptoAbierta).
  CORREGIR_CONCEPTO_SIN_REEMPLAZO: 'OBTENER_REEMPLAZO_CONCEPTO_TRAS_CORRECCION',
});

// Criterio de resolución genérico para intervenciones dirigidas que no
// nacieron de una deuda formal (continuidad/elegibilidad ordinaria) — mismo
// criterio que P1-B2/P1-B3 ya usan para DIMENSION_SIN_EVIDENCIA, nunca uno
// nuevo inventado aquí.
const CRITERIO_DE_RESOLUCION_GENERICO = 'DIMENSION_TIENE_AL_MENOS_UN_CONCEPTO_NUEVO_ATRIBUIDO';

// Resultado explícito (T-DIM2 Fase 4/5) cuando, agotados los reintentos, la
// relación declarada por Capa 1 sigue siendo internamente inconsistente con
// sus propios conceptosNuevos — reemplaza a `atribucionSinJustificar:true`
// como único resultado; el turno nunca se acepta en silencio (ver Writer:
// esto fuerza contratoDeCamposValidado=false incluso en el último intento,
// enrutando a la degradación Determinista ya existente y probada — P0-B).
const RESULTADO_ALINEACION_NO_VERIFICABLE = 'ALINEACION_RESPUESTA_DIRIGIDA_NO_VERIFICABLE';
const RESULTADO_VERIFICADA = 'VERIFICADA';
const RESULTADO_NO_APLICA = 'NO_APLICA';
const FEEDBACK_INTERVENCION = Object.freeze(['NO_ENTENDIDA', 'REDUNDANTE', 'VIA_INADECUADA', 'VIA_PREFERIDA', 'PREMISA_RECHAZADA']);

/**
 * Reconstruye, de forma PURA, el contrato causal de la intervención
 * dirigida que gobernó el turno anterior. Devuelve null cuando no hay
 * ninguna intervención dirigida vigente (primer turno de DESTINO, o el
 * movimiento anterior no pertenece al vocabulario de DESTINO) — en ese
 * caso el turno actual no lleva ninguna obligación de relación.
 *
 * @param {object} p
 * @param {string|null} p.dimensionObjetivoAnterior — protocoloDimensionEnFoco tal como entró este turno
 * @param {string|null} p.movimientoAnterior — comprension_conversacional.turno.movimientoDecidido.movimiento del turno anterior
 * @param {string|null} p.codigoRazonAnterior
 * @param {string|null} p.turnoIntervencionId — turnoId del Turno durable que emitió la intervención
 * @param {string|null} p.preguntaVisibleAnterior — mensajeCirculo exacto del Turno anterior
 * @param {string|null} p.objetivoConversacionalAnterior — objetivo_conversacional.turno.objetivo del turno anterior
 * @param {object|null} p.deudaBloqueanteAnterior — state.protocoloIntencionCierre.deudaBloqueante (ya hidratada)
 * @returns {object|null}
 */
function reconstruirContratoRespuestaDirigida({
  dimensionObjetivoAnterior = null,
  movimientoAnterior = null,
  viaAccesoAnterior = null,
  resultadoViaAccesoAnterior = null,
  codigoRazonAnterior = null,
  turnoIntervencionId = null,
  preguntaVisibleAnterior = null,
  objetivoConversacionalAnterior = null,
  deudaBloqueanteAnterior = null,
  referenciaResolucionAnterior = null,
  interpretacionReparadaAnterior = null,
  unknownIdAnterior = null,
  desconocidoPreguntableScopedAnterior = null,
  actoInterrogativoAnterior = null,
} = {}) {
  if (!dimensionObjetivoAnterior || !movimientoAnterior) return null;
  const funcionEsperada = FUNCION_ESPERADA_POR_MOVIMIENTO[movimientoAnterior] || null;
  if (!funcionEsperada) return null;

  // La deuda solo se adjunta cuando su dimensión coincide con la que
  // realmente gobernó el contrato anterior — nunca una deuda de otra
  // dimensión, arrastrada por error de un cálculo previo.
  const deuda = (deudaBloqueanteAnterior && deudaBloqueanteAnterior.dimension === dimensionObjetivoAnterior)
    ? deudaBloqueanteAnterior : null;

  return Object.freeze({
    turnoIntervencionId: turnoIntervencionId || null,
    movimiento: movimientoAnterior,
    viaAcceso: viaAccesoAnterior || null,
    resultadoViaAcceso: resultadoViaAccesoAnterior || null,
    codigoRazon: codigoRazonAnterior || null,
    dimensionObjetivo: dimensionObjetivoAnterior,
    preguntaVisible: preguntaVisibleAnterior || null,
    objetivoConversacional: objetivoConversacionalAnterior || null,
    deudaTipo: deuda ? deuda.tipo : null,
    deudaIdentidad: deuda ? deuda.identidad : null,
    referenciaResolucion: referenciaResolucionAnterior
      && ['REPARACION_INTERPRETATIVA', 'VEREDICTO_INTERPRETACION'].includes(referenciaResolucionAnterior.tipo)
      ? Object.freeze({ ...referenciaResolucionAnterior }) : null,
    criterioSatisfaccion: referenciaResolucionAnterior && referenciaResolucionAnterior.criterioSatisfaccion
      ? Object.freeze({ ...referenciaResolucionAnterior.criterioSatisfaccion }) : null,
    interpretacionReparada: interpretacionReparadaAnterior ? Object.freeze({ ...interpretacionReparadaAnterior }) : null,
    unknownId: unknownIdAnterior || null,
    desconocidoPreguntableScoped: desconocidoPreguntableScopedAnterior
      ? Object.freeze({ ...desconocidoPreguntableScopedAnterior }) : null,
    actoInterrogativo: actoInterrogativoAnterior
      ? Object.freeze({ ...actoInterrogativoAnterior }) : null,
    funcionEsperada,
    criterioDeResolucion: (deuda && deuda.criterioDeResolucion) || CRITERIO_DE_RESOLUCION_GENERICO,
  });
}

function esRelacionValida(relacion) {
  return RELACIONES_RESPUESTA_DIRIGIDA.includes(relacion);
}

/**
 * Contexto canónico que se entrega al evaluador de una respuesta dirigida.
 * La respuesta nunca debe volver a localizar R desde el head actual: la
 * referencia y el criterio vienen del contrato de la intervención emitida.
 */
function construirContextoSatisfaccionRespuestaDirigida({
  contrato,
  respuestaUsuario = null,
  materialesDisponibles = [],
} = {}) {
  const referencia = contrato && contrato.referenciaResolucion;
  if (!referencia || !referencia.obligacionId || !referencia.intentoInterpretacionId
    || !referencia.criterioSatisfaccion) return null;
  const interpretacion = contrato.interpretacionReparada || null;
  if (!interpretacion || interpretacion.id !== referencia.intentoInterpretacionId) return null;
  return Object.freeze({
    obligacionId: referencia.obligacionId,
    intentoInterpretacionId: referencia.intentoInterpretacionId,
    criterioSatisfaccion: Object.freeze({ ...referencia.criterioSatisfaccion }),
    interpretacionRechazada: Object.freeze({ id: interpretacion.id, descripcion: interpretacion.descripcion || '' }),
    respuestaUsuario,
    materialesDisponibles: Object.freeze((Array.isArray(materialesDisponibles) ? materialesDisponibles : []).map(m => Object.freeze({ ...m }))),
  });
}

/**
 * Valida ESTRUCTURALMENTE la relación declarada por Capa 1 contra su
 * propia respuesta — nunca reclasifica semánticamente (eso sigue siendo
 * autoridad exclusiva de Capa 1, ver REGLA_AUTORIDAD_PROCEDENCIA), solo
 * verifica: catálogo cerrado, evidencia textual literal, forma correcta de
 * "conceptosQueAtienden", y consistencia interna — si la relación declarada
 * exige evidencia vinculada a la dimensión objetivo, esa evidencia debe
 * existir de verdad entre los conceptos nuevos de ESTE turno, o como
 * incertidumbre resuelta con la misma identidad causal (P1-B3).
 *
 * @returns {{valido: boolean, motivo: string|null, diagnostico?: {codigo: string}}}
 */
function validarRelacionRespuestaDirigida(entrada) {
  // The single-verdict contract every caller already consumes: the FIRST
  // defect of the ordered list below (or valid). The ordered list itself is
  // the ONE source of truth for the checks -- see
  // listarDefectosRelacionRespuestaDirigida.
  const defectos = listarDefectosRelacionRespuestaDirigida(entrada);
  if (defectos.length === 0) return { valido: true, motivo: null };
  const primero = defectos[0];
  return primero.diagnostico
    ? { valido: false, motivo: primero.motivo, diagnostico: primero.diagnostico }
    : { valido: false, motivo: primero.motivo };
}

/**
 * COMPLETE_PRODUCER_CORRECTION_FEEDBACK (C007,
 * DIRECTED_RESPONSE_ATTEMPT_REPAIR_AUTHORITY_CONTINUITY). The very same
 * structural checks as validarRelacionRespuestaDirigida, but reporting EVERY
 * independently-detectable defect of the declared relation instead of
 * stopping at the first -- so a Producer correction can name them all at
 * once (a non-literal evidenciaTextual AND a missing structured support are
 * two defects of one relation, not one defect at a time). Pure and
 * deterministic: it classifies, it never reclassifies the relation
 * semantically and never invents content. Same messages, same order, same
 * diagnostico as the historical first-defect-only verdict.
 *
 * @returns {Array<{motivo: string, diagnostico?: object}>}
 */
function listarDefectosRelacionRespuestaDirigida({
  relacionDeclarada, mensajeUsuario, contrato,
  conceptosNuevosEsteTurno = [], dimensionDeProcedencia,
  incertidumbreObjetivoResuelta = false,
}) {
  if (!relacionDeclarada || typeof relacionDeclarada !== 'object') {
    return [{
      motivo: '"relacionRespuestaDirigida" ausente u omitida — es obligatoria este turno: declara cómo tu respuesta se relaciona con la pregunta dirigida del turno anterior',
    }];
  }
  const defectos = [];
  const { relacion, evidenciaTextual, conceptosQueAtienden, feedbackIntervencion } = relacionDeclarada;
  const relacionValida = esRelacionValida(relacion);
  if (!relacionValida) {
    defectos.push({
      motivo: `"relacionRespuestaDirigida.relacion" inválida: "${relacion}" — debe ser exactamente una de ${RELACIONES_RESPUESTA_DIRIGIDA.join(', ')}`,
    });
  }
  if (relacion !== 'NO_PUEDE_RESPONDER' && !esFragmentoLiteral(evidenciaTextual, mensajeUsuario)) {
    defectos.push({
      motivo: '"relacionRespuestaDirigida.evidenciaTextual" debe ser un fragmento literal (copiado tal cual) del mensaje de este turno del experto',
    });
  }
  if (conceptosQueAtienden !== undefined && conceptosQueAtienden !== null && !Array.isArray(conceptosQueAtienden)) {
    defectos.push({ motivo: '"relacionRespuestaDirigida.conceptosQueAtienden" debe ser un array' });
  }
  if (feedbackIntervencion !== undefined && feedbackIntervencion !== null && !FEEDBACK_INTERVENCION.includes(feedbackIntervencion)) {
    defectos.push({ motivo: 'feedbackIntervencion inválido' });
  }

  if (RELACIONES_QUE_EXIGEN_EVIDENCIA_OBJETIVO.includes(relacion)) {
    // TARGETLESS_DIRECTED_RESPONSE_REQUIRES_DIMENSION_SUPPORT -- a
    // legitimately targetless previous act (dimensionObjetivo === null
    // BECAUSE the act itself has no target, never because of a dangling or
    // malformed contract) is already sufficiently supported by the literal-
    // fragment check above (esFragmentoLiteral over evidenciaTextual) --
    // ACT-BOUND support, never dimension-bound. This does not independently
    // decide semantic acceptance: the Producer's own relacion declaration
    // remains the sole authority for what the response means; this only
    // recognizes that a targetless act has no dimension for evidence to
    // bind to. Scoped exclusively via actoAdmiteRespuestaDirigidaSinDimension
    // -- any other operator (including one that unexpectedly carries a null
    // dimensionObjetivo for some OTHER, unproven reason) keeps the exact
    // dimension-bound contract below, unchanged: fails closed exactly as before.
    const modoSoporte = resolverModoSoporteRespuestaDirigida(contrato);
    const actoBoundLegitimo = modoSoporte === MODOS_SOPORTE_RESPUESTA_DIRIGIDA.ACT_BOUND_SIN_DIMENSION;
    if (modoSoporte === MODOS_SOPORTE_RESPUESTA_DIRIGIDA.OPEN_SEARCH) {
      const soporte = evaluarSoporteBusquedaAbierta({ relacionDeclarada, mensajeUsuario, conceptosNuevosEsteTurno });
      if (!soporte.valido) {
        defectos.push({
          motivo: `"relacionRespuestaDirigida" declara "${relacion}" sobre una búsqueda abierta (sin dimensión) pero sin soporte gobernado de ESTE turno (${soporte.causa}): declara en conceptosNuevos, con descripción literal del experto, al menos un concepto que respalde la parte del mensaje que citas en evidenciaTextual, y referéncialo con su idTemporal exacto en conceptosQueAtienden`,
          diagnostico: Object.freeze({
            codigo: DIAGNOSTICOS_RELACION_RESPUESTA_DIRIGIDA.RELACION_POSITIVA_SIN_SOPORTE_BUSQUEDA_ABIERTA,
            relacion,
            dimensionObjetivo: null,
            causa: soporte.causa,
          }),
        });
      }
    } else if (!actoBoundLegitimo) {
      const conceptosEnObjetivo = (conceptosNuevosEsteTurno || [])
        .filter(c => dimensionDeProcedencia(c.procedencia) === contrato.dimensionObjetivo);
      const idsEnObjetivo = new Set(conceptosEnObjetivo
        .map(c => c && (c.idTemporal || c.id))
        .filter(Boolean));
      const referenciasDeclaradas = Array.isArray(conceptosQueAtienden) && conceptosQueAtienden.length > 0;
      const referenciasIntegras = referenciasDeclaradas
        && conceptosQueAtienden.every(id => idsEnObjetivo.has(id));
      if ((!conceptosEnObjetivo.length || (referenciasDeclaradas && !referenciasIntegras))
        && !incertidumbreObjetivoResuelta) {
        defectos.push({
          motivo: `"relacionRespuestaDirigida" declara "${relacion}" sin soporte estructurado referenciado en la dimensión objetivo '${contrato.dimensionObjetivo}' (ni se resolvió la incertidumbre correspondiente)`,
          diagnostico: Object.freeze({
            codigo: DIAGNOSTICOS_RELACION_RESPUESTA_DIRIGIDA.RELACION_POSITIVA_SIN_SOPORTE_ESTRUCTURADO,
            relacion,
            dimensionObjetivo: contrato.dimensionObjetivo,
          }),
        });
      }
    }
  }

  return defectos;
}

// PREVIOUS_RESPONSE_CONTRACT_MUST_BE_VERDICTED_BEFORE_PRODUCER_ACCEPTANCE (C007,
// logistica_c1 turn 17). Whether "relacionRespuestaDirigida" is a mandatory
// POSTCONDITION of a Producer attempt is a property of the PREVIOUS committed
// contract's response lifecycle, never of the protocol state's name: a frozen
// canonical act whose operator expects a directed response
// (OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA) owns the response semantics, and
// those semantics are carried by the relation. `cicloSolicitaRelacion` is the
// caller's fact that THIS response lifecycle asks the Producer for the relation
// (the same fact its prompt contract is built from), so the runtime acceptance
// contract and the prompt contract cannot disagree. It decides nothing about
// WHICH verdict is right (validarRelacionRespuestaDirigida still validates the
// declared relation) and never makes the relation global: a turn without a
// frozen response-expecting act does not require it.
function relacionEsPostcondicionDelProductor({ contrato, cicloSolicitaRelacion }) {
  if (cicloSolicitaRelacion !== true) return false;
  const acto = contrato && contrato.actoCognitivoVisible;
  return !!acto && OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA.includes(acto.operator);
}

// CLOSURE_CONTRACT_ACCEPTANCE_AND_OPTIONAL_OBLIGATION_COORDINATION (C007,
// Daniel-adjudicated, real evidence: logistica_c0 fresh-live turns 11-12,
// session live_complete_logistica_c0_11ec6033). VERIFIED_RESPONSE_TO_CLOSURE
// != UNGOVERNED_RESPONSE_METADATA: a structurally verified directed-response
// relation (validarRelacionRespuestaDirigida above) carries the previous
// canonical act's own identity, but nothing previously turned that pair
// into a contextual verdict any other authority could consume. This is
// COMMON cognitive capability, not DESTINO-specific: it sees only the
// previous canonical act's operator identity and the verified generic
// relation, never a grammar's own dimension/slot ontology (that stays
// GrafoProyeccion's exclusive territory).
//
// GENERIC_RELATION + PREVIOUS_CANONICAL_ACT -> CONTEXTUAL_VERDICT, never a
// global redefinition: ATIENDE_OBJETIVO on ASK_HOW still means "answered
// the requested mechanism" (unchanged); ATIENDE_OBJETIVO on
// PROPOSE_MISSION_CLOSURE means the closure was accepted -- ONLY when the
// relation is verified (never a raw, unverified Producer declaration) and
// ONLY for the one operator this cluster demonstrated. RECHAZA_PREMISA and
// AMBIGUA (and every other relation) never produce an accepted verdict for
// closure -- no speculative mapping for operators/relations this cluster
// never exercised.
const VEREDICTOS_RESPUESTA_ACTO_ANTERIOR = Object.freeze({
  MISSION_CLOSURE_ACCEPTED: 'MISSION_CLOSURE_ACCEPTED',
  NO_VEREDICTO: 'NO_VEREDICTO',
});

/**
 * @param {object|null} previousCanonicalAct — el actoCognitivoVisible ya
 *   congelado del turno anterior (contrato.actoCognitivoVisible), nunca
 *   texto libre del Productor.
 * @param {string|null} relacion — relacionDeclarada.relacion, la MISMA
 *   relación ya validada estructuralmente arriba.
 * @param {boolean} verificada — true únicamente cuando
 *   validarRelacionRespuestaDirigida (o su proyección,
 *   proyectarAlineacionRespuestaDirigida.resultado === RESULTADO_VERIFICADA)
 *   ya confirmó la relación contra ESTE turno -- nunca una relación cruda,
 *   todavía no verificada.
 * @returns {{veredicto: string, razon: string}}
 */
function interpretarVeredictoRespuestaActoAnterior({ previousCanonicalAct, relacion, verificada } = {}) {
  if (!previousCanonicalAct || !relacion || verificada !== true) {
    return {
      veredicto: VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.NO_VEREDICTO,
      razon: !previousCanonicalAct
        ? 'sin acto canónico previo'
        : (!relacion ? 'sin relación declarada' : 'relación no verificada estructuralmente'),
    };
  }
  if (previousCanonicalAct.operator === 'PROPOSE_MISSION_CLOSURE' && relacion === 'ATIENDE_OBJETIVO') {
    return {
      veredicto: VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.MISSION_CLOSURE_ACCEPTED,
      razon: 'respuesta dirigida verificada (ATIENDE_OBJETIVO) contra un PROPOSE_MISSION_CLOSURE congelado',
    };
  }
  return {
    veredicto: VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.NO_VEREDICTO,
    razon: `sin veredicto contextual demostrado para operator="${previousCanonicalAct.operator}" relacion="${relacion}"`,
  };
}

/**
 * Proyección de observabilidad (T-DIM2 Fase 4/5) — nunca gobierna nada por
 * sí misma, solo resume el resultado ya decidido por el Writer para el
 * evento `comprension_conversacional.turno`.
 */
function proyectarAlineacionRespuestaDirigida({ contrato, relacionDeclarada, validacion }) {
  if (!contrato) {
    return Object.freeze({
      aplica: false, relacion: null, evidenciaTextual: null, conceptosQueAtienden: null,
      resultado: RESULTADO_NO_APLICA,
    });
  }
  const relacion = (relacionDeclarada && relacionDeclarada.relacion) || null;
  const evidenciaTextual = (relacionDeclarada && relacionDeclarada.evidenciaTextual) || null;
  const conceptosQueAtienden = (relacionDeclarada && Array.isArray(relacionDeclarada.conceptosQueAtienden))
    ? relacionDeclarada.conceptosQueAtienden : [];
  const feedbackIntervencion = relacionDeclarada && FEEDBACK_INTERVENCION.includes(relacionDeclarada.feedbackIntervencion)
    ? relacionDeclarada.feedbackIntervencion : null;
  const viaPreferida = relacionDeclarada && typeof relacionDeclarada.viaPreferida === 'string'
    ? relacionDeclarada.viaPreferida : null;
  const propuesta = relacionDeclarada && relacionDeclarada.satisfaccionReparacion;
  const satisfaccionReparacion = (validacion && validacion.valido && propuesta
    && contrato.referenciaResolucion
    && propuesta.intentoInterpretacionId === contrato.referenciaResolucion.intentoInterpretacionId
    && Array.isArray(propuesta.materialIds))
    ? Object.freeze({
        ...propuesta,
        obligacionId: contrato.referenciaResolucion.obligacionId,
        intentoInterpretacionId: contrato.referenciaResolucion.intentoInterpretacionId,
      }) : null;
  return Object.freeze({
    aplica: true, relacion, evidenciaTextual, conceptosQueAtienden, feedbackIntervencion, viaPreferida,
    satisfaccionReparacion,
    resultado: (validacion && validacion.valido) ? RESULTADO_VERIFICADA : RESULTADO_ALINEACION_NO_VERIFICABLE,
  });
}

module.exports = {
  DIAGNOSTICOS_RELACION_RESPUESTA_DIRIGIDA,
  RELACIONES_RESPUESTA_DIRIGIDA,
  FEEDBACK_INTERVENCION,
  RELACIONES_QUE_EXIGEN_EVIDENCIA_OBJETIVO,
  OPERADORES_CON_RESPUESTA_DIRIGIDA_SIN_DIMENSION,
  actoAdmiteRespuestaDirigidaSinDimension,
  MODOS_SOPORTE_RESPUESTA_DIRIGIDA,
  resolverModoSoporteRespuestaDirigida,
  objetivoDeActoEsBusquedaAbiertaNoGobernada,
  evaluarSoporteBusquedaAbierta,
  VEREDICTOS_RESPUESTA_ACTO_ANTERIOR,
  interpretarVeredictoRespuestaActoAnterior,
  FUNCION_ESPERADA_POR_MOVIMIENTO,
  CRITERIO_DE_RESOLUCION_GENERICO,
  RESULTADO_ALINEACION_NO_VERIFICABLE,
  RESULTADO_VERIFICADA,
  RESULTADO_NO_APLICA,
  reconstruirContratoRespuestaDirigida,
  esRelacionValida,
  construirContextoSatisfaccionRespuestaDirigida,
  validarRelacionRespuestaDirigida,
  listarDefectosRelacionRespuestaDirigida,
  relacionEsPostcondicionDelProductor,
  proyectarAlineacionRespuestaDirigida,
};
