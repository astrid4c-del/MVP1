'use strict';

/**
 * OBJETIVO CONVERSACIONAL DEL TURNO (P1-B, circulomejora006 — autoridad de
 * objetivo conversacional ante cierre).
 *
 * Primera rebanada de una autoridad general, separada explícitamente de
 * Movimiento (ver auditoría P1-D/contrato P1-B, "Principio arquitectónico"):
 *
 *   observación conversacional → OBJETIVO POSITIVO DEL TURNO → restricciones
 *   cognitivas → movimiento admisible → materialización
 *
 * Esta política decide QUÉ debe intentar conseguir ahora la conversación —
 * nunca CÓMO decirlo (eso sigue siendo Movimiento/Gobernanza/Realizador) ni
 * SI es seguro decirlo (eso sigue siendo Movimiento, que conserva autoridad
 * sobre seguridad epistémica, función conversacional admisible, dimensión,
 * techo lingüístico y reparaciones obligatorias). No redacta texto, no
 * modifica el grafo, no confirma nada.
 *
 * `decidirObjetivoConversacional` es pura y determinista: dado un cierre
 * activo (señal de este turno o intención abierta en un turno anterior) y
 * una fotografía cognitiva, declara el objetivo. `avanzarIntencionCierre`
 * gobierna el ciclo de vida durable de esa intención entre turnos —
 * también pura, nunca toca CognitiveState directamente (el Writer decide
 * cuándo persistir su resultado).
 */

const {
  dimensionesConInterpretacionPendiente,
  ultimoIntentoAbstraccionMaterializado,
  dimensionesElegiblesNoAtendidas,
  dimensionesPendientes,
  coberturaCompleta,
  conceptosDeGramatica,
  dimensionDeProcedencia,
  alcanceEpistemicoConcepto,
  incertidumbreAccionable,
  resolverAutoridadTransformacionalCanonica,
  gramaticaDeDimension,
} = require('../state/GrafoProyeccion');
const { getGrammarMissionDescriptor, PROPOSITO_GLOBAL } = require('../state/GrammarMissionAdapter');

const OPERACIONES_OPORTUNIDAD = Object.freeze(['ABRIR_COMO', 'PEDIR_EJEMPLO', 'SITUAR_EN_CONTEXTO', 'ENSAYAR_CRITERIO', 'FORMULAR_VOZ_INTERIOR']);

const OBJETIVOS_CONVERSACIONALES = Object.freeze({
  NO_APLICA: 'NO_APLICA',
  OBTENER_VEREDICTO_PENDIENTE: 'OBTENER_VEREDICTO_PENDIENTE',
  MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE: 'MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE',
  PERMITIR_AVANCE_YA_AUTORIZADO: 'PERMITIR_AVANCE_YA_AUTORIZADO',
  EXPONER_DEUDA_DURA_MINIMA: 'EXPONER_DEUDA_DURA_MINIMA',
  BLOQUEADO_POR_DECISION_DE_PRODUCTO: 'BLOQUEADO_POR_DECISION_DE_PRODUCTO',
  REPARAR_RELACION_TRANSFORMACIONAL: 'REPARAR_RELACION_TRANSFORMACIONAL',
});

// Mapa observacional (Fase 6: "razón si el movimiento no pudo obedecer el
// objetivo") — nunca gobierna nada, solo permite comparar lo decidido
// contra lo efectivamente ejecutado. Los objetivos ausentes de este mapa
// (NO_APLICA/PERMITIR_AVANCE_YA_AUTORIZADO/EXPONER_DEUDA_DURA_MINIMA/
// BLOQUEADO_POR_DECISION_DE_PRODUCTO) no exigen un movimiento específico —
// Movimiento conserva autoridad completa sobre esos casos.
const MOVIMIENTO_ESPERADO_POR_OBJETIVO = Object.freeze({
  [OBJETIVOS_CONVERSACIONALES.OBTENER_VEREDICTO_PENDIENTE]: 'SOLICITAR_VEREDICTO_INTERPRETACION',
  [OBJETIVOS_CONVERSACIONALES.MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE]: 'PROPONER_INTERPRETACION',
});

// Ganancia efímera decidida desde la comprensión estructurada de Capa 1.
// Requiere soporte nuevo del mismo turno; un simple reconocimiento no crea
// una intervención adicional. No introduce identidad, lifecycle ni taxonomía.
function seleccionarGananciaCognitiva(cognicionCapa1, grafo = null, {
  directedUnknownId = null,
  directedResponseTurnId = null,
} = {}) {
  if (!cognicionCapa1 || typeof cognicionCapa1 !== 'object') return null;
  // Grounding and novelty are separate cognitive judgments.  Reuse the
  // typed interpretation evaluation when present; it is the authority's
  // explicit signal that a proposed compression adds (or does not add)
  // understanding over the accumulated working state.  No text comparison
  // is performed here.
  const evaluacion = cognicionCapa1.evaluacionGanancia;
  const declarada = typeof cognicionCapa1.gananciaCognitiva === 'string'
    ? cognicionCapa1.gananciaCognitiva.trim() : '';
  const observacion = typeof cognicionCapa1.observacion === 'string'
    ? cognicionCapa1.observacion.trim() : '';
  const relaciones = Array.isArray(cognicionCapa1.relacionesNuevas)
    ? cognicionCapa1.relacionesNuevas : [];
  const conceptos = Array.isArray(cognicionCapa1.conceptosNuevos)
    ? cognicionCapa1.conceptosNuevos : [];
  const contenido = declarada || (relaciones.length > 0 ? observacion : '');
  if (!contenido) return null;
  // A supported statement is not automatically a new cognitive gain.  The
  // gain-specific typed judgment is mandatory; interpretation evaluation is
  // a different object and cannot authorize this act.
  if (!evaluacion || typeof evaluacion !== 'object'
    || String(evaluacion.resultado || '').toUpperCase() !== 'NUEVA_COMPRENSION') return null;
  // A negative answer does not need (and must not manufacture) a positive
  // expert concept to support its gain. Its governed support is the durable
  // SemanticUnknown that the directed-response mutation has just closed.
  // This remains the same gain-selection authority: a raw "No" or a Capa1
  // label alone is insufficient without the canonical closure and the typed
  // satisfaction judgment.
  const tipoRespuestaNegativa = cognicionCapa1.respuestaNegativa
    && String(cognicionCapa1.respuestaNegativa.tipo || '').toUpperCase();
  const relacionDirigida = cognicionCapa1.relacionRespuestaDirigida
    && String(cognicionCapa1.relacionRespuestaDirigida.relacion || '').toUpperCase();
  const satisfaccionTipada = evaluacion.satisfaccionConocimiento;
  const unknownNegativoGobernado = ['NO_EXISTE', 'NO_APLICA'].includes(tipoRespuestaNegativa)
    && relacionDirigida === 'RECHAZA_PREMISA'
    && satisfaccionTipada
    && satisfaccionTipada.estado === 'SATISFECHA'
    && grafo
    && Array.isArray(grafo.incertidumbres)
    ? grafo.incertidumbres.find(u => u
      && u.resuelta === true
      && u.estado === 'CERRADO_SIN_EVIDENCIA'
      && u.motivoCierre === tipoRespuestaNegativa
      && Array.isArray(u.historia)
      && u.historia.length > 0
      && u.historia[u.historia.length - 1].relacion === 'RECHAZA_PREMISA')
    : null;
  if (unknownNegativoGobernado) {
    return {
      contenido,
      soporteConceptoIds: [unknownNegativoGobernado.id],
      soporteUnknownIds: [unknownNegativoGobernado.id],
    };
  }
  // INDEPENDENT_GOVERNED_GAIN_SURVIVES_REDUNDANT_SIBLING_OPPORTUNITY (C007,
  // Daniel-adjudicated, real evidence: logistica_c1 turn 16). `conceptos`
  // (this SAME Producer attempt's own conceptosNuevos) is only ONE of two
  // legitimate sources of grounding -- the other is the durable graph
  // itself, already consulted by evaluarSatisfaccionConocimiento below via
  // its own `grafo.conceptos` lookup. A gain proposed across several
  // internal retries this SAME turn may have its supporting concepts
  // already committed durably by an EARLIER retry (exactly the comment
  // just below already anticipates -- "Materialization may already have
  // added the durable id before this policy runs"), so the FINAL attempt's
  // own conceptosNuevos can legitimately be empty while evidenciaConceptoIds
  // still resolves fully against the durable graph. Requiring `conceptos`
  // non-empty here rejected that case before evaluarSatisfaccionConocimiento
  // ever got to prove it -- PRODUCT_FREE_FORM_TEXT_DOES_NOT_CREATE_
  // CONTRACTUAL_AUTHORITY is unaffected: this only ever widens WHERE
  // grounding may already durably exist, never what counts as grounding.
  // Still fails closed on a genuinely ungrounded gain: if evaluacion.
  // satisfaccionConocimiento cites no evidenciaConceptoIds at all, or they
  // don't resolve to an active, expert-authority durable concept,
  // evaluarSatisfaccionConocimiento/the SATISFECHA checks below (unchanged)
  // still return null exactly as before.
  const evidenciaDeclarada = evaluacion.satisfaccionConocimiento
    && Array.isArray(evaluacion.satisfaccionConocimiento.evidenciaConceptoIds)
    ? evaluacion.satisfaccionConocimiento.evidenciaConceptoIds : [];
  if (conceptos.length === 0 && evidenciaDeclarada.length === 0) return null;
  // Evidence references resolve against the governed graph. Same-turn
  // evidence is eligible only after the canonical dimension/authority gate
  // stamped it; a raw Capa1 `autoridad:"experto"` label is insufficient.
  const conceptosGobernadosEsteTurno = conceptos
    .filter(c => c && c.autoridad === 'experto'
      && ['CONCORDANTE', 'SIN_OBJETIVO_VIGENTE', 'ADJUDICADA_CONFORME'].includes(c.autoridadGobernanzaDimension)
      && (c.id || c.idTemporal))
    .flatMap(c => {
      const durable = { ...c, id: c.id || c.idTemporal, activo: c.activo !== false };
      // evaluacionGanancia is emitted in the same producer response and
      // therefore legitimately references idTemporal. Materialization may
      // already have added the durable id before this policy runs; expose
      // the temporary identity as an alias only for satisfaction checking.
      return c.idTemporal && c.idTemporal !== durable.id
        ? [durable, { ...durable, id: c.idTemporal }]
        : [durable];
    });
  const grafoParaSatisfaccion = conceptosGobernadosEsteTurno.length > 0
    ? { ...(grafo || {}), conceptos: [
        ...((grafo && Array.isArray(grafo.conceptos)) ? grafo.conceptos : []),
        ...conceptosGobernadosEsteTurno,
      ] }
    : grafo;
  const satisfaccion = evaluarSatisfaccionConocimiento(grafoParaSatisfaccion, {
    satisfaccionConocimiento: evaluacion.satisfaccionConocimiento,
  });
  // PARCIAL is not sufficient on its own. It may carry a returnable new
  // compression only when the current directed response already closed a
  // canonical outstanding unknown; the residue then describes subsequent
  // depth, not missing support for the gain itself.
  const relacionPositiva = ['ATIENDE_OBJETIVO', 'ATIENDE_PARCIALMENTE', 'MEZCLA_DIMENSIONES']
    .includes(relacionDirigida);
  const cierreDirigidoGobernado = satisfaccion.estado === 'PARCIAL'
    && relacionPositiva
    && directedUnknownId
    && directedResponseTurnId
    && grafo
    && Array.isArray(grafo.incertidumbres)
    && grafo.incertidumbres.some(u => u && u.id === directedUnknownId
      && u.resuelta === true && u.estado !== 'ABIERTO'
      && Array.isArray(u.historia) && u.historia.length > 0
      && u.historia[u.historia.length - 1].relacion === relacionDirigida
      && u.historia[u.historia.length - 1].turnoOrigenId === directedResponseTurnId);
  if (!satisfaccion.valido
    || (satisfaccion.estado !== 'SATISFECHA' && !cierreDirigidoGobernado)) return null;
  const soporteConceptoIds = Array.isArray(satisfaccion.evidenciaConceptoIds)
    ? satisfaccion.evidenciaConceptoIds : [];
  return soporteConceptoIds.length > 0 ? { contenido, soporteConceptoIds } : null;
}

// La autoridad de objetivo congela el acto cognitivo antes de que Movimiento
// pueda elegir una función.  No crea estado nuevo: solo transporta la forma
// efímera ya propuesta (WHAT interrogativo u observación con ganancia).
function seleccionarActoCognitivo({ oportunidadSeleccionada = null, gananciaCognitiva = null } = {}) {
  if (oportunidadSeleccionada) {
    return Object.freeze({
      tipo: 'INTERROGATIVE',
      semanticTarget: oportunidadSeleccionada.semanticTarget || null,
      unknownId: oportunidadSeleccionada.unknownId || null,
      operacion: oportunidadSeleccionada.operacion || null,
    });
  }
  if (gananciaCognitiva && typeof gananciaCognitiva.contenido === 'string'
    && gananciaCognitiva.contenido.trim()
    && Array.isArray(gananciaCognitiva.soporteConceptoIds)
    && gananciaCognitiva.soporteConceptoIds.length > 0) {
    return Object.freeze({ tipo: 'NON_INTERROGATIVE', gananciaCognitiva });
  }
  return null;
}

// La operación tipada es la única fuente autoritativa de la intención
// exploratoria.  Los textos libres de Capa 1 permanecen como rationale y no
// pueden introducir la forma factual de lo desconocido.
function intencionAbiertaDesdeOperacion(operacion) {
  return operacion ? 'explorar materialmente el anclaje autorizado' : 'explorar material autorizado';
}

// Capa 1 may judge that a proposed proposition is already covered by
// knowledge, but only governance can grant or deny the right to open an
// uncertainty.  Evidence references must point to active, expert-authorized
// concepts; no textual or dimensional equivalence is inferred here.
function evaluarSatisfaccionConocimiento(grafo, propuesta) {
  const claim = propuesta && propuesta.satisfaccionConocimiento;
  // A semantic target has no right to open an unknown unless Layer 1
  // explicitly evaluates its relation to the current knowledge graph.
  const hasSemanticTarget = !!(propuesta && (propuesta.semanticTarget || propuesta.proposicion));
  const targetText = propuesta && (propuesta.semanticTarget || propuesta.proposicion);
  const referentText = propuesta && (propuesta.referenteSemantico || propuesta.subjectRef);
  if (hasSemanticTarget
    && (typeof targetText !== 'string' || !targetText.trim()
      || typeof referentText !== 'string' || !referentText.trim())) {
    return { estado: 'NO_AUTORIZADA', valido: false, razon: 'TARGET_SEMANTICO_INCOMPLETO' };
  }
  if (!claim || typeof claim !== 'object') {
    if (!hasSemanticTarget) return { estado: 'ABIERTA', valido: true };
    return { estado: 'NO_AUTORIZADA', valido: false, razon: 'EVALUACION_SATISFACCION_AUSENTE' };
  }
  const estado = claim.estado;
  if (!['SATISFECHA', 'PARCIAL', 'ABIERTA'].includes(estado)) {
    return { estado: 'NO_AUTORIZADA', valido: false, razon: 'ESTADO_SATISFACCION_INVALIDO' };
  }
  if (estado === 'ABIERTA') return { estado, valido: true };
  const ids = Array.isArray(claim.evidenciaConceptoIds) ? [...new Set(claim.evidenciaConceptoIds)] : [];
  const conceptos = new Map((grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : []).map(c => [c.id, c]));
  const evidenciaValida = ids.length > 0 && ids.every(id => {
    const c = conceptos.get(id);
    return !!(c && c.activo !== false && c.autoridad === 'experto');
  });
  if (!evidenciaValida) return { estado: 'NO_AUTORIZADA', valido: false, razon: 'EVIDENCIA_SATISFACCION_NO_AUTORIZADA' };
  if (estado === 'SATISFECHA') return { estado, valido: true, evidenciaConceptoIds: ids };
  const residuo = claim.residuoSemantico;
  const residuoValido = residuo && typeof residuo === 'object'
    && typeof residuo.semanticTarget === 'string' && residuo.semanticTarget.trim()
    && typeof residuo.referenteSemantico === 'string' && residuo.referenteSemantico.trim()
    && typeof residuo.operation === 'string' && residuo.operation.trim();
  if (!residuoValido) return { estado: 'NO_AUTORIZADA', valido: false, razon: 'RESIDUO_SATISFACCION_INCOMPLETO' };
  return { estado, valido: true, evidenciaConceptoIds: ids, residuo: {
    semanticTarget: residuo.semanticTarget.trim(),
    referenteSemantico: residuo.referenteSemantico.trim(),
    operation: residuo.operation.trim(),
    oportunidadRef: typeof residuo.oportunidadRef === 'string'
      ? residuo.oportunidadRef.trim() : null,
  } };
}

// A positive directed answer changes the epistemic baseline before the next
// candidate is admitted. This policy never compares prose for similarity:
// novelty must be demonstrated by an existing different unknown, a different
// governed dimension, or a gain residue that explicitly references the
// opportunity identity representing its pending depth. Descriptions explain;
// oportunidadRef identifies. Rephrasing a resolved need has no such identity.
// C007 — human canary v5, NEW_IDENTITY != NEW_COGNITIVE_NEED. A valid typed
// residue identity is a precondition for admitting content-novelty
// governance, never a substitute for it: `veredictoNovedadContenido`, when
// provided, is the ALREADY-COMPUTED verdict of a separate semantic
// authority (ValidadorNovedadCognitivaResiduo — a real, independent
// judgment of whether the candidate's content is genuinely unaddressed by
// what this same turn's evidence just satisfied). This function never
// interprets prose itself to produce that verdict — it only consumes an
// externally governed value, exactly like it already consumes
// evaluacionGanancia. Omitting the parameter (default null) reproduces the
// prior identity-only behavior byte for byte — this seam is additive.
function evaluarNovedadOportunidadTrasRespuestaDirigida({
  grafo = null,
  oportunidad = null,
  actoCognitivoPrevio = null,
  evaluacionGanancia = null,
  veredictoNovedadContenido = null,
  // C007 — PARTIAL RESIDUE MUST REPRESENT INCREMENTAL DEPTH (human canary
  // v13 T3). PARTIAL_SATISFACTION -> REQUIRES_INCREMENTAL_RESIDUE: the exact
  // same governance below (identity match, then content-novelty verdict)
  // already correctly gates a residue that tries to reopen a need this
  // turn's directed answer just fully SATISFIED. The same gate must apply
  // when the directed answer only PARTIALLY attended its target and that
  // target is STILL open -- PARCIAL + SAME_PARENT_UNKNOWN + NO_INCREMENTAL_
  // RESIDUAL_DEPTH -> MUST_NOT_AUTHORIZE_REASK. This flag, computed by the
  // caller from THIS turn's own relacionRespuestaDirigida (ATIENDE_
  // PARCIALMENTE) and the target's still-open graph state, is the ONLY
  // difference from the existing SATISFECHA path -- no new ontology, no new
  // validator: it only widens WHEN `necesidadResuelta` below is populated.
  // Default false reproduces prior behavior byte for byte.
  respuestaDirigidaParcialEsteTurno = false,
} = {}) {
  if (!oportunidad || !actoCognitivoPrevio || !actoCognitivoPrevio.target) {
    return { elegible: true, razon: null };
  }
  const unknowns = grafo && Array.isArray(grafo.incertidumbres) ? grafo.incertidumbres : [];
  const necesidadResuelta = unknowns.find(u => u && u.id === actoCognitivoPrevio.target
    && (
      (u.resuelta === true && u.estado !== 'ABIERTO')
      || (respuestaDirigidaParcialEsteTurno && u.resuelta !== true)
    ));
  if (!necesidadResuelta) return { elegible: true, razon: null };

  // C007 — RESIDUE CONTINUATION + OPPORTUNITY REFERENTIAL INTEGRITY (human
  // canary v11 T2). Residue identity is carried by gain.residuoSemantico.
  // oportunidadRef, not by requiring the target opportunity to already hold
  // its own PARCIAL residue. An opportunity still ABIERTA (no evidence
  // gathered yet) or itself PARCIAL is legitimately the pending depth a
  // PARCIAL gain leaves behind — its epistemic state describes the
  // knowledge available about that target, it does not fabricate or deny
  // the residue's identity. Only SATISFECHA (or an absent/invalid claim)
  // excludes it: a need already fully answered has no pending depth left to
  // be the target of a residue. Computed BEFORE the unknownId check below
  // (PARENT_NEED_SATISFIED != TYPED_RESIDUAL_DEPTH_SATISFIED): an
  // opportunity legitimately anchors its unknownId to the very need it
  // deepens, so unknownId equality alone must never preempt this match.
  const satisfaccionOportunidad = oportunidad.satisfaccionConocimiento;
  const oportunidadElegibleParaResiduo = !!(satisfaccionOportunidad
    && typeof satisfaccionOportunidad === 'object'
    && ['ABIERTA', 'PARCIAL'].includes(satisfaccionOportunidad.estado));
  const satisfaccionGanancia = evaluacionGanancia && evaluacionGanancia.satisfaccionConocimiento;
  const residuoGanancia = satisfaccionGanancia
    && satisfaccionGanancia.estado === 'PARCIAL'
    && satisfaccionGanancia.residuoSemantico;
  const oportunidadRef = residuoGanancia
    && typeof residuoGanancia.oportunidadRef === 'string'
    ? residuoGanancia.oportunidadRef.trim() : '';
  // Authority is the identity match alone: gain.residuoSemantico.oportunidadRef
  // === oportunidad.idTemporal. An unmatched or invalid ref never acquires
  // authority, regardless of the opportunity's own state (RESIDUE_LINK_IDENTITY
  // != OPPORTUNITY_SATISFACTION_STATE).
  const identidadResiduoCoincide = !!(oportunidadElegibleParaResiduo
    && oportunidadRef
    && typeof oportunidad.idTemporal === 'string'
    && oportunidad.idTemporal === oportunidadRef);

  const oportunidadUnknownId = oportunidad.semanticUnknownId || oportunidad.unknownId || null;
  if (oportunidadUnknownId) {
    const otraNecesidadAbierta = unknowns.find(u => u && u.id === oportunidadUnknownId
      && u.id !== necesidadResuelta.id && u.estado === 'ABIERTO' && u.resuelta !== true);
    if (otraNecesidadAbierta) return { elegible: true, razon: 'OTRA_IDENTIDAD_ABIERTA' };
    // Only when the opportunity's own unknownId IS the need this turn just
    // satisfied does a valid typed residue identity get a chance to survive
    // it — a reference to any OTHER, unrelated already-resolved unknown
    // stays rejected exactly as before (SATISFIED_NEED + REPHRASED_
    // OPPORTUNITY + NO_TYPED_RESIDUE -> NOT_ELIGIBLE is unaffected).
    if (oportunidadUnknownId !== necesidadResuelta.id || !identidadResiduoCoincide) {
      return { elegible: false, razon: 'NECESIDAD_DIRIGIDA_YA_SATISFECHA' };
    }
    // Falls through to the same content-novelty gate below as any other
    // typed-residue candidate — identity alone still never proves the
    // direction is new.
  } else {
    const dimensionOportunidad = oportunidad.dimension || oportunidad.dimensionObjetivo || null;
    if (dimensionOportunidad && necesidadResuelta.dimension
      && dimensionOportunidad !== necesidadResuelta.dimension) {
      return { elegible: true, razon: 'OTRA_DIMENSION_GOBERNADA' };
    }
    if (!identidadResiduoCoincide) return { elegible: false, razon: 'NOVEDAD_COGNITIVA_NO_DEMOSTRADA' };
  }
  // Identity alone never proves the direction is new (NEW_IDENTITY !=
  // NEW_COGNITIVE_NEED). Content-novelty governance runs strictly after
  // identity is established, and its verdict — never this function's own
  // string interpretation — decides whether the residue survives.
  if (veredictoNovedadContenido === 'REPHRASED_SATISFIED_NEED') {
    return { elegible: false, razon: 'RESIDUO_REFORMULA_NECESIDAD_SATISFECHA' };
  }
  if (veredictoNovedadContenido === 'INSUFFICIENT_NOVELTY_BASIS') {
    return { elegible: false, razon: 'BASE_DE_NOVEDAD_COGNITIVA_INSUFICIENTE' };
  }
  // 'DISTINCT_COGNITIVE_RESIDUE', or no verdict supplied (caller did not
  // wire content-novelty governance for this candidate) — identity remains
  // the deciding authority, exactly as before this seam existed.
  return { elegible: true, razon: 'RESIDUO_COGNITIVO_TIPADO_NUEVO' };
}

function seleccionarOportunidadConversacional(grafo, oportunidades = [], {
  operacionesSoportadas = OPERACIONES_OPORTUNIDAD,
  requiereAnchorTransformacion = false,
  requiereAnchorDestilar = false,
  operacionAnclaje = null,
  sujetoObjetivo = null,
  desconocidoObjetivo = null,
  objetivoTipado = null,
  evidenciaTipada = null,
  unknownPendiente = null,
  comprensionTrabajo = null,
  focoConversacionalActual = null,
} = {}) {
  if (!Array.isArray(oportunidades)) return null;
  const operacionParaAnclaje = operacionAnclaje
    || (requiereAnchorTransformacion ? 'SITUAR_EN_CONTEXTO' : (requiereAnchorDestilar ? 'ENSAYAR_CRITERIO' : null));
  const conceptos = new Map((requiereAnchorTransformacion || requiereAnchorDestilar
    || operacionParaAnclaje
    ? anclajesElegiblesParaOperacion(grafo, operacionParaAnclaje)
    : (grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [])
      .filter(c => c && c.activo !== false && c.autoridad === 'experto'))
    .map(c => [c.id, c]));
  const relaciones = new Set((grafo && Array.isArray(grafo.relaciones) ? grafo.relaciones : [])
    .map(r => r && r.id).filter(Boolean));
  const conceptosPorDescripcion = new Map((grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [])
    .filter(c => c && c.activo !== false && c.autoridad === 'experto')
    .map(c => [c.descripcion, c.id]));
  const focoIds = new Set();
  if (focoConversacionalActual && conceptosPorDescripcion.has(focoConversacionalActual)) {
    focoIds.add(conceptosPorDescripcion.get(focoConversacionalActual));
  }
  if (comprensionTrabajo && Array.isArray(comprensionTrabajo.materialAutorizado)) {
    comprensionTrabajo.materialAutorizado.forEach(texto => {
      const id = conceptosPorDescripcion.get(texto);
      if (id) focoIds.add(id);
    });
  }
  const ordenadas = [...oportunidades].sort((a, b) => {
    // Desempate estructurado: identidad de anclajes, relaciones y estado
    // de UNKNOWN. No se interpreta texto libre ni se usa substring como
    // autoridad de relevancia.
    const score = (p) => {
      const anchors = Array.isArray(p && p.anclajeConceptoIds) ? p.anclajeConceptoIds : [];
      const relations = Array.isArray(p && p.anclajeRelacionIds) ? p.anclajeRelacionIds : [];
      return anchors.reduce((n, id) => n + (focoIds.has(id) ? 4 : 0), 0)
        + relations.reduce((n, id) => n + (relaciones.has(id) ? 1 : 0), 0)
        + (p && p.desconocidoObjetivo && desconocidoObjetivo
          && p.desconocidoObjetivo === desconocidoObjetivo ? 2 : 0);
    };
    return score(b) - score(a);
  });
  const seleccionado = ordenadas.slice(0, 3).map((propuesta, indice) => {
    if (!propuesta || typeof propuesta !== 'object') return null;
    const anclajeConceptoIds = Array.isArray(propuesta.anclajeConceptoIds)
      ? [...new Set(propuesta.anclajeConceptoIds.filter(id => conceptos.has(id)))] : [];
    const anclajeRelacionIds = Array.isArray(propuesta.anclajeRelacionIds)
      ? [...new Set(propuesta.anclajeRelacionIds.filter(id => relaciones.has(id)))] : [];
    const desconocidoPropuesto = typeof propuesta.desconocidoObjetivo === 'string'
      ? propuesta.desconocidoObjetivo.trim() : '';
    const evidenciaBuscada = typeof propuesta.evidenciaBuscada === 'string'
      ? propuesta.evidenciaBuscada.trim() : '';
    const satisfaccion = evaluarSatisfaccionConocimiento(grafo, propuesta);
    if (!satisfaccion.valido || satisfaccion.estado === 'SATISFECHA') return null;
    const semanticTarget = satisfaccion.residuo
      ? satisfaccion.residuo.semanticTarget : (propuesta.semanticTarget || propuesta.proposicion || null);
    const referenteSemantico = satisfaccion.residuo
      ? satisfaccion.residuo.referenteSemantico : (propuesta.referenteSemantico || propuesta.subjectRef || null);
    const semanticUnknownId = propuesta.unknownId || propuesta.semanticUnknownId || null;
    const unknownGoverned = semanticUnknownId
      ? (grafo && Array.isArray(grafo.incertidumbres)
        ? grafo.incertidumbres.find(u => u && u.id === semanticUnknownId
          && (u.semanticUnknown === true || u.kind === 'SEMANTIC_UNKNOWN')
          && u.estado === 'ABIERTO' && u.relevante !== false)
        : null)
      : null;
    const unknownGrounded = !!unknownGoverned;
    const semanticDimension = propuesta.dimension || propuesta.dimensionObjetivo || null;
    const operacionPropuesta = satisfaccion.residuo ? satisfaccion.residuo.operation : propuesta.operacion;
    const operacion = typeof operacionPropuesta === 'string' && operacionesSoportadas.includes(operacionPropuesta)
      ? operacionPropuesta : null;
    // A canonical governed unknown is itself a grounding identity; do not
    // require a synthetic concept anchor. Envelope candidates without an
    // explicit unknown retain the normal governed-anchor requirement.
    if (anclajeConceptoIds.length === 0 && !unknownGrounded) return null;
    if (!operacion) return null;
    const dimensionCanonica = desconocidoObjetivo || desconocidoPropuesto || intencionAbiertaDesdeOperacion(operacion);
    // PER_CANDIDATE_DIMENSION_HONORED correction (C007,
    // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION,
    // Daniel-adjudicated, real evidence: logistica_c0 turn 13). The real
    // Producer output populates `dimension` (semanticDimension, above --
    // the SAME field crearSemanticUnknownCandidate ultimately receives as
    // this candidate's durable dimension), never desconocidoObjetivo. The
    // pending-need check below must consult that SAME authoritative field
    // when the Producer supplied it, never the generic
    // desconocidoObjetivo/intencionAbiertaDesdeOperacion fallback derived
    // above for rationale/display purposes only -- otherwise a candidate
    // correctly targeting a genuinely-pending required dimension gets
    // checked against an unrelated placeholder string instead. Falls back
    // to dimensionCanonica byte-for-byte when the Producer never populated
    // `dimension` at all (every pre-existing caller/fixture, unchanged).
    const dimensionParaPendiente = typeof semanticDimension === 'string' && semanticDimension.trim()
      ? semanticDimension.trim() : dimensionCanonica;
    if (typeof unknownPendiente === 'function'
      && !unknownPendiente({ sujeto: sujetoObjetivo || propuesta.sujetoObjetivo || null, dimension: dimensionParaPendiente, operacion })) return null;
    return Object.freeze({
      idTemporal: typeof propuesta.idTemporal === 'string' ? propuesta.idTemporal : `oportunidad_${indice + 1}`,
      anclajeConceptoIds,
      anclajeRelacionIds,
      operacion,
      sujetoObjetivo: sujetoObjetivo || (typeof propuesta.sujetoObjetivo === 'string'
        ? propuesta.sujetoObjetivo.trim() : null),
      focoExploracion: anclajeConceptoIds.map(id => conceptos.get(id).descripcion),
      // Se conservan para trazabilidad/rationale; el desconocido tipado
      // contratado también debe sobrevivir hasta el contrato común.
      rationaleDesconocido: desconocidoPropuesto || null,
      rationaleEvidencia: evidenciaBuscada || null,
      desconocidoObjetivo: dimensionCanonica,
      evidenciaBuscada: evidenciaBuscada || intencionAbiertaDesdeOperacion(operacion),
      semanticTarget: typeof semanticTarget === 'string' ? semanticTarget.trim() : null,
      referenteSemantico: typeof referenteSemantico === 'string' ? referenteSemantico.trim() : null,
      unknownId: semanticUnknownId,
      semanticUnknownId,
      dimension: typeof semanticDimension === 'string' ? semanticDimension.trim() : null,
      viaAcceso: propuesta.viaAcceso || null,
      feedbackIntervencion: propuesta.feedbackIntervencion || null,
      viaPreferida: propuesta.viaPreferida || null,
      satisfaccionConocimiento: satisfaccion,
      objetivo: objetivoTipado || null,
      valorConversacional: typeof propuesta.valorConversacional === 'string' ? propuesta.valorConversacional.trim() : null,
    });
  }).find(Boolean) || null;
  return seleccionado;
}

// NATIVE_GRAMMAR_GOVERNED_OUTPUT_CAN_ANCHOR_LATER_NATIVE_PROGRESSION (C007,
// Daniel-adjudicated). COMMON MECHANIC, shared by every grammar that needs
// it: is `concepto` durable, governed prior material belonging to
// `gramatica`'s own native dimension lifecycle? HOW eligibility is safely
// evaluated (durable graph membership -- callers only ever see grafo.conceptos,
// never a same-turn uncommitted proposal -- plus dimension->grammar mapping)
// is common; WHAT is semantically admissible (which grammar, which operation)
// stays grammar-owned, decided by each named wrapper below, never inlined
// at the call site.
function esAnclajeDeProgresionNativaDeGramatica(concepto, gramatica) {
  if (!concepto || typeof concepto !== 'object') return false;
  return gramaticaDeDimension(dimensionDeProcedencia(concepto.procedencia)) === gramatica;
}

// ASCENSO_PROGRESSIVE_ANCHOR_CHAIN (C007, Daniel-adjudicated, real evidence:
// logistica_c0 live turns 36-39, session live_complete_logistica_c0_11ec6033).
// ROOT_ANCHOR_AUTHORITY != ONLY_VALID_PROGRESS_ANCHOR: ENSAYAR_CRITERIO's
// bootstrap anchor (the transferred DESTILAR criterion, CRITERIO_DESTILAR)
// remains valid, but it is not the ONLY legitimate anchor once ASCENSO has
// begun producing its OWN governed practice knowledge (ensayo/prueba_propia/
// escalon). Real evidence: the Producer voluntarily proposed rich, specific,
// evolving escalon-dimension opportunities every turn (turn36: transition
// from observing to unblocking the flow independently; turn38: transferring
// the criterion to a different zone unaccompanied; turn39: increasing
// complexity after the aprendiz masters initial observation) -- each one
// anchored on ASCENSO's own already-committed ensayo/prueba_propia material,
// and each one rejected purely because that material's epistemic scope is
// MATERIAL_EXPERTO, not CRITERIO_DESTILAR. The rejection forced a fallback
// to grammar-wide static text every time, producing near/byte-identical
// visible questions across turns despite the user supplying genuinely new,
// on-topic answers each time. SEMANTIC_AUTHORITY != ORIGIN_GRAMMAR_ONLY:
// origin remains relevant (this is why the check is scoped to ENSAYAR_CRITERIO
// specifically, and to a grammar-owned predicate, not broadened to every
// MATERIAL_EXPERTO concept globally), but once ASCENSO owns governed output
// of its own, that output is legitimate material for its own continued
// progression -- CROSS_GRAMMAR_BOOTSTRAP_MATERIAL may seed native-grammar
// progression, and NATIVE_GRAMMAR_PROGRESSION may build on its own
// already-governed output (including the SAME dimension, for genuine
// incremental depth -- turn39's case). VALID_ANCHOR != VALID_OPPORTUNITY:
// this predicate only widens which concepts may serve as an anchor: it never
// touches dimension/mission eligibility (direccionTieneNecesidadPendiente,
// GrafoProyeccion.dimensionesPendientes, untouched), so an already-satisfied
// dimension's own proposal (turn37's ensayo, already covered) remains
// rejected exactly as before, regardless of anchor validity.
function esAnclajeDeProgresionNativaAscenso(concepto) {
  return esAnclajeDeProgresionNativaDeGramatica(concepto, 'ascenso');
}

// NATIVE_GRAMMAR_GOVERNED_OUTPUT_CAN_ANCHOR_LATER_NATIVE_PROGRESSION (C007,
// DARVIDA_VIDA_PROPIA_NEVER_SATISFIED, Daniel-adjudicated, real evidence:
// logistica_c0 live turns 44-70, session live_complete_logistica_c0_11ec6033).
// DAR VIDA's own mission ("convertir el criterio construido en una voz
// interior que continúe operando cuando el experto ya no está") makes this
// EVEN more directly required than ASCENSO's case: vida_propia's entire
// meaning is whether the voice ALREADY formulated in voz takes on a
// durable, self-sustaining life of its own -- a vida_propia proposal that
// cannot reference that already-governed voz content is missing the exact
// material its own dimension is about. Real evidence: turn69's Producer
// proposal (dimension:vida_propia) anchored on three real, governed,
// active slot:voz concepts (e.g. "Busca la fuente, no el síntoma" -- the
// literal internalized voice content) -- ALL rejected purely because their
// epistemic scope is MATERIAL_EXPERTO, not CRITERIO_DESTILAR, forcing a
// fallback with grammar-wide generic text. Turns 65/70 only survived
// because their anchor list happened to also include one CRITERIO_DESTILAR
// concept alongside the DAR-VIDA-native ones. Same common mechanic as
// ASCENSO's own predicate, DAR-VIDA-owned semantics: voz/momento_solo/
// vida_propia governed material may anchor later native progression
// (including the SAME dimension, for genuine incremental depth). VALID_
// ANCHOR != VALID_OPPORTUNITY, unchanged: this never touches dimension/
// mission eligibility, so an already-satisfied dimension's own stale
// proposal (turns 52/60's own "voz", already covered) remains rejected
// exactly as before.
function esAnclajeDeProgresionNativaDarvida(concepto) {
  return esAnclajeDeProgresionNativaDeGramatica(concepto, 'darvida');
}

// Única autoridad de elegibilidad de anchors para dirección tipada.  La
// proyección al prompt y la selección/validación deben consultar exactamente
// este mismo predicado; un concepto meramente referenciable no necesariamente
// puede satisfacer una operación concreta.
//
// DESTINO_COMMITTED_MISSION_OUTCOME_AS_CROSS_GRAMMAR_ANCHOR (C007) --
// SITUAR_EN_CONTEXTO ya no define su propia autoridad transformacional
// localmente: consume GrafoProyeccion.resolverAutoridadTransformacionalCanonica
// (gramaticaOrigen fijo en 'destino' -- conocimiento semántico de esta
// operación, no del resolver, que permanece grammar-neutral). Un solo
// resolver, un solo predicado; este archivo nunca reimplementa Tier 1/Tier 2.
function anclajesElegiblesParaOperacion(grafo, operacion) {
  const requisitos = {
    requiereAnchorTransformacion: operacion === 'SITUAR_EN_CONTEXTO',
    requiereAnchorDestilar: operacion === 'ENSAYAR_CRITERIO',
    requiereAnchorVozInterior: operacion === 'FORMULAR_VOZ_INTERIOR',
  };
  if (requisitos.requiereAnchorTransformacion) {
    const resuelto = resolverAutoridadTransformacionalCanonica(grafo, 'destino');
    return resuelto ? resuelto.conceptos : [];
  }
  const conceptos = grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [];
  return conceptos.filter(c => {
    if (!c || c.activo === false || c.autoridad !== 'experto') return false;
    if (requisitos.requiereAnchorDestilar) {
      return alcanceEpistemicoConcepto(c) === 'CRITERIO_DESTILAR'
        || esAnclajeDeProgresionNativaAscenso(c);
    }
    if (requisitos.requiereAnchorVozInterior) {
      return alcanceEpistemicoConcepto(c) === 'CRITERIO_DESTILAR'
        || esAnclajeDeProgresionNativaDarvida(c);
    }
    return true;
  });
}

function diagnosticarOportunidadConversacional(grafo, propuesta, operacion, operacionesSoportadas = []) {
  const operacionPropuesta = propuesta && typeof propuesta.operacion === 'string'
    ? propuesta.operacion : null;
  if (!operacionPropuesta || (operacionesSoportadas.length > 0 && !operacionesSoportadas.includes(operacionPropuesta))) {
    return {
      codigo: 'OPERACION_NO_SOPORTADA',
      operacionPropuesta,
      operacionesSoportadas,
      anchorRechazados: propuesta && Array.isArray(propuesta.anclajeConceptoIds)
        ? propuesta.anclajeConceptoIds : [],
      anchorElegibles: [],
      desconocidoObjetivo: null,
    };
  }
  operacion = operacionPropuesta;
  const elegibles = anclajesElegiblesParaOperacion(grafo, operacion);
  const ids = propuesta && Array.isArray(propuesta.anclajeConceptoIds)
    ? propuesta.anclajeConceptoIds : [];
  const elegibleIds = new Set(elegibles.map(c => c.id));
  const rechazados = ids.filter(id => !elegibleIds.has(id));
  return {
    codigo: 'ANCHOR_NO_ELEGIBLE',
    operacion,
    anchorRechazados: rechazados,
    anchorElegibles: elegibles.map(c => c.id),
    desconocidoObjetivo: intencionAbiertaDesdeOperacion(operacion),
  };
}

function direccionDestino(grafo, gramatica, {
  contratoRespuestaDirigida = null,
  respuestaDirigida = null,
  oportunidadesConversacionales = [],
  comprensionTrabajo = null,
  focoConversacionalActual = null,
  cognicionCapa1 = null,
  directedUnknownId = null,
  directedResponseTurnId = null,
} = {}) {
  if (gramatica !== 'destino') return {};
  const descriptor = getGrammarMissionDescriptor(gramatica);
  const conceptos = conceptosDeGramatica(grafo, gramatica)
    .filter(c => c && c.activo !== false && c.autoridad === 'experto');
  const tieneSaber = conceptos.length > 0;
  const oportunidadSeleccionada = seleccionarOportunidadConversacional(grafo, oportunidadesConversacionales, { comprensionTrabajo, focoConversacionalActual });
  const gananciaCognitiva = seleccionarGananciaCognitiva(cognicionCapa1, grafo, {
    directedUnknownId, directedResponseTurnId,
  });
  const evidenciaSolicitadaAtendida = !!(
    contratoRespuestaDirigida
    && respuestaDirigida
    && respuestaDirigida.relacion === 'ATIENDE_OBJETIVO'
    && Array.isArray(respuestaDirigida.conceptosQueAtienden)
    && respuestaDirigida.conceptosQueAtienden.length > 0
  );
  return {
    propositoGlobal: PROPOSITO_GLOBAL,
    mision: descriptor && descriptor.mission,
    necesidadConversacional: tieneSaber
      ? (evidenciaSolicitadaAtendida
        ? (oportunidadSeleccionada
          ? `profundizar en ${oportunidadSeleccionada.focoExploracion.join(' y ')}`
          : 'profundizar en la práctica que la persona acaba de describir')
        : 'comenzar a comprender cómo realiza ese saber en la práctica')
      : 'invitar a la persona a expresar un saber concreto que pueda explorarse',
    // Sin oportunidad gobernada no existe un WHAT legítimo.  La dimensión
    // permanece disponible para bookkeeping, pero no aporta una pregunta.
    evidenciaBuscada: tieneSaber
      ? (evidenciaSolicitadaAtendida
          ? (oportunidadSeleccionada ? oportunidadSeleccionada.evidenciaBuscada : null)
        : (oportunidadSeleccionada ? oportunidadSeleccionada.evidenciaBuscada : null))
      : null,
    sinTargetLegitimo: !oportunidadSeleccionada,
    gananciaCognitiva,
    actoCognitivoSeleccionado: seleccionarActoCognitivo({ oportunidadSeleccionada, gananciaCognitiva }),
    sabidoConDerecho: conceptos.map(c => c.descripcion),
    oportunidadSeleccionada,
  };
}

// Dirección común para gramáticas con adapter propio. La misión aporta el
// motivo semántico; la oportunidad tipada aporta el WHAT concreto. El
// rationale libre permanece fuera de la autoridad.
function dimensionUnknownPendiente({ slots = {}, lifecycle = null } = {}) {
  if (!lifecycle || !lifecycle.dimension) return true;
  const keys = Array.isArray(lifecycle.resolvedBySlots) ? lifecycle.resolvedBySlots : [];
  return !keys.some(key => {
    const value = slots && slots[key];
    if (typeof value !== 'string' || !value.trim()) return false;
    if (lifecycle.absenceResolves && ['NO_APLICA', 'NO_EXISTE'].includes(value.trim())) return true;
    return true;
  });
}

// REQUIRED_COVERAGE_AUTHORITY_SPLIT correction (C007,
// DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION,
// Daniel-adjudicated, real evidence: logistica_c0 fresh-live turns 13-49,
// session live_complete_logistica_c0_11ec6033). GrafoProyeccion.
// dimensionesPendientes is the ONE authoritative, correctly-ALL-of, mission-
// scoped owner of "is this grammar's required coverage still open" -- the
// SAME function mission-sufficiency itself consults. dimensionUnknownPendiente
// (above) answers a DIFFERENT, narrower question (a single unknownLifecycle's
// own ANY-of resolvedBySlots heuristic) that was never meant to compete with
// it, and demonstrably breaks for any grammar whose descriptor.dimensions
// has more than one entry (DESTILAR: [obvio,errores,esencia] -- once ANY ONE
// filled, the WHOLE lifecycle read as resolved, permanently starving the
// other two). When a real `grafo` is available, this function now consults
// GrafoProyeccion.dimensionesPendientes exclusively -- never a second,
// independent notion -- optionally scoped to ONE candidate `dimension`
// (steady-state, per-candidate use: RN13/RN14). Only when no `grafo` is
// supplied at all does it fall back to the legacy slots-based heuristic,
// byte-for-byte unchanged, for any caller that predates this correction.
function direccionTieneNecesidadPendiente({ gramatica, slots = {}, grafo = null, dimension = null } = {}) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  const direccion = descriptor && descriptor.direccionConversacional;
  if (!direccion || !direccion.tipada) return false;
  if (grafo) {
    const pendientes = dimensionesPendientes(grafo, gramatica);
    return dimension ? pendientes.includes(dimension) : pendientes.length > 0;
  }
  return dimensionUnknownPendiente({ slots, lifecycle: direccion.unknownLifecycle });
}

function direccionMision(grafo, gramatica, { oportunidadesConversacionales = [], slots = {}, comprensionTrabajo = null, focoConversacionalActual = null } = {}) {
  if (gramatica === 'destino') return {};
  const descriptor = getGrammarMissionDescriptor(gramatica);
  const operacionesSoportadas = (descriptor && descriptor.direccionConversacional && descriptor.direccionConversacional.operacionesSoportadas)
    || OPERACIONES_OPORTUNIDAD;
  let oportunidadSeleccionada = seleccionarOportunidadConversacional(grafo, oportunidadesConversacionales, {
    operacionesSoportadas,
    requiereAnchorTransformacion: gramatica === 'traducir',
    requiereAnchorDestilar: gramatica === 'ascenso',
    operacionAnclaje: gramatica === 'darvida' ? 'FORMULAR_VOZ_INTERIOR' : null,
    sujetoObjetivo: descriptor && descriptor.direccionConversacional
      ? descriptor.direccionConversacional.sujetoObjetivo || null : null,
    desconocidoObjetivo: descriptor && descriptor.direccionConversacional
      ? descriptor.direccionConversacional.desconocidoObjetivo || null : null,
    objetivoTipado: descriptor && descriptor.direccionConversacional
      ? descriptor.direccionConversacional.objetivo || null : null,
    evidenciaTipada: descriptor && descriptor.direccionConversacional
      ? descriptor.direccionConversacional.evidencia || null : null,
    // PER_CANDIDATE_DIMENSION_HONORED correction (C007,
    // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION).
    // seleccionarOportunidadConversacional calls this with the CANDIDATE's
    // own {dimension} -- the previous bare `() => ...` closure silently
    // discarded it and answered a grammar-wide (and, until the correction
    // above, ANY-of) question instead of "is THIS specific dimension still
    // required". Now honored: a candidate for an already-covered dimension
    // (e.g. errores/esencia once filled) still correctly reads
    // pending=false, while a candidate for a genuinely still-open dimension
    // (e.g. obvio) reads pending=true regardless of its siblings' state.
    unknownPendiente: ({ dimension: dimensionCandidata } = {}) =>
      direccionTieneNecesidadPendiente({ gramatica, slots, grafo, dimension: dimensionCandidata }),
    comprensionTrabajo,
    focoConversacionalActual,
  });
  // STEADY_STATE_REQUIRED_NEED_BOOTSTRAP correction (C007,
  // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION,
  // Daniel-adjudicated, real evidence: logistica_c0 turns 13-49). The
  // Producer-proposal path above (seleccionarOportunidadConversacional) is
  // the ONLY historical path into a canonical typed opportunity for an
  // ALREADY-ACTIVE grammar -- PRODUCER_VOLUNTARY_OPPORTUNITY_REQUIRED was,
  // until this correction, YES with no fallback: if Producer proposed
  // nothing compatible (or nothing at all) this turn, an authoritatively
  // still-pending required dimension (GrafoProyeccion.dimensionesPendientes
  // -- never re-derived here) had NO path to become an executable need,
  // for as many turns as it took Producer to eventually propose it (in the
  // real trajectory: never, for 37 real turns). This never fabricates an
  // answer or a governed fact (OPEN_MISSION_NEED != GOVERNED_FACT) -- it
  // only opens ADMISSIBLE TERRITORY for the one legitimate next required
  // dimension, reusing the EXACT SAME typed-opportunity contract shape the
  // transition bootstrap already produces (prepararOportunidadTipadaDesdeDireccion,
  // below) -- never a second, parallel mechanism. Scoped narrowly: fires
  // ONLY when Producer's own proposals produced nothing usable this turn.
  if (!oportunidadSeleccionada) {
    oportunidadSeleccionada = prepararOportunidadTipadaDesdeDireccion(grafo, gramatica, { slots });
  }
  // La memoria autorizada puede haber sido ganada por una gramática previa
  // (p.ej. DESTINO). Cambiar de misión no crea otra identidad ni exige
  // volver a extraer el saber: la misión activa decide qué hacer con el
  // mismo concepto autorizado.
  const conceptos = (grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [])
    .filter(c => c && c.activo !== false && c.autoridad === 'experto');
  return {
    propositoGlobal: PROPOSITO_GLOBAL,
    mision: descriptor && descriptor.mission,
    // SELECTED_MISSION_OPPORTUNITY_OWNS_VISIBLE_FRAMING (C007, Daniel-
    // adjudicated, real evidence: logistica_c0 live turns 31-33, session
    // live_complete_logistica_c0_11ec6033). SELECTED_OPPORTUNITY_SPECIFIC_
    // CONTENT > GRAMMAR_STATIC_FALLBACK -- once opportunity selection has
    // already decided this turn's specific target (Producer's own narrower
    // proposal, or the steady-state fallback's own advanced dimension),
    // that decision must control the visible framing; direccionConversacional.
    // necesidad/.evidencia describe GENERAL_GRAMMAR_GUIDANCE only, never
    // CURRENT_SELECTED_WHAT (see grammar adapter definitions) -- they
    // remain the fallback for when the selected opportunity itself carries
    // no specific content, never the default that overrides it. Real
    // evidence: turn33's selector correctly advanced from 'ensayo' (just
    // satisfied) to 'escalon', but this static-first precedence let the
    // turn's visible question stay byte-identical to turns 31/32's ensayo
    // question three times running -- SELECTED_TARGET failed to control
    // CURRENT_TURN_VISIBLE_FRAMING. Uses the SAME two pre-existing,
    // already-populated oportunidad fields (rationaleDesconocido,
    // evidenciaBuscada; seleccionarOportunidadConversacional's own
    // "trazabilidad/rationale" fields) -- no new field invented.
    necesidadConversacional: oportunidadSeleccionada
      ? ((oportunidadSeleccionada.rationaleDesconocido)
        || (descriptor.direccionConversacional && descriptor.direccionConversacional.necesidad)
        || 'hacer visible una estructura cognitiva de una práctica autorizada')
      : ((descriptor.direccionConversacional && descriptor.direccionConversacional.necesidad)
        || 'obtener evidencia nueva sobre un saber autorizado'),
    evidenciaBuscada: (oportunidadSeleccionada && oportunidadSeleccionada.evidenciaBuscada)
      || (descriptor.direccionConversacional && descriptor.direccionConversacional.evidencia)
      || 'una evidencia concreta sobre la práctica autorizada',
    sabidoConDerecho: conceptos.map(c => c.descripcion),
    oportunidadSeleccionada,
    operacionesSoportadas,
  };
}

// Preparación de una necesidad tipada para la misión ACTIVA -- histórica-
// mente solo usada, una vez, en el handoff de gramática entrante (llamador
// original en InteraccionCognitivaWriter.js). MISSION_REQUIRED_ACQUISITION
// correction (C007, DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_
// CANONICAL_DECISION) generalizes it, sin nuevo mecanismo paralelo, para
// también servir como el fallback de estado-estable dentro de direccionMision
// (arriba): cuando `dimension` se omite (uso histórico del handoff), apunta
// a la PRIMERA dimensión pendiente en el orden canónico del adapter -- nunca
// el placeholder genérico de unknownLifecycle.dimension, que no identifica
// ninguna dimensión concreta para gramáticas multi-dimensión como DESTILAR.
// Cuando `dimension` se pasa explícitamente (uso por-candidato), se valida
// contra la MISMA autoridad (GrafoProyeccion.dimensionesPendientes) antes de
// construir nada. OPEN_MISSION_NEED != GOVERNED_FACT: nunca fabrica un
// concepto ni una respuesta -- solo abre territorio admisible, y solo si
// existen anchors ya gobernados para la operación (mismo requisito que el
// handoff original, sin relajar nada).
// MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET (C007).
// The ADMISSIBLE GOVERNED TARGET SET for a required mission need (mission +
// dimension + operation): the very set the required-need fallback below
// offers its target binder -- eligible governed anchors for the operation,
// minus the concepts that belong to a DIFFERENT dimension of THIS SAME
// grammar's own mission (ANCHOR_SCOPE_MUST_NOT_CROSS_SIBLING_DIMENSIONS).
// Pure: the definition of which governed concepts may SEED / SCOPE a typed
// opportunity (anchor scope). It is NOT the target set of a value act -- see
// candidatosObjetivoDeActoDeValor. It decides ELIGIBILITY only -- never which candidate is the target
// (that is the semantic binder's job, or cardinality 1) and never whether the
// mission need exists.
function candidatosObjetivoParaDimension(grafo, gramatica, dimensionObjetivo, operacion) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  if (!descriptor || !operacion) return [];
  const dimensionesPropias = new Set(Array.isArray(descriptor.dimensions) ? descriptor.dimensions : []);
  return anclajesElegiblesParaOperacion(grafo, operacion).filter(c => {
    const dim = dimensionDeProcedencia(c.procedencia);
    return !dimensionesPropias.has(dim) || dim === dimensionObjetivo;
  });
}

// VALUE_ACT_TARGET_CANDIDATES_ARE_NOT_OPPORTUNITY_ANCHOR_SCOPE (C007,
// cocina_c0 turn 10). SUPPORT_SET != TARGET_SET. A value act has ALREADY been
// authorized (a mission-dimensioned DETAIL need with a frozen requested facet
// {mission, dimension}); what remains is WHICH known governed entity that facet
// is about. Known thing + unknown facet about that thing: the target does NOT
// have to belong to the requested dimension -- for a facet that is still
// pending (first acquisition) it cannot, by definition, since a dimension with
// a concept of its own is no longer pending. The sibling-dimension exclusion of
// candidatosObjetivoParaDimension exists to keep OPPORTUNITY ANCHORS from
// re-opening already-covered sibling dimensions (anchor scoping); it carries no
// authority over which entity may be the TARGET of a requested facet, and
// applying it here made the target set empty by construction for any pending
// dimension of a first grammar.
//
// Eligibility is TARGET eligibility only: an ACTIVE governed concept with
// expert authority that is compatible with the operation (the same
// anclajesElegiblesParaOperacion authority every other consumer uses). Inactive,
// non-expert (inferred / degraded / ungoverned) and operation-incompatible
// concepts stay excluded; no dimension or grammar name is read here. It decides
// ELIGIBILITY only -- never which candidate is the target (cardinality 1, or the
// bounded semantic binder, decide that: no first anchor, no most recent concept,
// no same-slot shortcut) and never whether the mission need exists.
function candidatosObjetivoDeActoDeValor(grafo, gramatica, operacion) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  if (!descriptor || !operacion) return [];
  return anclajesElegiblesParaOperacion(grafo, operacion);
}

function prepararOportunidadTipadaDesdeDireccion(grafo, gramatica, { slots = {}, dimension = null } = {}) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  const direccion = descriptor && descriptor.direccionConversacional;
  if (!direccion || !direccion.tipada || !direccion.operacionesSoportadas || direccion.operacionesSoportadas.length === 0) return null;
  const pendientesReales = grafo ? dimensionesPendientes(grafo, gramatica) : null;
  let dimensionObjetivo;
  if (pendientesReales) {
    if (dimension) {
      if (!pendientesReales.includes(dimension)) return null;
      dimensionObjetivo = dimension;
    } else {
      if (pendientesReales.length === 0) return null;
      dimensionObjetivo = pendientesReales[0];
    }
  } else {
    // Sin grafo disponible: única autoridad posible es la heurística legada
    // (byte a byte, para cualquier llamador que nunca pasó grafo).
    if (!direccionTieneNecesidadPendiente({ gramatica, slots })) return null;
    dimensionObjetivo = direccion.desconocidoObjetivo
      || (direccion.unknownLifecycle && direccion.unknownLifecycle.dimension) || null;
  }
  const operacion = direccion.operacionesSoportadas[0];
  // ANCHOR_SCOPE_MUST_NOT_CROSS_SIBLING_DIMENSIONS correction (found via
  // this increment's own regression battery, test_circulomejora006_five_
  // grammar_e2e_1.js). anclajesElegiblesParaOperacion returns every
  // eligible concept regardless of dimension -- legitimate as anchor
  // SUPPORT (including prior-grammar concepts, cross-grammar reuse), but
  // GrafoProyeccion.dimensionesConIncertidumbresRelevantes attributes an
  // open unknown's `sobreConceptos` dimensions as "still affected" for
  // EVERY dimension any referenced concept belongs to. Left unfiltered, a
  // candidate targeting one required dimension that also references an
  // already-covered sibling dimension's own concept would make GrafoProyeccion
  // incorrectly re-report that sibling dimension as pending again. Concepts belonging to
  // a DIFFERENT dimension of THIS SAME grammar's own mission are excluded
  // here; concepts from a prior/other grammar's own dimensions (legitimate
  // cross-grammar reuse) or from this exact target dimension remain fully
  // eligible -- narrower than the raw eligibility set, never broader.
  const anchors = candidatosObjetivoParaDimension(grafo, gramatica, dimensionObjetivo, operacion);
  if (anchors.length === 0) return null;
  const sujetoObjetivo = direccion.sujetoObjetivo || (direccion.unknownLifecycle && direccion.unknownLifecycle.sujeto) || null;
  // REQUIRED_MISSION_FALLBACK_TARGET_BINDING (C007, Daniel-adjudicated, real
  // evidence: logistica_c1 turn 9). EXECUTABLE_WHAT REQUIRES_MINIMUM_
  // SUFFICIENT_TARGET_IDENTITY: this fallback may legitimately decide a
  // required mission need exists (that authority is unchanged, above), but
  // it must NOT itself decide WHICH of several eligible governed concepts
  // the intervention is concretely about -- anclajeConceptoIds (SUPPORT)
  // stays the full eligible set, unchanged, but SUPPORT_SET != TARGET_SET.
  // TARGET_CARDINALITY_RULE (common-core mechanics, not a heuristic):
  // exactly one eligible anchor binds deterministically here, with no
  // semantic judgment needed; more than one leaves targetConceptId null and
  // targetVinculacionPendiente:true for the caller to resolve via a bounded
  // semantic target-binding call (VinculacionObjetivoConcretoNecesidadRequerida.js)
  // BEFORE this opportunity may become an executable candidate -- never by
  // a recency/lexical/slot heuristic picked here.
  const targetConceptId = anchors.length === 1 ? anchors[0].id : null;
  return Object.freeze({
    idTemporal: `oportunidad_requerida_${gramatica}_${dimensionObjetivo || 'general'}`,
    anclajeConceptoIds: anchors.map(c => c.id),
    anclajeRelacionIds: [],
    operacion,
    sujetoObjetivo,
    desconocidoObjetivo: dimensionObjetivo,
    dimension: dimensionObjetivo,
    // Texto exclusivamente derivado del descriptor de la gramática (nunca
    // un nombre de dimensión hardcodeado en Common Core) -- reutiliza la
    // MISMA necesidad/evidencia genérica que direccionMision ya expone.
    evidenciaBuscada: direccion.evidencia || null,
    semanticTarget: direccion.evidencia || direccion.necesidad || descriptor.mission || null,
    referenteSemantico: sujetoObjetivo || 'EXPERTO',
    targetConceptId,
    targetCandidatos: Object.freeze(anchors.map(c => ({ id: c.id, descripcion: c.descripcion }))),
    targetVinculacionPendiente: targetConceptId === null,
  });
}

function movimientoObedeceObjetivo(objetivo, movimientoEfectivo) {
  const esperado = MOVIMIENTO_ESPERADO_POR_OBJETIVO[objetivo];
  if (!esperado) return true; // este objetivo no exige un movimiento específico
  return movimientoEfectivo === esperado;
}

/**
 * @param {object} params
 * @param {boolean} [params.senalEsteTurno] — al menos una señal de cierre
 *   (P1-A) fue aceptada en ESTE turno.
 * @param {boolean} [params.intencionActivaPrevia] — una intención de cierre
 *   ACTIVA o BLOQUEADA_POR_DEUDA_DURA ya existía al entrar a este turno
 *   (protocoloIntencionCierre de un turno anterior).
 * @param {object} params.grafo — KnowledgeGraph vigente (post-construcción
 *   de este turno — el mismo que decidirMovimientoDestino consultará).
 * @param {string} params.gramatica — 'destino'.
 * @param {Array} [params.reparacionesInterpretativasPendientes] — misma
 *   proyección que ya consume decidirMovimientoDestino.
 * @param {Array} [params.dimensionesDiferidas]
 * @returns {{objetivo:string, razon:string, origen:string|null, deudaPrioritaria:object|null, hitoEsperado:string|null}}
 */
function decidirObjetivoConversacional({
  senalEsteTurno = false,
  intencionActivaPrevia = false,
  grafo, gramatica,
  reparacionesInterpretativasPendientes = [],
  obligacionesCognitivasAbiertas = [],
  obligacionCognitivaActivaId = null,
  dimensionesDiferidas = [],
  contratoRespuestaDirigida = null,
  respuestaDirigida = null,
  oportunidadesConversacionales = [],
  slots = {},
  comprensionTrabajo = null,
  focoConversacionalActual = null,
  cognicionCapa1 = null,
  directedUnknownId = null,
  directedResponseTurnId = null,
}) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  if (gramatica !== 'destino' && descriptor && descriptor.direccionConversacional
      && descriptor.direccionConversacional.tipada === true) {
    const direccion = direccionMision(grafo, gramatica, { oportunidadesConversacionales, slots, comprensionTrabajo, focoConversacionalActual });
    const oportunidad = direccion.oportunidadSeleccionada;
    return {
      objetivo: oportunidad && oportunidad.objetivo
        ? oportunidad.objetivo : OBJETIVOS_CONVERSACIONALES.NO_APLICA,
      razon: 'DIRECCION_MISION_GRAMATICA', origen: null,
      deudaPrioritaria: null, hitoEsperado: null,
      ...direccion,
    };
  }
  const cierreActivo = senalEsteTurno || intencionActivaPrevia;
  const origen = senalEsteTurno ? 'SENAL_ESTE_TURNO' : (intencionActivaPrevia ? 'INTENCION_ACTIVA_PREVIA' : null);

  // Las reparaciones cognitivas son obligaciones de Dirección, no una
  // consecuencia exclusiva de la señal de cierre. La prioridad se adjudica
  // aquí; Movimiento solo consume el objetivo resultante.
  const reparaciones = obligacionesCognitivasAbiertas.filter(o => o.clase === 'REPARACION');
  const reparacionActiva = obligacionCognitivaActivaId
    ? (reparaciones.find(o => o.obligacionId === obligacionCognitivaActivaId)
      || (reparaciones.length === 1 ? reparaciones[0] : null))
    : (reparaciones.length === 1 ? reparaciones[0] : null);
  const reparacionRelacional = reparacionActiva && reparacionActiva.foco
    && reparacionActiva.foco.tipo === 'RELACION_TRANSFORMACIONAL' ? reparacionActiva : null;
  if (reparacionRelacional) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.REPARAR_RELACION_TRANSFORMACIONAL,
      objetivoCodigo: 'REPARAR_RELACION_TRANSFORMACIONAL',
      razon: 'REPARACION_S1R_ABIERTA', origen,
      deudaPrioritaria: {
        tipo: 'REPARACION', identidad: reparacionRelacional.obligacionId,
        foco: reparacionRelacional.foco, origen: reparacionRelacional.origen,
        razonNormativa: 'REPARAR_COMPRENSION_ROTA',
      },
      hitoEsperado: null,
    };
  }
  const reparacionDimensional = reparacionActiva && reparacionActiva.foco
    && reparacionActiva.foco.tipo === 'DIMENSION' ? reparacionActiva : null;
  if (reparacionDimensional) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA,
      objetivoCodigo: 'REPARAR_TRAS_RECHAZO',
      razon: 'REPARACION_INTERPRETATIVA_PENDIENTE', origen,
      deudaPrioritaria: {
        tipo: 'REPARACION', identidad: reparacionDimensional.obligacionId,
        intentoInterpretacionId: reparacionDimensional.origen
          && reparacionDimensional.origen.intentoInterpretacionId,
        dimension: reparacionDimensional.foco.dimension,
        razonNormativa: 'REPARACION_INTERPRETATIVA_PENDIENTE',
        origen: 'OBLIGACION_COGNITIVA_ABIERTA',
        criterioDeResolucion: 'OBLIGACION_YA_NO_PENDIENTE',
      },
      hitoEsperado: null,
    };
  }

  // Una interpretación materializada pendiente de veredicto es una
  // necesidad conversacional accionable por sí misma. No depende de una
  // señal de cierre: el veredicto puede ser necesario durante la exploración
  // ordinaria, una vez que la dimensión que sostiene la interpretación ya
  // tiene cobertura suficiente. Evita reabrir la misma pregunta de
  // evidencia mediante REFLEJAR_Y_PROFUNDIZAR.
  const dimsConVeredictoPendiente = dimensionesConInterpretacionPendiente(grafo, gramatica);
  if (dimsConVeredictoPendiente.length > 0 && coberturaCompleta(grafo, gramatica)) {
    const dimension = dimsConVeredictoPendiente[0];
    const interpretacion = ultimoIntentoAbstraccionMaterializado(grafo, dimension);
    const identidad = interpretacion && interpretacion.id ? interpretacion.id : null;
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.OBTENER_VEREDICTO_PENDIENTE,
      razon: 'INTERPRETACION_MATERIALIZADA_PENDIENTE_DE_VEREDICTO',
      origen: 'INTERPRETACION_MATERIALIZADA',
      deudaPrioritaria: {
        tipo: 'VEREDICTO_INTERPRETACION',
        identidad,
        intentoInterpretacionId: identidad,
        dimension,
        interpretacionId: identidad,
        razonNormativa: 'INTERPRETACION_MATERIALIZADA_PENDIENTE_DE_VEREDICTO',
        criterioDeResolucion: 'VEREDICTO_RESUELTO',
      },
      hitoEsperado: 'VEREDICTO_RESUELTO',
    };
  }

  if (!cierreActivo) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.NO_APLICA, razon: 'SIN_CIERRE_ACTIVO',
      origen: null, deudaPrioritaria: null, hitoEsperado: null,
      ...direccionDestino(grafo, gramatica, { contratoRespuestaDirigida, respuestaDirigida, oportunidadesConversacionales, comprensionTrabajo, focoConversacionalActual, cognicionCapa1, directedUnknownId, directedResponseTurnId }),
    };
  }


  // Reparación pendiente: misma jerarquía normativa que ya tiene dentro de
  // decidirMovimientoDestino (prioridad 1, REPARAR_TRAS_RECHAZO) — se
  // reporta aquí como deuda dura observacional, nunca para competir con esa
  // prioridad (test obligatorio 7: "reparación conserva prioridad normativa").
  // P1-B2 — deudaPrioritaria.identidad es el obligacionId (misma identidad
  // durable que ya usa protocoloReparacionesInterpretativasPendientes, ver
  // CognitiveState.js) — nunca un texto descriptivo: cualquier lector puede
  // verificar contra esa proyección si la obligación sigue existiendo.
  if (reparacionesInterpretativasPendientes.length > 0) {
    const reparacion = reparacionesInterpretativasPendientes[0];
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA, razon: 'REPARACION_INTERPRETATIVA_PENDIENTE',
      origen,
      deudaPrioritaria: {
        tipo: 'REPARACION',
        identidad: reparacion.obligacionId,
        intentoInterpretacionId: reparacion.intentoInterpretacionId,
        dimension: reparacion.dimension,
        razonNormativa: 'REPARACION_INTERPRETATIVA_PENDIENTE',
        origen: 'PROTOCOLO_REPARACIONES_INTERPRETATIVAS_PENDIENTES',
        criterioDeResolucion: 'OBLIGACION_YA_NO_PENDIENTE',
      },
      hitoEsperado: null,
    };
  }

  if (cierreActivo && dimsConVeredictoPendiente.length > 0) {
    const dimension = dimsConVeredictoPendiente[0];
    const interpretacion = ultimoIntentoAbstraccionMaterializado(grafo, dimension);
    const identidad = interpretacion && interpretacion.id ? interpretacion.id : null;
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.OBTENER_VEREDICTO_PENDIENTE, razon: 'INTERPRETACION_MATERIALIZADA_PENDIENTE_DE_VEREDICTO',
      origen, deudaPrioritaria: {
        tipo: 'VEREDICTO_INTERPRETACION', identidad, intentoInterpretacionId: identidad,
        dimension, interpretacionId: identidad,
        razonNormativa: 'INTERPRETACION_MATERIALIZADA_PENDIENTE_DE_VEREDICTO',
        criterioDeResolucion: 'VEREDICTO_RESUELTO',
      },
      hitoEsperado: 'VEREDICTO_RESUELTO',
    };
  }

  // P1-B3 (circulomejora006 — incertidumbre relevante como deuda normativa
  // accionable) — vence a "oportunidad elegible no atendida" y a
  // "dimensión sin evidencia alguna": una incertidumbre relevante ya
  // representa una obligación puntual y concreta ("resolverla cambiaría
  // la interpretación vigente" — ver KnowledgeGraph.js), nunca una simple
  // posibilidad de profundizar. deudaPrioritaria.identidad es u.id — la
  // misma identidad durable real de la incertidumbre, nunca fabricada.
  const incertidumbre = incertidumbreAccionable(grafo, gramatica);
  if (incertidumbre) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA, razon: 'INCERTIDUMBRE_RELEVANTE_ABIERTA',
      origen,
      deudaPrioritaria: {
        tipo: 'INCERTIDUMBRE_RELEVANTE_ABIERTA',
        identidad: incertidumbre.u.id,
        dimension: incertidumbre.dim,
        razonNormativa: 'INCERTIDUMBRE_RELEVANTE_BLOQUEA_COBERTURA',
        origen: 'GRAFO_DESTINO',
        criterioDeResolucion: 'INCERTIDUMBRE_RESUELTA_O_YA_NO_RELEVANTE',
        preguntaDeResolucion: incertidumbre.u.preguntaQueLaResolveria,
      },
      hitoEsperado: null,
    };
  }

  const dimsElegiblesNoAtendidas = dimensionesElegiblesNoAtendidas(grafo, gramatica, dimensionesDiferidas);
  if (dimsElegiblesNoAtendidas.length > 0) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE, razon: 'DIMENSION_ELEGIBLE_NO_ATENDIDA',
      origen, deudaPrioritaria: null, hitoEsperado: 'INTERPRETACION_MATERIALIZADA',
    };
  }

  if (coberturaCompleta(grafo, gramatica)) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.PERMITIR_AVANCE_YA_AUTORIZADO, razon: 'COBERTURA_COMPLETA',
      origen, deudaPrioritaria: null, hitoEsperado: 'SALIDA_DE_EXPLORANDO',
    };
  }

  // "dimensión indispensable sin evidencia experta" (Fase 4, Caso 4) es
  // ESTRICTAMENTE más angosto que "dimensionesPendientes" (que incluye
  // cualquier dimensión sin suficiencia semántica todavía, aunque ya tenga
  // evidencia real): una dimensión pendiente que YA tiene al menos un
  // concepto es "posibilidad abstracta de profundizar" — cobertura
  // incompleta ordinaria, nunca una deuda dura (instrucción explícita: no
  // tratar eso como deuda dura). Solo una dimensión GENUINAMENTE vacía (sin
  // ningún concepto, ni siquiera inferido) es la deuda dura real.
  const conceptos = conceptosDeGramatica(grafo, gramatica);
  // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — presupuesto de
  // pregunta final consolidada) — TODAS las dimensiones genuinamente vacías,
  // nunca solo la primera: el smoke real con Gemini demostró que, con dos
  // dimensiones vacías a la vez bajo cierre activo, resolverlas de a una
  // producía dos preguntas finales consecutivas y exponía nombres internos
  // de slot. `deudaPrioritaria` conserva la PRIMERA (compatibilidad byte a
  // byte con P1-B2/Movimiento, que solo anclan una dimensión) —
  // `todasLasDimensionesSinEvidenciaAlguna` es la lista completa, consumida
  // únicamente por el snapshot de pregunta final (ver avanzarIntencionCierre,
  // InteraccionCognitivaWriter).
  const todasLasDimensionesSinEvidenciaAlguna = dimensionesPendientes(grafo, gramatica).filter(
    dim => !conceptos.some(c => dimensionDeProcedencia(c.procedencia) === dim),
  );
  const dimensionSinEvidenciaAlguna = todasLasDimensionesSinEvidenciaAlguna[0];
  if (dimensionSinEvidenciaAlguna) {
    return {
      objetivo: OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA, razon: 'DIMENSION_SIN_EVIDENCIA_ALGUNA',
      origen,
      deudaPrioritaria: {
        tipo: 'DIMENSION_SIN_EVIDENCIA',
        // P1-B2 — identidad sintética pero determinista: no existe ningún
        // concepto que referenciar (la ausencia total ES el hecho
        // normativo), así que la identidad es la propia coordenada
        // verificable (gramática+dimensión) contra la que cualquier
        // lector puede recomputar el mismo criterioDeResolucion.
        identidad: `sin_evidencia:${gramatica}:${dimensionSinEvidenciaAlguna}`,
        dimension: dimensionSinEvidenciaAlguna,
        razonNormativa: 'DIMENSION_SIN_EVIDENCIA_ALGUNA',
        origen: 'GRAFO_DESTINO',
        criterioDeResolucion: 'DIMENSION_TIENE_AL_MENOS_UN_CONCEPTO_ACTIVO',
      },
      hitoEsperado: null,
      todasLasDimensionesSinEvidenciaAlguna,
    };
  }

  // Cobertura incompleta, pero sin ninguna deuda dura real ni oportunidad
  // consumible: el límite explícito donde vive la futura decisión sobre
  // cierre provisional (P1-C) — nunca se improvisa aquí.
  return {
    objetivo: OBJETIVOS_CONVERSACIONALES.BLOQUEADO_POR_DECISION_DE_PRODUCTO, razon: 'COBERTURA_INCOMPLETA_SIN_DEUDA_DURA_NI_OPORTUNIDAD',
    origen, deudaPrioritaria: null, hitoEsperado: null,
  };
}

/**
 * Ciclo de vida durable de la intención de cierre — INACTIVA(null) → ACTIVA
 * → SATISFECHA, con ACTIVA ⇄ BLOQUEADA_POR_DEUDA_DURA mientras no se
 * alcance un hito formal. Pura: nunca escribe CognitiveState, solo calcula
 * el próximo valor de protocoloIntencionCierre.
 *
 * SATISFECHA es terminal para ESA intención — una solicitud de cierre
 * posterior (senalEsteTurno=true con intencionAntes ya SATISFECHA) abre una
 * intención NUEVA, nunca reabre la vieja (implementado por el llamador: ver
 * InteraccionCognitivaWriter, que solo invoca esta función cuando hay
 * cierre en juego según decidirObjetivoConversacional).
 *
 * @param {object|null} params.intencionAntes — protocoloIntencionCierre tal
 *   como entró a este turno.
 * @param {boolean} params.cierreSolicitadoEsteTurno — señal aceptada este turno.
 * @param {string[]} [params.tiposSenalEsteTurno]
 * @param {string} params.objetivoDecidido — el `.objetivo` que
 *   decidirObjetivoConversacional calculó para este turno.
 * @param {string|null} params.hitoAlcanzadoEsteTurno — causa del hito
 *   formal alcanzado ESTE turno (comparación state/nuevoEstado, calculada
 *   por el llamador — esta función nunca inspecciona CognitiveState), o
 *   null si no se alcanzó ninguno.
 * @param {object|null} [params.deudaPrioritaria] — P1-B2 (circulomejora006 —
 *   alineación causal entre deuda prioritaria y movimiento): el
 *   `.deudaPrioritaria` que decidirObjetivoConversacional calculó para ESTE
 *   turno, cuando `objetivoDecidido===EXPONER_DEUDA_DURA_MINIMA`. Se
 *   persiste como `deudaBloqueante` (Fase 8: "debe registrarse: deuda que
 *   causó el bloqueo") — nunca redacta texto, solo transporta la misma
 *   identidad causal ya calculada. `turnoDeteccionDeuda` se conserva
 *   mientras la MISMA deuda (misma `identidad`) siga bloqueando —
 *   permite responder "pregunta emitida pero deuda no resuelta" (Fase 8,
 *   test 10) sin inventar un turno de detección nuevo cada vez.
 * @param {string} params.turnoId — identidad causal del turno actual.
 * @param {Array<{dimension:string, identidad:string}>|null} [params.deudasFinalesSnapshotCandidato]
 *   DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — presupuesto de
 *   pregunta final consolidada). Cuando `objetivoDecidido===EXPONER_DEUDA_DURA_MINIMA`
 *   con `deudaPrioritaria.tipo==='DIMENSION_SIN_EVIDENCIA'` y NINGÚN ciclo de
 *   pregunta final está ya abierto, este es el snapshot COMPLETO (todas las
 *   dimensiones genuinamente vacías de ESTE turno, no solo la primera —
 *   `decidirObjetivoConversacional`'s `todasLasDimensionesSinEvidenciaAlguna`,
 *   ya mapeado por el llamador a `{dimension, identidad}`) que abre el
 *   ciclo. `null` (default) nunca abre un ciclo — reproduce el
 *   comportamiento mono-deuda anterior byte a byte.
 * @param {Set<string>|null} [params.dimensionesConEvidenciaEsteTurno] — Set
 *   de nombres de dimensión que YA tienen al menos un concepto (cualquier
 *   autoridad) en el grafo resultante de ESTE turno — usado ÚNICAMENTE para
 *   reevaluar un ciclo YA abierto (nunca para abrir uno nuevo, nunca para
 *   agregar dimensiones fuera del snapshot original). `null` (default) no
 *   afecta ningún ciclo (equivale a "ninguna dimensión nueva resuelta").
 * @returns {object|null}
 */
function recalcularCicloPreguntaFinal(intencionAntes, dimensionesConEvidencia) {
  const cicloAbierto = !!(
    intencionAntes && intencionAntes.presupuestoPreguntaFinalConsumido
    && Array.isArray(intencionAntes.deudasFinalesSnapshot) && intencionAntes.deudasFinalesSnapshot.length > 0
  );
  if (!cicloAbierto) return null;
  const evidencia = dimensionesConEvidencia || new Set();
  const dims = intencionAntes.deudasFinalesSnapshot.map(d => d.dimension);
  return {
    pendientes: dims.filter(d => !evidencia.has(d)),
    resueltas: dims.filter(d => evidencia.has(d)),
  };
}

function avanzarIntencionCierre({
  intencionAntes = null,
  cierreSolicitadoEsteTurno = false,
  tiposSenalEsteTurno = [],
  objetivoDecidido = null,
  hitoAlcanzadoEsteTurno = null,
  deudaPrioritaria = null,
  turnoId,
  deudasFinalesSnapshotCandidato = null,
  dimensionesConEvidenciaEsteTurno = null,
}) {
  const activaOBloqueada = !!(intencionAntes
    && (intencionAntes.estado === 'ACTIVA' || intencionAntes.estado === 'BLOQUEADA_POR_DEUDA_DURA'));

  if (!activaOBloqueada && !cierreSolicitadoEsteTurno) {
    // Nada en juego este turno: una SATISFECHA previa se conserva tal cual
    // (hecho histórico cerrado), y sin intención ni señal no hay nada que
    // representar.
    return intencionAntes || null;
  }

  const base = activaOBloqueada
    ? intencionAntes
    : {
        estado: 'ACTIVA', tiposSenal: [], turnoAperturaId: turnoId, turnoResolucionId: null, causaResolucion: null,
        deudaBloqueante: null, turnoDeteccionDeuda: null,
        // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — estado limpio para una
        // intención recién nacida; ver docstring de arriba.
        deudasFinalesSnapshot: null, turnoDeteccionCierreId: null, preguntaFinalEmitidaEnTurnoId: null,
        presupuestoPreguntaFinalConsumido: false, deudasResueltas: [], deudasPendientes: [],
      };

  const tiposSenalAcumulados = Array.from(new Set([...(base.tiposSenal || []), ...tiposSenalEsteTurno]));

  // Reevalúa un ciclo de pregunta final YA abierto contra ESTE turno —
  // nunca lo reabre, nunca agrega dimensiones fuera del snapshot original
  // (requisito: "no agregar oportunidades laterales nuevas al ciclo de
  // cierre").
  const ciclo = recalcularCicloPreguntaFinal(base, dimensionesConEvidenciaEsteTurno);

  if (hitoAlcanzadoEsteTurno) {
    return {
      ...base, estado: 'SATISFECHA', tiposSenal: tiposSenalAcumulados,
      turnoResolucionId: turnoId, causaResolucion: hitoAlcanzadoEsteTurno,
      deudaBloqueante: null, turnoDeteccionDeuda: null,
      // SATISFECHA cierra cualquier ciclo en curso -- el snapshot/presupuesto
      // se conservan como registro histórico (nunca se borran), pero
      // deudasPendientes queda vacío: nada sigue bloqueando.
      deudasPendientes: [],
      deudasResueltas: ciclo ? ciclo.resueltas : (base.deudasFinalesSnapshot ? base.deudasFinalesSnapshot.map(d => d.dimension) : base.deudasResueltas || []),
    };
  }

  // Ciclo YA abierto y con deudas todavía pendientes: GANA sobre cualquier
  // objetivo recalculado este turno -- incluida una oportunidad lateral
  // nueva (MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE) que NUNCA debe
  // contaminar ni reabrir un ciclo de cierre en curso (requisito 4/7).
  if (ciclo && ciclo.pendientes.length > 0) {
    return {
      ...base, estado: 'BLOQUEADA_POR_DEUDA_DURA', tiposSenal: tiposSenalAcumulados,
      deudasPendientes: ciclo.pendientes, deudasResueltas: ciclo.resueltas,
      preguntaFinalEmitidaEnTurnoId: turnoId,
    };
  }
  // Ciclo YA abierto, todas sus deudas quedaron resueltas este turno, pero
  // sin hito formal todavía (p.ej. otra autoridad compite por este turno):
  // conserva el snapshot como registro histórico, nunca lo reabre.
  if (ciclo) {
    return {
      ...base, estado: 'ACTIVA', tiposSenal: tiposSenalAcumulados, deudaBloqueante: null, turnoDeteccionDeuda: null,
      deudasPendientes: [], deudasResueltas: ciclo.resueltas,
    };
  }

  // Abre un ciclo de pregunta final consolidada -- UNA sola vez, solo
  // cuando ningún ciclo estaba ya en curso (el `if (ciclo)` de arriba ya
  // cubrió esos casos) y el llamador proveyó el snapshot completo.
  if (
    objetivoDecidido === OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA && deudaPrioritaria
    && deudaPrioritaria.tipo === 'DIMENSION_SIN_EVIDENCIA'
    && Array.isArray(deudasFinalesSnapshotCandidato) && deudasFinalesSnapshotCandidato.length > 0
  ) {
    return {
      ...base, estado: 'BLOQUEADA_POR_DEUDA_DURA', tiposSenal: tiposSenalAcumulados,
      deudaBloqueante: deudaPrioritaria, turnoDeteccionDeuda: turnoId,
      deudasFinalesSnapshot: deudasFinalesSnapshotCandidato,
      turnoDeteccionCierreId: turnoId, preguntaFinalEmitidaEnTurnoId: turnoId,
      presupuestoPreguntaFinalConsumido: true, deudasResueltas: [],
      deudasPendientes: deudasFinalesSnapshotCandidato.map(d => d.dimension),
    };
  }

  if (objetivoDecidido === OBJETIVOS_CONVERSACIONALES.EXPONER_DEUDA_DURA_MINIMA && deudaPrioritaria) {
    // Camino mono-deuda EXISTENTE, sin cambios -- REPARACION/INCERTIDUMBRE_
    // RELEVANTE_ABIERTA/VEREDICTO_INTERPRETACION (o DIMENSION_SIN_EVIDENCIA
    // sin snapshot candidato, compatibilidad con llamadores anteriores a
    // este incremento) conservan su propio mecanismo, intacto.
    //
    // Misma deuda (misma identidad causal) que ya bloqueaba -> conserva el
    // turno de detección original (Fase 8: la re-pregunta de este turno no
    // "reinicia" cuándo se detectó la deuda). Deuda distinta (identidad
    // distinta, p.ej. cambió de dimensión) -> nueva detección, turnoId actual.
    const mismaDeuda = base.deudaBloqueante && base.deudaBloqueante.identidad === deudaPrioritaria.identidad;
    return {
      ...base, estado: 'BLOQUEADA_POR_DEUDA_DURA', tiposSenal: tiposSenalAcumulados,
      deudaBloqueante: deudaPrioritaria,
      turnoDeteccionDeuda: mismaDeuda ? base.turnoDeteccionDeuda : turnoId,
    };
  }

  // Cualquier otro objetivo (incluida una deuda que ya dejó de existir):
  // nunca queda una deuda bloqueante colgada de un turno anterior.
  return { ...base, estado: 'ACTIVA', tiposSenal: tiposSenalAcumulados, deudaBloqueante: null, turnoDeteccionDeuda: null };
}

// ACTIVE_REQUIRED_DIMENSION_OUTRANKS_NONPENDING_OPTIONAL_DEPTH (C007,
// LOGISTICA_C1_T37_VALUE_ACT_NO_BINDABLE_TARGET, Daniel-adjudicated).
// MISSION_OBLIGATION_AUTHORITY IS DECIDED ONCE, HERE. This module already owns
// the mission-required arbitration: decidirObjetivoConversacional /
// seleccionarOportunidadConversacional consult
// GrafoProyeccion.dimensionesPendientes (via direccionTieneNecesidadPendiente)
// and either select a Producer proposal for a still-pending required dimension
// or open the required-need fallback. What this function adds is the
// CONSUMER-FACING face of that SAME verdict -- never a second derivation of
// "which dimensions are pending": given the Objective-selected required
// opportunity, which of the Producer's raw opportunities remain the CURRENT
// executable mission obligation and which yield to it.
//
//   - no required opportunity selected -> nothing yields (this includes "all
//     required coverage is satisfied": existing optional-depth rules are
//     untouched);
//   - same dimension as the selected required opportunity -> executable
//     (LOCAL_DIMENSION_CONTINUITY on the required territory);
//   - any other dimension -> NOT the current executable obligation. It stays
//     valid memory / optional depth (VALID_MEMORY_UPDATE != NEW_MISSION_
//     OBLIGATION, GRAPH_MEMORY_SET != EXECUTABLE_OBLIGATION_SET): it is
//     reported, never deleted or mutated.
// MISSION_REQUIRED_COVERAGE > LOCAL_DIMENSION_CONTINUITY > OPTIONAL_ADDITIONAL_
// DEPTH. Downstream (Writer value-act gate, Decision candidate set) consumes
// this result and must not rederive mission priority from raw order, the first
// open opportunity, a Producer needKind alone or a satisfied dimension.
function dimensionDeclarada(oportunidad) {
  return oportunidad && typeof oportunidad.dimension === 'string' && oportunidad.dimension.trim()
    ? oportunidad.dimension.trim() : null;
}

// An opportunity YIELDS only when it explicitly claims a DIFFERENT mission
// dimension than the one the Objective selected as required. An opportunity
// that declares no dimension claims no mission territory at all (the legacy
// explicit-referent path) and is never "optional depth for a satisfied
// dimension" -- it is left exactly where it was.
function oportunidadCedeAMisionRequerida(oportunidad, oportunidadMisionRequerida) {
  if (!oportunidadMisionRequerida || !oportunidad) return false;
  const propia = dimensionDeclarada(oportunidad);
  const requerida = dimensionDeclarada(oportunidadMisionRequerida);
  return !!(propia && requerida && propia !== requerida);
}

function particionarOportunidadesPorPrioridadDeMision(oportunidades, objetivoConversacional) {
  const lista = Array.isArray(oportunidades) ? oportunidades : [];
  const requerida = objetivoConversacional && objetivoConversacional.oportunidadSeleccionada
    ? objetivoConversacional.oportunidadSeleccionada : null;
  const ejecutables = [];
  const cedidas = [];
  lista.forEach((o) => {
    (oportunidadCedeAMisionRequerida(o, requerida) ? cedidas : ejecutables).push(o);
  });
  return Object.freeze({
    ejecutables: Object.freeze(ejecutables),
    cedidas: Object.freeze(cedidas),
    dimensionRequerida: requerida && typeof requerida.dimension === 'string' ? requerida.dimension : null,
  });
}

module.exports = {
  OPERACIONES_OPORTUNIDAD,
  oportunidadCedeAMisionRequerida,
  particionarOportunidadesPorPrioridadDeMision,
  OBJETIVOS_CONVERSACIONALES,
  MOVIMIENTO_ESPERADO_POR_OBJETIVO,
  seleccionarGananciaCognitiva,
  seleccionarActoCognitivo,
  seleccionarOportunidadConversacional,
  evaluarSatisfaccionConocimiento,
  evaluarNovedadOportunidadTrasRespuestaDirigida,
  dimensionUnknownPendiente,
  direccionTieneNecesidadPendiente,
  prepararOportunidadTipadaDesdeDireccion,
  candidatosObjetivoParaDimension,
  candidatosObjetivoDeActoDeValor,
  anclajesElegiblesParaOperacion,
  // ASCENSO_PROGRESSIVE_ANCHOR_CHAIN -- isolable unit test of the native-
  // progression anchor predicate without needing anclajesElegiblesParaOperacion's
  // full filter pipeline.
  esAnclajeDeProgresionNativaAscenso,
  // NATIVE_GRAMMAR_GOVERNED_OUTPUT_CAN_ANCHOR_LATER_NATIVE_PROGRESSION --
  // DAR VIDA's own native-progression anchor predicate, and the shared
  // mechanic both grammar-owned predicates delegate to, isolable for unit
  // testing without needing anclajesElegiblesParaOperacion's full pipeline.
  esAnclajeDeProgresionNativaDarvida,
  esAnclajeDeProgresionNativaDeGramatica,
  diagnosticarOportunidadConversacional,
  direccionMision,
  movimientoObedeceObjetivo,
  decidirObjetivoConversacional,
  avanzarIntencionCierre,
  recalcularCicloPreguntaFinal,
};
