'use strict';

/**
 * INTERACCIÓN COGNITIVA WRITER
 * Único punto del backend capaz de confirmar una interacción cognitiva
 * completa: coordina una decisión ya calculada (LLM + síntesis de slots +
 * Gate) y la persiste, junto con el Turno y los eventos de la transición,
 * bajo una sola frontera de consistencia (CognitiveUnitOfWork).
 *
 * No es un nuevo orquestador: no decide prompts (AgoraPrompts), no decide
 * aprobación (GatePolicy), no decide síntesis (SlotSynthesisPolicy) — los
 * invoca y persiste su resultado. Ref: diseño aprobado del Incremento 3.
 *
 * ── Frontera de consistencia ──────────────────────────────────────────────
 * FUERA de cualquier transacción: llamada al LLM (LLMService — con sus
 * propios eventos técnicos llm.called/llm.attempt/llm.succeeded/llm.failed,
 * que se emiten en tiempo real, no dentro de la transacción cognitiva),
 * parsing, evaluación del Gate, síntesis de slots — todo síncrono y puro
 * salvo la llamada al LLM misma.
 * DENTRO de una única transacción (CognitiveUnitOfWork.ejecutar, síncrona):
 * Turno, slots materializados, estado canónico (versionado), y los eventos
 * cognitivos de la transición (slot.updated, slots.snapshot,
 * gate.approved/rejected, intelligence.completed, gramatica.avanzada,
 * sesion.status.cambiado). No se emite 'state.committed': auditoría de
 * dominio (previa a este incremento) concluyó que no aporta semántica
 * nueva — la cadena de versiones ya vive en state_versions, y el "porqué"
 * del commit ya lo explican el Turno y los eventos cognitivos de arriba.
 *
 * ── Dos mecanismos de concurrencia distintos ──────────────────────────────
 * 1. Single-flight por (sesionId, turnoClienteId): solicitudes concurrentes
 *    con la misma clave comparten una sola ejecución.
 * 2. Serialización cognitiva por sesionId: dos turnoClienteId DISTINTOS de
 *    la misma sesión se ejecutan en fila — cargar estado, llamar al LLM,
 *    evaluar, persistir y liberar es una unidad indivisible por sesión.
 *    Sesiones distintas se ejecutan en paralelo sin ninguna espera mutua.
 * Ambos mecanismos son en memoria (Map) y presuponen una sola instancia de
 * backend — si el proceso se escala horizontalmente, esta coordinación deja
 * de ser suficiente y debe reemplazarse por una reserva durable o
 * coordinación distribuida (no se diseña aquí).
 *
 * ── Autoridad sobre el estado ──────────────────────────────────────────────
 * El body de la solicitud puede seguir incluyendo `etapa`/`understood` por
 * compatibilidad con el bridge legacy (Incremento 4 los retira del
 * contrato). Este writer los IGNORA por completo: la gramática activa se
 * lee siempre de state.gramaticaActiva (backend), y los slots de entrada
 * siempre de state.slots persistido — nunca de lo que mande el cliente. No
 * hay ninguna ruta en este archivo donde un valor del cliente decida
 * gramática activa, gramáticas completadas, resultado de Gate, ciclo de
 * vida o progreso del pipeline.
 *
 * ── Frontera única de autoridad de cierre (Incremento 4) ───────────────────
 * Exactamente un punto decide qué autoridad gobierna el avance real de las 5
 * gramáticas conversacionales — ver decidirInteraccion, bloque "frontera
 * única": protocolV2Enabled===false → GatePolicy.evaluateGramatica (sin
 * cambios respecto al comportamiento histórico); protocolV2Enabled===true →
 * ProgresoConversacionalPolicy.decidirProtocolo, y GatePolicy.evaluateGramatica
 * NUNCA se invoca en ese modo (no aprueba, no bloquea, no compara — perdió
 * toda función operativa bajo V2 porque el contrato nuevo ya no le pide al
 * generador los campos que esa función exige). Ninguna otra parte de este
 * archivo, de la API HTTP ni del bridge vuelve a preguntar "¿qué modo es
 * este" para decidir avance — solo para construir el prompt correcto
 * (buildGramaticaPrompt vs. buildGramaticaPromptV2) y para elegir qué texto
 * exponer como `mensaje`.
 *
 * GatePolicy conserva intactos, en ambos modos, el resto de sus gates
 * (avatar_anclado, arquitectura, bifurcacion_real, desarrollo_completo) —
 * pertenecen a la etapa POSTERIOR al ciclo conversacional (downstream, tras
 * DAR VIDA) y este archivo nunca los toca ni los reemplaza.
 *
 * Bajo V2, `completed` (la respuesta HTTP) se deriva exclusivamente de
 * `avanzaReal` (progreso.avanza) — nunca del booleano legacy. `avanzaSegunProtocoloNuevo`
 * deja de ser una sugerencia paralela expuesta para comparación: bajo V2 ES
 * el veredicto real, no una segunda opinión.
 */

const { createTurno, generateTurnoId } = require('../schemas/Turno');
const { createEvent }   = require('../schemas/Event');
const { createVersion } = require('../schemas/Version');
// C007 CONVERSATIONAL ENGINE STABILIZATION -- DETERMINISTIC REPLAY CAPTURE.
// Same identity functions LLMService.js's capture hook and the C007 test
// replay harness use -- single source, see ReplayFingerprints.js docstring.
const { sha256Hex, computeEngineBuildFingerprint } = require('../observability/ReplayFingerprints');
// OBSERVABILITY_O1 -- only for LLMService.clearReplayCaptureContext(turnoId)
// (releasing the shared turn-scoped capture context, see its own
// docstring); never for constructing a new LLMService (this.  _llmService
// stays fully dependency-injected, unchanged).
const { LLMService } = require('../llm/LLMService');
// DURABILIDAD_ENTRADA_CONVERSACIONAL_1
const { createEntradaConversacional } = require('../schemas/EntradaConversacional');
const { ERROR_CATEGORIES } = require('../llm/LLMErrorTaxonomy');
const { createContratoIntervencion, normalizarTipoAccionUsuario, proyectarContratoIntervencionPresentada } = require('../schemas/ContratoIntervencion');
const {
  materializarIntervencionVisible,
  validarMaterializacion,
  respuestaOperacionalFalloFidelity,
  MENSAJE_OPERACIONAL_FALLO_GENERICO,
} = require('./MaterializacionIntervencionVisible');
const {
  procesarRespuestaValidacionRelacionTransformacionalDestino,
} = require('./ValidacionRelacionTransformacionalDestinoCasoDeUso');
const { evaluarDerechoAValidarDestino } = require('../policy/DerechoAValidarDestinoPolicy');
const { esFalloOperacionalPersistencia } = require('../persistence/PersistenceOperationalError');
// circulomejora006_act10l — productor existente (act10c/d), nunca
// reimplementado aquí: evaluarEstadoRelacionTransformacionalDestino decide
// entre vigencia/propuesta nueva (ver docstring propio, "punto de entrada
// único para el llamador (Writer futuro o pruebas)" — este es exactamente
// ese llamador), proyectarHipotesisParaEstado produce la proyección plana
// de observabilidad (nunca autoridad), generateHipotesisId mina el mismo
// tipo de identificador opaco que generateTurnoId (arriba) — nunca parte de
// la entidad.
const {
  evaluarEstadoRelacionTransformacionalDestino, proyectarHipotesisParaEstado, generateHipotesisId,
  validarPropuestasRolesTransformacionales,
  revalidarComposicionTransformacionalPendiente,
  recuperarRolesOriginalesPorIdentidad,
  // circulomejora006_reporte02 (incremento correctivo) — lectura pura de la
  // emisión CONFIRMADA (nunca escribe), exclusiva del camino de
  // recuperación tras EMISION_YA_CONFIRMADA (ver
  // _recuperarOCompletarConvergenciaTransformacional).
  recuperarHipotesisConfirmadaPendienteDeConvergencia,
  // S1_R_INCREMENTO_3 — ver docstrings propios en CicloHipotesisTransformacionalDestinoOrquestacion.js.
  reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable,
  sembrarMemoriaNegativaDesdeRegistroDurable,
} = require('../policy/CicloHipotesisTransformacionalDestinoOrquestacion');
// circulomejora006_reporte01 (Paso 1 — convergencia productiva) —
// HipotesisTransformacionalDestino CONFIRMADA → AfirmacionTransformacionalDestino
// AUTORIZADA y durable. Único punto de traducción entre ambas autoridades —
// nunca reimplementa lifecycle/repositorio/cabeza/sucesión/presentación (ver
// docstring propio de ConvergenciaTransformacionalDestinoOrquestacion.js).
// circulomejora006_reporte02 añade buscarConvergenciaDurablePorHipotesis —
// consulta pura, ver mismo docstring.
const {
  convergerHipotesisConfirmadaAAfirmacionDurable, buscarConvergenciaDurablePorHipotesis,
} = require('../policy/ConvergenciaTransformacionalDestinoOrquestacion');
// CERRAR_FIDELIDAD_DE_SINTESIS_DE_DESTINO — frontera D1-independiente:
// dada la Afirmación AUTORIZADA vigente de la sesión, reconstruye el texto
// exacto de su Presentación causal (nunca evalúa BaseDefendible/D1, nunca
// decide si corresponde sintetizar — eso lo sigue decidiendo por completo
// decidirProtocolo/determinarEstadoProtocolarEfectivo, sin cambios). Ver
// docstring propio en SintesisDestinoDesdePresentacionPolicy.js.
const {
  producirSintesisDestinoAutorizadaDesdeRepositorio,
} = require('../policy/SintesisDestinoDesdePresentacionPolicy');
const {
  createInitialState, deserializeState, serializeState,
} = require('../schemas/CognitiveState');
const { GatePolicy, GATE_OUTCOMES } = require('../policy/GatePolicy');
const { buildGramaticaPrompt, buildGramaticaPromptV2, buildReconciliacionPrompt, buildRealizadorTurnoConversacional, buildCapa1CognitiveResponseSchema, CAPA1_CANDIDATE_REPAIR_SCHEMA, buildCapa1CandidateRepairSchema, buildCapa1DirectedSupportRepairSchema, buildCapa1CandidateRebindSchema, buildCapa1ContentClosureRepairSchema, buildCapa1ContentClosureRepairSystem, buildCapa1BootstrapAcquisitionCorrectionSchema, buildCapa1BootstrapAcquisitionCorrectionSystem, buildCapa1BootstrapReacquisitionSchema, buildCapa1BootstrapReacquisitionSystem, buildCapa1FreshGroundingCorrectionSchema, buildCapa1FreshGroundingCorrectionSystem } = require('../agora/AgoraPrompts');
const { ProducerExecutionCoordinator, PRODUCER_FAILURE_CLASSES } = require('../llm/ProducerExecutionCoordinator');
const { serializeSlots, GRAMATICA_ORDER, validateGramaticaComplete, SLOTS_BY_GRAMATICA, SLOT_DEFINITIONS } = require('../schemas/AgoraSlots');
const { sintetizarSlot } = require('../state/SlotSynthesisPolicy');
const { debeSolicitarDownstream } = require('../policy/DownstreamTriggerPolicy');
const { clasificarSenalesCierreConversacional } = require('../policy/SenalCierreConversacionalPolicy');
const {
  decidirObjetivoConversacional, avanzarIntencionCierre, movimientoObedeceObjetivo, recalcularCicloPreguntaFinal,
  anclajesElegiblesParaOperacion, diagnosticarOportunidadConversacional,
  direccionTieneNecesidadPendiente,
  prepararOportunidadTipadaDesdeDireccion,
  candidatosObjetivoDeActoDeValor,
  evaluarNovedadOportunidadTrasRespuestaDirigida,
  seleccionarGananciaCognitiva,
  particionarOportunidadesPorPrioridadDeMision,
} = require('../policy/ObjetivoConversacionalPolicy');
const { adjudicarOportunidadSemantica } = require('../policy/AdjudicadorSemanticoOportunidadConversacional');
const {
  dimensionNativaDeDesconocido, dimensionesAfectadasPorDesconocido, dimensionCoherenteConBinding, dimensionTrasRebind,
} = require('../policy/RebindEstructuralPolicy');
const { vincularObjetivoConcretoNecesidadRequerida, resolverVinculacionObjetivoDeActoDeValor } = require('./VinculacionObjetivoConcretoNecesidadRequerida');
const {
  reconstruirContratoRespuestaDirigida, validarRelacionRespuestaDirigida, proyectarAlineacionRespuestaDirigida,
  objetivoDeActoEsBusquedaAbiertaNoGobernada,
  listarDefectosRelacionRespuestaDirigida,
  relacionEsPostcondicionDelProductor,
  interpretarVeredictoRespuestaActoAnterior, VEREDICTOS_RESPUESTA_ACTO_ANTERIOR,
  RESULTADO_VERIFICADA,
} = require('../policy/ContratoRespuestaDirigidaPolicy');
const {
  derivarComandosApertura, derivarComandosResolucion, aplicarComandosReparacion,
  proyectarReparacionesPendientes,
} = require('../policy/ReparacionInterpretativaPolicy');
const {
  normalizarPropuestaSatisfaccion,
  certificarSatisfaccionReparacion,
} = require('../policy/CertificadorSatisfaccionReparacion');
const { proyectarObligacionesAbiertasDestino } = require('../policy/ObligacionesAbiertasDestinoProjection');
const { evaluarSuficienciaParaSintesis } = require('../policy/SuficienciaParaSintesisPolicy');
const {
  decidirProtocolo, componerMensajeFinal, reaccionRechazoControlada, validarContratoPorEstado,
  determinarEstadoProtocolarEfectivo, EVENTOS: PROTOCOLO_EVENTOS, AMBITOS_CORRECCION_RELACIONAL, IMPACTOS_CAMBIO,
  resolverNextUserAction, PROTOCOLO_ESTADOS: PROTOCOLO_ESTADOS_PROGRESO,
  validarComponenteRelacional, estadoPermiteDireccionConversacional,
  proyectarEstadoConversacionalPostTurno, CONFIRMATION_SUBJECTS,
} = require('../policy/ProgresoConversacionalPolicy');
const {
  fuenteSemanticaAfirmacion,
  evaluarElegibilidadFuenteSintesis,
} = require('../policy/S1SintesisElegibilidadPolicy');
const {
  aplicarDelta, aplicarDeltaReconciliacion, naturalezaEpistemicaGobernada, aplicarMarcaMaterializacion,
  aplicarDeltaIntegridad, aplicarDeltaRevisionActiva, contenidoEsExtractivo,
  construirUnidadesEvidenciaLiteral, materializarSeleccionEvidenciaLiteral,
  materializarConexionRechazada, conceptosConfirmablesParaReconciliacion,
} = require('../state/GrafoConocimientoPolicy');
// DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final —
// CITA_LITERAL_ESPECIFICA_NO_EQUIVALE_A_CORRECCION_DEL_CONCEPTO) — puerto
// estrecho de adjudicación, ver docstring propio del archivo. Nunca
// produce, nunca muta — solo determina si un fragmento citado modifica
// semánticamente un concepto concreto, invocado exclusivamente desde
// validarMutacionesDestructivasBajoCierre (abajo), nunca desde otro punto.
const {
  identidadValidacionMutacion, prefiltroEstructuralMutacion, validarSemanticamenteMutacion,
  decidirAceptacionMutacion, normalizarParaHash: normalizarParaHashSemantico,
} = require('./ValidadorSemanticoMutacionConcepto');
// DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — mismo patrón de puerto
// estrecho que ValidadorSemanticoMutacionConcepto arriba, invocado
// exclusivamente desde gobernarDimensionDeltaConceptos (abajo): adjudica
// DIMENSION_GOBERNADA para conceptosNuevos cuya dimensión propuesta por el
// generador diverge del objetivo vigente, o presenta señal de solapamiento
// con otro concepto del mismo turno. Nunca produce, nunca muta el grafo.
const { validarSemanticamenteDelta } = require('./ValidadorSemanticoDeltaConceptos');
const { validarNovedadCognitivaResiduo } = require('./ValidadorNovedadCognitivaResiduo');
const {
  validarSoporteSemanticoGanancia, seleccionarSoporteSemanticoCorregido,
  esSoporteCrossTurnoDeAltoRiesgo, desafiarSoporteCrossTurnoGanancia, spansEvidenciaFundamentadosYCoberturaCompleta,
} = require('./ValidadorSoporteSemanticoGanancia');
// LLM_CALL_PROFILE_GOVERNANCE_1 — reemplaza TOKENS_CONTRATO_ESTRUCTURADO_
// GRAMATICA (un literal de presupuesto) por un nombre de perfil: cada
// llamada declara QUÉ TRABAJO necesita ("veredicto estructurado",
// "generación cognitiva estructurada", "realización conversacional") —
// ver CallProfiles.js. InteraccionCognitivaWriter sigue sin conocer
// ningún número mágico de presupuesto, ni la traducción a parámetros de
// ningún proveedor concreto (esa traducción vive exclusivamente en
// LLMService/Provider — ver test H de test_gemini_provider_estabilidad_1.js).
const {
  decidirMovimiento, decidirMovimientoDestino, ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES,
  MOVIMIENTOS_DESTINO, textoDeterministaReparacion, fallbackMovimientoTrasFalloRealizador,
  MODOS_FALLBACK_MOVIMIENTO, construirContratoIntervencionDesdeMovimiento,
} = require('../state/MovimientoConversacionalPolicy');
const {
  candidatosRelacionDurableEntreAnclajes, validarConexionConectadaDeclarada,
} = require('../state/MaterialRelacionalCitable');
const {
  getGrammarMissionAdapter, getGrammarMissionDescriptor, PROPOSITO_GLOBAL, construirContratoIntervencionDeMision,
  describirFacetaDeMision,
} = require('../state/GrammarMissionAdapter');
const { proyectarComprensionTrabajo, seleccionarFocoConversacional } = require('../policy/ComprensionTrabajoPolicy');
const { construirContextoAtribucionRespuesta, leerContextoAtribucionRespuestaVigente } = require('../state/ContextoAtribucionRespuesta');
const {
  congelarActoUnico, decidirIntervencionConversacional, exigenciaDeActoDeValor,
  OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA,
  OPERADORES_QUE_REQUIEREN_SOLICITUD_VISIBLE,
} = require('../state/DecisorIntervencionConversacional');
const { clasificarRespuestaNegativa } = require('../state/RespuestaNegativaPolicy');
const {
  crearSemanticUnknownCandidate,
  materializarSemanticUnknown,
  promoverSemanticUnknownAObligacion,
  resolverSemanticUnknown,
  esObligacionActivaParaMision,
  encontrarObligacionActivaReutilizable,
} = require('../state/SemanticUnknown');
const {
  ESTRATEGIAS: ESTRATEGIAS_MATERIALIZACION, CONTEXTOS: CONTEXTOS_MATERIALIZACION,
  EVALUACION_GRAFO, decidirMaterializacion, decidirFallbackTrasFalloTransformar,
} = require('./GobernanzaMaterializacion');
// C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 2 --
// NEXT_ACT_AUTHORITY_IS_SINGLE. The one owner/builder of the projection
// repair-eligibility and canonical Decision must both consume -- see
// CanonicalNextActState.js for the full authority contract.
const {
  construirCanonicalNextActState, tieneAlternativaCanonicaEjecutable, proyectarReferenciasParaTraza,
} = require('../state/CanonicalNextActState');

function direccionConversacionalTipadaActiva(gramatica) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  return !!(descriptor && descriptor.direccionConversacional
    && descriptor.direccionConversacional.tipada === true);
}

function clasificarEstadoFronteraCognitiva(evaluada, frontera) {
  if (!evaluada) return 'NOT_EVALUATED';
  return Array.isArray(frontera) && frontera.length > 0
    ? 'EVALUATED_NONEMPTY'
    : 'EVALUATED_EMPTY';
}

// GOVERNED_RESPONSE_MAY_COMMIT_WITHOUT_NEW_CURRENT_WHAT (C007,
// DIRECTED_RESPONSE_ATTEMPT_REPAIR_AUTHORITY_CONTINUITY). VALID_TURN !=
// CURRENT_CANONICAL_ACT_PRESENT: a turn whose directed response to the
// previous frozen act was STRUCTURALLY VERIFIED (validarRelacionRespuestaDirigida's
// own RESULTADO_VERIFICADA, never a raw Producer declaration) and that
// ATIENDE_OBJETIVO -- i.e. satisfied the previous contracted act -- has done
// its cognitive job; the previous act no longer needs to stay active, and
// the absence of a NEW current act is not a reason to fail the turn. Pure
// factoring-out of the fact the caller already holds (the same two
// authorities interpretarVeredictoRespuestaActoAnterior consumes); it
// invents no operator and decides nothing about progression.
function respuestaDirigidaSatisfaceActoPrevio({ contratoRespuestaDirigida = null, alineacionRespuestaDirigida = null } = {}) {
  return !!(contratoRespuestaDirigida
    && contratoRespuestaDirigida.actoCognitivoVisible
    && alineacionRespuestaDirigida
    && alineacionRespuestaDirigida.resultado === RESULTADO_VERIFICADA
    && alineacionRespuestaDirigida.relacion === 'ATIENDE_OBJETIVO');
}

function debeRepararCandidatoEnFrontera({
  estadoFrontera, reaperturaSinNovedad = false, gananciaSeleccionada = null,
  candidatosCompatibles = [], adquisicionesRebindables = [],

  // C007 — REPAIR SUPPRESSION MUST USE CANONICALLY CONSUMABLE NEXT-ACT
  // AUTHORITY (human product canary v14 T3, deterministic replay). Scoped
  // EXCLUSIVELY to the content-rejected disjunct below -- gananciaSeleccionada/
  // candidatosCompatibles keep governing the OTHER, pre-existing disjunct
  // byte for byte, unchanged. See that disjunct's own comment for why.
  alternativaCanonicaDisponible = false,
} = {}) {
  const idsCompatibles = new Set((Array.isArray(candidatosCompatibles) ? candidatosCompatibles : [])
    .map(c => c && c.idTemporal).filter(Boolean));
  const adquisicionLegitimaSinBinding = (Array.isArray(adquisicionesRebindables)
    ? adquisicionesRebindables : [])
    .some(c => c && c.idTemporal && !idsCompatibles.has(c.idTemporal));
  const sinCandidatosCompatibles = Array.isArray(candidatosCompatibles) && candidatosCompatibles.length === 0;
  // C007 — CONTENT-REJECTED RESIDUE MUST REPAIR WITHIN FROZEN COGNITIVE
  // DIRECTION (human product canary v14 T3, 502). The structural-rebind
  // branch below (unchanged, still requires !reaperturaSinNovedad) means
  // "a cognitively valid, already-approved WHAT has a stale/invalid
  // structural binding" -- REPAIR CAN PROPOSE WHAT != REPAIR CAN AUTHORIZE
  // WHAT, and rebind never re-proposes the WHAT itself, so it correctly
  // stays exclusive of a content rejection. A DIFFERENT, parallel case:
  // semantic governance rejected every candidate outright
  // (reaperturaSinNovedad true) -- CONTENT_REJECTED_RESIDUE +
  // NONEMPTY_ADMISSIBLE_FRONTIER + ZERO_USABLE_CANDIDATES ->
  // COGNITIVE_CANDIDATE_REPAIR. There is nothing frozen to rebind here
  // (adquisicionesRebindables is empty by construction whenever the
  // Producer's own oportunidades were already filtered to nothing), so
  // this can only ever select the EXISTING PROPUESTA_COGNITIVA_POST_
  // GOBERNANZA mode below -- propose, never bypass, never authorize by
  // itself.
  //
  // REPAIR_SUPPRESSION_SIGNAL -> MUST_BE_CONSUMABLE_BY_NEXT_ACT_AUTHORITY
  // (human product canary v14 T3, deterministic replay) -- gananciaSeleccionada/
  // sinCandidatosCompatibles here previously gated suppression from RAW,
  // turn-local proxies (seleccionarGananciaCognitiva applied straight to
  // Capa 1's own r.parsed, and a frontier-only compatibility scan that also
  // resurfaces that SAME raw gain as a synthetic {tipo:'GANANCIA_COGNITIVA'}
  // candidate) -- NEITHER is the representation decidirIntervencionConversacional
  // actually consumes (governedGain / oportunidadesConversacionales / open
  // graph incertidumbres). A raw gain decidirObjetivoConversacional's own
  // cierre-priority branch will never surface as governedGain cannot license
  // suppressing repair: GAIN_AVAILABLE != RIGHT_TO_CONSUME_VISIBLE_TURN.
  // alternativaCanonicaDisponible is computed by the caller from those SAME
  // canonical representations (see InteraccionCognitivaWriter's call site) --
  // CONTENT_REJECTED + EVALUATED_NONEMPTY_FRONTIER + NO_CANONICAL_NEXT_ACT_
  // AVAILABLE -> REPAIR, independent of any upstream proxy's truthiness.
  const contenidoRechazadoSinCandidato = reaperturaSinNovedad
    && !alternativaCanonicaDisponible;
  return estadoFrontera === 'EVALUATED_NONEMPTY'
    && (
      (!reaperturaSinNovedad
        && (adquisicionLegitimaSinBinding || (!gananciaSeleccionada && sinCandidatosCompatibles)))
      || contenidoRechazadoSinCandidato
    );
}

// C007 — contrato estructural de candidatos de Capa 1.  LLMService valida
// únicamente que la respuesta sea JSON; esta frontera impide que una
// oportunidad semántica incompleta llegue a la gobernanza como candidata
// aparentemente válida.  Solo se permite el downgrade conservador de una
// afirmación PARCIAL sin residuo estructurado; nunca se fabrica semántica.
function canonicalizarSatisfaccionOportunidad(oportunidad) {
  if (!oportunidad || typeof oportunidad !== 'object' || Array.isArray(oportunidad)) return oportunidad;
  const satisfaccion = oportunidad.satisfaccionConocimiento;
  if (!satisfaccion || typeof satisfaccion !== 'object' || Array.isArray(satisfaccion)) return oportunidad;
  if (satisfaccion.estado !== 'PARCIAL') return oportunidad;
  const residuo = satisfaccion.residuoSemantico;
  const residuoValido = residuo && typeof residuo === 'object' && !Array.isArray(residuo)
    && typeof residuo.semanticTarget === 'string' && residuo.semanticTarget.trim()
    && typeof residuo.referenteSemantico === 'string' && residuo.referenteSemantico.trim()
    && typeof (residuo.operation || residuo.operacion) === 'string'
    && (residuo.operation || residuo.operacion).trim();
  if (residuoValido) return oportunidad;
  // Conservative downgrade only: remove the unsupported stronger state;
  // never manufacture residue, evidence, anchors, or semantic content.
  return {
    ...oportunidad,
    // PARCIAL already declared the epistemic shape of the proposed WHAT.
    // Removing an incomplete residue may weaken satisfaction to ABIERTA,
    // but must not silently reinterpret mechanism acquisition as existence.
    needKind: oportunidad.needKind
      || (oportunidad.operacion === 'ABRIR_COMO' ? 'MECHANISM' : null),
    satisfaccionConocimiento: {
      ...satisfaccion,
      estado: 'ABIERTA',
      residuoSemantico: null,
    },
  };
}

function oportunidadConversacionalEstructuralmenteValida(oportunidad) {
  if (!oportunidad || typeof oportunidad !== 'object' || Array.isArray(oportunidad)) return false;
  // Las oportunidades legacy sin semanticTarget siguen siendo datos de
  // bookkeeping; no se presentan como una oportunidad semántica completa.
  if (typeof oportunidad.semanticTarget !== 'string' || !oportunidad.semanticTarget.trim()) return true;
  if (typeof oportunidad.referenteSemantico !== 'string' || !oportunidad.referenteSemantico.trim()) return false;
  if (typeof oportunidad.operacion !== 'string' || !oportunidad.operacion.trim()) return false;
  if (typeof oportunidad.evidenciaBuscada !== 'string' || !oportunidad.evidenciaBuscada.trim()) return false;
  const satisfaccion = oportunidad.satisfaccionConocimiento;
  if (!(satisfaccion && typeof satisfaccion === 'object' && !Array.isArray(satisfaccion)
    && ['SATISFECHA', 'PARCIAL', 'ABIERTA'].includes(satisfaccion.estado)
    && Array.isArray(satisfaccion.evidenciaConceptoIds))) return false;
  // PARCIAL carries an unresolved semantic residue, whose canonical shape
  // is the same one consumed by evaluarSatisfaccionConocimiento.  Plain
  // text is not a structurally complete candidate and is rejected here.
  if (satisfaccion.estado === 'PARCIAL') {
    const residuo = satisfaccion.residuoSemantico;
    if (!(residuo && typeof residuo === 'object' && !Array.isArray(residuo)
      && typeof residuo.semanticTarget === 'string' && residuo.semanticTarget.trim()
      && typeof residuo.referenteSemantico === 'string' && residuo.referenteSemantico.trim()
      && typeof (residuo.operation || residuo.operacion) === 'string'
      && (residuo.operation || residuo.operacion).trim())) return false;
  }
  return true;
}

function normalizarOportunidadesConversacionales(lista, idTemporalAReal = {}) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, 3)
    .map(canonicalizarSatisfaccionOportunidad)
    .filter(oportunidadConversacionalEstructuralmenteValida)
    .map(o => {
      const residuo = o.satisfaccionConocimiento
        && o.satisfaccionConocimiento.residuoSemantico;
      const operacionResiduo = residuo && (residuo.operation || residuo.operacion);
      // Satisfaction coverage and epistemic need are separate axes. A
      // typed HOW residue remains MECHANISM even when the accumulated
      // coverage is ABIERTA; otherwise the same producer contract is
      // reinterpreted downstream as an existence question.
      const needKind = o.needKind
        || (o.operacion === 'ABRIR_COMO' && operacionResiduo === 'ABRIR_COMO'
          ? 'MECHANISM' : null);
      const soporte = o.satisfaccionConocimiento
        && Array.isArray(o.satisfaccionConocimiento.evidenciaConceptoIds)
        ? o.satisfaccionConocimiento.evidenciaConceptoIds : [];
      const anclajesDeclarados = Array.isArray(o.anclajeConceptoIds)
        ? o.anclajeConceptoIds : [];
      // Evidence already adjudicated for this opportunity is a governed
      // identity binding.  Preserve that same binding when the provider did
      // not redundantly repeat it in anclajeConceptoIds; no semantic anchor
      // is inferred from free text here.
      const anclajeConceptoIds = [...new Set((anclajesDeclarados.length > 0
        ? anclajesDeclarados : soporte).map(id => idTemporalAReal[id] || id))];
      return {
        ...o,
        ...(needKind ? { needKind } : {}),
        epistemicStatus: o.epistemicStatus
          || (o.semanticUnknownId || o.unknownId || o.satisfaccionConocimiento ? 'OPEN_SEARCH' : null),
        subjectRef: o.subjectRef || anclajeConceptoIds[0] || null,
        ...(!o.subjectRef && anclajeConceptoIds[0] ? { subjectRefPosicional: true } : {}),
        anclajeConceptoIds,
        satisfaccionConocimiento: o.satisfaccionConocimiento ? {
          ...o.satisfaccionConocimiento,
          evidenciaConceptoIds: soporte.map(id => idTemporalAReal[id] || id),
        } : o.satisfaccionConocimiento,
        anclajeRelacionIds: Array.isArray(o.anclajeRelacionIds) ? o.anclajeRelacionIds : [],
      };
    });
}

function validarFormaConceptosNuevos(parsed) {
  const conceptos = parsed && parsed.conceptosNuevos;
  if (!Array.isArray(conceptos)) return [];
  const errores = [];
  conceptos.forEach((c, i) => {
    if (!c || typeof c !== 'object') { errores.push(`conceptosNuevos[${i}] debe ser un objeto`); return; }
    for (const campo of ['idTemporal', 'tipo', 'autoridad', 'procedencia']) {
      if (typeof c[campo] !== 'string' || !c[campo].trim()) errores.push(`conceptosNuevos[${i}].${campo} ausente o vacío`);
    }
    if (typeof c.descripcion !== 'string' || !c.descripcion.trim()) errores.push(`conceptosNuevos[${i}].descripcion ausente o vacío`);
  });
  return errores;
}

// Keep the producer's representation contract distinct from semantic
// governance policy.  Both may make the legacy `valido` bit false, but only
// representation failures own the pre-governance producer-failure boundary.
function etiquetarValidacionContrato(resultado, clase = 'REPRESENTACION') {
  const base = resultado && typeof resultado === 'object' ? resultado : {};
  const errores = Array.isArray(base.errores) ? base.errores : [];
  const invalida = base.valido === false;
  return {
    ...base,
    errores,
    claseError: invalida ? clase : null,
    erroresRepresentacion: invalida && clase === 'REPRESENTACION' ? [...errores] : [],
    erroresGobernanza: invalida && clase === 'GOBERNANZA' ? [...errores] : [],
  };
}

// C007 — PRESERVE GOVERNED NOVELTY DISTINCTION INTO CONTRACTED WHAT (human
// canary v14 T3). SemanticUnknown.proposicion (the ONLY field that reaches
// actoCognitivoVisible.expectedEvidence, via decidirIntervencionConversacional's
// `mechanism.descripcion`) is the minimal EXISTING structural slot a
// materialized unknown's WHAT already flows through -- no new subsystem.
// oportunidad.semanticTarget alone is a short label; oportunidad.evidenciaBuscada
// (the SAME governed oportunidad object -- never a different, ungoverned
// Producer field) frequently carries the specific distinguishing content that
// a residue's own novelty verdict (DISTINCT_COGNITIVE_RESIDUE) was actually
// judged against. Using semanticTarget alone silently discarded that
// distinguishing content before it could ever reach the Contract/Realizer --
// DISTINCT_COGNITIVE_RESIDUE -> DISTINGUISHING_DIMENSION_MUST_SURVIVE_IN_
// CONTRACTED_WHAT. This never grants evidenciaBuscada new authority on its
// own (FREE_FORM_PRODUCER_TEXT MAY_DESCRIBE_COGNITIVE_PROPOSAL BUT MUST_NOT_
// CREATE_CONTRACTUAL_AUTHORITY, unchanged): it only combines two fields
// ALREADY present on the SAME oportunidad object that both call sites below
// already treat as governed enough to materialize a new unknown from
// (semanticTarget alone was already trusted here before this fix).
// CANONICAL_REALIZABLE_TARGET (C007 Machine Product Acceptance, live-eval
// cocina_1/logistica_1 REALIZACION_CONTRATO_NO_FIEL family; architectural
// correction, Daniel-adjudicated). FIDELITY_WHAT_VIEW == REALIZER_WHAT_VIEW:
// Fidelity already sees actoCognitivoVisible.expectedEvidence (axis A,
// unmodified); the Realizer structurally never did (RUN 3, CLOSED,
// unmodified -- expectedEvidence stays excluded from actoAutoridadCerrada).
// The contradiction was never "the Realizer needs expectedEvidence" -- it
// is that the Realizer had NO governed semantic content distinguishing
// this turn's WHAT from an EARLIER, already-addressed need about the SAME
// subject. This projection supplies exactly that, built EXCLUSIVELY from
// material whose authority Círculo has already independently established
// -- never Producer semanticTarget/evidenciaBuscada/residuoSemantico
// (proposicionGobernadaDeOportunidad, immediately above, is exactly that
// forbidden source -- deliberately never reused here):
//   - operator/missionNeed/expectedCognitiveEffect: already structural
//     authority (actoCognitivoVisible's own fields, Decision-frozen).
//   - subjectDescripcionGobernada: the SUBJECT CONCEPT's own `descripcion`,
//     already durable/governed (autoridad:'experto', contenidoEsExtractivo-
//     verified at the SAME authority gate every concept passes -- never
//     re-verified here, only read).
// Deliberately THIN when that is all that legitimately exists (a mechanism
// this turn asks about is, by construction, still UNKNOWN -- there is no
// governed prior description of it to draw from, and inventing one here
// would be exactly the leak RUN 3 closed). AgoraPrompts.js renders this
// data into prose (rendering, not deriving); it never adds semantic
// content beyond what this projection already carries. Returns null when
// subjectRef does not resolve against `grafo` -- callers must treat null
// as NO_REALIZATION_CANDIDATE, never fall back to unauthorized material.
function proyectarTargetRealizableCanonico(actoCognitivoVisible, grafo) {
  if (!actoCognitivoVisible || !actoCognitivoVisible.operator) return null;
  const conceptos = (grafo && Array.isArray(grafo.conceptos)) ? grafo.conceptos : [];
  const sujeto = actoCognitivoVisible.subjectRef
    ? conceptos.find(c => c && c.id === actoCognitivoVisible.subjectRef && c.activo !== false)
    : null;
  return Object.freeze({
    operator: actoCognitivoVisible.operator,
    missionNeed: actoCognitivoVisible.missionNeed || null,
    subjectDescripcionGobernada: sujeto ? sujeto.descripcion : null,
    expectedCognitiveEffect: actoCognitivoVisible.expectedCognitiveEffect || null,
    sourceRefs: Object.freeze({
      subjectConceptId: sujeto ? sujeto.id : null,
      target: actoCognitivoVisible.target || null,
    }),
    // MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET --
    // the requested facet travels next to the target, structurally
    // ({mission, dimension}); significadoNativo is the grammar's OWN
    // definition of that dimension (adapter / slot registry), never Producer
    // prose. Present only when the act froze a facet.
    ...(actoCognitivoVisible.requestedFacet ? {
      requestedFacet: Object.freeze({
        mission: actoCognitivoVisible.requestedFacet.mission,
        dimension: actoCognitivoVisible.requestedFacet.dimension,
        significadoNativo: describirFacetaDeMision(
          actoCognitivoVisible.requestedFacet.mission, actoCognitivoVisible.requestedFacet.dimension),
      }),
    } : {}),
  });
}

function proposicionGobernadaDeOportunidad(oportunidad) {
  const semanticTarget = typeof oportunidad.semanticTarget === 'string' ? oportunidad.semanticTarget.trim() : '';
  const evidenciaBuscada = typeof oportunidad.evidenciaBuscada === 'string' ? oportunidad.evidenciaBuscada.trim() : '';
  if (!evidenciaBuscada || evidenciaBuscada === semanticTarget) return semanticTarget || null;
  return `${semanticTarget} — ${evidenciaBuscada}`;
}

/**
 * Deterministic projection of the epistemically admissible territory for the
 * active mission.  This is deliberately an envelope, not a semantic WHAT:
 * it contains only governed subject references, the pending mission need and
 * operation classes supplied by the grammar adapter.  Candidate generation
 * and Decision Authority remain responsible for proposing/selecting the
 * actual target.
 */
function construirFronteraCognitivaAdmisible({
  grafo = null,
  gramatica = null,
  slots = {},
  dimension = null,
  semanticUnknowns = [],
  idTemporalAReal = {},
  // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- turn-scoped concept OBJECTS
  // that KNOWLEDGE_ELIGIBILITY (elegibleParaAbstraer) correctly excluded
  // from THIS turn's durable delta (never in `grafo`, never durable, never
  // future abstraction rights) but that already passed aplicarDelta's own
  // real extraction/authority derivation -- legitimately user-grounded,
  // never invented. See the sujetosInferidos comment below for the full
  // rationale; this is purely an ADDITIONAL, non-durable source for that
  // same open-hypothesis material.
  conceptosHipotesisAbierta = [],
} = {}) {
  const descriptor = getGrammarMissionDescriptor(gramatica);
  const direccion = descriptor && descriptor.direccionConversacional;
  // Una dimensión explícita puede acotar el territorio; cuando no existe,
  // la misión conserva su lifecycle desde el descriptor del adapter.
  const pendiente = Boolean(dimension)
    || direccionTieneNecesidadPendiente({ gramatica, slots, grafo });
  const operaciones = direccion && Array.isArray(direccion.operacionesSoportadas)
    ? direccion.operacionesSoportadas.slice() : [];
  const dimensionesRequeridasPropias = new Set(Array.isArray(descriptor && descriptor.dimensions) ? descriptor.dimensions : []);
  const conceptos = grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [];
  const sujetos = conceptos
    .filter(c => c && c.activo !== false && c.autoridad === 'experto')
    .filter(c => !dimension || dimensionDeProcedencia(c.procedencia) === dimension)
    .map(c => ({
      subjectRef: idTemporalAReal[c.id] || c.id,
      evidenciaConceptoIds: [idTemporalAReal[c.id] || c.id],
      provenance: c.procedencia || null,
    }));
  // INFERRED_ONLY_BOOTSTRAP_OPEN_TARGET (C007 Machine Product Acceptance,
  // live-eval FRONTIER family, Daniel-adjudicated). GOVERNED_INFERENCE MAY
  // DEFINE AN OPEN TARGET, but MUST NOT BECOME A PRESUPPOSED FACT --
  // `sujetos` above stays 'experto'-only, unchanged: an 'inferido' concept
  // never grants factual subject authority. But when NO 'experto' subject
  // exists yet, a legitimately governed (already committed to the graph via
  // aplicarDelta -- never fabricated, never Producer-minted) 'inferido'
  // concept is not nothing either: candidatosCompatiblesConFrontera gates
  // this tier to needKind==='EXISTENCE' only (see below), which is exactly
  // the EXISTING, unmodified ASK_EXISTENCE vocabulary
  // (DecisorIntervencionConversacional.js: needKind 'EXISTENCE' ->
  // operator 'ASK_EXISTENCE', epistemicStatus 'OPEN_SEARCH' --
  // "explora si el target existe o aplica; no presupongas su existencia").
  // A presuppositional needKind (MECHANISM/DETAIL/EVIDENCE) anchored only to
  // an inferred concept is correctly excluded by that same gate -- this
  // tier never widens what ADMISSIBILITY_ENVELOPE already grants an expert
  // subject, it only opens the strictly narrower non-presuppositional door.
  const sujetosInferidosDurables = conceptos
    .filter(c => c && c.activo !== false && c.autoridad === 'inferido')
    .filter(c => !dimension || dimensionDeProcedencia(c.procedencia) === dimension)
    .map(c => ({
      subjectRef: idTemporalAReal[c.id] || c.id,
      evidenciaConceptoIds: [idTemporalAReal[c.id] || c.id],
      provenance: c.procedencia || null,
      // DURABLE_INFERIDO_KEEPS_STRICT_GATE (found via a real regression --
      // test_c007_stabilization_deterministic_replay_1.js). This entry has
      // NO corresponding hypothesisConceptIds entry -- Decision's
      // DECISION_HYPOTHESIS_TO_EXISTENCE downgrade never sees or acts on
      // it. candidatosCompatiblesConFrontera must therefore keep the
      // ORIGINAL needKind:'EXISTENCE'-only restriction for THIS sub-tier,
      // unchanged from before that adjudication -- widening admission here
      // without a Decision-side consumer would let a presuppositional
      // needKind reach governance unrecharacterized.
      origenAutoridad: 'DURABLE_INFERIDO',
    }));
  // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- the KNOWLEDGE-ineligible
  // (never durable, never in `conceptos` above) counterpart to
  // sujetosInferidosDurables: sourced from the caller's OWN already-real
  // (non-durable) id -- never re-derived, never fabricated here. Tagged
  // origenAutoridad:'CONVERSATIONAL_HYPOTHESIS' -- ONLY this sub-tier gets
  // the relaxed (any needKind) admission gate, because ONLY this sub-tier
  // has a matching entry in hypothesisConceptIds that Decision's
  // DECISION_HYPOTHESIS_TO_EXISTENCE downgrade actually consults.
  const idsYaIncluidos = new Set(sujetosInferidosDurables.map(s => s.subjectRef));
  const sujetosHipotesisAbierta = (Array.isArray(conceptosHipotesisAbierta) ? conceptosHipotesisAbierta : [])
    .filter(c => c && c.activo !== false && c.id && !idsYaIncluidos.has(c.id))
    .filter(c => !dimension || dimensionDeProcedencia(c.procedencia) === dimension)
    .map(c => ({ subjectRef: c.id, evidenciaConceptoIds: [c.id], provenance: c.procedencia || null, origenAutoridad: 'CONVERSATIONAL_HYPOTHESIS' }));
  const sujetosInferidos = sujetosInferidosDurables.concat(sujetosHipotesisAbierta);
  const desconocidosFuente = Array.isArray(semanticUnknowns) && semanticUnknowns.length > 0
    ? semanticUnknowns : (grafo && Array.isArray(grafo.incertidumbres) ? grafo.incertidumbres : []);
  const conocidos = desconocidosFuente
    .filter(u => u && typeof u === 'object' && (u.id || u.unknownId))
    // ACTIVE_FRONTIER_CONTAMINATION correction (C007,
    // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION,
    // Daniel-adjudicated, real evidence: logistica_c0 turns 13-22, session
    // live_complete_logistica_c0_11ec6033). MEMORY != ACTIVE_MISSION_
    // OBLIGATION. CROSS_GRAMMAR_OPEN_UNKNOWN != ACTIVE_GRAMMAR_EXECUTABLE_
    // OBLIGATION. RELEVANTE_FALSE != EXECUTABLE_FRONTIER_CANDIDATE. The
    // open + mission + relevance test is no longer re-spelled here -- it is
    // the ONE shared authority (SemanticUnknown.esObligacionActivaParaMision)
    // that CanonicalNextActState.executableUnknowns, needFromGovernedState
    // and the promotion boundary also consume. Real evidence:
    // semantic_unknown:4 (mission:"destino", relevante:false, left open by
    // the earlier closure-coordination fix) permanently occupied DESTILAR's
    // entire frontier, filtering out the Producer's OWN correctly-
    // dimensioned fresh proposal turn after turn. The predicate NEVER
    // mutates or deletes an unknown that fails it -- it stays fully
    // preserved, queryable graph memory (CROSS_GRAMMAR_MEMORY_REUSE !=
    // CROSS_GRAMMAR_OBLIGATION_INHERITANCE); it just stops being executable
    // territory for a turn whose active grammar it does not belong to, or
    // that was never promoted past candidate status. `u.mission` absent is
    // still admitted (legacy incertidumbre shapes that predate the field).
    .filter(u => esObligacionActivaParaMision(u, gramatica))
    // SATISFIED_DIMENSION_UNKNOWN_MUST_NOT_BLOCK_SIBLING_ACQUISITION
    // correction (found via this increment's own regression battery,
    // test_circulomejora006_five_grammar_e2e_1.js). candidatosCompatiblesConFrontera
    // requires strict identity-binding to an EXISTING_GOVERNED_UNKNOWN tier
    // entry -- so a same-mission, still-technically-open unknown whose OWN
    // dimension has SINCE become independently covered (e.g. a later,
    // unrelated turn supplied real evidence for that same dimension) would
    // otherwise keep monopolizing this turn's entire frontier and starve
    // every OTHER, genuinely still-pending required dimension -- the exact
    // same starvation this cluster closes, just same-grammar instead of
    // cross-grammar. Scoped narrowly via the authoritative owner
    // (GrafoProyeccion.dimensionesPendientes): only excludes when
    // `u.dimension` is itself one of THIS grammar's own declared required
    // dimensions AND that dimension is confirmed no longer pending. Any
    // other shape (no recorded dimension, a dimension outside this
    // grammar's own vocabulary, or a genuinely still-pending one) is left
    // completely untouched -- never mutates/deletes the unknown itself.
    .filter(u => {
      if (typeof u.dimension !== 'string' || !dimensionesRequeridasPropias.has(u.dimension)) return true;
      return dimensionesPendientesDeGrafo(grafo, gramatica).includes(u.dimension);
    })
    .map(u => {
      const refsConcepto = [...new Set([
        u.subjectRef,
        ...(Array.isArray(u.sobreConceptos) ? u.sobreConceptos : []),
      ].filter(Boolean))];
      const subjectRefAutorizado = refsConcepto.find(id => conceptos.some(c =>
        c && c.id === id && c.activo !== false && c.autoridad === 'experto')) || null;
      // Existing-unknown identity grounds an open search, not assertions or
      // detail/evidence questions about a concept. Only advertise those
      // operations when the unknown also carries an authorized concept
      // binding. Human semantic referents remain rationale, never IDs.
      const allowedOperations = subjectRefAutorizado
        ? operaciones
        : operaciones.filter(op => !['PRECISAR_REFERENTE', 'PEDIR_EJEMPLO'].includes(op));
      return {
      unknownRef: u.id || u.unknownId,
      // The unknown's OWN native mission dimension and the dimensions it
      // affects in the certified projection. missionNeedRef below is frontier/
      // territory bookkeeping that may fall back to a grammar-level
      // placeholder: it is never the unknown's dimension.
      unknownDimension: dimensionNativaDeDesconocido(u),
      unknownDimensionesAfectadas: dimensionesAfectadasPorDesconocido(u, conceptos),
      subjectRef: subjectRefAutorizado,
      // SemanticUnknown.operation describes the lifecycle/epistemic need;
      // it is not necessarily a conversational operation consumable by
      // Decision Authority.  Frontier entries advertise only the active
      // grammar's canonical executable vocabulary.
      operation: u.operation || u.operacion || null,
      allowedOperations,
      mission: gramatica,
      missionNeedRef: dimension || (direccion && direccion.unknownLifecycle && direccion.unknownLifecycle.dimension) || null,
      evidenciaConceptoIds: Array.isArray(u.evidenciaConceptoIds) ? u.evidenciaConceptoIds : [],
      provenance: u.provenance || null,
    };
    });
  // ADMISSIBLE_FRONTIER_BOOTSTRAP_GAP correction (Human Canary A, turn 1,
  // captured regression) -- PREEXISTING_GOVERNED_KNOWLEDGE IS NOT A
  // PRECONDITION FOR THE FIRST LEGITIMATE ACQUISITION. Before this
  // correction, `sujetos` empty (no durable 'experto' concept exists yet --
  // true by construction on the first turn of the first mission, which has
  // no predecessor grammar to inherit anchors from) collapsed the frontier
  // to [] even when `pendiente` was true, unconditionally rejecting every
  // candidate before any dimension/content check ever ran (demonstrated via
  // deterministic replay, see test_c007_human_canary_a_regression_1.js).
  // The correction adds exactly ONE more representable case, reusing the
  // SAME frontier shape/missionNeedRef semantics the other two cases
  // already use -- no parallel system, no fabricated concept, no durable
  // id, no knowledgeGraph write. `subjectRef`/`evidenciaConceptoIds` stay
  // empty -- OPEN_MISSION_NEED != GOVERNED FACT: this entry asserts only
  // that the pending need is admissible territory, never that any concept
  // already exists to anchor it.
  const frontier = conocidos.length > 0
    ? conocidos.map(u => ({ tipo: 'EXISTING_GOVERNED_UNKNOWN', ...u }))
    : !pendiente ? []
    : sujetos.length > 0 ? sujetos.map(s => ({
      tipo: 'ADMISSIBILITY_ENVELOPE',
      ...s,
      mission: gramatica,
      missionNeedRef: dimension || (direccion && direccion.unknownLifecycle && direccion.unknownLifecycle.dimension) || null,
      allowedOperations: operaciones,
    })) : sujetosInferidos.length > 0 ? sujetosInferidos.map(s => ({
      tipo: 'INFERRED_OPEN_TARGET',
      ...s,
      mission: gramatica,
      missionNeedRef: dimension || (direccion && direccion.unknownLifecycle && direccion.unknownLifecycle.dimension) || null,
      allowedOperations: operaciones,
    })) : [{
      tipo: 'BOOTSTRAP_MISSION_NEED',
      subjectRef: null,
      evidenciaConceptoIds: [],
      mission: gramatica,
      missionNeedRef: dimension || (direccion && direccion.unknownLifecycle && direccion.unknownLifecycle.dimension) || null,
      allowedOperations: operaciones,
    }];
  return frontier;
}

function candidatosCompatiblesConFrontera(parsed, frontera, idTemporalAReal = {}, grafo = null, mensajeUsuario = undefined) {
  if (!Array.isArray(frontera) || frontera.length === 0 || !parsed) return [];
  const oportunidades = normalizarOportunidadesConversacionales(
    parsed.oportunidadesConversacionales, idTemporalAReal,
  );
  const conceptos = grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [];
  const oportunidadesCompatibles = oportunidades.filter(o => {
    if (!o.idTemporal) return false;
    const anchors = Array.isArray(o.anclajeConceptoIds) ? o.anclajeConceptoIds : [];
    const soporte = o.satisfaccionConocimiento && Array.isArray(o.satisfaccionConocimiento.evidenciaConceptoIds)
      ? o.satisfaccionConocimiento.evidenciaConceptoIds.map(id => idTemporalAReal[id] || id) : [];
    const unknown = o.unknownId || o.semanticUnknownId || null;
    const epistemicStatus = o.epistemicStatus || null;
    if (typeof o.semanticTarget === 'string' && o.semanticTarget.trim() && !epistemicStatus) return false;
    if (epistemicStatus === 'SUPPORTED') {
      const sat = o.satisfaccionConocimiento;
      const grounded = sat && (sat.estado === 'SATISFECHA' || (Array.isArray(sat.evidenciaConceptoIds) && sat.evidenciaConceptoIds.length > 0));
      if (!grounded) return false;
    } else if (epistemicStatus && epistemicStatus !== 'OPEN_SEARCH' && epistemicStatus !== 'UNKNOWN') {
      return false;
    }
    // STALE_TEMPORAL_UNKNOWN_BINDING_SHORT_CIRCUIT (C007, Daniel-adjudicated,
    // faithful-replay-proven -- logistica_c0 turn 3). SAME_IDENTITY !=
    // SAME_TEMPORAL_STATE: `unknown` above (o.unknownId/semanticUnknownId) is
    // durable identity/provenance (v11 T3 comment above: "its id does not
    // disappear from the graph, only its estado/resuelta change") -- it is
    // NEVER mutated or stripped here. What changes is which frontier tiers
    // that identity is allowed to gate: construirFronteraCognitivaAdmisible
    // only ever emits an EXISTING_GOVERNED_UNKNOWN entry for an unknown that
    // is STILL open (conocidos filters resuelta===false) -- so a candidate
    // whose own referenced unknown was legitimately closed (e.g. by
    // reconciliation, same turn) can no longer find ANY frontier entry
    // offering that binding. R_RESUELTA != DERECHO_A_AVANZAR: a closed
    // unknown's identity alone grants no advancement authority by itself --
    // it only stops incorrectly BLOCKING the candidate from ordinary
    // admission through this turn's OTHER, current frontier tiers.
    // unknownBindingActive is TRUE only when this turn's CURRENT frontier
    // still offers an active EXISTING_GOVERNED_UNKNOWN entry for this EXACT
    // identity -- computed once against the whole frontier, never a single
    // entry's own (possibly different) unknownRef.
    const unknownBindingActive = !!(unknown && frontera.some(fEntry =>
      fEntry.tipo === 'EXISTING_GOVERNED_UNKNOWN' && fEntry.unknownRef === unknown));
    return frontera.some(f => {
      const ids = new Set([f.subjectRef, f.unknownRef, ...(f.evidenciaConceptoIds || [])].filter(Boolean));
      // Internal identity is never semantic WHAT.  Reject an opaque
      // unknown/subject/frontier id copied into semanticTarget before it can
      // reach Decision Authority.
      if (o.operacion !== 'PEDIR_EJEMPLO'
        && typeof o.semanticTarget === 'string' && ids.has(o.semanticTarget)) return false;
      // `operation` on an EXISTING_GOVERNED_UNKNOWN is lifecycle metadata;
      // only the active grammar's explicitly projected operation vocabulary
      // is executable by Decision Authority.
      const opAllowed = (f.allowedOperations || []).includes(o.operacion);
      const subjectBound = [...anchors, ...soporte].some(id => ids.has(id)
        || conceptos.some(c => c && c.id === id && f.subjectRef === c.id));
      const unknownBound = unknown && f.unknownRef === unknown;
      // EXISTING_GOVERNED_UNKNOWN's whole admission contract stays exactly
      // unknown-bound identity, unchanged, for every entry of that tier.
      if (f.tipo === 'EXISTING_GOVERNED_UNKNOWN') return Boolean(unknown && unknownBound && opAllowed);
      // A candidate whose own reference IS currently active on some OTHER
      // EXISTING_GOVERNED_UNKNOWN entry in this SAME frontier must never
      // "skip ahead" through a different, unrelated tier while that real
      // binding obligation is still live -- unchanged behavior for that case.
      if (unknownBindingActive) return false;
      // Reference absent, OR present but not currently active anywhere in
      // this turn's frontier (closed/stale): falls through to this tier's
      // OWN ordinary, completely unmodified admission rules below, exactly
      // as if no unknown reference existed at all. Never automatically
      // admitted merely because the reference used to be active.
      // INFERRED_ONLY_BOOTSTRAP_OPEN_TARGET / CONVERSATIONAL_HYPOTHESIS_
      // ELIGIBILITY -- structural admission here (opAllowed && subjectBound)
      // is the SAME test every other frontier tier uses; it says only "this
      // opportunity's operation is in the grammar's vocabulary and its
      // anchor resolves against this frontier entry." For a
      // CONVERSATIONAL_HYPOTHESIS-origin entry, that alone is enough: it
      // does NOT itself grant a presuppositional needKind
      // (MECHANISM/DETAIL/EVIDENCE) authority to presuppose the subject as
      // fact -- GOVERNED_INFERENCE MUST NOT BECOME A PRESUPPOSED FACT is
      // enforced downstream, at the single existing owner that turns
      // admissible state into the final executable act
      // (needFromGovernedState, DecisorIntervencionConversacional.js),
      // which recharacterizes a presuppositional needKind into
      // ASK_EXISTENCE over the SAME target -- never in place, never
      // mutating this opportunity object. A DURABLE_INFERIDO-origin entry
      // has no matching hypothesisConceptIds entry for Decision to act on
      // (found via a real regression -- test_c007_stabilization_
      // deterministic_replay_1.js), so it keeps the ORIGINAL, unwidened
      // needKind:'EXISTENCE'-only restriction, unchanged.
      if (f.tipo === 'INFERRED_OPEN_TARGET' && f.origenAutoridad !== 'CONVERSATIONAL_HYPOTHESIS'
        && o.needKind !== 'EXISTENCE') return false;
      // BOOTSTRAP_MISSION_NEED_ADMISSION (C007, Daniel-adjudicated, traced
      // end to end -- real evidence: logistica_c0's live trial). This
      // tier's own ids are permanently empty by design (subjectRef:null,
      // evidenciaConceptoIds:[]) -- OPEN_MISSION_NEED != GOVERNED_FACT,
      // there is nothing to bind to yet, that is the whole point of
      // "territory only". The generic opAllowed && subjectBound test can
      // therefore never pass here (confirmed directly: a textbook
      // needKind:EXISTENCE oportunidad with correctly-empty anchors
      // produced zero compatibles under the unmodified check) -- this
      // frontier tier was structurally inert since ADMISSIBLE_FRONTIER_
      // BOOTSTRAP_GAP only ever made it non-EMPTY, never ADMISSIBLE. This
      // clause does NOT admit "bootstrap && opAllowed" (too broad -- see
      // the Daniel-adjudicated architectural review that required this
      // narrower contract). It requires the EXACT shape the two OTHER
      // existing owners already presuppose for a first-acquisition
      // candidate, never inventing a new authority test:
      //   - operacion === 'ABRIR_COMO': the ONLY operation the existing
      //     post-selection materialization mechanism (below, ~line 7518,
      //     `oportunidadSeleccionadaGobernada.operacion === 'ABRIR_COMO'`)
      //     ever converts into a durable SemanticUnknown -- PRECISAR_
      //     REFERENTE/PEDIR_EJEMPLO both presuppose existing material to
      //     precisify or exemplify, neither makes sense over nothing.
      //   - satisfaccionConocimiento.estado === 'ABIERTA': genuinely open,
      //     non-presuppositional -- SATISFECHA/PARCIAL would presuppose
      //     resolved or partial knowledge that cannot exist yet.
      //   - semanticTarget AND referenteSemantico both present: the exact
      //     precondition the SAME materialization mechanism already
      //     requires (line ~7516-7517) -- real, literal descriptive
      //     content must exist, not an empty shell.
      // Traced directly (DecisorIntervencionConversacional.js,
      // needFromGovernedState, UNMODIFIED): a candidate of this exact
      // shape already derives kind:'EXISTENCE' -> operator:'ASK_EXISTENCE',
      // epistemicStatus:'OPEN_SEARCH' on its own -- zero Decision changes
      // needed, zero new ontology, reuses the SAME already-certified
      // hypothesis->ASK_EXISTENCE law end to end.
      if (f.tipo === 'BOOTSTRAP_MISSION_NEED') {
        // BOOTSTRAP_TARGET_USER_GROUNDING (Daniel-adjudicated correction --
        // the structural shape alone (operacion/estado/non-empty strings)
        // is NOT authority; a non-empty Producer-written string is still
        // free-form text, not evidence. PRODUCER FREE-FORM TEXT DOES NOT
        // CREATE CONTRACTUAL AUTHORITY. Reuses the SAME extractive-grounding
        // machinery that already governs "experto"-authority concept
        // descriptions (contenidoEsExtractivo, GrafoConocimientoPolicy.js)
        // -- never a new authority system: `referenteSemantico` (the
        // CONCRETE REFERENT this act would ask about) must be literally
        // locatable in the expert's own message this turn, exactly the
        // same cheap, deterministic, no-language-understanding-required
        // test already certified elsewhere. `semanticTarget`/proposicion
        // (the UNKNOWN/gap itself) is deliberately NOT held to this test --
        // by definition an unknown gap cannot already be verbatim in the
        // user's own words (if it were, it would not be unknown); only the
        // REFERENT being asked about needs grounding, never the question.
        return o.operacion === 'ABRIR_COMO'
          && o.satisfaccionConocimiento && o.satisfaccionConocimiento.estado === 'ABIERTA'
          && typeof o.semanticTarget === 'string' && o.semanticTarget.trim()
          && typeof o.referenteSemantico === 'string' && o.referenteSemantico.trim()
          && contenidoEsExtractivo(o.referenteSemantico, mensajeUsuario);
      }
      return opAllowed && subjectBound;
    });
  });
  const evaluacion = parsed.evaluacionGanancia;
  const satisfaccion = evaluacion && evaluacion.satisfaccionConocimiento;
  const gainCompleto = typeof parsed.gananciaCognitiva === 'string' && parsed.gananciaCognitiva.trim()
    && evaluacion && typeof evaluacion === 'object'
    && ['NUEVA_COMPRENSION', 'NO_PROPUESTA'].includes(evaluacion.resultado)
    && satisfaccion && typeof satisfaccion === 'object'
    && ['SATISFECHA', 'PARCIAL', 'ABIERTA'].includes(satisfaccion.estado)
    && Array.isArray(satisfaccion.evidenciaConceptoIds);
  const gainCompatible = gainCompleto && frontera.some(f => {
    const ids = new Set([f.subjectRef, f.unknownRef, ...(f.evidenciaConceptoIds || [])].filter(Boolean));
    return satisfaccion.evidenciaConceptoIds.some(id => ids.has(idTemporalAReal[id] || id));
  });
  // Gain and an interrogative opportunity are independent admissible
  // candidates.  A supported gain must not erase a simultaneously valid
  // opportunity before Decision Authority gets the governed state.
  return [
    ...(gainCompatible ? [{ tipo: 'GANANCIA_COGNITIVA' }] : []),
    ...oportunidadesCompatibles,
  ];
}

function validarBusquedaActoCognitivo(parsed, {
  grafo = null, gramatica = null, slots = {}, dimension = null,
} = {}) {
  const busqueda = parsed && parsed.busquedaActoCognitivo;
  if (!busqueda || typeof busqueda !== 'object' || Array.isArray(busqueda)) {
    return { valido: false, razon: 'BUSQUEDA_ACTO_COGNITIVO_AUSENTE' };
  }
  if (!['CANDIDATO_PROPUESTO', 'NINGUNO_LEGITIMO'].includes(busqueda.resultado)) {
    return { valido: false, razon: 'BUSQUEDA_ACTO_COGNITIVO_RESULTADO_INVALIDO' };
  }
  if (busqueda.resultado === 'CANDIDATO_PROPUESTO'
    && busqueda.bloqueoNoActo != null) return { valido: false, razon: 'CANDIDATO_PROPUESTO_CON_BLOQUEO' };
  const oportunidadesValidas = normalizarOportunidadesConversacionales(
    parsed.oportunidadesConversacionales,
  );
  const evaluacionGanancia = parsed.evaluacionGanancia;
  const satisfaccionGanancia = evaluacionGanancia && evaluacionGanancia.satisfaccionConocimiento;
  const residuoGanancia = satisfaccionGanancia && satisfaccionGanancia.residuoSemantico;
  const idsOportunidades = new Set(oportunidadesValidas
    .map(o => o && o.idTemporal).filter(Boolean));
  const gananciaValida = typeof parsed.gananciaCognitiva === 'string'
    && parsed.gananciaCognitiva.trim()
    && evaluacionGanancia && typeof evaluacionGanancia === 'object'
    && ['NUEVA_COMPRENSION', 'NO_PROPUESTA'].includes(evaluacionGanancia.resultado)
    && satisfaccionGanancia && typeof satisfaccionGanancia === 'object'
    && ['SATISFECHA', 'PARCIAL', 'ABIERTA'].includes(satisfaccionGanancia.estado)
    && Array.isArray(satisfaccionGanancia.evidenciaConceptoIds)
    // RESPONSE_VERDICT_MATERIAL_NOT_NEXT_ACT_GAIN (C007) -- defense-in-depth,
    // deterministic evidence discipline. The Producer's own contract
    // (AgoraPrompts.js) already requires a claimed gain to be "respaldada
    // por evidencia autorizada" -- a SATISFECHA claim with ZERO cited
    // evidenciaConceptoIds contradicts that label on its face (real
    // evidence: turn 24, "NUEVA_COMPRENSION"/"SATISFECHA" with
    // evidenciaConceptoIds:[] was nothing but a paraphrase of the expert's
    // acceptance of the previous closure act, not domain knowledge). This
    // does NOT touch PARCIAL (already gated by its own residuoGanancia
    // requirement below, independent of evidence count) or ABIERTA
    // (legitimately open, nothing claimed as fully supported yet) -- only
    // SATISFECHA, which by definition asserts full support.
    && (satisfaccionGanancia.estado !== 'SATISFECHA' || satisfaccionGanancia.evidenciaConceptoIds.length > 0)
    && (satisfaccionGanancia.estado !== 'PARCIAL'
      || (residuoGanancia && typeof residuoGanancia === 'object'
        && typeof residuoGanancia.semanticTarget === 'string'
        && typeof residuoGanancia.referenteSemantico === 'string'
        && typeof (residuoGanancia.operation || residuoGanancia.operacion) === 'string'
        && typeof residuoGanancia.oportunidadRef === 'string'
        && idsOportunidades.has(residuoGanancia.oportunidadRef)));
  const tieneCandidato = oportunidadesValidas.length > 0 || !!gananciaValida;
  if (busqueda.resultado === 'CANDIDATO_PROPUESTO' && !tieneCandidato) {
    return {
      valido: false,
      // A concept, relation, SemanticUnknown or pre-existing anchor can
      // ground a candidate, but is not itself a candidate.  Admitting this
      // shape until post-governance creates a repair contract with no frozen
      // WHAT to rebind.  The bounded producer retry must repair the same
      // proposal before any governance mutation instead.
      recuperablePostGobernanza: false,
      underreachSinBaseGobernable: true,
      razon: 'CANDIDATO_PROPUESTO_SIN_CANDIDATO',
    };
  }
  if (busqueda.resultado === 'NINGUNO_LEGITIMO' && tieneCandidato) {
    return { valido: false, razon: 'NINGUNO_LEGITIMO_CON_CANDIDATO' };
  }
  if (busqueda.resultado === 'NINGUNO_LEGITIMO'
    && (typeof busqueda.razon !== 'string' || !busqueda.razon.trim())) {
    return { valido: false, razon: 'NINGUNO_LEGITIMO_SIN_RAZON' };
  }
  if (busqueda.resultado === 'NINGUNO_LEGITIMO') {
    const bloqueosValidos = ['SIN_REFERENTE_AUTORIZADO', 'SIN_NECESIDAD_COGNITIVA_ABIERTA', 'SIN_DIRECCION_EPISTEMICAMENTE_LEGITIMA'];
    if (!bloqueosValidos.includes(busqueda.bloqueoNoActo)) return { valido: false, razon: 'BLOQUEO_NO_ACTO_INVALIDO' };
    // Negative search outcomes are proposals/diagnostics only.  The common
    // frontier, computed after evidence governance, owns the right to stop;
    // do not let a global expert-concept proxy or free blocker govern flow.
  }
  return { valido: true, razon: null };
}

// PRODUCER_REFERENTIAL_INTEGRITY (C007 human canary v8) — common,
// deterministic, COMMON_CORE structural check. validarContratoPorEstado
// and validarFormaConceptosNuevos already confirm the producer's JSON is
// well-shaped; neither ever confirmed that a concept ID an authoritative
// field CITES actually resolves to something real. CAPA1_SCHEMA_VALID_CONCEPT
// != STRUCTURALLY_GOVERNABLE_CONCEPT: the native schema forces
// oportunidadesConversacionales[].anclajeConceptoIds and both flavors of
// satisfaccionConocimiento.evidenciaConceptoIds to exist, but conceptosNuevos
// itself is never schema-required — a producer can legally emit a populated
// anchor/evidence array while never declaring the concept(s) it names.
//
// PRODUCER_OUTPUT_ACCEPTED -> MUST_BE_REPRESENTABLE_BY_NEXT_GOVERNANCE_BOUNDARY.
// PRODUCER_REFERENCE -> MUST_RESOLVE_BEFORE_GOVERNANCE. A concept ID
// resolves legitimately against exactly two universes:
//   A. a durable/preexisting concept already in `grafo` — including a
//      concept THIS SAME TURN's own reconciliación/earlier governance
//      already materialized and mapped via `idTemporalAReal` (the SAME
//      temporal->durable mapping every other consumer in this file already
//      resolves through — CURRENT_TURN_GROUNDED_EVIDENCE/Certification8's
//      bootstrap depends on exactly this: reconciliación recovers a concept
//      under its own idTemporal, and the producer may cite that same
//      temporal id without redeclaring it).
//   B. this SAME output's own conceptosNuevos[].idTemporal.
// Anything else is a DANGLING_REFERENCE, never treated as
// EMPTY_COGNITIVE_TERRITORY: a producer that legitimately finds nothing
// (NINGUNO_LEGITIMO, or an opportunity/gain that never cites a concept ID
// at all) is never flagged here — this only rejects a producer that
// DECLARES authority over an ID it never defined and that never already
// existed. Nothing here fabricates the missing concept from semanticTarget/
// mensaje/opportunity text — no downstream rescue is authorized to invent
// the missing declaration; the producer must either declare the concept or
// cite a real durable identity.
//
// Scope is deliberately narrow to the ONE authoritative concept-ID field
// with no existing downstream recovery path of its own:
// evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds — never a
// global "every string ending in Id" sweep, and never
// relacionRespuestaDirigida.conceptosQueAtienden (already has its own
// dedicated, narrower repair mechanism — REPARACION_ESTRUCTURAL_RESPUESTA_DIRIGIDA,
// above — duplicating it here would double-govern the same field).
//
// oportunidadesConversacionales[].anclajeConceptoIds (and its nested
// satisfaccionConocimiento.evidenciaConceptoIds) are DELIBERATELY EXCLUDED
// here, confirmed by a real regression this check broke before this
// exclusion existed: a producer MAY legitimately propose an opportunity
// anchored to an id that is not yet durable NOR in this output's own
// conceptosNuevos, when the active turn's frontier is genuinely non-empty —
// debeRepararCandidatoEnFrontera (above) and the PROPUESTA_COGNITIVA_POST_GOBERNANZA/
// REBIND_ESTRUCTURAL_POST_GOBERNANZA repair calls (further down this same
// producer loop) are the EXISTING, CERTIFIED mechanism that resolves that
// exact case against the REAL governed frontier once it's computed — this
// function runs too early to distinguish "will legitimately rebind" from
// "permanently dangling", and gating escalation on that same later frontier
// state (debeRepararCandidatoEnFrontera itself requires estadoFrontera ===
// 'EVALUATED_NONEMPTY') is exactly why that path never rescues v8's case:
// v8's frontier evaluated EMPTY, so nothing downstream could ever have
// repaired it — the gain's own dangling evidence is what this function
// exists to catch there, and it does.
function validarIntegridadReferencialRepresentacionProductor(parsed, { grafo = null, idTemporalAReal = {} } = {}) {
  if (!parsed || typeof parsed !== 'object') return { valido: true, referenciasInvalidas: [] };
  const idsDurables = new Set(
    (grafo && Array.isArray(grafo.conceptos) ? grafo.conceptos : [])
      .filter(c => c && typeof c.id === 'string' && c.id)
      .map(c => c.id),
  );
  const idsMismoOutput = new Set(
    (Array.isArray(parsed.conceptosNuevos) ? parsed.conceptosNuevos : [])
      .filter(c => c && typeof c.idTemporal === 'string' && c.idTemporal.trim())
      .map(c => c.idTemporal),
  );
  const mapa = idTemporalAReal || {};
  const resuelve = (id) => {
    const idMapeado = Object.prototype.hasOwnProperty.call(mapa, id) ? mapa[id] : id;
    return idsDurables.has(idMapeado) || idsDurables.has(id) || idsMismoOutput.has(id);
  };
  const referenciasInvalidas = [];
  const registrar = (etiqueta, ids) => {
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      if (typeof id === 'string' && id.trim() && !resuelve(id)) referenciasInvalidas.push(`${etiqueta}: "${id}" no resuelve contra un concepto durable del grafo (directo o vía idTemporalAReal) ni contra conceptosNuevos de este mismo output`);
    });
  };
  registrar('evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds',
    parsed.evaluacionGanancia && parsed.evaluacionGanancia.satisfaccionConocimiento
      && parsed.evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds);
  // C007 — RESIDUE CONTINUATION + OPPORTUNITY REFERENTIAL INTEGRITY (human
  // canary v11 T3). oportunidadesConversacionales[].unknownId/semanticUnknownId
  // is a DIFFERENT identity space than conceptosNuevos: unlike concepts, the
  // schema gives the producer no way to declare a brand-new unknown's id in
  // this same output — a new unknown is always backend-materialized later
  // (materializarSemanticUnknown, from the opportunity's own semanticTarget/
  // referenteSemantico), never assigned by the producer itself. So the only
  // admissible domain for a NON-NULL value here is a durable, already-
  // governed unknown already in `grafo.incertidumbres` (this legitimately
  // includes the very unknown a directed response just resolved THIS turn —
  // its id does not disappear from the graph, only its estado/resuelta
  // change — so a typed residue opportunity anchored to that same parent
  // unknown, per evaluarNovedadOportunidadTrasRespuestaDirigida, resolves
  // here without issue). A genuinely new, not-yet-materialized target has no
  // legitimate value to put here other than null/absent — a producer that
  // fabricates a placeholder string ("unknown1", "foo", ...) instead is a
  // DANGLING_REFERENCE, never EMPTY_COGNITIVE_TERRITORY: this is exactly the
  // v11 T3 defect (unknownId:"unknown1" sailed through ungoverned into an
  // EVALUATED_EMPTY frontier instead of being rejected here as REPRESENTACION
  // invalid, which is what correctly escalates to PRODUCER_CAPABILITY_FAILURE
  // via the same mechanism evidenciaConceptoIds above already uses).
  const idsUnknownsDurables = new Set(
    (grafo && Array.isArray(grafo.incertidumbres) ? grafo.incertidumbres : [])
      .filter(u => u && typeof u.id === 'string' && u.id)
      .map(u => u.id),
  );
  // DANGLING_UNKNOWN_REF_IS_OPTIONAL_FIELD_NOT_REQUIRED_DEPENDENCY (C007
  // Machine Product Acceptance, live-eval FRONTIER family, Daniel-
  // adjudicated). unknownId/semanticUnknownId remains exactly what the v11
  // T3 comment above documents: a producer has no legitimate way to mint
  // one, so a dangling value is NEVER treated as a real reference (PRODUCER
  // MAY NOT MINT A DURABLE UNKNOWN REFERENCE, unchanged, still enforced --
  // this never lets a fabricated id survive as a target). What changes:
  // candidatosCompatiblesConFrontera's OWN existing logic already proves
  // this field is OPTIONAL for a standard ABRIR_COMO/MECHANISM opportunity
  // -- `if (unknown) return unknownBound && opAllowed; return opAllowed &&
  // subjectBound;` -- an opportunity with unknownId/semanticUnknownId
  // absent is governed via subjectBound alone, exactly the same as one
  // that never had a real unknown to reference yet (the ordinary case:
  // materializarSemanticUnknown mints it fresh AFTER governance, later).
  // So a DANGLING reference is exactly as governable as an ABSENT one --
  // neither claims authority the field can't back up -- it is only ever a
  // REQUIRED dependency for EXISTING_GOVERNED_UNKNOWN-typed continuations,
  // which by definition can only exist when grafo.incertidumbres is
  // non-empty (nothing to continue on a fresh/empty graph) and are handled
  // by their own, separate, unmodified owner
  // (evaluarNovedadOportunidadTrasRespuestaDirigida, per the v11 T3 comment
  // above). Strip the dangling value (never silently invent one, never
  // widen the durable set) rather than reject the whole representation --
  // INVALID_REPRESENTATIONAL_FIELD != INVALID_SEMANTIC_CANDIDATE when that
  // field is not required. The opportunity must still independently pass
  // every OTHER check (subjectBound, novelty, elegibility, referential
  // integrity of its OWN concept anchors, above) unchanged -- stripping
  // grants no authority, it only removes an illegitimate claim so the rest
  // can be judged on its own merits.
  let oportunidadesSaneadas = parsed.oportunidadesConversacionales;
  let huboSaneamientoDeUnknownRef = false;
  if (Array.isArray(parsed.oportunidadesConversacionales)) {
    oportunidadesSaneadas = parsed.oportunidadesConversacionales.map((oportunidad) => {
      if (!oportunidad || typeof oportunidad !== 'object') return oportunidad;
      let copia = oportunidad;
      ['unknownId', 'semanticUnknownId'].forEach((campo) => {
        const valor = oportunidad[campo];
        if (typeof valor === 'string' && valor.trim() && !idsUnknownsDurables.has(valor)) {
          if (copia === oportunidad) copia = { ...oportunidad };
          copia[campo] = null;
          huboSaneamientoDeUnknownRef = true;
        }
      });
      return copia;
    });
  }
  const parsedSaneado = huboSaneamientoDeUnknownRef
    ? { ...parsed, oportunidadesConversacionales: oportunidadesSaneadas }
    : parsed;
  return { valido: referenciasInvalidas.length === 0, referenciasInvalidas, parsedSaneado };
}

// CONTENT_CLOSURE_REPAIR -- structural companion to
// validarIntegridadReferencialRepresentacionProductor. Its own
// referenciasInvalidas entries are always of the exact form
// `${etiqueta}: "${id}" no resuelve...` (see `registrar` above, the single
// producer of every entry) -- extracting the id here is a pure, mechanical
// re-read of that same, controlled string, never a second source of truth.
function extraerIdsColgantesDeReferenciasInvalidas(referenciasInvalidas) {
  const ids = new Set();
  (Array.isArray(referenciasInvalidas) ? referenciasInvalidas : []).forEach((entry) => {
    const m = typeof entry === 'string' && entry.match(/: "([^"]+)" no resuelve/);
    if (m) ids.add(m[1]);
  });
  return [...ids];
}

// COMPLETE_PRODUCER_CORRECTION_FEEDBACK (C007,
// DIRECTED_RESPONSE_ATTEMPT_REPAIR_AUTHORITY_CONTINUITY). The producer loop's
// validators are staged (each runs only while the previous passed), so a
// single Producer output carrying SEVERAL independently-detectable
// structural defects used to be corrected ONE defect at a time -- and each
// retry could fix the one it was told about by dropping what the next stage
// needed (real evidence, logistica_c1 turn 16: a retry told only "n1/n2
// dangling" declared n1/n2 but dropped the directed relation; the next retry
// told only "relation missing" restored the relation but dropped n1/n2 ...
// across both executor budgets, never converging). This pure function lists
// EVERY structural defect that can be detected from one representation, in
// one pass, with the very same validators the loop uses:
//   - conceptosNuevos shape            (validarFormaConceptosNuevos)
//   - same-batch id integrity           (validarIntegridadReferencialRepresentacionProductor)
//   - delta governance errors           (aplicarDelta dry run, no state is kept)
//   - the directed-response relation    (listarDefectosRelacionRespuestaDirigida,
//                                        when a frozen previous act governs this turn)
// FEEDBACK_IS_NOT_AUTHORITY: the list only describes what is wrong; it
// invents no concept, no id and no wording, and the corrected output goes
// through the unchanged validators again.
function detectarDefectosEstructuralesProductor(parsed, {
  grafo = null, grafoGobernanza = null, idTemporalAReal = {}, contratoRespuestaDirigida = null, mensajeUsuario = '',
  incertidumbreObjetivoResuelta = false,
} = {}) {
  if (!parsed || typeof parsed !== 'object') return [];
  const defectos = [];
  const agregar = (mensaje) => {
    if (typeof mensaje === 'string' && mensaje.trim() && !defectos.includes(mensaje)) defectos.push(mensaje);
  };
  validarFormaConceptosNuevos(parsed).forEach(agregar);
  validarIntegridadReferencialRepresentacionProductor(parsed, { grafo, idTemporalAReal })
    .referenciasInvalidas.forEach(agregar);
  const grafoParaGobernanza = grafoGobernanza || grafo;
  if (grafoParaGobernanza && Array.isArray(grafoParaGobernanza.conceptos)
    && (Array.isArray(parsed.conceptosNuevos) || Array.isArray(parsed.relacionesNuevas))) {
    const secoGobernanza = aplicarDelta(grafoParaGobernanza, deltaAditivoDesdeParsed({ ...parsed, relacionRespuestaDirigida: null }), {
      mensajeUsuario, turnoOrigenId: null, actoCognitivoVisible: null, relacionRespuestaDirigida: null,
    });
    (secoGobernanza.errores || []).forEach(agregar);
  }
  if (contratoRespuestaDirigida) {
    const conceptosDeclarados = Array.isArray(parsed.conceptosNuevos) ? parsed.conceptosNuevos.filter(Boolean) : [];
    const defectosRelacion = listarDefectosRelacionRespuestaDirigida({
      relacionDeclarada: parsed.relacionRespuestaDirigida, mensajeUsuario, contrato: contratoRespuestaDirigida,
      conceptosNuevosEsteTurno: conceptosDeclarados, dimensionDeProcedencia, incertidumbreObjetivoResuelta,
    });
    defectosRelacion.forEach(d => agregar(d.motivo));
    if (defectosRelacion.length === 0 && contratoRespuestaDirigida.viaAcceso) {
      const resultadoVia = parsed.resultadoViaAcceso;
      const viaValida = resultadoVia
        && resultadoVia.viaAcceso === contratoRespuestaDirigida.viaAcceso
        && ['DISPONIBLE', 'NO_DISPONIBLE', 'NO_APLICA'].includes(resultadoVia.estado);
      if (!viaValida) agregar('resultadoViaAcceso ausente o inválido para la vía contratada');
    }
  }
  return defectos;
}

// Companion instruction for the correction text built from the list above.
// States the cross-field consistency the Producer must restore ALL AT ONCE
// when same-batch support is involved; it prescribes no content.
const CORRECCION_SOPORTE_MISMA_SALIDA = '; CORRIGE TODOS LOS DEFECTOS LISTADOS A LA VEZ, en una única salida completa, sin resolver uno a costa de reintroducir otro. Un id temporal (el idTemporal que tú asignas a un concepto de esta salida) citado en evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds o en relacionRespuestaDirigida.conceptosQueAtienden solo existe si lo declaras en conceptosNuevos de ESTA misma salida con su idTemporal, tipo, descripcion literal del experto, autoridad y procedencia; si tu respuesta depende de conceptos frescos, decláralos en conceptosNuevos y referencia sus idTemporal exactos, y mantén consistentes entre sí los conceptos declarados, la relación de respuesta dirigida y la evidencia de la ganancia. Usa únicamente lo que el experto dijo en este turno; no inventes contenido';

// REPAIR_HANDOFF_NORMALIZES_GAIN_SUPPORT_IDENTITIES -- pure rewrite of the
// dependent REFERENCE fields of ONE repaired candidate from the temporal ids
// of its own batch to the canonical ids aplicarDelta assigned:
//   - evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds
//   - oportunidadesConversacionales[].anclajeConceptoIds / subjectRef /
//     satisfaccionConocimiento.evidenciaConceptoIds
//   - relacionRespuestaDirigida.conceptosQueAtienden
//   - rolesTransformacionales[].conceptoId
// Declarations (conceptosNuevos[].idTemporal) and relacionesNuevas (already
// applied by that same aplicarDelta) are deliberately NOT touched. Ids the
// map does not know are left exactly as they were: a still-dangling id must
// stay visible to the next validator, never be silently dropped or replaced.
function normalizarReferenciasTemporalesDeCandidatoReparado(parsed, mapa = {}) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const resolver = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(mapa, id) && mapa[id]) || id;
  const resolverLista = (ids) => (Array.isArray(ids) ? [...new Set(ids.map(resolver))] : ids);
  const salida = { ...parsed };
  const evaluacion = parsed.evaluacionGanancia;
  if (evaluacion && evaluacion.satisfaccionConocimiento
    && Array.isArray(evaluacion.satisfaccionConocimiento.evidenciaConceptoIds)) {
    salida.evaluacionGanancia = {
      ...evaluacion,
      satisfaccionConocimiento: {
        ...evaluacion.satisfaccionConocimiento,
        evidenciaConceptoIds: resolverLista(evaluacion.satisfaccionConocimiento.evidenciaConceptoIds),
      },
    };
  }
  if (Array.isArray(parsed.oportunidadesConversacionales)) {
    salida.oportunidadesConversacionales = parsed.oportunidadesConversacionales.map((o) => {
      if (!o || typeof o !== 'object') return o;
      const copia = { ...o };
      if (Array.isArray(o.anclajeConceptoIds)) copia.anclajeConceptoIds = resolverLista(o.anclajeConceptoIds);
      if (typeof o.subjectRef === 'string') copia.subjectRef = resolver(o.subjectRef);
      if (o.satisfaccionConocimiento && Array.isArray(o.satisfaccionConocimiento.evidenciaConceptoIds)) {
        copia.satisfaccionConocimiento = {
          ...o.satisfaccionConocimiento,
          evidenciaConceptoIds: resolverLista(o.satisfaccionConocimiento.evidenciaConceptoIds),
        };
      }
      return copia;
    });
  }
  if (parsed.relacionRespuestaDirigida && typeof parsed.relacionRespuestaDirigida === 'object'
    && Array.isArray(parsed.relacionRespuestaDirigida.conceptosQueAtienden)) {
    salida.relacionRespuestaDirigida = {
      ...parsed.relacionRespuestaDirigida,
      conceptosQueAtienden: resolverLista(parsed.relacionRespuestaDirigida.conceptosQueAtienden),
    };
  }
  if (Array.isArray(parsed.rolesTransformacionales)) {
    salida.rolesTransformacionales = parsed.rolesTransformacionales.map(role => (
      role && typeof role === 'object' && typeof role.conceptoId === 'string'
        ? { ...role, conceptoId: resolver(role.conceptoId) } : role));
  }
  return salida;
}

// REPAIRED_DIRECTED_RESPONSE_MUST_PASS_NORMAL_VALIDATION -- the SAME
// validation the ordinary producer loop applies to a directed response
// (validarRelacionRespuestaDirigida + the contracted access-route check +
// proyectarAlineacionRespuestaDirigida), factored for a repaired candidate:
// the "concepts new this turn" are read from the graph the repair produced,
// each carried under BOTH its temporal and its canonical id so a relation
// citing either form is judged by the same rule. Returns the verdict and the
// two trace projections the turn consumes (relacionRespuestaDirigidaTraza /
// alineacionRespuestaDirigidaResultadoTraza). With no frozen previous act
// there is nothing to govern: { aplica:false, valido:true }.
function gobernarRelacionDirigidaDeCandidatoReparado({
  parsed, grafoReparado, grafoAntesDelTurno, idTemporalAReal = {},
  contratoRespuestaDirigida = null, mensajeUsuario = '',
} = {}) {
  if (!contratoRespuestaDirigida) {
    return { aplica: false, valido: true, validacion: { valido: true, motivo: null }, relacionTraza: null, alineacionTraza: null };
  }
  const idsAntes = new Set(((grafoAntesDelTurno && grafoAntesDelTurno.conceptos) || []).map(c => c.id));
  const conceptosNuevosEsteTurno = [];
  ((grafoReparado && grafoReparado.conceptos) || []).filter(c => !idsAntes.has(c.id)).forEach((concepto) => {
    const temporales = Object.entries(idTemporalAReal || {}).filter(([, real]) => real === concepto.id);
    temporales.forEach(([idTemporal]) => conceptosNuevosEsteTurno.push({ ...concepto, idTemporal }));
    conceptosNuevosEsteTurno.push(concepto);
  });
  const relacionDeclarada = parsed && parsed.relacionRespuestaDirigida;
  const incertidumbreObjetivoResuelta = contratoRespuestaDirigida.deudaTipo === 'INCERTIDUMBRE_RELEVANTE_ABIERTA'
    && Array.isArray(grafoReparado && grafoReparado.incertidumbres)
    && grafoReparado.incertidumbres.some(u => u.id === contratoRespuestaDirigida.deudaIdentidad && u.resuelta === true);
  let validacion = validarRelacionRespuestaDirigida({
    relacionDeclarada, mensajeUsuario, contrato: contratoRespuestaDirigida,
    conceptosNuevosEsteTurno, dimensionDeProcedencia, incertidumbreObjetivoResuelta,
  });
  if (validacion.valido && contratoRespuestaDirigida.viaAcceso) {
    const resultadoVia = parsed.resultadoViaAcceso;
    const viaValida = resultadoVia
      && resultadoVia.viaAcceso === contratoRespuestaDirigida.viaAcceso
      && ['DISPONIBLE', 'NO_DISPONIBLE', 'NO_APLICA'].includes(resultadoVia.estado);
    if (!viaValida) validacion = { valido: false, motivo: 'resultadoViaAcceso ausente o inválido para la vía contratada' };
  }
  const relacionTraza = relacionDeclarada
    ? {
        ...relacionDeclarada,
        unknownId: contratoRespuestaDirigida.unknownId || null,
        desconocidoPreguntableScoped: contratoRespuestaDirigida.desconocidoPreguntableScoped || null,
        resultadoViaAcceso: (parsed && parsed.resultadoViaAcceso) || null,
      }
    : null;
  const alineacionTraza = proyectarAlineacionRespuestaDirigida({
    contrato: contratoRespuestaDirigida,
    relacionDeclarada: relacionDeclarada
      ? {
          ...relacionDeclarada,
          satisfaccionReparacion: relacionDeclarada.satisfaccionReparacion
            ? {
                ...relacionDeclarada.satisfaccionReparacion,
                materialIds: (relacionDeclarada.satisfaccionReparacion.materialIds || [])
                  .map(id => (idTemporalAReal && Object.prototype.hasOwnProperty.call(idTemporalAReal, id))
                    ? idTemporalAReal[id] : null),
              }
            : null,
        }
      : null,
    validacion,
  });
  return { aplica: true, valido: validacion.valido, validacion, relacionTraza, alineacionTraza };
}

// CONTENT_CLOSURE_REPAIR -- the existing repair architecture's NEW third
// outcome, alongside STRUCTURAL_REBIND (rebinds a candidate to an EXISTING
// frontier entry) and PROPUESTA_COGNITIVA_POST_GOBERNANZA (re-proposes the
// WHAT, explicitly forbidden from declaring conceptos). Neither existing
// path can close a same-output dangling reference to a genuinely NEW id:
// rebind has nothing existing to select (no durable/frontier entry can
// possibly correspond to a Producer-invented temporal id), and proposta is
// deliberately barred from creating concepts. This is that missing,
// narrowly-scoped third outcome -- it may PROPOSE a closing declaration for
// EXACTLY the dangling id(s) a REJECTED representation already cited,
// nothing else, and every invariant this session has already certified
// still governs what happens to that proposal:
//   - WHAT stays frozen (candidato.parsed's own operacion/semanticTarget/
//     evidenciaBuscada/gananciaCognitiva are never touched or re-derived);
//   - the proposal is re-validated by the SAME
//     validarIntegridadReferencialRepresentacionProductor/
//     validarFormaConceptosNuevos every ordinary Producer output goes
//     through (FULL_SCHEMA_VALIDATION + FULL_REFERENTIAL_INTEGRITY);
//   - it is committed via the SAME aplicarDelta -- autoridadGobernada's
//     own extractive check independently re-verifies any 'experto' claim
//     against the literal user message; a repair-proposed concept gets
//     ZERO more authority than a Producer-proposed one (FULL_GOVERNANCE);
//   - the caller (both call sites) lets the ordinary downstream frontier/
//     candidatosCompatiblesConFrontera code decide admissibility exactly as
//     it always does (FULL_ADMISSIBILITY) -- this function commits nothing
//     to a "governed, visible" state by itself.
// Returns null on ANY failure (no legitimate closure, malformed repair
// response, governance rejection) -- the caller's existing failure path
// (COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER) then runs
// unchanged, exactly as if this function had never been called.
async function intentarReparacionCierreReferencial({
  candidato, mensajeUsuario, grafoBase, idTemporalAReal, llmService,
  turnoId, turnoClienteId, gramatica,
  // REPAIRED_DIRECTED_RESPONSE_MUST_PASS_NORMAL_VALIDATION (C007,
  // DIRECTED_RESPONSE_ATTEMPT_REPAIR_AUTHORITY_CONTINUITY). Both optional:
  // callers on a turn with no frozen previous act keep byte-for-byte the
  // historical behavior. `contratoRespuestaDirigida` is the frozen previous
  // act's directed-response contract; `grafoAntesDelTurno` the durable graph
  // BEFORE this turn (what "new this turn" is measured against).
  contratoRespuestaDirigida = null, grafoAntesDelTurno = null,
}) {
  if (!candidato || !Array.isArray(candidato.idsColgantes) || candidato.idsColgantes.length === 0) return null;
  const idsColgantes = candidato.idsColgantes;
  const oportunidadCongelada = Array.isArray(candidato.parsed.oportunidadesConversacionales)
    ? candidato.parsed.oportunidadesConversacionales[0] : null;
  const dimension = (oportunidadCongelada && oportunidadCongelada.dimension) || null;
  const whatCongelado = oportunidadCongelada
    ? { operacion: oportunidadCongelada.operacion, semanticTarget: oportunidadCongelada.semanticTarget, evidenciaBuscada: oportunidadCongelada.evidenciaBuscada }
    : { gananciaCognitiva: candidato.parsed.gananciaCognitiva };
  let repair;
  try {
    repair = await llmService.call({
      system: buildCapa1ContentClosureRepairSystem({ mensajeUsuario, idsColgantes, whatCongelado, dimension }),
      // DISTINCT_LABEL -- deliberately NOT `gramatica`/the ordinary
      // producer's own label: this call must occupy its own identity (both
      // for observability and, critically, for deterministic-replay
      // fixtures, whose per-label FIFO queue must never let this repair
      // call be silently consumed by -- or silently consume -- an ordinary
      // producer retry/fallback attempt).
      userMsg: mensajeUsuario, label: `${gramatica}-cierre-referencial`, callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
      responseMimeType: 'application/json',
      responseSchema: buildCapa1ContentClosureRepairSchema(idsColgantes),
      turnoId,
    });
  } catch (_) {
    return null;
  }
  if (!repair || !repair.parsed || !Array.isArray(repair.parsed.conceptosPropuestos)
    || repair.parsed.conceptosPropuestos.length === 0) return null;
  // DEFENSIVE_RE-CHECK -- the schema already enum-constrains idTemporal to
  // idsColgantes; this never widens what the schema allowed, it only
  // refuses to trust a malformed/tampered response past that boundary.
  const idsColgantesSet = new Set(idsColgantes);
  const conceptosPropuestosCrudos = repair.parsed.conceptosPropuestos.filter(c => c && idsColgantesSet.has(c.idTemporal));
  if (conceptosPropuestosCrudos.length === 0) return null;
  // CONTENT_CLOSURE_REPAIR_SUCCESS_CONTRACT_TOO_WEAK (C007, Daniel-
  // adjudicated, faithful-replay-proven). Real evidence: the repair LLM call
  // above already carries an explicit instruction to use a literal fragment
  // when declaring autoridad:"experto" (buildCapa1ContentClosureRepairSystem)
  // -- but the model can still comply on the LABEL while paraphrasing the
  // CONTENT, which the existing, unmodified, already-certified
  // autoridadGobernada/contenidoEsExtractivo law then (correctly) degrades
  // to "inferido" silently. That degradation is CORRECT governance, never
  // weakened here. The gap this closes is upstream: for the id that anchors
  // the turn's OWN frozen oportunidad, this turn ALREADY has independent,
  // frozen, literal grounding on hand -- oportunidadCongelada.referenteSemantico
  // -- the SAME field the BOOTSTRAP_MISSION_NEED admissibility clause
  // (candidatosCompatiblesConFrontera, contenidoEsExtractivo) already treats
  // as this oportunidad's own literal referent. When the repair LLM's own
  // proposed descripcion for that SAME id is not extractive but that
  // frozen, already-honest literal referent independently is (checked via
  // the IDENTICAL contenidoEsExtractivo test, zero new authority granted
  // here), prefer it -- REPAIR MAY PROPOSE THE REPRESENTATION, it never
  // assigns authority: autoridadGobernada (aplicarDelta, below) still makes
  // the real, only, unmodified determination from whatever descripcion ends
  // up here. Never fabricates content: referenteSemantico was already frozen
  // as part of candidato.parsed this same turn, never regenerated, never
  // paraphrased further. Scoped to exactly the id that anchors
  // oportunidadCongelada -- every other proposed id, and every case where no
  // frozen oportunidad exists (bare gananciaCognitiva closure) or its own
  // referenteSemantico isn't independently extractive, keeps the repair
  // LLM's own descripcion exactly as before this fix.
  const anchorId = oportunidadCongelada && (oportunidadCongelada.anclajeConceptoIds || [])[0];
  const referenteCongeladoExtractivo = oportunidadCongelada
    && typeof oportunidadCongelada.referenteSemantico === 'string'
    && contenidoEsExtractivo(oportunidadCongelada.referenteSemantico, mensajeUsuario)
    ? oportunidadCongelada.referenteSemantico : null;
  const conceptosPropuestos = conceptosPropuestosCrudos.map(c => {
    if (c.idTemporal !== anchorId || c.autoridad !== 'experto' || !referenteCongeladoExtractivo) return c;
    if (contenidoEsExtractivo(c.descripcion, mensajeUsuario)) return c;
    return { ...c, descripcion: referenteCongeladoExtractivo };
  });

  // RELACIONESNUEVAS_IS_OUT_OF_SCOPE -- this repair is authorized to close
  // EXACTLY the dangling id(s) validarIntegridadReferencialRepresentacionProductor
  // flagged (evaluacionGanancia's own evidenciaConceptoIds); a relation the
  // frozen candidate separately declared (relacionesNuevas) can cite an
  // id this repair was never asked about (a real captured case: a
  // relacionesNuevas entry citing a SECOND concept the Producer also never
  // declared, distinct from the id closed here). Fabricating a second
  // concept to satisfy an out-of-scope relation would be exactly the
  // invented authority this repair must never grant -- REMOVE_INVALID_
  // DEPENDENCY (repair outcome B) applies to the relation itself: keep
  // only relations whose BOTH endpoints resolve against the concept set
  // this repair actually closes (the durable graph + the newly-proposed
  // ids), drop the rest. Never invents a missing endpoint, never keeps an
  // unsupported relation.
  const idsResueltosTrasCierre = new Set([
    ...conceptosPropuestos.map(c => c.idTemporal),
    ...((grafoBase && Array.isArray(grafoBase.conceptos)) ? grafoBase.conceptos.map(c => c.id) : []),
  ]);
  const relacionesCerradas = Array.isArray(candidato.parsed.relacionesNuevas)
    ? candidato.parsed.relacionesNuevas.filter(r => r
      && idsResueltosTrasCierre.has(r.origen) && idsResueltosTrasCierre.has(r.destino))
    : [];
  const parsedReparado = { ...candidato.parsed, conceptosNuevos: conceptosPropuestos, relacionesNuevas: relacionesCerradas };
  if (validarFormaConceptosNuevos(parsedReparado).length > 0) return null;

  const validacionCierre = validarIntegridadReferencialRepresentacionProductor(parsedReparado, {
    grafo: grafoBase, idTemporalAReal,
  });
  // CONTENT_CLOSURE_MUST_ACTUALLY_CLOSE -- if any originally-dangling id is
  // STILL unresolved after the repair's own proposal (e.g. it proposed n1
  // but not n2), this repair did not legitimately close the representation
  // it was given; never a partial/best-effort commit. Unchanged, still the
  // ONLY authority on whether a candidate component is referentially valid.
  let parsedParaCommit = validacionCierre.parsedSaneado || parsedReparado;
  let outcome = 'REPAIRED_VIA_CONTENT_CLOSURE';
  if (!validacionCierre.valido) {
    // CANDIDATE-SCOPED SALVAGE (CONTENT_CLOSURE_ALL_OR_NOTHING_DISCARDS_
    // INDEPENDENT_CANDIDATE, C007, Daniel-adjudicated, faithful-replay-
    // proven -- logistica_c0 turn 39). A single Producer envelope can carry
    // TWO structurally independent cognitive candidates -- a gain claim
    // (evaluacionGanancia) and an oportunidad -- that happen to share the
    // same output only by accident of the response format, not by any real
    // dependency. Before this fix, ANY still-unresolved reference anywhere
    // in the envelope (here: the gain's own evidenciaConceptoIds) discarded
    // the WHOLE representation, including an oportunidad that never cited
    // the dangling id at all. INVALID_CANDIDATE MUST_NOT_CONTAMINATE
    // INDEPENDENT_VALID_CANDIDATE -- but CANDIDATE-SCOPED SALVAGE IS NOT
    // PARTIAL AUTHORIZATION: the invalid gain is never marked repaired,
    // partial, satisfied, or governed -- it is dropped outright, replaced
    // with the EXACT neutral "no gain proposed" shape the Producer's own
    // contract already uses for this case (AgoraPrompts.js, "si no existe
    // gain retornable usa gananciaCognitiva:null, evaluacionGanancia:
    // {resultado:'NO_PROPUESTA', ...}") -- reusing the existing convention,
    // never inventing a new ontology. validarIntegridadReferencialRepresen
    // tacionProductor itself is NEVER changed and is invoked a SECOND time
    // below, unconditionally, as the sole authority on whether what
    // survives is actually referentially valid -- this block only decides
    // WHICH independent pieces are even offered to it.
    //
    // Scoped narrowly: only ever engages when the still-unresolved id(s)
    // belong to the gain's own evidenciaConceptoIds (the only field
    // validarIntegridadReferencialRepresentacionProductor checks) -- any
    // OTHER shape of referential failure has no defined salvage owner here
    // and fails closed exactly as before this fix.
    const idsAunColgantes = new Set(
      extraerIdsColgantesDeReferenciasInvalidas(validacionCierre.referenciasInvalidas));
    const evidenciaGanancia = parsedReparado.evaluacionGanancia
      && parsedReparado.evaluacionGanancia.satisfaccionConocimiento
      && Array.isArray(parsedReparado.evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds)
      ? parsedReparado.evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds : [];
    const gananciaEsLaCandidataInvalida = idsAunColgantes.size > 0
      && evidenciaGanancia.some(id => idsAunColgantes.has(id));
    if (!gananciaEsLaCandidataInvalida) return null;
    // DEPENDENCY_CLOSURE_NOT_ENVELOPE_POSITION -- mirrors validarIntegridad
    // ReferencialRepresentacionProductor's OWN `resuelve` test exactly
    // (durable graph, directo o vía idTemporalAReal, o esta MISMA salida --
    // aquí, los ids que este repair efectivamente cerró), never a looser or
    // stricter rule. Proves independence structurally per oportunidad, from
    // its own anclajeConceptoIds/evidenciaConceptoIds -- never "looks
    // unrelated". An oportunidad referencing ANY still-unresolved id (the
    // same one, or transitively any other id this repair did not close) is
    // dropped alongside the gain, not preserved.
    const idsDurablesSalvamento = new Set(
      (grafoBase && Array.isArray(grafoBase.conceptos) ? grafoBase.conceptos : [])
        .filter(c => c && typeof c.id === 'string').map(c => c.id));
    const idsCerradosPorEsteRepair = new Set(conceptosPropuestos.map(c => c.idTemporal));
    const mapaSalvamento = idTemporalAReal || {};
    const idResuelveParaSalvamento = (id) => {
      const idMapeado = Object.prototype.hasOwnProperty.call(mapaSalvamento, id) ? mapaSalvamento[id] : id;
      return idsDurablesSalvamento.has(idMapeado) || idsDurablesSalvamento.has(id)
        || idsCerradosPorEsteRepair.has(id);
    };
    const oportunidadesSobrevivientes = (Array.isArray(parsedReparado.oportunidadesConversacionales)
      ? parsedReparado.oportunidadesConversacionales : []).filter((o) => {
      if (!o || typeof o !== 'object') return false;
      const referencias = [
        ...(Array.isArray(o.anclajeConceptoIds) ? o.anclajeConceptoIds : []),
        ...((o.satisfaccionConocimiento && Array.isArray(o.satisfaccionConocimiento.evidenciaConceptoIds))
          ? o.satisfaccionConocimiento.evidenciaConceptoIds : []),
      ];
      return referencias.every(id => idResuelveParaSalvamento(id));
    });
    // Nothing legitimately independent survives -- no salvage, same
    // terminal as before this fix (both components invalid, or the only
    // candidate WAS the gain) -- UNLESS the frozen previous act's directed
    // response survives the drop (RESPONSE_ONLY_PRESERVED): the response is
    // its own independent component, never a WHAT, and it is accepted below
    // only if it passes the SAME normal validation as any ordinary output.
    const respuestaDirigidaSobrevive = !!contratoRespuestaDirigida
      && !!parsedReparado.relacionRespuestaDirigida
      && typeof parsedReparado.relacionRespuestaDirigida === 'object';
    if (oportunidadesSobrevivientes.length === 0 && !respuestaDirigidaSobrevive) return null;
    // PRESERVE_WHAT -- oportunidadesSobrevivientes entries are the EXACT
    // original objects from parsedReparado (a `.filter`, never a `.map`):
    // semanticTarget/referenteSemantico/evidenciaBuscada/needKind/operacion
    // and every other field travel unchanged. SALVAGED_CANDIDATE !=
    // GOVERNED_CANDIDATE: nothing here grants admissibility -- the surviving
    // representation still passes through frontier/governance/Decision
    // exactly like any ordinary Producer output, with no special authority.
    const parsedSalvado = {
      ...parsedReparado,
      gananciaCognitiva: null,
      evaluacionGanancia: {
        resultado: 'NO_PROPUESTA', razon: 'CONTENT_CLOSURE_UNRESOLVED_DEPENDENCY',
        satisfaccionConocimiento: { estado: 'ABIERTA', evidenciaConceptoIds: [], residuoSemantico: null },
      },
      oportunidadesConversacionales: oportunidadesSobrevivientes,
    };
    // FULL_REFERENTIAL_REVALIDATION -- the unmodified validator remains the
    // sole authority on the SURVIVING representation too; a salvage that
    // still fails full revalidation (e.g. a relation now dangling) is no
    // salvage at all.
    const revalidacionCompleta = validarIntegridadReferencialRepresentacionProductor(parsedSalvado, {
      grafo: grafoBase, idTemporalAReal,
    });
    if (!revalidacionCompleta.valido) return null;
    parsedParaCommit = revalidacionCompleta.parsedSaneado || parsedSalvado;
    outcome = oportunidadesSobrevivientes.length > 0
      ? 'INVALID_COMPONENT_DROPPED_INDEPENDENT_CANDIDATE_PRESERVED'
      : 'INVALID_COMPONENT_DROPPED_RESPONSE_ONLY_PRESERVED';
  }

  const { grafoNuevo, idTemporalAReal: idTemporalArealNuevo } = aplicarDelta(
    grafoBase, deltaAditivoDesdeParsed(parsedParaCommit),
    { mensajeUsuario, turnoOrigenId: turnoClienteId, actoCognitivoVisible: null, relacionRespuestaDirigida: null },
  );
  if (!grafoNuevo) return null;

  // REPAIR_HANDOFF_NORMALIZES_GAIN_SUPPORT_IDENTITIES (C007,
  // DIRECTED_RESPONSE_ATTEMPT_REPAIR_AUTHORITY_CONTINUITY). aplicarDelta just
  // assigned the durable identity of every concept this repair declared
  // (n1 -> c_9 ...). The repaired candidate is handed to the rest of the
  // turn (gain selection, frontier, directed-response lifecycle) as if it
  // had been valid from the start, so its dependent references must speak
  // the canonical identity too -- a temporal id surviving here is a
  // reference nobody downstream can resolve (the gain would be read as
  // unsupported even though its support exists). Only the SAME repaired
  // candidate's dependent fields are rewritten, only through the map
  // aplicarDelta itself returned: no broader graph rewriting, no id is
  // invented, an id the map does not know stays visibly unresolved.
  const mapaIdentidades = { ...(idTemporalAReal || {}), ...(idTemporalArealNuevo || {}) };
  const parsedNormalizado = normalizarReferenciasTemporalesDeCandidatoReparado(parsedParaCommit, mapaIdentidades);

  // REPAIRED_DIRECTED_RESPONSE_MUST_PASS_NORMAL_VALIDATION -- a repair may
  // RECONSTRUCT the representation but never bypasses response authority:
  // whatever relacionRespuestaDirigida the repaired candidate carries goes
  // through the very validator an ordinary Producer output goes through, now
  // against the canonical ids and the graph the repair actually produced.
  // Not valid (or absent while a frozen previous act governs this turn) ->
  // the repair did not produce a governable representation: null, and the
  // caller's existing fail-closed path runs exactly as if no repair existed.
  const relacionDirigida = gobernarRelacionDirigidaDeCandidatoReparado({
    parsed: parsedNormalizado, grafoReparado: grafoNuevo, grafoAntesDelTurno: grafoAntesDelTurno || grafoBase,
    idTemporalAReal: mapaIdentidades, contratoRespuestaDirigida, mensajeUsuario,
  });
  if (!relacionDirigida.valido) return null;

  return {
    parsed: parsedNormalizado,
    grafoNuevo,
    idTemporalAReal: idTemporalArealNuevo || {},
    outcome,
    relacionDirigida,
  };
}

// BOOTSTRAP_SEMANTICUNKNOWN_TO_ACQUISITION_CORRECTION (C007, Daniel-
// adjudicated -- Option A). Owner: the Producer generative-contract /
// correction-loop boundary -- correction of an UNGOVERNED Producer
// proposal before canonical admissibility, never repair of already-
// governed knowledge (CONTENT_CLOSURE_REPAIR/STRUCTURAL_REBIND are a
// DIFFERENT, untouched territory). Called ONLY when the caller has already
// confirmed: active BOOTSTRAP_MISSION_NEED frontier, zero compatible
// candidates, and a real, mission-relevant standalone semanticUnknown
// proposal exists this turn (see the call site's own eligibility gate).
//
// WHAT (mission, proposición/dirección cognitiva) is FROZEN -- this
// function never asks the correction call to regenerate it, and never
// accepts a regenerated one even if offered; `semanticTarget` on the
// returned oportunidad is always the ORIGINAL proposicion, verbatim. The
// correction call's only representable output is a corrected
// `referenteSemantico` (an honest extractive re-citation of the SAME
// direction) or an honest admission that none exists -- never a new topic,
// never fabricated content. REPAIR MAY PROPOSE, NOT AUTHORIZE: the
// returned referenteSemantico is independently re-validated against
// contenidoEsExtractivo (the SAME, unmodified, already-certified grounding
// owner candidatosCompatiblesConFrontera's own BOOTSTRAP_MISSION_NEED
// clause uses) before this function ever returns a non-null result -- no
// authority laundering, no trust extended to the correction call alone.
async function intentarCorreccionAdquisicionBootstrap({
  semanticUnknownOriginal, mensajeUsuario, llmService, turnoId, gramatica, dimension,
}) {
  if (!semanticUnknownOriginal || typeof semanticUnknownOriginal !== 'object') return null;
  const proposicion = semanticUnknownOriginal.proposicion || semanticUnknownOriginal.semanticTarget;
  const referenteOriginal = semanticUnknownOriginal.referenteSemantico;
  if (typeof proposicion !== 'string' || !proposicion.trim()
    || typeof referenteOriginal !== 'string' || !referenteOriginal.trim()) return null;
  const mission = semanticUnknownOriginal.mission || gramatica;
  let correccion;
  try {
    correccion = await llmService.call({
      system: buildCapa1BootstrapAcquisitionCorrectionSystem({ mensajeUsuario, proposicion, referenteOriginal, mission, dimension }),
      // DISTINCT_LABEL -- same discipline as -cierre-referencial: never the
      // ordinary producer's own label, so deterministic-replay fixtures'
      // per-label FIFO queue can never confuse this call with an ordinary
      // producer retry/fallback attempt.
      userMsg: mensajeUsuario, label: `${gramatica}-correccion-adquisicion-bootstrap`, callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
      responseMimeType: 'application/json',
      responseSchema: buildCapa1BootstrapAcquisitionCorrectionSchema(),
      turnoId,
    });
  } catch (_) { return null; }
  if (!correccion || !correccion.parsed) return null;
  // Honest decline -- never fabricate a referent when the correction call
  // itself reports none exists. TRY THE CORRECT BOUNDED REPAIR, not FORCE
  // EVERY TURN TO PASS.
  if (correccion.parsed.existeReferenteLegitimo !== true) return null;
  const referenteCorregido = correccion.parsed.referenteSemantico;
  if (typeof referenteCorregido !== 'string' || !referenteCorregido.trim()) return null;
  if (!contenidoEsExtractivo(referenteCorregido, mensajeUsuario)) return null;
  return {
    idTemporal: 'bootstrap_correction_1', operacion: 'ABRIR_COMO',
    semanticTarget: proposicion, // FROZEN, verbatim -- never regenerated
    referenteSemantico: referenteCorregido,
    // oportunidadConversacionalEstructuralmenteValida requires a non-empty
    // evidenciaBuscada -- reuses the SAME frozen proposicion, never new
    // semantic content.
    evidenciaBuscada: proposicion,
    satisfaccionConocimiento: { estado: 'ABIERTA', evidenciaConceptoIds: [], residuoSemantico: null },
    anclajeConceptoIds: [], anclajeRelacionIds: [],
    semanticUnknownId: null, unknownId: null,
    dimension: dimension || null, needKind: null,
  };
}

// BOOTSTRAP_REACQUISITION (C007, Daniel-adjudicated). REJECTED_ACQUISITION_
// PROPOSAL != EXHAUSTED_ACQUISITION_FRONTIER: intentarCorreccionAdquisicionBootstrap
// proving ONE Producer-chosen direction unrecoverable (no legitimate
// extractive referent for THAT proposición) never proves the user's
// opening contains no admissible first acquisition at all --
// FAILED_REPAIR_OF_PROPOSAL_X != NO_LEGITIMATE_FIRST_ACQUISITION_EXISTS.
// Called EXACTLY ONCE by the caller, ONLY after
// intentarCorreccionAdquisicionBootstrap has already honestly declined
// for the SAME turn -- never a loop, never re-tried. Unlike that
// function, WHAT is not frozen here (a genuinely DIFFERENT direction may
// be proposed) -- but REPAIR MAY PROPOSE WHAT != REPAIR MAY AUTHORIZE
// WHAT still holds absolutely: the returned referenteSemantico is
// independently re-validated against the SAME, unmodified
// contenidoEsExtractivo before this function ever returns a non-null
// result, exactly like the correction it follows. The rejected direction
// is turn-local negative memory ONLY -- transported into the prompt
// purely so this call does not re-propose the SAME thing already
// demonstrated unrecoverable; it is never written to the Knowledge Graph,
// never durable, never epistemic authority.
async function intentarReadquisicionBootstrap({
  semanticUnknownRechazado, mensajeUsuario, llmService, turnoId, gramatica, dimension,
}) {
  if (!semanticUnknownRechazado || typeof semanticUnknownRechazado !== 'object') return null;
  const rejectedProposicion = semanticUnknownRechazado.proposicion || semanticUnknownRechazado.semanticTarget;
  const rejectedReferente = semanticUnknownRechazado.referenteSemantico;
  if (typeof rejectedProposicion !== 'string' || !rejectedProposicion.trim()
    || typeof rejectedReferente !== 'string' || !rejectedReferente.trim()) return null;
  const mission = semanticUnknownRechazado.mission || gramatica;
  let readquisicion;
  try {
    readquisicion = await llmService.call({
      system: buildCapa1BootstrapReacquisitionSystem({ mensajeUsuario, rejectedProposicion, rejectedReferente, mission, dimension }),
      // DISTINCT_LABEL -- same discipline as -cierre-referencial and
      // -correccion-adquisicion-bootstrap: never the ordinary producer's
      // own label, so deterministic-replay fixtures' per-label FIFO queue
      // can never confuse this call with any other attempt.
      userMsg: mensajeUsuario, label: `${gramatica}-readquisicion-bootstrap`, callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
      responseMimeType: 'application/json',
      responseSchema: buildCapa1BootstrapReacquisitionSchema(),
      turnoId,
    });
  } catch (_) { return null; }
  if (!readquisicion || !readquisicion.parsed) return null;
  // Honest decline -- never fabricate an acquisition when the reacquisition
  // call itself reports none exists. TRY THE CORRECT BOUNDED REPAIR, not
  // FORCE EVERY TURN TO PASS -- an honest terminal remains legitimate.
  if (readquisicion.parsed.existeOtraAdquisicionLegitima !== true) return null;
  const nuevaProposicion = readquisicion.parsed.proposicion;
  const nuevoReferente = readquisicion.parsed.referenteSemantico;
  if (typeof nuevaProposicion !== 'string' || !nuevaProposicion.trim()
    || typeof nuevoReferente !== 'string' || !nuevoReferente.trim()) return null;
  // NEGATIVE_TRANSIENT_MEMORY_MUST_BE_RESPECTED -- the new proposal must be
  // genuinely DISTINCT from the rejected one, never a repeat/reformulation
  // smuggled through. Mechanical, normalized comparison only -- no
  // semantic judgment invented here.
  const normalizar = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  if (normalizar(nuevaProposicion) === normalizar(rejectedProposicion)
    || normalizar(nuevoReferente) === normalizar(rejectedReferente)) return null;
  // REPAIR MAY PROPOSE, NOT AUTHORIZE -- independently re-validated,
  // never trusted from the reacquisition call alone.
  if (!contenidoEsExtractivo(nuevoReferente, mensajeUsuario)) return null;
  return {
    idTemporal: 'bootstrap_reacquisition_1', operacion: 'ABRIR_COMO',
    semanticTarget: nuevaProposicion,
    referenteSemantico: nuevoReferente,
    evidenciaBuscada: nuevaProposicion,
    satisfaccionConocimiento: { estado: 'ABIERTA', evidenciaConceptoIds: [], residuoSemantico: null },
    anclajeConceptoIds: [], anclajeRelacionIds: [],
    semanticUnknownId: null, unknownId: null,
    dimension: dimension || null, needKind: null,
  };
}

// NEW_OPPORTUNITY_REQUIRES_SAME_BATCH_GROUNDING (C007, Daniel-adjudicated,
// real evidence: logistica_c1 turn 10). Scoped narrowly to the SAME shape
// of gap elegibleCorreccionAdquisicionBootstrap already covers for
// semanticUnknown -- zero compatible candidates this turn -- but for the
// oportunidadesConversacionales representation instead: a Producer proposal
// that is otherwise well-formed (real operacion, real semanticTarget/
// evidenciaBuscada direction) yet cites NO anchor at all (neither an
// existing durable concept nor a same-batch conceptosNuevos entry).
// EXCLUSIVE of the bootstrap path by construction: that one requires a real
// semanticUnknownParsed object; this one requires a real oportunidad
// candidate -- a turn can only ever match the one it actually produced.
function primerCandidatoSinFundamento(oportunidadesCrudas, conceptosNuevosCrudos) {
  const propuestos = new Set((Array.isArray(conceptosNuevosCrudos) ? conceptosNuevosCrudos : [])
    .map(c => c && c.idTemporal).filter(Boolean));
  return (Array.isArray(oportunidadesCrudas) ? oportunidadesCrudas : []).find(o => {
    if (!o || typeof o !== 'object' || !o.operacion) return false;
    const direccion = (typeof o.semanticTarget === 'string' && o.semanticTarget.trim())
      || (typeof o.evidenciaBuscada === 'string' && o.evidenciaBuscada.trim());
    if (!direccion) return false;
    const anclaje = Array.isArray(o.anclajeConceptoIds) ? o.anclajeConceptoIds : [];
    // Already grounded, either directly or via a same-batch proposal this
    // SAME output already made -- nothing to correct.
    if (anclaje.some(id => propuestos.has(id))) return false;
    return anclaje.length === 0;
  }) || null;
}

function elegibleCorreccionFundamentoFrescoOportunidad({
  candidatosCompatiblesAntesDeRepair = [],
  oportunidadesCrudas = [],
  conceptosNuevosCrudos = [],
} = {}) {
  return (candidatosCompatiblesAntesDeRepair || []).length === 0
    && !!primerCandidatoSinFundamento(oportunidadesCrudas, conceptosNuevosCrudos);
}

// CORRECCION_DE_FUNDAMENTO_FRESCO_ACOTADA caller. WHAT (operacion/
// semanticTarget/evidenciaBuscada) is FROZEN -- never regenerated, exactly
// like intentarCorreccionAdquisicionBootstrap. On a legitimate grounding,
// commits the ONE new concept via the SAME aplicarDelta every ordinary
// Producer concept already goes through (never a parallel commit path),
// then returns the corrected opportunity anchored to that concept's REAL
// id. REPAIR MAY PROPOSE, NOT AUTHORIZE: the returned descripcion is
// independently re-validated against contenidoEsExtractivo before this
// function ever attempts to commit it -- aplicarDelta's own
// autoridadGobernada remains the second, unconditional backstop either way.
async function intentarCorreccionFundamentoFrescoOportunidad({
  oportunidadOriginal, mensajeUsuario, llmService, turnoId, turnoClienteId, gramatica, dimension, grafoBase,
}) {
  if (!oportunidadOriginal || typeof oportunidadOriginal !== 'object' || !oportunidadOriginal.operacion) return null;
  const direccionCognitiva = (typeof oportunidadOriginal.semanticTarget === 'string' && oportunidadOriginal.semanticTarget.trim())
    || (typeof oportunidadOriginal.evidenciaBuscada === 'string' && oportunidadOriginal.evidenciaBuscada.trim());
  if (!direccionCognitiva) return null;
  const mission = oportunidadOriginal.mission || gramatica;
  let correccion;
  try {
    correccion = await llmService.call({
      system: buildCapa1FreshGroundingCorrectionSystem({
        mensajeUsuario, direccionCognitiva, operacion: oportunidadOriginal.operacion, mission, dimension,
      }),
      // DISTINCT_LABEL -- same discipline as every other narrow correction
      // call in this file: never the ordinary producer's own label.
      userMsg: mensajeUsuario, label: `${gramatica}-correccion-fundamento-fresco`, callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
      responseMimeType: 'application/json',
      responseSchema: buildCapa1FreshGroundingCorrectionSchema(),
      turnoId,
    });
  } catch (_) { return null; }
  if (!correccion || !correccion.parsed) return null;
  if (correccion.parsed.existeFundamentoLegitimo !== true) return null;
  const conceptoNuevo = correccion.parsed.conceptoNuevo;
  if (!conceptoNuevo || typeof conceptoNuevo !== 'object'
    || typeof conceptoNuevo.idTemporal !== 'string' || !conceptoNuevo.idTemporal.trim()
    || typeof conceptoNuevo.descripcion !== 'string' || !conceptoNuevo.descripcion.trim()) return null;
  if (!contenidoEsExtractivo(conceptoNuevo.descripcion, mensajeUsuario)) return null;
  const { grafoNuevo, idTemporalAReal, errores } = aplicarDelta(grafoBase, {
    conceptosNuevos: [{
      idTemporal: conceptoNuevo.idTemporal, tipo: 'conocimiento_central',
      descripcion: conceptoNuevo.descripcion, autoridad: 'experto',
      procedencia: `turno:${turnoClienteId}`, gramaticaOrigen: gramatica,
    }],
    conceptosActualizados: [], marcarObsoletos: [], relacionesNuevas: [], incertidumbresNuevas: [],
  }, { mensajeUsuario, turnoOrigenId: turnoClienteId, actoCognitivoVisible: null, relacionRespuestaDirigida: null });
  if (!grafoNuevo || (errores && errores.length > 0)) return null;
  const idReal = idTemporalAReal[conceptoNuevo.idTemporal];
  if (!idReal) return null;
  return {
    grafoNuevo, idTemporalAReal,
    oportunidadCorregida: { ...oportunidadOriginal, anclajeConceptoIds: [idReal] },
    conceptoNuevo: { idTemporal: conceptoNuevo.idTemporal, descripcion: conceptoNuevo.descripcion, idReal },
  };
}

// The graph remains the continuity memory.  Only concepts explicitly cited
// as support for the contracted non-interrogative gain are projected as
// material to express in that act.
function materialAfirmableParaActo(conceptos, gananciaCognitiva) {
  const lista = Array.isArray(conceptos) ? conceptos : [];
  const gain = gananciaCognitiva && typeof gananciaCognitiva === 'object'
    ? gananciaCognitiva : null;
  const ids = gain && Array.isArray(gain.soporteConceptoIds)
    ? new Set(gain.soporteConceptoIds) : null;
  return lista.filter(c => c && c.activo !== false && c.autoridad === 'experto'
    && (!ids || ids.has(c.id)));
}

// VISIBLE_LANGUAGE_FIDELITY (C007 — voz conversacional). SEMANTIC_LABEL !=
// VISIBLE_LEXICAL_AUTHORITY: distinct from materialAfirmableParaActo on
// purpose — that projection answers "what may Círculo affirm as true this
// turn" and is correctly narrowed to the contracted gain's own support.
// This one answers a different question — "what exact words did the expert
// already use for the thing this act is about" — scoped to the frozen
// act's own anchors (subjectRef/authorizedPresuppositionIds/the selected
// opportunity's anclajeConceptoIds), never to gain support: an interrogative
// act with no gain, or a co-present gain scoped to different concepts,
// still deserves the user's own register for its own anchor. Never derives
// new text; only reuses descriptions the graph already governs.
function lexicalGroundingParaAncla(conceptos, anclaConceptoIds) {
  const lista = Array.isArray(conceptos) ? conceptos : [];
  const ids = new Set((Array.isArray(anclaConceptoIds) ? anclaConceptoIds : []).filter(Boolean));
  if (ids.size === 0) return [];
  return lista
    .filter(c => c && c.activo !== false && c.autoridad === 'experto' && ids.has(c.id))
    .map(c => c.descripcion)
    .filter(d => typeof d === 'string' && d.trim());
}
const GrafoProyeccion = require('../state/GrafoProyeccion');
const {
  proyectarSlots, conceptosDeGramatica, incertidumbresRelevantesAbiertas, inferenciasMaterialesActivas,
  relacionesMaterialesActivas,
  contextoGramaticasAnterioresPorAutoridad, dimensionDeProcedencia, elegibleParaAbstraer, umbralElegibilidad,
  alcanceEpistemicoConcepto,
  calcularNivelLenguaje, sintesisProcedencia, sintesisRechazadasDeGramatica,
  conocimientoExportadoDeGramaticasCerradas, conocimientoExpertoActivoDeGramatica,
  proyectarHechosSuficienciaParaSintesis, SLOT_LABELS, procedenciaNoResuelta,
} = GrafoProyeccion;
const dimensionesPendientesDeGrafo = GrafoProyeccion.dimensionesPendientes;
const avanzaRealDeGrafo = GrafoProyeccion.avanzaReal;

/**
 * Extrae el shape de delta que GrafoConocimientoPolicy.aplicarDelta (fase de
 * CONSTRUCCIÓN) espera, directamente de la respuesta parseada del LLM bajo
 * el contrato EXPLORANDO del Grafo de Conocimiento vivo (Incremento 1) —
 * los nombres de campo del JSON solicitado (ver
 * AgoraPrompts.buildProtocoloBloqueExplorandoGrafo) coinciden 1:1 a
 * propósito, sin traducción intermedia.
 */
// CONECTADO_PROCEDENCIA_VERIFICADA / RELACION_DURABLE_SIN_PROCEDENCIA_NO_
// PUEDE_OTORGAR_AUTORIDAD_INTERPRETATIVA — activa, por primera vez para
// 'destino', el primitivo YA EXISTENTE KnowledgeGraph.relaciones. La
// gobernanza de autoridad (extractiva, "Ley de Degradación" — nunca
// rechaza, degrada) vive ahora DENTRO de GrafoConocimientoPolicy.aplicarDelta
// (autoridadGobernada, reutilizada tal cual para relaciones — MISMA regla
// que ya rige conceptosNuevos, nunca una segunda), no aquí: relacionesNuevas
// viaja tal cual, igual que conceptosNuevos, sin arnés de pre-filtrado
// separado — un tipo inválido o un id irresoluble hace que aplicarDelta
// rechace el delta y dispare el mismo reintento de contrato que ya gobierna
// cualquier otro campo mal formado (comportamiento ya aceptado y probado
// para conceptosNuevos, nunca nuevo).
function deltaDesdeParsed(parsed) {
  return {
    conceptosNuevos: parsed.conceptosNuevos,
    marcarObsoletos: parsed.marcarObsoletos,
    incertidumbresNuevas: parsed.incertidumbresNuevas,
    relacionesNuevas: parsed.relacionesNuevas,
  };
}

// Frontera ORDEN_COGNITIVO_DEL_TURNO_1: antes de reconciliar solo se
// materializan identidades y relaciones descriptivas del aporte actual.
function deltaAditivoDesdeParsed(parsed) {
  return {
    conceptosNuevos: parsed.conceptosNuevos,
    relacionesNuevas: parsed.relacionesNuevas,
    relacionRespuestaDirigida: parsed.relacionRespuestaDirigida || null,
  };
}

/**
 * Extrae el shape de delta que GrafoConocimientoPolicy.aplicarDeltaReconciliacion
 * (fase de RECONCILIACIÓN HISTÓRICA) espera, desde la respuesta parseada del
 * LLM bajo AgoraPrompts.buildReconciliacionPrompt.
 */
function deltaReconciliacionDesdeParsed(parsed) {
  return {
    conceptosActualizados: parsed.conceptosActualizados,
    incertidumbresNuevas: parsed.incertidumbresNuevas,
    incertidumbresResueltas: parsed.incertidumbresResueltas,
    incertidumbresNoRelevantes: parsed.incertidumbresNoRelevantes,
    inferenciasConfirmadas: parsed.inferenciasConfirmadas,
    inferenciasRechazadas: parsed.inferenciasRechazadas,
    relacionesConfirmadas: parsed.relacionesConfirmadas,
    relacionesAutorizadas: parsed.relacionesAutorizadas,
    resolucionesIdentidadDurable: parsed.resolucionesIdentidadDurable,
    // Compatibilidad de deltas estructurados históricos: solo se usa cuando
    // el contrato nuevo no está presente.
    identidadesDurables: parsed.identidadesDurables,
    conceptosRecuperadosDeMemoria: parsed.conceptosRecuperadosDeMemoria,
    relacionesRecuperadasDeMemoria: parsed.relacionesRecuperadasDeMemoria,
  };
}

// Canonicaliza toda la cadena de referencias del turno en una sola pasada
// lógica. El mapa provisional puede contener n1→TEMP_1 y Reconciliación
// añadir TEMP_1→M; ningún consumidor downstream debe resolver aliases por
// accidente ni recibir un nodo que ya fue descartado de la cabeza.
function canonicalizarMapaReferenciasTurno(mapa, identidadesCanonicas = {}) {
  const salida = { ...(mapa || {}), ...(identidadesCanonicas || {}) };
  const resolver = (id, visitados = new Set()) => {
    if (!salida[id] || salida[id] === id || visitados.has(id)) return salida[id] || id;
    visitados.add(id);
    return resolver(salida[id], visitados);
  };
  for (const id of Object.keys(salida)) salida[id] = resolver(id);
  return salida;
}

// La adjudicación dimensional puede declarar que una extracción temporal es
// la misma identidad que otra del lote antes de que aplicarDelta asigne el id
// durable. Esa extracción se descarta como concepto, pero sus referencias no
// pueden quedar huérfanas: transportan la identidad canónica ya adjudicada.
function proyectarIdentidadesAdjudicadas(mapa, traza = []) {
  const aliases = {};
  for (const item of traza) {
    if (!item || item.resultado !== 'DESCARTADO_POR_IDENTIDAD'
      || !item.conceptoIdTemporal || !item.evidenciaRef) continue;
    aliases[item.conceptoIdTemporal] = item.evidenciaRef;
  }
  return canonicalizarMapaReferenciasTurno(mapa, aliases);
}

function canonicalizarSoporteGanancia(parsed, mapa = {}) {
  const satisfaccion = parsed && parsed.evaluacionGanancia
    && parsed.evaluacionGanancia.satisfaccionConocimiento;
  if (!satisfaccion || !Array.isArray(satisfaccion.evidenciaConceptoIds)) return;
  satisfaccion.evidenciaConceptoIds = [...new Set(
    satisfaccion.evidenciaConceptoIds.map(id => mapa[id] || id),
  )];
}

// CONTRATO_RESPUESTA_DIRIGIDA_CANONICAL_DIMENSION_LOST (C007, Daniel-
// adjudicated, faithful-replay-proven -- logistica_c0 fresh-live turn 10,
// session live_complete_logistica_c0_11ec6033). CANONICAL_ACT_TARGET_
// IDENTITY_IS_THE_AUTHORITY_FOR_TARGET_METADATA: given a frozen canonical
// act's own `target` id, resolves the REAL governed dimension already
// carried by whatever that target durably is -- a governed SemanticUnknown
// (its own `.dimension` field) or a governed Concept (`.procedencia` via
// the SAME dimensionDeProcedencia this file already uses everywhere else,
// never a second heuristic). This is a pure factoring-out of the real call
// site's lookup for isolated testability (same discipline as
// authorizedVisibleOutputEstaDisponible below) -- reuses the SAME find()
// pattern this file already applies to a frozen act's target elsewhere
// (actoDirigidoPrevio resolution, subjectRef resolution), never a bespoke
// third lookup. FAIL_CLOSED: an unresolved target, or a resolved target
// with no legitimate dimension, returns null -- never fabricated, never
// substituted with current focus/frontier/last-dimension.
function resolverDimensionDeTargetGobernado(target, grafo) {
  if (!target || !grafo) return null;
  const unknownGobernado = Array.isArray(grafo.incertidumbres)
    ? grafo.incertidumbres.find(u => u && u.id === target) : null;
  if (unknownGobernado) return unknownGobernado.dimension || null;
  const conceptoGobernado = Array.isArray(grafo.conceptos)
    ? grafo.conceptos.find(c => c && c.id === target) : null;
  return conceptoGobernado ? (dimensionDeProcedencia(conceptoGobernado.procedencia) || null) : null;
}

// DESTINO_MISSION_SUFFICIENCY_NOT_WIRED_TO_CLOSURE (C007, Daniel-
// adjudicated, real evidence: logistica_c0 fresh-live turn 11, session
// live_complete_logistica_c0_11ec6033). GRAMMAR_MISSION_SUFFICIENT !=
// GRAMMAR_TRANSITION_AUTHORIZED: the pre-existing `missionSufficient`
// computation ("C007 CLASS 12 HANDOFF FIX", below) answers "is it time to
// hand off to the NEXT grammar in the five-grammar sequence" -- a
// WHOLE-SEQUENCE authority (ProgresoConversacionalPolicy's closureOption),
// correct and untouched for the other four grammars. It structurally
// excludes 'destino' (`gramaticaActivaAlInicio !== 'destino'`), so
// PROPOSE_MISSION_CLOSURE was categorically unreachable while active in
// DESTINO, no matter how complete DESTINO's own internal 4-dimension
// coverage was -- DESTINO's OWN, already-certified sufficiency signal
// (GrafoProyeccion.dimensionesPendientes/coberturaCompleta, the same
// owner DESTINO_OPTIONAL_DEPTH_STARVES_REQUIRED_COVERAGE already reuses)
// was never consulted here at all. This function is the grammar adapter
// boundary: for 'destino', ELIGIBLE_FOR_MISSION_CLOSURE now reads that
// real, already-computed coverage fact; every OTHER grammar's expression
// is reproduced byte-for-byte, unchanged, never redesigned or generalized
// to DESTINO's own dimension ontology. Never recomputed from Producer
// opportunity, UI focus, turn count, last movement, or textual
// recognition -- ADDITIONAL_DEPTH_EXISTS != MISSION_REQUIRES_ADDITIONAL_
// DEPTH, and the Decisor's own downstream PROPOSE_MISSION_CLOSURE
// contract is untouched: this only supplies the one boolean fact it was
// always meant to consume, now correctly meaning "the ACTIVE grammar's own
// mission is sufficient for closure consideration" for every grammar
// including destino.
//
// OPTIONAL_PROPOSAL_MUST_NOT_CREATE_MISSION_NECESSITY (same cluster,
// caught during offline replay certification, real evidence: the exact
// turn-11 fixture). `grafoPreTurnoDestino` MUST be the graph as it entered
// THIS turn (estadoActual.knowledgeGraph), never grafoDelta/
// grafoParaDecisionCanonica -- by the time Decision runs, a legitimate
// OPTIONAL Producer opportunity may already have been structurally
// rebound into a brand-new, still-open governed SemanticUnknown (real
// evidence: turn 11's own "checklist mechanism" oportunidad materializing
// as semantic_unknown:4). Reading the POST-rebind graph here would let
// that fresh, genuinely-optional unknown reopen a dimension
// (dimensionesConIncertidumbresRelevantes) and silently flip an
// already-sufficient mission back to insufficient, exactly the ordering
// bug this fix exists to close: mission-level sufficiency must be judged
// on the state the turn STARTED with, before any optional acquisition
// this same turn proposes gets a chance to manufacture new necessity.
function resolverSuficienciaMisionGramaticaActiva({
  gramaticaActivaAlInicio, grafoPreTurnoDestino, protocoloEstadoEfectivo, closureOptionEsteTurno,
}) {
  if (gramaticaActivaAlInicio === 'destino') {
    return !!grafoPreTurnoDestino && dimensionesPendientesDeGrafo(grafoPreTurnoDestino, 'destino').length === 0;
  }
  return protocoloEstadoEfectivo === 'LISTO_PARA_SINTESIS' || !!closureOptionEsteTurno;
}

function debeEjecutarMaterializadorMovimientoLegacy({ actoCognitivoCanonico, contratoIntervencion }) {
  return !(actoCognitivoCanonico && contratoIntervencion);
}

// MISSION_REQUIRED_OPPORTUNITY_OUTRANKS_OPTIONAL_ACQUIRED_ACT (C007,
// ASCENSO_ASK_EVIDENCE_INTERMITTENT_REALIZATION_FAILURE, Daniel-adjudicated,
// real evidence: logistica_c0 live turn 36, session
// live_complete_logistica_c0_11ec6033). Common-core arbitration between the
// TWO independent conversational-authority mechanisms this pipeline runs
// every turn: the mission-opportunity path (ObjetivoConversacionalPolicy.
// direccionMision/decidirObjetivoConversacional, already correctly scoped to
// GrafoProyeccion.dimensionesPendientes) and the acquired-act path
// (DecisorIntervencionConversacional.decidirIntervencionConversacional/
// needFromGovernedState). MISSION_REQUIRED_COVERAGE > LOCAL_DIMENSION_
// CONTINUITY > OPTIONAL_ADDITIONAL_DEPTH must hold ACROSS both mechanisms,
// never just within one -- real evidence: turn 36's Producer cited an old,
// already-satisfied 'ensayo'-dimension opportunity as its own needKind:
// EVIDENCE candidate (triggered by an unrelated, correctly-rejected cross-
// turn gain-support challenge), and the acquired-act path selected
// ASK_EVIDENCE from it unconditionally, even though ASCENSO's OWN
// mission-required 'escalon' opportunity was independently available and
// correctly selected by the mission-opportunity path the very same turn.
//
// Scoped narrowly, per explicit adjudication: only acquired-act candidates
// whose OWN necesidadCognitiva.provenance is 'governed_opportunity' (a
// Producer-VOLUNTEERED, needKind-classified candidate -- EVIDENCE/DETAIL/
// EXISTENCE/opportunity-driven MECHANISM, see DecisorIntervencionConversacional.js
// needFromGovernedState's own opportunity-derived branch) are even
// considered here. REPAIR, MISSION_CLOSURE, RETURN_UNDERSTANDING,
// RETURN_GOVERNED_GAIN, and the raw-graph MECHANISM fallback (every one of
// them provenance:'governed_state'/'governed_active_repair') are genuinely
// blocking cognitive obligations and remain unconditionally authoritative,
// exactly as before -- never touched here. And even within that narrow
// scope, an acquired act serving the SAME required territory the mission-
// opportunity mechanism is ALSO currently trying to advance is never
// suppressed (CASE 3: evidence mandatory to govern a required current claim
// may still win) -- only a candidate for a DIFFERENT (already-satisfied or
// non-required) dimension yields.
function actoAdquiridoOpcionalDebeCederAMisionRequerida({
  necesidadCognitiva = null,
  oportunidadOrigenActoAdquirido = null,
  oportunidadMisionRequerida = null,
} = {}) {
  if (!necesidadCognitiva || necesidadCognitiva.provenance !== 'governed_opportunity') return false;
  if (!oportunidadMisionRequerida) return false;
  if (!oportunidadOrigenActoAdquirido) return true;
  return oportunidadOrigenActoAdquirido.dimension !== oportunidadMisionRequerida.dimension;
}

// COMMITTED_PREVIOUS_ACT_AUTHORITY_ONLY (C007,
// FAILED_ATTEMPT_TRACE_CONTAMINATES_CONFIRMATION_SUBJECT_AUTHORITY,
// Daniel-adjudicated, real evidence: the RECOVERY3 db for session
// live_complete_logistica_c0_11ec6033). FAILED_TURN != COMMITTED_COGNITIVE_
// STATE; UNCOMMITTED_AUTHORITY_TRACE_MUST_NOT_AUTHORIZE_OR_OVERRIDE_FUTURE_
// COGNITION. `eventRepo.lastOfType('authority_trace.turno')` is purely
// chronological -- `_emitirTrazaAutoridad` durably records an
// authority_trace.turno event even on a FAILED turn (commit:false, see its
// own call sites), so a failed CURRENT-turn retry can sit chronologically
// AFTER the real last COMMITTED previous act and silently shadow it. Real
// evidence: turn 23 committed PROPOSE_MISSION_CLOSURE (commit:true); an
// earlier failed turn-24 attempt then wrote its own trace (operator:null,
// commit:false) for the SAME still-pending turnoId; `lastOfType` returned
// THAT one on the next resume, defaulting confirmationSubject to SYNTHESIS
// and demanding clasificacion_respuesta -- CONTRATO_INVALIDO, never
// reaching either already-certified turn-24 fix.
// PREVIOUS_ACT_AUTHORITY = LATEST_RELEVANT_COMMITTED_ACT, never the latest
// chronological trace. Grammar-neutral by construction -- encodes no
// operator/grammar semantics, only COMMITTED_ONLY + same-session scoping +
// (defensively) excluding the current pending turn's own reserved turnoId,
// so a future bug that ever marked a same-turn retry commit:true still
// could not leak authority into itself. ONE shared authority for every
// consumer inside this recovery boundary (confirmationSubject fallback AND
// the frozen-previous-act/contratoPresentadoAnterior reconstruction) --
// never a second, independently-filtered lookup. HISTORY_PRESERVED !=
// HISTORY_AUTHORIZES_CURRENT_STATE: this never deletes or mutates any
// event, including failed ones -- it only changes which one is read as
// authority.
function obtenerUltimoActoCanonicoComprometidoAnterior(eventRepo, sesionId, { excludeTurnoId = null } = {}) {
  if (!eventRepo || typeof eventRepo.findBySesionAndType !== 'function') return null;
  const eventos = eventRepo.findBySesionAndType(sesionId, 'authority_trace.turno');
  if (!Array.isArray(eventos)) return null;
  for (let i = eventos.length - 1; i >= 0; i--) {
    const ev = eventos[i];
    if (!ev || !ev.payload || ev.payload.commit !== true) continue;
    if (excludeTurnoId && ev.turnoId === excludeTurnoId) continue;
    return ev;
  }
  return null;
}

// AUTHORIZED_VISIBLE_OUTPUT_AVAILABLE (C007, Daniel-adjudicated, faithful-
// replay-proven -- logistica_c0 turn 42). The single, minimal predicate for
// "does this turn already have a legitimately-produced visible response",
// recognizing exactly the FOUR independently-authorized materialization
// paths this file has:
//   - typed-direction contract (decision.contratoIntervencionDestino);
//   - MOVIMIENTO contract (contratoIntervencionMovimiento);
//   - GobernanzaMaterializacion(TRANSFORMAR) -> Realizer, when the
//     Realizer's own output survived every gate it already has to pass
//     (validarContratoConectado when applicable, then the unconditional
//     FRONTERA_INTERVENCION_VISIBLE_1 safety validator, validarMaterializacion)
//     -- realizadorProdujoSalida IS that already-computed, already-gated
//     signal; this function never recomputes or loosens it;
//   - RESPONSE_GOVERNED_TRANSITION_VISIBLE_COMMIT (C007,
//     PREVIOUS_ACT_RESPONSE_GOVERNANCE_BLOCKED_BY_NO_CURRENT_ACT, real
//     evidence: logistica_c0 turn 24) -- a turn whose entire cognitive job
//     is a VERIFIED response to a previously frozen canonical act needs no
//     current WHAT to legitimately commit a visible acknowledgement of
//     whatever state effect that verified response already authorized
//     (a grammar advance, or none -- this predicate never looks at
//     avanzaReal; VALID_GOVERNED_PREVIOUS_ACT_RESPONSE is the eligibility,
//     not "did it advance"). Real evidence: turn 24 correctly declared
//     busquedaActoCognitivo:NINGUNO_LEGITIMO + gananciaCognitiva:null (no
//     new WHAT -- RESPONSE_VERDICT_MATERIAL_NOT_NEXT_ACT_GAIN's own
//     certified correct shape) and relacionRespuestaDirigida:ATIENDE_OBJETIVO
//     against the frozen turn-23 PROPOSE_MISSION_CLOSURE, verified by
//     validarRelacionRespuestaDirigida -- yet the turn was discarded here as
//     NO_COGNITIVE_ACT_AVAILABLE because CanonicalNextActState (built
//     earlier this turn, before this verified relation existed) had no
//     candidate. STATE_TRANSITION_AUTHORITY != CURRENT_VISIBLE_ACT_AUTHORITY:
//     decidirInteraccion's avanzaReal/gramaticaSiguiente (computed from this
//     SAME verified relation, via interpretarVeredictoRespuestaActoAnterior)
//     already correctly decided the state effect; this predicate only
//     authorizes EXPRESSING it, never decides it.
// AUTHORITY_SOURCE_NOT_TEXT_PRESENCE: deliberately takes no message/text
// parameter at all -- mere presence of decision.mensajeCirculo or
// r.parsed.mensaje is never authority (an ungoverned raw Producer message
// would satisfy a text-presence test too). `respuestaGobernadaVisible` is no
// exception: it is the CALLER's already-verified structural fact (a frozen
// previous act + validarRelacionRespuestaDirigida's own RESULTADO_VERIFICADA
// on THIS turn's relation), never recomputed or loosened here, and never a
// re-reading of raw Producer text. Fail-closed by construction: any other
// combination (DETERMINISTA/PRESERVAR strategy, a TRANSFORMAR attempt whose
// Realizer output never passed its own gates, or no verified previous-act
// response) returns false.
function authorizedVisibleOutputEstaDisponible({
  contratoIntervencionDestino = null, contratoIntervencionMovimiento = null,
  estrategiaParaMaterializar = null, realizadorProdujoSalida = false,
  respuestaGobernadaVisible = false,
} = {}) {
  return !!(
    contratoIntervencionDestino
    || contratoIntervencionMovimiento
    || (estrategiaParaMaterializar === ESTRATEGIAS_MATERIALIZACION.TRANSFORMAR && realizadorProdujoSalida)
    || respuestaGobernadaVisible
  );
}

// BOOTSTRAP_ACQUISITION_YIELD_RELIABILITY / R3 (C007, Daniel-adjudicated,
// faithful-replay-proven -- logistica_c0's two independent bootstrap
// trials). The eligibility gate for BOOTSTRAP_SEMANTICUNKNOWN_TO_
// ACQUISITION_CORRECTION previously used cierreTempranaFueIntentada (mere
// ATTEMPT of the earlier dangling-reference repair) where it needed
// cierreTempranaRestauroPathReal (whether that repair actually restored a
// real path -- oportunidadesRealesTrasCierreTemprana.length>0 ||
// gananciaLegitimaTrasCierreTemprana). Attempting != succeeding: a cierre
// temprana attempt that only produced a synthetic/proxy gain (or nothing)
// still leaves this turn exactly as bootstrap-eligible as no attempt at
// all. This predicate is a pure factoring-out of the real call site's
// expression for isolated testability (same discipline as
// authorizedVisibleOutputEstaDisponible above) -- it changes no conjunct's
// MEANING, only replaces the wrong sibling signal with the correct
// already-existing one. Every other law stays exactly as before: bootstrap
// territory must be admissible this turn, zero compatible candidates must
// already exist, and a real semanticUnknown proposal must be present to
// correct.
function elegibleCorreccionAdquisicionBootstrap({
  cierreTempranaRestauroPathReal = false,
  fronteraCognitivaAdmisibleEsteTurno = [],
  candidatosCompatiblesAntesDeRepair = [],
  semanticUnknownParsed = null,
} = {}) {
  return !cierreTempranaRestauroPathReal
    && (fronteraCognitivaAdmisibleEsteTurno || []).some(f => f && f.tipo === 'BOOTSTRAP_MISSION_NEED')
    && (candidatosCompatiblesAntesDeRepair || []).length === 0
    && !!semanticUnknownParsed && typeof semanticUnknownParsed === 'object';
}

/**
 * Ley de Integridad Cognitiva — extrae el shape de delta que
 * GrafoConocimientoPolicy.aplicarDeltaIntegridad espera, desde la MISMA
 * respuesta parseada de reconciliación (una sola llamada al LLM produce
 * ambos deltas — nunca una llamada aparte).
 */
function deltaIntegridadDesdeParsed(parsed) {
  return {
    conocimientoRefinado: parsed.conocimientoRefinado,
    conocimientoContradicho: parsed.conocimientoContradicho,
  };
}

// Reintentos acotados contra el LLM cuando la salida no cumple el contrato
// por estado (Incremento 3, distinto de los reintentos de LLMService por
// fallo de transporte/parseo). Hasta 2 reintentos ⇒ 3 intentos totales.
const MAX_CONTRATO_RETRIES = 2;

// DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — retryable solo cuando es
// determinable a partir de LLMErrorTaxonomy (nunca adivinado por texto
// libre). Transitorio (reintentar el MISMO turnoClienteId puede terminar en
// éxito): truncamiento por presupuesto, transporte, cuota. No transitorio
// (reintentar con el mismo mensaje no cambia el resultado): el modelo
// configurado no existe/no responde, o la respuesta no cumple el contrato
// JSON de forma persistente. `null` cuando no hay errorCategory que evaluar
// — nunca se infiere false por defecto.
function retryableDesdeErrorCategory(errorCategory) {
  if (!errorCategory) return null;
  if ([
    ERROR_CATEGORIES.MODEL_RESPONSE_TRUNCATED,
    ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR,
    ERROR_CATEGORIES.QUOTA_OR_RATE_LIMIT,
  ].includes(errorCategory)) return true;
  return false;
}


/**
 * S1_R_INCREMENTO_3 — traduce, sin ninguna lectura del grafo (solo
 * reetiquetado de campos ya durables en AfirmacionTransformacionalDestino),
 * los `conceptoIds` de los cuatro constituyentes de una Afirmación hacia el
 * shape `roles` que HipotesisTransformacionalDestino exige — únicamente
 * para SEMBRAR la memoria negativa (nunca para crear ni persistir ninguna
 * Hipótesis real, ver sembrarMemoriaNegativaDesdeRegistroDurable). `null`
 * cuando la Afirmación no puede traducirse fielmente (modoObservabilidad
 * INTEGRADA_EN_RESULTADO no tiene un constituyente de observabilidad propio
 * que HipotesisTransformacionalDestino.roles.observabilidadConceptoIds
 * exige no-vacío — caso fuera de alcance de este incremento; la ausencia de
 * esta siembra puntual nunca bloquea el turno, ver call site) — nunca se
 * fabrica un array vacío ni inventado.
 */
function derivarRolesDesdeConstituyentesAfirmacion(afirmacion) {
  if (!afirmacion || !afirmacion.constituyentes) return null;
  const { inicio, mecanismo, resultado, observabilidad } = afirmacion.constituyentes;
  if (!inicio || !mecanismo || !resultado || !observabilidad) return null;
  const conceptoIdsDe = constituyente => (constituyente.conceptoIds || []);
  if ([inicio, mecanismo, resultado, observabilidad].some(c => conceptoIdsDe(c).length === 0)) return null;
  return {
    inicioConceptoIds: [...conceptoIdsDe(inicio)],
    mecanismoConceptoIds: [...conceptoIdsDe(mecanismo)],
    resultadoConceptoIds: [...conceptoIdsDe(resultado)],
    observabilidadConceptoIds: [...conceptoIdsDe(observabilidad)],
  };
}

// DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 — mismo mapeo que
// DIMENSION_A_CAMPO_ROL (CicloHipotesisTransformacionalDestinoOrquestacion.js),
// deliberadamente duplicado (mismo criterio documentado ahí: el mapeo
// dimensión→rol es un hecho estable del dominio, no una dependencia entre
// capacidades). Traduce la `dimension` que Capa 1 declara para
// 'corrige'+ambito_correccion='concepto' (VALIDANDO_RELACION_TRANSFORMACIONAL)
// al campoRol de HipotesisTransformacionalDestino.roles que
// construirReferenciasPorRolDestino/exclusionesPorRol ya entienden.
const DIMENSION_A_CAMPO_ROL_HIPOTESIS = Object.freeze({
  antes: 'inicioConceptoIds', conocimiento: 'mecanismoConceptoIds',
  despues: 'resultadoConceptoIds', evidencia: 'observabilidadConceptoIds',
});

// HERENCIA_FOCAL_NO_DEMOSTRABLE_NO_PUEDE_DEGRADAR_A_RECALCULO_SILENCIOSO —
// mensaje determinista (nunca generado por LLM, mismo criterio que
// mensajeDeterministaCandidataIncompatible en
// ValidacionRelacionTransformacionalDestinoCasoDeUso.js): cuando una
// corrección focal no puede demostrar la base heredable de sus roles no
// afectados (ni persistida, ni recuperable por identidad exacta), el
// sistema nunca improvisa una pregunta genérica ni reconstruye por
// aproximación — pide, explícitamente, reconstruir la propuesta completa.
function mensajeDeterministaBaseHeredableNoRecuperable() {
  return 'No puedo reconstruir automáticamente las partes de esta Hipótesis que no corregiste todavía -- necesito volver a armar la propuesta completa contigo antes de continuar.';
}

// DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — mensaje determinista (nunca
// generado por LLM, mismo criterio que mensajeDeterministaBaseHeredableNoRecuperable/
// mensajeDeterministaCandidataIncompatible): cuando el experto ya expresó
// una intención de cierre real (P1-A/protocoloIntencionCierre ACTIVA o
// BLOQUEADA_POR_DEUDA_DURA) y todavía existe una incertidumbre relevante
// abierta (única deuda que este mensaje sigue cubriendo -- ver corrección
// final más abajo para deudas de tipo DIMENSION_SIN_EVIDENCIA, ahora
// consolidadas en una sola pregunta final, nunca una por turno), Círculo
// reconoce el cierre y pide EXACTAMENTE la pregunta real que resolvería esa
// incertidumbre — nunca lo que Capa 1/el flujo legado hubiera preguntado
// libremente.
function mensajeDeterministaDeudaDuraConCierreActivo(deudaPrioritaria) {
  if (deudaPrioritaria && deudaPrioritaria.tipo === 'INCERTIDUMBRE_RELEVANTE_ABIERTA' && deudaPrioritaria.preguntaDeResolucion) {
    return `Antes de cerrar, me falta una sola cosa: ${deudaPrioritaria.preguntaDeResolucion}`;
  }
  // FRONTERA_INTERVENCION_VISIBLE_1 (BLOCKER A — AUTORIDAD_DE_LENGUAJE_DE_
  // DIMENSIONES) -- FRASE_NATURAL_DEUDA_DESTINO (abajo), nunca SLOT_LABELS:
  // este site leía el label interno crudo directamente, dejando "esto"
  // como único resguardo -- la misma clase de agujero que la trayectoria
  // humana 3 encontró en el fallback F1 de Movimiento.
  const etiqueta = (deudaPrioritaria && FRASE_NATURAL_DEUDA_DESTINO[deudaPrioritaria.dimension]) || 'esto';
  return `Antes de cerrar, me falta lo esencial sobre ${etiqueta} -- ¿qué dirías al respecto?`;
}

// DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — presupuesto de
// pregunta final consolidada) — frases naturales por dimensión de DESTINO,
// DELIBERADAMENTE distintas de SLOT_LABELS: SLOT_LABELS son nombres
// internos del sistema ("Después", "Evidencia", "La estrella...") -- el
// smoke real con Gemini demostró que exponerlos en la pregunta final
// contradice "la pregunta debe ser comprensible sin conocer la
// arquitectura". Exclusivo de gramática 'destino' -- el único alcance de
// este mecanismo (ver deudasFinalesSnapshot/DIMENSION_SIN_EVIDENCIA).
const FRASE_NATURAL_DEUDA_DESTINO = Object.freeze({
  antes: 'cómo era la situación antes',
  conocimiento: 'qué hiciste concretamente para lograrlo',
  despues: 'qué cambió gracias a esa experiencia',
  evidencia: 'cómo sabes que realmente funcionó',
});

function listarNaturalmente(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * Pregunta final ÚNICA y consolidada -- cubre TODAS las dimensiones del
 * snapshot original en una sola intervención, nunca una por turno (el
 * defecto real que este incremento corrige: dos preguntas consecutivas,
 * "Después" y luego "Evidencia", cada una con el nombre interno del slot).
 * `dimensiones` son las que TODAVÍA están pendientes (puede ser un
 * subconjunto del snapshot original, si una respuesta parcial ya resolvió
 * alguna) -- nunca dimensiones fuera de ese snapshot.
 */
function mensajeDeterministaPreguntaFinalConsolidada(dimensiones) {
  const frases = (dimensiones || []).map(dim => FRASE_NATURAL_DEUDA_DESTINO[dim] || dim).filter(Boolean);
  if (frases.length <= 1) {
    return `Antes de cerrar, me falta una cosa: ${frases[0] || 'lo esencial'}. ¿Qué dirías al respecto?`;
  }
  const cantidad = frases.length === 2 ? 'dos cosas' : `${frases.length} cosas`;
  return `Antes de cerrar, me faltan ${cantidad}: ${listarNaturalmente(frases)}. ¿Qué dirías de cada una?`;
}

// DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — PRESUPUESTO_
// CONSUMIDO_REEMITE_LA_PREGUNTA_FINAL) — el hallazgo real del smoke: una
// respuesta ambigua o parcial, en el turno SIGUIENTE al que ya consumió el
// presupuesto de pregunta final, seguía mostrando la MISMA pregunta
// consolidada (con signo de interrogación) -- una segunda emisión visible
// de una intervención final que, por definición, solo puede emitirse una
// vez. A partir de aquí, cualquier turno donde el ciclo YA estaba abierto
// (nunca el turno que lo abre, ese conserva su única pregunta interrogativa
// -- ver mensajeDeterministaPreguntaFinalConsolidada) usa esta función:
// un ESTADO declarativo, nunca una pregunta -- ni la misma, ni reformulada,
// ni lateral. `deudasResueltasEsteTurno` son las que este turno
// específicamente resolvió (diff contra lo ya resuelto en turnos
// anteriores) -- `[]` si la respuesta fue ambigua/no aportó nada del
// snapshot. `deudasPendientes` es lo que TODAVÍA falta del snapshot
// original -- nunca se amplía.
function mensajeDeterministaEstadoPreguntaFinalConsolidada(deudasResueltasEsteTurno, deudasPendientes) {
  const frasesPendientes = (deudasPendientes || []).map(dim => FRASE_NATURAL_DEUDA_DESTINO[dim] || dim).filter(Boolean);
  const pendienteTexto = frasesPendientes.length <= 1
    ? (frasesPendientes[0] || 'lo esencial')
    : listarNaturalmente(frasesPendientes);
  const frasesResueltas = (deudasResueltasEsteTurno || []).map(dim => FRASE_NATURAL_DEUDA_DESTINO[dim] || dim).filter(Boolean);
  const prefijo = frasesResueltas.length > 0
    ? `Entendí ${listarNaturalmente(frasesResueltas)}. `
    : '';
  return `${prefijo}Para cerrar con precisión todavía falta ${pendienteTexto}. Puedes añadirlo en tu próximo mensaje o cerrar con lo que ya tenemos.`;
}

// DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final —
// CITA_LITERAL_ESPECIFICA_NO_EQUIVALE_A_CORRECCION_DEL_CONCEPTO) — ÚNICA
// política reutilizable para toda mutación DESTRUCTIVA (desactiva o
// invalida conocimiento ya establecido) propuesta mientras un ciclo de
// cierre está en curso -- nunca un gate distinto por mecanismo. Ronda
// anterior: exigía que "porQue" fuera un fragmento LITERAL del mensaje, y
// que ese fragmento no fuera el mensaje completo -- el smoke real demostró
// que eso es NECESARIO pero no SUFICIENTE: una cita corta, literal y
// totalmente ajena al concepto todavía aprobaba la mutación, porque la
// única autoridad era la propia declaración del productor que la proponía.
//
// Regla: dentro del snapshot (`ambitoMutacionCierre`), cualquier mutación
// se autoriza sin más (ya es la deuda que se está resolviendo). Fuera del
// snapshot: (1) prefiltro estructural determinista (nunca invoca el LLM si
// falla -- ver ValidadorSemanticoMutacionConcepto.prefiltroEstructuralMutacion);
// (2) si pasa, adjudicación por un validador GENUINAMENTE distinto del
// productor (una llamada LLM separada, de solo lectura, que nunca puede
// proponer mutaciones) -- se acepta la mutación solo si esa adjudicación
// resulta VALIDADA, sobre el MISMO concepto, con el MISMO tipo de impacto
// propuesto, y validadorDistintoDelProductor===true. Cualquier otro
// resultado (NO_VALIDADA, INCONCLUSA, discordancia de concepto o de
// impacto) falla cerrado: nunca se asume autorización por defecto.
//
// Durabilidad: cada adjudicación se persiste bajo una identidad estable
// (sesión+turno de origen+concepto+impacto+hash de evidencia) en
// state.protocoloAutoridadesMutacionValidadas -- reutilizada (nunca
// re-llamada) si la MISMA identidad vuelve a aparecer, sea en un retry
// dentro del mismo turno (memo en `cacheValidacionesEsteTurno`, en memoria,
// scope de una sola ejecución de writer.procesar()) o en un turno posterior
// / tras reinicio del proceso (memo durable, `autoridadesPrevias`).
//
// @param {object} params
// @param {Set<string>|null} params.ambitoMutacionCierre
// @param {object} params.grafoActual — KnowledgeGraph contra el que se
//   resuelve la dimensión de cada concepto afectado (el grafo tal como
//   entró este turno, verdaderamente-antes de la mutación propuesta).
// @param {string} params.mensajeUsuario
// @param {Array<{id:string, porQue?:string}>} params.mutacionesPropuestas
// @param {string} params.origen — 'CONSTRUCCION' | 'RECONCILIACION_HISTORICA'
//   | cualquier productor futuro -- solo para trazabilidad, nunca cambia
//   la regla aplicada.
// @param {string} params.tipoImpactoPropuesto — CORRIGE|RECHAZA|REEMPLAZA|
//   DECLARA_NO_VIGENTE — decidido por el LLAMADOR según el mecanismo
//   concreto (marcarObsoletos→DECLARA_NO_VIGENTE, conocimientoContradicho/
//   inferenciasRechazadas→RECHAZA), nunca inferido aquí por heurística.
// @param {object} params.llmService — para la adjudicación semántica.
// @param {string} params.sesionId
// @param {string} params.turnoOrigenId
// @param {Array<object>} [params.autoridadesPrevias] — protocoloAutoridadesMutacionValidadas
//   ya persistido (durable, de turnos/procesos anteriores).
// @param {Map<string,object>} [params.cacheValidacionesEsteTurno] — memo en
//   memoria, scope de UNA ejecución de writer.procesar() (evita repetir la
//   llamada entre reintentos del mismo productor dentro del mismo turno).
// @returns {Promise<{ autorizadas: Array, noAutorizadas: Array<{id, dimension, porQue, origen, codigoRazon}>, autoridadesNuevas: Array<object> }>}
async function validarMutacionesDestructivasBajoCierre({
  ambitoMutacionCierre, grafoActual, mensajeUsuario, mutacionesPropuestas, origen,
  tipoImpactoPropuesto, llmService, sesionId, turnoOrigenId,
  autoridadesPrevias = [], cacheValidacionesEsteTurno = null,
  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 3) — identidad interna
  // reservada en admisión, solo para correlación de eventos llm.*.
  turnoId = null,
}) {
  const lista = Array.isArray(mutacionesPropuestas) ? mutacionesPropuestas : [];
  if (!ambitoMutacionCierre) return { autorizadas: lista, noAutorizadas: [], autoridadesNuevas: [] };
  const autorizadas = [];
  const noAutorizadas = [];
  const autoridadesNuevas = [];
  for (const item of lista) {
    if (!item || typeof item.id !== 'string') { autorizadas.push(item); continue; }
    const concepto = grafoActual.conceptos.find(c => c.id === item.id);
    if (!concepto) { autorizadas.push(item); continue; } // id inexistente: la validación normal del productor ya lo maneja
    const dimension = dimensionDeProcedencia(concepto.procedencia);
    if (ambitoMutacionCierre.has(dimension)) { autorizadas.push(item); continue; } // dentro del snapshot: autorizada

    const prefiltro = prefiltroEstructuralMutacion({
      concepto, dimensionAfectada: dimension, tipoImpactoPropuesto,
      evidenciaTextual: item.porQue, mensajeUsuario, origenProductor: origen,
      turnoOrigenId, esDestructiva: true,
    });
    if (!prefiltro.pasa) {
      noAutorizadas.push({ id: item.id, dimension, porQue: (item.porQue || null), origen, codigoRazon: prefiltro.razon });
      continue;
    }

    const identidad = identidadValidacionMutacion({
      sesionId, turnoOrigenId, conceptoAfectadoId: concepto.id, tipoImpactoPropuesto, evidenciaTextual: item.porQue,
    });

    let veredicto = autoridadesPrevias.find(a => a.identidad === identidad);
    if (!veredicto && cacheValidacionesEsteTurno && cacheValidacionesEsteTurno.has(identidad)) {
      veredicto = cacheValidacionesEsteTurno.get(identidad);
    }
    if (!veredicto) {
      const resultado = await validarSemanticamenteMutacion({
        llmService, concepto, dimensionAfectada: dimension, tipoImpactoPropuesto,
        evidenciaTextual: item.porQue, mensajeUsuario, turnoOrigenId, origenProductor: origen,
        turnoId,
      });
      veredicto = { ...resultado, identidad };
      if (cacheValidacionesEsteTurno) cacheValidacionesEsteTurno.set(identidad, veredicto);
      autoridadesNuevas.push(veredicto);
    }

    const aceptar = decidirAceptacionMutacion(veredicto, concepto.id, tipoImpactoPropuesto);

    if (aceptar) autorizadas.push(item);
    else noAutorizadas.push({ id: item.id, dimension, porQue: (item.porQue || null), origen, codigoRazon: veredicto.codigoRazon || veredicto.resultado });
  }
  return { autorizadas, noAutorizadas, autoridadesNuevas };
}

// DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — GOBERNANZA_DELTA_DIMENSIONAL.
//
// Frontera acordada: GENERADOR → DELTA_PROPUESTO → GOBERNANZA_DELTA_DIMENSIONAL
// (esta función) → DELTA_AUTORIZADO → aplicarDelta. aplicarDelta conserva su
// responsabilidad actual (transportar fielmente un delta ya autorizado) —
// esta función corre ANTES, sobre conceptosNuevos crudos, y decide la
// `procedencia` GOBERNADA de cada uno antes de que lleguen a aplicarDelta.
//
// Camino concordante (barato, sin segunda llamada LLM): cuando no hay
// objetivo vigente (nada que contrastar), o la dimensión propuesta por el
// generador coincide con el objetivo vigente, SIN señal de contradicción
// (relacionRespuestaDirigida declarando mezcla/otra dimensión/cambio de
// tema) ni señal de solapamiento textual con otro concepto del mismo lote.
//
// Camino divergente: cualquiera de --  dimensión propuesta != objetivo
// vigente; relacionRespuestaDirigida divergente; señal de solapamiento entre
// conceptos del mismo lote -- dispara UNA llamada al adjudicador
// (ValidadorSemanticoDeltaConceptos), por lote (no por concepto), read-only,
// nunca capaz de producir/mutar. autoridadGobernanzaDimension registra
// explícitamente qué camino gobernó cada concepto: CONCORDANTE |
// SIN_OBJETIVO_VIGENTE | ADJUDICADA_CONFORME | ADJUDICADA_RECLASIFICADA |
// NO_RESUELTA.
//
// Fail-closed semántico (nunca fail-closed de turno): un concepto que el
// adjudicador no pudo resolver, o que falló por transporte/parseo, se
// PRESERVA con procedencia = procedenciaNoResuelta(turnoOrigenId) (sentinel
// que dimensionDeProcedencia nunca reconoce como slot real -- Ley de
// Degradación: conserva evidencia, nunca cuenta para suficiencia, nunca
// alimenta un rol dimensional de Hipótesis, nunca se proyecta en un slot
// falso -- sin que ningún consumidor existente necesite cambiar una línea).
//
// Duplicación: SOLO el adjudicador puede declarar identidadRespectoA (misma
// extracción citada dos veces) -- nunca una heurística de substring por su
// cuenta. La señal de solapamiento textual (aquí, determinista) únicamente
// DISPARA la revisión del adjudicador; jamás decide por sí sola.
//
// @param {Array<object>} params.conceptosPropuestos — delta.conceptosNuevos crudo, tal cual el generador
// @param {string|null} params.objetivoSolicitado — dimensión objetivo vigente este turno (o null)
// @param {object|null} params.relacionRespuestaDirigidaDeclarada — r.parsed.relacionRespuestaDirigida, si existe
// @param {string} params.mensajeUsuario
// @param {Array<{clave:string, descripcion:string}>} params.dimensionesLegales
// @param {object} params.llmService
// @param {string} params.sesionId
// @param {string} params.turnoOrigenId
// @returns {Promise<{ conceptosGobernados: Array<object>, traza: Array<object> }>}
async function gobernarDimensionDeltaConceptos({
  conceptosPropuestos, objetivoSolicitado, relacionRespuestaDirigidaDeclarada,
  mensajeUsuario, dimensionesLegales, llmService, sesionId, turnoOrigenId,
  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 3) — identidad interna
  // reservada en admisión, solo para correlación de eventos llm.*.
  turnoId = null,
}) {
  const lista = Array.isArray(conceptosPropuestos) ? conceptosPropuestos : [];
  if (lista.length === 0) return { conceptosGobernados: [], traza: [] };

  const items = lista.map((c, i) => ({
    original: c,
    idTemporal: (c && typeof c.idTemporal === 'string' && c.idTemporal) || `sin_id_temporal_${i}`,
    dimensionPropuesta: dimensionDeProcedencia(c && c.procedencia),
  }));

  // Señal de solapamiento — determinista, nunca decide fusión: dos
  // conceptos del mismo lote, misma dimensión propuesta, y la descripción
  // normalizada de uno contiene la del otro.
  const idsConSenalSolapamiento = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.dimensionPropuesta || a.dimensionPropuesta !== b.dimensionPropuesta) continue;
      const da = normalizarParaHashSemantico(a.original.descripcion);
      const db = normalizarParaHashSemantico(b.original.descripcion);
      if (!da || !db || da === db) { if (da === db && da) { idsConSenalSolapamiento.add(a.idTemporal); idsConSenalSolapamiento.add(b.idTemporal); } continue; }
      if (da.includes(db) || db.includes(da)) { idsConSenalSolapamiento.add(a.idTemporal); idsConSenalSolapamiento.add(b.idTemporal); }
    }
  }

  // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 (corrección tras revisión —
  // CONCORDANTE_VIA_RESPUESTA_DIRIGIDA fue un error arquitectónico, revertido).
  // T-DIM2/relacionRespuestaDirigida es autoridad/coherencia a NIVEL TURNO
  // ("¿qué relación tuvo la respuesta con lo solicitado?") -- NUNCA
  // sustituye la evaluación a NIVEL CONCEPTO ("¿qué dimensión puede adquirir
  // ESTE concepto como verdad durable?"). Son dos responsabilidades
  // distintas, reutilizadas juntas (relacionRespuestaDirigidaDeclarada viaja
  // al adjudicador como CONTEXTO, nunca como veredicto — ver
  // buildSystemPromptValidadorDimension), nunca una sustituyendo a la otra.
  // Por tanto: la existencia de un contrato de respuesta dirigida vigente
  // NUNCA exime, por sí sola, la evaluación de un concepto cuya
  // dimensionPropuesta diverge del objetivo.
  const relacionSenalaDivergenciaDeTurno = !!relacionRespuestaDirigidaDeclarada
    && ['MEZCLA_DIMENSIONES', 'APORTA_OTRA_DIMENSION', 'CAMBIA_DE_TEMA'].includes(relacionRespuestaDirigidaDeclarada.relacion);

  const necesitaAdjudicadorPorDimension = (item) => !item.dimensionPropuesta
    || (!!objetivoSolicitado && item.dimensionPropuesta !== objetivoSolicitado)
    || relacionSenalaDivergenciaDeTurno;
  // La señal de solapamiento/duplicación es un concern independiente --
  // T-DIM2 nunca detecta ni gobierna duplicación de conceptos, solo
  // coherencia de dimensión a nivel turno.
  const necesitaAdjudicadorPorSolapamiento = (item) => idsConSenalSolapamiento.has(item.idTemporal);

  const gobernadoPorId = new Map();
  const loteDivergente = [];
  for (const item of items) {
    if (necesitaAdjudicadorPorDimension(item) || necesitaAdjudicadorPorSolapamiento(item)) { loteDivergente.push(item); continue; }
    gobernadoPorId.set(item.idTemporal, {
      dimensionGobernada: item.dimensionPropuesta, identidadRespectoA: null,
      autoridad: objetivoSolicitado ? 'CONCORDANTE' : 'SIN_OBJETIVO_VIGENTE',
    });
  }

  if (loteDivergente.length > 0) {
    const veredicto = await validarSemanticamenteDelta({
      llmService, mensajeUsuario, objetivoSolicitado, relacionRespuestaDirigidaDeclarada,
      dimensionesLegales,
      conceptosPropuestos: loteDivergente.map(item => ({
        idTemporal: item.idTemporal, descripcion: item.original.descripcion, dimensionPropuesta: item.dimensionPropuesta,
      })),
      turnoOrigenId, turnoId,
    });
    for (const item of loteDivergente) {
      const entrada = (veredicto.conceptos || []).find(v => v.idTemporal === item.idTemporal);
      const dimensionGobernada = entrada ? entrada.dimensionGobernada : null;
      const autoridad = !dimensionGobernada ? 'NO_RESUELTA'
        : (dimensionGobernada === item.dimensionPropuesta ? 'ADJUDICADA_CONFORME' : 'ADJUDICADA_RECLASIFICADA');
      gobernadoPorId.set(item.idTemporal, {
        dimensionGobernada, identidadRespectoA: entrada ? entrada.identidadRespectoA : null, autoridad,
      });
    }
  }

  // Identidad: solo el adjudicador la declara. Un concepto marcado como la
  // misma extracción que otro se descarta -- únicamente si el concepto que
  // referencia sigue presente en este mismo lote (nunca a un id ajeno).
  const idsDescartados = new Set();
  for (const [id, g] of gobernadoPorId.entries()) {
    if (g.identidadRespectoA && g.identidadRespectoA !== id && gobernadoPorId.has(g.identidadRespectoA)) {
      idsDescartados.add(id);
    }
  }

  const conceptosGobernados = [];
  const traza = [];
  for (const item of items) {
    const g = gobernadoPorId.get(item.idTemporal) || { dimensionGobernada: null, autoridad: 'NO_RESUELTA', identidadRespectoA: null };
    if (idsDescartados.has(item.idTemporal)) {
      traza.push({
        conceptoIdTemporal: item.idTemporal, objetivoSolicitado, dimensionPropuesta: item.dimensionPropuesta,
        dimensionGobernada: null, resultado: 'DESCARTADO_POR_IDENTIDAD', autoridad: 'IDENTIDAD_ADJUDICADA',
        evidenciaRef: g.identidadRespectoA,
      });
      continue; // nunca se persiste -- la misma extracción ya vive en el concepto referenciado
    }
    const procedenciaFinal = g.dimensionGobernada ? `slot:${g.dimensionGobernada}` : procedenciaNoResuelta(turnoOrigenId);
    conceptosGobernados.push({
      ...item.original,
      procedencia: procedenciaFinal,
      dimensionPropuesta: item.dimensionPropuesta,
      autoridadGobernanzaDimension: g.autoridad,
    });
    traza.push({
      conceptoIdTemporal: item.idTemporal, objetivoSolicitado, dimensionPropuesta: item.dimensionPropuesta,
      dimensionGobernada: g.dimensionGobernada, resultado: g.dimensionGobernada ? 'GOBERNADA' : 'NO_RESUELTA',
      autoridad: g.autoridad, evidenciaRef: null,
    });
  }

  return { conceptosGobernados, traza };
}

/** dimensionesLegales para el adjudicador, con descripción humana -- misma fuente (AgoraSlots.SLOT_DEFINITIONS) que ya usa el resto del sistema para explicar cada dimensión, nunca vocabulario nuevo. */
function dimensionesLegalesDeGramatica(gramatica) {
  return (SLOTS_BY_GRAMATICA[gramatica] || []).map(clave => ({
    clave, descripcion: (SLOT_DEFINITIONS[clave] && SLOT_DEFINITIONS[clave].descripcion) || SLOT_LABELS[clave] || clave,
  }));
}

function mensajeErrorMutacionLateralNoAutorizada(item) {
  return `${item.origen === 'RECONCILIACION_HISTORICA' ? 'conocimientoContradicho/inferenciasRechazadas' : 'marcarObsoletos'}: no podés invalidar el concepto ${item.id} -- pertenece a una dimensión fuera de lo que estás cerrando en este ciclo, y "porQue" no demuestra una corrección explícita y verificable de ESE concepto en este turno. Dejalo activo, o cita textualmente, y de forma específica, dónde el experto lo corrigió.`;
}

// DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (auditoría real V2, caso
// bicicleta: turno 8 propone "despues"=c_kg_..._12 ("dos fuentes dicen cosas
// distintas..."), turno 9 lo rechaza explícito (corrige+concepto+
// dimension="despues"), turno 12 regenera la Hipótesis y REUTILIZA, sin
// cambios, el mismo conceptoId como "despues" — porque
// construirReferenciasPorRolDestino nunca supo que ese concepto ya había
// sido excluido de ESE rol) — mismo Modelo B que S1-R-SCOPE1 (el concepto
// sigue siendo verdad histórica vigente, nunca se invalida ni se borra, solo
// deja de ser candidato para ESE rol), aplicado ANTES de que exista ninguna
// Afirmación autorizada (por eso vive en CognitiveState.
// protocoloExclusionesHipotesisPorRol — ver CognitiveState.js — nunca en
// destino_afirmacion_reparaciones_s1r, que exige una Afirmación real vía FK).
// `null` cuando no hay dimensión localizable o no hay Hipótesis autoritativa
// (nunca se fabrica una entrada a medias).
// Frontera positiva (auditoría del smoke real, bicicleta) — `conceptosPositivosIds`
// (default [], nunca undefined: mismo tipo en las tres ramas de
// estadoCorreccion) y `reemplazoDeclaradoSinMaterializar` (ver
// ValidacionRelacionTransformacionalDestinoCasoDeUso.js) determinan
// estadoCorreccion — nunca lo contrario: el estado se DERIVA de los datos
// reales, jamás se declara aparte de ellos.
function entradaExclusionHipotesisPorRol({
  dimensionConcepto, hipotesisAutoritativa, turnoCorreccionId, evidenciaTextual,
  conceptosPositivosIds = [], reemplazoDeclaradoSinMaterializar = false,
}) {
  const campoRol = DIMENSION_A_CAMPO_ROL_HIPOTESIS[dimensionConcepto];
  if (!campoRol || !hipotesisAutoritativa || !hipotesisAutoritativa.roles) return null;
  const conceptoIds = hipotesisAutoritativa.roles[campoRol];
  if (!Array.isArray(conceptoIds) || conceptoIds.length === 0) return null;
  const estadoCorreccion = conceptosPositivosIds.length > 0
    ? 'REEMPLAZO_MATERIALIZADO'
    : (reemplazoDeclaradoSinMaterializar ? 'REEMPLAZO_DECLARADO_SIN_MATERIALIZAR' : 'SOLO_EXCLUSION');
  // REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS — snapshot congelado, AL
  // MOMENTO DEL RECHAZO, de los cuatro roles de la Hipótesis rechazada
  // (nunca recalculado después): la única fuente que permite, más adelante,
  // heredar EXACTAMENTE las referencias de los roles que esta corrección
  // nunca cuestionó — ver referenciasHeredablesPorRol, más abajo.
  const rolesOriginales = Object.fromEntries(
    Object.values(DIMENSION_A_CAMPO_ROL_HIPOTESIS).map(campo => [campo, [...(hipotesisAutoritativa.roles[campo] || [])]]),
  );
  return {
    campoRol, dimension: dimensionConcepto, conceptoIds: [...conceptoIds],
    hipotesisId: hipotesisAutoritativa.id, hipotesisVersion: hipotesisAutoritativa.version,
    turnoCorreccionId, evidenciaTextual,
    conceptosPositivosIds: [...conceptosPositivosIds], estadoCorreccion, hipotesisSucesoraId: null,
    rolesOriginales,
  };
}

// Frontera positiva, Path B (auditoría del smoke real) — cuando el experto
// declara la exclusión y el reemplazo en MENSAJES SEPARADOS (corrige+concepto
// sin reemplazo_declarado, luego una evidencia normal de EXPLORANDO en un
// turno posterior), la corrección abierta (conceptosPositivosIds todavía
// vacío, estadoCorreccion!=='REEMPLAZO_MATERIALIZADO') se resuelve aquí, en
// el primer turno posterior que materialice un concepto 'experto' activo
// para la MISMA dimensión — criterio puramente ESTRUCTURAL (identidad de
// dimensión, autoridad, vigencia — el mismo criterio ya usado por
// construirReferenciasPorRolDestino para candidatos), nunca heurística
// lexical sobre el texto del turno. Si ninguna corrección abierta coincide,
// o no hay conceptos nuevos este turno, devuelve el array sin cambios (misma
// referencia) — aditivo puro, sin efecto en sesiones sin correcciones
// abiertas.
function resolverAsignacionPositivaAbierta(exclusionesVigentes, conceptosNuevosEsteTurno) {
  if (!Array.isArray(exclusionesVigentes) || exclusionesVigentes.length === 0) return exclusionesVigentes;
  if (!Array.isArray(conceptosNuevosEsteTurno) || conceptosNuevosEsteTurno.length === 0) return exclusionesVigentes;
  let huboCambios = false;
  const actualizado = exclusionesVigentes.map(entrada => {
    if (entrada.estadoCorreccion === 'REEMPLAZO_MATERIALIZADO') return entrada;
    const candidatos = conceptosNuevosEsteTurno.filter(c =>
      c.autoridad === 'experto' && c.activo === true
      && dimensionDeProcedencia(c.procedencia) === entrada.dimension,
    );
    if (candidatos.length === 0) return entrada;
    huboCambios = true;
    return {
      ...entrada,
      conceptosPositivosIds: candidatos.map(c => c.id),
      estadoCorreccion: 'REEMPLAZO_MATERIALIZADO',
    };
  });
  return huboCambios ? actualizado : exclusionesVigentes;
}

// Fusiona (unión por campoRol) las exclusiones ya durables en CognitiveState
// (protocoloExclusionesHipotesisPorRol — DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1)
// con una exclusión S1-R puntual ({campo,ids}|null, ver
// exclusionesResultadoPorReparacion) en el ÚNICO shape que
// construirReferenciasPorRolDestino ya entiende: `{ campoRol: Set<conceptoId> }`.
// `[]`/`null` reproduce el comportamiento anterior byte a byte.
function fusionarExclusionesPorRol(entradasCognitiveState, exclusionS1R) {
  const mapa = {};
  (entradasCognitiveState || []).forEach(entrada => {
    if (!mapa[entrada.campoRol]) mapa[entrada.campoRol] = new Set();
    entrada.conceptoIds.forEach(id => mapa[entrada.campoRol].add(id));
  });
  if (exclusionS1R && exclusionS1R.campo && exclusionS1R.ids) {
    if (!mapa[exclusionS1R.campo]) mapa[exclusionS1R.campo] = new Set();
    exclusionS1R.ids.forEach(id => mapa[exclusionS1R.campo].add(id));
  }
  return Object.keys(mapa).length > 0 ? mapa : null;
}

// S1-R-SCOPE1 (auditoría: la Hipótesis sucesora de a4r_confirmacion
// reutilizó, sin cambios, el conceptoId de "resultado" que la reparación
// S1-R ABIERTA ya cuestionaba) — Modelo B: mientras exista una reparación
// ABIERTA sobre la Afirmación origen de esta sesión, el/los conceptoId que
// ocupaban el rol cuestionado dejan de ser candidatos admisibles para ESE
// mismo rol (nunca para otro rol, nunca para otra sesión, nunca se
// desactivan ni se borran).
//
// Qué rol se excluye lo decide `reparacionAbierta.componenteRelacional`
// (mismo vocabulario que VALIDANDO_RELACION_TRANSFORMACIONAL ya usa —
// nunca heurística léxica): MECANISMO_RESULTADO excluye el rol "resultado"
// (el mecanismo→resultado quedó cuestionado); RESULTADO_OBSERVABILIDAD
// excluye el rol "observabilidad" (la evidencia quedó cuestionada, el
// resultado en sí permanece disponible — caso real: test_s1r_incremento4,
// donde la corrección aportó evidencia nueva sin tocar el resultado).
//
// `null`/ausente (veredicto que no lo declaró, o reparación abierta antes
// de este incremento — ver migración en SqliteAfirmacionTransformacionalDestinoRepository.js)
// usa el default v1, documentado y deliberado: MECANISMO_RESULTADO — mismo
// criterio que el comentario original de abrirReparacionS1R ("rechazo de
// una Afirmación AUTORIZADA con alcance RELACION" — la Afirmación culmina
// en su resultado). Este default es exactamente lo que protege, sin
// modificar la SQLite real, la reparación ya abierta de `a4r_confirmacion`
// (ver Fase 8 de la auditoría S1-R-SCOPE1).
function exclusionesResultadoPorReparacion(reparacionAbierta, afirmacionOrigen) {
  if (!reparacionAbierta) return null;
  const roles = derivarRolesDesdeConstituyentesAfirmacion(afirmacionOrigen);
  if (!roles) return null;
  const componente = reparacionAbierta.componenteRelacional;
  const campoAfectado = componente === 'resultado_observabilidad' ? 'observabilidadConceptoIds' : 'resultadoConceptoIds';
  const ids = roles[campoAfectado];
  if (!ids || ids.length === 0) return null;
  return { campo: campoAfectado, ids: new Set(ids) };
}

// circulomejora006_act10k — DIMENSIONES_POR_COMPONENTE_RELACIONAL: mapeo
// componente relacional ↔ dimensiones DESTINO involucradas (mecanismo↔
// conocimiento, resultado↔despues, observabilidad↔evidencia — mismo mapeo
// rol↔dimensión que el resto del ciclo de HipotesisTransformacionalDestino
// ya usa, nunca redefinido aquí). Sirve dos propósitos, ambos exclusivos de
// EXPLORANDO+destino+protocoloObjetivoRelacionalDirigido activo:
//   1. ensanchar el vocabulario válido de next_user_action.objetivo mientras
//      el objetivo dirigido esté activo (mismo mecanismo que ya ensancha
//      slotsFaltantesAntes para dimensionesElegiblesNoAtendidas/interpretación
//      pendiente/reparaciones, más abajo) — para que una pregunta dirigida a
//      la reparación nunca sea rechazada por apuntar a una dimensión que
//      GrafoProyeccion ya considera "cubierta";
//   2. localizar, en vivo, el contenido vigente de los conceptos
//      involucrados (nunca un snapshot persistido — "no persistencia
//      nueva", ver construirComponenteLegibleParaObjetivoRelacional).
const DIMENSIONES_POR_COMPONENTE_RELACIONAL = Object.freeze({
  mecanismo_resultado: Object.freeze({ desde: 'conocimiento', hacia: 'despues' }),
  resultado_observabilidad: Object.freeze({ desde: 'despues', hacia: 'evidencia' }),
});

/**
 * circulomejora006_act10k — construye, en vivo, el contenido legible (nunca
 * un snapshot persistido) de los conceptos vigentes en las dos dimensiones
 * que participan del componente relacional cuestionado. Nunca reconstruye
 * la hipótesis rechazada ni asume su identidad — solo lee, del grafo
 * ACTUAL, qué sostiene cada dimensión hoy (mismo mecanismo de lectura que
 * ya usa el resto de EXPLORANDO — conceptosDeGramatica ya filtra activo).
 * Si una dimensión no tiene ningún concepto activo todavía, ese lado queda
 * vacío — el bloque de AgoraPrompts (construirBloqueExploracionDirigidaRelacional)
 * sigue funcionando solo con el nombre del componente.
 */
function construirComponenteLegibleParaObjetivoRelacional(grafo, gramatica, componenteRelacional) {
  const mapeo = DIMENSIONES_POR_COMPONENTE_RELACIONAL[componenteRelacional];
  if (!mapeo) return null;
  const conceptos = conceptosDeGramatica(grafo, gramatica);
  const proyectarLado = dimension => conceptos
    .filter(c => dimensionDeProcedencia(c.procedencia) === dimension)
    .map(c => ({ conceptoId: c.id, contenido: c.descripcion }));
  return { desde: proyectarLado(mapeo.desde), hacia: proyectarLado(mapeo.hacia) };
}

/**
 * Construye un objeto con la misma forma que GatePolicy.evaluateGramatica
 * devuelve, pero producido por el veredicto de ProgresoConversacionalPolicy
 * bajo V2 — para que el evento gate.approved/gate.rejected (auditoría ya
 * existente, leída por herramientas y pruebas previas) siga teniendo el
 * mismo shape sin importar qué autoridad decidió. El campo `gate` distingue
 * el origen: nunca dice 'gramatica_completa' (eso implicaría GatePolicy).
 */
function gateDesdeProtocolo(avanza, gramatica, detalle) {
  return Object.freeze({
    outcome: avanza ? GATE_OUTCOMES.APPROVED : GATE_OUTCOMES.REJECTED,
    gate: 'protocolo_conversacional', etapa: gramatica, bloqueante: true,
    razon: detalle, detalles: [],
  });
}

/**
 * Decide el resultado de la interacción a partir de la respuesta YA
 * PARSEADA del LLM. Pura: no toca repositorios, no emite eventos.
 *
 * Orden de efectos (Incremento 2, aprobado):
 *   1. cargar estado previo           → responsabilidad del llamador (state)
 *   2. invocar LLM / consumir result. → responsabilidad del llamador (parsed)
 *   3. validar y sintetizar slots     → bloque "síntesis de slots" abajo
 *   4. calcular cobertura resultante  → validateGramaticaComplete tras sintetizar
 *   5. ejecutar ProgresoConversacionalPolicy
 *   6. resolver next_user_action o fallback → dentro del mismo decidirProtocolo
 *   7. componer mensajeFinal          → componerMensajeFinal
 *   8. persistir todos los efectos    → _confirmarInteraccion (fuera de esta función)
 *   9. devolver la respuesta HTTP     → _procesarBajoExclusividad (fuera de esta función)
 */
function decidirInteraccion({
  state, gramaticaActivaAlInicio, parsed, protocolV2Enabled = false,
  // Incremento 1 (Grafo de Conocimiento vivo): knowledgeGraphEnabled activa
  // este camino SOLO junto con protocolV2Enabled (matriz de flags aprobada
  // — KG=ON/V2=OFF se rechaza en bootstrap, nunca llega aquí). grafoDelta
  // es el resultado YA aplicado y validado por el llamador (retry loop de
  // contrato en _procesarBajoExclusividad) — esta función no vuelve a
  // llamar aplicarDelta, se mantiene pura y sin I/O.
  knowledgeGraphEnabled = false, grafoDelta = null,
  // circulomejora006 (tercera verificación, Sección C3 — Opción B):
  // EXCLUSIVO de DESTINO+EXPLORANDO+Movimiento activo. Cuando es true,
  // `r.parsed.mensaje` (el llamador ya lo dejó así, sea por el Realizador
  // — intervencionCompleta — o por la plantilla determinista de
  // REPARAR_TRAS_RECHAZO) ES la intervención visible completa de este
  // turno — nunca se le anexa nada más. `dimensionEnFocoNuevo` es la
  // MISMA dimensión, ya decidida por Movimiento post-construcción, que
  // gobernó esa redacción — se conserva solo como dato derivado de
  // observabilidad/telemetría (nunca de Capa 1), igual que ya permite el
  // propio next_user_action.resuelta para cualquier otro turno.
  movimientoRigeMaterializacion = false, dimensionEnFocoNuevo = null,
  movimientoAutoridad = null,
  contratoIntervencionMovimiento = null,
  objetivoConversacional = null,
  // Marcador explícito de la autoridad cognitiva.  `null` significa que
  // este turno no tiene ningún acto legítimo y no debe compilarse como
  // movimiento/contrato visible; `undefined` conserva callers legacy.
  actoCognitivoSeleccionado = undefined,
  oportunidadesConversacionales = [],
  historialVisibleReciente = [],
  // FRONTERA_INTERVENCION_VISIBLE_1 — distinto de movimientoRigeMaterializacion:
  // GobernanzaMaterializacion.js (Transformar/Determinista/Preservar) NO
  // promete que r.parsed.mensaje sea la intervención COMPLETA (next_user_action
  // sigue componiéndose aparte, normalmente) — solo promete que ese mensaje
  // ya es la salida validada/segura que decidió, así que esta frontera debe
  // dejarlo intacto (nunca reconstruir un contrato encima), pero SIN activar
  // el nulling de nextUserAction.texto de arriba (eso es exclusivo del
  // contrato "intervención completa" de Movimiento).
  gobernanzaMaterializacionRigeEsteTurno = false,
  reparacionesInterpretativasPendientes = [],
  dimensionesInterpretacionDiferida = [],
  // circulomejora006_act10l — precalculado por el llamador ANTES de esta
  // llamada (_procesarBajoExclusividad), nunca aquí: evaluarEstadoRelacionTransformacionalDestino
  // tiene un efecto real (registro en emisionesLegitimas cuando corresponde)
  // que esta función, documentada como pura ("no toca repositorios, no
  // emite eventos"), no puede ejecutar por sí misma — recibe el resultado
  // YA RESUELTO como dato, igual que grafoDelta arriba. `null` (default)
  // reproduce el contrato anterior a este incremento byte a byte: cuando es
  // null y el objetivo dirigido sigue activo, se asume 'BLOQUEADA_SIN_SENAL_NUEVA'
  // (mismo valor estático que ya usaba act10k, nunca peor que antes).
  relacionTransformacionalEstadoPrecalculado = null,
  diagnosticoEstructuralTransformacional = null,
  // Proyección plana (proyectarHipotesisParaEstado) de la nueva hipótesis,
  // SOLO cuando relacionTransformacionalEstadoPrecalculado==='CANDIDATA_DISPONIBLE'
  // — nunca la entidad autoritativa completa (esta función nunca la toca).
  nuevaHipotesisRelacionalProyeccion = null,
  // CERRAR_FIDELIDAD_DE_SINTESIS_DE_DESTINO — precalculado por el llamador
  // ANTES de esta llamada (misma disciplina que relacionTransformacionalEstadoPrecalculado
  // arriba: producirSintesisDestinoAutorizadaDesdeRepositorio solo LEE
  // repositorios reales, sin efecto que mutar, pero esta función se mantiene
  // pura de todos modos — nunca I/O aquí). `null` (default) reproduce el
  // contrato anterior byte a byte: sin síntesis autorizada disponible,
  // mensajeBase sigue viniendo de Capa 1/Realizador exactamente como antes.
  sintesisDestinoAutorizadaPrecalculada = null,
  // S1: la candidata canónica fue localizada pero quedó excluida antes de
  // Dirección. La decisión pura no puede abrir un ciclo de síntesis
  // source-less en su lugar.
  sintesisDestinoNoElegiblePrecalculada = false,
  // S1_R_INCREMENTO_2 — precalculado por el llamador ANTES de esta llamada
  // (misma disciplina que sintesisDestinoAutorizadaPrecalculada arriba):
  // no-null EXCLUSIVAMENTE cuando este turno es un rechazo con
  // ambito_correccion==="relacion" bajo DESTINO moderno Y la identidad de
  // la Afirmación+Presentación mostrada ya fue reconfirmada, en vivo,
  // contra el repositorio (ver _procesarBajoExclusividad). `null` (default)
  // reproduce el contrato anterior byte a byte — ningún override de estado,
  // ninguna apertura de reparación.
  aperturaS1RPrecalculada = null,
  // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (orquestación de cierre —
  // ABIERTO_BLOQUEADO_POR_INCONSISTENCIA_DE_PREPARACION) — precalculado por
  // el llamador ANTES de esta llamada (misma disciplina que
  // relacionTransformacionalEstadoPrecalculado arriba): true únicamente
  // cuando la intención de cierre ya declaró su snapshot sin deudas
  // pendientes (P1-B, protocoloIntencionCierre) Y ninguna deuda prioritaria
  // de tipo REPARACION/VEREDICTO_INTERPRETACION/INCERTIDUMBRE_RELEVANTE_ABIERTA
  // sigue abierta. NUNCA redefine suficienciaGanada ni la elegibilidad de
  // Movimiento (GrafoProyeccion.elegibleParaAbstraer/dimensionesElegiblesNoAtendidas
  // quedan intactas) — ver ProgresoConversacionalPolicy.decidirProtocolo,
  // única función que la consume. `false` (default) reproduce el
  // comportamiento anterior a esta corrección byte a byte.
  cierreConSnapshotSinDeudas = false,
  // AUTHORITY_CONTINUITY correction (C007 CONVERSATIONAL ENGINE
  // STABILIZATION, CLASS 12 handoff fix) -- PROGRESS_DECISION_INVOCATIONS_
  // FOR_HANDOFF_AUTHORITY = 1: when the caller already produced the real,
  // governed ProgresoConversacionalPolicy.decidirProtocolo() result for
  // THIS turn (non-destino grammars, ahead of Decision/CanonicalNextActState
  // -- see _procesarBajoExclusividad), it is passed here and reused
  // VERBATIM below -- decidirProtocolo is never invoked a second time for
  // the same turn. `null` (default) reproduces the previous behavior byte
  // for byte: this function computes its own progreso internally, exactly
  // as it always did (every other caller, and 'destino').
  progresoPrecalculado = null,
  // CLOSURE_CONTRACT_ACCEPTANCE_AND_OPTIONAL_OBLIGATION_COORDINATION (C007,
  // Daniel-adjudicated). Precalculado por el llamador (interpretarVeredictoRespuestaActoAnterior,
  // ContratoRespuestaDirigidaPolicy.js) a partir de una relación YA
  // estructuralmente verificada contra el acto canónico congelado del
  // turno anterior -- nunca recalculado aquí, nunca derivado de texto
  // libre del Productor. 'NO_VEREDICTO' (default) reproduce el
  // comportamiento anterior byte a byte para toda gramática y todo turno
  // que este incremento no demostró: solo 'destino', y solo cuando vale
  // 'MISSION_CLOSURE_ACCEPTED', añade una autoridad de avance adicional
  // -- nunca sustituye ni muta progreso.avanza (la autoridad de las otras
  // cuatro gramáticas queda intacta).
  veredictoCierreMisionPrecalculado = VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.NO_VEREDICTO,
  // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION (C007). The frozen
  // confirmation subject of this turn ('SYNTHESIS' default, or 'MISSION_CLOSURE').
  // A MISSION_CLOSURE subject makes the MISSION_CLOSURE_ACCEPTED advance
  // authority apply to ANY grammar (not just 'destino'), because the
  // acceptance was governed by the frozen PROPOSE_MISSION_CLOSURE + verified
  // directed-response relation, exactly as for DESTINO's own closure.
  confirmationSubject = CONFIRMATION_SUBJECTS.SYNTHESIS,
  // RESPONSE_GOVERNED_HANDOFF_DEFERS_NEXT_GRAMMAR_ACT (C007, Daniel-adjudicated).
  // Precalculado por el llamador a partir de las MISMAS dos autoridades que
  // ya gobiernan respuestaGobernadaVisibleEsteTurno (contratoRespuestaDirigidaEsteTurno
  // + alineacionRespuestaDirigidaResultadoTraza verificada), combinadas con
  // que este turno no seleccionó un nuevo acto cognitivo canónico propio.
  // GRAMMAR_TRANSITION_AUTHORIZED != NEXT_GRAMMAR_ACT_AUTHORIZED_IN_CURRENT_TURN:
  // cuando es true, este turno está gobernado únicamente por la respuesta
  // verificada al acto anterior, y NUNCA debe preparar ni congelar el
  // primer acto/contrato de la gramática entrante -- ese WHAT pertenece al
  // turno siguiente, una vez la transición ya esté durablemente comprometida.
  // false (default) reproduce el comportamiento anterior byte a byte.
  turnoGobernadoPorRespuestaAnterior = false,
}) {
  // CANONICAL_NO_SELECTED_ACT_NULL_NORMALIZATION (C007, Daniel-adjudicated,
  // real evidence: logistica_c0 live turn 30, second REALIZACION_CONTRATO_
  // NO_FIEL after the response-governed handoff gates above already fired
  // correctly). NO_SELECTED_CANONICAL_ACT = null, never undefined --
  // ABSENCE_OF_ACT != MISSING_VALUE_ACCIDENT. The caller's own
  // actoCognitivoSeleccionado ?? null normalization (InteraccionCognitivaWriter.js,
  // decidirInteraccion's call site) already canonicalizes the common case,
  // but this function's own API accepts "selected act OR no selected act"
  // and must not trust every caller to have done so -- function-boundary
  // hardening, normalized EXACTLY ONCE here, never re-derived per branch.
  // Every branch below that inspects "is there a current selected act"
  // reads ONLY this canonical value, never the raw parameter.
  const actoCognitivoSeleccionadoCanonico = actoCognitivoSeleccionado ?? null;
  const protocoloEstadoActual = state.protocoloEstado || 'EXPLORANDO';
  const grafoActivo = protocolV2Enabled && knowledgeGraphEnabled && protocoloEstadoActual === 'EXPLORANDO';
  // Ciclo Cognitivo de Descubrimiento — a diferencia de grafoActivo
  // (exclusivo de EXPLORANDO), grafoModoSesion cubre toda la sesión: un
  // rechazo en ESPERANDO_CONFIRMACION también puede mutar el grafo
  // (cascada + evidencia nueva, ver más abajo) y la cobertura/dimensiones
  // pendientes resultantes deben leerse de ESE grafo, no de state.slots
  // (que quedaría desactualizado frente a lo que el turno acaba de mutar).
  const grafoModoSesion = protocolV2Enabled && knowledgeGraphEnabled;

  // 3. Proyección/síntesis de slots — una sola vez por turno (esta función
  // se invoca como máximo una vez por turnoClienteId; los reintentos con la
  // misma clave nunca llegan aquí, ver _procesarBajoExclusividad paso 4).
  //
  // Incremento 3, punto 1 (alcance aprobado): durante ESPERANDO_CONFIRMACION
  // bajo protocolV2Enabled, el contrato ni siquiera le pide `entendido` al
  // generador. Incremento 1 (Grafo de Conocimiento vivo) extiende el mismo
  // criterio: bajo knowledgeGraphEnabled, slots es SIEMPRE una proyección
  // del grafo — nunca un blanco de escritura directa del LLM, en NINGÚN
  // estado del protocolo, no solo en ESPERANDO_CONFIRMACION (Contrato v1.0:
  // "los slots son siempre una proyección").
  const entendidoBloqueado = (protocolV2Enabled && protocoloEstadoActual === 'ESPERANDO_CONFIRMACION')
    || (protocolV2Enabled && knowledgeGraphEnabled && protocoloEstadoActual !== 'EXPLORANDO');
  const aportesBrutos = (!entendidoBloqueado && parsed.entendido && typeof parsed.entendido === 'object') ? { ...parsed.entendido } : {};
  const domainScaffoldEsteTurno = Array.isArray(parsed.domainScaffold)
    ? parsed.domainScaffold.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
  // Una ausencia explícita puede resolver legítimamente un UNKNOWN cuando el
  // descriptor de la misión lo autoriza; no se interpreta por una palabra
  // aislada ni se convierte NO_SABE en evidencia.
  const respuestaNegativaNormalizada = parsed.respuestaNegativa
    ? clasificarRespuestaNegativa(parsed.respuestaNegativa) : null;
  if (respuestaNegativaNormalizada && ['NO_APLICA', 'NO_EXISTE'].includes(respuestaNegativaNormalizada.tipo)) {
    const descriptorNegativa = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
    const lifecycleNegativa = descriptorNegativa && descriptorNegativa.direccionConversacional
      && descriptorNegativa.direccionConversacional.unknownLifecycle;
    const keysNegativa = lifecycleNegativa && Array.isArray(lifecycleNegativa.resolvedBySlots)
      ? lifecycleNegativa.resolvedBySlots : [];
    if (lifecycleNegativa && lifecycleNegativa.absenceResolves && keysNegativa.length === 1) {
      aportesBrutos[keysNegativa[0]] = respuestaNegativaNormalizada.tipo;
    }
  }

  let nuevosSlots, slotsActualizados, grafoResultado;
  if (grafoActivo) {
    // El delta ya fue validado y aplicado por el llamador (dry-run dentro
    // del mismo bucle de reintento de contrato) — si por algún motivo
    // llegara null (contrato inválido incluso tras agotar los reintentos),
    // el grafo de este turno queda sin cambios: nunca se corrompe con un
    // delta a medio aplicar.
    grafoResultado = grafoDelta || state.knowledgeGraph;
    const proyeccionNueva = proyectarSlots(grafoResultado, gramaticaActivaAlInicio);
    const proyeccionAnterior = proyectarSlots(state.knowledgeGraph, gramaticaActivaAlInicio);
    slotsActualizados = Object.keys(proyeccionNueva).filter(k => proyeccionNueva[k] !== proyeccionAnterior[k]);
    nuevosSlots = { ...state.slots, ...proyeccionNueva };
  } else if (protocolV2Enabled && knowledgeGraphEnabled) {
    // Fuera de EXPLORANDO con el grafo activo: por defecto ni slots ni
    // grafo cambian este turno — la proyección vigente es la que dejó el
    // último turno EXPLORANDO de esta gramática.
    //
    // ÚNICA EXCEPCIÓN (Ciclo Cognitivo de Descubrimiento — ADR): un rechazo
    // de la síntesis propuesta en ESPERANDO_CONFIRMACION cascadea al grafo
    // real (todo "inferido" activo de la gramática pierde autoridad,
    // GrafoConocimientoPolicy.aplicarDeltaReconciliacion.
    // inferenciasRechazadas) y puede además incorporar evidencia nueva que
    // el experto haya aportado en el mismo mensaje (aplicarDelta) — ambas
    // operaciones ya fueron calculadas y validadas (incluida la misma
    // elegibilidad de EXPLORANDO) por el llamador, dentro del mismo bucle
    // de reintento de contrato — ver InteraccionCognitivaWriter,
    // _procesarBajoExclusividad. Esta función solo consume el resultado ya
    // resuelto en `grafoDelta`, exactamente igual que la rama grafoActivo
    // de arriba — nunca lo recalcula.
    grafoResultado = grafoDelta || state.knowledgeGraph;
    if (grafoResultado !== state.knowledgeGraph) {
      const proyeccionNueva = proyectarSlots(grafoResultado, gramaticaActivaAlInicio);
      nuevosSlots = { ...state.slots, ...proyeccionNueva };
      slotsActualizados = Object.keys(proyeccionNueva).filter(k => proyeccionNueva[k] !== state.slots[k]);
    } else {
      nuevosSlots = { ...state.slots };
      slotsActualizados = [];
    }
  } else {
    grafoResultado = state.knowledgeGraph; // sin cambios — camino legacy nunca lo toca
    nuevosSlots = { ...state.slots };
    slotsActualizados = [];
    for (const [slot, valorNuevo] of Object.entries(aportesBrutos)) {
      if (!(slot in nuevosSlots)) continue; // ignora claves desconocidas, igual que mergeSlots
      const sintetizado = sintetizarSlot([{ valor: valorNuevo }], nuevosSlots[slot]);
      if (sintetizado !== nuevosSlots[slot]) {
        nuevosSlots[slot] = sintetizado;
        slotsActualizados.push(slot);
      }
    }
  }

  const estadoTrasSlots = { ...state, slots: nuevosSlots };
  const mensajeBase = typeof parsed.mensaje === 'string' ? parsed.mensaje : '';
  // HQR3: proyección efímera de comprensión acumulada.  Se deriva de las
  // autoridades ya actualizadas del turno y se consume antes de decidir el
  // objetivo/vía; no constituye una segunda memoria ni se persiste.
  const conceptosAutorizadosEsteTurno = (grafoResultado && Array.isArray(grafoResultado.conceptos)
    ? grafoResultado.conceptos : [])
    .filter(c => c && c.activo !== false && c.autoridad === 'experto');
  const userKnowledgeEsteTurno = conceptosAutorizadosEsteTurno.map(c => c.descripcion).filter(Boolean);
  const materialRecienteEsteTurno = [typeof mensajeBase === 'string' ? mensajeBase : ''].filter(Boolean);
  const comprensionTrabajoEsteTurno = proyectarComprensionTrabajo({
    userKnowledge: userKnowledgeEsteTurno,
    authorizedInterpretation: conceptosAutorizadosEsteTurno
      .filter(c => c.tipo === 'sintesis_interpretativa' || c.tipo === 'afirmacion')
      .map(c => c.descripcion),
    domainScaffold: domainScaffoldEsteTurno,
    valuableUnknown: null,
    recentFocus: materialRecienteEsteTurno[materialRecienteEsteTurno.length - 1] || null,
    rejectedOrCorrected: [],
  });
  const focoConversacionalActual = seleccionarFocoConversacional({
    comprension: comprensionTrabajoEsteTurno,
    materialReciente: materialRecienteEsteTurno,
    evidenciaObtenida: userKnowledgeEsteTurno,
  });

  // 4. Cobertura y "slotsFaltantes" que gobiernan a ProgresoConversacionalPolicy.
  //
  // Bajo legacy: sin cambios respecto a siempre — slotsFaltantesAntes es la
  // foto PRE-turno (lo que gobernó el contrato de este turno), coberturaCompleta
  // es POST-síntesis. Dos fotos, igual que siempre.
  //
  // Bajo el grafo vivo (Incremento 1, corrección arquitectónica — "tres
  // fotografías"): decidirProtocolo recibe SIEMPRE la foto verdaderamente-
  // después (posterior a construcción, la única fase que puede tocar este
  // grafo aquí — reconciliación ya comprometió lo suyo antes de que este
  // turno de construcción empezara). slotsFaltantes y coberturaCompleta se
  // calculan del MISMO grafoResultado — nunca de dos fotos distintas — así
  // que la invariante "slotsFaltantes vacío ⟺ coberturaCompleta" se cumple
  // por construcción, no por coincidencia. La foto "post-reconciliación,
  // pre-construcción" (lo que el prompt de este turno realmente mostró) se
  // usa aparte, en el bucle de reintento de _procesarBajoExclusividad, para
  // validar next_user_action.objetivo contra lo que el generador vio de
  // verdad — nunca aquí.
  // circulomejora006 (corrección final — bloqueo transitorio de Progreso):
  // ProgresoConversacionalPolicy.decidirProtocolo NO cambia — su propio
  // primer branch (defensivo) resuelve LISTO_PARA_SINTESIS en cuanto
  // `slotsFaltantes` viene vacío, SIN mirar `coberturaCompleta` — por eso
  // este bloqueo no puede componerse solo sobre `coberturaCompleta`: hay
  // que preservar, para 'destino', la MISMA invariante que ya documenta el
  // comentario de arriba ("slotsFaltantes vacío ⟺ coberturaCompleta") pero
  // incluyendo ahora una tercera condición. Una interpretación materializada
  // y todavía sin veredicto es una operación conversacional iniciada y no
  // resuelta: mientras exista, `slotsFaltantesAntes` para 'destino' incluye
  // también esas dimensiones (dimensionesConInterpretacionPendiente) — sin
  // que eso implique elevar dimensionesPendientes/coberturaCompleta (las
  // funciones puras, sin cambios) ni el umbral de suficiencia semántica.
  // Para cualquier otra gramática, dimensionesConInterpretacionPendiente es
  // estructuralmente siempre vacío hoy (materializadoViaMovimiento nunca se
  // estampa fuera de destino) — el chequeo se restringe igual, explícito en
  // vez de depender de esa coincidencia.
  const pendientesCoberturaDeGrafoResultado = grafoModoSesion
    ? dimensionesPendientesDeGrafo(grafoResultado, gramaticaActivaAlInicio)
    : validateGramaticaComplete(state.slots, gramaticaActivaAlInicio).missing;
  const conInterpretacionPendienteDeGrafoResultado = (grafoModoSesion && gramaticaActivaAlInicio === 'destino')
    ? GrafoProyeccion.dimensionesConInterpretacionPendiente(grafoResultado, gramaticaActivaAlInicio)
    : [];
  const slotsFaltantesAntes = [...new Set([...pendientesCoberturaDeGrafoResultado, ...conInterpretacionPendienteDeGrafoResultado])];
  const coberturaCompleta = grafoModoSesion
    ? slotsFaltantesAntes.length === 0
    : validateGramaticaComplete(nuevosSlots, gramaticaActivaAlInicio).complete;
  // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera causal —
  // ELEGIBILIDAD_DIMENSIONAL_IGNORA_LA_AUTORIDAD_DE_CORRECCION_POR_ROL) —
  // los conceptoIds que una corrección de Hipótesis por rol ya declaró
  // inadmisibles para su rol nunca deben, por sí solos, inflar el conteo
  // bruto de "conceptos experto activos" que decide si esta dimensión
  // está lista para una interpretación NUEVA (GrafoProyeccion.elegibleParaAbstraer)
  // — el concepto sigue activo:true, sigue contando para cobertura/slots,
  // solo se descuenta de ESTE conteo puntual. Siempre seguro: en estado
  // SOLO_EXCLUSION (sin reemplazo aún) la dimensión nunca llega a 2 por sí
  // sola, así que esto nunca cambia nada ahí — ver docstring de
  // elegibleParaAbstraer.
  const conceptoIdsExcluidosPorRol = new Set(
    (state.protocoloExclusionesHipotesisPorRol || []).flatMap(e => e.conceptoIds),
  );
  // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera causal —
  // SUFICIENCIA_GLOBAL_IGNORA_EL_AMBITO_DE_LA_CORRECCION_DE_HIPOTESIS) —
  // las correcciones "focales" vigentes: todavía no produjeron su
  // Hipótesis sucesora (hipotesisSucesoraId===null, ver bookkeeping en la
  // transacción de persistencia). Deliberadamente NUNCA se filtra por
  // estadoCorreccion==='REEMPLAZO_MATERIALIZADO' aquí — `state` es la foto
  // ANTES de este turno, y resolverAsignacionPositivaAbierta (que recién
  // marca REEMPLAZO_MATERIALIZADO) corre DESPUÉS de esta función, más
  // adelante en la MISMA transacción — leer esa condición aquí perdería
  // exactamente el turno donde exclusión y reemplazo llegan juntos (mismo
  // defecto de temporalidad ya corregido para el contrato de respuesta
  // dirigida, ver fuenteEsCorreccionConceptoAbierta). Siempre seguro de
  // ensanchar: mientras la corrección siga SOLO_EXCLUSION (sin reemplazo
  // real en el grafo), construirReferenciasPorRolDestino nunca produce
  // CANDIDATA_DISPONIBLE de todos modos (SIN_COBERTURA), así que acotar la
  // suficiencia en ese estado no cambia ningún resultado observable. Mientras
  // alguna esté vigente, la suficiencia se acota a SUS dimensiones — nunca
  // deja que una oportunidad genuina en OTRA dimensión (evidencia
  // acumulada durante la conversación, sin relación con ninguna
  // corrección) secuestre la repropuesta. En cuanto una corrección produce
  // su sucesora, deja de aparecer aquí en el siguiente turno — sin afectar
  // a ninguna otra corrección focal que siga vigente.
  const dimensionesEnAmbitoDeCorreccion = new Set(
    (state.protocoloExclusionesHipotesisPorRol || [])
      .filter(e => e.hipotesisSucesoraId === null)
      .map(e => e.dimension),
  );
  const resultadoSuficiencia = protocolV2Enabled && grafoModoSesion
    ? evaluarSuficienciaParaSintesis({
        hechosSemanticos: proyectarHechosSuficienciaParaSintesis(
          grafoResultado, gramaticaActivaAlInicio, dimensionesInterpretacionDiferida, conceptoIdsExcluidosPorRol,
          dimensionesEnAmbitoDeCorreccion,
        ),
        reparacionesInterpretativasPendientes,
      })
    : null;

  // ── Frontera única de autoridad (Incremento 4) ──────────────────────────
  // Exactamente una de las dos ramas se ejecuta — nunca ambas. Ver nota de
  // cabecera del archivo.
  let gate, avanzaReal, progreso;
  if (protocolV2Enabled) {
    // circulomejora006_act10k — mismo motivo que el ensanche gemelo en
    // determinarEstadoProtocolarEfectivo (ver _procesarBajoExclusividad):
    // sin esto, la rama defensiva de EXPLORANDO de decidirProtocolo
    // (suficienteParaSintesis===true) saltaría a LISTO_PARA_SINTESIS
    // ignorando por completo la respuesta que el experto acaba de dar a la
    // reparación dirigida — descartando el propósito entero de mostrarla.
    // 'BLOQUEADA_SIN_SENAL_NUEVA' es el estado YA DISEÑADO (act10c) para
    // "existe un objetivo dirigido activo, todavía sin una señal
    // estructural nueva" — nunca inventado aquí; solo se conecta el
    // parámetro que faltaba.
    // circulomejora006_act10l — relacionTransformacionalEstadoPrecalculado
    // (ver cabecera de esta función) es el resultado REAL de haber
    // intentado la propuesta (calculado por el llamador, efecto incluido,
    // ANTES de esta llamada pura) — reemplaza el valor estático fijo que
    // act10k usaba como aproximación provisional. Si el llamador no intentó
    // nada este turno (objetivo inactivo, o condición fuera de alcance),
    // llega null y se conserva el mismo comportamiento defensivo de antes.
    // CERRAR_ARRANQUE_DEL_CICLO_TRANSFORMACIONAL_DE_DESTINO — por contrato,
    // toda gramática 'destino' exige relación transformacional confirmada
    // antes de sintetizar; ya no depende de protocoloObjetivoRelacionalDirigido
    // (ver nota junto al call site de evaluarEstadoRelacionTransformacionalDestino).
    // CORREGIR_COMPATIBILIDAD_SLOT_BASED_Y_MIGRAR_CERTIFICACION — CONTRATOS_PARALELOS
    // (auditoría de compatibilidad): el ciclo Hipótesis→Afirmación es
    // estructuralmente exclusivo del Grafo de Conocimiento vivo — su único
    // productor (evaluarEstadoRelacionTransformacionalDestino, más abajo en
    // este archivo) YA está gateado tras knowledgeGraphEnabled y nunca corre
    // sin él. Exigir la relación transformacional en modo slot-based
    // (knowledgeGraphEnabled:false — superficie soportada, COMPATIBILIDAD_LEGACY_CONGELADA,
    // cerrada y validada con E2E real antes de que el grafo existiera, ver
    // MASTER_ROADMAP.md) exigía una autoridad que esa configuración nunca
    // puede producir — bloqueo permanente, no una decisión de producto.
    // knowledgeGraphEnabled ya es un parámetro de esta función (la misma
    // señal que el propio Writer resuelve una única vez en su constructor,
    // ver cabecera de la clase) — no se duplica ni se agrega un flag nuevo.
    const relacionTransformacionalRequeridaEsteTurno = gramaticaActivaAlInicio === 'destino' && knowledgeGraphEnabled;
    const relacionTransformacionalEstadoEsteTurno = relacionTransformacionalRequeridaEsteTurno
      ? (relacionTransformacionalEstadoPrecalculado || 'BLOQUEADA_SIN_SENAL_NUEVA')
      : null;
    // AUTHORITY_CONTINUITY correction (PROGRESS_DECISION_INVOCATIONS_FOR_
    // HANDOFF_AUTHORITY = 1) -- progresoPrecalculado, when the caller
    // already produced it earlier this SAME turn (non-destino grammars,
    // for the handoff/closureOption vertical -- see _procesarBajoExclusividad),
    // is reused verbatim: decidirProtocolo is NEVER invoked twice for the
    // same turn. `null` (default -- every other caller, and 'destino')
    // reproduces the previous behavior byte for byte.
    progreso = progresoPrecalculado || decidirProtocolo({
      protocoloEstadoActual, coberturaCompleta, slotsFaltantes: slotsFaltantesAntes,
      parsed, intentosAmbiguosPrevios: state.protocoloIntentosAmbiguos || 0,
      resultadoSuficiencia,
      relacionTransformacionalRequerida: relacionTransformacionalRequeridaEsteTurno,
      relacionTransformacionalEstado: relacionTransformacionalEstadoEsteTurno,
      diagnosticoEstructuralTransformacional,
      cierreConSnapshotSinDeudas,
      confirmationSubject,
    });
    // La dirección pública se proyecta exclusivamente desde Movimiento.
    // La respuesta estructurada de Generación puede conservar un campo
    // legacy, pero nunca compite con este contrato gobernado.
    if (movimientoRigeMaterializacion && (contratoIntervencionMovimiento || movimientoAutoridad)) {
      const autoridadMovimiento = contratoIntervencionMovimiento || movimientoAutoridad;
      progreso = {
        ...progreso,
        nextUserAction: {
          tipo: 'responder_pregunta',
          objetivo: autoridadMovimiento.accionUsuario
            ? autoridadMovimiento.accionUsuario.objetivo
            : (autoridadMovimiento.dimensionObjetivo || autoridadMovimiento.objetivo || null),
          ...(autoridadMovimiento.objetivoCodigo ? { objetivoCodigo: autoridadMovimiento.objetivoCodigo } : {}),
          texto: null,
        },
        nextUserActionOrigen: 'movimiento_realizador',
        nextUserActionRazonFallback: undefined,
      };
    }
    // Corrección D-041 (hallazgo del primer E2E público, exclusiva de grafo
    // activo — nunca toca ProgresoConversacionalPolicy.js ni el camino
    // legacy): la rama defensiva de decidirProtocolo para
    // COBERTURA_COMPLETADA fuerza un next_user_action tipo "confirmar" —
    // correcto cuando D-040 ya redirigió este turno a un contrato de
    // síntesis real, pero bajo grafo esa rama, después de D-040, solo se
    // alcanza para el caso distinto: cobertura que se completó CON el
    // propio contenido de este turno, generado bajo el contrato EXPLORANDO
    // — nunca una síntesis real. Preguntar "¿esta síntesis representa lo
    // que quieres enseñar?" ahí describe algo que todavía no existe, y la
    // respuesta del experto a esa pregunta se pierde como contenido
    // ordinario (el turno siguiente ya construye la síntesis real bajo
    // LISTO_PARA_SINTESIS, con su propia confirmación correcta después).
    // Se descarta el next_user_action en vez de dejar que se anexe.
    if (
      grafoActivo && progreso && progreso.evento === PROTOCOLO_EVENTOS.COBERTURA_COMPLETADA &&
      progreso.nextUserActionOrigen === 'fallback'
    ) {
      progreso = { ...progreso, nextUserAction: null, nextUserActionOrigen: null, nextUserActionRazonFallback: undefined };
    }
    // circulomejora006 (tercera verificación, Sección C3 — Opción B) —
    // mismo patrón que la corrección D-041 de arriba, pero por una razón
    // distinta: aquí SÍ hay next_user_action legítimo que ProgresoConversacionalPolicy
    // acaba de resolver (generador o fallback, según su propia lógica
    // interna, sin cambios) — pero ese resultado ya es irrelevante, porque
    // r.parsed.mensaje (que decidirProtocolo nunca ve, solo consume vía
    // `parsed.mensaje` para su propio `mensajeBase` de abajo) YA ES la
    // intervención visible completa de este turno (Realizador con
    // intervencionCompleta, o la plantilla determinista de reparación).
    // Reemplazamos su next_user_action por uno derivado ÚNICAMENTE de
    // Movimiento (nunca de Capa 1, nunca del fallback interno de
    // ProgresoConversacionalPolicy) — con `texto:null` para que
    // componerMensajeFinal (más abajo) no anexe nada: mensajeBase ya es
    // la respuesta completa. `objetivo` se conserva como el único dato
    // real de observabilidad (mismo campo que ya mostraba next_user_action.resuelta
    // para cualquier otro turno de DESTINO).
    if (grafoActivo && progreso && movimientoRigeMaterializacion
      && !diagnosticoEstructuralTransformacional) {
      progreso = {
        ...progreso,
        nextUserAction: ((contratoIntervencionMovimiento || movimientoAutoridad)
          && ((contratoIntervencionMovimiento || movimientoAutoridad).accionUsuario
            ? (contratoIntervencionMovimiento || movimientoAutoridad).accionUsuario.objetivo
            : ((contratoIntervencionMovimiento || movimientoAutoridad).dimensionObjetivo
              || (contratoIntervencionMovimiento || movimientoAutoridad).objetivo)))
          ? {
            tipo: 'responder_pregunta',
            objetivo: (contratoIntervencionMovimiento || movimientoAutoridad).accionUsuario
              ? (contratoIntervencionMovimiento || movimientoAutoridad).accionUsuario.objetivo
              : ((contratoIntervencionMovimiento || movimientoAutoridad).dimensionObjetivo
                || (contratoIntervencionMovimiento || movimientoAutoridad).objetivo),
            ...(movimientoAutoridad && movimientoAutoridad.objetivoCodigo ? { objetivoCodigo: movimientoAutoridad.objetivoCodigo } : {}),
            texto: null,
          }
          : null,
        nextUserActionOrigen: 'movimiento_realizador',
        nextUserActionRazonFallback: undefined,
      };
    }
    // S1_R_INCREMENTO_2 / S1-DISAGREE1 — una objeción semántica con
    // ambito_correccion==="relacion" bajo DESTINO moderno SIEMPRE regresa a
    // EXPLORANDO — nunca al atajo hacia LISTO_PARA_SINTESIS que
    // decidirProtocolo aplica al rechazo legacy (o a "corrige" editorial)
    // con cobertura completa (esa ruta asume re-síntesis inmediata sobre el
    // mismo grafo cascadeado; S1-R exige que el experto vuelva a explorar
    // antes de que cualquier nueva síntesis pueda proponerse — la Afirmación
    // cuestionada queda, además, bloqueada para reutilización por la
    // reparación que se abre en la misma transacción, ver _confirmarInteraccion).
    // aperturaS1RPrecalculada no-null ya demuestra que corresponde, según el
    // caso, a evento===SINTESIS_RECHAZADA (clasificacion_respuesta==='rechaza')
    // o a evento===SINTESIS_CORREGIDA (clasificacion_respuesta==='corrige'
    // con impacto_cambio==='semantico', S1-DISAGREE1 — mismo precálculo,
    // misma condición de identidad) — el evento en sí (rechazada/corregida)
    // se conserva sin tocar como metadato honesto de tono; solo el
    // enrutamiento estructural cambia aquí, gobernado exclusivamente por
    // aperturaS1RPrecalculada, nunca por el evento — nunca se re-verifica
    // aquí una segunda regla de enrutamiento.
    if (protocolV2Enabled && progreso && aperturaS1RPrecalculada) {
      // S1-DISAGREE1 (corrección posterior al smoke real — turno 17 de
      // a4r_confirmacion) — el "rechaza" legacy YA calculaba, dentro de
      // decidirProtocolo, un next_user_action real contra EXPLORANDO (su
      // protocoloEstadoSiguiente original YA era EXPLORANDO — nada que
      // recalcular). "corrige", en cambio, SIEMPRE calcula su next_user_action
      // contra LISTO_PARA_SINTESIS (confirmar la síntesis) — un objetivo que
      // este override acaba de invalidar. Sin esta corrección, la respuesta
      // visible seguía preguntando "¿Esta síntesis representa lo que quieres
      // enseñar?" pese a que la síntesis cuestionada ya quedó bloqueada —
      // prometiendo una confirmación que el estado durable ya no permite
      // (exactamente el defecto que motivó esta auditoría, reintroducido por
      // otra vía). Mismo criterio que reaccionRechazoControlada: el mensaje
      // determinista ya es la respuesta completa — un next_user_action solo
      // se conserva si de verdad apunta a una dimensión EXPLORANDO real.
      if (progreso.protocoloEstadoSiguiente !== 'EXPLORANDO') {
        if (Array.isArray(slotsFaltantesAntes) && slotsFaltantesAntes.length > 0) {
          const { resultado, origen, razon } = resolverNextUserAction({
            nextUserActionPropuesto: null,
            protocoloEstado: PROTOCOLO_ESTADOS_PROGRESO.EXPLORANDO,
            slotsValidos: slotsFaltantesAntes,
          });
          progreso = { ...progreso, nextUserAction: resultado, nextUserActionOrigen: origen, nextUserActionRazonFallback: razon };
        } else {
          progreso = { ...progreso, nextUserAction: null, nextUserActionOrigen: null, nextUserActionRazonFallback: undefined };
        }
      }
      progreso = { ...progreso, protocoloEstadoSiguiente: 'EXPLORANDO' };
    }
    avanzaReal = progreso.avanza;
    // ACCEPTANCE OUTRANKS OPTIONAL ACQUISITION; PROGRESO REMAINS THE
    // TRANSITION AUTHORITY (C007, CLOSURE_CONTRACT_ACCEPTANCE_AND_
    // OPTIONAL_OBLIGATION_COORDINATION). DESTINO's own closure mechanism
    // (PROPOSE_MISSION_CLOSURE + resolverSuficienciaMisionGramaticaActiva)
    // runs entirely independently of the legacy protocoloEstado/
    // decidirProtocolo confirmation cycle every other grammar uses --
    // progreso.avanza never reflects a DESTINO closure acceptance, exactly
    // the same asymmetry resolverSuficienciaMisionGramaticaActiva's own
    // grammar-adapter boundary already establishes for missionSufficient.
    // This is purely ADDITIVE (an OR, never a replacement): every other
    // grammar's avanzaReal, and every DESTINO turn without an accepted
    // closure, is byte-for-byte unchanged. CLOSURE_ACCEPTED != GRAMMAR_
    // ALREADY_CHANGED -- this only supplies the same avanzaReal boolean
    // Progreso's own confirmation cycle already supplies for other
    // grammars; the existing gramaticaSiguiente/GRAMATICA_ORDER logic
    // immediately below remains the SOLE transition owner.
    // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION (C007) -- also apply the
    // governed-acceptance advance to a non-DESTINO grammar whose frozen
    // confirmation subject is MISSION_CLOSURE. Still purely ADDITIVE.
    if ((gramaticaActivaAlInicio === 'destino' || confirmationSubject === CONFIRMATION_SUBJECTS.MISSION_CLOSURE)
      && veredictoCierreMisionPrecalculado === VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.MISSION_CLOSURE_ACCEPTED) {
      avanzaReal = true;
    }
    gate = gateDesdeProtocolo(
      avanzaReal, gramaticaActivaAlInicio,
      avanzaReal
        ? `Gramática ${gramaticaActivaAlInicio} confirmada por el experto (protocolo conversacional, síntesis v${state.protocoloSintesisVigente ? state.protocoloSintesisVigente.version : '?'})`
        : `Protocolo conversacional en ${progreso.protocoloEstadoSiguiente} (evento: ${progreso.evento || 'sin evento'})`,
    );
  } else {
    // GatePolicy: única autoridad bajo legacy, sin cambios respecto al
    // comportamiento histórico. ProgresoConversacionalPolicy NO se invoca
    // en esta rama — ya cumplió su función de validación en modo sombra
    // durante los Incrementos 1-3; mantenerla corriendo aquí no tendría
    // ningún efecto observable (siempre caería a fallback, porque el
    // contrato legacy nunca provee next_user_action/clasificacion_respuesta)
    // y sería exactamente la "lógica duplicada sin propósito operativo" que
    // este incremento retira.
    gate = GatePolicy.evaluateGramatica(estadoTrasSlots, gramaticaActivaAlInicio, parsed);
    avanzaReal = gate.outcome === GATE_OUTCOMES.APPROVED;
    progreso = null;
  }

  let gramaticaSiguiente = state.gramaticaActiva;
  let gramaticasCompletadasNuevas = state.gramaticasCompletadas;
  const statusNuevo = state.status; // ningún cambio de ciclo de vida en este incremento (grammar-turn únicamente)

  if (avanzaReal) {
    const idx = GRAMATICA_ORDER.indexOf(gramaticaActivaAlInicio);
    // idx === GRAMATICA_ORDER.length - 1 es DAR VIDA: gramaticaSiguiente
    // queda en null — estado TERMINAL canónico, nunca una sexta gramática.
    gramaticaSiguiente = idx < GRAMATICA_ORDER.length - 1 ? GRAMATICA_ORDER[idx + 1] : null;
    gramaticasCompletadasNuevas = state.gramaticasCompletadas.includes(gramaticaActivaAlInicio)
      ? state.gramaticasCompletadas
      : [...state.gramaticasCompletadas, gramaticaActivaAlInicio];
  }
  const estadoProspectivo = proyectarEstadoConversacionalPostTurno({
    estadoActual: state,
    decision: {
      gramaticaSiguiente,
      gramaticasCompletadasNuevas,
      protocoloEstadoSiguiente: progreso && progreso.protocoloEstadoSiguiente,
      statusNuevo: gramaticaSiguiente === null ? 'completado' : statusNuevo,
    },
  });
    // En un avance no terminal, la primera intervención de la misión entrante
    // se calcula con las mismas autoridades de dirección/movimiento, sobre el
    // snapshot prospectivo. Nunca se reutilizan oportunidades de la misión
    // saliente: la misión entrante prepara internamente su propio WHAT.
  let objetivoParaContrato = objetivoConversacional;
  let movimientoParaContrato = movimientoAutoridad;
  let gramaticaParaContrato = gramaticaActivaAlInicio;
  // RESPONSE_GOVERNED_HANDOFF_DEFERS_NEXT_GRAMMAR_ACT (C007) -- a turn
  // governed solely by a verified response to the previous act (no new
  // canonical act of its own) may still legitimately authorize the grammar
  // transition (avanzaReal/gramaticaSiguiente, above, untouched), but must
  // NOT prepare the entering grammar's own typed opportunity as authority
  // for THIS turn's WHAT: SEMANTIC_FIT != TEMPORAL_AUTHORITY. The entering
  // grammar's native opportunity search remains fully available on the
  // NEXT turn, once the transition is durably committed.
  if (!turnoGobernadoPorRespuestaAnterior
    && avanzaReal && gramaticaSiguiente && gramaticaSiguiente !== gramaticaActivaAlInicio) {
    const oportunidadEntranteInterna = prepararOportunidadTipadaDesdeDireccion(
      grafoResultado || state.knowledgeGraph,
      gramaticaSiguiente,
      { slots: nuevosSlots || state.slots },
    );
    const objetivoEntrante = decidirObjetivoConversacional({
      grafo: grafoResultado || state.knowledgeGraph,
      gramatica: gramaticaSiguiente,
      slots: nuevosSlots || state.slots,
      oportunidadesConversacionales: oportunidadEntranteInterna ? [oportunidadEntranteInterna] : [],
      comprensionTrabajo: comprensionTrabajoEsteTurno,
      focoConversacionalActual,
    });
    if (objetivoEntrante && objetivoEntrante.oportunidadSeleccionada) {
      objetivoParaContrato = objetivoEntrante;
      movimientoParaContrato = decidirMovimiento(
        grafoResultado || state.knowledgeGraph,
        gramaticaSiguiente,
        { objetivoConversacional: objetivoEntrante },
      );
      gramaticaParaContrato = gramaticaSiguiente;
    }
  }

  // circulomejora006_act10l — Formulación visible: cuando este turno acaba
  // de proponer una nueva HipotesisTransformacionalDestino
  // (evento===RELACION_TRANSFORMACIONAL_PROPUESTA), el texto normativo
  // mostrado es SIEMPRE hipotesis.formulacionCongelada — nunca
  // parsed.mensaje de Capa 1 (esa es la respuesta de Capa 1 A LA
  // exploración dirigida, no la formulación de la nueva relación) ni una
  // segunda formulación redactada aquí. Mismo criterio que
  // reaccionRechazoControlada/componerMensajeFinal ya aplican para
  // rechazos: el mensaje base de este turno concreto es determinista, no
  // la prosa libre del generador. FALLBACKS.confirmar_relacion_transformacional
  // (ya existente, act10c) sigue siendo el único "envoltorio conversacional"
  // que decidirProtocolo anexa vía next_user_action — nunca una segunda
  // formulación.
  // CERRAR_FIDELIDAD_DE_SINTESIS_DE_DESTINO — mismo principio que la
  // formulación de Hipótesis arriba: cuando este turno se procesa bajo
  // LISTO_PARA_SINTESIS para 'destino' con grafo Y ya existe una Afirmación
  // AUTORIZADA vigente con su Presentación causal reconstruible, el texto
  // normativo mostrado es SIEMPRE ese texto autorizado — nunca parsed.mensaje
  // de Capa 1 (que puede seguir corriendo por responsabilidades protocolarias
  // del turno, pero nunca gobierna el contenido visible). Composicional, no
  // una instrucción de prompt: la garantía vive en este `if`, no en pedirle
  // a Capa 1 que "repita" nada. Mutuamente excluyente con el swap de
  // Hipótesis de arriba — ese solo aplica en EXPLORANDO, este solo en
  // LISTO_PARA_SINTESIS.
  const sintesisDestinoAutorizadaAplica = (
    protocolV2Enabled && knowledgeGraphEnabled && gramaticaActivaAlInicio === 'destino'
    && protocoloEstadoActual === 'LISTO_PARA_SINTESIS'
    && sintesisDestinoAutorizadaPrecalculada
    && sintesisDestinoAutorizadaPrecalculada.estado === 'SINTESIS_PRODUCIDA'
  );
  const mensajeBaseEfectivo = sintesisDestinoAutorizadaAplica
    ? sintesisDestinoAutorizadaPrecalculada.texto
    : (
        protocolV2Enabled && progreso && progreso.evento === PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_PROPUESTA
        && nuevaHipotesisRelacionalProyeccion
      ) ? nuevaHipotesisRelacionalProyeccion.formulacionCongelada : mensajeBase;

  // Composición determinista y next_user_action: solo existen bajo V2 (bajo
  // legacy, progreso es null — no hay nada que componer ni observar).
  // Cuando existe una misión/dirección tipada o Movimiento, el contrato
  // único materializa la intervención completa. Anexar aquí next_user_action
  // produciría un segundo WHAT/acto de otro owner.
  // Las misiones tipadas usan exclusivamente el contrato común; DESTINO
  // conserva aquí su compositor histórico hasta que su materializador propio
  // transporte también la pregunta dentro del contrato de Movimiento.
  const contratoUnicoEsperado = !!(contratoIntervencionMovimiento
    || direccionConversacionalTipadaActiva(gramaticaParaContrato));
  const mensajeFinalProtocolo = protocolV2Enabled
    ? (contratoUnicoEsperado ? mensajeBaseEfectivo : componerMensajeFinal(mensajeBaseEfectivo, progreso.nextUserAction))
    : mensajeBaseEfectivo;
  const mensajeCircle = protocolV2Enabled ? mensajeFinalProtocolo : mensajeBaseEfectivo;

  // FRONTERA_INTERVENCION_VISIBLE_1 — construcción PURA del contrato (sin
  // I/O aquí, esta función se mantiene pura): el llamador
  // (_procesarBajoExclusividad), tras recibir esta decisión y ANTES de
  // abrir la transacción, invoca materializarIntervencionVisible para
  // producir el mensajeCirculo real y SOBREESCRIBE mensajeCirculo/
  // mensajeFinalProtocolo (arriba) con ese resultado — cuando
  // contratoIntervencion existe, mensajeCircle/mensajeFinalProtocolo de
  // arriba dejan de ser autoridad final, quedan como material candidato
  // (ver contenido.materialCandidato abajo, evaluado por la frontera antes
  // de gastar una llamada nueva).
  //
  // Alcance explícito de este incremento (decisión del usuario): SOLO
  // 'destino' bajo V2+grafo — ninguna otra gramática, ni el modo legacy
  // (protocolV2Enabled===false), cambia de comportamiento. Cubre las TRES
  // familias vivas de P1 en destino: el turno genérico de
  // EXPLORANDO/ESPERANDO_CONFIRMACION/LISTO_PARA_SINTESIS-sin-autorizar
  // (antes P1 puro), la propuesta de relación transformacional (antes P4,
  // formulacionCongelada expuesta directo) y la síntesis ya autorizada
  // (antes P5). El veredicto de VALIDANDO_RELACION_TRANSFORMACIONAL (antes
  // P1 vía parsed.mensaje) se migra por separado en
  // ValidacionRelacionTransformacionalDestinoCasoDeUso.js — esta función
  // nunca corre para ese protocoloEstado.
  let contratoIntervencionDestino = null;
  const missionAdapter = getGrammarMissionAdapter(gramaticaActivaAlInicio);
  const missionAdapterProspectivo = getGrammarMissionAdapter(gramaticaParaContrato);
  // The canonical cognitive decision is evaluated once per intervention
  // lineage. Its selected WHAT is transported unchanged to the Contract.
  // movimientoRigeMaterializacion (circulomejora006, ver cabecera de esta
  // función): cuando es true, r.parsed.mensaje YA es la intervención visible
  // completa -- producida por el Realizador de Movimiento Conversacional
  // (un materializador distinto, autorizado y anterior a este incremento,
  // fuera de su alcance). Esta frontera existe para que NINGÚN productor
  // cognitivo alcance mensajeCirculo sin pasar por un materializador
  // autorizado -- Movimiento YA es uno; reconstruir un contrato aquí encima
  // de su salida sería un SEXTO productor paralelo (ver punto 2 del
  // incremento), no la frontera única, y forzaría esa salida ya completa a
  // cumplir un requisito de pregunta ajeno a su propio contrato.
  //
  // FRONTERA_INTERVENCION_VISIBLE_1 (BLOCKER B, corrección posterior —
  // hallazgo real de trayectoria humana 3, turno 4) — P4 (justo abajo) ya
  // NO se gatea con `!movimientoRigeMaterializacion`. Causa raíz
  // reconstruida: `movimientoRigeMaterializacion` es una bandera de NIVEL
  // DE SESIÓN/TURNO ("¿Movimiento Conversacional está activo?"), nunca "¿el
  // Realizador de Movimiento ya materializó ALGO este turno?" -- en el
  // estado imposible ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES
  // (exactamente el turno en que las 4 dimensiones se completan y nace una
  // nueva Hipótesis, movimientoDecidido queda null) la bandera seguía en
  // true, así que este bloque completo se saltaba -- y la línea de abajo
  // (mensajeBaseEfectivo = ...formulacionCongelada, nunca condicionada a
  // esta bandera) dejaba el texto RAW de la plantilla interna
  // (_FormulacionTransformacionalDestinoTemplate.js: "Partiendo de:",
  // "Mediante:", "Se llega a:", "Esto se sabrá porque:") como único valor,
  // sin ningún materializador de por medio. P4 nace de un evento
  // estructuralmente distinto de "Movimiento decidió algo este turno"
  // (decidirProtocolo/RELACION_TRANSFORMACIONAL_PROPUESTA, nunca producido
  // por el Realizador de Movimiento) -- por construcción, las 4 dimensiones
  // completas que habilitan P4 son la MISMA condición que deja a Movimiento
  // sin nada que decidir (ver ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES,
  // arriba en este archivo), así que exigirle su propia materialización
  // aquí nunca duplica una salida visible ya válida de Movimiento -- sigue
  // existiendo una única materialización por turno.
  if (protocolV2Enabled && knowledgeGraphEnabled && (
    gramaticaActivaAlInicio === 'destino' || missionAdapter || missionAdapterProspectivo
  )) {
    if (
      progreso && progreso.evento === PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_PROPUESTA
      && nuevaHipotesisRelacionalProyeccion
    ) {
      // P4 tiene prioridad ABSOLUTA sobre gobernanzaMaterializacionRigeEsteTurno
      // Y sobre movimientoRigeMaterializacion (ver corrección de arriba):
      // GobernanzaMaterializacion.js decide Transformar/Determinista/Preservar
      // para la materialización ORDINARIA de un turno EXPLORANDO+grafo, pero
      // nunca evaluó (ni pudo evaluar) formulacionCongelada -- esa decisión
      // es estructuralmente ajena a P4. Saltarse este contrato aquí
      // reintroduciría exactamente el bypass que este incremento cierra
      // (hallazgo real: turnos que a la vez proponen una Hipótesis Y
      // califican para la evaluación de Gobernanza).
      // Antes P4: formulacionCongelada nunca es autoridad visible por sí
      // sola — viaja como material crudo (ver renderizarContenidoContrato
      // en AgoraPrompts.js), nunca como materialCandidato (no es lenguaje
      // natural, no puede usarse tal cual).
      contratoIntervencionDestino = createContratoIntervencion({
        funcion: 'VALIDAR',
        contenido: {
          tipo: 'relacion_transformacional_propuesta',
          gainType: 'RESOLVER_VEREDICTO',
          estructura: { formulacionCongelada: nuevaHipotesisRelacionalProyeccion.formulacionCongelada },
        },
        accionUsuario: { tipo: 'confirmar', objetivo: 'relacion_transformacional' },
        criterioExito: 'el experto confirma, corrige o rechaza la relación transformacional mostrada',
      });
    } else if (movimientoRigeMaterializacion && !missionAdapter && contratoIntervencionMovimiento) {
      // DESTINO conserva su semántica de Movimiento, pero no una segunda
      // autoridad visible: el contrato producido por Movimiento cruza la
      // misma frontera común y el Realizer lo expresa una sola vez.
      const accion = contratoIntervencionMovimiento.accionUsuario || { tipo: 'ninguna', objetivo: null };
      contratoIntervencionDestino = congelarActoUnico({
        ...contratoIntervencionMovimiento,
        contenido: {
          ...contratoIntervencionMovimiento.contenido,
          fidelidadVisibleRequerida: true,
          actosPrimarios: accion.tipo === 'ninguna' ? [] : [{ tipo: accion.tipo, objetivo: accion.objetivo }],
          necesidadPrimaria: accion.tipo === 'ninguna' ? null : { tipo: accion.tipo, objetivo: accion.objetivo },
        },
      });
    } else if (sintesisDestinoAutorizadaAplica) {
      // Antes P5: mismo criterio que P4 — el texto autorizado es material
      // crudo, nunca materialCandidato.
      contratoIntervencionDestino = createContratoIntervencion({
        funcion: 'RESUMIR',
        contenido: {
          tipo: 'sintesis_autorizada',
          gainType: 'RESOLVER_VEREDICTO',
          estructura: { texto: sintesisDestinoAutorizadaPrecalculada.texto },
          fidelidadVisibleRequerida: true,
          materialAfirmable: materialAfirmableParaActo(
            grafoResultado && Array.isArray(grafoResultado.conceptos)
              ? grafoResultado.conceptos : state.knowledgeGraph.conceptos || [],
            objetivoParaContrato && objetivoParaContrato.gananciaCognitiva,
          ).map(c => c.descripcion),
          materialAfirmableScoped: (grafoResultado && Array.isArray(grafoResultado.conceptos)
            ? grafoResultado.conceptos : state.knowledgeGraph.conceptos || [])
            .filter(c => c && c.activo !== false && c.autoridad === 'experto')
            .map(c => ({ sourceId: c.id, texto: c.descripcion, autoridad: c.autoridad, alcance: alcanceEpistemicoConcepto(c) })),
          presuposicionesAutorizadas: [],
          evidenciaBuscada: 'síntesis fiel del material autorizado',
        },
        accionUsuario: { tipo: 'confirmar', objetivo: 'sintesis_propuesta' },
        continuidad: {
          yaConfirmado: ['la relación entre lo que el experto sabía antes, lo que aprendió, y cómo lo aplicó'],
          noDebeRepetirse: ['la relación transformacional, ya confirmada en un turno anterior — esto es la síntesis final, un objeto distinto'],
        },
        criterioExito: 'el experto reconoce la síntesis como fiel a lo que enseñó y la confirma o corrige',
      });
    } else if (!turnoGobernadoPorRespuestaAnterior
      && (missionAdapter || (gramaticaParaContrato !== 'destino' && missionAdapterProspectivo))
      && !(actoCognitivoSeleccionadoCanonico
        && ['RETURN_GOVERNED_GAIN', 'RETURN_UNDERSTANDING', 'PROPOSE_MISSION_CLOSURE']
          .includes(actoCognitivoSeleccionadoCanonico.operator))) {
      // La misión aporta el vocabulario y el criterio; el movimiento, el
      // grafo y la materialización siguen siendo comunes.
      contratoIntervencionDestino = congelarActoUnico(construirContratoIntervencionDeMision({
        gramatica: gramaticaParaContrato,
        movimiento: movimientoParaContrato,
        parsed,
        progreso,
        continuidadMision: (state.knowledgeGraph.conceptos || [])
          .filter(c => c && c.activo !== false && c.autoridad === 'experto')
          .map(c => c.descripcion),
        objetivoConversacional: objetivoParaContrato,
        materialAfirmable: materialAfirmableParaActo(
          grafoResultado && Array.isArray(grafoResultado.conceptos)
            ? grafoResultado.conceptos : state.knowledgeGraph.conceptos || [],
          objetivoParaContrato && objetivoParaContrato.gananciaCognitiva,
        ).map(c => c.descripcion),
        materialAfirmableScoped: materialAfirmableParaActo(
          grafoResultado && Array.isArray(grafoResultado.conceptos)
            ? grafoResultado.conceptos : state.knowledgeGraph.conceptos || [],
          objetivoParaContrato && objetivoParaContrato.gananciaCognitiva,
        )
          .map(c => ({ sourceId: c.id, texto: c.descripcion, autoridad: c.autoridad, alcance: alcanceEpistemicoConcepto(c) })),
        materialExplorable: objetivoParaContrato && objetivoParaContrato.evidenciaBuscada
          ? objetivoParaContrato.evidenciaBuscada : null,
        domainScaffold: domainScaffoldEsteTurno,
        comprensionTrabajo: comprensionTrabajoEsteTurno,
        focoConversacionalActual,
        historialVisibleReciente,
        necesidadConversacional: objetivoParaContrato && objetivoParaContrato.necesidadConversacional,
        evidenciaBuscada: objetivoParaContrato && objetivoParaContrato.evidenciaBuscada,
        protocoloEstado: progreso && progreso.protocoloEstadoSiguiente
          ? progreso.protocoloEstadoSiguiente : protocoloEstadoActual,
        estadoProspectivoTerminal: estadoProspectivo.terminal,
        actoCognitivoVisible: actoCognitivoSeleccionadoCanonico,
      }));
    } else if (actoCognitivoSeleccionadoCanonico !== null) {
      // A diferencia de P4/P5 (arriba), el turno genérico SÍ es exactamente
      // lo que GobernanzaMaterializacion.js ya gobierna cuando aplica
      // (Transformar/Determinista/Preservar) -- r.parsed.mensaje ya es su
      // resultado final, nunca reconstruir un contrato encima.
      // Turno genérico (antes P1 puro): EXPLORANDO, ESPERANDO_CONFIRMACION,
      // LISTO_PARA_SINTESIS sin autorización todavía, rechazo, corrección.
      // mensajeBaseEfectivo (Capa 1/Realizador previo, SIN el next_user_action
      // ya anexado por componerMensajeFinal arriba) viaja como
      // materialCandidato — la frontera decide si lo usa tal cual o
      // remateralializa, nunca autoridad directa.
      const nextUserAction = progreso && progreso.nextUserAction;
      const tipoAccion = normalizarTipoAccionUsuario(nextUserAction && nextUserAction.tipo);
      const huboRechazoOCorreccion = !!(parsed && (
        parsed.clasificacion_respuesta === 'rechaza' || parsed.clasificacion_respuesta === 'corrige'
      ));
      const funcionPorTipoAccion = {
        responder_pregunta: 'PRECISAR', dar_ejemplo: 'PRECISAR', elegir_opcion: 'PRECISAR', confirmar: 'VALIDAR',
      };
      const funcionGenerica = huboRechazoOCorreccion ? 'RECONOCER_CORREGIR' : (funcionPorTipoAccion[tipoAccion] || 'REFLEJAR');
      const oportunidadDelActo = Array.isArray(oportunidadesConversacionales)
        ? oportunidadesConversacionales.find(o => o
          && (o.semanticTarget === actoCognitivoSeleccionadoCanonico.target
            || o.semanticUnknownId === actoCognitivoSeleccionadoCanonico.target
            || o.unknownId === actoCognitivoSeleccionadoCanonico.target)
          && (!actoCognitivoSeleccionadoCanonico.subjectRef
            || o.referenteSemantico === actoCognitivoSeleccionadoCanonico.subjectRef))
        : null;
      // PROPOSE_MISSION_CLOSURE_VISIBLE_ACTION_CONFLATED_WITH_RESPONSE_
      // EXPECTATION (C007, Daniel-adjudicated, real evidence: logistica_c0
      // fresh-live turn 11, session live_complete_logistica_c0_11ec6033).
      // EXPECTS_DIRECTED_USER_RESPONSE != REQUIRES_REQUEST_SHAPED_VISIBLE_
      // REALIZATION -- OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA correctly
      // governs whether the NEXT user turn is interpreted as a directed
      // response to this act (see crearContextoActoPendiente,
      // DecisorIntervencionConversacional.js), a fact PROPOSE_MISSION_
      // CLOSURE legitimately shares with the ASK_*/REPAIR_UNDERSTANDING
      // operators. It does NOT decide whether THIS turn's OWN visible
      // realization must itself be phrased as a request -- that is a
      // separate fact, owned by OPERADORES_QUE_REQUIEREN_SOLICITUD_VISIBLE,
      // which PROPOSE_MISSION_CLOSURE does not belong to: a closure
      // proposal does not ask the user for new domain knowledge.
      const actoRequiereSolicitudVisible = !!(actoCognitivoSeleccionadoCanonico
        && OPERADORES_QUE_REQUIEREN_SOLICITUD_VISIBLE.includes(actoCognitivoSeleccionadoCanonico.operator));
      const tipoAccionContratada = actoRequiereSolicitudVisible ? 'responder_pregunta' : tipoAccion;
      const objetivoAccionContratada = (nextUserAction && nextUserAction.objetivo)
        || (oportunidadDelActo && oportunidadDelActo.dimension) || null;
      contratoIntervencionDestino = createContratoIntervencion({
        funcion: funcionGenerica,
        actoCognitivoVisible: actoCognitivoSeleccionadoCanonico,
        contenido: {
          tipo: 'turno_generico',
          // El contrato final conserva la decisión de Movimiento como
          // contexto de ejecutabilidad; no crea un WHAT nuevo.
          movimiento: movimientoAutoridad && (movimientoAutoridad.movimiento
            || (movimientoAutoridad.contenido && movimientoAutoridad.contenido.movimiento)) || null,
          gainType: huboRechazoOCorreccion ? 'REPARAR_INTERVENCION' : (tipoAccion === 'confirmar' ? 'RESOLVER_VEREDICTO' : 'OBTENER_EVIDENCIA'),
          // UNGROUNDED_OBSERVACION_TRANSPORTED_AS_REALIZER_AUTHORITY (C007,
          // Daniel-adjudicated, real evidence: logistica_c0 fresh-live turn
          // 11, session live_complete_logistica_c0_11ec6033).
          // PRODUCER_FREE_FORM_TEXT_DOES_NOT_CREATE_CONTRACTUAL_VISIBLE_
          // AUTHORITY: r.parsed.observacion is Capa1's own free-form gloss --
          // its accompanying observacionNaturaleza (observacion_directa/
          // interpretacion/inferencia) is SELF-DECLARED by the Producer,
          // never independently verified by any grounding/extractive check
          // (unlike materialAfirmable's concept descriptions, or gain
          // support's own dedicated validator+corroborator) -- so no value
          // of it is a certified governance owner for visible content.
          // Real evidence: observacionNaturaleza:"interpretacion" carried
          // Producer-invented terminology ("gobernanza predictiva del
          // flujo") straight into the Realizer as if it were "lo que se
          // entendió", which Fidelity's own correct, unmodified lexical-
          // fidelity law then necessarily rejected on every attempt. Same
          // treatment, same rationale, as materialCandidato immediately
          // below (a producer draft, not governed affirmative material) --
          // never rendered as Realizer content authority. Producer's own
          // observacion remains available elsewhere for diagnostics (this
          // turn's own comprensión/reconciliation events still carry
          // r.parsed.observacion in full) -- only this ONE transport into
          // contractual visible authority is removed.
          observacion: null,
          entendido: (parsed && parsed.entendido && typeof parsed.entendido === 'object') ? parsed.entendido : null,
          unknownId: oportunidadDelActo && (oportunidadDelActo.semanticUnknownId || oportunidadDelActo.unknownId) || null,
          // Capa1.message is a producer draft, not governed affirmative
          // material. Once a canonical cognitive act exists, transporting
          // that free draft would let an unsupported preamble accompany a
          // different contracted WHAT. Realizer receives only the frozen
          // act and independently governed material.
          materialCandidato: null,
          // next_user_action legacy may describe a pending grammar dimension,
          // but it is not a second semantic authority once Decision froze an
          // act. The Realizer derives the request from that canonical WHAT.
          preguntaSugerida: null,
          fidelidadVisibleRequerida: true,
        },
        accionUsuario: {
          tipo: tipoAccionContratada,
          objetivo: objetivoAccionContratada,
          viaAcceso: movimientoAutoridad && movimientoAutoridad.viaAcceso
            ? movimientoAutoridad.viaAcceso : null,
        },
        criterioExito: 'el experto reconoce lo que se entendió y puede continuar la conversación con naturalidad',
      });
    }
  }

  // Contador de intentos ambiguos: solo aplica bajo V2. Se reinicia en
  // cualquier transición que no sea "seguimos sin resolver la confirmación"
  // — aclaracion_solicitada y rechazo_sin_detalle lo incrementan (comparten
  // el mismo límite de escalamiento hacia el fallback binario restringido).
  const protocoloIntentosAmbiguosNuevo = protocolV2Enabled && !avanzaReal && (
    progreso.evento === PROTOCOLO_EVENTOS.ACLARACION_SOLICITADA || progreso.evento === PROTOCOLO_EVENTOS.RECHAZO_SIN_DETALLE
  ) ? (state.protocoloIntentosAmbiguos || 0) + 1 : 0;

  // Contexto explícito de corrección/síntesis vigente (Incremento 3/4). Solo
  // V2 los escribe; en legacy se pasan intactos — nadie los toca, así que
  // un rollback a legacy nunca destruye metadata V2 (ver CognitiveState.js).
  let protocoloCorreccionPendienteNuevo = state.protocoloCorreccionPendiente || null;
  // debeVersionarSintesis: bandera pura — _confirmarInteraccion construye el
  // objeto canónico real una vez que existe turno.turnoId (esta función es
  // pura y no lo tiene todavía).
  let debeVersionarSintesis = false;
  if (protocolV2Enabled && !avanzaReal) {
    if (protocoloEstadoActual === 'LISTO_PARA_SINTESIS') {
      // La corrección pendiente (si existía) ya se usó para construir el
      // prompt de ESTE turno — se consume aquí; nunca sobrevive a una
      // segunda síntesis ya incorporada.
      protocoloCorreccionPendienteNuevo = null;
      // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- a mission-closure
      // proposal (evento MISSION_CLOSURE_PROPUESTA) is NOT a synthesis: never
      // write protocoloSintesisVigente for it.
      debeVersionarSintesis = !sintesisDestinoNoElegiblePrecalculada
        && progreso.evento !== PROTOCOLO_EVENTOS.MISSION_CLOSURE_PROPUESTA;
    }
    if (progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_CORREGIDA || progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_RECHAZADA) {
      // Ciclo Cognitivo de Descubrimiento (ADR) — corrección de la brecha de
      // síntesis: "corrige" y "rechaza" ya NO comparten un campo
      // indistinguible. El "tipo" viaja en el propio estado — nunca se
      // vuelve a inferir más adelante a partir de otra cosa (ver
      // AgoraPrompts.buildProtocoloBloqueSintesisGrafo, que exige tipo:
      // 'corrige' explícito para la rama de edición dirigida).
      const detalle = typeof parsed.correccion_detalle === 'string' && parsed.correccion_detalle.trim()
        ? parsed.correccion_detalle
        : null;
      protocoloCorreccionPendienteNuevo = detalle
        ? { tipo: progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_RECHAZADA ? 'rechaza' : 'corrige', detalle }
        : null;
    }
  }
  if (avanzaReal) {
    // Avance real: nueva gramática, ningún residuo del ciclo de cierre anterior.
    protocoloCorreccionPendienteNuevo = null;
  }

  return {
    aportesBrutos, nuevosSlots, slotsActualizados, grafoResultado,
    gate, avanzaReal,
    gramaticaSiguiente, gramaticasCompletadasNuevas, statusNuevo,
    mensajeCirculo: mensajeCircle,
    mensajeBase: mensajeBaseEfectivo, mensajeFinalProtocolo,
    // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- the subject in force
    // this turn: taken from progreso's own freshly-frozen value when a
    // transition set one (MISSION_CLOSURE_PROPUESTA), else the subject that
    // governed this turn's contract selection. _confirmarInteraccion
    // persists it as protocoloConfirmacionSujeto (cleared on any advance).
    confirmationSubject: (progreso && progreso.confirmationSubject) || confirmationSubject,
    protocoloEstadoActual, progreso, protocoloIntentosAmbiguosNuevo,
    protocoloCorreccionPendienteNuevo, debeVersionarSintesis,
    resultadoSuficiencia,
    diagnosticoEstructuralTransformacional,
    // circulomejora006_act10l — pass-through puro (ver parámetros de
    // entrada, arriba): _confirmarInteraccion los usa para proyectar
    // protocoloHipotesisTransformacionalPendiente y limpiar
    // protocoloObjetivoRelacionalDirigido, SOLO cuando progreso.evento
    // confirma que la propuesta realmente ocurrió este turno.
    nuevaHipotesisRelacionalProyeccion,
    // CERRAR_FIDELIDAD_DE_SINTESIS_DE_DESTINO — pass-through puro: identidad
    // de la Afirmación cuyo texto reconstruido gobernó mensajeBaseEfectivo
    // este turno (solo cuando sintesisDestinoAutorizadaAplica), para que
    // _confirmarInteraccion pueda propagarla hacia protocoloSintesisVigente
    // (ver bloque debeVersionarSintesis) — sin esto, la identidad se pierde
    // exactamente en el turno en que la síntesis se muestra.
    sintesisDestinoAutorizadaIdentidad: sintesisDestinoAutorizadaAplica
      ? {
          afirmacionTransformacionalId: sintesisDestinoAutorizadaPrecalculada.afirmacionId,
          afirmacionVersion: sintesisDestinoAutorizadaPrecalculada.afirmacionVersion,
          fuenteSemantica: fuenteSemanticaAfirmacion(
            sintesisDestinoAutorizadaPrecalculada.afirmacionId,
            sintesisDestinoAutorizadaPrecalculada.afirmacionVersion,
          ),
        }
      : null,
    // S1_R_INCREMENTO_2 — pass-through puro (ver parámetro de entrada,
    // arriba): _confirmarInteraccion lo usa, dentro de la MISMA transacción,
    // para abrir la reparación S1-R exactamente cuando progreso.evento
    // confirma que el rechazo con alcance RELACION realmente ocurrió.
    aperturaS1RPrecalculada,
    // FRONTERA_INTERVENCION_VISIBLE_1 — null fuera de 'destino'+V2+grafo
    // (comportamiento anterior byte a byte). El llamador
    // (_procesarBajoExclusividad), ANTES de la transacción, lo materializa
    // y sobreescribe mensajeCirculo/mensajeFinalProtocolo con el resultado.
    contratoIntervencionDestino,
    estadoProspectivo,
  };
}

class InteraccionCognitivaWriter {
  /**
   * @param {object} config
   * @param {import('../persistence/CognitiveUnitOfWork').CognitiveUnitOfWork} config.unitOfWork
   * @param {import('../llm/LLMService').LLMService} config.llmService
   * @param {boolean} [config.protocolV2Enabled] — Incremento 3, punto único de
   *   activación del contrato nuevo (ver bin/start-server.js,
   *   CIRCULO_PROGRESS_PROTOCOL_V2). Resuelto UNA VEZ al construir el writer
   *   — nadie más en el sistema vuelve a leer esta condición: la API HTTP, el
   *   bridge y el cliente legacy permanecen sin ningún conocimiento de ella.
   *   false (default) = comportamiento productivo actual, intacto.
   * @param {boolean} [config.knowledgeGraphEnabled] — Incremento 1 (Grafo de
   *   Conocimiento vivo), CIRCULO_KNOWLEDGE_GRAPH_ENABLED. Solo tiene efecto
   *   junto con protocolV2Enabled===true (bin/start-server.js rechaza en
   *   bootstrap la combinación inversa). false (default) = comportamiento
   *   actual intacto, incluso con protocolV2Enabled activo.
   * @param {boolean} [config.movimientoConversacionalEnabled] — vertical
   *   slice del Motor de Movimientos Conversacionales (Project OS,
   *   ADR-Motor-de-Movimientos-Conversacionales.md), CIRCULO_MOVIMIENTO_
   *   CONVERSACIONAL_ENABLED. Solo tiene efecto junto con
   *   knowledgeGraphEnabled===true (bin/start-server.js rechaza en
   *   bootstrap la combinación inversa — la política lee el grafo, no
   *   existe sin él). false (default) = comportamiento actual intacto,
   *   byte-idéntico, incluso con los otros flags activos.
   */
  constructor({
    unitOfWork, llmService, downstreamDispatcher = null,
    producerExecutionCoordinator = null,
    // FIDELITY_EXECUTOR_FAILURE != FIDELITY_VERDICT — mismo mecanismo neutral
    // de escalación que producerExecutionCoordinator (ProducerExecutionCoordinator
    // es genérico, no específico del productor), pero un coordinador propio:
    // la tarea de Fidelity nunca comparte identity/escalation state con la
    // del productor cognitivo. Default sin fallback (mismo patrón de arriba)
    // preserva byte a byte el comportamiento previo cuando no se configura.
    fidelityExecutionCoordinator = null,
    // C007 — REALIZER EXECUTION RECOVERY — same neutral mechanism, its own
    // coordinator/task identity (the frozen Contract), same no-fallback
    // default when unconfigured.
    realizerExecutionCoordinator = null,
    protocolV2Enabled = false, knowledgeGraphEnabled = false, movimientoConversacionalEnabled = false,
    // C007 CONVERSATIONAL ENGINE STABILIZATION -- DETERMINISTIC REPLAY
    // CAPTURE (Human Canary observability gap correction). Opt-in, off by
    // default -- see src/observability/ReplayFingerprints.js and this
    // class's own _capturarPreStateSiCorresponde/_capturarTerminalReplaySiCorresponde.
    deterministicReplayCaptureEnabled = false,
  }) {
    if (!unitOfWork || typeof unitOfWork.ejecutar !== 'function')
      throw new Error('InteraccionCognitivaWriter: unitOfWork es requerido.');
    if (!llmService || typeof llmService.call !== 'function')
      throw new Error('InteraccionCognitivaWriter: llmService es requerido.');

    this._unitOfWork = unitOfWork;
    this._llmService = llmService;
    this._producerExecutionCoordinator = producerExecutionCoordinator
      || new ProducerExecutionCoordinator({ primary: llmService });
    this._fidelityExecutionCoordinator = fidelityExecutionCoordinator
      || new ProducerExecutionCoordinator({ primary: llmService });
    this._realizerExecutionCoordinator = realizerExecutionCoordinator
      || new ProducerExecutionCoordinator({ primary: llmService });
    this._protocolV2Enabled = !!protocolV2Enabled;
    this._knowledgeGraphEnabled = !!knowledgeGraphEnabled;
    this._movimientoConversacionalEnabled = !!movimientoConversacionalEnabled;
    this._deterministicReplayCaptureEnabled = !!deterministicReplayCaptureEnabled;
    // Opcional (Incremento 7d, corrección post-revisión): despacho INMEDIATO
    // del downstream, fuera de cualquier transacción, cuando
    // _confirmarInteraccion decide (dentro de su propia transacción) que
    // corresponde solicitarlo. Es solo una optimización de latencia — la
    // garantía real de que el downstream se ejecute vive en el outbox
    // durable (SqliteDownstreamOutboxRepository) más el barrido de
    // recuperación explícito (PipelineDownstreamDispatcher.recuperarPendientes),
    // no en esta llamada.
    this._downstreamDispatcher = downstreamDispatcher;

    // Single-flight por (sesionId, turnoClienteId).
    this._enVueloPorClave = new Map();
    // Serialización cognitiva por sesionId (cola encadenada de Promises).
    this._colaPorSesion = new Map();
  }

  /**
   * Confirma una interacción cognitiva completa. Único método público.
   * @param {object} params
   * @param {string} params.sesionId
   * @param {string} params.mensajeUsuario
   * @param {string|null} [params.turnoClienteId]
   * @returns {Promise<object>} { ok, httpStatus, ... }
   */
  async procesar({ sesionId, mensajeUsuario, turnoClienteId }) {
    // 1. Validación de entrada — antes de tocar cualquier mecanismo de concurrencia.
    this._validarEntrada({ sesionId, mensajeUsuario, turnoClienteId });

    // 2. Single-flight por (sesionId, turnoClienteId) — turnoClienteId es
    // obligatorio (DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §5): ya no existe un
    // camino de /grammar-turn sin clave de idempotencia.
    const clave = `${sesionId}:${turnoClienteId}`;
    if (this._enVueloPorClave.has(clave)) return this._enVueloPorClave.get(clave);

    const promesa = this._encolarPorSesion(
      sesionId,
      () => this._procesarBajoExclusividad({ sesionId, mensajeUsuario, turnoClienteId }),
    );
    this._enVueloPorClave.set(clave, promesa);
    try {
      return await promesa;
    } finally {
      this._enVueloPorClave.delete(clave); // 10. liberar single-flight
    }
  }

  _validarEntrada({ sesionId, mensajeUsuario, turnoClienteId }) {
    if (!sesionId || typeof sesionId !== 'string')
      throw new Error("InteraccionCognitivaWriter: 'sesionId' es requerido.");
    if (!mensajeUsuario || typeof mensajeUsuario !== 'string' || !mensajeUsuario.trim())
      throw new Error("InteraccionCognitivaWriter: 'mensajeUsuario' es requerido.");
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §5 — turnoClienteId pasa a ser
    // obligatorio: es la base tanto de la idempotencia de Turno ya
    // completado (comportamiento previo) como de la nueva admisión durable
    // de EntradaConversacional (ver _procesarBajoExclusividad). La UI real
    // (circulo_v0_bridge.html, build_bridge.js) ya lo genera y lo envía en
    // el 100% de las llamadas — nunca fue, en la práctica, verdaderamente
    // opcional.
    if (!turnoClienteId || typeof turnoClienteId !== 'string')
      throw new Error("InteraccionCognitivaWriter: 'turnoClienteId' es requerido.");
  }

  /**
   * 3. Serialización cognitiva por sesionId: encola `tarea` para que se
   * ejecute solo después de que cualquier tarea previa de la MISMA sesión
   * haya terminado (éxito o fallo) — abarca todo el ciclo (cargar estado →
   * LLM → evaluar → persistir), no solo la transacción SQLite. Sesiones
   * distintas nunca se esperan entre sí.
   */
  _encolarPorSesion(sesionId, tarea) {
    const colaAnterior = this._colaPorSesion.get(sesionId) || Promise.resolve();
    const miEjecucion = colaAnterior.then(tarea, tarea);
    // Lo que queda encadenado para el siguiente en la fila nunca debe rechazar
    // (si no, rompería la cadena) — el resultado real de ESTA tarea se
    // devuelve igual a quien llamó, vía miEjecucion.
    this._colaPorSesion.set(sesionId, miEjecucion.catch(() => {})); // 10. liberar cola (implícito: el siguiente ya puede empezar)
    return miEjecucion;
  }

  async _procesarBajoExclusividad({ sesionId, mensajeUsuario, turnoClienteId }) {
    // 4. Re-chequeo de idempotencia en persistencia, ya bajo exclusividad de sesión.
    // turnoClienteId es obligatorio (validado en _validarEntrada) — ya no
    // existe un camino sin clave de idempotencia para /grammar-turn.
    const turnoExistente = this._unitOfWork.turnoRepo.findByTurnoClienteId(sesionId, turnoClienteId);
    if (turnoExistente) return this._reconstruirResultadoIdempotente(sesionId, turnoExistente);

    // 5. Cargar el estado canónico vigente (o crearlo en memoria si es la
    // primera interacción de la sesión — no se persiste todavía; se
    // persistirá por primera vez dentro de la misma transacción que el
    // primer Turno exitoso, nunca como una fila "fantasma" sin evidencia).
    const json = this._unitOfWork.stateRepo.load(sesionId);
    // S1-R-SCOPE1 (RECUPERACION_PROACTIVA_DE_CANDIDATA_INCOMPATIBLE) —
    // `let`, no `const`: el bloque proactivo de más abajo necesita
    // reasignar esta MISMA referencia (nunca solo `estadoActual`) porque
    // parte de la rama genérica de construcción, más abajo, lee
    // deliberadamente `state.protocoloObjetivoRelacionalDirigido` (el valor
    // durable de ANTES de este turno, no la foto post-reconciliación) —
    // ver protocoloObjetivoRelacionalDirigidoNuevo. Fuera de ese bloque,
    // nunca se reasigna: comportamiento anterior intacto byte a byte.
    let state = json ? deserializeState(json) : createInitialState({ sesionId });
    // Fotografía de identidad previa al turno. Las fases posteriores pueden
    // reemplazar referencias de estado mientras canonicalizan el grafo; la
    // resolución de reemplazos positivos debe comparar contra esta frontera,
    // no contra una referencia potencialmente ya mutada.
    const idsConceptosAlInicioTurno = new Set(
      ((state.knowledgeGraph && state.knowledgeGraph.conceptos) || []).map(c => c.id),
    );
    const gramaticaActivaAlInicio = state.gramaticaActiva;
    // Snapshot of the producer-contract loop for later materialization
    // branches. The loop-local validation object must not leak its scope;
    // downstream code consumes this explicit post-loop status instead.
    let validacionContratoFinal = null;
    let intentosContratoFinal = 0;

    if (!gramaticaActivaAlInicio) {
      return {
        ok: false, httpStatus: 409, codigo: 'SIN_GRAMATICA_ACTIVA',
        mensaje: 'La sesión ya completó las 5 gramáticas; el downstream pertenece a un incremento posterior.',
      };
    }

    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 — FRONTERA DE ADMISIÓN
    // (INTERVENCION_ADMITIDA). Todo lo de arriba (forma del body, single-
    // flight, exclusividad de sesión, idempotencia de Turno ya completado,
    // gramaticaActiva vigente) es determinístico: no consume el mensaje
    // mediante LLM, no produce ningún efecto cognitivo. A partir de aquí
    // "el usuario dijo X" se vuelve un hecho durable, en su propia
    // transacción, ANTES de cualquier llamada LLM — el rechazo proactivo
    // S1-R y la Reconciliación Histórica, ambos más abajo, corren DESPUÉS
    // de esta frontera sin cambios (son efectos pre-finales legítimos
    // preexistentes — DURABILIDAD_ENTRADA_CONVERSACIONAL_1 no los absorbe
    // ni los modifica).
    //
    // Invariante adoptado: una vez admitida determinísticamente una
    // intervención del usuario, su existencia durable no depende de
    // ninguna operación cognitiva o externa posterior. El Provider puede
    // fallar, el LLM puede truncar, el parser puede fallar, el proceso
    // puede morir, el Realizador puede fallar — la entrada permanece.
    let entradaConversacional = this._unitOfWork.entradaConversacionalRepo.findByTurnoClienteId(sesionId, turnoClienteId);
    if (entradaConversacional) {
      // Retry de una intervención ya admitida — nunca puede estar
      // COMPLETADO aquí: si lo estuviera, turnoRepo.findByTurnoClienteId ya
      // la habría resuelto arriba, porque marcar COMPLETADO ocurre en la
      // MISMA transacción que crear el Turno (ver _confirmarInteraccion,
      // _procesarValidacionRelacionTransformacionalDestino,
      // _recuperarOCompletarConvergenciaTransformacional). Mismo
      // turnoClienteId + mismo payload → se reprocesa con el contenido
      // DURABLE de la entrada; nunca se vuelve a confiar en el payload que
      // trae esta solicitud (podría venir de un reintento del cliente tras
      // timeout, con el mismo texto por construcción, pero la fuente de
      // verdad pasa a ser la fila ya admitida).
      if (entradaConversacional.mensajeUsuario !== mensajeUsuario) {
        return {
          ok: false, httpStatus: 409, codigo: 'CONFLICTO_DE_IDEMPOTENCIA',
          mensaje: `turnoClienteId '${turnoClienteId}' ya fue admitido con un mensaje distinto en esta sesión — no se ejecuta ninguna llamada al LLM ni se elige silenciosamente uno de los dos mensajes.`,
        };
      }
      mensajeUsuario = entradaConversacional.mensajeUsuario;
    } else {
      const turnoIdReservado = generateTurnoId();
      entradaConversacional = this._unitOfWork.ejecutar(({ entradaConversacionalRepo, eventRepo }) => {
        const nueva = createEntradaConversacional({
          turnoId: turnoIdReservado, sesionId, turnoClienteId, mensajeUsuario,
        });
        entradaConversacionalRepo.save(nueva);
        eventRepo.save(createEvent({
          tipo: 'entrada_conversacional.admitida', sesionId, turnoId: turnoIdReservado,
          correlationId: turnoClienteId, payload: { turnoClienteId },
        }));
        return nueva;
      });
    }
    // Identidad interna durable de ESTE procesamiento — reservada una sola
    // vez en admisión, reutilizada (nunca regenerada) en cualquier reintento
    // y, si el procesamiento converge, en el turnoId del cognitive_turno
    // final (ver _confirmarInteraccion/_procesarValidacionRelacionTransformacionalDestino/
    // _recuperarOCompletarConvergenciaTransformacional). Distinta de
    // turnoClienteId (identidad idempotente EXTERNA, provista por el
    // cliente) — nunca la sustituye.
    const turnoIdReservadoEnAdmision = entradaConversacional.turnoId;
    // DETERMINISTIC REPLAY CAPTURE -- exact preState, right after admission
    // reserves turnoId, before any cognitive mutation (see method docstring).
    this._capturarPreStateSiCorresponde({
      turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
      gramaticaActivaAlInicio: state.gramaticaActiva, state,
    });

    // 6. Fuera de transacción: LLM, parsing, evaluación de Gate, decisión.
    // Incremento 2 ("toda información estructurada que consume el LLM
    // proviene exclusivamente de una proyección oficial del grafo"): con
    // protocolV2Enabled && knowledgeGraphEnabled, priorContext nunca se
    // calcula desde state.slots — queda null y ningún contrato lo lee (ver
    // grafoModoSesion/contextoGrafoAnteriores más abajo, que lo reemplazan
    // por completo). Bajo legacy o V2 sin grafo, sin cambios.
    const priorContext = (this._protocolV2Enabled && this._knowledgeGraphEnabled)
      ? null
      : (gramaticaActivaAlInicio !== 'destino' ? serializeSlots(state.slots) : null);

    // ── FASE A: Reconciliación histórica (Incremento 1, corrección
    // arquitectónica) ──────────────────────────────────────────────────────
    // Corre ANTES de construcción, en su propia transacción — "¿algo que ya
    // creíamos quedó ahora confirmado, resuelto o descartado?", nunca "¿qué
    // es nuevo aquí?". Solo bajo protocolV2Enabled && knowledgeGraphEnabled
    // && EXPLORANDO (bootstrap ya rechazó KG=ON/V2=OFF). Gate: incertidumbres
    // materiales abiertas O inferencias materiales — nunca "cualquier
    // elemento abierto" (ver GrafoProyeccion.inferenciasMaterialesActivas).
    // `estadoActual` es la foto verdaderamente-antes hasta que esta fase
    // (si corre y tiene éxito) la reemplaza por la foto post-reconciliación
    // — la única que construcción, más abajo, llega a ver.
    let estadoActual = state;
    let protocoloEstadoActualInicio = state.protocoloEstado || 'EXPLORANDO';
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
    // AMBITO_DE_CIERRE_GOBIERNA_PRODUCTORES_PERO_NO_LA_FRONTERA_COMUN_DE_MUTACION)
    // — ámbito causal de mutación mientras un ciclo de pregunta final está
    // en curso (presupuesto ya consumido, todavía sin SATISFECHA): SOLO
    // las dimensiones del snapshot original. Derivado ÚNICAMENTE de
    // state.protocoloIntencionCierre (la foto verdaderamente-antes de este
    // turno — nunca de nada que este turno vaya a decidir), calculado AQUÍ
    // (antes de FASE A: Reconciliación histórica, más abajo) porque debe
    // gobernar TODO productor de mutaciones de este turno, no solo
    // construcción — ver validarMutacionesDestructivasBajoCierre. `null`
    // fuera de un ciclo de cierre en curso — el gate queda inerte en ese
    // caso, byte a byte igual que antes de esta corrección.
    const ambitoMutacionCierreEsteTurno = (
      state.protocoloIntencionCierre
      && state.protocoloIntencionCierre.presupuestoPreguntaFinalConsumido
      && state.protocoloIntencionCierre.estado !== 'SATISFECHA'
      && Array.isArray(state.protocoloIntencionCierre.deudasFinalesSnapshot)
      && state.protocoloIntencionCierre.deudasFinalesSnapshot.length > 0
    )
      ? new Set(state.protocoloIntencionCierre.deudasFinalesSnapshot.map(d => d.dimension))
      : null;
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — traza durable (requisito 5:
    // "origen; concepto afectado; dimensión; causa; turno") de cualquier
    // mutación destructiva rechazada por validarMutacionesDestructivasBajoCierre,
    // sea cual sea el productor (construcción o Reconciliación Histórica).
    // Hay TRES puntos de gate independientes en el mismo turno (inferencias
    // rechazadas de Reconciliación, conocimientoContradicho de Reconciliación,
    // marcarObsoletos de construcción). Cada uno escribe bajo su PROPIA clave
    // — refleja el último intento realmente evaluado DE ESE punto (nunca se
    // acumulan reintentos del mismo punto) — sin que un punto sin nada que
    // rechazar borre lo que otro punto ya encontró este turno. El valor
    // final threadeado a _confirmarInteraccion es el aplanado de todas las
    // claves; nunca se descarta en silencio.
    const mutacionesLateralesRechazadasPorOrigen = {};
    let mutacionesLateralesRechazadasTraza = [];
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final) — memo en memoria,
    // scope de ESTA ejecución de writer.procesar(): evita que reintentos
    // sucesivos del MISMO productor (p.ej. construcción insistiendo en la
    // misma obsolescencia no autorizada turno tras turno de contrato)
    // vuelvan a llamar al adjudicador para la MISMA identidad. La autoridad
    // verdaderamente durable (entre turnos y tras reinicio) es
    // state.protocoloAutoridadesMutacionValidadas, leída más abajo.
    const cacheValidacionesMutacionEsteTurno = new Map();
    const autoridadesPreviasMutacion = Array.isArray(state.protocoloAutoridadesMutacionValidadas)
      ? state.protocoloAutoridadesMutacionValidadas : [];
    let autoridadesMutacionNuevasEsteTurno = [];
    // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — traza de la última
    // GOBERNANZA_DELTA_DIMENSIONAL ejecutada este turno (los dos call sites
    // de construcción son mutuamente excluyentes dentro de un mismo turno:
    // nunca se pisan, solo uno de los dos corre según el estado del turno).
    let gobernanzaDimensionTrazaEsteTurno = [];

    // S1-R-SCOPE1 (RECUPERACION_PROACTIVA_DE_CANDIDATA_INCOMPATIBLE) — antes
    // de decidir qué rama de protocolo procesa este turno, y ANTES de
    // interpretar mensajeUsuario de ninguna forma (nunca se construye el
    // prompt de confirmación), se verifica si la sesión está esperando
    // confirmación de una Hipótesis sucesora que una reparación S1-R ABIERTA
    // ya sabe, sin necesidad de preguntarle nada a nadie, que es incompatible
    // con el rol que cuestiona — el MISMO criterio exacto que
    // candidataUsaConceptoExcluidoEnResultado ya aplica, reactivamente,
    // dentro de ValidacionRelacionTransformacionalDestinoCasoDeUso (nunca
    // reimplementado aquí, nunca una segunda regla). La diferencia es
    // únicamente CUÁNDO se aplica: aquí, un turno antes, para que el usuario
    // nunca tenga que intentar confirmar una candidata que el sistema ya
    // puede demostrar inválida.
    //
    // Lee siempre la verdad SQL viva de la reparación (hipotesisSucesoraRoles
    // ya persistido en destino_afirmacion_reparaciones_s1r), nunca
    // state.protocoloHipotesisTransformacionalPendiente — ese campo puede
    // haber quedado desactualizado tras un reinicio interrumpido a mitad de
    // convergencia (mismo riesgo ya documentado para el bloque de
    // reinstalación, más abajo — misma razón por la que ESE bloque tampoco
    // confía ciegamente en la proyección).
    //
    // Exclusivo de 'destino'+V2+grafo (misma guarda que el resto del ciclo
    // S1-R): en cualquier otro caso este bloque es un no-op y el contrato
    // anterior queda intacto byte a byte.
    if (
      this._protocolV2Enabled && this._knowledgeGraphEnabled
      && gramaticaActivaAlInicio === 'destino'
      && protocoloEstadoActualInicio === 'VALIDANDO_RELACION_TRANSFORMACIONAL'
    ) {
      const cabezaProactiva = this._unitOfWork.afirmacionTransformacionalRepo.findHeadBySession(sesionId);
      const reparacionProactiva = cabezaProactiva && cabezaProactiva.afirmacion
        && cabezaProactiva.afirmacion.estado === 'AUTORIZADA'
        ? this._unitOfWork.afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
            sesionId, cabezaProactiva.afirmacion.id, cabezaProactiva.afirmacion.version,
          )
        : null;
      if (reparacionProactiva && reparacionProactiva.hipotesisSucesoraId && reparacionProactiva.hipotesisSucesoraRoles) {
        const exclusionProactiva = exclusionesResultadoPorReparacion(reparacionProactiva, cabezaProactiva.afirmacion);
        const idsDelRolAfectadoProactivo = exclusionProactiva
          ? (reparacionProactiva.hipotesisSucesoraRoles[exclusionProactiva.campo] || [])
          : [];
        const esIncompatibleProactivamente = !!exclusionProactiva
          && idsDelRolAfectadoProactivo.some(id => exclusionProactiva.ids.has(id));
        if (esIncompatibleProactivamente) {
          const componenteRelacionalProactivo = exclusionProactiva.campo === 'observabilidadConceptoIds'
            ? 'resultado_observabilidad' : 'mecanismo_resultado';
          // registrarHipotesisSucesoraRechazada/limpiarHipotesisSucesoraCandidata
          // son ambas idempotentes ante retry (identidad determinística por
          // reparacionId+hipotesisId+hipotesisVersion; limpiar un slot ya
          // limpio es un no-op) — mismo criterio que el bloque reactivo
          // equivalente, más abajo, nunca reimplementado dos veces. La
          // Hipótesis NUNCA se borra: sigue existiendo, CANDIDATA, como
          // registro histórico/diagnóstico (Modelo B).
          const turnoIdInvalidacionProactiva = generateTurnoId();
          this._unitOfWork.ejecutar(({ afirmacionTransformacionalRepo, eventRepo }) => {
            afirmacionTransformacionalRepo.registrarHipotesisSucesoraRechazada({
              sesionId, reparacionId: reparacionProactiva.reparacionId,
              hipotesisId: reparacionProactiva.hipotesisSucesoraId,
              hipotesisVersion: reparacionProactiva.hipotesisSucesoraVersion,
              turnoId: turnoIdInvalidacionProactiva,
              correccionDetalle: 'Candidata sucesora incompatible: reutilizaba, sin cambios, el resultado que esta reparación ya cuestiona (detectada proactivamente al iniciar el turno, antes de pedir confirmación — S1-R-SCOPE1, RECUPERACION_PROACTIVA_DE_CANDIDATA_INCOMPATIBLE).',
              roles: reparacionProactiva.hipotesisSucesoraRoles,
            });
            afirmacionTransformacionalRepo.limpiarHipotesisSucesoraCandidata({
              sesionId, reparacionId: reparacionProactiva.reparacionId,
            });
            eventRepo.save(createEvent({
              tipo: 'relacion_transformacional.veredicto_procesado',
              sesionId, turnoId: null, correlationId: `destino_${turnoIdInvalidacionProactiva}`,
              payload: {
                evento: PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_CANDIDATA_INCOMPATIBLE,
                hipotesisEstado: 'CANDIDATA',
                componenteRelacional: componenteRelacionalProactivo,
                causa: 'CANDIDATA_INCOMPATIBLE_CON_REPARACION',
                disparadoPor: 'PROACTIVO_INICIO_TURNO',
              },
            }));
          });
          // El resto de ESTE MISMO turno procesa como si ya estuviera en
          // EXPLORANDO — nunca construye el prompt de confirmación, nunca le
          // pide al usuario que confirme o rechace una candidata que el
          // propio sistema ya sabe inválida. protocoloObjetivoRelacionalDirigido
          // queda activo de inmediato (mismo mecanismo act10k que ya usa el
          // camino reactivo — construirBloqueExploracionDirigidaRelacional/
          // AgoraPrompts, nunca reimplementado aquí) para que la rama
          // EXPLORANDO genérica, más abajo, dirija la pregunta al rol exacto
          // que necesita reemplazo — en este mismo turno, nunca uno después.
          protocoloEstadoActualInicio = 'EXPLORANDO';
          // Reasigna AMBAS referencias al mismo objeto nuevo (ver nota en la
          // declaración de `state`, arriba): algunas piezas de la rama
          // genérica leen `estadoActual` (la foto post-reconciliación) y
          // otras leen deliberadamente `state` (el valor durable de antes de
          // este turno) — ambas deben reflejar la recuperación proactiva por
          // igual, nunca solo una.
          state = estadoActual = {
            ...estadoActual,
            protocoloEstado: 'EXPLORANDO',
            protocoloHipotesisTransformacionalPendiente: null,
            protocoloObjetivoRelacionalDirigido: componenteRelacionalProactivo,
          };
        }
      }
    }

    // circulomejora006_act10j — VALIDANDO_RELACION_TRANSFORMACIONAL delega
    // EXCLUSIVAMENTE a ValidacionRelacionTransformacionalDestinoCasoDeUso —
    // rama TERMINAL respecto a la decisión de este turno: se resuelve y
    // retorna aquí mismo, antes de que corra CUALQUIER pieza de la rama
    // genérica (reconciliación, construcción, decidirProtocolo genérico,
    // Movimiento). Nunca construye el prompt por la ruta genérica, nunca
    // invoca el generador dos veces, nunca vuelve a decidir protocolo ni a
    // aplicar el veredicto — esas cinco responsabilidades ya viven,
    // completas y probadas, dentro del caso de uso (924598d). Exclusivo de
    // 'destino' bajo protocolV2Enabled && knowledgeGraphEnabled (mismo
    // requisito que el resto del ciclo de HipotesisTransformacionalDestino
    // — este estado nunca existe fuera de esa combinación).
    if (
      this._protocolV2Enabled && this._knowledgeGraphEnabled
      && protocoloEstadoActualInicio === 'VALIDANDO_RELACION_TRANSFORMACIONAL'
    ) {
      // S1_R_INCREMENTO_3 / P0-A2 — reinstala, si hace falta, la identidad
      // autoritativa de la Hipótesis pendiente ANTES de delegar (auditoría
      // previa: recuperarContextoAutoritativoRelacionTransformacionalDestino/
      // aplicarVeredictoRelacionTransformacionalDestino, dentro del caso de
      // uso de abajo, exigen emisionesLegitimas — process-local, nunca
      // sobrevive un reinicio). No-op si la emisión ya está disponible este
      // mismo proceso (ver reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable:
      // yaDisponible corta antes de reconstruir nada).
      //
      // Dos fuentes durables posibles para roles/turnoPresentacionId, nunca
      // una tercera vía inventada aquí:
      //   1. Hipótesis sucesora de una reparación S1-R ABIERTA — roles/
      //      turnoPresentacionId ya vivían en
      //      afirmacionTransformacionalRepo (registrarHipotesisSucesoraCandidata,
      //      S1_R_INCREMENTO_3, sin cambios en este incremento).
      //   2. P0-A2 (arranque normal de DESTINO, sin reparación vinculada) —
      //      roles/turnoPresentacionId ahora viajan en la MISMA proyección
      //      ya durable, protocoloHipotesisTransformacionalPendiente (ver
      //      proyectarHipotesisParaEstado) — ningún repositorio nuevo,
      //      ninguna tabla nueva.
      // Si ninguna de las dos aporta ambos datos (proyección de una versión
      // de estado anterior a este incremento, por ejemplo), este bloque no
      // hace nada — aplicarVeredictoRelacionTransformacionalDestino seguirá
      // reportando IDENTIDAD_DE_EMISION_NO_VERIFICABLE explícito más abajo,
      // nunca un fallback silencioso ni una reconstrucción parcial.
      //
      // P0-A2 (invariante 8, "reinicio después del veredicto no reabre la
      // emisión") — exclusivo de pendiente.estado==='CANDIDATA': si ya es
      // 'CONFIRMADA' durablemente (veredicto aplicado y persistido antes de
      // un reinicio que interrumpió la convergencia a Afirmación —
      // ver recuperarHipotesisConfirmadaPendienteDeConvergencia, límite ya
      // documentado, fuera de alcance de este incremento), reinstalar aquí
      // la registraría de nuevo como PENDIENTE en emisionesLegitimas —
      // reabriendo a confirmación/rechazo una emisión que el propio estado
      // durable ya marca resuelta. Sin este resguardo, ese riesgo ya existía
      // (sin acotar) para el camino S1-R original; aquí se cierra para
      // ambos, no solo para el camino nuevo.
      const pendiente = state.protocoloHipotesisTransformacionalPendiente;
      // S1-R-SCOPE1 — calculado una sola vez, junto con reparacionVinculada
      // (ya se necesita esa misma lectura para la reinstalación de arriba),
      // y pasado tal cual al caso de uso — null en cualquier sesión sin
      // reparación ABIERTA (comportamiento anterior intacto).
      let exclusionesResultado = null;
      if (pendiente && pendiente.hipotesisId && pendiente.estado === 'CANDIDATA') {
        const cabeza = this._unitOfWork.afirmacionTransformacionalRepo.findHeadBySession(sesionId);
        const reparacionVinculada = cabeza && cabeza.afirmacion
          ? this._unitOfWork.afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
              sesionId, cabeza.afirmacion.id, cabeza.afirmacion.version,
            )
          : null;
        exclusionesResultado = exclusionesResultadoPorReparacion(reparacionVinculada, cabeza && cabeza.afirmacion);
        const esSucesoraDeReparacionAbierta = !!(
          reparacionVinculada && reparacionVinculada.hipotesisSucesoraId === pendiente.hipotesisId
          && reparacionVinculada.hipotesisSucesoraVersion === pendiente.version
        );
        const rolesParaReinstalar = esSucesoraDeReparacionAbierta
          ? reparacionVinculada.hipotesisSucesoraRoles
          : pendiente.roles;
        const turnoPresentacionIdParaReinstalar = esSucesoraDeReparacionAbierta
          ? reparacionVinculada.hipotesisSucesoraTurnoPresentacionId
          : pendiente.turnoPresentacionId;
        if (rolesParaReinstalar && turnoPresentacionIdParaReinstalar) {
          reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable({
            sesionId, grafoActual: state.knowledgeGraph,
            hipotesisId: pendiente.hipotesisId, version: pendiente.version,
            roles: rolesParaReinstalar, turnoPresentacionId: turnoPresentacionIdParaReinstalar,
          });
        }
      }
      return this._procesarValidacionRelacionTransformacionalDestino({
        sesionId, mensajeUsuario, turnoClienteId, state, gramaticaActivaAlInicio, exclusionesResultado,
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §6 — identidad interna
        // reservada en admisión, reutilizada aquí (nunca regenerada) tanto
        // para correlacionar las llamadas LLM de este método como, si
        // converge, para el turnoId del cognitive_turno final.
        turnoId: turnoIdReservadoEnAdmision,
      });
    }

    const reconciliacionActiva = this._protocolV2Enabled && this._knowledgeGraphEnabled
      && protocoloEstadoActualInicio === 'EXPLORANDO';
    // circulomejora006 (Especificación §2) — única señal estructural
    // confiable de "rechazo explícito": Reconciliación Histórica de ESTE
    // turno produjo inferenciasRechazadas no vacío. Deliberadamente NUNCA
    // se combina con marcarObsoletos (huboObsolescenciaEsteTurno, más abajo
    // en el bucle de construcción) — marcarObsoletos no demuestra por sí
    // solo un rechazo del experto, puede ser refinamiento sin contradicción.
    // "Corrección explícita" distinta de "rechazo" queda sin señal hoy —
    // brecha reportada, no implementada (Especificación §2).
    let huboRechazoEsteTurno = false;
    let dimensionesRechazadasEsteTurno = [];
    // circulomejora006 (corrección final — rechazo visible por identidad):
    // huboRechazoEsteTurno/dimensionesRechazadasEsteTurno (arriba) son la
    // señal CRUDA — cualquier "inferido" rechazado, mostrado o no — y se
    // conservan sin cambios para observabilidad/auditoría. Estas dos son la
    // intersección EXACTA (por id) entre lo que estaba materializado-
    // pendiente-de-veredicto ANTES de este turno y lo que Reconciliación
    // rechazó en él: la ÚNICA señal que puede activar REPARAR_TRAS_RECHAZO
    // (ver más abajo, donde gobierna la llamada a decidirMovimientoDestino).
    // El rechazo de una inferencia interna nunca mostrada sigue corrigiendo
    // el grafo (huboRechazoEsteTurno de arriba, sin cambios) pero nunca
    // produce reparación pública.
    let huboRechazoVisibleEsteTurno = false;
    let dimensionesRechazadasVisiblesEsteTurno = [];
    let rechazosVisiblesAtribuidos = [];
    let certificacionesSatisfaccionReparacionEsteTurno = [];

    // La reconciliación se define aquí, pero se ejecuta después de que la
    // extracción del turno haya materializado sus conceptos aditivos. Así
    // puede resolver referencias A↔B del mismo turno sin duplicar llamadas.
    const ejecutarReconciliacion = async () => {
    let cabezaReconciliadaAceptada = null;
    const estadoParaReconciliar = grafoDelta
      ? { ...state, knowledgeGraph: grafoDelta }
      : state;
    if (reconciliacionActiva) {
      const faltantesRecuperables = gramaticaActivaAlInicio === 'destino'
        ? dimensionesPendientesDeGrafo(estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio)
        : [];
      // FIRST_TURN_RECONCILIATION_SKIP (efficiency audit, Daniel-adjudicated,
      // 100% executed evidence from the 36/36 LIVE_FIRST_TURN corpus).
      // faltanteRecuperable's own purpose is "a dimension is still pending
      // AND there might be earlier literal evidence, from a PRIOR committed
      // turn of this SAME grammar, that already resolves it" -- but on a
      // session's genuine first turn of this grammar (no prior committed
      // Turno at all), historialLiteral below has NOTHING to search except
      // THIS SAME turn's own content (unconditionally added via
      // sinDuplicados.set(turnoIdReservadoEnAdmision, ...)) -- there is
      // structurally nothing else to recover. Measured directly: across
      // all 36 real captured first turns, 73/73 genuine reconciliation
      // calls cited the CURRENT turn as their own "recovered from memory"
      // source (zero ever correctly returned empty) -- the model is being
      // invited to search a "memory" that is, in this exact case, only
      // ever itself, and it does so via paraphrase rather than literal
      // quotation, which the extractive check then correctly rejects on a
      // real fraction of attempts. huboTurnoPrevioComprometidoEnEstaGramatica
      // gates on the SAME source historialLiteral itself queries
      // (turnoRepo.findBySesion, filtered to this grammar) -- an
      // uncommitted/failed prior turn was never persisted as a Turno, so
      // it is correctly excluded here exactly as it already is there; no
      // new precondition invented, only the EXISTING "is there a real
      // prior committed turn" fact checked before dispatching the call
      // that presupposes one exists. The other five independent triggers
      // below (incertidumbresMateriales/inferenciasMateriales/
      // conocimientoExportadoCandidato/conocimientoActivoRevisableCandidato/
      // relacionesMateriales) are completely untouched -- correction/
      // rejection on real prior state, and cross-grammar continuity via
      // conocimientoExportadoCandidato, remain fully eligible exactly as
      // before.
      const huboTurnoPrevioComprometidoEnEstaGramatica = this._unitOfWork.turnoRepo
        .findBySesion(sesionId).some(t => t.gramatica === gramaticaActivaAlInicio);
      const faltanteRecuperable = faltantesRecuperables.length > 0 && huboTurnoPrevioComprometidoEnEstaGramatica
        ? {
            dimension: state.protocoloDimensionEnFoco || faltantesRecuperables[0],
            necesidad: 'conocimiento explícito ya expresado por el experto que pueda resolver esta dimensión pendiente',
          }
        : null;
      // La memoria primaria se consulta solo si existe una dimensión
      // pendiente real. Incluye el aporte actual ya admitido y los turnos
      // anteriores; una única fuente, sin recovery paralelo.
      const historialLiteral = faltanteRecuperable
        ? (() => {
            const fuentes = this._unitOfWork.turnoRepo.findBySesion(sesionId)
              .filter(t => t.gramatica === gramaticaActivaAlInicio)
              .map(t => ({ turnoId: t.turnoId, mensaje: t.mensajeExperto, sesionId }));
            const sinDuplicados = new Map(fuentes.map(f => [f.turnoId, f]));
            sinDuplicados.set(turnoIdReservadoEnAdmision, {
              turnoId: turnoIdReservadoEnAdmision,
              mensaje: mensajeUsuario,
              esTurnoActual: true,
              sesionId,
            });
            return [...sinDuplicados.values()];
          })()
        : [];
      const incertidumbresMateriales = incertidumbresRelevantesAbiertas(estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio);
      const inferenciasMateriales = inferenciasMaterialesActivas(estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio);
      // RELACION_DURABLE_SIN_PROCEDENCIA_NO_PUEDE_OTORGAR_AUTORIDAD_INTERPRETATIVA
      // — candidatas a "reconocidaPorUsuario", misma fase, mismo disparador
      // que inferenciasMateriales.
      const relacionesMateriales = relacionesMaterialesActivas(estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio);
      // Ley de Integridad Cognitiva — candidatos de revisión de conocimiento
      // YA exportado por gramáticas ya cerradas (nunca la activa, nunca sin
      // confirmar) — se ofrecen en la MISMA llamada de reconciliación,
      // nunca una llamada aparte. Vacío por construcción mientras
      // `gramaticasCompletadas` esté vacío (p.ej. la primera gramática de
      // la sesión) — sin cambio de comportamiento en ese caso.
      const conocimientoExportadoCandidato = conocimientoExportadoDeGramaticasCerradas(
        estadoParaReconciliar.knowledgeGraph, state.gramaticasCompletadas || [],
      );
      // circulomejora006 (segunda auditoría, Sección 2 — corrección tras
      // verificación de trayectoria) — candidatos de revisión ámbito
      // ACTIVA: conocimiento 'experto' de esta MISMA gramática, todavía
      // abierta. Es un disparador INDEPENDIENTE, exactamente al mismo
      // nivel que conocimientoExportadoCandidato — nunca condicionado a
      // que otra señal (incertidumbres, inferencias, exportado) ya haya
      // disparado esta fase. La versión anterior de esta corrección lo
      // dejaba enriquecer una llamada ya existente, nunca disparar una
      // nueva — eso resultaba en un hueco funcional real: el escenario más
      // simple posible (un único concepto experto activo, contradicho por
      // el experto, sin ninguna otra señal) nunca llegaba a evaluarse en
      // absoluto — el usuario podía contradecir explícitamente algo ya
      // confirmado y el sistema nunca lo detectaría. El costo de una
      // llamada de reconciliación extra por turno (desde el segundo turno
      // de cada gramática en adelante) es el mismo que YA se acepta desde
      // 8204c1e para conocimientoExportadoCandidato una vez que cualquier
      // gramática posterior a la primera está activa — esta corrección
      // solo extiende ese mismo costo, ya asumido, a la primera gramática
      // también. Nunca se sacrifica accesibilidad de la capacidad por costo.
      //
      // RECONCILIACION_CONFIRMED_CONTEXT_EXCLUDES_CURRENT_TURN_PROVISIONAL_KNOWLEDGE
      // (C007, Daniel-adjudicated, real evidence: logistica_c1 turn 2).
      // PROVISIONAL_CURRENT_TURN_KNOWLEDGE != CONFIRMED_GOVERNED_KNOWLEDGE.
      // idTemporalARealEsteTurno ya está poblado en este punto (la
      // reconciliación corre después de que la extracción del turno
      // materializó sus conceptos aditivos, ver comentario de
      // ejecutarReconciliacion más arriba) -- sus valores son exactamente
      // los ids canónicos provisionales que ESTE turno acaba de crear en
      // grafoDelta, todavía sin comprometerse de forma durable. Se calcula
      // aquí, antes de conocimientoActivoRevisableCandidato, para que
      // ninguna vista de "autoridad ya confirmada" pueda incluirlos --
      // exactamente la misma noción de identidad provisional que
      // conceptosIdentidadDurables ya usaba más abajo para excluirlos como
      // target legal de MISMA_IDENTIDAD_DURABLE. Real evidence: sin este
      // filtro, el bloque "CONOCIMIENTO YA CONFIRMADO EN ESTA MISMA
      // GRAMÁTICA ... ya tiene autoridad plena" listaba el concepto
      // provisional de este turno junto al conocimiento genuinamente
      // preexistente, y el modelo de destino_reconciliacion concluía
      // (predeciblemente) que ese id ya existía con autoridad plena --
      // produciendo MISMA_IDENTIDAD_DURABLE contra su propio id
      // provisional, rechazado correctamente por GrafoConocimientoPolicy
      // (identidadesDurables fuera del espacio referenciable legal). El
      // concepto sigue siendo visible como sujeto de adjudicación (ver
      // materialesAdjudicablesEsteTurno / TEMPORALES QUE REQUIEREN
      // ADJUDICACIÓN, sin cambios) -- solo deja de aparecer también como si
      // ya tuviera autoridad confirmada o fuera un target/endpoint legal.
      const idsTemporalesActuales = new Set(Object.values(idTemporalARealEsteTurno));
      const conocimientoActivoRevisableCandidato = conocimientoExpertoActivoDeGramatica(
        estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio,
      ).filter(c => !idsTemporalesActuales.has(c.id));
      if (
        incertidumbresMateriales.length > 0 || inferenciasMateriales.length > 0
        || conocimientoExportadoCandidato.length > 0 || conocimientoActivoRevisableCandidato.length > 0
        || relacionesMateriales.length > 0 || faltanteRecuperable !== null
      ) {
        const conceptosGramatica = conceptosDeGramatica(estadoParaReconciliar.knowledgeGraph, gramaticaActivaAlInicio);
        const incMaterialesConContexto = incertidumbresMateriales.map(u => {
          const concepto = conceptosGramatica.find(c => u.sobreConceptos.includes(c.id));
          return {
            id: u.id,
            conceptoId: concepto ? concepto.id : (u.sobreConceptos[0] || ''),
            conceptoDescripcion: concepto ? concepto.descripcion : '',
            preguntaQueLaResolveria: u.preguntaQueLaResolveria,
          };
        });
        const relMaterialesConContexto = relacionesMateriales.map(rel => ({
          id: rel.id, tipo: rel.tipo,
          origenDescripcion: (conceptosGramatica.find(c => c.id === rel.origen) || {}).descripcion || '',
          destinoDescripcion: (conceptosGramatica.find(c => c.id === rel.destino) || {}).descripcion || '',
        }));
        const inferenciasConfirmables = conceptosConfirmablesParaReconciliacion(
          estadoParaReconciliar.knowledgeGraph,
        );
        // RECONCILIACION_CONFIRMED_CONTEXT_EXCLUDES_CURRENT_TURN_PROVISIONAL_KNOWLEDGE
        // — "CONCEPTOS EXISTENTES REFERENCIABLES" también declara autoridad
        // ("solo estos IDs pueden ser origen/destino de una relación
        // recuperada"), así que sigue la misma ley que
        // conocimientoActivoRevisableCandidato arriba: un concepto
        // provisional de este turno no puede aparecer como si ya fuera un
        // endpoint legal de relacionesRecuperadasDeMemoria. idsTemporalesActuales
        // ya se calculó arriba, antes de conocimientoActivoRevisableCandidato.
        const conceptosReferenciables = conceptosGramatica
          .filter(c => c && c.activo !== false && !idsTemporalesActuales.has(c.id))
          .map(c => ({ id: c.id, descripcion: c.descripcion }));
        // conceptosIdentidadDurables ya hereda la exclusión de conceptosReferenciables;
        // el filtro se conserva explícito por claridad/defensa en profundidad,
        // nunca por necesidad -- misma ley, nunca una segunda heurística.
        const conceptosIdentidadDurables = conceptosReferenciables
          .filter(c => !idsTemporalesActuales.has(c.id));
        const materialesGeneradosEsteTurno = (r && r.parsed && Array.isArray(r.parsed.conceptosNuevos)
          ? r.parsed.conceptosNuevos
            .filter(c => c && typeof c.idTemporal === 'string' && c.idTemporal.trim())
            .map(c => ({ idTemporal: c.idTemporal, descripcion: c.descripcion || c.idTemporal }))
          : []);
        const referenciasAdjudicablesEsteTurno = new Map(materialesGeneradosEsteTurno.map(c => [c.idTemporal, c.descripcion]));
        for (const [temporal, real] of Object.entries(idTemporalARealEsteTurno)) {
          if (!referenciasAdjudicablesEsteTurno.has(temporal)) referenciasAdjudicablesEsteTurno.set(temporal, real);
        }
        // Visibilidad y adjudicación son contratos distintos. Todo material
        // generado se ofrece al Veredicto, pero solo el subconjunto que ya
        // participa en roles/relaciones (la semántica histórica del owner de
        // identidad) requiere una resolución durable obligatoria.
        const materialesAdjudicablesEsteTurno = [...referenciasAdjudicablesEsteTurno.entries()]
          .map(([idTemporal, real]) => ({
            idTemporal,
            real,
            descripcion: (materialesGeneradosEsteTurno.find(c => c.idTemporal === idTemporal) || {}).descripcion
              || (grafoDelta && (grafoDelta.conceptos || []).find(c => c.id === real)?.descripcion)
              || real,
          }));
        const temporalesRequeridosEsteTurno = materialesAdjudicablesEsteTurno
          .filter(({ idTemporal, real }) => (
            (r && r.parsed && Array.isArray(r.parsed.rolesTransformacionales)
              && r.parsed.rolesTransformacionales.some(role => role && role.conceptoId === idTemporal))
            || (r && r.parsed && Array.isArray(r.parsed.relacionesNuevas)
              && r.parsed.relacionesNuevas.some(rel => rel && (
                rel.origen === idTemporal || rel.destino === idTemporal
              )))
            || (grafoDelta && Array.isArray(grafoDelta.relaciones)
              && grafoDelta.relaciones.some(rel => rel && (
                rel.origen === idTemporal || rel.destino === idTemporal
                || rel.origen === real || rel.destino === real
              )))
          ));

        let rReconciliacion = null;
        let grafoReconciliado = null;
        let erroresReconciliacion = ['sin intentos todavía'];
        let correccionDeFormatoReconciliacion = null;
        let intentosReconciliacion = 0;

        // C007 — CLOSE EXECUTOR RECOVERY COVERAGE GAP. Reconciliación
        // Histórica used a bare this._llmService.call() with no bounded
        // fallback: a transient PROVIDER_FAILURE here silently discarded
        // this turn's reconciliation contribution (never blocking the turn
        // by design, but always losing real governed work). SAME_GOVERNED_
        // TASK + DIFFERENT_EXECUTOR -> SAME_COGNITIVE_GOVERNANCE: reuses the
        // ALREADY-EXISTING producerExecutionCoordinator (no parallel
        // ReconciliationCoordinator) — reconciliación is part of the same
        // per-turn cognitive-governance umbrella as the Producer call, and
        // the coordinator is task-agnostic (beginTask() is a fresh, scoped
        // task identity every call, safe to reuse across distinct governed
        // tasks in the same turn). Never re-Producer, never re-Decision:
        // this only changes WHICH executor answers the SAME reconciliation
        // prompt on provider failure.
        const reconciliacionTask = this._producerExecutionCoordinator.beginTask({
          tarea: 'reconciliacion_historica', gramatica: gramaticaActivaAlInicio,
          userMsg: mensajeUsuario,
        });
        let llmServiceReconciliacionActivo = reconciliacionTask.current();

        do {
          const systemPromptReconciliacion = buildReconciliacionPrompt({
            gramatica: gramaticaActivaAlInicio,
            incertidumbresMateriales: incMaterialesConContexto,
            inferenciasMateriales,
            historialLiteral,
            faltanteRecuperable,
            conocimientoExportado: conocimientoExportadoCandidato,
            conocimientoActivoRevisable: conocimientoActivoRevisableCandidato,
            inferenciasConfirmables,
            conceptosReferenciables,
            conceptosIdentidadDurables,
            materialesAdjudicablesEsteTurno,
            temporalesRequierenAdjudicacion: temporalesRequeridosEsteTurno,
            relacionesMateriales: relMaterialesConContexto,
            reparacionesInterpretativasPendientes: proyectarReparacionesPendientes(
              estadoParaReconciliar.protocoloReparacionesInterpretativasPendientes,
            ),
            correccionDeFormato: correccionDeFormatoReconciliacion,
          });
          rReconciliacion = await llmServiceReconciliacionActivo.call({
            system: systemPromptReconciliacion, userMsg: mensajeUsuario,
            label: `${gramaticaActivaAlInicio}_reconciliacion`, callProfile: 'VEREDICTO_ESTRUCTURADO',
            // DETERMINISTIC REPLAY CAPTURE -- observability-only, never
            // forwarded to the provider (see LLMService.call docstring):
            // this contract lives entirely in systemPromptReconciliacion's
            // own prose, no JSON-schema object governs it anywhere.
            replaySchema: 'NONE',
            turnoId: turnoIdReservadoEnAdmision,
          });
          if (!rReconciliacion.parsed) {
            // Transport/parse failure only (never a content/validation
            // rejection, which is handled separately below via the normal
            // intentosReconciliacion retry) -- bounded escalation to the
            // SAME externally-configured fallback executor, on the exact
            // SAME governed reconciliation task (same prompt, same turn).
            if (reconciliacionTask.escalate(PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE)) {
              llmServiceReconciliacionActivo = reconciliacionTask.current();
              continue;
            }
            break; // all configured executors exhausted -- fail closed, registered as fallida below, never blocks the turn
          }
          // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
          // AMBITO_DE_CIERRE_GOBIERNA_PRODUCTORES_PERO_NO_LA_FRONTERA_COMUN_DE_MUTACION)
          // — MISMA política que construcción usa más abajo, nunca un gate
          // divergente: "inferenciasRechazadas" es, exactamente igual que
          // "marcarObsoletos", una mutación destructiva -- desactiva
          // conocimiento ya establecido. Reconciliación Histórica corre
          // ANTES de construcción, sobre state.knowledgeGraph (la foto
          // verdaderamente-antes de este turno) -- misma referencia contra
          // la que se resuelve la dimensión de cada concepto afectado.
          const esUltimoIntentoReconciliacionParaMutacionLateral = intentosReconciliacion >= MAX_CONTRATO_RETRIES;
          const {
            noAutorizadas: inferenciasRechazadasNoAutorizadas,
            autoridadesNuevas: autoridadesNuevasInferencias,
          } = await validarMutacionesDestructivasBajoCierre({
            ambitoMutacionCierre: ambitoMutacionCierreEsteTurno,
            grafoActual: estadoParaReconciliar.knowledgeGraph,
            mensajeUsuario,
            mutacionesPropuestas: rReconciliacion.parsed.inferenciasRechazadas,
            origen: 'RECONCILIACION_HISTORICA',
            tipoImpactoPropuesto: 'RECHAZA',
            llmService: this._llmService, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
            autoridadesPrevias: autoridadesPreviasMutacion, cacheValidacionesEsteTurno: cacheValidacionesMutacionEsteTurno,
          });
          autoridadesMutacionNuevasEsteTurno = autoridadesMutacionNuevasEsteTurno.concat(autoridadesNuevasInferencias);
          mutacionesLateralesRechazadasPorOrigen.RECONCILIACION_INFERENCIAS = inferenciasRechazadasNoAutorizadas.map(item => ({
            ...item, causa: item.codigoRazon || 'MUTACION_NO_VALIDADA_SEMANTICAMENTE', turnoClienteId,
          }));
          mutacionesLateralesRechazadasTraza = Object.values(mutacionesLateralesRechazadasPorOrigen).flat();
          if (inferenciasRechazadasNoAutorizadas.length > 0 && !esUltimoIntentoReconciliacionParaMutacionLateral) {
            // Retry focal -- misma disciplina que construcción: señala
            // EXACTAMENTE la mutación no autorizada, nunca descarta el
            // resto de la reconciliación de este turno.
            erroresReconciliacion = inferenciasRechazadasNoAutorizadas.map(mensajeErrorMutacionLateralNoAutorizada);
            correccionDeFormatoReconciliacion = erroresReconciliacion.join('; ');
            intentosReconciliacion++;
            continue;
          }
          // Presupuesto de reintentos agotado -- falla cerrado SOLO sobre
          // esas mutaciones puntuales (requisito 5): reconstruye el delta
          // de reconciliación con el MISMO contenido, MENOS las
          // obsolescencias no autorizadas -- conserva toda resolución
          // válida de incertidumbres/inferencias/relaciones de este turno.
          const parsedReconciliacionCorregido = inferenciasRechazadasNoAutorizadas.length > 0
            ? {
                ...rReconciliacion.parsed,
                inferenciasRechazadas: (rReconciliacion.parsed.inferenciasRechazadas || [])
                  .filter(item => !inferenciasRechazadasNoAutorizadas.some(bad => bad.id === (item && item.id))),
              }
            : rReconciliacion.parsed;
          // La reconciliación puede aportar una proposición SAME-TURN de
          // satisfacción; el certificador la valida contra la identidad y
          // materiales realmente presentes. Nunca se infiere desde dimensión.
          certificacionesSatisfaccionReparacionEsteTurno = Array.isArray(parsedReconciliacionCorregido.satisfaccionesReparacion)
            ? parsedReconciliacionCorregido.satisfaccionesReparacion
            : [];
          const { grafoNuevo, errores, identidadesCanonicas } = aplicarDeltaReconciliacion(
            estadoParaReconciliar.knowledgeGraph, deltaReconciliacionDesdeParsed(parsedReconciliacionCorregido),
            {
              turnoReconocimientoId: turnoClienteId,
              historialLiteral,
              fuentesPrimariasLiteral: historialLiteral,
              turnoActualId: turnoIdReservadoEnAdmision,
              mensajeUsuarioActual: mensajeUsuario,
              mensajeUsuario,
              relacionRespuestaDirigida: rReconciliacion.parsed.relacionRespuestaDirigida || null,
              sesionId,
              idTemporalAReal: idTemporalARealEsteTurno,
              idsConceptosReferenciables: conceptosIdentidadDurables.map(c => c.id),
              // Todo material generado este turno fue expuesto al Veredicto
              // como adjudicable; la adjudicación es obligatoria para cada
              // referencia declarada, también cuando el concepto aún está
              // aislado en el grafo. Visibilidad no concede autoridad.
              temporalesRequierenAdjudicacion: temporalesRequeridosEsteTurno.map(x => x.idTemporal),
            },
          );
          if (grafoNuevo) {
            Object.assign(
              idTemporalARealEsteTurno,
              canonicalizarMapaReferenciasTurno(idTemporalARealEsteTurno, identidadesCanonicas || {}),
            );
            certificacionesSatisfaccionReparacionEsteTurno = certificacionesSatisfaccionReparacionEsteTurno.map(propuesta => ({
              ...propuesta,
              materialIds: (propuesta.materialIds || [])
                .map(id => Object.prototype.hasOwnProperty.call(idTemporalARealEsteTurno, id)
                  ? idTemporalARealEsteTurno[id] : null),
            }));
            grafoReconciliado = grafoNuevo;
            // circulomejora006 — señal de rechazo explícito de ESTE turno,
            // tomada directamente de lo que Reconciliación efectivamente
            // aplicó (nunca de un intento fallido). Los ids son siempre
            // reales/preexistentes (Reconciliación nunca crea idTemporal) —
            // se resuelve la dimensión contra el grafo PRE-turno (la
            // procedencia de un concepto no cambia al rechazarlo).
            // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — lee parsedReconciliacionCorregido
            // (lo REALMENTE aplicado, sin las obsolescencias no
            // autorizadas), nunca rReconciliacion.parsed crudo -- si no, un
            // rechazo bloqueado por el gate igual se contaría como "rechazo
            // visible" pese a nunca haber tocado el grafo.
            const idsRechazados = (parsedReconciliacionCorregido.inferenciasRechazadas || [])
              .map(x => x && x.id).filter(Boolean);
            if (idsRechazados.length > 0) {
              huboRechazoEsteTurno = true;
              const conceptoPorId = new Map(estadoParaReconciliar.knowledgeGraph.conceptos.map(c => [c.id, c]));
              dimensionesRechazadasEsteTurno = [...new Set(
                idsRechazados
                  .map(id => conceptoPorId.get(id))
                  .filter(Boolean)
                  .map(c => dimensionDeProcedencia(c.procedencia))
                  .filter(Boolean),
              )];

              // circulomejora006 (corrección final) — intersección exacta
              // por id, sobre el grafo verdaderamente-antes de este turno
              // (state.knowledgeGraph, nunca estadoActual — todavía no
              // existe en este punto del método): de todas las dimensiones
              // de DESTINO, cuáles tenían un intento materializado (visible)
              // todavía pendiente de veredicto, y de esos, cuáles ids
              // coinciden exactamente con lo que Reconciliación acaba de
              // rechazar. Solo esa intersección es "rechazo visible".
              const idsMaterializadosPendientesAntes = (SLOTS_BY_GRAMATICA[gramaticaActivaAlInicio] || [])
                .map(dim => GrafoProyeccion.ultimoIntentoAbstraccionMaterializado(estadoParaReconciliar.knowledgeGraph, dim))
                .filter(c => c
                  && c.materializadoViaMovimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION
                  && GrafoProyeccion.resultadoInterpretacion(
                    estadoParaReconciliar.knowledgeGraph, dimensionDeProcedencia(c.procedencia),
                  ) === 'pendiente')
                .map(c => c.id);
              const idsRechazadosVisibles = idsRechazados.filter(id => idsMaterializadosPendientesAntes.includes(id));
              if (idsRechazadosVisibles.length > 0) {
                huboRechazoVisibleEsteTurno = true;
                rechazosVisiblesAtribuidos = idsRechazadosVisibles
                  .map(id => conceptoPorId.get(id))
                  .filter(Boolean)
                  .map(c => ({
                    intentoInterpretacionId: c.id,
                    dimension: dimensionDeProcedencia(c.procedencia),
                    interpretacionRechazadaSnapshot: {
                      id: c.id,
                      tipo: c.tipo,
                      descripcion: c.descripcion,
                      autoridad: c.autoridad,
                      procedencia: c.procedencia,
                      materializadoEnTurno: c.materializadoEnTurno || null,
                      materializadoViaMovimiento: c.materializadoViaMovimiento || null,
                    },
                  }))
                  .filter(x => x.dimension);
                dimensionesRechazadasVisiblesEsteTurno = [...new Set(
                  rechazosVisiblesAtribuidos.map(x => x.dimension),
                )];
              }
            }
            break;
          }
          erroresReconciliacion = errores;
          correccionDeFormatoReconciliacion = errores.join('; ');
          intentosReconciliacion++;
        } while (intentosReconciliacion <= MAX_CONTRATO_RETRIES);

        // Ley de Integridad Cognitiva — se aplica sobre el resultado YA
        // reconciliado, tomando conocimientoRefinado/conocimientoContradicho
        // de la MISMA respuesta que reconciliación ya validó (nunca una
        // llamada aparte). Un rechazo aquí (Y sin autoridad experto
        // suficiente, o un id inválido) NO es un problema de formato — es
        // una degradación aceptada, igual que en el resto del sistema:
        // X permanece vigente, grafoReconciliado sigue siendo el de la
        // reconciliación ordinaria, y el turno sigue su curso normal, sin
        // reintentar esta llamada por esto.
        //
        // circulomejora006 (segunda auditoría, Sección 2) — la MISMA
        // respuesta puede traer entradas de DOS ámbitos distintos
        // (gramática activa / gramáticas ya exportadas); el código las
        // separa por pertenencia a los candidatos YA ofrecidos arriba —
        // nunca el LLM decide a qué contrato pertenece cada una. Una
        // entrada que no pertenece a NINGUNO de los dos conjuntos
        // ofrecidos (un id que nunca fue listado como candidato) se
        // descarta en silencio — mismo "silencio por defecto" que ya rige
        // el resto de Reconciliación, nunca un id inventado se procesa.
        // Cada contrato aplica/rechaza únicamente su propio subdelta
        // (atomicidad por operación) — un rechazo en uno nunca revierte
        // ni bloquea al otro, ni a la reconciliación ordinaria ya aplicada.
        let refinacionesEsteTurno = [];
        let contradiccionesEsteTurno = [];
        if (grafoReconciliado && rReconciliacion && rReconciliacion.parsed) {
          const deltaCompleto = deltaIntegridadDesdeParsed(rReconciliacion.parsed);
          const idsActivos = new Set(conocimientoActivoRevisableCandidato.map(c => c.id));
          const idsExportados = new Set(conocimientoExportadoCandidato.map(c => c.id));
          const perteneceA = (conjunto) => (entrada) => entrada && conjunto.has(entrada.id);

          const deltaActivaSubset = {
            conocimientoRefinado: (deltaCompleto.conocimientoRefinado || []).filter(perteneceA(idsActivos)),
            conocimientoContradicho: (deltaCompleto.conocimientoContradicho || []).filter(perteneceA(idsActivos)),
          };
          const deltaExportadaSubset = {
            conocimientoRefinado: (deltaCompleto.conocimientoRefinado || []).filter(perteneceA(idsExportados)),
            conocimientoContradicho: (deltaCompleto.conocimientoContradicho || []).filter(perteneceA(idsExportados)),
          };

          // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
          // AMBITO_DE_CIERRE_GOBIERNA_PRODUCTORES_PERO_NO_LA_FRONTERA_COMUN_DE_MUTACION)
          // — MISMA política, aplicada aquí a "conocimientoContradicho" (el
          // hallazgo real del smoke: Reconciliación Histórica contradijo
          // "antes" citando el mensaje completo, que en realidad describía
          // "despues" — una cita literal, pero nunca un vínculo verificable
          // con "antes"). Esta llamada, a diferencia de aplicarDeltaReconciliacion
          // arriba, corre DESPUÉS del propio retry de Reconciliación (ya
          // documentado como "sin reintentar esta llamada por esto" —
          // decisión preexistente del archivo, no de este incremento) — el
          // gate aquí falla cerrado en un único paso: nunca aplica la
          // contradicción no autorizada, conserva conocimientoRefinado y
          // cualquier otra contradicción sí autorizada. "conocimientoRefinado"
          // nunca desactiva nada (solo revisa una descripción) — queda
          // fuera de este gate, sin cambios.
          const {
            noAutorizadas: contradiccionesActivaNoAutorizadas,
            autoridadesNuevas: autoridadesNuevasActiva,
          } = await validarMutacionesDestructivasBajoCierre({
            ambitoMutacionCierre: ambitoMutacionCierreEsteTurno, grafoActual: grafoReconciliado,
            mensajeUsuario, mutacionesPropuestas: deltaActivaSubset.conocimientoContradicho,
            origen: 'RECONCILIACION_HISTORICA', tipoImpactoPropuesto: 'RECHAZA',
            llmService: this._llmService, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
            autoridadesPrevias: autoridadesPreviasMutacion, cacheValidacionesEsteTurno: cacheValidacionesMutacionEsteTurno,
          });
          const {
            noAutorizadas: contradiccionesExportadaNoAutorizadas,
            autoridadesNuevas: autoridadesNuevasExportada,
          } = await validarMutacionesDestructivasBajoCierre({
            ambitoMutacionCierre: ambitoMutacionCierreEsteTurno, grafoActual: grafoReconciliado,
            mensajeUsuario, mutacionesPropuestas: deltaExportadaSubset.conocimientoContradicho,
            origen: 'RECONCILIACION_HISTORICA', tipoImpactoPropuesto: 'RECHAZA',
            llmService: this._llmService, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
            autoridadesPrevias: autoridadesPreviasMutacion, cacheValidacionesEsteTurno: cacheValidacionesMutacionEsteTurno,
          });
          autoridadesMutacionNuevasEsteTurno = autoridadesMutacionNuevasEsteTurno
            .concat(autoridadesNuevasActiva, autoridadesNuevasExportada);
          const contradiccionesNoAutorizadasTotal = [...contradiccionesActivaNoAutorizadas, ...contradiccionesExportadaNoAutorizadas];
          if (contradiccionesNoAutorizadasTotal.length > 0) {
            mutacionesLateralesRechazadasPorOrigen.RECONCILIACION_CONTRADICCION = contradiccionesNoAutorizadasTotal.map(item => ({
              ...item, causa: item.codigoRazon || 'MUTACION_NO_VALIDADA_SEMANTICAMENTE', turnoClienteId,
            }));
            mutacionesLateralesRechazadasTraza = Object.values(mutacionesLateralesRechazadasPorOrigen).flat();
            const idsNoAutorizadosActiva = new Set(contradiccionesActivaNoAutorizadas.map(item => item.id));
            const idsNoAutorizadosExportada = new Set(contradiccionesExportadaNoAutorizadas.map(item => item.id));
            deltaActivaSubset.conocimientoContradicho = deltaActivaSubset.conocimientoContradicho
              .filter(item => !idsNoAutorizadosActiva.has(item.id));
            deltaExportadaSubset.conocimientoContradicho = deltaExportadaSubset.conocimientoContradicho
              .filter(item => !idsNoAutorizadosExportada.has(item.id));
          }

          if (deltaActivaSubset.conocimientoRefinado.length > 0 || deltaActivaSubset.conocimientoContradicho.length > 0) {
            const { grafoNuevo: grafoConRevisionActiva, refinaciones, contradicciones } =
              aplicarDeltaRevisionActiva(grafoReconciliado, deltaActivaSubset, {
                mensajeUsuario, gramaticaActiva: gramaticaActivaAlInicio,
              });
            if (grafoConRevisionActiva) {
              grafoReconciliado = grafoConRevisionActiva;
              refinacionesEsteTurno = refinacionesEsteTurno.concat(
                refinaciones.map(r => ({ ...r, ambito: 'gramatica_activa' })),
              );
              contradiccionesEsteTurno = contradiccionesEsteTurno.concat(
                contradicciones.map(c => ({ ...c, ambito: 'gramatica_activa' })),
              );
            }
          }

          if (deltaExportadaSubset.conocimientoRefinado.length > 0 || deltaExportadaSubset.conocimientoContradicho.length > 0) {
            const { grafoNuevo: grafoConIntegridad, refinaciones, contradicciones } =
              aplicarDeltaIntegridad(grafoReconciliado, deltaExportadaSubset, {
                mensajeUsuario, gramaticasCompletadas: state.gramaticasCompletadas || [],
              });
            if (grafoConIntegridad) {
              grafoReconciliado = grafoConIntegridad;
              refinacionesEsteTurno = refinacionesEsteTurno.concat(
                refinaciones.map(r => ({ ...r, ambito: 'gramatica_exportada' })),
              );
              contradiccionesEsteTurno = contradiccionesEsteTurno.concat(
                contradicciones.map(c => ({ ...c, ambito: 'gramatica_exportada' })),
              );
            }
          }
        }

        // FRONTERA_INTERVENCION_VISIBLE_1 (corrección focal —
        // RECHAZO_NO_PROPAGADO) — si el experto acaba de contradecir uno de
        // los dos anclajes de la ÚLTIMA conexión ANCLADA propuesta (Motor
        // de Movimientos, nivel 'conectado', ver GrafoProyeccion.
        // seleccionarAnclajesConectados), materializa YA la memoria
        // negativa durable de esa interpretación relacional -- ANTES de que
        // construcción (más abajo, mismo turno) vuelva a calcular qué
        // ofrecer. Sin esto, el rechazo perdía autoridad exactamente aquí:
        // Reconciliación invalidaba el CONCEPTO contradicho, pero nada
        // recordaba que la CONEXIÓN entre sus dos dimensiones ya había sido
        // rechazada, así que un concepto nuevo en la misma dimensión
        // heredaba elegibilidad sin fricción (reconstrucción causal real,
        // turnos 3-6, ver evidencia archivada). Nunca decide aquí si HAY
        // evidencia para reabrir -- eso es exclusivo de
        // seleccionarAnclajesConectados/conexionTieneEvidenciaPosteriorAlRechazo,
        // sobre el grafo ya materializado.
        const ultimaConexionPropuesta = gramaticaActivaAlInicio === 'destino'
          ? (state.protocoloUltimaConexionConectadaPropuesta || null)
          : null;
        if (ultimaConexionPropuesta && grafoReconciliado) {
          const contradiccionSobreAnclaje = contradiccionesEsteTurno.find(c =>
            c.conceptoId === ultimaConexionPropuesta.anclajeAId
            || c.conceptoId === ultimaConexionPropuesta.anclajeBId
          );
          if (contradiccionSobreAnclaje) {
            // Fotografía de la evidencia 'experto' activa en ambas
            // dimensiones AL MOMENTO del rechazo (state.knowledgeGraph, la
            // foto verdaderamente-antes de este turno) -- nunca recalculada
            // después. conexionTieneEvidenciaPosteriorAlRechazo la usa para
            // distinguir "contenido ya evaluado" de "genuinamente nuevo".
            const conceptosYaEvaluadosIds = (estadoParaReconciliar.knowledgeGraph.conceptos || [])
              .filter(c => c.activo && c.autoridad === 'experto'
                && (dimensionDeProcedencia(c.procedencia) === ultimaConexionPropuesta.dimensionA
                  || dimensionDeProcedencia(c.procedencia) === ultimaConexionPropuesta.dimensionB))
              .map(c => c.id);
            grafoReconciliado = materializarConexionRechazada(grafoReconciliado, {
              gramatica: gramaticaActivaAlInicio,
              dimensionA: ultimaConexionPropuesta.dimensionA,
              dimensionB: ultimaConexionPropuesta.dimensionB,
              operacionRelacional: ultimaConexionPropuesta.operacionRelacional,
              porQue: contradiccionSobreAnclaje.porQue,
              conceptosYaEvaluadosIds,
              turnoOrigenId: turnoClienteId,
            });
          }
        }

        // Transacción PROPIA — independiente de la de construcción, más
        // abajo. Un fallo aquí nunca descarta conocimiento constructivo
        // válido; un fallo en construcción nunca revierte esto.
        try {
          if (grafoReconciliado) {
            cabezaReconciliadaAceptada = grafoReconciliado;
            estadoActual = this._unitOfWork.ejecutar(({ stateRepo, eventRepo }) =>
              this._confirmarReconciliacion({
                stateRepo, eventRepo, sesionId, turnoClienteId, gramaticaActivaAlInicio,
                state: estadoParaReconciliar, grafoNuevo: grafoReconciliado,
                refinaciones: refinacionesEsteTurno, contradicciones: contradiccionesEsteTurno,
                rechazosVisiblesAtribuidos,
              }));
          } else {
            this._unitOfWork.ejecutar(({ eventRepo }) =>
              this._registrarReconciliacionFallida({
                eventRepo, sesionId, turnoClienteId, gramaticaActivaAlInicio,
                errores: erroresReconciliacion,
              }));
          }
        } catch (e) {
          if (!esFalloOperacionalPersistencia(e)) throw e;
          // La reconciliación es una fase cognitiva con una transacción
          // propia. Si falla su persistencia, la transacción ya revirtió su
          // cabeza/version/eventos; la admisión permanece durable y se
          // registra el fallo en una transacción independiente, igual que
          // cualquier otra terminación operacional conocida del turno.
          this._marcarEntradaFallidaSiEsSeguro({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: 'PERSISTENCE_ERROR', retryable: null,
          });
          return {
            __falloOperacionalReconciliacion: true,
            resultado: {
              ok: false, httpStatus: 500, codigo: 'PERSISTENCE_ERROR',
              mensaje: `No se pudo confirmar la reconciliación: ${e.message}`,
              state,
            },
          };
        }
      }
      // La cabeza de reconciliación sustituye a la anterior únicamente si
      // el delta completo fue aceptado. Un fallo posterior no puede hacer
      // retroceder la cabeza de extracción ya aceptada.
      return cabezaReconciliadaAceptada;
    }
    };

    let r;
    // Incremento 1: declarados en este nivel (no dentro del bloque V2) para
    // que decidirInteraccion y el cálculo de avanzaReal, más abajo, puedan
    // leerlos — permanecen en sus valores por defecto en modo legacy.
    let grafoDelta = null;
    let semanticUnknownIdEsteTurno = null;
    let grafoActivo = false;
    const idsConceptosAntesTurno = new Set((estadoActual.knowledgeGraph && Array.isArray(estadoActual.knowledgeGraph.conceptos)
      ? estadoActual.knowledgeGraph.conceptos : []).map(c => c.id));
    let idTemporalARealEsteTurno = {};
    let oportunidadesGobernadasEsteTurno = [];
    // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY (C007 Machine Product
    // Acceptance, live-eval FRONTIER family, Daniel-adjudicated).
    // KNOWLEDGE_ELIGIBILITY != CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY --
    // elegibleParaAbstraer (ADR-governed, "an inference never sustains
    // itself") stays completely unchanged: an 'inferido' concept that fails
    // it is still never committed to the durable Knowledge Graph, never
    // counted as evidence, never durable. But the concept OBJECT itself
    // already passed aplicarDelta's own real extraction/authority
    // derivation (autoridadGobernada) before elegibility ever excluded it
    // from THIS turn's delta -- it is a legitimately user-grounded
    // inference, not an invented string. This turn-scoped (never durable,
    // never written to estadoActual.knowledgeGraph) array captures exactly
    // those excluded-for-KNOWLEDGE concepts, purely so
    // construirFronteraCognitivaAdmisible can offer them as
    // CONVERSATIONAL_HYPOTHESIS material (needKind:'EXISTENCE' only, see
    // candidatosCompatiblesConFrontera's INFERRED_OPEN_TARGET gate) -- never
    // as factual subjectBound authority, never surviving past this turn if
    // it fails/ends without being visibly asked.
    let conceptosHipotesisAbiertaEsteTurno = [];
    // CONTENT_CLOSURE_REPAIR (PRODUCER_CROSS_FIELD_REFERENTIAL_SELF_
    // INCONSISTENCY cluster, Daniel-adjudicated). Captures the FIRST
    // producer attempt this turn (across every executor tier -- never
    // reset per tier, only per turn) whose ONLY defect is a same-output
    // dangling reference (evaluacionGanancia.satisfaccionConocimiento.
    // evidenciaConceptoIds citing an id absent from that same output's own
    // conceptosNuevos) while otherwise carrying a genuine WHAT (a real
    // oportunidad or gananciaCognitiva) -- never a transport failure, never
    // a different REPRESENTACION defect coexisting. This is FROZEN
    // structural material, never governed, never durable, never itself
    // authority -- see intentarReparacionCierreReferencial below, the sole
    // consumer, which may only PROPOSE a closing declaration for the
    // dangling id(s), subject to the SAME extractive governance
    // (autoridadGobernada) every ordinary Producer concept goes through.
    let mejorCandidatoColganteEsteTurno = null;
    let fronteraCognitivaAdmisibleEsteTurno = [];
    let estadoFronteraCognitivaEsteTurno = 'NOT_EVALUATED';
    // C007 CONVERSATIONAL ENGINE STABILIZATION -- CLASS 12 HANDOFF FIX.
    // Outer-scope, like estadoFronteraCognitivaEsteTurno above: assigned
    // once, inside the frontier/CanonicalNextActState block below, read
    // both there (V0/V1) and much later at the terminal NO_COGNITIVE_ACT_
    // AVAILABLE guard -- never re-derived at either read site.
    let closureOptionEsteTurno = null;
    // AUTHORITY_CONTINUITY correction -- PROGRESS_DECISION_INVOCATIONS_
    // FOR_HANDOFF_AUTHORITY = 1: the ONE governed ProgresoConversacionalPolicy.
    // decidirProtocolo() result for this turn (non-destino only -- see the
    // single call site below), threaded forward into decidirInteraccion()
    // itself (progresoPrecalculado param) so IT reuses this exact object
    // instead of calling decidirProtocolo() a second time internally.
    // closureOptionEsteTurno above is a pure PROJECTION of this same result
    // (grammarAfter derived from progresoEsteTurno.avanza via the static,
    // non-decisional GRAMATICA_ORDER sequence -- never a second judgment).
    let progresoEsteTurno = null;
    // Same object Decision (decidirIntervencionConversacional) consumes --
    // the terminal NO_COGNITIVE_ACT_AVAILABLE guard reuses THIS SAME
    // reference (TERMINAL_GUARD_NEXT_ACT_AUTHORITY === DECISION_NEXT_ACT_
    // AUTHORITY, literally, not just semantically), never a fresh rebuild.
    let canonicalNextActStateV1EsteTurno = null;
    // C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 4 -- compact,
    // per-turn authority lineage (grammar/novelty/CanonicalNextActState/
    // repair/Decision/Contract/route/realization/commit). Populated
    // additively at the points where each fact is already computed; emitted
    // once near turn end via _emitirTrazaAutoridad (success or failure --
    // AuthorityTrace != CognitiveState, never gates anything itself).
    const trazaAutoridadEsteTurno = { grammar: gramaticaActivaAlInicio, preStateVersion: state.versionId };
    // GOVERNED_RESPONSE_MAY_COMMIT_WITHOUT_NEW_CURRENT_WHAT -- when the
    // certified search for a NEW act finds nothing admissible but this turn's
    // verified directed response already satisfied the previous act, the
    // turn is allowed to continue as a response-only turn IF the existing
    // visible-response machinery can actually express it. The original
    // fail-closed verdict is not discarded: it is parked here and re-issued,
    // byte for byte, at the exact points where that machinery turns out to
    // have no visible output -- so a state with no legal visible
    // representation fails as it always did (never a new silent hole, never
    // an invented operator).
    let falloReparacionDiferido = null;
    const emitirFalloReparacionDiferido = () => {
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        causa: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER', errorCategory: null, retryable: false,
      });
      trazaAutoridadEsteTurno.repair = { ...(trazaAutoridadEsteTurno.repair || {}), outcome: falloReparacionDiferido.outcome };
      trazaAutoridadEsteTurno.visibleRoute = 'NONE';
      trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
      this._emitirTrazaAutoridad({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        traza: trazaAutoridadEsteTurno, commit: false, failureClass: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER',
      });
      return {
        ok: false, httpStatus: 502, codigo: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER',
        mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
      };
    };
    let reconciliacionBootstrapEjecutadaEsteTurno = false;
    let reaperturaSinNovedadDescartadaEsteTurno = false;
    // Dirección tipada: cuando una misión opta por el contrato común, una
    // generación sin oportunidad seleccionable no puede degradarse a la
    // decisión legacy. Se conserva a nivel de turno para aplicar el fail
    // closed después del mismo ciclo de reintentos de contrato.
    let oportunidadTipadaValidaEsteTurno = false;
    let rolesContextualesTransformacionalesEsteTurno = null;
    let autoridadesContextualesTransformacionalesEsteTurno = null;
    let composicionPendienteTransformacionalNuevo = estadoActual.protocoloComposicionTransformacionalPendiente || null;
    const fuentesPrimariasParaRolesPendientes = this._unitOfWork.turnoRepo
      .findBySesion(sesionId)
      .map(t => ({ turnoId: t.turnoId, mensaje: t.mensajeExperto }));
    const pendienteRevalidada = revalidarComposicionTransformacionalPendiente(
      estadoActual.knowledgeGraph, composicionPendienteTransformacionalNuevo, fuentesPrimariasParaRolesPendientes,
    );
    if (pendienteRevalidada.valido) {
      rolesContextualesTransformacionalesEsteTurno = pendienteRevalidada.roles;
      autoridadesContextualesTransformacionalesEsteTurno = pendienteRevalidada.autoridadesContextualesPorRol;
    }
    else composicionPendienteTransformacionalNuevo = null;
    // circulomejora006_act10l — mismo motivo que grafoDelta arriba:
    // protocoloEstadoEfectivo se calcula dentro del bloque V2 (más abajo,
    // ver decisionEstadoPreturno) y ese bloque cierra antes de la llamada a
    // decidirInteraccion — se captura aquí, a nivel de función, para que el
    // intento de nueva propuesta relacional (justo antes de esa llamada)
    // pueda leerlo sin recalcularlo.
    let protocoloEstadoEfectivoDeConstruccion = null;
    // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- declarado en este
    // nivel (no dentro del bloque V2) porque decidirInteraccion/decidirProtocolo,
    // más abajo, lo consumen para toda gramática. Solo se REASIGNA dentro del
    // bloque V2 cuando protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION'.
    let confirmationSujetoEsteTurno = CONFIRMATION_SUBJECTS.SYNTHESIS;
    // circulomejora006 — declarados en este nivel (no dentro del bloque V2)
    // por la misma razón que grafoDelta/grafoActivo arriba: _confirmarInteraccion,
    // más abajo, necesita leerlos para persistir protocoloDimensionEnFoco y
    // trazar observabilidad — permanecen en sus valores por defecto (sin
    // efecto observable) bajo legacy o fuera del alcance de esta rebanada.
    let contratoMovimientoDestino = null;
    let contratoIntervencionMovimiento = null;
    let movimientoComunEsteTurno = null;
    let movimientoMisionAplicaEsteTurno = false;
    let dimensionEnFocoNuevo = null;
    let movimientoEjecutadoDestino = false;
    // Corrección posterior a la auditoría de a22d081: razón estable cuando
    // un movimiento decidido y compatible con la estrategia NO llega a
    // marcarse ejecutado por falta de una salida visible real (ver rama
    // DETERMINISTA, más abajo) — nunca se confunde con codigoRazon del
    // propio ContratoMovimiento, que explica POR QUÉ se decidió, no por
    // qué no se ejecutó.
    let movimientoNoEjecutadoRazon = null;
    // circulomejora006 (corrección posterior a la prueba real) — nombre de
    // la dimensión que este turno difirió, o null. "Diferida" es un hecho
    // de ESTE turno (a lo sumo una dimensión por turno, ya que Movimiento
    // solo decide una dimensionObjetivo por turno) — se persiste más abajo,
    // fusionado con el historial de la sesión (nunca reemplazado), y se
    // traza en el evento de observabilidad con su razón y su turno exactos.
    let dimensionInterpretacionDiferidaEsteTurno = null;
    let dimensionesInterpretacionSinGananciaEsteTurno = {};
    let destinoMovimientoCompatible = true;
    let observacionNaturalezaValor = null;
    let observacionNaturalezaGobernada = null;
    let observacionNaturalezaDegradada = false;
    // P1-A (circulomejora006 — autoridad de cierre conversacional, primer
    // incremento) — observación pura de lo que el experto expresó SOBRE LA
    // CONVERSACIÓN (nunca conocimiento de dominio, nunca autoridad
    // experto/inferido). Se reinicia en cada intento, igual que
    // observacionNaturaleza* — nunca acumula entre reintentos.
    let senalesCierreAceptadas = [];
    let senalesCierreDescartadas = [];
    // P1-B (circulomejora006 — autoridad de objetivo conversacional ante
    // cierre) — decisión de ObjetivoConversacionalPolicy para ESTE turno,
    // calculada una sola vez, DESPUÉS de que las señales de arriba ya
    // están clasificadas (misma iteración del bucle) y ANTES de llamar a
    // decidirMovimientoDestino — ver más abajo. null cuando el selector de
    // DESTINO no gobierna este turno.
    let objetivoConversacionalEsteTurno = null;
    let actoCognitivoCanonico = null;
    let comprensionTrabajoEsteTurno = null;
    let focoConversacionalActual = null;
    let historialVisibleRecienteEsteTurno = [];
    let estrategiaSeleccionadaTraza = null;
    let estrategiaEfectivaTraza = null;
    // AUTHORIZED_VISIBLE_OUTPUT_AVAILABLE — function-scoped mirror of the
    // block-scoped `realizadorProdujoSalida` (Gobernanza de Materialización,
    // below): that flag only exists inside the TRANSFORMAR block itself and
    // is out of scope by the time the final visible-output guards run.
    // Snapshotted here, once, right where the original flag reaches its
    // final value -- never recomputed, never a second definition.
    let realizadorProdujoSalidaEsteTurno = false;
    let realizadorFalloTraza = false;
    let fallbackMovimientoAplicadoTraza = false;
    // CONECTADO_ANCLADO_EN_EVIDENCIA — true únicamente cuando el contrato
    // CONECTADO (anclajesUsados + sinAbstraccionNueva) falló dos veces y el
    // turno se degradó a la intervención determinista REFLEJADA (nunca la
    // metáfora/abstracción no autorizada llega al usuario).
    let contratoConectadoDegradadoTraza = false;
    // CONECTADO_PROCEDENCIA_VERIFICADA — estructura verificable
    // (anclajeAId/anclajeBId/operacionRelacional/fuenteRelacionId) YA
    // validada por el Writer contra el grafo real, nunca la autodeclaración
    // cruda del modelo. null cuando este turno no pasó por CONECTADO.
    let conexionConectadaTraza = null;
    let salidaVisibleSeguraTraza = false;
    let huboObsolescenciaEsteTurno = false;
    let mutacionesAutorizadasConstruccionEsteTurno = [];
    // circulomejora006 (corrección final — atribución multidimensional) —
    // T-DIM2: legado, telemetría secundaria únicamente. Con
    // contratoRespuestaDirigidaEsteTurno presente (T-DIM2), el gate de
    // atribución YA NUNCA se exime en el último intento — ver más abajo —
    // así que este flag queda estructuralmente en false por ese camino
    // (el resultado real vive en alineacionRespuestaDirigidaResultadoTraza).
    // Sin contratoRespuestaDirigidaEsteTurno (turno sin intervención
    // dirigida vigente), conserva su significado original: true únicamente
    // cuando el turno agotó los 3 intentos sin que ningún concepto nuevo
    // atendiera la dimensión que gobernó el contrato NI trajera
    // porQueNoCapturaDimensionObjetivo — degradación trazada, nunca motivo
    // de bloqueo (el turno se acepta igual, ver más abajo).
    let atribucionSinJustificar = false;
    // T-DIM2 (circulomejora006 — contrato causal de respuesta a
    // intervención dirigida) — relacionRespuestaDirigida cruda declarada
    // por Capa 1 este intento (null si no aplica o no llegó a declararse),
    // y el resultado ya proyectado por ContratoRespuestaDirigidaPolicy.
    // proyectarAlineacionRespuestaDirigida (NO_APLICA/VERIFICADA/
    // ALINEACION_RESPUESTA_DIRIGIDA_NO_VERIFICABLE) — reemplaza a
    // atribucionSinJustificar como resultado real observable (Fase 5).
    let relacionRespuestaDirigidaTraza = null;
    let alineacionRespuestaDirigidaResultadoTraza = null;
    // T-DIM2 — declarado a nivel de función (mismo motivo que las tres
    // variables de arriba: se lee mucho más abajo, en comprensionConversacional
    // y en el evento durable, fuera del bloque donde se calcula).
    let contratoRespuestaDirigidaEsteTurno = null;
    // Certificación causal de la respuesta dirigida, calculada antes de la
    // decisión visible de este turno para que Objetivo/Movimiento consuman
    // el estado post-resolución. Se transporta luego al lifecycle; no se
    // vuelve a inferir desde el Movimiento.
    let certificacionSatisfaccionResolucionEsteTurno = null;
    // circulomejora006 (evaluacionInterpretacion) — resultado estructural ya
    // validado de la evaluación explícita de Capa 1 sobre la dimensión
    // focal de ESTE turno (null cuando no aplica, o cuando ningún intento
    // produjo un resultado válido). "PROPUESTA" trae, además, el id REAL
    // (ya resuelto contra idTemporalAReal) del concepto identificado — la
    // única identidad que un commit posterior podrá usar para
    // candidatosMaterializables; esta rebanada (Commit 1) NO lo conecta
    // todavía. evaluacionInterpretacionOmitida es la degradación trazada
    // simétrica a atribucionSinJustificar: solo true cuando se agotaron
    // los 3 intentos sin un "resultado" válido — el turno se acepta
    // igual, nunca se fabrica una interpretación ni se bloquea el turno
    // por esto.
    let evaluacionInterpretacionResultado = null;
    let conceptoIdInterpretacionValidado = null;
    let evaluacionInterpretacionOmitida = false;
    // circulomejora006 (evaluacionInterpretacion, corrección de carrera —
    // auditoría aprobada) — PREPARACIÓN pre-construcción: la dimensión (o
    // null) para la que Movimiento, mirando ÚNICAMENTE el estado YA
    // COMPROMETIDO al inicio del turno (antes de que Capa 1 produzca nada),
    // ya decidiría PROPONER_INTERPRETACION. Es la ÚNICA fuente que gobierna
    // evaluacionInterpretacionRequerida/dimensionFocal del prompt — nunca
    // se recalcula con una política paralela (reutiliza decidirMovimientoDestino
    // tal cual, sin tocarla). Se reasigna más abajo, antes del bucle de
    // reintento; declarada aquí (nivel de función) para sobrevivir hasta la
    // comparación posterior a construcción y hasta la traza de observabilidad.
    let interpretacionPreparadaParaDimension = null;
    // circulomejora006 (evaluacionInterpretacion, corrección de carrera) —
    // decisión CRUDA de Movimiento, tal como sale de decidirMovimientoDestino
    // DESPUÉS de construcción, sin ninguna corrección del writer — nunca se
    // muta. Distinta de contratoMovimientoDestino (que sí puede degradarse a
    // null cuando esta decisión no es accionable este turno) — conservada
    // exclusivamente para observabilidad (comprensionConversacional.movimientoDecididoCrudo).
    let resultadoMovimientoDecididoCrudo = null;
    // circulomejora006 (evaluacionInterpretacion, corrección de carrera) —
    // razón por la que una decisión CRUDA de PROPONER_INTERPRETACION no fue
    // accionable este turno (dimensión distinta de interpretacionPreparadaParaDimension
    // — cruzó elegibilidad recién en esta misma construcción). Distinta de
    // movimientoNoEjecutadoRazon (que explica por qué un movimiento SÍ
    // accionable no llegó a ejecutarse/materializarse) — nunca se confunden.
    let movimientoNoAccionableRazon = null;
    // circulomejora006 (evaluacionInterpretacion, Commit 2) — disambiguación
    // de motivo cuando evaluacionInterpretacionOmitida es true: 'identidad'
    // (PROPUESTA con conceptoId inválido) reutiliza el código EXISTENTE
    // INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA; 'contrato' (resultado
    // ausente/inválido, o razon inválida) es el código NUEVO
    // EVALUACION_INTERPRETACION_OMITIDA — ver rama TRANSFORMAR, más abajo.
    let evaluacionInterpretacionMotivoOmision = null;
    // circulomejora006 (evaluacionInterpretacion) — "razon" de una
    // NO_PROPUESTA válida (EVIDENCIA_INSUFICIENTE/NO_AGREGA_COMPRENSION/
    // CONTRADICCION_ACTIVA), trazada para observabilidad — nunca gobierna
    // ninguna decisión, solo permite auditar POR QUÉ Capa 1 no propuso.
    let evaluacionInterpretacionRazon = null;
    // circulomejora006 — copia a nivel de función de promptBase.movimiento
    // ConversacionalDestinoActivo (promptBase vive dentro del bloque V2 y
    // no sobrevive hasta el punto donde se construye comprensionConversacional).
    let destinoMovimientoAplicaEsteTurno = false;
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — mismo patrón exacto que
    // destinoMovimientoAplicaEsteTurno, arriba, para promptBase.senalCierreConversacionalActiva:
    // copia a nivel de función porque promptBase no sobrevive hasta donde
    // se construyen senalCierreConversacional/objetivoConversacional, más
    // abajo.
    let senalCierreConversacionalAplicaEsteTurno = false;
    if (!this._protocolV2Enabled) {
      // Modo legacy — byte a byte igual que antes del Incremento 3.
      const systemPrompt = buildGramaticaPrompt(gramaticaActivaAlInicio, priorContext);
      r = await this._llmService.call({
        system: systemPrompt, userMsg: mensajeUsuario, label: gramaticaActivaAlInicio,
        callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
        turnoId: turnoIdReservadoEnAdmision,
      });
    } else {
      // Modo nuevo — contrato por estado, con reintento acotado ante
      // violaciones de forma (Incremento 3, punto 5). Cada intento vuelve a
      // generar desde el MISMO contexto original (nunca repara el texto
      // inválido directamente) — estrategia elegida por ser la más simple
      // de razonar y probar: el system prompt es puro en cada llamada, la
      // única variable entre intentos es la nota de corrección de formato
      // anexada al final. Ningún intento avanza numeroDeTurno, sintetiza
      // slots ni persiste nada — eso solo ocurre una vez, después de este
      // bloque completo, con el resultado final (válido o no).
      // A partir de aquí, TODO lee estadoActual — la foto posterior a
      // reconciliación (o la original, si esa fase no corrió o no tuvo
      // cambios que aplicar) — nunca `state` directamente. Es "lo que este
      // turno de construcción realmente vio".
      const protocoloEstadoActual = estadoActual.protocoloEstado || 'EXPLORANDO';
      // Incremento 1 (Grafo de Conocimiento vivo): solo tiene efecto en
      // EXPLORANDO, y solo junto con protocolV2Enabled (ya garantizado en
      // esta rama) — bin/start-server.js ya rechazó en bootstrap la
      // combinación KG=ON/V2=OFF, así que este archivo nunca necesita
      // volver a preguntarlo.
      grafoActivo = this._knowledgeGraphEnabled && protocoloEstadoActual === 'EXPLORANDO';
      // Incremento 2 ("toda información estructurada que consume el LLM
      // proviene exclusivamente de una proyección oficial del grafo"): a
      // diferencia de `grafoActivo` (exclusivo de EXPLORANDO, gobierna
      // MUTACIÓN del grafo — sin cambios), `grafoModoSesion` gobierna la
      // FUENTE del contenido de los tres contratos por igual (EXPLORANDO,
      // LISTO_PARA_SINTESIS, ESPERANDO_CONFIRMACION) — ninguno de los tres
      // lee `priorContext`/`state.slots` bajo el grafo activo.
      const grafoModoSesion = this._knowledgeGraphEnabled;
      // Foto 2 ("post-reconciliación, pre-construcción"): lo que el prompt
      // de ESTE turno realmente mostró — gobierna la validación de
      // next_user_action.objetivo más abajo. Distinta, a propósito, de la
      // foto 3 que usa decidirInteraccion para alimentar a decidirProtocolo
      // (ver comentario ahí).
      const pendientesCoberturaAntes = grafoActivo
        ? dimensionesPendientesDeGrafo(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
        : validateGramaticaComplete(estadoActual.slots, gramaticaActivaAlInicio).missing;
      // circulomejora006 (corrección final) — para 'destino', el vocabulario
      // válido de next_user_action.objetivo (y el gate D-040 de abajo) debe
      // ser el MISMO universo que Movimiento usa para elegir dimensionObjetivo
      // (pendientesCobertura ∪ elegiblesNoAtendidas ∪ conInterpretacionPendiente),
      // más la dimensión de un rechazo visible de ESTE turno si lo hay —
      // nunca solo la cobertura estrecha de Progreso. Sin este ensanche, un
      // turno que repara un rechazo visible, o que profundiza/propone sobre
      // una dimensión ya elegible pero con cobertura satisfecha, no tendría
      // ningún objetivo válido que ofrecerle a Capa 1 — aunque Movimiento sí
      // tenga algo real que decidir. La elección REAL de Movimiento nunca
      // depende de next_user_action.objetivo (viene de la plantilla
      // determinista o de la interrupción de rechazo) — ensanchar este
      // vocabulario solo evita rechazar de forma espuria un contrato que
      // Movimiento de todos modos va a gobernar.
      // circulomejora006_act10k — `let`, no `const`: se ensancha una vez más,
      // más abajo, con las dimensiones del componente relacional dirigido
      // (necesita protocoloEstadoEfectivo, resuelto recién después de este
      // bloque) — mismo principio de ensanche que el resto de este comentario,
      // nunca un vocabulario paralelo.
      // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera causal —
      // ELEGIBILIDAD_DIMENSIONAL_IGNORA_LA_AUTORIDAD_DE_CORRECCION_POR_ROL)
      // — ver la misma nota completa en decidirInteraccion, arriba en este
      // archivo. Aquí se lee directamente de estadoActual (esta foto es
      // "post-reconciliación, pre-construcción").
      const conceptoIdsExcluidosPorRolAntes = new Set(
        (estadoActual.protocoloExclusionesHipotesisPorRol || []).flatMap(e => e.conceptoIds),
      );
      // SUFICIENCIA_GLOBAL_IGNORA_EL_AMBITO_DE_LA_CORRECCION_DE_HIPOTESIS —
      // ver la nota completa junto a `dimensionesEnAmbitoDeCorreccion` en
      // decidirInteraccion, arriba en este archivo. Deliberadamente NO se
      // usa para ensanchar `slotsFaltantesAntes` (abajo) — los objetivos
      // válidos de next_user_action/conversación siguen siendo TODAS las
      // dimensiones elegibles, sin acotar; solo la puerta de suficiencia
      // (resultadoSuficienciaPostReconciliacion, más abajo) se acota.
      // Deliberadamente sin filtrar por estadoCorreccion — ver la nota
      // completa junto a `dimensionesEnAmbitoDeCorreccion` en
      // decidirInteraccion, arriba en este archivo (mismo defecto de
      // temporalidad: esta foto también es anterior a
      // resolverAsignacionPositivaAbierta).
      const dimensionesEnAmbitoDeCorreccionAntes = new Set(
        (estadoActual.protocoloExclusionesHipotesisPorRol || [])
          .filter(e => e.hipotesisSucesoraId === null)
          .map(e => e.dimension),
      );
      let slotsFaltantesAntes = (grafoActivo && gramaticaActivaAlInicio === 'destino')
        ? [...new Set([
            ...pendientesCoberturaAntes,
            // circulomejora006 (corrección posterior a la prueba real) — se
            // pasa la misma lista de diferidas que consultará Movimiento
            // más abajo, para que este vocabulario "válido" nunca ofrezca
            // como objetivo una dimensión que Movimiento ya excluyó de
            // elegiblesNoAtendidas.
            ...GrafoProyeccion.dimensionesElegiblesNoAtendidas(
              estadoActual.knowledgeGraph, gramaticaActivaAlInicio, estadoActual.protocoloDimensionesInterpretacionDiferida || [],
              conceptoIdsExcluidosPorRolAntes,
            ),
            ...GrafoProyeccion.dimensionesConInterpretacionPendiente(estadoActual.knowledgeGraph, gramaticaActivaAlInicio),
            ...proyectarReparacionesPendientes(
              estadoActual.protocoloReparacionesInterpretativasPendientes,
            ).map(r => r.dimension),
          ])]
        : pendientesCoberturaAntes;
      let reparacionesPendientesEsteTurno = proyectarReparacionesPendientes(
        estadoActual.protocoloReparacionesInterpretativasPendientes,
      );
      const resultadoSuficienciaPostReconciliacion = grafoModoSesion
        ? evaluarSuficienciaParaSintesis({
            hechosSemanticos: proyectarHechosSuficienciaParaSintesis(
              estadoActual.knowledgeGraph,
              gramaticaActivaAlInicio,
              estadoActual.protocoloDimensionesInterpretacionDiferida || [],
              conceptoIdsExcluidosPorRolAntes,
              dimensionesEnAmbitoDeCorreccionAntes,
            ),
            reparacionesInterpretativasPendientes: reparacionesPendientesEsteTurno,
          })
        : null;
      // circulomejora006_act10k — sin este ensanche, un objetivo dirigido
      // recién persistido (tras un rechazo relacional) sería invisible para
      // este cálculo: coberturaCompleta ya era true ANTES del rechazo (por
      // invariante — VALIDANDO_RELACION_TRANSFORMACIONAL solo se alcanza con
      // cobertura completa, ver ProgresoConversacionalPolicy), así que el
      // próximo turno de EXPLORANDO promovería inmediatamente a
      // LISTO_PARA_SINTESIS sin mostrar jamás el bloque de exploración
      // dirigida — el objetivo persistido quedaría inerte. `relacionTransformacionalVigente`
      // es exactamente false mientras exista un objetivo dirigido activo
      // (por definición: si hay un objetivo dirigido es porque la relación
      // propuesta fue rechazada, nunca confirmada); null en cualquier otro
      // caso (relación no requerida, o requerida pero todavía sin veredicto
      // — incluida una CONFIRMADA vigente: suficienciaGanada, más abajo,
      // solo puede volver a ser true con protocoloEstadoPersistido===EXPLORANDO,
      // así que este null nunca reabre un cierre ya alcanzado).
      // CERRAR_ARRANQUE_DEL_CICLO_TRANSFORMACIONAL_DE_DESTINO — mismo
      // principio que el call site de evaluarEstadoRelacionTransformacionalDestino
      // (ver más abajo en este archivo): relacionTransformacionalRequerida
      // ya NO depende de protocoloObjetivoRelacionalDirigido. Este era el
      // gate real del arranque circular: con la condición vieja, una sesión
      // fría (objetivo dirigido null) nunca activaba la rama de la línea
      // ~539 de ProgresoConversacionalPolicy (bloquear la promoción a
      // LISTO_PARA_SINTESIS hasta que exista relación transformacional
      // vigente) — así que suficienciaGanada promovía directo a
      // LISTO_PARA_SINTESIS, saltándose por completo
      // VALIDANDO_RELACION_TRANSFORMACIONAL. Ahora, para 'destino', toda
      // suficiencia ganada permanece en EXPLORANDO hasta que exista relación
      // confirmada — exactamente la decisión de producto de este incremento
      // (ninguna cobertura sola vuelve a cerrar DESTINO).
      const decisionEstadoPreturno = resultadoSuficienciaPostReconciliacion
        ? determinarEstadoProtocolarEfectivo({
            protocoloEstadoPersistido: protocoloEstadoActual,
            gramaticaActiva: gramaticaActivaAlInicio,
            resultadoSuficiencia: resultadoSuficienciaPostReconciliacion,
            relacionTransformacionalRequerida: gramaticaActivaAlInicio === 'destino',
            relacionTransformacionalVigente: estadoActual.protocoloObjetivoRelacionalDirigido ? false : null,
          })
        : { valido: true, protocoloEstadoEfectivo: protocoloEstadoActual };
      if (!decisionEstadoPreturno.valido) {
        // TERMINACION_CONOCIDA_SIN_TURNO — no es un fallo del LLM, pero es
        // igual de conocida: el Writer detecta la inconsistencia
        // determinísticamente (guardia previa a cualquier construcción de
        // prompt de este turno) y sabe con certeza que este intento termina
        // aquí, sin Turno.
        this._marcarEntradaFallidaSiEsSeguro({
          turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
          causa: 'ESTADO_PROTOCOLAR_INCONSISTENTE', errorCategory: null, retryable: null,
        });
        return {
          ok: false, httpStatus: 409, codigo: 'ESTADO_PROTOCOLAR_INCONSISTENTE',
          mensaje: decisionEstadoPreturno.razon,
        };
      }
      const protocoloEstadoEfectivo = decisionEstadoPreturno.protocoloEstadoEfectivo;
      protocoloEstadoEfectivoDeConstruccion = protocoloEstadoEfectivo;
      if (protocoloEstadoEfectivo !== protocoloEstadoActual) {
        estadoActual = { ...estadoActual, protocoloEstado: protocoloEstadoEfectivo };
      }
      // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION (C007,
      // MISSION_CLOSURE_ACCEPTANCE_MISROUTED_TO_SYNTHESIS_VERDICT_CONTRACT).
      // The confirmation subject of an ESPERANDO_CONFIRMACION turn. Primary
      // source is the durable field frozen when the state was entered
      // (protocoloConfirmacionSujeto). For a checkpoint that predates this
      // increment, it is reconstructed deterministically -- WITHOUT re-running
      // cognition and WITHOUT reading the raw user message -- from the
      // previous turn's already-frozen canonical decision (authority_trace.turno):
      // a PROPOSE_MISSION_CLOSURE that drove entry into ESPERANDO_CONFIRMACION
      // means the current turn is a closure acceptance, not a synthesis verdict.
      // (confirmationSujetoEsteTurno is declared at function scope, above.)
      // Scoped to the four non-DESTINO grammars: DESTINO runs its own closure
      // machinery from EXPLORANDO (never LISTO_PARA_SINTESIS ->
      // ESPERANDO_CONFIRMACION for a closure) and keeps its own synthesis
      // verdict for ESPERANDO_CONFIRMACION -- untouched here.
      if (gramaticaActivaAlInicio !== 'destino' && protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION') {
        if (estadoActual.protocoloConfirmacionSujeto === CONFIRMATION_SUBJECTS.MISSION_CLOSURE
          || estadoActual.protocoloConfirmacionSujeto === CONFIRMATION_SUBJECTS.SYNTHESIS) {
          confirmationSujetoEsteTurno = estadoActual.protocoloConfirmacionSujeto;
        } else {
          // COMMITTED_PREVIOUS_ACT_AUTHORITY_ONLY -- never the raw chronological
          // lastOfType (a failed CURRENT-turn retry, commit:false, must never
          // shadow the real last COMMITTED previous act).
          const trazaAnteriorParaSujeto = obtenerUltimoActoCanonicoComprometidoAnterior(
            this._unitOfWork.eventRepo, sesionId, { excludeTurnoId: turnoIdReservadoEnAdmision },
          );
          const decisionAnterior = trazaAnteriorParaSujeto && trazaAnteriorParaSujeto.payload
            && trazaAnteriorParaSujeto.payload.decision;
          if (decisionAnterior && decisionAnterior.operator === 'PROPOSE_MISSION_CLOSURE') {
            confirmationSujetoEsteTurno = CONFIRMATION_SUBJECTS.MISSION_CLOSURE;
          }
        }
      }
      // circulomejora006_act10k — consumo conversacional de
      // protocoloObjetivoRelacionalDirigido: EXCLUSIVO de destino+EXPLORANDO
      // (los otros 3 protocoloEstado, y las otras 4 gramáticas, nunca lo
      // leen — el campo tampoco se estampa fuera de destino, ver
      // _procesarValidacionRelacionTransformacionalDestino). Se lee del
      // ESTADO PERSISTIDO real (estadoActual — la foto post-reconciliación
      // que este turno de construcción realmente ve), nunca del cliente ni
      // re-deducido del evento anterior ni del texto conversacional. Usa
      // protocoloEstadoEfectivo (recién resuelto arriba), no
      // protocoloEstadoActual — EXPLORANDO persistido puede promoverse a
      // LISTO_PARA_SINTESIS antes de este punto, y el bloque dirigido es
      // exclusivo de EXPLORANDO real de este turno.
      const objetivoRelacionalDirigidoEsteTurno = (gramaticaActivaAlInicio === 'destino' && protocoloEstadoEfectivo === 'EXPLORANDO')
        ? (estadoActual.protocoloObjetivoRelacionalDirigido || null)
        : null;
      // El componente dirigido involucra dos dimensiones reales de DESTINO
      // (ver DIMENSIONES_POR_COMPONENTE_RELACIONAL) — se ensanchan aquí en
      // el MISMO vocabulario válido de next_user_action.objetivo (mismo
      // mecanismo que el ensanche de arriba), para que una pregunta dirigida
      // a la reparación nunca sea rechazada solo porque esas dimensiones ya
      // tenían cobertura suficiente antes de la corrección relacional.
      const relacionCorregidaContextoEsteTurno = objetivoRelacionalDirigidoEsteTurno
        ? {
            componenteLegible: construirComponenteLegibleParaObjetivoRelacional(
              estadoActual.knowledgeGraph, gramaticaActivaAlInicio, objetivoRelacionalDirigidoEsteTurno,
            ),
          }
        : null;
      if (objetivoRelacionalDirigidoEsteTurno) {
        const dimensionesDelComponente = DIMENSIONES_POR_COMPONENTE_RELACIONAL[objetivoRelacionalDirigidoEsteTurno];
        slotsFaltantesAntes = [...new Set([
          ...slotsFaltantesAntes, dimensionesDelComponente.desde, dimensionesDelComponente.hacia,
        ])];
      }
      // circulomejora006 (Especificación §1, corrección final) — extraído a
      // variable local (antes vivía inline dentro de promptBase) para que
      // el cálculo de evaluacionInterpretacionRequerida, más abajo, pueda
      // reutilizar la MISMA condición sin duplicarla — ningún cambio de
      // comportamiento, mismo valor exacto que antes.
      const drenajeReparacionInterpretativaActivo = reparacionesPendientesEsteTurno.length > 0;
      const movimientoConversacionalDestinoActivoEsteTurno = gramaticaActivaAlInicio === 'destino'
        && protocoloEstadoEfectivo === 'EXPLORANDO'
        && (this._movimientoConversacionalEnabled || drenajeReparacionInterpretativaActivo);
      // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (frontera causal —
      // SENAL_DE_CIERRE_NUNCA_SOLICITADA_FUERA_DEL_FLAG_EXPERIMENTAL_DE_MOVIMIENTO)
      // — P1-A/P1-B (autoridad de cierre conversacional) nacieron detrás de
      // movimientoConversacionalDestinoActivoEsteTurno por conveniencia,
      // nunca porque su propia autoridad dependiera del resto del
      // vocabulario de Movimiento (5 movimientos, evaluacionInterpretacion,
      // next_user_action suprimido). Ese flag está apagado en todo
      // despliegue real de este proyecto (CIRCULO_MOVIMIENTO_CONVERSACIONAL_ENABLED
      // nunca se declara en .env.local ni en ningún smoke real) — Capa 1
      // nunca llegaba a ver el bloque "OBSERVACIÓN CONVERSACIONAL", así que
      // una intención de cierre explícita del experto no tenía dónde
      // aterrizar (reproducido con Gemini real: turno de cierre puro,
      // "Creo que ya te conté lo esencial. Prefiero que cerremos con lo que
      // entendiste.", clasificación CIERRE_NO_DETECTADO — el JSON crudo de
      // Capa 1 ni siquiera tenía el campo "observacionesConversacionales").
      // Condición INDEPENDIENTE, mismo patrón ya usado por
      // correccionConceptoAbiertaEsteTurno (ver más abajo, T-DIM2/
      // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1): activa la extracción
      // y persistencia del cierre (P1-A/P1-B) SIN activar Movimiento en sí
      // — decidirMovimientoDestino y su vocabulario de 5 movimientos siguen
      // gobernados EXCLUSIVAMENTE por movimientoConversacionalDestinoActivoEsteTurno,
      // sin cambios.
      const senalCierreConversacionalActivaEsteTurno = gramaticaActivaAlInicio === 'destino'
        && protocoloEstadoEfectivo === 'EXPLORANDO';
      // circulomejora006 (evaluacionInterpretacion, corrección de carrera —
      // auditoría aprobada) — PREPARACIÓN: reutiliza decidirMovimientoDestino
      // TAL CUAL (mismo universo, misma prioridad, sin política paralela)
      // sobre estadoActual.knowledgeGraph — el estado YA COMPROMETIDO al
      // inicio de este turno (post-reconciliación), el mismo que ve la fase
      // de reconciliación de arriba. `nivel` es un valor de relleno: de
      // este resultado solo se lee `.movimiento`/`.dimensionObjetivo`,
      // nunca se usa como nivelLenguaje real de ningún turno (eso lo
      // calcula calcularNivelLenguaje, más abajo, para la decisión real).
      // huboRechazoVisibleEsteTurno/dimensionesRechazadasVisiblesEsteTurno
      // ya están resueltos (fase de Reconciliación, arriba en este mismo
      // método) — exactamente los mismos valores que la llamada posterior
      // a construcción usará más abajo.
      const resultadoMovimientoPreparado = movimientoConversacionalDestinoActivoEsteTurno
        ? (() => {
          const obligacionesPreparadas = proyectarObligacionesAbiertasDestino({
            reparacionesInterpretativasPendientes: reparacionesPendientesEsteTurno,
            reparacionesS1RAbiertas: (this._unitOfWork.afirmacionTransformacionalRepo
              && typeof this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion === 'function')
              ? this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion(sesionId) : [],
          });
          const objetivoPreparado = decidirObjetivoConversacional({
            grafo: estadoActual.knowledgeGraph,
            gramatica: gramaticaActivaAlInicio,
            slots: estadoActual.slots || {},
            obligacionesCognitivasAbiertas: obligacionesPreparadas,
            obligacionCognitivaActivaId: estadoActual.obligacionCognitivaActivaId || null,
            reparacionesInterpretativasPendientes: reparacionesPendientesEsteTurno,
          });
          return decidirMovimientoDestino({
            grafo: estadoActual.knowledgeGraph,
            nivel: 'reflejado',
            dimensionEnFocoAnterior: estadoActual.protocoloDimensionEnFoco || null,
            dimensionesDiferidas: estadoActual.protocoloDimensionesInterpretacionDiferida || [],
            dimensionesSinGanancia: estadoActual.protocoloDimensionesInterpretacionSinGanancia || {},
            reparacionesInterpretativasPendientes: reparacionesPendientesEsteTurno,
            objetivoConversacional: objetivoPreparado,
            obligacionesCognitivasAbiertas: obligacionesPreparadas,
            // DESTINO_OPTIONAL_DEPTH_STARVES_REQUIRED_COVERAGE -- this call
            // already uses estadoActual.knowledgeGraph (the pre-turn graph)
            // as its own `grafo`, so pendientesCoberturaAntes (the SAME
            // GrafoProyeccion.dimensionesPendientes reading, already
            // computed once above) is exactly consistent here -- never a
            // second, divergent derivation.
            misionPendienteAntesDeOpcional: pendientesCoberturaAntes,
          });
        })()
        : null;
      // circulomejora006 (evaluacionInterpretacion, corrección de carrera) —
      // la ÚNICA dimensión para la que Movimiento, con la evidencia que
      // este turno YA tenía antes de empezar, decidiría PROPONER_INTERPRETACION.
      // Nunca una dimensión que se vuelva elegible recién con lo que Capa 1
      // agregue en ESTE turno — esa posibilidad se resuelve después de
      // construcción (ver la comparación junto a decidirMovimientoDestino,
      // más abajo), nunca aquí.
      interpretacionPreparadaParaDimension = (
        resultadoMovimientoPreparado
        && resultadoMovimientoPreparado.movimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION
      ) ? resultadoMovimientoPreparado.dimensionObjetivo : null;
      // circulomejora006 (evaluacionInterpretacion) — dimensionFocal/
      // evaluacionInterpretacionRequerida (consumidos por AgoraPrompts, SIN
      // cambios en ese archivo) se derivan DIRECTAMENTE de la preparación
      // de arriba — nunca de un chequeo manual paralelo de elegibilidad/
      // oportunidad (ese chequeo quedaba, por diseño, un turno detrás de lo
      // que Movimiento realmente decidiría — ver auditoría de carrera).
      const dimensionFocalEsteTurno = interpretacionPreparadaParaDimension;
      const evaluacionInterpretacionRequeridaEsteTurno = !!interpretacionPreparadaParaDimension;
      // T-DIM2 (circulomejora006 — contrato causal de respuesta a
      // intervención dirigida) — reconstrucción PURA sobre autoridades
      // durables ya existentes (T-DIM2 Fase 1: Turno + EventRepository.
      // lastOfType + protocoloIntencionCierre/protocoloDimensionEnFoco ya
      // hidratados en estadoActual — ningún campo persistido nuevo, ninguna
      // variable process-local, ningún índice de array). Exclusivo de
      // destino+EXPLORANDO+movimiento activo con una dimensión ya en foco
      // — la MISMA condición que ya gobernaba el viejo gate de atribución
      // (dimensionObjetivoDeContrato, más abajo) — en cualquier otro caso
      // queda null y el turno no lleva ninguna obligación de relación.
      // (declarada a nivel de función, ver arriba — aquí solo se reasigna).
      //
      // S1-R-SCOPE1 (auditoría: reparación dirige Movimiento pero nunca
      // llegaba a la extracción cognitiva como contrato estructurado) — la
      // dimensión en foco de una intervención dirigida tiene DOS fuentes
      // durables posibles, nunca una tercera: protocoloDimensionEnFoco
      // (P1-B, continuidad ordinaria de EXPLORANDO) o, cuando esa no está
      // activa, protocoloObjetivoRelacionalDirigido (act10k — una
      // reparación S1-R ABIERTA dirigiendo exploración hacia el rol que
      // cuestiona). Ambas representan la MISMA autoridad causal ("hay una
      // pregunta dirigida vigente que este turno debe responder") — el
      // contrato T-DIM2 nunca supo de la segunda, así que Capa 1 nunca
      // declaraba relacionRespuestaDirigida para esos turnos y el Writer
      // nunca exigía un concepto verificable para el rol resultado.
      // DIMENSIONES_POR_COMPONENTE_RELACIONAL es el MISMO mapeo componente→
      // dimensión que ya usa construirBloqueExploracionDirigidaRelacional
      // (act10k) — nunca un criterio nuevo, nunca heurística léxica.
      // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera causal —
      // RESPUESTA_DIRIGIDA_A_UN_ROL_CAMBIA_DE_DIMENSION_SIN_JUSTIFICACION_ESTRUCTURADA)
      // — TERCERA fuente durable de intervención dirigida, misma autoridad
      // causal que protocoloDimensionEnFoco/protocoloObjetivoRelacionalDirigido
      // (arriba): una corrección de concepto ('corrige'+ambito='concepto')
      // que excluyó un rol pero todavía no tiene un reemplazo materializado
      // (estadoCorreccion!=='REEMPLAZO_MATERIALIZADO' en
      // protocoloExclusionesHipotesisPorRol) es, causalmente, una pregunta
      // dirigida vigente sobre esa dimensión — el mismo defecto que
      // S1-R-SCOPE1 ya corrigió para protocoloObjetivoRelacionalDirigido
      // (Capa 1 nunca declaraba relacionRespuestaDirigida para esos turnos,
      // así que una respuesta real podía atribuirse a OTRA dimensión sin
      // ninguna justificación estructurada — turno 2 real del smoke,
      // bicicleta: "ya no necesito que un taller valide..." se atribuyó a
      // "evidencia" en vez de "despues"). Nunca dos mecanismos paralelos:
      // reutiliza el MISMO contratoRespuestaDirigidaEsteTurno/
      // reconstruirContratoRespuestaDirigida — nunca un T-DIM2 nuevo. La más
      // reciente todavía abierta (última del array, mismo orden que el
      // resto del archivo ya usa) es la única candidata — nunca heurística
      // lexical sobre el texto del turno.
      const correccionConceptoAbiertaEsteTurno = (estadoActual.protocoloExclusionesHipotesisPorRol || [])
        .filter(e => e.estadoCorreccion !== 'REEMPLAZO_MATERIALIZADO')
        .slice(-1)[0] || null;
      contratoRespuestaDirigidaEsteTurno = null;
      const dimensionEnFocoParaContrato = estadoActual.protocoloDimensionEnFoco
        || (estadoActual.protocoloObjetivoRelacionalDirigido
          ? (DIMENSIONES_POR_COMPONENTE_RELACIONAL[estadoActual.protocoloObjetivoRelacionalDirigido] || {}).hacia || null
          : null)
        || (correccionConceptoAbiertaEsteTurno ? correccionConceptoAbiertaEsteTurno.dimension : null);
      // A diferencia de protocoloDimensionEnFoco/protocoloObjetivoRelacionalDirigido
      // (exclusivos de Movimiento activo), una corrección de concepto abierta
      // es autoridad causal POR SÍ SOLA — el contrato de respuesta dirigida
      // debe activarse aunque movimientoConversacionalEnabled esté apagado
      // (byte a byte el caso real de esta sesión: DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1
      // nunca activa Movimiento). Verificado que esto es seguro: el prompt
      // (AgoraPrompts.buildProtocoloBloqueExplorandoGrafo) gatea el bloque
      // "RELACIÓN CON TU PROPIA PREGUNTA ANTERIOR" únicamente en
      // contratoRespuestaDirigida (nunca en movimientoConversacionalDestinoActivo),
      // el gate de reintento (gateAtribucionInvalido, más abajo) lee
      // únicamente contratoRespuestaDirigidaEsteTurno, y decidirMovimientoDestino/
      // la ejecución de Movimiento se gatean únicamente en
      // movimientoConversacionalDestinoActivoEsteTurno/promptBase.movimientoConversacionalDestinoActivo
      // — nunca en este contrato.
      const eventoComprensionPresentadoAnterior = (() => {
        const ts = this._unitOfWork.turnoRepo.paginar(sesionId, null, 1);
        const t = ts.length ? ts[0] : null;
        if (!t || !t.turnoId) return null;
        return this._unitOfWork.eventRepo.findByTurnoId(sesionId, t.turnoId).find(e => e.tipo === 'comprension_conversacional.turno') || null;
      })();
      let contratoPresentadoAnterior = (eventoComprensionPresentadoAnterior && eventoComprensionPresentadoAnterior.payload
        && eventoComprensionPresentadoAnterior.payload.contratoIntervencion) || null;
      // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION (C007). A non-DESTINO
      // grammar's PROPOSE_MISSION_CLOSURE proposal turn does not emit a
      // comprension_conversacional.turno event (movement/typed direction is
      // inactive in LISTO_PARA_SINTESIS/ESPERANDO_CONFIRMACION), so the
      // reconstruction above finds nothing. Recover the frozen previous
      // canonical act from that turn's authority_trace.turno decision --
      // the same already-frozen contracted decision, never re-derived from
      // wording -- so the directed-response relation this turn declares can
      // be verified against it and interpretarVeredictoRespuestaActoAnterior
      // can produce MISSION_CLOSURE_ACCEPTED.
      if ((!contratoPresentadoAnterior || !contratoPresentadoAnterior.actoCognitivoVisible)
        && confirmationSujetoEsteTurno === CONFIRMATION_SUBJECTS.MISSION_CLOSURE) {
        // COMMITTED_PREVIOUS_ACT_AUTHORITY_ONLY -- same shared authority as
        // the confirmationSubject fallback above, never a second,
        // independently-filtered lookup.
        const trazaAnteriorParaActo = obtenerUltimoActoCanonicoComprometidoAnterior(
          this._unitOfWork.eventRepo, sesionId, { excludeTurnoId: turnoIdReservadoEnAdmision },
        );
        const decisionAnteriorParaActo = trazaAnteriorParaActo && trazaAnteriorParaActo.payload
          && trazaAnteriorParaActo.payload.decision;
        if (decisionAnteriorParaActo && decisionAnteriorParaActo.operator === 'PROPOSE_MISSION_CLOSURE') {
          contratoPresentadoAnterior = {
            funcion: 'REFLEJAR',
            actoCognitivoVisible: {
              operator: 'PROPOSE_MISSION_CLOSURE',
              target: null,
              missionNeed: 'MISSION_SUFFICIENT',
              subjectRef: null,
            },
            accionUsuario: { tipo: 'confirmar', objetivo: 'mission_closure', viaAcceso: null },
          };
        }
      }
      // SATISFIED_PREVIOUS_ACT != ACTIVE_PREVIOUS_ACT
      // (CURRENT_CANONICAL_ACT_MUST_OVERRIDE_STALE_CONVERSATIONAL_HISTORY,
      // C007, Daniel-adjudicated, real evidence: logistica_c0 fresh-live
      // turns 12-13, session live_complete_logistica_c0_11ec6033). Turn 12
      // re-presented PROPOSE_MISSION_CLOSURE (Decision computes the visible
      // act against gramaticaActivaAlInicio, i.e. the grammar AS THE TURN
      // STARTED -- already-confirmed non-bug ordering nuance, see
      // DESTINO_TO_DESTILAR_HANDOFF) in the SAME turn that ALSO verified and
      // accepted turn 11's own closure proposal (MISSION_CLOSURE_ACCEPTED,
      // via interpretarVeredictoRespuestaActoAnterior, below) -- so turn
      // 12's own presented act is the TAIL/RESTATEMENT of an obligation
      // already governed-satisfied THAT SAME turn, never a fresh ask.
      // Without this flag, every following turn's reconstruction (this same
      // block, further down) would treat turn 12's re-presented closure as
      // yet another ACTIVE directed-response obligation to verify -- forever,
      // for as long as no later turn's own presented act differs. Reads the
      // flag this same file writes onto comprensionConversacional (below,
      // near decidirInteraccion) -- never re-derives the verdict here.
      const contratoPresentadoAnteriorConsumido = !!(eventoComprensionPresentadoAnterior
        && eventoComprensionPresentadoAnterior.payload
        && eventoComprensionPresentadoAnterior.payload.respuestaDirigidaConsumidaPorAceptacion === true);
      if ((movimientoConversacionalDestinoActivoEsteTurno || correccionConceptoAbiertaEsteTurno || (contratoPresentadoAnterior && contratoPresentadoAnterior.actoCognitivoVisible)) && (dimensionEnFocoParaContrato || (contratoPresentadoAnterior && contratoPresentadoAnterior.actoCognitivoVisible))) {
        const eventoObjetivoAnterior = this._unitOfWork.eventRepo.lastOfType(sesionId, 'objetivo_conversacional.turno');
        const ultimosTurnos = this._unitOfWork.turnoRepo.paginar(sesionId, null, 1);
        const turnoAnterior = ultimosTurnos.length > 0 ? ultimosTurnos[0] : null;
        // La respuesta pertenece a la intervención efectivamente emitida en
        // el turno causal anterior.  No usar el último evento técnico de la
        // sesión como sustituto de identidad temporal: entre ambos turnos
        // pueden existir eventos cognitivos no respondibles.
        const eventoComprensionAnteriorCausal = turnoAnterior && turnoAnterior.turnoId
          ? this._unitOfWork.eventRepo.findByTurnoId(sesionId, turnoAnterior.turnoId)
            .find(e => e.tipo === 'comprension_conversacional.turno') || null
          : null;
        // S1-R-SCOPE1 (corrección posterior a la prueba real) — cuando la
        // fuente es protocoloObjetivoRelacionalDirigido (sin
        // protocoloDimensionEnFoco activo), NO existe "movimiento anterior"
        // que leer: la reparación S1-R dirige exploración directamente
        // (act10k), sin pasar nunca por decidirMovimientoDestino — de hecho
        // el turno que la dejó activa pudo, legítimamente,
        // decidir ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES (cobertura ya
        // completa) y aun así llevar la pregunta dirigida real en el prompt.
        // La función que esa pregunta cumple es, por definición, la MISMA
        // que ya existe en el catálogo para "obtener corrección tras
        // rechazo" (REPARAR_TRAS_RECHAZO — FUNCION_ESPERADA_POR_MOVIMIENTO)
        // — una reparación S1-R ES, causalmente, la continuación de un
        // rechazo/corrección semántica ya aceptado (ver S1-DISAGREE1) —
        // nunca un movimiento nuevo inventado aquí. Con
        // protocoloDimensionEnFoco activo (P1-B puro), el comportamiento
        // queda exactamente igual que antes: se sigue leyendo el
        // movimientoDecidido real del evento anterior.
        const fuenteEsReparacionRelacional = !estadoActual.protocoloDimensionEnFoco
          && !!estadoActual.protocoloObjetivoRelacionalDirigido;
        // Prioridad explícita, nunca implícita: protocoloDimensionEnFoco (P1-B)
        // y protocoloObjetivoRelacionalDirigido (S1-R-SCOPE1) siguen siendo,
        // en ese orden, las autoridades causales existentes — la corrección de
        // concepto abierta es la TERCERA, solo cuando ninguna de las otras dos
        // está activa (mismo criterio de exclusión mutua que ya rige entre las
        // primeras dos, arriba).
        const fuenteEsCorreccionConceptoAbierta = !estadoActual.protocoloDimensionEnFoco
          && !estadoActual.protocoloObjetivoRelacionalDirigido
          && !!correccionConceptoAbiertaEsteTurno;
        let movimientoAnteriorParaContrato = null;
        let codigoRazonAnteriorParaContrato = null;
        if (fuenteEsReparacionRelacional) {
          movimientoAnteriorParaContrato = 'REPARAR_TRAS_RECHAZO';
        } else if (fuenteEsCorreccionConceptoAbierta) {
          movimientoAnteriorParaContrato = 'CORREGIR_CONCEPTO_SIN_REEMPLAZO';
        } else {
          const movimientoDecididoAnterior = eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
            ? eventoComprensionAnteriorCausal.payload.movimientoDecidido : null;
          movimientoAnteriorParaContrato = movimientoDecididoAnterior ? movimientoDecididoAnterior.movimiento : null;
          codigoRazonAnteriorParaContrato = movimientoDecididoAnterior ? movimientoDecididoAnterior.codigoRazon : null;
        }
        contratoRespuestaDirigidaEsteTurno = reconstruirContratoRespuestaDirigida({
          dimensionObjetivoAnterior: dimensionEnFocoParaContrato,
          movimientoAnterior: movimientoAnteriorParaContrato,
          viaAccesoAnterior: eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
            && eventoComprensionAnteriorCausal.payload.contratoIntervencion
            && eventoComprensionAnteriorCausal.payload.contratoIntervencion.accionUsuario
            ? eventoComprensionAnteriorCausal.payload.contratoIntervencion.accionUsuario.viaAcceso : null,
          resultadoViaAccesoAnterior: eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
            && eventoComprensionAnteriorCausal.payload.relacionRespuestaDirigida
            ? eventoComprensionAnteriorCausal.payload.relacionRespuestaDirigida.resultadoViaAcceso : null,
          codigoRazonAnterior: codigoRazonAnteriorParaContrato,
          turnoIntervencionId: turnoAnterior ? turnoAnterior.turnoId : null,
          preguntaVisibleAnterior: turnoAnterior ? turnoAnterior.mensajeCirculo : null,
          objetivoConversacionalAnterior: eventoObjetivoAnterior && eventoObjetivoAnterior.payload
            ? eventoObjetivoAnterior.payload.objetivo : null,
          referenciaResolucionAnterior: (() => {
            const eventoPrevio = eventoComprensionAnteriorCausal;
            const contratoPrevio = eventoPrevio && eventoPrevio.payload && eventoPrevio.payload.contratoIntervencion;
            return contratoPrevio && contratoPrevio.referenciaResolucion
              ? contratoPrevio.referenciaResolucion : null;
          })(),
          interpretacionReparadaAnterior: (() => {
            const eventoPrevio = eventoComprensionAnteriorCausal;
            const referencia = eventoPrevio && eventoPrevio.payload && eventoPrevio.payload.contratoIntervencion
              && eventoPrevio.payload.contratoIntervencion.referenciaResolucion;
            const reparaciones = estadoActual.protocoloReparacionesInterpretativasPendientes || {};
            const reparacion = referencia && reparaciones[referencia.obligacionId];
            // La reparación conserva el snapshot del concepto exactamente
            // como fue rechazado. El grafo actual puede haber refinado o
            // reemplazado esa identidad; nunca se usa como sustituto causal.
            return reparacion && reparacion.interpretacionRechazadaSnapshot
              ? reparacion.interpretacionRechazadaSnapshot
              : null;
          })(),
          unknownIdAnterior: (() => {
            const previo = eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
              && eventoComprensionAnteriorCausal.payload.contratoIntervencion;
            return previo && previo.contenido ? previo.contenido.unknownId || null : null;
          })(),
          desconocidoPreguntableScopedAnterior: (() => {
            const previo = eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
              && eventoComprensionAnteriorCausal.payload.contratoIntervencion;
            return previo && previo.contenido ? previo.contenido.desconocidoPreguntableScoped || null : null;
          })(),
          actoInterrogativoAnterior: (() => {
            const previo = eventoComprensionAnteriorCausal && eventoComprensionAnteriorCausal.payload
              && eventoComprensionAnteriorCausal.payload.contratoIntervencion;
            return previo && previo.contenido ? previo.contenido.actoInterrogativo || null : null;
          })(),
          deudaBloqueanteAnterior: (estadoActual.protocoloIntencionCierre && estadoActual.protocoloIntencionCierre.deudaBloqueante) || null,
        });
        // SATISFIED_PREVIOUS_ACT != ACTIVE_PREVIOUS_ACT -- narrowly scoped to
        // the ONE demonstrated case (PROPOSE_MISSION_CLOSURE, matching the
        // existing OPERADORES_CON_RESPUESTA_DIRIGIDA_SIN_DIMENSION allow-list
        // discipline): never generalized to every directed-response operator
        // (§4 -- "a rejected/corrected/ambiguous response must follow its
        // existing semantics", unaffected here). contratoPresentadoAnteriorConsumido
        // is true ONLY when THIS SAME presented act's turn already computed
        // MISSION_CLOSURE_ACCEPTED for it (see comprensionConversacional,
        // below) -- never inferred from grammar transition alone (FA4).
        const contratoPresentadoAnteriorYaSatisfecho = !!(contratoPresentadoAnterior
          && contratoPresentadoAnterior.actoCognitivoVisible
          && contratoPresentadoAnterior.actoCognitivoVisible.operator === 'PROPOSE_MISSION_CLOSURE'
          && contratoPresentadoAnteriorConsumido);
        if (contratoPresentadoAnterior && contratoPresentadoAnterior.actoCognitivoVisible
          && !contratoPresentadoAnteriorYaSatisfecho
          && OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA.includes(
            contratoPresentadoAnterior.actoCognitivoVisible.operator,
          )) {
          // CONTRATO_RESPUESTA_DIRIGIDA_CANONICAL_DIMENSION_LOST (C007,
          // Daniel-adjudicated, real evidence: logistica_c0 fresh-live turn
          // 10, session live_complete_logistica_c0_11ec6033).
          // CANONICAL_ACT_TARGET_IDENTITY_IS_THE_AUTHORITY_FOR_TARGET_
          // METADATA: accionUsuario.objetivo is a LEGACY slot-routing field
          // that canonical-path (frozen actoCognitivoVisible) acts never
          // populate -- reading it here silently produced dimensionObjetivo:
          // null for every canonical ASK_HOW/etc. Contract, which then made
          // ContratoRespuestaDirigidaPolicy's own structural support-match
          // filter unconditionally empty (RELACION_POSITIVA_SIN_SOPORTE_
          // ESTRUCTURADO), rejecting even a genuinely correct, on-topic
          // direct answer. The real governed dimension already lives on the
          // frozen act's OWN target -- resolved here via the SAME reused
          // lookup pattern this file already uses elsewhere for a frozen
          // act's target (grafo.incertidumbres.find(u => u.id === target),
          // e.g. actoDirigidoPrevio resolution below; grafo.conceptos.find
          // for the concept-target case, matching subjectRef resolution
          // near the top of this file) -- never a bespoke third lookup.
          // TARGET_METADATA_RESOLUTION != DOWNSTREAM_WHAT_RE-DERIVATION:
          // this only reads an already-governed field off an already-frozen
          // target; it does not choose, validate, or re-decide anything.
          // Uses estadoActual.knowledgeGraph (the durable PRE-turn graph --
          // grafoDelta does not exist yet at this point in the turn) since
          // the prior turn's target is, by construction, already durably
          // governed.
          const dimensionContratadaPorActo = resolverDimensionDeTargetGobernado(
            contratoPresentadoAnterior.actoCognitivoVisible.target, estadoActual.knowledgeGraph,
          );
          // A canonical Contract can direct a response without a legacy
          // Movement/protocoloDimensionEnFoco. Preserve the dimension that
          // the presented Contract already froze instead of constructing a
          // partial response contract whose dimension becomes `undefined`.
          contratoRespuestaDirigidaEsteTurno = {
            ...(contratoRespuestaDirigidaEsteTurno || {
              turnoIntervencionId: turnoAnterior ? turnoAnterior.turnoId : null,
              movimiento: null,
              preguntaVisible: turnoAnterior ? turnoAnterior.mensajeCirculo : null,
              funcionEsperada: contratoPresentadoAnterior.funcion || null,
              criterioDeResolucion: contratoPresentadoAnterior.criterioExito || null,
            }),
            dimensionObjetivo: (contratoRespuestaDirigidaEsteTurno
              && contratoRespuestaDirigidaEsteTurno.dimensionObjetivo)
              || dimensionContratadaPorActo,
            actoCognitivoVisible: contratoPresentadoAnterior.actoCognitivoVisible,
            contratoId: contratoPresentadoAnterior.id || null,
            // DIRECTED_RESPONSE_SUPPORT_FOLLOWS_PREVIOUS_ACT_AUTHORITY -- WHY the
            // dimension is null: only when the frozen act is a canonical
            // ASK_EXISTENCE / OPEN_SEARCH whose target is a free-text search
            // target that is not a governed id (verified against the durable
            // pre-turn graph). null dimension alone authorizes nothing.
            objetivoAbiertoNoGobernado: dimensionContratadaPorActo == null
              && !(contratoRespuestaDirigidaEsteTurno && contratoRespuestaDirigidaEsteTurno.dimensionObjetivo)
              && objetivoDeActoEsBusquedaAbiertaNoGobernada(
                contratoPresentadoAnterior.actoCognitivoVisible, estadoActual.knowledgeGraph),
          };
        } else if (contratoPresentadoAnterior && contratoPresentadoAnterior.actoCognitivoVisible) {
          // El Contract visible es la historia causal. Un Movement previo no
          // puede reconstruir como pregunta un RETURN que efectivamente fue
          // presentado; esos operadores no abren respuesta dirigida.
          contratoRespuestaDirigidaEsteTurno = null;
        }
      }
      // FIRST_GOVERNED_ANCHOR_BOOTSTRAP — on a fresh session the current
      // admitted turn is the only possible primary source. Reconciliation
      // already owns literal-source verification, type/dimension governance
      // and durable concept identity; run that authority before asking the
      // cognitive producer for an anchored candidate. This does not turn raw
      // text into authority and does not produce WHAT: it only makes the
      // governed current-turn basis visible to the one ordinary producer.
      const conceptosExpertosDurablesAntesDeProduccion = (
        estadoActual.knowledgeGraph && Array.isArray(estadoActual.knowledgeGraph.conceptos)
          ? estadoActual.knowledgeGraph.conceptos : []
      ).filter(c => c && c.activo !== false && c.autoridad === 'experto');
      if (gramaticaActivaAlInicio === 'destino'
        && grafoModoSesion
        && protocoloEstadoEfectivo === 'EXPLORANDO'
        && conceptosExpertosDurablesAntesDeProduccion.length === 0) {
        const bootstrapGobernado = await ejecutarReconciliacion();
        reconciliacionBootstrapEjecutadaEsteTurno = true;
        if (bootstrapGobernado && bootstrapGobernado.__falloOperacionalReconciliacion) {
          return bootstrapGobernado.resultado;
        }
        if (bootstrapGobernado) grafoDelta = bootstrapGobernado;
      }

      // PREVIOUS_INTERVENTION_DIMENSION_SURVIVES_TO_RESPONSE_ATTRIBUTION
      // (C007, DVP-B). The dimension the PREVIOUSLY PRESENTED intervention
      // asked about, read ONLY from the latest COMMITTED authority trace
      // (COMMITTED_PREVIOUS_ACT_AUTHORITY_ONLY: a failed attempt, commit:
      // false, is never a candidate) and only for the grammar that presented
      // it. It is adjudication CONTEXT for this turn's concept capture --
      // never a label: the Producer still proposes each concept's slot and
      // gobernarDimensionDeltaConceptos still adjudicates it. DESTINO keeps
      // its own directed-response lifecycle (untouched).
      const contextoAtribucionRespuestaPrevio = gramaticaActivaAlInicio === 'destino' ? null
        : leerContextoAtribucionRespuestaVigente(
          obtenerUltimoActoCanonicoComprometidoAnterior(
            this._unitOfWork.eventRepo, sesionId, { excludeTurnoId: turnoIdReservadoEnAdmision },
          ),
          { gramaticaActiva: gramaticaActivaAlInicio },
        );
      trazaAutoridadEsteTurno.responseAttributionContextConsumido = contextoAtribucionRespuestaPrevio
        ? { sourceTurnId: contextoAtribucionRespuestaPrevio.sourceTurnId, dimension: contextoAtribucionRespuestaPrevio.dimension, source: contextoAtribucionRespuestaPrevio.source }
        : null;

      const promptBase = {
        gramatica: gramaticaActivaAlInicio, protocoloEstado: protocoloEstadoEfectivo, priorContext,
        // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- so the
        // ESPERANDO_CONFIRMACION prompt never tells the model "Ya propusiste
        // una síntesis..." for a mission-closure acceptance turn.
        confirmationSubject: confirmationSujetoEsteTurno,
        // Contrato explícito de la dirección tipada: la misión adapter es la
        // autoridad semántica; el prompt no debe reconstruirla por nombre de
        // gramática.
        direccionConversacional: (() => {
          const descriptor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
          return descriptor && descriptor.direccionConversacional
            ? { ...descriptor.direccionConversacional }
            : null;
        })(),
        slotsFaltantes: slotsFaltantesAntes,
        // El prompt solo necesita el texto — AgoraPrompts no conoce (ni debe
        // conocer) la forma versionada de CognitiveState.protocoloSintesisVigente.
        sintesisVigente: estadoActual.protocoloSintesisVigente ? estadoActual.protocoloSintesisVigente.texto : null,
        correccionPendiente: estadoActual.protocoloCorreccionPendiente || null,
        intentosAmbiguosPrevios: estadoActual.protocoloIntentosAmbiguos || 0,
        // grafoConocimientoActivo ahora es de sesión (no exclusivo de
        // EXPLORANDO): LISTO_PARA_SINTESIS también necesita su propio
        // subgrafo para sintetizar desde el grafo, no desde texto plano.
        grafoConocimientoActivo: grafoModoSesion,
        subgrafo: grafoModoSesion ? {
          conceptos: conceptosDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio),
          incertidumbres: incertidumbresRelevantesAbiertas(estadoActual.knowledgeGraph, gramaticaActivaAlInicio),
        } : null,
        // dimensionesPendientes sigue exclusivo de EXPLORANDO — es
        // vocabulario de next_user_action.objetivo, sin sentido en
        // LISTO_PARA_SINTESIS/ESPERANDO_CONFIRMACION.
        dimensionesPendientes: grafoActivo ? slotsFaltantesAntes : null,
        // Incremento 2: contexto entre gramáticas, siempre desde el grafo
        // bajo grafoModoSesion — reemplaza a priorContext por completo en
        // ese modo (ver comentario de priorContext, más arriba en este
        // método). Ciclo Cognitivo de Descubrimiento (ADR): ya particionado
        // por autoridad — ver contextoGramaticasAnterioresPorAutoridad. Una
        // hipótesis "inferido" de una gramática anterior nunca puede
        // presentarse como asentada solo porque cambió la gramática activa.
        contextoGrafoAnteriores: grafoModoSesion
          ? contextoGramaticasAnterioresPorAutoridad(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
          : null,
        // Catálogo de referencias de solo lectura. Incluye conocimiento
        // experto heredado sin cambiar su gramaticaOrigen ni su identidad.
        anclajesReferenciables: grafoModoSesion
          ? (() => {
            const descriptor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
            const operaciones = descriptor && descriptor.direccionConversacional
              && descriptor.direccionConversacional.tipada
              ? descriptor.direccionConversacional.operacionesSoportadas || [] : [];
            const conceptosBase = [
            ...contextoGramaticasAnterioresPorAutoridad(estadoActual.knowledgeGraph, gramaticaActivaAlInicio).confirmado,
            ...conceptosDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio),
            ];
            const candidatos = operaciones.length > 0
              ? anclajesElegiblesParaOperacion(estadoActual.knowledgeGraph, operaciones[0])
              : conceptosBase.filter(c => c && c.activo !== false && c.autoridad === 'experto');
            const permitidos = new Set(candidatos.map(c => c.id));
            return conceptosBase
            .filter(c => c && permitidos.has(c.id))
            .map(c => ({
              conceptoId: c.id,
              descripcion: c.descripcion,
              autoridad: c.autoridad,
              procedencia: c.procedencia,
              alcance: alcanceEpistemicoConcepto(c),
              gramaticaOrigen: c.gramaticaOrigen || null,
              afirmacionTransformacionalId: c.afirmacionTransformacionalId || null,
              afirmacionTransformacionalVersion: c.afirmacionTransformacionalVersion || null,
              tipoProyeccion: c.tipoProyeccion || null,
            }));
          })()
          : null,
        operacionesConversacionalesSoportadas: (() => {
          const descriptor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
          return descriptor && descriptor.direccionConversacional
            && descriptor.direccionConversacional.operacionesSoportadas
            ? [...descriptor.direccionConversacional.operacionesSoportadas]
            : ['ABRIR_COMO', 'PEDIR_EJEMPLO'];
        })(),
        // Ciclo Cognitivo de Descubrimiento (ADR) — cierre de la "amnesia
        // regenerativa": memoria negativa LOCAL de esta gramática (nunca
        // cruza a otra, nunca es una lista global de vocabulario prohibido
        // — ver sintesisRechazadasDeGramatica). Solo tiene efecto en la
        // rama de síntesis fresca de AgoraPrompts; se calcula siempre que
        // hay grafo, aunque este turno no llegue a usarla.
        sintesisRechazadas: grafoModoSesion
          ? sintesisRechazadasDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
          : null,
        // Ciclo Cognitivo de Descubrimiento (ADR §2/§7) — ELEGIBILIDAD: se
        // calcula una vez, sobre la foto post-reconciliación
        // (estadoActual.knowledgeGraph, la única que este turno de
        // construcción llega a ver), para TODAS las dimensiones de la
        // gramática activa — no solo las pendientes, porque una dimensión
        // ya "suficiente" en slots igual puede recibir una abstracción
        // nueva. Único lugar donde se calcula (GrafoProyeccion,
        // determinístico) — el prompt de abajo solo reporta el veredicto,
        // la validación real ocurre otra vez, contra este mismo
        // estadoActual.knowledgeGraph, en el bucle de reintento (ver más
        // abajo) — nunca confía en que el LLM haya respetado el prompt.
        // Ciclo Cognitivo de Descubrimiento — también se calcula bajo
        // ESPERANDO_CONFIRMACION: un rechazo puede traer evidencia nueva
        // (conceptosNuevos) en el mismo turno, y esa evidencia respeta la
        // MISMA regla de elegibilidad que EXPLORANDO — nunca una relajada.
        elegibilidadPorDimension: (grafoActivo || protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION')
          ? Object.fromEntries((SLOTS_BY_GRAMATICA[gramaticaActivaAlInicio] || []).map(dim => {
              const umbral = umbralElegibilidad(estadoActual.knowledgeGraph, dim);
              const evidencia = conceptosDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
                .filter(c => c.autoridad === 'experto' && dimensionDeProcedencia(c.procedencia) === dim).length;
              return [dim, { elegible: evidencia >= umbral, evidencia, umbral }];
            }))
          : null,
        // circulomejora006 (Especificación §1, corrección final) — condición
        // completa resuelta AQUÍ, una sola vez: exclusivo de DESTINO,
        // EXPLORANDO y el flag de movimiento activo. AgoraPrompts nunca
        // vuelve a preguntarla — reproduce el contrato compartido byte a
        // byte en cualquier otro caso.
        movimientoConversacionalDestinoActivo: movimientoConversacionalDestinoActivoEsteTurno,
        oportunidadesConversacionalesActivas: !!(
          movimientoConversacionalDestinoActivoEsteTurno
          || (gramaticaActivaAlInicio !== 'destino'
            && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
            && this._movimientoConversacionalEnabled)
        ),
        // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — condición independiente, ver
        // cálculo arriba. Gobierna únicamente si Capa 1 recibe el bloque
        // "OBSERVACIÓN CONVERSACIONAL"/el campo "observacionesConversacionales"
        // (AgoraPrompts.buildProtocoloBloqueExplorandoGrafo) — nunca activa
        // el resto del contrato de Movimiento.
        senalCierreConversacionalActiva: senalCierreConversacionalActivaEsteTurno,
        // circulomejora006 (evaluacionInterpretacion) — ver constantes
        // locales de arriba. null/false en cualquier caso fuera del
        // alcance exclusivo de este incremento — AgoraPrompts reproduce el
        // contrato compartido byte a byte cuando evaluacionInterpretacionRequerida
        // es false, sea cual sea dimensionFocal.
        dimensionFocal: dimensionFocalEsteTurno,
        evaluacionInterpretacionRequerida: evaluacionInterpretacionRequeridaEsteTurno,
        // circulomejora006_act10k — null en cualquier caso fuera de
        // destino+EXPLORANDO+objetivo dirigido activo — AgoraPrompts
        // reproduce el contrato de EXPLORANDO byte a byte en ese caso.
        objetivoRelacionalDirigido: objetivoRelacionalDirigidoEsteTurno,
        relacionCorregidaContexto: relacionCorregidaContextoEsteTurno,
        // S1_R_INCREMENTO_2 — condición completa resuelta AQUÍ, una sola vez
        // (mismo criterio que objetivoRelacionalDirigido arriba): exclusivo
        // de DESTINO, grafo de sesión activo y ESPERANDO_CONFIRMACION.
        // AgoraPrompts nunca vuelve a preguntarla.
        alcanceCorreccionRelacionalSolicitable: (
          gramaticaActivaAlInicio === 'destino' && grafoModoSesion
          && protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION'
        ),
        // T-DIM2 — ver cálculo arriba. null en cualquier caso fuera de su
        // alcance exclusivo — AgoraPrompts reproduce el contrato byte a
        // byte en ese caso.
        contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
        // Non-authoritative temporal context (see above); null reproduces the prompt byte for byte.
        contextoAtribucionRespuesta: contextoAtribucionRespuestaPrevio,
      };

      let correccionDeFormato = null;
      let validacionContrato = etiquetarValidacionContrato({ valido: false, errores: ['sin intentos todavía'] });
      let intentosContrato = 0;
      let intentosPropuestaCompleta = 0;
      let intentosReparacionSoporteDirigido = 0;
      let candidateUnderreachPreGovernance = false;
      let propuestaBaseReparacionSoporteDirigido = null;
      // grafoDelta (declarado arriba, nivel de función): resultado de
      // aplicarDelta cuando grafoActivo — se valida aquí mismo (dry-run
      // dentro del mismo bucle de reintento de contrato, reutilizando el
      // mecanismo YA EXISTENTE de corrección de formato en vez de uno
      // nuevo) y se reutiliza tal cual en decidirInteraccion, sin recalcular.
      //
      // Garantías atómicas para GobernanzaMaterializacion (auditoría de
      // tipado semántico posterior a 23b766f): `validacionContrato.valido`
      // fusiona dos hechos distintos — el contrato de campos propio del
      // estado, y (cuando aplica) el resultado de la evaluación de
      // elegibilidad del grafo — y se sobrescribe dentro de este mismo
      // bucle cuando esa evaluación rechaza. contratoDeCamposValidado
      // captura el PRIMERO tal cual sale de validarContratoPorEstado,
      // antes de cualquier sobrescritura; evaluacionGrafo captura el
      // SEGUNDO, explícitamente, incluyendo NO_APLICA cuando el mecanismo
      // de evaluación no llegó a correr esta vez — nunca inferido de
      // ignorar el caso. Ambas se reinician en cada intento (nunca
      // acumulan entre reintentos, igual que validacionContrato).
      let contratoDeCamposValidado = false;
      let evaluacionGrafo = EVALUACION_GRAFO.NO_APLICA;
      // circulomejora006 (Especificación §2) — únicamente observabilidad;
      // NUNCA alimenta REPARAR_TRAS_RECHAZO. marcarObsoletos no demuestra
      // por sí solo que el experto rechazó algo — puede ser refinamiento.
      // circulomejora006 (Especificación §1/§3 de las correcciones finales)
      // — contrato epistemológico de Capa 1, EXCLUSIVO de
      // movimientoConversacionalDestinoActivo. observacionNaturalezaValor
      // es lo DECLARADO (post-validación de formato); observacionNaturaleza
      // Gobernada/Degradada son el resultado de naturalezaEpistemicaGobernada
      // (Ley de Degradación — nunca aborta por esto). Se reinician en cada
      // intento, igual que contratoDeCamposValidado/evaluacionGrafo. Todas
      // declaradas a nivel de función (ver más arriba) — aquí solo se
      // reasignan, nunca se redeclaran (evita sombrear la variable externa
      // que _confirmarInteraccion necesita leer más abajo).
      huboObsolescenciaEsteTurno = false;

      // PRODUCER_EXECUTION_ABSTRACTION — identidad estable del trabajo ya
      // gobernado. Un executor alternativo recibe este MISMO contrato base;
      // solamente cambia la implementación de LLMService que lo ejecuta.
      const descriptorTareaProductor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
      const direccionTareaProductor = descriptorTareaProductor && descriptorTareaProductor.direccionConversacional;
      const dimensionTareaProductor = direccionTareaProductor
        && direccionTareaProductor.alcanceAnclaje === 'DIMENSION_PENDIENTE'
        ? (estadoActual.protocoloDimensionEnFoco || slotsFaltantesAntes[0] || null)
        : null;
      const fronteraTareaProductor = grafoModoSesion && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
        ? construirFronteraCognitivaAdmisible({
            grafo: grafoDelta || estadoActual.knowledgeGraph,
            gramatica: gramaticaActivaAlInicio,
            slots: estadoActual.slots || {},
            dimension: dimensionTareaProductor,
            idTemporalAReal: idTemporalARealEsteTurno,
          })
        : [];
      const producerTask = this._producerExecutionCoordinator.beginTask({
        grammar: gramaticaActivaAlInicio,
        userMsg: mensajeUsuario,
        promptContract: buildGramaticaPromptV2({ ...promptBase, correccionDeFormato: null }),
        responseSchema: buildCapa1CognitiveResponseSchema(promptBase.movimientoConversacionalDestinoActivo, gramaticaActivaAlInicio),
        callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
        frontier: fronteraTareaProductor,
      });
      let llmServiceProductorActivo = producerTask.current();
      let producerFailureClassFinal = null;
      const estadoInicialTareaProductor = {
        grafoDelta,
        idTemporalARealEsteTurno: { ...idTemporalARealEsteTurno },
        oportunidadesGobernadasEsteTurno: [...oportunidadesGobernadasEsteTurno],
        oportunidadTipadaValidaEsteTurno,
      };

      // The contract-of-fields check of THIS state, factored out of the
      // attempt loop (same arguments, same call) so a repaired
      // representation can be judged by the very same rule an ordinary
      // attempt is: REPAIR MAY RECONSTRUCT THE REPRESENTATION, NEVER BYPASS
      // ITS VALIDATION.
      const validarContratoDeCamposDelProductor = (parsedEvaluado) => validarContratoPorEstado({

          protocoloEstado: protocoloEstadoEfectivo, parsed: parsedEvaluado, slotsFaltantes: slotsFaltantesAntes,
          // circulomejora006 (tercera verificación, Sección C3) — cuando
          // Movimiento gobierna DESTINO, el contrato pedido a Capa 1 ya no
          // incluye "next_user_action" (ver buildProtocoloBloqueExplorandoGrafo)
          // — exigir su presencia aquí reintentaría el turno para siempre
          // por un campo que deliberadamente se retiró del contrato.
          // CERRAR_ARRANQUE_DEL_CICLO_TRANSFORMACIONAL_DE_DESTINO — mismo
          // motivo se aplica ahora cuando slotsFaltantesAntes queda vacío
          // (cobertura completa, EXPLORANDO persiste solo porque la relación
          // transformacional todavía no está confirmada — ver
          // determinarEstadoProtocolarEfectivo): exigir next_user_action.objetivo
          // contra una lista vacía es exactamente el contrato irrespondible
          // que D-040 ya documentó — mismo criterio de supresión que
          // AgoraPrompts.buildProtocoloBloqueExplorandoGrafo (debeOmitirNextUserAction),
          // nunca un contrato nuevo.
          // Las direcciones tipadas gobiernan la intervención mediante su
          // oportunidad estructurada; no requieren que Capa 1 duplique ese
          // contrato en el vocabulario legacy de next_user_action/slots.
          nextUserActionRequerido: !promptBase.movimientoConversacionalDestinoActivo
            && !direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
            && slotsFaltantesAntes.length > 0,
          // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- selects the
          // closure-acceptance contract (no clasificacion_respuesta demanded)
          // when this ESPERANDO_CONFIRMACION turn is a response to a frozen
          // PROPOSE_MISSION_CLOSURE.
          confirmationSubject: confirmationSujetoEsteTurno,
              });

      // PREVIOUS_RESPONSE_CONTRACT_MUST_BE_VERDICTED_BEFORE_PRODUCER_ACCEPTANCE --
      // true once THIS attempt's relation has already been validated by the
      // graph-governed gate below (so the common postcondition never validates
      // the same relation twice, nor with a weaker input than that gate has).
      let relacionVerificadaEsteIntento = false;
      producerExecutionLoop: while (true) {
        correccionDeFormato = null;
        validacionContrato = etiquetarValidacionContrato({ valido: false, errores: ['sin intentos todavía'] });
        intentosContrato = 0;
        intentosPropuestaCompleta = 0;
        intentosReparacionSoporteDirigido = 0;
        candidateUnderreachPreGovernance = false;
        propuestaBaseReparacionSoporteDirigido = null;
        contratoDeCamposValidado = false;
        evaluacionGrafo = EVALUACION_GRAFO.NO_APLICA;
        grafoDelta = estadoInicialTareaProductor.grafoDelta;
        idTemporalARealEsteTurno = { ...estadoInicialTareaProductor.idTemporalARealEsteTurno };
        oportunidadesGobernadasEsteTurno = [...estadoInicialTareaProductor.oportunidadesGobernadasEsteTurno];
        oportunidadTipadaValidaEsteTurno = estadoInicialTareaProductor.oportunidadTipadaValidaEsteTurno;

      do {
        relacionVerificadaEsteIntento = false;
        candidateUnderreachPreGovernance = false;
        if (propuestaBaseReparacionSoporteDirigido) {
          intentosReparacionSoporteDirigido++;
          const base = propuestaBaseReparacionSoporteDirigido;
          const dimensionObjetivo = contratoRespuestaDirigidaEsteTurno.dimensionObjetivo;
          const unidadesEvidencia = construirUnidadesEvidenciaLiteral(mensajeUsuario);
          const conceptosBase = Array.isArray(base.parsed.conceptosNuevos)
            ? base.parsed.conceptosNuevos.filter(Boolean) : [];
          const idsConceptosBase = new Set(conceptosBase.map(c => c.idTemporal).filter(Boolean));
          const idsDurablesDisponibles = new Set(((grafoDelta || estadoActual.knowledgeGraph).conceptos || [])
            .map(c => c && c.id).filter(Boolean));
          const referenciasSoporteDeclaradas = [
            ...((base.parsed.relacionRespuestaDirigida
              && base.parsed.relacionRespuestaDirigida.conceptosQueAtienden) || []),
            ...((base.parsed.evaluacionGanancia
              && base.parsed.evaluacionGanancia.satisfaccionConocimiento
              && base.parsed.evaluacionGanancia.satisfaccionConocimiento.evidenciaConceptoIds) || []),
            ...((base.parsed.oportunidadesConversacionales || []).flatMap(o =>
              o && o.satisfaccionConocimiento && Array.isArray(o.satisfaccionConocimiento.evidenciaConceptoIds)
                ? o.satisfaccionConocimiento.evidenciaConceptoIds : [])),
          ];
          const idsTemporalesSoporteFaltantes = [...new Set(referenciasSoporteDeclaradas)]
            .filter(id => id && !idsConceptosBase.has(id) && !idsDurablesDisponibles.has(id));
          const repair = await llmServiceProductorActivo.call({
            system: `REPARACION_ESTRUCTURAL_RESPUESTA_DIRIGIDA ${JSON.stringify({
              relacionCongelada: base.parsed.relacionRespuestaDirigida.relacion,
              dimensionObjetivo,
            })}`,
            userMsg: JSON.stringify({ unidadesEvidencia }),
            label: `${gramaticaActivaAlInicio}_reparacion_soporte_dirigido`,
            callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA',
            responseMimeType: 'application/json',
            responseSchema: buildCapa1DirectedSupportRepairSchema(
              dimensionObjetivo, unidadesEvidencia.map(unidad => unidad.id),
              idsTemporalesSoporteFaltantes,
            ),
            turnoId: turnoIdReservadoEnAdmision,
          });
          const patch = repair && repair.parsed;
          const patchMaterializado = materializarSeleccionEvidenciaLiteral({
            selecciones: patch && patch.seleccionesEvidencia,
            unidadesDisponibles: unidadesEvidencia,
            dimensionObjetivo,
          });
          const idsPatch = new Set(patchMaterializado
            ? patchMaterializado.conceptosNuevos.map(c => c.idTemporal) : []);
          const patchAceptable = !!patchMaterializado
            && idsTemporalesSoporteFaltantes.every(id => idsPatch.has(id));
          r = patchAceptable
            ? {
                ...base,
                parsed: {
                  ...base.parsed,
                  conceptosNuevos: [
                    ...conceptosBase,
                    ...patchMaterializado.conceptosNuevos.filter(c => !idsConceptosBase.has(c.idTemporal)),
                  ],
                  relacionRespuestaDirigida: {
                    ...base.parsed.relacionRespuestaDirigida,
                    conceptosQueAtienden: patchMaterializado.conceptosQueAtienden,
                  },
                },
              }
            : base;
          if (patchAceptable) propuestaBaseReparacionSoporteDirigido = null;
        } else {
          intentosPropuestaCompleta++;
          const systemPrompt = correccionDeFormato
            ? buildGramaticaPromptV2({ ...promptBase, correccionDeFormato })
            : producerTask.contract.promptContract;
          r = await llmServiceProductorActivo.call({
            system: systemPrompt, userMsg: producerTask.contract.userMsg, label: gramaticaActivaAlInicio,
            callProfile: producerTask.contract.callProfile,
            responseMimeType: 'application/json',
            responseSchema: producerTask.contract.responseSchema,
            turnoId: turnoIdReservadoEnAdmision,
          });
        }
        if (!r.parsed) break; // fallo de transporte/parseo — no hay contrato que validar todavía
        // circulomejora006 (segunda auditoría, Sección 3 — corrección
        // temporal): el estampado de next_user_action.objetivo NUNCA ocurre
        // aquí, con dimensionObjetivoPreparado (A, pre-construcción) — ese
        // valor solo gobierna qué se le pidió evaluar a Capa 1 ANTES de esta
        // llamada (evaluacionInterpretacionRequerida/dimensionFocal), nunca
        // lo que debe preguntarse DESPUÉS de lo que Capa 1 acaba de aportar.
        // Estampar aquí dejaría el objetivo apuntando a una dimensión que
        // este mismo turno ya pudo haber quedado satisfecha (p. ej. Capa 1
        // cubre "conocimiento" y Movimiento ya avanza a "antes"). El
        // estampado real ocurre más abajo, con dimensionEnFocoNuevo — el
        // mismo valor post-construcción que ya gobierna el Realizador
        // (contratoMovimientoDestino) y la continuidad del turno siguiente
        // (protocoloDimensionEnFoco) — nunca un tercer criterio.
        validacionContrato = etiquetarValidacionContrato(validarContratoDeCamposDelProductor(r.parsed), 'REPRESENTACION');
        if (validacionContrato.valido) {
          const erroresFormaConceptos = validarFormaConceptosNuevos(r.parsed);
          if (erroresFormaConceptos.length > 0) {
            validacionContrato = etiquetarValidacionContrato({ valido: false, errores: erroresFormaConceptos }, 'REPRESENTACION');
          }
        }
        // PRODUCER_REFERENTIAL_INTEGRITY (C007 human canary v8) — a concept
        // ID an authoritative field cites (anclajeConceptoIds/evidenciaConceptoIds)
        // must resolve against a durable concept or this SAME output's own
        // conceptosNuevos before this representation is ever accepted.
        // "Durable" here is grafoDelta (falling back to the pre-turn graph
        // when no delta exists yet) — the SAME reading construirFronteraCognitivaAdmisible
        // and the rest of this loop already use, deliberately WIDER than
        // validarBusquedaActoCognitivo's own pre-turn-only reading just
        // below: CURRENT_TURN_GROUNDED_EVIDENCE legitimately lets THIS
        // turn's own reconciliación recover a concept (its own idTemporal,
        // materialized into grafoDelta before the producer loop even
        // starts) that the producer may then cite without redeclaring it —
        // Certification8's bootstrap path depends on exactly this.
        if (validacionContrato.valido) {
          const validacionReferencial = validarIntegridadReferencialRepresentacionProductor(r.parsed, {
            grafo: grafoDelta || estadoActual.knowledgeGraph,
            idTemporalAReal: idTemporalARealEsteTurno,
          });
          // DANGLING_UNKNOWN_REF_IS_OPTIONAL_FIELD -- parsedSaneado applies
          // regardless of validacionReferencial.valido (it only ever
          // strips the SAME dangling unknownId/semanticUnknownId this
          // check itself used to reject the whole representation for; any
          // OTHER, still-required reference failure -- concept evidence
          // ids -- keeps rejecting below, unchanged). Downstream logic
          // (busquedaActoCognitivo, GOBERNANZA, candidatosCompatiblesConFrontera)
          // must see the sanitized value, never the fabricated one.
          r = { ...r, parsed: validacionReferencial.parsedSaneado };
          if (!validacionReferencial.valido) {
            validacionContrato = etiquetarValidacionContrato({
              valido: false,
              errores: validacionReferencial.referenciasInvalidas,
              integridadReferencialFallida: true,
            }, 'REPRESENTACION');
            // CONTENT_CLOSURE_REPAIR capture -- every OTHER format/contract
            // check already passed at this point (we are inside `if
            // (validacionContrato.valido)`), so a dangling reference here
            // is, by construction, this attempt's ONLY defect. Freeze the
            // FIRST such attempt this turn that also carries genuine WHAT
            // content (a real oportunidad or gananciaCognitiva) -- never a
            // later one, matching EARLIEST_CAUSAL_DIVERGENCE; never
            // overwritten once captured, so a LATER, worse attempt (e.g. a
            // transport failure, or a genuine NINGUNO_LEGITIMO) can never
            // displace the one legitimate repair opportunity this turn had.
            const tieneQueProponer = r.parsed && (
              (Array.isArray(r.parsed.oportunidadesConversacionales) && r.parsed.oportunidadesConversacionales.length > 0)
              || (typeof r.parsed.gananciaCognitiva === 'string' && r.parsed.gananciaCognitiva.trim())
            );
            if (!mejorCandidatoColganteEsteTurno && tieneQueProponer) {
              mejorCandidatoColganteEsteTurno = {
                parsed: r.parsed,
                idsColgantes: extraerIdsColgantesDeReferenciasInvalidas(validacionReferencial.referenciasInvalidas),
              };
            }
          }
        }
        // At this point every provider adapter has already produced the same
        // normalized producer representation. Cognitive search validation is
        // common governance: executor identity may affect transport, never
        // whether the proposed cognitive act must satisfy this contract.
        if (validacionContrato.valido) {
          const validacionBusqueda = validarBusquedaActoCognitivo(r.parsed, {
            grafo: estadoActual.knowledgeGraph,
            gramatica: gramaticaActivaAlInicio,
            slots: estadoActual.slots || {},
            dimension: estadoActual.protocoloDimensionEnFoco || slotsFaltantesAntes[0] || null,
          });
          if (!validacionBusqueda.valido) {
            if (validacionBusqueda.recuperablePostGobernanza) {
              candidateUnderreachPreGovernance = true;
            } else {
              validacionContrato = etiquetarValidacionContrato({
                valido: false,
                errores: [`busquedaActoCognitivo: ${validacionBusqueda.razon}`],
              }, 'REPRESENTACION');
            }
          }
        }
        // La oportunidad es propuesta por Capa 1 y validada/seleccionada por
        // ObjetivoConversacionalPolicy. En modo tipado, su ausencia es una
        // salida incompleta, no una ocasión para ejecutar REFLEJAR legacy.
        const direccionTipadaActiva = this._movimientoConversacionalEnabled
          && gramaticaActivaAlInicio !== 'destino'
          && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio);
        oportunidadTipadaValidaEsteTurno = false;
        if (direccionTipadaActiva
          && estadoPermiteDireccionConversacional(protocoloEstadoEfectivo)
          && validacionContrato.valido) {
          const conceptosComprension = ((grafoDelta || estadoActual.knowledgeGraph).conceptos || [])
            .filter(c => c && c.activo !== false && c.autoridad === 'experto');
          comprensionTrabajoEsteTurno = proyectarComprensionTrabajo({
            userKnowledge: conceptosComprension.map(c => c.descripcion),
            authorizedInterpretation: conceptosComprension.filter(c => c.tipo === 'sintesis_interpretativa').map(c => c.descripcion),
            domainScaffold: Array.isArray(r.parsed.domainScaffold) ? r.parsed.domainScaffold : [],
            recentFocus: r.parsed.mensaje || null,
          });
          focoConversacionalActual = seleccionarFocoConversacional({
            comprension: comprensionTrabajoEsteTurno,
            materialReciente: [r.parsed.mensaje].filter(Boolean),
            evidenciaObtenida: comprensionTrabajoEsteTurno.userKnowledge,
          });
          objetivoConversacionalEsteTurno = decidirObjetivoConversacional({
            grafo: estadoActual.knowledgeGraph,
            gramatica: gramaticaActivaAlInicio,
            slots: estadoActual.slots || {},
            oportunidadesConversacionales: r.parsed.oportunidadesConversacionales,
            comprensionTrabajo: comprensionTrabajoEsteTurno,
            focoConversacionalActual,
          });
          // Governance owns SemanticUnknown creation: Capa 1 may propose a
          // semantic target, but only the selected opportunity is allowed to
          // materialize it in the common KnowledgeGraph before Movement.
          const oportunidadSemantic = objetivoConversacionalEsteTurno
            && objetivoConversacionalEsteTurno.oportunidadSeleccionada;
          if (oportunidadSemantic && !oportunidadSemantic.unknownId
            && oportunidadSemantic.semanticTarget && oportunidadSemantic.referenteSemantico) {
            // ACTIVE_TARGET_REUSE (C007,
            // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION).
            // Reuse an already-active same-mission obligation for this
            // required territory rather than minting a duplicate. A
            // genuinely resolved prior target (or an un-promoted transient)
            // does not satisfy esObligacionActivaParaMision, so a legitimate
            // fresh acquisition is never suppressed while the dimension
            // stays authoritatively pending. Relevance/lifecycle of a
            // newly-minted candidate is unchanged from before this cluster.
            const dimensionSemanticCandidata = oportunidadSemantic.dimension || null;
            const obligacionReutilizableSemantic = encontrarObligacionActivaReutilizable(
              grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio, dimensionSemanticCandidata);
            const candidate = obligacionReutilizableSemantic ? null : crearSemanticUnknownCandidate({
              mission: gramaticaActivaAlInicio,
              dimension: dimensionSemanticCandidata,
              respondent: oportunidadSemantic.sujetoObjetivo || null,
              referenteSemantico: oportunidadSemantic.referenteSemantico,
              proposicion: oportunidadSemantic.semanticTarget,
              operation: oportunidadSemantic.operacion,
              procedencia: { turnoId: turnoIdReservadoEnAdmision, decision: 'OBJETIVO_CONVERSACIONAL' },
              sobreConceptos: oportunidadSemantic.anclajeConceptoIds || [],
            });
            const materializado = obligacionReutilizableSemantic
              ? { grafo: grafoDelta || estadoActual.knowledgeGraph, unknown: obligacionReutilizableSemantic, error: null }
              : materializarSemanticUnknown(grafoDelta || estadoActual.knowledgeGraph, candidate);
            if (materializado.unknown) {
              grafoDelta = materializado.grafo;
              semanticUnknownIdEsteTurno = materializado.unknown.id;
              objetivoConversacionalEsteTurno = {
                ...objetivoConversacionalEsteTurno,
                semanticUnknownId: materializado.unknown.id,
                oportunidadSeleccionada: {
                  ...oportunidadSemantic,
                  unknownId: materializado.unknown.id,
                  semanticUnknown: materializado.unknown,
                },
              };
            }
          }
          oportunidadTipadaValidaEsteTurno = !!(objetivoConversacionalEsteTurno
            && objetivoConversacionalEsteTurno.oportunidadSeleccionada);
          if (!candidateUnderreachPreGovernance && !oportunidadTipadaValidaEsteTurno && direccionTieneNecesidadPendiente({ gramatica: gramaticaActivaAlInicio, slots: estadoActual.slots || {} })) {
            const operacionesSoportadas = (getGrammarMissionDescriptor(gramaticaActivaAlInicio)
              && getGrammarMissionDescriptor(gramaticaActivaAlInicio).direccionConversacional
              && getGrammarMissionDescriptor(gramaticaActivaAlInicio).direccionConversacional.operacionesSoportadas) || [];
            const propuesta = r.parsed && Array.isArray(r.parsed.oportunidadesConversacionales)
              ? r.parsed.oportunidadesConversacionales[0] : null;
            const diagnostico = propuesta && propuesta.operacion
              ? diagnosticarOportunidadConversacional(estadoActual.knowledgeGraph, propuesta, propuesta.operacion, operacionesSoportadas)
              : null;
            validacionContrato = etiquetarValidacionContrato({
              valido: false,
              errores: [
                'oportunidadesConversacionales: dirección tipada activa requiere al menos una oportunidad válida con anclaje autorizado y operación soportada',
                ...(diagnostico ? [`anchor_no_elegible:${JSON.stringify(diagnostico)}`] : []),
              ],
            }, 'REPRESENTACION');
          }
        }
        // circulomejora006 — reinicio por intento (nunca acumula entre
        // reintentos, igual que contratoDeCamposValidado/evaluacionGrafo).
        observacionNaturalezaValor = null;
        observacionNaturalezaGobernada = null;
        observacionNaturalezaDegradada = false;
        senalesCierreAceptadas = [];
        senalesCierreDescartadas = [];
        // T-DIM2 — reinicio por intento, mismo patrón que arriba: nunca
        // acumula entre reintentos.
        relacionRespuestaDirigidaTraza = null;
        alineacionRespuestaDirigidaResultadoTraza = null;
        // Chequeo de FORMATO (no de fidelidad): ausente o con un valor
        // fuera de las 3 categorías activa el reintento normal de
        // contrato, igual que cualquier otro campo mal formado — nunca se
        // infiere ni se rellena. La verificación de FIDELIDAD
        // (naturalezaEpistemicaGobernada, degradación silenciosa) ocurre
        // acá mismo, únicamente cuando este chequeo de formato ya pasó.
        if (promptBase.movimientoConversacionalDestinoActivo && validacionContrato.valido) {
          const naturalezaDeclarada = r.parsed.observacionNaturaleza;
          if (!['observacion_directa', 'interpretacion', 'inferencia'].includes(naturalezaDeclarada)) {
            validacionContrato = etiquetarValidacionContrato({
              valido: false,
              errores: ['observacionNaturaleza ausente o inválida — debe ser "observacion_directa", "interpretacion" o "inferencia"'],
            }, 'REPRESENTACION');
          } else {
            observacionNaturalezaValor = naturalezaDeclarada;
            // Corrección posterior a la auditoría de a22d081: colección de
            // descripciones INDIVIDUALES — nunca concatenadas — para que
            // naturalezaEpistemicaGobernada verifique cada una por
            // separado (nunca una evidencia sintética entre conceptos
            // distintos). conceptosDeGramatica ya filtra `activo` (excluye
            // rechazados/obsoletos/inactivos); el filtro de autoridad
            // excluye "inferido"; usar estadoActual.knowledgeGraph (foto
            // post-reconciliación, pre-construcción) excluye por
            // construcción cualquier concepto propuesto en ESTE turno.
            const descripcionesExpertoPrevias = conceptosDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
              .filter(c => c.autoridad === 'experto').map(c => c.descripcion);
            const gobernada = naturalezaEpistemicaGobernada(
              naturalezaDeclarada, r.parsed.observacion, mensajeUsuario, descripcionesExpertoPrevias,
            );
            observacionNaturalezaGobernada = gobernada.naturaleza;
            observacionNaturalezaDegradada = gobernada.degradada;
          }
        }
        // P1-A (circulomejora006 — autoridad de cierre conversacional,
        // primer incremento) — Ley de Degradación aplicada a este bloque,
        // nunca de rechazo: un ítem inválido (tipo fuera de catálogo,
        // evidencia no literal) se descarta CON causa, sin invalidar
        // validacionContrato ni forzar un reintento completo de Capa 1 —
        // preserva las garantías de P0-B (nunca gasta el presupuesto de
        // reintentos del contrato por un campo puramente observacional).
        // Deliberadamente independiente del bloque de observacionNaturaleza
        // de arriba (contratos distintos, nunca fusionados — ver
        // SenalCierreConversacionalPolicy).
        // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — gate independiente
        // (senalCierreConversacionalActiva), no movimientoConversacionalDestinoActivo:
        // esta clasificación solo depende de que Capa 1 haya recibido el
        // campo "observacionesConversacionales" este turno (ver promptBase,
        // arriba), nunca de si Movimiento en sí está activo.
        if (promptBase.senalCierreConversacionalActiva && validacionContrato.valido) {
          const clasificacion = clasificarSenalesCierreConversacional(
            r.parsed.observacionesConversacionales, mensajeUsuario,
          );
          senalesCierreAceptadas = clasificacion.aceptadas;
          senalesCierreDescartadas = clasificacion.descartadas;
        }
        contratoDeCamposValidado = validacionContrato.valido;
        evaluacionGrafo = EVALUACION_GRAFO.NO_APLICA;
        if (validacionContrato.valido && grafoActivo) {
          // Ciclo Cognitivo de Descubrimiento (ADR §2 + gobernanza de
          // autoridad) — aplicarDelta corre PRIMERO: ahí es donde cualquier
          // "experto" sin cita verificable ya queda degradado a "inferido"
          // (GrafoConocimientoPolicy.autoridadGobernada) — nunca se confía
          // en que el generador haya elegido bien. La elegibilidad se
          // revisa DESPUÉS, por diferencia de ids contra el grafo de antes,
          // sobre el resultado YA CORREGIDO — así ningún "experto"
          // degradado a último momento se salta el gate por haber llegado
          // como degradación en vez de como "inferido" declarado
          // directamente.
          //
          // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — GOBERNANZA_DELTA_DIMENSIONAL
          // corre AQUÍ, antes que aplicarDelta: mismo principio que
          // autoridadGobernada (dentro de aplicarDelta) para "autoridad",
          // ahora aplicado a "a qué dimensión pertenece" -- nunca se confía
          // en que el generador haya clasificado bien. dimensionObjetivoDeContratoTemprano
          // es el MISMO valor (protocoloDimensionEnFoco) que gobierna el
          // gate T-DIM2/porQueNoCapturaDimensionObjetivo más abajo -- una
          // sola fuente, calculada una vez, nunca dos definiciones que
          // puedan divergir.
          const missionAdapterParaAdjudicacion = getGrammarMissionAdapter(gramaticaActivaAlInicio);
          const objetivoMisionSolicitado = missionAdapterParaAdjudicacion
            && r.parsed && r.parsed.next_user_action
            && missionAdapterParaAdjudicacion.dimensions.includes(r.parsed.next_user_action.objetivo)
            ? r.parsed.next_user_action.objetivo : null;
          const dimensionObjetivoDeContratoTemprano = gramaticaActivaAlInicio === 'destino'
            ? (estadoActual.protocoloDimensionEnFoco || null)
            : objetivoMisionSolicitado;
          // The dimension the previous PRESENTED intervention asked about
          // (response-attribution context) is what concept governance must
          // adjudicate against. The Producer's own next_user_action.objetivo
          // is the dimension of ITS NEXT question, not of the response being
          // captured, and typed mode does not emit it at all (=> always null
          // => SIN_OBJETIVO_VIGENTE, no adjudication). It remains the
          // fallback when there is no prior context. The T-DIM2 gate below
          // keeps reading dimensionObjetivoDeContratoTemprano unchanged: it
          // would push the Producer to relabel instead of letting governance
          // decide, and belongs to DESTINO's directed-response lifecycle.
          const objetivoSolicitadoParaGobernanza = (gramaticaActivaAlInicio !== 'destino' && contextoAtribucionRespuestaPrevio)
            ? contextoAtribucionRespuestaPrevio.dimension
            : dimensionObjetivoDeContratoTemprano;
          if (Array.isArray(r.parsed.conceptosNuevos) && r.parsed.conceptosNuevos.length > 0) {
            const { conceptosGobernados, traza } = await gobernarDimensionDeltaConceptos({
              conceptosPropuestos: r.parsed.conceptosNuevos,
              objetivoSolicitado: objetivoSolicitadoParaGobernanza,
              relacionRespuestaDirigidaDeclarada: contratoRespuestaDirigidaEsteTurno ? (r.parsed.relacionRespuestaDirigida || null) : null,
              mensajeUsuario, dimensionesLegales: dimensionesLegalesDeGramatica(gramaticaActivaAlInicio),
              llmService: llmServiceProductorActivo, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
            });
            r.parsed.conceptosNuevos = conceptosGobernados;
            gobernanzaDimensionTrazaEsteTurno = traza;
          }
          let { grafoNuevo, errores, idTemporalAReal } = aplicarDelta(estadoActual.knowledgeGraph, deltaAditivoDesdeParsed(r.parsed), { mensajeUsuario, turnoOrigenId: turnoClienteId, actoCognitivoVisible: null, relacionRespuestaDirigida: null });
          if (idTemporalAReal) {
            idTemporalARealEsteTurno = proyectarIdentidadesAdjudicadas(
              { ...idTemporalARealEsteTurno, ...idTemporalAReal },
              gobernanzaDimensionTrazaEsteTurno,
            );
            canonicalizarSoporteGanancia(r.parsed, idTemporalARealEsteTurno);
          }
          if (!grafoNuevo) {
            validacionContrato = etiquetarValidacionContrato({ valido: false, errores }, 'GOBERNANZA');
            evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
          } else {
            // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
            // AMBITO_DE_CIERRE_GOBIERNA_PRODUCTORES_PERO_NO_LA_FRONTERA_COMUN_DE_MUTACION)
            // — misma política compartida que Reconciliación Histórica usa
            // más arriba (ver validarMutacionesDestructivasBajoCierre) —
            // nunca un gate divergente por mecanismo. El hallazgo real:
            // Capa 1 obsoletó "antes" como efecto incidental de resolver
            // "evidencia", sin que el experto lo hubiera corregido — abrió
            // una deuda nueva fuera del snapshot con el presupuesto de
            // pregunta final ya consumido.
            const esUltimoIntentoContratoParaMutacionLateral = intentosContrato >= MAX_CONTRATO_RETRIES;
            const {
              noAutorizadas: mutacionesLateralesNoAutorizadas,
              autoridadesNuevas: autoridadesNuevasConstruccion,
            } = await validarMutacionesDestructivasBajoCierre({
              ambitoMutacionCierre: ambitoMutacionCierreEsteTurno,
              grafoActual: estadoActual.knowledgeGraph,
              mensajeUsuario,
              mutacionesPropuestas: r.parsed.marcarObsoletos,
              origen: 'CONSTRUCCION', tipoImpactoPropuesto: 'DECLARA_NO_VIGENTE',
              llmService: llmServiceProductorActivo, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
              autoridadesPrevias: autoridadesPreviasMutacion, cacheValidacionesEsteTurno: cacheValidacionesMutacionEsteTurno,
            });
            autoridadesMutacionNuevasEsteTurno = autoridadesMutacionNuevasEsteTurno.concat(autoridadesNuevasConstruccion);
            // Escribe bajo su propia clave -- refleja el último intento de
            // ESTE productor (incluida su corrección tras un retry, que
            // limpia su propia entrada previa), sin borrar lo que
            // Reconciliación Histórica ya haya dejado este mismo turno.
            mutacionesLateralesRechazadasPorOrigen.CONSTRUCCION_MARCAR_OBSOLETOS = mutacionesLateralesNoAutorizadas.map(item => ({
              ...item, causa: item.codigoRazon || 'MUTACION_NO_VALIDADA_SEMANTICAMENTE', turnoClienteId,
            }));
            mutacionesLateralesRechazadasTraza = Object.values(mutacionesLateralesRechazadasPorOrigen).flat();
            if (mutacionesLateralesNoAutorizadas.length > 0 && !esUltimoIntentoContratoParaMutacionLateral) {
              // Retry focal -- señala EXACTAMENTE la mutación no autorizada,
              // nunca un rechazo genérico del turno completo.
              validacionContrato = etiquetarValidacionContrato({
                valido: false,
                errores: mutacionesLateralesNoAutorizadas.map(mensajeErrorMutacionLateralNoAutorizada),
              }, 'GOBERNANZA');
              evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
            } else {
              if (mutacionesLateralesNoAutorizadas.length > 0) {
                // Presupuesto de reintentos agotado -- falla cerrado SOLO
                // sobre esas mutaciones puntuales, nunca sobre el turno
                // completo (requisito 5): reconstruye el grafo con el MISMO
                // delta, MENOS las obsolescencias no autorizadas -- conserva
                // toda aportación válida (incluido lo que resuelve las
                // deudas del propio snapshot en este mismo turno).
                const idsNoAutorizados = new Set(mutacionesLateralesNoAutorizadas.map(item => item.id));
                const parsedCorregido = {
                  ...r.parsed,
                  marcarObsoletos: (r.parsed.marcarObsoletos || []).filter(item => !idsNoAutorizados.has(item.id)),
                };
                const reconstruido = aplicarDelta(estadoActual.knowledgeGraph, deltaAditivoDesdeParsed(parsedCorregido), {
                  mensajeUsuario,
                  turnoOrigenId: turnoClienteId,
                  actoCognitivoVisible: null,
                  relacionRespuestaDirigida: null,
                });
                grafoNuevo = reconstruido.grafoNuevo;
                errores = reconstruido.errores;
                idTemporalAReal = reconstruido.idTemporalAReal;
              }
              // La validación semántica solo produce autoridad; el efecto
              // destructivo debe atravesar igualmente la infraestructura
              // canónica del grafo.  El delta aditivo anterior excluye
              // deliberadamente `marcarObsoletos`, por lo que aplicamos aquí
              // únicamente las mutaciones autorizadas (después de retirar
              // las rechazadas).  Así autoridad y estado efectivo siguen la
              // misma transacción, sin una ruta especial de cierre.
              const idsNoAutorizados = new Set(mutacionesLateralesNoAutorizadas.map(item => item.id));
              const mutacionesAutorizadas = (r.parsed.marcarObsoletos || [])
                .filter(item => item && !idsNoAutorizados.has(item.id));
              // Una incertidumbre relevante abierta por la reconciliación
              // sobre el mismo concepto mantiene su vigencia en disputa:
              // una petición destructiva del extractor no puede ganar por
              // orden de fases antes de que esa disputa sea adjudicada.
              const idsEnIncertidumbreRelevante = new Set((grafoNuevo.incertidumbres || [])
                .filter(u => u && u.relevante !== false && Array.isArray(u.sobreConceptos))
                .flatMap(u => u.sobreConceptos));
              const mutacionesAplicables = mutacionesAutorizadas
                .filter(item => !idsEnIncertidumbreRelevante.has(item.id));
              mutacionesAutorizadasConstruccionEsteTurno = mutacionesAplicables;
            // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — la traza de
            // gobernanza se construyó ANTES de aplicarDelta (solo conoce
            // idTemporal); ahora que idTemporalAReal ya está en su forma
            // FINAL para este intento, la enlazamos al id REAL y durable —
            // sin esto, un concepto NO_RESUELTA sería auditable solo
            // durante el turno (el evento solo tendría idTemporal, que no
            // sobrevive) y opaco tras un restart.
            if (gobernanzaDimensionTrazaEsteTurno.length > 0 && idTemporalAReal) {
              gobernanzaDimensionTrazaEsteTurno = gobernanzaDimensionTrazaEsteTurno.map(t => ({
                // aplicarDelta devuelve idTemporalAReal como OBJETO plano
                // (Object.fromEntries), nunca un Map -- acceso por
                // propiedad, no .has()/.get().
                ...t, conceptoId: Object.prototype.hasOwnProperty.call(idTemporalAReal, t.conceptoIdTemporal)
                  ? idTemporalAReal[t.conceptoIdTemporal] : null,
              }));
            }
            const idsAntes = new Set(estadoActual.knowledgeGraph.conceptos.map(c => c.id));
            // DEPENDENCY_SCOPED_SEMANTIC_GOVERNANCE (C007 Machine Product
            // Acceptance, Human Canary A structural-rebind closure) --
            // PRODUCER BATCH MEMBERSHIP != SHARED COGNITIVE FATE. Each
            // proposed concept is adjudicated for authority (autoridadGobernada,
            // untouched -- extractive-literalness stays the certified
            // epistemic contract, ver GrafoConocimientoPolicy.js:76-100) and
            // eligibility (elegibleParaAbstraer, untouched) INDEPENDENTLY.
            // Before this correction, ANY sibling concept in the SAME batch
            // failing eligibility rejected the ENTIRE delta wholesale --
            // discarding an unrelated, already-verified "experto" concept
            // (and whatever opportunity/gain legitimately depended on it)
            // for a stranger's failure it never depended on. The ONLY
            // change: an ineligible concept is now excluded from THIS
            // delta (never committed, never durable, never authority) while
            // whatever survives independently reconstructs via the SAME
            // aplicarDelta call every other partial-exclusion path in this
            // function already uses (see mutacionesLateralesNoAutorizadas'
            // reconstruction below -- identical pattern, not a new one).
            // A relation/opportunity/gain that actually depends on the
            // excluded concept still fails downstream, unchanged: its
            // dropped concept never resolves in grafoDelta/idTemporalAReal,
            // so PRODUCER_REFERENTIAL_INTEGRITY and candidatosCompatiblesConFrontera
            // (both untouched) reject it exactly as a dangling reference,
            // never granting it ghost authority.
            const idsIneligiblesEsteIntento = new Set(grafoNuevo.conceptos
              .filter(c => !idsAntes.has(c.id) && c.autoridad === 'inferido')
              .filter(c => {
                const dim = dimensionDeProcedencia(c.procedencia);
                return dim && !elegibleParaAbstraer(estadoActual.knowledgeGraph, dim);
              })
              .map(c => c.id));
            const violacionesElegibilidad = idsIneligiblesEsteIntento.size > 0
              ? grafoNuevo.conceptos
                .filter(c => idsIneligiblesEsteIntento.has(c.id))
                .map(c => dimensionDeProcedencia(c.procedencia))
              : [];
            if (idsIneligiblesEsteIntento.size > 0) {
              const idsTemporalesIneligibles = new Set(
                Object.entries(idTemporalAReal || {})
                  .filter(([, real]) => idsIneligiblesEsteIntento.has(real))
                  .map(([temporal]) => temporal),
              );
              // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- snapshot the
              // excluded concept OBJECTS (with their idTemporal->id mapping
              // AS OF THIS aplicarDelta call, before reconstruction below
              // drops it) purely so construirFronteraCognitivaAdmisible can
              // offer them as non-durable, turn-scoped open-hypothesis
              // material. Never written to estadoActual.knowledgeGraph,
              // never merged into idTemporalARealEsteTurno (the shared,
              // widely-read mapping other consumers -- referential
              // integrity, durable projections -- treat as authoritative).
              //
              // UNSUPPORTED_CONTENT_MUST_NOT_BE_RESCUED (C007 Machine
              // Product Acceptance, found via CASE B regression --
              // test_c007_dependency_scoped_semantic_governance_1.js).
              // `autoridad === 'inferido'` alone does NOT distinguish a
              // genuinely user-grounded interpretation from fabricated
              // content: autoridadGobernada (GrafoConocimientoPolicy.js)
              // downgrades ANY 'experto'-declared concept that fails its
              // literal-substring check (contenidoEsExtractivo) to
              // 'inferido' with autoridadDegradada:true -- a producer
              // claiming "the expert said X" about something the expert
              // never said gets the EXACT SAME autoridad:'inferido' shape
              // as an honest, self-aware interpretation. The real
              // distinguishing signal is autoridadDegradada itself: a
              // concept the producer honestly declared 'inferido' from the
              // start never carries it (autoridadGobernada's own early
              // return: `autoridadDeclarada !== 'experto' -> degradada:
              // false`) -- only a FAILED, downgraded 'experto' CLAIM does.
              // Only the former is eligible hypothesis material; a
              // downgraded false-authority claim gets zero rescue, exactly
              // like any other unsupported content.
              conceptosHipotesisAbiertaEsteTurno = conceptosHipotesisAbiertaEsteTurno.concat(
                grafoNuevo.conceptos
                  .filter(c => idsIneligiblesEsteIntento.has(c.id) && c.autoridadDegradada !== true)
                  .map(c => ({
                    ...c,
                    idTemporal: Object.entries(idTemporalAReal || {}).find(([, real]) => real === c.id)?.[0] || null,
                  }))
                  .filter(c => c.idTemporal),
              );
              const conceptosNuevosSinIneligibles = (r.parsed.conceptosNuevos || [])
                .filter(c => !(c && idsTemporalesIneligibles.has(c.idTemporal)));
              const reconstruidoElegibilidad = aplicarDelta(
                estadoActual.knowledgeGraph,
                deltaAditivoDesdeParsed({ ...r.parsed, conceptosNuevos: conceptosNuevosSinIneligibles }),
                { mensajeUsuario, turnoOrigenId: turnoClienteId, actoCognitivoVisible: null, relacionRespuestaDirigida: null },
              );
              grafoNuevo = reconstruidoElegibilidad.grafoNuevo;
              errores = reconstruidoElegibilidad.errores;
              idTemporalAReal = reconstruidoElegibilidad.idTemporalAReal;
              if (idTemporalAReal) {
                idTemporalARealEsteTurno = proyectarIdentidadesAdjudicadas(
                  { ...idTemporalARealEsteTurno, ...idTemporalAReal },
                  gobernanzaDimensionTrazaEsteTurno,
                );
                canonicalizarSoporteGanancia(r.parsed, idTemporalARealEsteTurno);
              }
            }
            if (!grafoNuevo) {
              validacionContrato = etiquetarValidacionContrato({
                valido: false,
                errores: errores && errores.length > 0 ? errores : [...new Set(violacionesElegibilidad)].map(dim =>
                  `conceptosNuevos: la dimensión '${dim}' todavía no tiene evidencia suficiente de autoridad "experto" para proponer un concepto "inferido" — refleja o conecta solo lo ya dicho, o pide el elemento concreto que falta, sin nombrar ni generalizar todavía`
                ),
              }, 'GOBERNANZA');
              evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
            } else {
              // circulomejora006 (corrección final — atribución
              // multidimensional): la dimensión que gobernó el contrato de
              // ESTE turno es protocoloDimensionEnFoco tal como entró
              // (continuidad/foco ya persistido — la misma ancla que rige
              // continuidad de Movimiento), nunca la dimensionObjetivo
              // recalculada después de este mismo delta (sería circular).
              // Reutilizada, sin cambios, por evaluacionInterpretacion más
              // abajo. DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — MISMA
              // variable que ya gobernó GOBERNANZA_DELTA_DIMENSIONAL arriba
              // (dimensionObjetivoDeContratoTemprano), nunca una segunda
              // definición que pueda divergir.
              const dimensionObjetivoDeContrato = dimensionObjetivoDeContratoTemprano;
              const conceptosNuevosEsteTurno = grafoNuevo.conceptos.filter(c => !idsAntes.has(c.id));
              const esUltimoIntentoContrato = intentosContrato >= MAX_CONTRATO_RETRIES;
              // T-DIM2 (circulomejora006 — contrato causal de respuesta a
              // intervención dirigida) — T-DIM0 encontró la causa raíz de
              // la atribución dimensional incorrecta real (a4r_rechazo,
              // turnos 9 y 10): el gate anterior (atiendeDimensionObjetivo/
              // porQueNoCapturaDimensionObjetivo) solo verificaba AUSENCIA,
              // y en el último intento aceptaba la atribución incorrecta en
              // silencio (atribucionSinJustificar:true, fail-open). Con
              // contratoRespuestaDirigidaEsteTurno presente, ese gate queda
              // reemplazado por ContratoRespuestaDirigidaPolicy: Capa 1
              // debe declarar explícitamente la relación con su propia
              // pregunta anterior, y esa declaración se valida contra sus
              // propios conceptosNuevos — nunca se acepta como afirmación
              // decorativa, y NUNCA se exime en el último intento (a
              // diferencia del gate viejo): si sigue inconsistente,
              // contratoDeCamposValidado queda false y el turno cae en la
              // degradación Determinista ya probada (P0-B, "mensaje visible
              // seguro"), nunca en un fail-open nuevo. Sin
              // contratoRespuestaDirigidaEsteTurno (turno sin intervención
              // dirigida vigente — p.ej. primer turno de DESTINO), el gate
              // viejo se conserva sin cambios, byte a byte.
              let relacionRespuestaDirigidaValidacion = { valido: true, motivo: null };
              if (contratoRespuestaDirigidaEsteTurno) {
                const incertidumbreObjetivoResuelta = contratoRespuestaDirigidaEsteTurno.deudaTipo === 'INCERTIDUMBRE_RELEVANTE_ABIERTA'
                  && Array.isArray(grafoNuevo.incertidumbres)
                  && grafoNuevo.incertidumbres.some(u => u.id === contratoRespuestaDirigidaEsteTurno.deudaIdentidad && u.resuelta === true);
                relacionVerificadaEsteIntento = true;
                relacionRespuestaDirigidaValidacion = validarRelacionRespuestaDirigida({
                  relacionDeclarada: r.parsed.relacionRespuestaDirigida,
                  mensajeUsuario,
                  contrato: contratoRespuestaDirigidaEsteTurno,
                  conceptosNuevosEsteTurno: conceptosNuevosEsteTurno.map(concepto => {
                    const idTemporal = Object.entries(idTemporalAReal || {})
                      .find(([, idReal]) => idReal === concepto.id);
                    return idTemporal ? { ...concepto, idTemporal: idTemporal[0] } : concepto;
                  }),
                  dimensionDeProcedencia,
                  incertidumbreObjetivoResuelta,
                });
                if (relacionRespuestaDirigidaValidacion.valido && contratoRespuestaDirigidaEsteTurno.viaAcceso) {
                  const resultadoVia = r.parsed.resultadoViaAcceso;
                  const viaValida = resultadoVia
                    && resultadoVia.viaAcceso === contratoRespuestaDirigidaEsteTurno.viaAcceso
                    && ['DISPONIBLE', 'NO_DISPONIBLE', 'NO_APLICA'].includes(resultadoVia.estado);
                  if (!viaValida) {
                    relacionRespuestaDirigidaValidacion = {
                      valido: false,
                      motivo: 'resultadoViaAcceso ausente o inválido para la vía contratada',
                    };
                  }
                }
              }
              relacionRespuestaDirigidaTraza = contratoRespuestaDirigidaEsteTurno
                ? (r.parsed.relacionRespuestaDirigida
                  ? {
                      ...r.parsed.relacionRespuestaDirigida,
                      // La relación interpretada por Capa 1 queda ligada al
                      // unknown que el contrato anterior congeló. Nunca se
                      // acepta que la capa lingüística fabrique otro WHAT.
                      unknownId: contratoRespuestaDirigidaEsteTurno.unknownId || null,
                      desconocidoPreguntableScoped: contratoRespuestaDirigidaEsteTurno.desconocidoPreguntableScoped || null,
                      resultadoViaAcceso: r.parsed.resultadoViaAcceso || null,
                    }
                  : null) : null;
              alineacionRespuestaDirigidaResultadoTraza = proyectarAlineacionRespuestaDirigida({
                contrato: contratoRespuestaDirigidaEsteTurno,
                relacionDeclarada: r.parsed.relacionRespuestaDirigida
                  ? {
                      ...r.parsed.relacionRespuestaDirigida,
                      // El evaluador conoce ids temporales de conceptos de
                      // este output. Resolverlos aquí, después de la
                      // canonicalización del delta, evita que el productor
                      // prediga ids durables futuros y deja al Certificador
                      // validar únicamente material canónico real.
                      satisfaccionReparacion: r.parsed.relacionRespuestaDirigida.satisfaccionReparacion
                        ? {
                            ...r.parsed.relacionRespuestaDirigida.satisfaccionReparacion,
                            materialIds: (r.parsed.relacionRespuestaDirigida.satisfaccionReparacion.materialIds || [])
                              .map(id => (idTemporalAReal && Object.prototype.hasOwnProperty.call(idTemporalAReal, id))
                                ? idTemporalAReal[id] : null),
                          }
                        : null,
                    }
                  : null,
                validacion: relacionRespuestaDirigidaValidacion,
              });
              const atiendeDimensionObjetivo = !dimensionObjetivoDeContrato || conceptosNuevosEsteTurno.length === 0
                || conceptosNuevosEsteTurno.some(c => dimensionDeProcedencia(c.procedencia) === dimensionObjetivoDeContrato);
              const justificacionAtribucion = typeof r.parsed.porQueNoCapturaDimensionObjetivo === 'string'
                ? r.parsed.porQueNoCapturaDimensionObjetivo.trim() : '';
              const gateAtribucionInvalido = contratoRespuestaDirigidaEsteTurno
                ? !relacionRespuestaDirigidaValidacion.valido
                : (!atiendeDimensionObjetivo && !justificacionAtribucion && !esUltimoIntentoContrato);
              if (gateAtribucionInvalido) {
                // Señal estructural, del propio contrato ya en curso — nunca
                // una llamada ni un clasificador nuevo: mismo reintento de
                // formato que ya gobierna cualquier otra violación de este
                // bucle.
                validacionContrato = etiquetarValidacionContrato({
                  valido: false,
                  errores: [contratoRespuestaDirigidaEsteTurno
                    ? (relacionRespuestaDirigidaValidacion.motivo || 'relacionRespuestaDirigida inválida')
                    : `conceptosNuevos: ninguno pertenece a la dimensión '${dimensionObjetivoDeContrato}' que gobernó este contrato de EXPLORANDO — agrega "porQueNoCapturaDimensionObjetivo" explicando por qué, o atribuye al menos un concepto nuevo a esa dimensión`],
                  diagnostico: contratoRespuestaDirigidaEsteTurno
                    ? (relacionRespuestaDirigidaValidacion.diagnostico || null)
                    : null,
                }, 'REPRESENTACION');
                evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
              } else {
                // circulomejora006 (evaluacionInterpretacion) — mismo
                // mecanismo estructural de reintento que atribución
                // (arriba), evaluado DESPUÉS de que atribución ya aprobó (o
                // exentó) este intento: dos violaciones simultáneas
                // comparten el mismo ciclo de reintento, ninguna enmascara
                // a la otra. Exclusivo de promptBase.evaluacionInterpretacionRequerida
                // (calculado UNA sola vez, antes del bucle, sobre
                // estadoActual.knowledgeGraph/dimensionFocal — nunca
                // recalculado aquí). Cuando el flag está apagado,
                // evaluacionInterpretacionValida permanece true por
                // default y este bloque no cambia nada del comportamiento
                // ya existente.
                let evaluacionInterpretacionValida = true;
                let erroresEvaluacionInterpretacion = [];
                let resultadoEsteIntento = null;
                let conceptoIdEsteIntento = null;
                let razonEsteIntento = null;
                // circulomejora006 (evaluacionInterpretacion, Commit 2) —
                // disambiguación de motivo, exigida por la Especificación:
                // 'identidad' (PROPUESTA con conceptoId inválido, tras
                // agotar reintentos) sigue usando el código EXISTENTE
                // INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA (más abajo, en
                // la rama TRANSFORMAR — es, literalmente, la misma falla de
                // identidad que ese código ya nombra). 'contrato' (resultado
                // ausente/inválido, o NO_PROPUESTA con razon inválida) es
                // el caso NUEVO — Capa 1 nunca llegó a producir una
                // evaluación válida en absoluto, nunca un problema de
                // identidad de materialización.
                let motivoInvalidezEsteIntento = null;
                if (promptBase.evaluacionInterpretacionRequerida) {
                  const evalInterp = r.parsed.evaluacionInterpretacion;
                  const resultadoDeclarado = (evalInterp && typeof evalInterp === 'object') ? evalInterp.resultado : null;
                  if (resultadoDeclarado === 'PROPUESTA') {
                    // Identidad EXACTA (Especificación — "no permitas que el
                    // writer seleccione automáticamente 'cualquier inferido'
                    // de la dimensión"): conceptoId debe resolver, vía
                    // idTemporalAReal, a uno de los conceptos NUEVOS de
                    // ESTE turno — nunca uno preexistente, de otra
                    // dimensión, o sin autoridad/origen de abstracción.
                    const idRef = evalInterp.conceptoId;
                    const idReal = (idRef && idTemporalAReal && Object.prototype.hasOwnProperty.call(idTemporalAReal, idRef))
                      ? idTemporalAReal[idRef] : idRef;
                    const conceptoRef = idReal ? conceptosNuevosEsteTurno.find(c => c.id === idReal) : null;
                    const identidadValida = !!conceptoRef && conceptoRef.autoridad === 'inferido'
                      && conceptoRef.origenAbstraccion === true
                      && dimensionDeProcedencia(conceptoRef.procedencia) === dimensionObjetivoDeContrato;
                    if (identidadValida) {
                      resultadoEsteIntento = 'PROPUESTA';
                      conceptoIdEsteIntento = conceptoRef.id;
                    } else {
                      evaluacionInterpretacionValida = false;
                      motivoInvalidezEsteIntento = 'identidad';
                      erroresEvaluacionInterpretacion = [`evaluacionInterpretacion: "conceptoId" debe identificar, entre los conceptosNuevos de ESTE turno, uno con autoridad "inferido", origen de abstracción y procedencia de la dimensión '${dimensionObjetivoDeContrato}' — nunca un concepto ya existente, de otra dimensión, o "experto"`];
                    }
                  } else if (resultadoDeclarado === 'NO_PROPUESTA') {
                    const razon = evalInterp.razon;
                    if (['EVIDENCIA_INSUFICIENTE', 'NO_AGREGA_COMPRENSION', 'CONTRADICCION_ACTIVA'].includes(razon)) {
                      resultadoEsteIntento = 'NO_PROPUESTA';
                      razonEsteIntento = razon;
                    } else {
                      evaluacionInterpretacionValida = false;
                      motivoInvalidezEsteIntento = 'contrato';
                      erroresEvaluacionInterpretacion = ['evaluacionInterpretacion: "razon" debe ser EVIDENCIA_INSUFICIENTE, NO_AGREGA_COMPRENSION o CONTRADICCION_ACTIVA cuando resultado es NO_PROPUESTA'];
                    }
                  } else {
                    // Invariante (Especificación): ausencia de PROPUESTA y
                    // de NO_PROPUESTA es una violación de contrato, nunca
                    // una omisión tolerada.
                    evaluacionInterpretacionValida = false;
                    motivoInvalidezEsteIntento = 'contrato';
                    erroresEvaluacionInterpretacion = ['evaluacionInterpretacion: falta u omite "resultado" — la dimensión en foco de este turno permite interpretación; responde { resultado: "PROPUESTA", conceptoId } o { resultado: "NO_PROPUESTA", razon }, nunca lo omitas'];
                  }
                }
                if (!evaluacionInterpretacionValida && !esUltimoIntentoContrato) {
                  validacionContrato = etiquetarValidacionContrato({ valido: false, errores: erroresEvaluacionInterpretacion }, 'REPRESENTACION');
                  evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
                } else {
                  grafoDelta = grafoNuevo;
                  // Se llega aquí también cuando conceptosNuevos venía vacío
                  // (aplicarDelta corre sin condición en esta rama): el
                  // mecanismo genuinamente se ejecutó y no encontró
                  // violaciones (no había nada que violar) — APROBADA es el
                  // hecho correcto, no NO_APLICA. Distinto de la rama de
                  // "rechaza" más abajo, que si explícitamente salta el
                  // mecanismo cuando no hay conceptosNuevos.
                  evaluacionGrafo = EVALUACION_GRAFO.APROBADA;
                  huboObsolescenciaEsteTurno = Array.isArray(r.parsed.marcarObsoletos) && r.parsed.marcarObsoletos.length > 0;
                  // T-DIM2 — legado: con contratoRespuestaDirigidaEsteTurno
                  // presente, el gate de arriba nunca se exime en el último
                  // intento, así que este camino solo se alcanza ya
                  // validado (queda false) — el resultado real vive en
                  // alineacionRespuestaDirigidaResultadoTraza. Sin
                  // contratoRespuestaDirigidaEsteTurno, conserva el
                  // significado original: degradación trazada, nunca
                  // bloqueo, solo true cuando de verdad se agotaron los
                  // reintentos sin justificación.
                  atribucionSinJustificar = contratoRespuestaDirigidaEsteTurno
                    ? false : (!atiendeDimensionObjetivo && !justificacionAtribucion);
                  // circulomejora006 (evaluacionInterpretacion) — misma
                  // disciplina: "omitida" solo true cuando de verdad se
                  // agotaron los reintentos sin un resultado válido (si
                  // evaluacionInterpretacionValida ya era cierto, queda
                  // false). Commit 1 termina aquí — resultado/conceptoId
                  // quedan trazados, pero candidatosMaterializables (más
                  // abajo, en la rama TRANSFORMAR) todavía NO los lee.
                  evaluacionInterpretacionOmitida = !evaluacionInterpretacionValida;
                  evaluacionInterpretacionResultado = resultadoEsteIntento;
                  conceptoIdInterpretacionValidado = conceptoIdEsteIntento;
                  evaluacionInterpretacionRazon = razonEsteIntento;
                  // circulomejora006 (Commit 2) — solo relevante cuando
                  // evaluacionInterpretacionOmitida es true (agotó
                  // reintentos); null en cualquier otro caso.
                  evaluacionInterpretacionMotivoOmision = motivoInvalidezEsteIntento;
                }
              }
            }
            }
          }
        } else if (validacionContrato.valido && grafoModoSesion && protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION' && r.parsed.clasificacion_respuesta === 'rechaza') {
          // Ciclo Cognitivo de Descubrimiento — rechazo de síntesis con
          // posible evidencia nueva en el MISMO turno. Dos operaciones
          // encadenadas, reutilizando exactamente los mismos aplicadores
          // que el resto del ciclo:
          //   1. cascada de rechazo (aplicarDeltaReconciliacion.
          //      inferenciasRechazadas) sobre todo "inferido" activo de
          //      esta gramática — la hipótesis que la síntesis rechazada
          //      sostenía.
          //   2. cualquier conceptosNuevos que el experto haya aportado se
          //      valida con la MISMA elegibilidad de EXPLORANDO — evaluada
          //      contra el grafo YA cascadeado, para que un rechazo que
          //      acaba de elevar el umbral de esta dimensión (dos rechazos
          //      consecutivos) se respete de inmediato, en el mismo turno.
          const conceptosACascadear = conceptosDeGramatica(estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
            .filter(c => c.autoridad === 'inferido');
          let grafoTrasCascada = estadoActual.knowledgeGraph;
          if (conceptosACascadear.length > 0) {
            const porQueRechazo = (typeof r.parsed.correccion_detalle === 'string' && r.parsed.correccion_detalle.trim())
              ? r.parsed.correccion_detalle
              : 'El experto rechazó la síntesis propuesta sin detalle adicional.';
            const { grafoNuevo: gCascada } = aplicarDeltaReconciliacion(estadoActual.knowledgeGraph, {
              inferenciasRechazadas: conceptosACascadear.map(c => ({ id: c.id, porQue: porQueRechazo })),
            });
            grafoTrasCascada = gCascada || estadoActual.knowledgeGraph;
          }

          const conceptosNuevosPropuestos = (r.parsed.conceptosNuevos || []);
          if (conceptosNuevosPropuestos.length === 0) {
            grafoDelta = grafoTrasCascada;
            // Explícito (aunque coincide con el default del inicio del
            // intento): esta rama SALTA aplicarDelta/elegibilidad a
            // propósito cuando no hay conceptosNuevos — el turno
            // genuinamente no produjo un delta que requiriera evaluación.
            // A diferencia de EXPLORANDO (arriba), acá el mecanismo NO
            // corre sin condición.
            evaluacionGrafo = EVALUACION_GRAFO.NO_APLICA;
          } else {
            // Misma disciplina que arriba: aplicarDelta corre primero (con
            // mensajeUsuario — cualquier "experto" sin cita verificable se
            // degrada aquí), la elegibilidad se revisa después, sobre el
            // resultado ya corregido.
            //
            // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — misma
            // GOBERNANZA_DELTA_DIMENSIONAL que el camino EXPLORANDO de
            // arriba, antes de aplicarDelta -- genérica, nunca específica de
            // este flujo de rechazo de síntesis.
            const dimensionObjetivoRechazoSintesis = gramaticaActivaAlInicio === 'destino'
              ? (estadoActual.protocoloDimensionEnFoco || null) : null;
            {
              const { conceptosGobernados, traza } = await gobernarDimensionDeltaConceptos({
                conceptosPropuestos: r.parsed.conceptosNuevos,
                objetivoSolicitado: dimensionObjetivoRechazoSintesis,
                relacionRespuestaDirigidaDeclarada: null,
                mensajeUsuario, dimensionesLegales: dimensionesLegalesDeGramatica(gramaticaActivaAlInicio),
                llmService: llmServiceProductorActivo, sesionId, turnoOrigenId: turnoClienteId, turnoId: turnoIdReservadoEnAdmision,
              });
              r.parsed.conceptosNuevos = conceptosGobernados;
              gobernanzaDimensionTrazaEsteTurno = traza;
            }
            let { grafoNuevo, errores, idTemporalAReal } = aplicarDelta(grafoTrasCascada, deltaAditivoDesdeParsed(r.parsed), {
              mensajeUsuario,
              turnoOrigenId: turnoClienteId,
              actoCognitivoVisible: null,
              relacionRespuestaDirigida: null,
            });
            if (idTemporalAReal) {
              idTemporalARealEsteTurno = proyectarIdentidadesAdjudicadas(
                { ...idTemporalARealEsteTurno, ...idTemporalAReal },
                gobernanzaDimensionTrazaEsteTurno,
              );
              canonicalizarSoporteGanancia(r.parsed, idTemporalARealEsteTurno);
            }
            if (!grafoNuevo) {
              validacionContrato = etiquetarValidacionContrato({ valido: false, errores }, 'GOBERNANZA');
              evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
            } else {
              // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — mismo enlace a
              // id real que el camino EXPLORANDO de arriba.
              if (gobernanzaDimensionTrazaEsteTurno.length > 0 && idTemporalAReal) {
                gobernanzaDimensionTrazaEsteTurno = gobernanzaDimensionTrazaEsteTurno.map(t => ({
                  // aplicarDelta devuelve idTemporalAReal como OBJETO plano
                // (Object.fromEntries), nunca un Map -- acceso por
                // propiedad, no .has()/.get().
                ...t, conceptoId: Object.prototype.hasOwnProperty.call(idTemporalAReal, t.conceptoIdTemporal)
                  ? idTemporalAReal[t.conceptoIdTemporal] : null,
                }));
              }
              const idsAntes = new Set(grafoTrasCascada.conceptos.map(c => c.id));
              // DEPENDENCY_SCOPED_SEMANTIC_GOVERNANCE -- mirrors the
              // EXPLORANDO path's own correction above, byte for byte in
              // intent: exclude the specific ineligible concept(s) from
              // THIS delta rather than rejecting the whole batch. See that
              // site's comment for the full rationale.
              const idsIneligiblesEsteIntento = new Set(grafoNuevo.conceptos
                .filter(c => !idsAntes.has(c.id) && c.autoridad === 'inferido')
                .filter(c => {
                  const dim = dimensionDeProcedencia(c.procedencia);
                  return dim && !elegibleParaAbstraer(grafoTrasCascada, dim);
                })
                .map(c => c.id));
              const violacionesElegibilidad = idsIneligiblesEsteIntento.size > 0
                ? grafoNuevo.conceptos
                  .filter(c => idsIneligiblesEsteIntento.has(c.id))
                  .map(c => dimensionDeProcedencia(c.procedencia))
                : [];
              if (idsIneligiblesEsteIntento.size > 0) {
                const idsTemporalesIneligibles = new Set(
                  Object.entries(idTemporalAReal || {})
                    .filter(([, real]) => idsIneligiblesEsteIntento.has(real))
                    .map(([temporal]) => temporal),
                );
                // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- mirrors the
                // EXPLORANDO path's own snapshot above, byte for byte in
                // intent, including the UNSUPPORTED_CONTENT_MUST_NOT_BE_
                // RESCUED autoridadDegradada exclusion -- see that site's
                // comment for the full rationale.
                conceptosHipotesisAbiertaEsteTurno = conceptosHipotesisAbiertaEsteTurno.concat(
                  grafoNuevo.conceptos
                    .filter(c => idsIneligiblesEsteIntento.has(c.id) && c.autoridadDegradada !== true)
                    .map(c => ({
                      ...c,
                      idTemporal: Object.entries(idTemporalAReal || {}).find(([, real]) => real === c.id)?.[0] || null,
                    }))
                    .filter(c => c.idTemporal),
                );
                const conceptosNuevosSinIneligibles = (r.parsed.conceptosNuevos || [])
                  .filter(c => !(c && idsTemporalesIneligibles.has(c.idTemporal)));
                const reconstruidoElegibilidad = aplicarDelta(
                  grafoTrasCascada,
                  deltaAditivoDesdeParsed({ ...r.parsed, conceptosNuevos: conceptosNuevosSinIneligibles }),
                  { mensajeUsuario, turnoOrigenId: turnoClienteId, actoCognitivoVisible: null, relacionRespuestaDirigida: null },
                );
                grafoNuevo = reconstruidoElegibilidad.grafoNuevo;
                errores = reconstruidoElegibilidad.errores;
                idTemporalAReal = reconstruidoElegibilidad.idTemporalAReal;
                if (idTemporalAReal) {
                  idTemporalARealEsteTurno = proyectarIdentidadesAdjudicadas(
                    { ...idTemporalARealEsteTurno, ...idTemporalAReal },
                    gobernanzaDimensionTrazaEsteTurno,
                  );
                  canonicalizarSoporteGanancia(r.parsed, idTemporalARealEsteTurno);
                }
              }
              if (!grafoNuevo) {
                validacionContrato = etiquetarValidacionContrato({
                  valido: false,
                  errores: errores && errores.length > 0 ? errores : [...new Set(violacionesElegibilidad)].map(dim =>
                    `conceptosNuevos: la dimensión '${dim}' todavía no tiene evidencia suficiente de autoridad "experto" para proponer un concepto "inferido" — captura esta evidencia como "experto" si el experto la afirmó directamente, o espera a tener más`
                  ),
                }, 'GOBERNANZA');
                evaluacionGrafo = EVALUACION_GRAFO.RECHAZADA;
              } else {
                grafoDelta = grafoNuevo;
                evaluacionGrafo = EVALUACION_GRAFO.APROBADA;
              }
            }
          }
        }
        // PREVIOUS_RESPONSE_CONTRACT_MUST_BE_VERDICTED_BEFORE_PRODUCER_ACCEPTANCE
        // (C007, logistica_c1 turn 17). The relation gate above is evaluated
        // only inside the graph-governed branch; a response lifecycle whose
        // PREVIOUS committed contract owns the response semantics but whose
        // turn never enters that branch (e.g. the acceptance of a frozen
        // PROPOSE_MISSION_CLOSURE) used to accept a Producer output with NO
        // relation on attempt 0, and downstream correctly found no verdict.
        // The requirement is derived from the previous contract (see
        // relacionEsPostcondicionDelProductor), validated by the SAME
        // validarRelacionRespuestaDirigida the post-loop closure check uses,
        // and enforced through the SAME bounded retry mechanism: a missing,
        // malformed or unsupported relation is an incomplete Producer output,
        // never an accepted one. It never chooses the verdict.
        if (validacionContrato.valido && !relacionVerificadaEsteIntento
          && relacionEsPostcondicionDelProductor({
            contrato: contratoRespuestaDirigidaEsteTurno,
            cicloSolicitaRelacion: confirmationSujetoEsteTurno === CONFIRMATION_SUBJECTS.MISSION_CLOSURE,
          })) {
          const verdictoRelacionPostcondicion = validarRelacionRespuestaDirigida({
            relacionDeclarada: r.parsed.relacionRespuestaDirigida,
            mensajeUsuario,
            contrato: contratoRespuestaDirigidaEsteTurno,
            conceptosNuevosEsteTurno: [],
            dimensionDeProcedencia,
            incertidumbreObjetivoResuelta: false,
          });
          if (!verdictoRelacionPostcondicion.valido) {
            validacionContrato = etiquetarValidacionContrato({
              valido: false,
              errores: [verdictoRelacionPostcondicion.motivo || 'relacionRespuestaDirigida inválida'],
              diagnostico: verdictoRelacionPostcondicion.diagnostico || null,
            }, 'REPRESENTACION');
          }
        }
        if (validacionContrato.valido) break;
        // COMPLETE_PRODUCER_CORRECTION_FEEDBACK -- the staged validators
        // above reported only the FIRST failing stage; every other
        // independently-detectable structural defect of this SAME output is
        // appended here (deduplicated, same validators), so one retry can
        // fix them all at once instead of oscillating between them.
        const defectosAdicionalesDeLaSalida = detectarDefectosEstructuralesProductor(r.parsed, {
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          grafoGobernanza: estadoActual.knowledgeGraph,
          idTemporalAReal: idTemporalARealEsteTurno,
          contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
          mensajeUsuario,
          incertidumbreObjetivoResuelta: !!(contratoRespuestaDirigidaEsteTurno
            && contratoRespuestaDirigidaEsteTurno.deudaTipo === 'INCERTIDUMBRE_RELEVANTE_ABIERTA'
            && ((grafoDelta || estadoActual.knowledgeGraph).incertidumbres || [])
              .some(u => u && u.id === contratoRespuestaDirigidaEsteTurno.deudaIdentidad && u.resuelta === true)),
        });
        const erroresCorreccionCompletos = [
          ...validacionContrato.errores,
          ...defectosAdicionalesDeLaSalida.filter(e => !validacionContrato.errores.includes(e)),
        ];
        correccionDeFormato = erroresCorreccionCompletos.join('; ');
        if (erroresCorreccionCompletos.some(e => /no resuelve contra un concepto durable|sin soporte estructurado|relacionRespuestaDirigida|conceptosNuevos|relacionesNuevas/.test(String(e)))) {
          correccionDeFormato += CORRECCION_SOPORTE_MISMA_SALIDA;
        }
        if (validacionContrato.diagnostico
          && validacionContrato.diagnostico.codigo === 'RELACION_POSITIVA_SIN_SOPORTE_ESTRUCTURADO') {
          propuestaBaseReparacionSoporteDirigido = r;
          correccionDeFormato = null;
        }
        if (erroresCorreccionCompletos.some(e => String(e).includes('relacionRespuestaDirigida.relacion'))) {
          correccionDeFormato += '; RELACION_RESPUESTA_DIRIGIDA es obligatoria en este turno: devuelve un objeto con relacion exactamente igual a uno de ATIENDE_OBJETIVO, ATIENDE_PARCIALMENTE, APORTA_OTRA_DIMENSION, MEZCLA_DIMENSIONES, CAMBIA_DE_TEMA, RECHAZA_PREMISA, NO_PUEDE_RESPONDER o AMBIGUA; incluye evidenciaTextual literal y conceptosQueAtienden cuando corresponda.';
        }
        if (validacionContrato.errores.includes('busquedaActoCognitivo: CANDIDATO_PROPUESTO_SIN_CANDIDATO')
          && !candidateUnderreachPreGovernance) {
          correccionDeFormato += '; CANDIDATO_PROPUESTO requiere un candidato canónico o material semántico literal del turno que pueda gobernarse; no cuentes mensaje, observacion ni semanticUnknown aislado como candidato. Si no existe material legítimo, devuelve NINGUNO_LEGITIMO con una razón epistémica independiente.';
        }
        // RESPONSE_VERDICT_MATERIAL_NOT_NEXT_ACT_GAIN (C007,
        // MISSION_CLOSURE_ACCEPTANCE_NO_NEW_ACT_GAIN_CONSISTENCY_CONFLICT).
        // NINGUNO_LEGITIMO_CON_CANDIDATO has TWO logically possible repairs
        // -- (A) the claimed gain/oportunidad is real domain content, so
        // busquedaActoCognitivo should become CANDIDATO_PROPUESTO, or (B) the
        // claimed gain/oportunidad is a false positive (real evidence: a
        // paraphrase of the expert's own acceptance/rejection/correction of
        // the previous act, restated as gananciaCognitiva with ZERO
        // evidenciaConceptoIds) and NINGUNO_LEGITIMO should be PRESERVED
        // with the gain/oportunidad removed. The generic block just below
        // this one only ever states direction A ("no sustituyas
        // CANDIDATO_PROPUESTO por NINGUNO_LEGITIMO") -- correct for every
        // OTHER busquedaActoCognitivo error it also covers, but actively
        // wrong-directioned for THIS one, where direction B is exactly the
        // repair a response-verdict turn needs. This branch states both
        // directions and is mutually exclusive with the generic one below
        // (esNingunoLegitimoConCandidato), which keeps every other error
        // case byte-for-byte unchanged.
        const esNingunoLegitimoConCandidato = validacionContrato.errores
          .includes('busquedaActoCognitivo: NINGUNO_LEGITIMO_CON_CANDIDATO');
        if (esNingunoLegitimoConCandidato) {
          correccionDeFormato += '; NINGUNO_LEGITIMO_CON_CANDIDATO: declaraste "resultado":"NINGUNO_LEGITIMO" pero también una oportunidad u otra gananciaCognitiva/evaluacionGanancia "SATISFECHA" que cuenta como candidato -- son contradictorios entre sí. Repara de UNA de estas dos formas, la que sea cierta -- nunca ambas: (A) si esa oportunidad/ganancia es contenido de dominio genuinamente nuevo, distinto de tu propia respuesta al acto anterior, y respaldado por evidenciaConceptoIds real, cambia "busquedaActoCognitivo.resultado" a "CANDIDATO_PROPUESTO" y consérvala; (B) si esa oportunidad/ganancia es solo una repetición o paráfrasis de tu propia "relacionRespuestaDirigida" o de la aceptación/rechazo/corrección del acto anterior del experto -- SIN conocimiento de dominio nuevo respaldado por evidencia -- entonces NO es una ganancia real: mantén "busquedaActoCognitivo.resultado":"NINGUNO_LEGITIMO" (con un bloqueoNoActo válido) y devuelve "gananciaCognitiva":null, "evaluacionGanancia":{"resultado":"NO_PROPUESTA","razon":"NO_AGREGA_COMPRENSION","satisfaccionConocimiento":{"estado":"ABIERTA","evidenciaConceptoIds":[],"residuoSemantico":null}} y "oportunidadesConversacionales":[]. NUNCA fuerces CANDIDATO_PROPUESTO solo para resolver esta contradicción cuando la respuesta real es (B).';
        }
        if (!propuestaBaseReparacionSoporteDirigido && !esNingunoLegitimoConCandidato
          && r.parsed && (r.parsed.busquedaActoCognitivo || r.parsed.oportunidadesConversacionales
          || r.parsed.gananciaCognitiva)) {
          correccionDeFormato += `; CONSERVA LA DIRECCIÓN COGNITIVA VÁLIDA DEL INTENTO ANTERIOR; corrige solo la estructura defectuosa y no sustituyas CANDIDATO_PROPUESTO por NINGUNO_LEGITIMO sin una razón epistémica independiente. PROPUESTA_PREVIA=${JSON.stringify({
            busquedaActoCognitivo: r.parsed.busquedaActoCognitivo || null,
            gananciaCognitiva: r.parsed.gananciaCognitiva || null,
            evaluacionGanancia: r.parsed.evaluacionGanancia || null,
            oportunidadesConversacionales: r.parsed.oportunidadesConversacionales || [],
            conceptosNuevos: r.parsed.conceptosNuevos || [],
          })}`;
        }
        if (fronteraCognitivaAdmisibleEsteTurno.length > 0) {
          correccionDeFormato += `; FRONTERA_COGNITIVA_ADMISIBLE=${JSON.stringify(fronteraCognitivaAdmisibleEsteTurno.map(f => ({
            tipo: f.tipo, subjectRef: f.subjectRef || null, unknownRef: f.unknownRef || null,
            mission: f.mission || gramaticaActivaAlInicio, missionNeedRef: f.missionNeedRef || null,
            allowedOperations: f.allowedOperations || (f.operation ? [f.operation] : []),
            evidenciaConceptoIds: f.evidenciaConceptoIds || [], provenance: f.provenance || null,
          })))}; propose a typed candidate inside this territory without inventing its WHAT`;
        }
        intentosContrato++;
      } while (intentosContrato <= MAX_CONTRATO_RETRIES);

        const providerFailure = !r || !r.parsed;
        // PRODUCER_REFERENTIAL_INTEGRITY (C007 human canary v8) —
        // INVALID_PRODUCER_CONTRACT != LEGITIMATE_EMPTY_COGNITIVE_FRONTIER.
        // A dangling concept reference is invalid regardless of whether the
        // pre-turn frontier happens to be empty or not — gating this
        // specific failure on fronteraTareaProductor.length>0 would let a
        // producer on a genuinely fresh/empty frontier (exactly v8's case)
        // silently fall through as "no territory" instead of escalating.
        // Every OTHER REPRESENTACION-class failure keeps the original,
        // already-certified frontier-gated behavior unchanged.
        const erroresIntegridadReferencial = !validacionContrato.valido
          && validacionContrato.claseError === 'REPRESENTACION'
          && validacionContrato.integridadReferencialFallida === true;
        const capabilityFailure = !providerFailure
          && !validacionContrato.valido
          && validacionContrato.claseError === 'REPRESENTACION'
          && (fronteraTareaProductor.length > 0 || erroresIntegridadReferencial);
        const failureClass = providerFailure
          ? PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE
          : (capabilityFailure ? PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE : null);
        if (failureClass && producerTask.escalate(failureClass)) {
          llmServiceProductorActivo = producerTask.current();
          continue producerExecutionLoop;
        }
        producerFailureClassFinal = failureClass;
        break producerExecutionLoop;
      }

      validacionContratoFinal = validacionContrato;
      intentosContratoFinal = intentosContrato;

      // PROVIDER_FAILURE_ERROR_PROPAGATION_1 — si el proveedor/LLMService
      // no produjo payload adjudicable, no existe contrato cognitivo que
      // validar. Transportar la categoría de infraestructura antes del
      // fail-closed de dirección tipada; la ausencia de JSON no equivale a
      // una respuesta estructurada inválida.
      if (!r.parsed) {
        const errorCategoryLlmUnavailable = r.errorCategory || null;
        const retryable = retryableDesdeErrorCategory(errorCategoryLlmUnavailable);
        this._marcarEntradaFallidaSiEsSeguro({
          turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
          causa: 'LLM_UNAVAILABLE', errorCategory: errorCategoryLlmUnavailable, retryable,
        });
        return {
          ok: true,
          httpStatus: 200,
          // C007 — HONEST FAILURE SURFACE (human canary v10 T2). This is a
          // TECHNICAL_FAILURE, never a COGNITIVE_INTERVENTION — the visible
          // copy must not describe internals ("motor", "respuesta
          // cognitiva") nor imply the expert's evidence was insufficient.
          // causa/errorCategory/retryable below (internal diagnostics) are
          // preserved exactly as before, only the user-facing `mensaje`
          // changes to the shared operational fallback copy.
          mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
          state,
          entradaRegistrada: true,
          procesamientoCompletado: false,
          respuestaGenerada: false,
          turnoId: turnoIdReservadoEnAdmision,
          turnoClienteId,
          protocolo: {
            estadoAnterior: protocoloEstadoEfectivo,
            estadoNuevo: protocoloEstadoEfectivo,
            evento: null,
            avanzaReal: false,
            causa: 'LLM_UNAVAILABLE',
            errorCategory: errorCategoryLlmUnavailable,
            retryable,
          },
        };
      }

      if (producerFailureClassFinal === PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE) {
        // CONTENT_CLOSURE_REPAIR (PRODUCER_CROSS_FIELD_REFERENTIAL_SELF_
        // INCONSISTENCY cluster, first call site -- covers the sub-path
        // where the FINAL producer attempt this turn was itself the
        // dangling-reference one, so the retry budget exhausted straight
        // into PRODUCER_CAPABILITY_FAILURE without ever reaching the
        // frontier/STRUCTURAL_REBIND block below). Only attempted when a
        // qualifying candidate was actually captured (see its own capture
        // comment) -- every OTHER capability failure (schema-missing,
        // observacionNaturaleza, transport) leaves
        // mejorCandidatoColganteEsteTurno null and this block is a no-op,
        // byte-for-byte the original early return.
        let reparacionCierre = mejorCandidatoColganteEsteTurno
          ? await intentarReparacionCierreReferencial({
            candidato: mejorCandidatoColganteEsteTurno, mensajeUsuario,
            grafoBase: grafoDelta || estadoActual.knowledgeGraph,
            idTemporalAReal: idTemporalARealEsteTurno,
            llmService: llmServiceProductorActivo,
            turnoId: turnoIdReservadoEnAdmision, turnoClienteId,
            gramatica: gramaticaActivaAlInicio,
            contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
            grafoAntesDelTurno: estadoActual.knowledgeGraph,
          })
          : null;
        // REPAIR MAY RECONSTRUCT THE REPRESENTATION, NEVER BYPASS ITS
        // VALIDATION: the producer loop above ended on a representation that
        // FAILED, so the contract-of-fields guarantee it left behind
        // (contratoDeCamposValidado) describes that failed attempt, not the
        // repaired one. The repaired representation earns its own verdict
        // from the very check an ordinary attempt goes through; a repair
        // that does not pass it is no repair at all (fail closed, below).
        const contratoCamposReparado = reparacionCierre
          ? validarContratoDeCamposDelProductor(reparacionCierre.parsed) : null;
        const camposReparadoValidos = !!contratoCamposReparado && contratoCamposReparado.valido
          && validarFormaConceptosNuevos(reparacionCierre.parsed).length === 0;
        if (reparacionCierre && !camposReparadoValidos) reparacionCierre = null;
        if (reparacionCierre) {
          r = { ...r, parsed: reparacionCierre.parsed };
          grafoDelta = reparacionCierre.grafoNuevo;
          idTemporalARealEsteTurno = { ...idTemporalARealEsteTurno, ...reparacionCierre.idTemporalAReal };
          // The materialization guarantees (GobernanzaMaterializacion) must
          // describe the representation that is actually materialized:
          // fields contract validated just above; the graph delta is the one
          // aplicarDelta approved for the repair itself.
          contratoDeCamposValidado = true;
          evaluacionGrafo = EVALUACION_GRAFO.APROBADA;
          // REPAIRED_DIRECTED_RESPONSE_MUST_PASS_NORMAL_VALIDATION -- the
          // repaired candidate's directed response was validated INSIDE
          // intentarReparacionCierreReferencial (it returns null otherwise),
          // against the canonical ids and the graph the repair produced; the
          // turn's relation/alignment traces must mirror THAT verdict, never
          // the stale one of the last (failed) producer attempt.
          if (contratoRespuestaDirigidaEsteTurno) {
            relacionRespuestaDirigidaTraza = reparacionCierre.relacionDirigida.relacionTraza;
            alineacionRespuestaDirigidaResultadoTraza = reparacionCierre.relacionDirigida.alineacionTraza;
          }
          validacionContrato = { valido: true, errores: [], claseError: null };
          producerFailureClassFinal = null;
          // Falls through to the rest of this turn's processing exactly as
          // if this had been a valid producer attempt from the start --
          // frontier construction, candidatosCompatiblesConFrontera, and
          // Decision Authority below decide admissibility/authority
          // themselves, unchanged, from here on.
        } else {
          this._marcarEntradaFallidaSiEsSeguro({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER', errorCategory: null, retryable: false });
          return { ok: false, httpStatus: 502, codigo: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER',
            // C007 human canary v7 — internal architecture vocabulary must
            // never reach the human surface literally; codigo/producerFailureClass
            // stay internal identity for logs/observability.
            mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
            producerFailureClass: PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE };
        }
      }

      // Any remaining invalid producer contract belongs to the producer
      // boundary. It must not fall through to governance/frontier and be
      // misreported as a legitimate empty cognitive territory.
      const errorDeRepresentacionProductor = !validacionContrato.valido
        && validacionContrato.claseError === 'REPRESENTACION';
      if (errorDeRepresentacionProductor) {
        this._marcarEntradaFallidaSiEsSeguro({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
          causa: 'CONTRATO_INVALIDO', errorCategory: null, retryable: false });
        // C007 human canary v7/v8 — the raw validacionContrato.errores[] list
        // is internal diagnosis (logged via _marcarEntradaFallidaSiEsSeguro
        // just above); it must never be concatenated into a human-facing
        // mensaje.
        return { ok: false, httpStatus: 422, codigo: 'CONTRATO_INVALIDO',
          mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO };
      }

      // A malformed producer representation is not evidence that the
      // governed state has no cognitive territory.  Keep the failure at the
      // producer/contract boundary instead of allowing it to fall through to
      // the legitimate empty-frontier NO_ACT result.
      // Fail-closed de rollout: una misión tipada nunca continúa con el
      // movimiento/contrato legacy después de agotar sus reintentos.
      if (this._movimientoConversacionalEnabled
        && gramaticaActivaAlInicio !== 'destino'
        && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
        && estadoPermiteDireccionConversacional(protocoloEstadoEfectivo)
        && !oportunidadTipadaValidaEsteTurno
        && direccionTieneNecesidadPendiente({ gramatica: gramaticaActivaAlInicio, slots: estadoActual.slots || {} })) {
        this._marcarEntradaFallidaSiEsSeguro({
          turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
          causa: 'CONTRATO_INVALIDO', errorCategory: null, retryable: false,
        });
        return {
          ok: false,
          httpStatus: 422,
          codigo: 'CONTRATO_INVALIDO',
          mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
        };
      }

      // El aporte actual ya fue interpretado y materializado en grafoDelta;
      // recién ahora reconciliamos contra memoria histórica y vigencia.
      // Ningún consumidor de composición/progreso corre entre ambas fases.
      const grafoReconciliadoAceptado = reconciliacionBootstrapEjecutadaEsteTurno
        ? grafoDelta : await ejecutarReconciliacion();
      if (grafoReconciliadoAceptado && grafoReconciliadoAceptado.__falloOperacionalReconciliacion) {
        return grafoReconciliadoAceptado.resultado;
      }
      if (grafoReconciliadoAceptado) grafoDelta = grafoReconciliadoAceptado;

      // La respuesta dirigida se aplica una sola vez sobre el grafo ya
      // reconciliado. Esta es la mutación canónica que debe preceder a la
      // única Decision del siguiente acto; el delta aditivo temprano no la
      // ejecuta y la fase legacy inferior no participa cuando hay acto
      // congelado.
      if (grafoDelta && contratoRespuestaDirigidaEsteTurno
        && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
        && r && r.parsed && r.parsed.relacionRespuestaDirigida) {
        const respuestaAplicada = aplicarDelta(grafoDelta, {
          conceptosNuevos: [], relacionesNuevas: [], incertidumbresNuevas: [],
        }, {
          mensajeUsuario,
          turnoOrigenId: turnoClienteId,
          actoCognitivoVisible: contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible,
          relacionRespuestaDirigida: {
            ...r.parsed.relacionRespuestaDirigida,
            respuestaNegativa: r.parsed.respuestaNegativa || null,
          },
        });
        if (respuestaAplicada.grafoNuevo) grafoDelta = respuestaAplicada.grafoNuevo;
      }

      // Directed answers close the exact SemanticUnknown from the previous
      // contract after reconciliation and proposal application. Resolution
      // changes state only; it never chooses the next movement.
      if (grafoDelta && contratoRespuestaDirigidaEsteTurno
        && contratoRespuestaDirigidaEsteTurno.unknownId
        && !(contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible)
        && r && r.parsed) {
        const negative = r.parsed.respuestaNegativa && r.parsed.respuestaNegativa.tipo;
        const relation = r.parsed.relacionRespuestaDirigida && r.parsed.relacionRespuestaDirigida.relacion;
        const motivo = ['VALOR_PRESENTE', 'NO_EXISTE', 'NO_APLICA', 'NO_SABE', 'RECHAZA_PREMISA'].includes(negative)
          ? negative
          : (relation === 'RECHAZA_PREMISA' ? 'RECHAZA_PREMISA' : null);
        if (motivo) {
          const resolved = resolverSemanticUnknown(grafoDelta, contratoRespuestaDirigidaEsteTurno.unknownId, {
            motivo,
            evidenciaRef: r.parsed.respuestaNegativa && r.parsed.respuestaNegativa.evidencia || mensajeUsuario,
          });
          if (!resolved.error) grafoDelta = resolved.grafo;
        }
      }

      // The directed mutation above changes what counts as unknown before
      // admitting any next-turn debt. When that exact need was satisfied,
      // same-dimension novelty must be represented by the gain's typed
      // residue (or by another already-open identity), never by rephrasing.
      const actoDirigidoPrevio = contratoRespuestaDirigidaEsteTurno
        && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible;
      const necesidadDirigidaResueltaEsteTurno = actoDirigidoPrevio && grafoDelta
        && Array.isArray(grafoDelta.incertidumbres)
        ? grafoDelta.incertidumbres.find(u => u && u.id === actoDirigidoPrevio.target
          && u.resuelta === true && u.estado !== 'ABIERTO')
        : null;
      // C007 — PARTIAL RESIDUE MUST REPRESENT INCREMENTAL DEPTH (human
      // canary v13 T3). PARTIAL_SATISFACTION -> REQUIRES_INCREMENTAL_RESIDUE:
      // the directed target can legitimately still be ABIERTO after an
      // ATIENDE_PARCIALMENTE response (SAME_IDENTITY != SAME_TEMPORAL_STATE
      // -- this never force-closes it, never converts PARCIAL to
      // SATISFECHA). But a residue that only re-offers that SAME still-open
      // need must clear the identical novelty gate that already governs the
      // SATISFECHA case below -- SAME_UNKNOWN_ID != RIGHT_TO_REPEAT_SAME_
      // COGNITIVE_NEED. Scoped to THIS turn's own directed relation (never a
      // stale/unrelated open unknown from another lineage).
      const necesidadDirigidaParcialEsteTurno = !necesidadDirigidaResueltaEsteTurno
        && actoDirigidoPrevio && grafoDelta
        && Array.isArray(grafoDelta.incertidumbres)
        && r && r.parsed && r.parsed.relacionRespuestaDirigida
        && r.parsed.relacionRespuestaDirigida.relacion === 'ATIENDE_PARCIALMENTE'
        ? grafoDelta.incertidumbres.find(u => u && u.id === actoDirigidoPrevio.target
          && u.resuelta !== true)
        : null;
      // C007 — CONTENT-REJECTED RESIDUE MUST REPAIR WITHIN FROZEN COGNITIVE
      // DIRECTION (human product canary v14 T3, 502). Extracted so the SAME
      // identity+content-novelty governance can be reused verbatim for a
      // bounded content-repair proposal later in this turn — REPAIRED_
      // CANDIDATE MUST_REENTER_THE_GOVERNANCE_THAT_AUTHORIZES_PUBLICATION.
      // Never duplicated, never re-derived: same function, same ontology,
      // same real validador_novedad_cognitiva_residuo call.
      const evaluarOportunidadConGobernanzaDeNovedad = async (oportunidad) => {
        const evaluacionGananciaActual = (r.parsed && r.parsed.evaluacionGanancia) || null;
        const evaluacionIdentidad = evaluarNovedadOportunidadTrasRespuestaDirigida({
          grafo: grafoDelta,
          oportunidad,
          actoCognitivoPrevio: actoDirigidoPrevio,
          evaluacionGanancia: evaluacionGananciaActual,
          respuestaDirigidaParcialEsteTurno: !!necesidadDirigidaParcialEsteTurno,
        });
        if (!evaluacionIdentidad.elegible) return null;
        // Identity alone (NEW_IDENTITY != NEW_COGNITIVE_NEED) only grants
        // this candidate the right to be evaluated for content novelty —
        // never the right to materialize a new unknown by itself. The
        // separate semantic authority runs strictly before that
        // materialization, only for a candidate that already carries a
        // valid typed residue link (razon === 'RESIDUO_COGNITIVO_TIPADO_NUEVO');
        // an 'OTRA_IDENTIDAD_ABIERTA'/'OTRA_DIMENSION_GOBERNADA' candidate
        // is already grounded in durable, pre-existing graph identity and
        // needs no additional content judgment.
        if (evaluacionIdentidad.razon !== 'RESIDUO_COGNITIVO_TIPADO_NUEVO') return oportunidad;
        const satisfaccionGananciaActual = evaluacionGananciaActual
          && evaluacionGananciaActual.satisfaccionConocimiento;
        const residuoGananciaActual = satisfaccionGananciaActual
          && satisfaccionGananciaActual.estado === 'PARCIAL'
          && satisfaccionGananciaActual.residuoSemantico;
        const veredictoNovedadContenido = await validarNovedadCognitivaResiduo({
          llmService: this._llmService,
          satisfiedNeed: {
            semanticUnknownId: actoDirigidoPrevio.target || null,
            semanticTarget: actoDirigidoPrevio.expectedEvidence || null,
            expectedEvidence: actoDirigidoPrevio.expectedEvidence || null,
            subjectRef: actoDirigidoPrevio.subjectRef || null,
          },
          userEvidence: mensajeUsuario,
          candidateResidue: {
            idTemporal: oportunidad.idTemporal || null,
            semanticTarget: oportunidad.semanticTarget || null,
            referenteSemantico: oportunidad.referenteSemantico || null,
            operation: oportunidad.operacion || null,
            needKind: oportunidad.needKind || null,
            evidenciaBuscada: oportunidad.evidenciaBuscada || null,
            oportunidadRef: (residuoGananciaActual && residuoGananciaActual.oportunidadRef) || null,
          },
          turnoOrigenId: turnoClienteId,
          turnoId: turnoIdReservadoEnAdmision,
        });
        const evaluacionFinal = evaluarNovedadOportunidadTrasRespuestaDirigida({
          grafo: grafoDelta,
          oportunidad,
          actoCognitivoPrevio: actoDirigidoPrevio,
          evaluacionGanancia: evaluacionGananciaActual,
          veredictoNovedadContenido: veredictoNovedadContenido.veredicto,
          respuestaDirigidaParcialEsteTurno: !!necesidadDirigidaParcialEsteTurno,
        });
        return evaluacionFinal.elegible ? oportunidad : null;
      };
      if ((necesidadDirigidaResueltaEsteTurno || necesidadDirigidaParcialEsteTurno) && r && r.parsed) {
        const oportunidadesAntesDeNovedad = Array.isArray(r.parsed.oportunidadesConversacionales)
          ? r.parsed.oportunidadesConversacionales : [];
        const oportunidadesConNovedad = [];
        for (const oportunidad of oportunidadesAntesDeNovedad) {
          const aceptada = await evaluarOportunidadConGobernanzaDeNovedad(oportunidad);
          if (aceptada) oportunidadesConNovedad.push(aceptada);
        }
        reaperturaSinNovedadDescartadaEsteTurno = oportunidadesAntesDeNovedad.length > 0
          && oportunidadesConNovedad.length === 0;
        r = {
          ...r,
          parsed: { ...r.parsed, oportunidadesConversacionales: oportunidadesConNovedad },
        };
      }

      // Apply a standalone SemanticUnknown proposal only when the current
      // turn did not just satisfy a directed need. After a directed closure,
      // a legitimate new unknown is materialized later from an opportunity
      // that passed the novelty boundary above; the standalone proposal is
      // not an independent source of cognitive debt.
      if (!necesidadDirigidaResueltaEsteTurno
        && grafoDelta && r && r.parsed && r.parsed.semanticUnknown
        && typeof r.parsed.semanticUnknown === 'object') {
        const proposed = r.parsed.semanticUnknown;
        const candidate = crearSemanticUnknownCandidate({
          mission: proposed.mission || gramaticaActivaAlInicio,
          dimension: proposed.dimension,
          respondent: proposed.respondent || proposed.autoridadFuente || null,
          referenteSemantico: proposed.referenteSemantico,
          proposicion: proposed.proposicion || proposed.semanticTarget,
          operation: proposed.operation,
          procedencia: { turnoId: turnoIdReservadoEnAdmision, decision: 'CAPA1_OPORTUNIDAD' },
          sobreConceptos: proposed.sobreConceptos || [],
        });
        // DURABLE_SEMANTICUNKNOWN_TARGET_GROUNDING (C007, Daniel-adjudicated
        // -- Finding 2, real evidence: a live trial materialized a durable
        // SemanticUnknown from referenteSemantico "operacion logistica
        // real", a Producer paraphrase never literally present in the
        // expert's message). SemanticUnknown itself stays epistemically
        // OPEN -- TRUTH AUTHORITY is never required to persist an
        // uncertainty, and this gate does NOT add an autoridad/experto-
        // inferido axis to it (that would collapse SemanticUnknown into
        // ConversationalHypothesis, a different, untouched ontology). But
        // TARGET GROUNDING AUTHORITY -- persisting that this is a
        // legitimate durable epistemic target ABOUT THE USER'S REALITY,
        // not an invented one -- does require the SAME extractive-grounding
        // authority already governing "experto" concept descriptions
        // (contenidoEsExtractivo, GrafoConocimientoPolicy.js) -- reused
        // here as a hard gate, never weakened, never downgraded-and-
        // committed-anyway. PRODUCER FREE-FORM TEXT DOES NOT CREATE
        // CONTRACTUAL AUTHORITY: an ungrounded proposal is never committed
        // to durable state, but the ORIGINAL r.parsed.semanticUnknown
        // object is untouched and still readable by the bootstrap
        // acquisition correction's own eligibility check below, so a
        // genuinely repairable proposal is never silently discarded --
        // only its illegitimate DURABLE commit is blocked.
        const referenteGrounded = contenidoEsExtractivo(candidate && candidate.referenteSemantico, mensajeUsuario);
        if (candidate && referenteGrounded) {
          const materializado = materializarSemanticUnknown(grafoDelta, candidate);
          if (!materializado.error) {
            grafoDelta = materializado.grafo;
            semanticUnknownIdEsteTurno = materializado.unknown.id;
            objetivoConversacionalEsteTurno = objetivoConversacionalEsteTurno
              ? { ...objetivoConversacionalEsteTurno, semanticUnknownId: materializado.unknown.id }
              : { objetivo: 'NO_APLICA', semanticUnknownId: materializado.unknown.id };
          }
        }
      }

      // ADJUDICACION_POST_MATERIALIZACION: una relación nacida en el delta
      // de Generación no estaba disponible en el corte PRE_GENERACION del
      // veredicto anterior. Si sigue sin autoridad tras esa primera
      // reconciliación, ejecutar una segunda adjudicación estructurada sobre
      // el mismo turno, ya con su identidad canónica materializada.
      // La frontera PRE_GENERACION es la foto durable de entrada. `estadoActual`
      // puede haber sido reemplazado por la primera reconciliación sobre el
      // delta materializado y ya incluir las relaciones recién nacidas; usarlo
      // aquí ocultaría precisamente el material que requiere adjudicación
      // post-materialización.
      const relacionesPreGeneracion = new Set((state.knowledgeGraph.relaciones || []).map(rel => rel.id));
      // La segunda adjudicación se dispara por autoridad pendiente, no por
      // reconocimiento. `reconocidaPorUsuario` es una señal ortogonal de
      // trazabilidad y no concede autoridad causal a una relación. El owner
      // relacional materializa una relación con autoridad `inferido` cuando
      // todavía necesita veredicto; ese es el corte semántico que precede a
      // los gates transformacionales downstream.
      const relacionesNuevasSinAdjudicar = (grafoDelta && grafoDelta.relaciones || [])
        .filter(rel => !relacionesPreGeneracion.has(rel.id)
          && rel.activo !== false
        && rel.autoridad === 'inferido');
      if (relacionesNuevasSinAdjudicar.length > 0) {
          const grafoPostAdjudicacion = await ejecutarReconciliacion();
        if (grafoPostAdjudicacion && grafoPostAdjudicacion.__falloOperacionalReconciliacion) {
          return grafoPostAdjudicacion.resultado;
        }
        if (grafoPostAdjudicacion) grafoDelta = grafoPostAdjudicacion;
      }

      if (mutacionesAutorizadasConstruccionEsteTurno.length > 0 && grafoDelta) {
        const idsEnIncertidumbreRelevante = new Set((grafoDelta.incertidumbres || [])
          .filter(u => u && u.relevante !== false && Array.isArray(u.sobreConceptos))
          .flatMap(u => u.sobreConceptos));
        const mutacionesAplicables = mutacionesAutorizadasConstruccionEsteTurno
          .filter(item => !idsEnIncertidumbreRelevante.has(item.id))
          .filter(item => {
            // La bifurcación no concede ni revoca autoridad: distingue el
            // ámbito de aplicabilidad. Una mutación ya autorizada dentro del
            // cierre puede ejecutarse con su autoridad durable; cuando el
            // turno además responde a una intervención dirigida, su
            // evidencia debe superar de nuevo el prefiltro estructural sobre
            // el estado post-reconciliación, porque ese contrato aporta el
            // scope de la respuesta y puede haber abierto incertidumbre. En
            // ambos casos la decisión final consume el mismo grafo posterior.
            if (!contratoRespuestaDirigidaEsteTurno) return true;
            const concepto = grafoDelta.conceptos.find(c => c.id === item.id);
            if (!concepto) return false;
            return prefiltroEstructuralMutacion({
              concepto, dimensionAfectada: dimensionDeProcedencia(concepto.procedencia),
              tipoImpactoPropuesto: 'DECLARA_NO_VIGENTE', evidenciaTextual: item.porQue,
              mensajeUsuario, origenProductor: 'CONSTRUCCION', turnoOrigenId: turnoClienteId,
              esDestructiva: true,
            }).pasa;
          });
        if (mutacionesAplicables.length > 0) {
          const aplicado = aplicarDelta(grafoDelta, {
            marcarObsoletos: mutacionesAplicables,
          }, { mensajeUsuario, turnoOrigenId: turnoClienteId });
          if (aplicado.grafoNuevo) {
            grafoDelta = aplicado.grafoNuevo;
          }
        }
      }

      // La reconciliación es la autoridad que adjudica un rechazo y abre la
      // reparación conversacional. La fotografía usada para preparar y
      // ejecutar Movimiento debe ser la post-reconciliación; la lista
      // calculada antes de ejecutar esa fase solo representa reparaciones
      // heredadas y no puede gobernar este mismo turno.
      reparacionesPendientesEsteTurno = proyectarReparacionesPendientes(
        estadoActual.protocoloReparacionesInterpretativasPendientes,
      );
      const reparacionesS1RAbiertasParaDireccion = (this._unitOfWork.afirmacionTransformacionalRepo
        && typeof this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion === 'function')
        ? this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion(sesionId)
        : [];
      const obligacionesCognitivasAbiertas = proyectarObligacionesAbiertasDestino({
        reparacionesInterpretativasPendientes: proyectarReparacionesPendientes(
          estadoActual.protocoloReparacionesInterpretativasPendientes,
        ),
        reparacionesS1RAbiertas: reparacionesS1RAbiertasParaDireccion,
      });

      // AUTORIDAD_SEMANTICA_ROL_MECANISMO_1 — la interpretación del LLM
      // propone el rol; esta policy solo gobierna referencias, vigencia y
      // literalidad. El rol permanece process-local y no altera el KG.
      if (gramaticaActivaAlInicio === 'destino' && r.parsed && grafoDelta) {
        const validacionRoles = validarPropuestasRolesTransformacionales(
          grafoDelta,
          r.parsed.rolesTransformacionales,
          idTemporalARealEsteTurno,
          mensajeUsuario,
        );
        if (validacionRoles.valido) {
          rolesContextualesTransformacionalesEsteTurno = {
            mecanismoConceptoIds: [...new Set([
              ...((rolesContextualesTransformacionalesEsteTurno && rolesContextualesTransformacionalesEsteTurno.mecanismoConceptoIds) || []),
              ...(validacionRoles.roles.mecanismoConceptoIds || []),
            ])],
          };
          autoridadesContextualesTransformacionalesEsteTurno = {
            mecanismoConceptoIds: [...new Set([
              ...((autoridadesContextualesTransformacionalesEsteTurno && autoridadesContextualesTransformacionalesEsteTurno.mecanismoConceptoIds) || []),
              ...(validacionRoles.roles.mecanismoConceptoIds || []),
            ])],
          };
        }
      }

      // Garantía atómica compartida por los tres puntos de Gobernanza de
      // este método (EXPLORANDO, rechaza, LISTO_PARA_SINTESIS) — se calcula
      // una sola vez aquí, sobre el `r.parsed` del último intento del
      // bucle de arriba. Los tres bloques son mutuamente excluyentes por
      // protocoloEstadoEfectivo (nunca corre más de uno por turno), así
      // que reutilizarla es seguro: ninguno de los tres muta r.parsed
      // ANTES de que su propio bloque de Gobernanza la haya consultado.
      const mensajeValidado = !!(r.parsed && typeof r.parsed.mensaje === 'string' && r.parsed.mensaje.trim());

      // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- LOCAL widening, scoped
      // exclusively to frontier/candidate/opportunity matching within this
      // block. The shared idTemporalARealEsteTurno (read by referential
      // integrity, durable projections, and every other consumer in this
      // function) is never touched -- an open-hypothesis concept must
      // never be resolvable as durable authority anywhere else.
      //
      // STALE_SNAPSHOT_ACROSS_REPAIR (found via a real regression --
      // test_c007_stabilization_deterministic_replay_1.js). idTemporalARealEsteTurno
      // is a `let` this block's OWN repair path can still reassign (new
      // materialization) between an earlier call site and a later one
      // (e.g. the repaired-candidate re-check further down). A single
      // const snapshot taken once here would silently go stale for every
      // call site after such a reassignment -- read it fresh, every call,
      // exactly like the unwidened code always did.
      const idTemporalARealParaFrontera = () => conceptosHipotesisAbiertaEsteTurno.length > 0
        ? {
          ...idTemporalARealEsteTurno,
          ...Object.fromEntries(conceptosHipotesisAbiertaEsteTurno.map(c => [c.idTemporal, c.id])),
        }
        : idTemporalARealEsteTurno;
      // La propuesta generativa no concede derecho por sí misma. Objetivo
      // valida anclajes y operación tipada; el texto libre es rationale.
      if (direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
        && r.parsed
        && Array.isArray(r.parsed.oportunidadesConversacionales)) {
        oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(
          r.parsed.oportunidadesConversacionales,
          idTemporalARealParaFrontera(),
        );
      }

      // PRODUCER_CROSS_FIELD_EVIDENCE_STALENESS (C007, Daniel-adjudicated,
      // real evidence: logistica_c0 turn 10). REFERENTIAL_SUPPORT_VALIDITY
      // != SEMANTIC_SUPPORT_VALIDITY: validarIntegridadReferencialRepresentacionProductor
      // (already run above, this same attempt) only proves each
      // evidenciaConceptoId RESOLVES against something real -- never that it
      // actually SUBSTANTIATES this specific gain. Runs exactly once per
      // attempt, strictly AFTER referential validation and BEFORE any
      // seleccionarGananciaCognitiva call below (this is the single owner
      // all of THIS attempt's gain-selection call sites share -- mutating
      // r.parsed here, in place, is what every one of them then reads).
      // Never touches oportunidadesConversacionales, conceptosNuevos, or the
      // gain's own texto -- GAIN SUPPORT != GAIN WORDING AUTHORITY stays
      // exactly as certified; this only gates which already-resolved
      // concept ids may legitimately become soporteConceptoIds.
      if (r.parsed && r.parsed.evaluacionGanancia
        && typeof r.parsed.gananciaCognitiva === 'string' && r.parsed.gananciaCognitiva.trim()
        && String((r.parsed.evaluacionGanancia.resultado || '')).toUpperCase() === 'NUEVA_COMPRENSION') {
        const gananciaTextoActual = r.parsed.gananciaCognitiva.trim();
        const satisfaccionActual = r.parsed.evaluacionGanancia.satisfaccionConocimiento;
        const idsSoporteActual = satisfaccionActual && Array.isArray(satisfaccionActual.evidenciaConceptoIds)
          ? satisfaccionActual.evidenciaConceptoIds.filter(Boolean) : [];
        if (idsSoporteActual.length > 0) {
          const grafoParaSoporte = grafoDelta || estadoActual.knowledgeGraph;
          const conceptosDurables = (grafoParaSoporte && Array.isArray(grafoParaSoporte.conceptos))
            ? grafoParaSoporte.conceptos : [];
          const conceptosNuevosEsteTurno = Array.isArray(r.parsed.conceptosNuevos) ? r.parsed.conceptosNuevos : [];
          // PRODUCER_CROSS_FIELD_EVIDENCE_STALENESS_VALIDATOR_RELIABILITY
          // (C007, Daniel-adjudicated, real evidence: logistica_c0
          // fresh-live turn 3). `turnoOrigenId` is carried through here so
          // esSoporteCrossTurnoDeAltoRiesgo can reuse the concept's OWN
          // durable provenance field (GrafoConocimientoPolicy.js) rather
          // than inferring age from id shape. A "nuevo" (this attempt's own
          // conceptosNuevos) candidate is, by construction, current-turn --
          // stamped with turnoClienteId itself, never left ambiguous.
          const resolverDescripcion = (id) => {
            const real = idTemporalARealEsteTurno[id] || id;
            const durable = conceptosDurables.find(c => c && c.id === real && c.activo !== false);
            if (durable) return { id, descripcion: durable.descripcion, turnoOrigenId: durable.turnoOrigenId || null };
            const nuevo = conceptosNuevosEsteTurno.find(c => c && (c.idTemporal === id || c.id === id));
            return nuevo ? { id, descripcion: nuevo.descripcion, turnoOrigenId: turnoClienteId } : null;
          };
          const candidatosSoporte = idsSoporteActual.map(resolverDescripcion).filter(Boolean);
          if (candidatosSoporte.length === idsSoporteActual.length) {
            const veredictoInicial = await validarSoporteSemanticoGanancia({
              llmService: llmServiceProductorActivo, gananciaTexto: gananciaTextoActual,
              candidatosSoporte, mensajeUsuario, turnoId: turnoIdReservadoEnAdmision,
            });
            // HIGH_RISK_CROSS_TURN_SUPPORT -- a positive first verdict on a
            // real cross-turn citation is not, alone, sufficient authority
            // (see module docstring). CROSS_TURN_SUPPORT MAY BE VALID: this
            // never rejects on its own, it only requires one independent,
            // adversarial, deterministically-grounded corroboration before
            // the SAME first-verdict outcome (authorized) is trusted.
            // FIRST_VALIDATOR_UNCHANGED -- soporteValido:true/false is read
            // exactly as before; only what happens NEXT, for the true+
            // high-risk case, is new.
            const soporteInicialAutorizado = veredictoInicial.soporteValido
              && (!esSoporteCrossTurnoDeAltoRiesgo(candidatosSoporte, turnoClienteId)
                || spansEvidenciaFundamentadosYCoberturaCompleta(
                  await desafiarSoporteCrossTurnoGanancia({
                    llmService: llmServiceProductorActivo, gananciaTexto: gananciaTextoActual,
                    candidatosSoporte, turnoId: turnoIdReservadoEnAdmision,
                  }),
                  candidatosSoporte,
                ));
            if (!soporteInicialAutorizado) {
              // GOVERNANCE_ELIGIBILITY_REUSED -- the SAME dimension-authority
              // gate seleccionarGananciaCognitiva itself already requires for
              // a current-turn concept (autoridadGobernanzaDimension in
              // CONCORDANTE/SIN_OBJETIVO_VIGENTE/ADJUDICADA_CONFORME) --
              // never a new eligibility rule invented here.
              const candidatosLegitimos = [
                ...conceptosDurables
                  .filter(c => c && c.activo !== false && c.autoridad === 'experto')
                  .map(c => ({ id: c.id, descripcion: c.descripcion, turnoOrigenId: c.turnoOrigenId || null })),
                ...conceptosNuevosEsteTurno
                  .filter(c => c && c.autoridad === 'experto' && c.idTemporal
                    && ['CONCORDANTE', 'SIN_OBJETIVO_VIGENTE', 'ADJUDICADA_CONFORME'].includes(c.autoridadGobernanzaDimension))
                  .map(c => ({ id: c.idTemporal, descripcion: c.descripcion, turnoOrigenId: turnoClienteId })),
              ];
              let idsCorregidos = [];
              if (candidatosLegitimos.length > 0) {
                const correccion = await seleccionarSoporteSemanticoCorregido({
                  llmService: llmServiceProductorActivo, gananciaTexto: gananciaTextoActual,
                  candidatosLegitimos, mensajeUsuario, turnoId: turnoIdReservadoEnAdmision,
                });
                if (!correccion.ningunoLegitimo && correccion.idsSeleccionados.length > 0) {
                  const candidatosCorregidos = correccion.idsSeleccionados
                    .map(id => candidatosLegitimos.find(c => c.id === id)).filter(Boolean);
                  const veredictoCorregido = await validarSoporteSemanticoGanancia({
                    llmService: llmServiceProductorActivo, gananciaTexto: gananciaTextoActual,
                    candidatosSoporte: candidatosCorregidos, mensajeUsuario, turnoId: turnoIdReservadoEnAdmision,
                  });
                  // CORRECTED_SUPPORT_ALSO_REQUIRES_CORROBORATION -- REPAIR
                  // MAY PROPOSE SUPPORT != SUPPORT IS GOVERNED extends to
                  // this new risk class too: a corrected selection that is
                  // ITSELF high-risk cross-turn gets the exact same
                  // adversarial corroboration before being trusted, never a
                  // second, differently-scoped mechanism.
                  const corregidoAutorizado = veredictoCorregido.soporteValido
                    && (!esSoporteCrossTurnoDeAltoRiesgo(candidatosCorregidos, turnoClienteId)
                      || spansEvidenciaFundamentadosYCoberturaCompleta(
                        await desafiarSoporteCrossTurnoGanancia({
                          llmService: llmServiceProductorActivo, gananciaTexto: gananciaTextoActual,
                          candidatosSoporte: candidatosCorregidos, turnoId: turnoIdReservadoEnAdmision,
                        }),
                        candidatosCorregidos,
                      ));
                  if (corregidoAutorizado) idsCorregidos = correccion.idsSeleccionados;
                }
              }
              // NO_LEGITIMATE_SUPPORT (idsCorregidos still empty) strips the
              // stale evidence rather than fabricating anything --
              // seleccionarGananciaCognitiva's own existing
              // `soporteConceptoIds.length > 0` requirement then correctly
              // yields no governed gain this attempt, falling back through
              // the existing bounded Producer capability/retry semantics --
              // never a new fallback mechanism invented here.
              r = {
                ...r,
                parsed: {
                  ...r.parsed,
                  evaluacionGanancia: {
                    ...r.parsed.evaluacionGanancia,
                    satisfaccionConocimiento: {
                      ...satisfaccionActual,
                      evidenciaConceptoIds: idsCorregidos,
                    },
                  },
                },
              };
            }
          }
        }
      }

      // C007 — frontera determinista de territorio admisible: se calcula
      // después de gobernar/aplicar el delta de este turno y antes de la
      // autoridad que selecciona el WHAT. Solo proyecta territorio tipado;
      // nunca inventa semanticTarget ni contenido.
      if (grafoModoSesion && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)) {
        const descriptorFrontera = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
        const direccionFrontera = descriptorFrontera && descriptorFrontera.direccionConversacional;
        const dimensionFrontera = direccionFrontera
          && direccionFrontera.alcanceAnclaje === 'DIMENSION_PENDIENTE'
          ? (estadoActual.protocoloDimensionEnFoco || slotsFaltantesAntes[0] || null)
          : null;
        fronteraCognitivaAdmisibleEsteTurno = construirFronteraCognitivaAdmisible({
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          gramatica: gramaticaActivaAlInicio,
          slots: estadoActual.slots || {},
          dimension: dimensionFrontera,
          idTemporalAReal: idTemporalARealParaFrontera(),
          conceptosHipotesisAbierta: conceptosHipotesisAbiertaEsteTurno,
        });
        estadoFronteraCognitivaEsteTurno = clasificarEstadoFronteraCognitiva(
          true,
          fronteraCognitivaAdmisibleEsteTurno,
        );
        const compatibles = candidatosCompatiblesConFrontera(r.parsed, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario);
        const idsCompatibles = new Set(compatibles.map(o => o.idTemporal || o.tipo));
        oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.filter(o => idsCompatibles.has(o.idTemporal));
        const gananciaSeleccionadaPorPolicy = seleccionarGananciaCognitiva(
          r.parsed,
          grafoDelta || estadoActual.knowledgeGraph,
          {
            directedUnknownId: contratoRespuestaDirigidaEsteTurno
              && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
              && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
            directedResponseTurnId: turnoClienteId,
          },
        );
        // Post-governance candidate repair: the first producer response could
        // not know ids created by this same turn.  This bounded call repairs
        // only the candidate proposal; it never re-extracts or mutates state.
        const candidatosSemanticosCongelados = normalizarOportunidadesConversacionales(
          r.parsed.oportunidadesConversacionales, idTemporalARealParaFrontera(),
        ).filter(o => fronteraCognitivaAdmisibleEsteTurno.some(f =>
          (f.allowedOperations || []).includes(o.operacion)));
        const candidatosCompatiblesAntesDeRepair = candidatosCompatiblesConFrontera(
          r.parsed, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario,
        );
        // C007 — REPAIR SUPPRESSION MUST USE CANONICALLY CONSUMABLE NEXT-ACT
        // AUTHORITY (human product canary v14 T3, deterministic replay).
        // gananciaSeleccionadaPorPolicy (seleccionarGananciaCognitiva applied
        // straight to r.parsed) and candidatosCompatiblesAntesDeRepair (which
        // resurfaces that SAME raw gain as a synthetic {tipo:'GANANCIA_
        // COGNITIVA'} entry via candidatosCompatiblesConFrontera) are BOTH
        // raw, turn-local proxies -- neither is the representation
        // decidirIntervencionConversacional actually consumes. Proven by
        // deterministic replay: a turn existed where both proxies were
        // truthy (gain truthy, one compatible candidate) yet the canonical
        // Decision input was empty across the board (oportunidadesGobernadasEsteTurno
        // = [], governedGain = null, no open graph incertidumbre) --
        // decidirObjetivoConversacional's own cierre-priority branch
        // (senalEsteTurno/intencionActivaPrevia active) never reaches the
        // direccionDestino code path that would have surfaced that same raw
        // gain as governedGain. GAIN_AVAILABLE != RIGHT_TO_CONSUME_VISIBLE_TURN.
        //
        // C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 2 --
        // NEXT_ACT_AUTHORITY_IS_SINGLE. canonicalNextActStateV0 is the ONE
        // owner/builder of "does a canonically consumable alternative
        // exist" at repair-eligibility time. cierreActivoEsteTurno mirrors,
        // without re-deriving, decidirObjetivoConversacional's own
        // `cierreActivo` precondition (identical senalEsteTurno/
        // intencionActivaPrevia inputs already computed above) -- when true,
        // that function never reaches the branch that computes
        // gananciaCognitiva at all, so no canonical gain can exist
        // regardless of what Capa 1 proposed. When false, direccionDestino's
        // own seleccionarGananciaCognitiva call shares IDENTICAL inputs
        // (r.parsed, grafoDelta||estadoActual.knowledgeGraph, the same
        // directedUnknownId/directedResponseTurnId) with
        // gananciaSeleccionadaPorPolicy, so reusing it here is reading the
        // same already-computed value under the one condition where it is
        // provably identical to the canonical one -- never a duplicate of
        // Decision, never a second call to it. This is v0: a conservative,
        // best-effort projection built before objetivoConversacionalEsteTurno
        // exists (repair-eligibility runs before decidirObjetivoConversacional
        // -- see canonicalNextActStateV1 below, the authoritative version
        // Decision itself consumes, built once objetivoConversacionalEsteTurno
        // is real). governedOpportunities/executableUnknowns here read the
        // SAME durable structures Decision will read (oportunidadesGobernadasEsteTurno,
        // grafoDelta||estadoActual.knowledgeGraph) -- an open incertidumbre
        // is one Decision could still legitimately ASK about, so repair must
        // not manufacture a competing acquisition while one remains.
        const cierreActivoEsteTurno = senalesCierreAceptadas.length > 0 || !!(
          estadoActual.protocoloIntencionCierre
          && (estadoActual.protocoloIntencionCierre.estado === 'ACTIVA'
            || estadoActual.protocoloIntencionCierre.estado === 'BLOQUEADA_POR_DEUDA_DURA')
        );
        // AUTHORITY_CONTINUITY correction (PROGRESS_DECISION_INVOCATIONS_
        // FOR_HANDOFF_AUTHORITY = 1) -- ProgresoConversacionalPolicy.
        // decidirProtocolo is invoked EXACTLY ONCE for this turn's handoff
        // authority, right here (the earliest point closureOption/Decision
        // need it); decidirInteraccion() below (which used to call it a
        // second time internally) now receives THIS EXACT result via
        // `progresoPrecalculado` and reuses it verbatim -- never a second
        // derivation, even though the underlying function is pure and the
        // inputs/output would be identical. Exclusive of
        // gramaticaActivaAlInicio!=='destino': DESTINO's own advance
        // depends on CONFIRMADA_VIGENTE + a process-memory emission record,
        // a separate, already-diagnosed, out-of-scope mechanism -- for
        // 'destino', progresoEsteTurno stays null and decidirInteraccion()
        // falls back to computing its own progreso internally, exactly as
        // it always did (zero behavior change there).
        // diagnosticoEstructuralTransformacional/cierreConSnapshotSinDeudas
        // are exclusively DESTINO-scoped fields (see
        // relacionTransformacionalRequeridaEsteTurno's own definition,
        // gramaticaActivaAlInicio==='destino' gated) -- their real value is
        // structurally always null/false for any OTHER grammar, so passing
        // those literal defaults here is not an approximation.
        if (grafoModoSesion && gramaticaActivaAlInicio !== 'destino') {
          const slotsFaltantesEsteTurno = dimensionesPendientesDeGrafo(
            grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio,
          );
          progresoEsteTurno = decidirProtocolo({
            protocoloEstadoActual: estadoActual.protocoloEstado || 'EXPLORANDO',
            coberturaCompleta: slotsFaltantesEsteTurno.length === 0,
            slotsFaltantes: slotsFaltantesEsteTurno,
            parsed: r.parsed, intentosAmbiguosPrevios: estadoActual.protocoloIntentosAmbiguos || 0,
            resultadoSuficiencia: null,
            relacionTransformacionalRequerida: false,
            relacionTransformacionalEstado: null,
            diagnosticoEstructuralTransformacional: null,
            cierreConSnapshotSinDeudas: false,
            // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- for a non-DESTINO
            // grammar, LISTO_PARA_SINTESIS with zero pending required dimensions
            // is, by construction, a mission-closure proposal (these grammars
            // have no separate synthesis-verdict step); route it away from the
            // SINTESIS_PROPUESTA path. On a subsequent ESPERANDO_CONFIRMACION
            // turn, the already-frozen subject governs.
            actoCanonicoEsMisionClosure: (estadoActual.protocoloEstado || 'EXPLORANDO') === 'LISTO_PARA_SINTESIS'
              && slotsFaltantesEsteTurno.length === 0,
            confirmationSubject: confirmationSujetoEsteTurno,
          });
        }
        // closureOptionEsteTurno is a PURE PROJECTION of progresoEsteTurno
        // (grammarAfter via the static, non-decisional GRAMATICA_ORDER
        // sequence) -- never a second judgment about whether to advance.
        if (progresoEsteTurno && progresoEsteTurno.avanza === true) {
          const idxActual = GRAMATICA_ORDER.indexOf(gramaticaActivaAlInicio);
          const gramaticaSiguienteProyectada = idxActual >= 0 && idxActual < GRAMATICA_ORDER.length - 1
            ? GRAMATICA_ORDER[idxActual + 1] : null;
          closureOptionEsteTurno = gramaticaSiguienteProyectada
            ? { grammarAfter: gramaticaSiguienteProyectada, authorizedBy: 'ProgresoConversacionalPolicy' }
            : null;
        }
        const canonicalNextActStateV0 = construirCanonicalNextActState({
          oportunidadesGobernadas: oportunidadesGobernadasEsteTurno,
          governedGain: (!cierreActivoEsteTurno && gananciaSeleccionadaPorPolicy) ? gananciaSeleccionadaPorPolicy : null,
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          gramatica: gramaticaActivaAlInicio,
          frontierStatus: estadoFronteraCognitivaEsteTurno,
          closureOption: closureOptionEsteTurno,
          version: 0,
          excludedAlternatives: [
            ...(gananciaSeleccionadaPorPolicy && cierreActivoEsteTurno
              ? [{ tipo: 'raw_gain_proxy', razon: 'cierre_activo_prioridad_decidirObjetivoConversacional' }] : []),
            ...(candidatosCompatiblesAntesDeRepair.some(c => c && c.tipo === 'GANANCIA_COGNITIVA')
              ? [{ tipo: 'synthetic_gain_candidate_proxy', razon: 'candidatosCompatiblesConFrontera_no_es_oportunidad_gobernada' }] : []),
          ],
        });
        trazaAutoridadEsteTurno.canonicalNextActStateV0 = proyectarReferenciasParaTraza(canonicalNextActStateV0);
        // C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 4 --
        // directedResponse/governance lineage. IDs and short verdicts only
        // -- never the evidenciaTextual/prompt content.
        trazaAutoridadEsteTurno.directedResponse = {
          target: contratoRespuestaDirigidaEsteTurno
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
          relation: relacionRespuestaDirigidaTraza && relacionRespuestaDirigidaTraza.relacion || null,
        };
        trazaAutoridadEsteTurno.governance = {
          graphDeltaRefs: (grafoDelta && Array.isArray(grafoDelta.conceptos) ? grafoDelta.conceptos.length : 0),
          noveltyAccepted: oportunidadesGobernadasEsteTurno.length,
          noveltyRejected: reaperturaSinNovedadDescartadaEsteTurno ? 1 : 0,
        };
        // C007 — CONTENT-REJECTED RESIDUE MUST REPAIR WITHIN FROZEN
        // COGNITIVE DIRECTION. Mirrors debeRepararCandidatoEnFrontera's own
        // contenidoRechazadoSinCandidato disjunct exactly, so the
        // PROPUESTA (non-rebind) dispatch below can be scoped to ONLY this
        // reason -- the OTHER, pre-existing disjunct (zero compatible
        // candidates with no content rejection at all) must keep its prior
        // behavior byte for byte: no candidate was ever frozen to rebind
        // AND content was never rejected, so PROPUESTA stayed a deliberate
        // no-op before this fix and must remain one now. Only a genuine
        // content rejection, with no canonically consumable alternative,
        // authorizes this new dispatch.
        // GOVERNED_RESPONSE_MAY_COMMIT_WITHOUT_NEW_CURRENT_WHAT -- read FRESH
        // every time (an earlier repair of this very chain may have
        // refreshed the alignment): did this turn's VERIFIED directed
        // response satisfy the previous contracted act? It never replaces
        // the search for a next act below (the certified content-repair
        // still runs first, unchanged); it only decides whether that search
        // finding NOTHING admissible is a fatal 502 or a response-only turn.
        const respuestaDirigidaSatisfaceActoPrevioEsteTurno = () => respuestaDirigidaSatisfaceActoPrevio({
          contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
          alineacionRespuestaDirigida: alineacionRespuestaDirigidaResultadoTraza,
        });
        const esReparacionPorContenidoRechazado = reaperturaSinNovedadDescartadaEsteTurno
          && !tieneAlternativaCanonicaEjecutable(canonicalNextActStateV0);
        trazaAutoridadEsteTurno.repair = {
          required: esReparacionPorContenidoRechazado,
          reason: esReparacionPorContenidoRechazado ? 'NO_CANONICAL_NEXT_ACT' : null,
          responseSatisfiedPreviousAct: respuestaDirigidaSatisfaceActoPrevioEsteTurno(),
        };
        if (debeRepararCandidatoEnFrontera({
          estadoFrontera: estadoFronteraCognitivaEsteTurno,
          reaperturaSinNovedad: reaperturaSinNovedadDescartadaEsteTurno,
          gananciaSeleccionada: gananciaSeleccionadaPorPolicy,
          candidatosCompatibles: candidatosCompatiblesAntesDeRepair,
          adquisicionesRebindables: candidatosSemanticosCongelados,
          alternativaCanonicaDisponible: tieneAlternativaCanonicaEjecutable(canonicalNextActStateV0),
        })) {
          // CONTENT_CLOSURE_REPAIR -- REPAIR-ELIGIBILITY BOUNDARY FIX
          // (PRODUCER_CROSS_FIELD_REFERENTIAL_SELF_INCONSISTENCY cluster,
          // Daniel-adjudicated, second round). Tried FIRST, independent of
          // usaRebindEstructural/dispatchRepair below. Evidence (real
          // captured trials, deterministic replay): debeRepararCandidatoEnFrontera
          // above can be TRUE (frontier EVALUATED_NONEMPTY, zero compatible
          // candidates, no gain) while BOTH usaRebindEstructural (nothing
          // frozen to rebind -- candidatosSemanticosCongelados empty,
          // because the Producer's final attempt cited no operable
          // oportunidad at all, e.g. a genuine NINGUNO_LEGITIMO) AND
          // esReparacionPorContenidoRechazado (reaperturaSinNovedad false --
          // nothing was rejected as a duplicate) are ALSO false -- making
          // dispatchRepair false, and the existing rebind/proposta
          // mechanism below a documented, deliberate no-op for that case
          // (see its own comment). That no-op is CORRECT for what it was
          // built to handle -- but it left a THIRD, orthogonal case
          // unowned: a dangling-same-output-reference candidate captured
          // earlier THIS SAME turn (mejorCandidatoColganteEsteTurno),
          // which is neither "something frozen to rebind" nor "content
          // rejected as non-novel". VALID_GAIN MUST_NOT_MASK REBINDABLE_
          // ACQUISITION, generalized: a narrow, already-correct no-op gate
          // must not also silently swallow an unrelated, independently-
          // eligible repair case. On success this ALSO makes the existing
          // rebind/proposta logic below correctly moot (a governed
          // candidate already exists), so it is skipped, never run twice,
          // never conflicting with it.
          const reparacionCierreTemprana = mejorCandidatoColganteEsteTurno
            ? await intentarReparacionCierreReferencial({
              candidato: mejorCandidatoColganteEsteTurno, mensajeUsuario,
              grafoBase: grafoDelta || estadoActual.knowledgeGraph,
              idTemporalAReal: idTemporalARealEsteTurno,
              llmService: llmServiceProductorActivo,
              turnoId: turnoIdReservadoEnAdmision, turnoClienteId,
              gramatica: gramaticaActivaAlInicio,
              contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
              grafoAntesDelTurno: estadoActual.knowledgeGraph,
            })
            : null;
          const fronteraTrasCierreTemprana = reparacionCierreTemprana
            ? construirFronteraCognitivaAdmisible({
              grafo: reparacionCierreTemprana.grafoNuevo, gramatica: gramaticaActivaAlInicio,
              slots: estadoActual.slots || {}, dimension: dimensionFrontera,
              idTemporalAReal: { ...idTemporalARealEsteTurno, ...reparacionCierreTemprana.idTemporalAReal },
              conceptosHipotesisAbierta: conceptosHipotesisAbiertaEsteTurno,
            })
            : null;
          const compatiblesTrasCierreTemprana = reparacionCierreTemprana
            ? candidatosCompatiblesConFrontera(reparacionCierreTemprana.parsed, fronteraTrasCierreTemprana, { ...idTemporalARealEsteTurno, ...reparacionCierreTemprana.idTemporalAReal }, reparacionCierreTemprana.grafoNuevo, mensajeUsuario)
            : [];
          // SYNTHETIC_GAIN_PROXY_FALSE_SUCCESS_GATE (C007, Daniel-adjudicated,
          // faithful-replay-proven -- logistica_c0 turn 3). candidatosCompatibles
          // ConFrontera's own return value deliberately mixes two different
          // things under one array: real oportunidad entries (idTemporal
          // present) AND a synthetic {tipo:'GANANCIA_COGNITIVA'} placeholder
          // that only proves a raw evidenciaConceptoIds/frontier overlap
          // exists -- never that seleccionarGananciaCognitiva (the ONE real,
          // already-governed consumer of "is there a legitimate gain this
          // turn") would actually accept it. `.length > 0` alone cannot tell
          // these apart, so a turn whose ONLY compatible entry is that
          // synthetic proxy was being treated as full restoration -- skipping
          // the STRUCTURAL_REBIND branch below even though the real frozen
          // candidate (mejorCandidatoColganteEsteTurno) never actually
          // reached a consumable state. Never a positional/idTemporal-only
          // rule (a legitimate gain-only turn is preserved below, unchanged,
          // via the SAME seleccionarGananciaCognitiva call every other real
          // gain-selection site already uses): success here means EITHER a
          // real restored oportunidad OR a real governed gain, never the
          // synthetic proxy alone.
          const oportunidadesRealesTrasCierreTemprana = compatiblesTrasCierreTemprana.filter(c => c.idTemporal);
          const gananciaLegitimaTrasCierreTemprana = reparacionCierreTemprana
            ? seleccionarGananciaCognitiva(
              reparacionCierreTemprana.parsed,
              reparacionCierreTemprana.grafoNuevo,
              {
                directedUnknownId: contratoRespuestaDirigidaEsteTurno
                  && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
                  && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
                directedResponseTurnId: turnoClienteId,
              },
            )
            : null;
          const cierreTempranaRestauroPathReal = oportunidadesRealesTrasCierreTemprana.length > 0
            || !!gananciaLegitimaTrasCierreTemprana;
          // BOOTSTRAP_SEMANTICUNKNOWN_TO_ACQUISITION_CORRECTION (C007,
          // Daniel-adjudicated -- Option A). Tried SECOND, after
          // CONTENT_CLOSURE_REPAIR (unrelated trigger, never interferes)
          // and BEFORE the original rebind/proposta fallback below. Real
          // evidence: logistica_c0's live trial -- a genuinely user-
          // grounded first-turn direction, expressed by the Producer as a
          // standalone semanticUnknown with a PARAPHRASED (not extractive)
          // referenteSemantico, against an active BOOTSTRAP_MISSION_NEED
          // frontier with zero compatible candidates. This is NOT
          // CONTENT_CLOSURE_REPAIR's territory (no dangling same-output
          // reference -- the Producer's output was fully self-consistent,
          // just paraphrased) and NOT STRUCTURAL_REBIND's (nothing frozen
          // to rebind). LEGITIMATE_FIRST_ACQUISITION MUST_NOT_FAIL_SILENTLY
          // BECAUSE_PRODUCER_GROUNDING_FORMAT_IS_REPAIRABLE -- but the
          // correction NEVER regenerates WHAT (mission/proposición stay
          // frozen, see intentarCorreccionAdquisicionBootstrap), and its
          // own output is independently re-validated against the SAME
          // unmodified contenidoEsExtractivo before it can ever reach
          // admissibility (REPAIR MAY PROPOSE, NOT AUTHORIZE -- no
          // authority laundering). Eligibility is narrow and explicit,
          // never "the turn is merely empty": bootstrap territory active,
          // zero compatible candidates, AND a real, mission-relevant
          // semanticUnknown proposal exists this turn to correct.
          //
          // BOOTSTRAP_ACQUISITION_YIELD_RELIABILITY (C007, Daniel-
          // adjudicated). This gate previously read !reparacionCierreTemprana
          // -- MERE ATTEMPT of the earlier dangling-reference repair, not
          // whether that repair actually restored a real path. A cierre
          // temprana attempt that only produced a synthetic/proxy gain (or
          // none at all) still leaves this turn exactly as bootstrap-
          // eligible as if no repair had been attempted -- attempting !=
          // succeeding. The correct, already-existing sibling signal is
          // cierreTempranaRestauroPathReal (immediately above): whether
          // cierre temprana actually restored a real oportunidad or a
          // legitimate gain. Using it instead of the mere-attempt flag is
          // the ONLY change in this eligibility gate -- every other
          // conjunct, and everything downstream of eligibility
          // (intentarCorreccionAdquisicionBootstrap's WHAT-frozen contract,
          // extractive re-validation, frontier admissibility) stays
          // untouched.
          const esElegibleCorreccionAdquisicionBootstrapEsteTurno = elegibleCorreccionAdquisicionBootstrap({
            cierreTempranaRestauroPathReal,
            fronteraCognitivaAdmisibleEsteTurno,
            candidatosCompatiblesAntesDeRepair,
            semanticUnknownParsed: r && r.parsed ? r.parsed.semanticUnknown : null,
          });
          const oportunidadCorregidaBootstrap = esElegibleCorreccionAdquisicionBootstrapEsteTurno
            ? await intentarCorreccionAdquisicionBootstrap({
              semanticUnknownOriginal: r.parsed.semanticUnknown, mensajeUsuario,
              llmService: llmServiceProductorActivo, turnoId: turnoIdReservadoEnAdmision,
              gramatica: gramaticaActivaAlInicio, dimension: dimensionFrontera,
            })
            : null;
          const parsedTrasCorreccionBootstrap = oportunidadCorregidaBootstrap
            ? { ...r.parsed, oportunidadesConversacionales: [...(Array.isArray(r.parsed.oportunidadesConversacionales) ? r.parsed.oportunidadesConversacionales : []), oportunidadCorregidaBootstrap] }
            : null;
          const compatiblesTrasCorreccionBootstrap = parsedTrasCorreccionBootstrap
            ? candidatosCompatiblesConFrontera(parsedTrasCorreccionBootstrap, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario)
            : [];

          // BOOTSTRAP_REACQUISITION (C007, Daniel-adjudicated). Dispatched
          // EXACTLY ONCE, ONLY when a bootstrap correction was genuinely
          // eligible AND was actually attempted AND still declined
          // (oportunidadCorregidaBootstrap null) -- REJECTED_ACQUISITION_
          // PROPOSAL != EXHAUSTED_ACQUISITION_FRONTIER: one Producer
          // direction failing extractive grounding never proves the
          // user's opening contains no OTHER admissible first acquisition.
          // Never a loop -- this is the ONLY reacquisition attempt this
          // turn, bounded exactly like the correction it follows.
          const elegibleReadquisicionBootstrap = esElegibleCorreccionAdquisicionBootstrapEsteTurno
            && !oportunidadCorregidaBootstrap;
          const oportunidadReadquiridaBootstrap = elegibleReadquisicionBootstrap
            ? await intentarReadquisicionBootstrap({
              semanticUnknownRechazado: r.parsed.semanticUnknown, mensajeUsuario,
              llmService: llmServiceProductorActivo, turnoId: turnoIdReservadoEnAdmision,
              gramatica: gramaticaActivaAlInicio, dimension: dimensionFrontera,
            })
            : null;
          const parsedTrasReadquisicionBootstrap = oportunidadReadquiridaBootstrap
            ? { ...r.parsed, oportunidadesConversacionales: [...(Array.isArray(r.parsed.oportunidadesConversacionales) ? r.parsed.oportunidadesConversacionales : []), oportunidadReadquiridaBootstrap] }
            : null;
          const compatiblesTrasReadquisicionBootstrap = parsedTrasReadquisicionBootstrap
            ? candidatosCompatiblesConFrontera(parsedTrasReadquisicionBootstrap, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario)
            : [];

          // NEW_OPPORTUNITY_REQUIRES_SAME_BATCH_GROUNDING (C007, Daniel-
          // adjudicated, real evidence: logistica_c1 turn 10). Checked only
          // once every bootstrap (semanticUnknown-shaped) path above has
          // already failed to apply/recover -- exclusive by construction
          // (that gate requires a real semanticUnknownParsed; this one
          // requires a real oportunidad candidate with zero anchors). Fires
          // BEFORE structural rebind: an opportunity that cites no anchor at
          // all has nothing for rebind to legitimately reconnect, so this
          // must route to a bounded PRODUCER correction, never to
          // REBIND_ESTRUCTURAL_POST_GOBERNANZA (which may only select among
          // already-governed references -- it cannot author the missing
          // concept the Producer omitted).
          const candidatoSinFundamentoEsteTurno = elegibleCorreccionFundamentoFrescoOportunidad({
            candidatosCompatiblesAntesDeRepair,
            oportunidadesCrudas: r && r.parsed ? r.parsed.oportunidadesConversacionales : [],
            conceptosNuevosCrudos: r && r.parsed ? r.parsed.conceptosNuevos : [],
          })
            ? primerCandidatoSinFundamento(r.parsed.oportunidadesConversacionales, r.parsed.conceptosNuevos)
            : null;
          const correccionFundamentoFresco = candidatoSinFundamentoEsteTurno
            ? await intentarCorreccionFundamentoFrescoOportunidad({
              oportunidadOriginal: candidatoSinFundamentoEsteTurno, mensajeUsuario,
              llmService: llmServiceProductorActivo, turnoId: turnoIdReservadoEnAdmision,
              turnoClienteId, gramatica: gramaticaActivaAlInicio, dimension: dimensionFrontera,
              grafoBase: grafoDelta || estadoActual.knowledgeGraph,
            })
            : null;
          const fronteraTrasFundamentoFresco = correccionFundamentoFresco
            ? construirFronteraCognitivaAdmisible({
              grafo: correccionFundamentoFresco.grafoNuevo, gramatica: gramaticaActivaAlInicio,
              slots: estadoActual.slots || {}, dimension: dimensionFrontera,
              idTemporalAReal: { ...idTemporalARealEsteTurno, ...correccionFundamentoFresco.idTemporalAReal },
              conceptosHipotesisAbierta: conceptosHipotesisAbiertaEsteTurno,
            })
            : [];
          const parsedTrasFundamentoFresco = correccionFundamentoFresco
            ? {
              ...r.parsed,
              oportunidadesConversacionales: r.parsed.oportunidadesConversacionales.map(o =>
                o.idTemporal === correccionFundamentoFresco.oportunidadCorregida.idTemporal
                  ? correccionFundamentoFresco.oportunidadCorregida : o),
            }
            : null;
          const compatiblesTrasFundamentoFresco = correccionFundamentoFresco
            ? candidatosCompatiblesConFrontera(parsedTrasFundamentoFresco, fronteraTrasFundamentoFresco, { ...idTemporalARealEsteTurno, ...correccionFundamentoFresco.idTemporalAReal }, correccionFundamentoFresco.grafoNuevo, mensajeUsuario)
            : [];

          if (reparacionCierreTemprana && cierreTempranaRestauroPathReal) {
            r = { ...r, parsed: reparacionCierreTemprana.parsed };
            grafoDelta = reparacionCierreTemprana.grafoNuevo;
            idTemporalARealEsteTurno = { ...idTemporalARealEsteTurno, ...reparacionCierreTemprana.idTemporalAReal };
            fronteraCognitivaAdmisibleEsteTurno = fronteraTrasCierreTemprana;
            if (contratoRespuestaDirigidaEsteTurno) {
              relacionRespuestaDirigidaTraza = reparacionCierreTemprana.relacionDirigida.relacionTraza;
              alineacionRespuestaDirigidaResultadoTraza = reparacionCierreTemprana.relacionDirigida.alineacionTraza;
            }
            const compatibleIdsCierreTemprana = new Set(oportunidadesRealesTrasCierreTemprana.map(o => o.idTemporal));
            oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(reparacionCierreTemprana.parsed.oportunidadesConversacionales, idTemporalARealParaFrontera())
              .filter(o => compatibleIdsCierreTemprana.has(o.idTemporal));
            // CANDIDATE-SCOPED SALVAGE -- never report a dropped/salvaged
            // gain as a full content closure (reparacionCierreTemprana.
            // outcome distinguishes them; see intentarReparacionCierreReferencial).
            trazaAutoridadEsteTurno.repair.outcome = reparacionCierreTemprana.outcome || 'REPAIRED_VIA_CONTENT_CLOSURE';
          } else if (oportunidadCorregidaBootstrap && compatiblesTrasCorreccionBootstrap.length > 0) {
            r = { ...r, parsed: parsedTrasCorreccionBootstrap };
            const compatibleIdsBootstrap = new Set(compatiblesTrasCorreccionBootstrap.map(o => o.idTemporal));
            oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(parsedTrasCorreccionBootstrap.oportunidadesConversacionales, idTemporalARealParaFrontera())
              .filter(o => compatibleIdsBootstrap.has(o.idTemporal));
            trazaAutoridadEsteTurno.repair.outcome = 'REPAIRED_VIA_BOOTSTRAP_ACQUISITION_CORRECTION';
          } else if (oportunidadReadquiridaBootstrap && compatiblesTrasReadquisicionBootstrap.length > 0) {
            r = { ...r, parsed: parsedTrasReadquisicionBootstrap };
            const compatibleIdsReadquisicion = new Set(compatiblesTrasReadquisicionBootstrap.map(o => o.idTemporal));
            oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(parsedTrasReadquisicionBootstrap.oportunidadesConversacionales, idTemporalARealParaFrontera())
              .filter(o => compatibleIdsReadquisicion.has(o.idTemporal));
            trazaAutoridadEsteTurno.repair.outcome = 'REPAIRED_VIA_BOOTSTRAP_REACQUISITION';
          } else if (correccionFundamentoFresco && compatiblesTrasFundamentoFresco.length > 0) {
            r = { ...r, parsed: parsedTrasFundamentoFresco };
            grafoDelta = correccionFundamentoFresco.grafoNuevo;
            idTemporalARealEsteTurno = { ...idTemporalARealEsteTurno, ...correccionFundamentoFresco.idTemporalAReal };
            fronteraCognitivaAdmisibleEsteTurno = fronteraTrasFundamentoFresco;
            const compatibleIdsFundamentoFresco = new Set(compatiblesTrasFundamentoFresco.map(o => o.idTemporal));
            oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(parsedTrasFundamentoFresco.oportunidadesConversacionales, idTemporalARealParaFrontera())
              .filter(o => compatibleIdsFundamentoFresco.has(o.idTemporal));
            trazaAutoridadEsteTurno.repair.outcome = 'REPAIRED_VIA_FRESH_GROUNDING_CORRECTION';
          } else {
          const referenciasFrontera = fronteraCognitivaAdmisibleEsteTurno.map((f, index) => ({
            ref: `frontera_${index + 1}`,
            descriptor: f,
          }));
          const usaRebindEstructural = candidatosSemanticosCongelados.length > 0;
          // Post-governance only repairs representability of an already
          // proposed cognitive direction. A concept/anchor created from an
          // example does not authorize a second producer to invent a new
          // proposition about that domain. With no frozen candidate there
          // is nothing to rebind: the canonical Decision may still consume
          // a governed gain, but this seam cannot manufacture another WHAT.
          const repairSystem = usaRebindEstructural
            ? `Eres Círculo. REBIND_ESTRUCTURAL_POST_GOBERNANZA. Selecciona qué candidato semántico ya propuesto se vincula con qué referencias gobernadas. No vuelvas a proponer el WHAT. CANDIDATOS_CONGELADOS=${JSON.stringify(candidatosSemanticosCongelados.map(o => ({ candidateId: o.idTemporal, operation: o.operacion, semanticTarget: o.semanticTarget, evidenciaBuscada: o.evidenciaBuscada, satisfaccionConocimiento: o.satisfaccionConocimiento })))}; FRONTERA_COGNITIVA_ADMISIBLE=${JSON.stringify(referenciasFrontera.map(({ ref, descriptor: f }) => ({ ref, tipo: f.tipo, subjectRef: f.subjectRef || null, unknownRef: f.unknownRef || null, mission: f.mission || gramaticaActivaAlInicio, missionNeedRef: f.missionNeedRef || null, allowedOperations: f.allowedOperations || [], evidenciaConceptoIds: f.evidenciaConceptoIds || [], provenance: f.provenance || null })))};`
            : `Eres Círculo. PROPUESTA_COGNITIVA_POST_GOBERNANZA. Propón un candidato dentro del territorio tipado; puedes proponer el WHAT, pero no autorizarlo ni crear evidencia, conceptos, relaciones o unknowns. Si la entrada es EXISTING_GOVERNED_UNKNOWN, copia su unknownRef exacto únicamente en semanticUnknownId (identidad); semanticTarget debe ser el contenido semántico que propones explorar y nunca un id opaco. Decision Authority decidirá si acepta la propuesta. La satisfaccionConocimiento debe respetar la forma canónica: PARCIAL exige un residuoSemantico estructurado completo; si no hay residuo estructurado, usa ABIERTA (no null con PARCIAL). FRONTERA_COGNITIVA_ADMISIBLE=${JSON.stringify(fronteraCognitivaAdmisibleEsteTurno.map(f => ({ tipo: f.tipo, subjectRef: f.subjectRef || null, unknownRef: f.unknownRef || null, mission: f.mission || gramaticaActivaAlInicio, missionNeedRef: f.missionNeedRef || null, allowedOperations: f.allowedOperations || (f.operation ? [f.operation] : []), evidenciaConceptoIds: f.evidenciaConceptoIds || [], provenance: f.provenance || null })))};`;
          const responseSchemaRepair = usaRebindEstructural
            ? buildCapa1CandidateRebindSchema(
              candidatosSemanticosCongelados.map(o => o.idTemporal),
              referenciasFrontera.map(f => f.ref),
            )
            : buildCapa1CandidateRepairSchema(gramaticaActivaAlInicio);
          // C007 — CONTENT-REJECTED RESIDUE MUST REPAIR WITHIN FROZEN
          // COGNITIVE DIRECTION. This call previously only dispatched for
          // the rebind branch -- the PROPUESTA_COGNITIVA_POST_GOBERNANZA
          // system/schema above were already fully built but never sent.
          // It now ALSO dispatches for the PROPUESTA branch, but ONLY when
          // debeRepararCandidatoEnFrontera fired specifically because of a
          // genuine content rejection (esReparacionPorContenidoRechazado) --
          // never for the OTHER, pre-existing, differently-scoped reason
          // (zero compatible candidates with no content rejection at all),
          // which must keep behaving exactly as before this fix (a
          // deliberate no-op: dispatchRepair stays null, nothing changes).
          const dispatchRepair = usaRebindEstructural || esReparacionPorContenidoRechazado;
          trazaAutoridadEsteTurno.repair.mode = usaRebindEstructural
            ? 'STRUCTURAL_REBIND' : (esReparacionPorContenidoRechazado ? 'CONTENT_PROPUESTA' : null);
          trazaAutoridadEsteTurno.repair.dispatched = dispatchRepair;
          const repair = dispatchRepair
            ? await llmServiceProductorActivo.call({ system: repairSystem, userMsg: mensajeUsuario, label: gramaticaActivaAlInicio, callProfile: 'GENERACION_COGNITIVA_ESTRUCTURADA', responseMimeType: 'application/json', responseSchema: responseSchemaRepair, turnoId: turnoIdReservadoEnAdmision })
            : null;
          const repairDisponible = !!(repair && repair.parsed);
          if (dispatchRepair && !repairDisponible && !(repair && repair.errorCategory)
            && respuestaDirigidaSatisfaceActoPrevioEsteTurno()) {
            // The optional search for a NEW act produced no usable payload
            // (not an infrastructure failure), but the verified directed
            // response already satisfied the previous act: response-only,
            // provided the visible machinery can express it (see
            // falloReparacionDiferido).
            falloReparacionDiferido = { outcome: 'TRANSPORT_FAILURE' };
            trazaAutoridadEsteTurno.repair.outcome = 'NO_NEW_ACT_ADMISSIBLE_RESPONSE_SATISFIED_PREVIOUS_ACT';
          } else if (dispatchRepair && !repairDisponible) {
            const providerFailure = Boolean(repair && repair.errorCategory);
            const category = providerFailure ? repair.errorCategory : null;
            const retryable = providerFailure ? retryableDesdeErrorCategory(category) : false;
            const codigoFalloRepair = providerFailure ? 'LLM_UNAVAILABLE' : 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER';
            this._marcarEntradaFallidaSiEsSeguro({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, causa: codigoFalloRepair, errorCategory: category, retryable });
            trazaAutoridadEsteTurno.repair.outcome = 'TRANSPORT_FAILURE';
            trazaAutoridadEsteTurno.visibleRoute = 'NONE';
            trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
            this._emitirTrazaAutoridad({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, traza: trazaAutoridadEsteTurno, commit: false, failureClass: codigoFalloRepair });
            return { ok: false, httpStatus: 502, codigo: codigoFalloRepair, mensaje: providerFailure ? 'El motor no produjo una respuesta cognitiva válida.' : MENSAJE_OPERACIONAL_FALLO_GENERICO, errorCategory: category, retryable };
          }
          if (dispatchRepair && repairDisponible) {
            let oportunidadesReparadas = repair.parsed.oportunidadesConversacionales || [];
            if (usaRebindEstructural) {
              const base = candidatosSemanticosCongelados.find(o =>
                o.idTemporal === repair.parsed.candidateId);
              const refsSolicitadas = Array.isArray(repair.parsed.frontierRefs)
                ? [...new Set(repair.parsed.frontierRefs)] : [];
              const bindingsSolicitados = refsSolicitadas
                .map(ref => referenciasFrontera.find(f => f.ref === ref))
                .filter(Boolean)
                .map(f => f.descriptor)
                .filter(f => base && (f.allowedOperations || []).includes(base.operacion));
              // STRUCTURAL_REBIND_PRESERVES_OPPORTUNITY_MISSION_DIMENSION --
              // rebind binds IDENTITY; it never rewrites the mission semantics
              // the opportunity or the unknown already declared (see
              // RebindEstructuralPolicy). A frontier unknown incoherent with
              // the dimension the Producer declared is not a bindable target
              // for this opportunity.
              const dimensionDeclarada = base ? base.dimension : null;
              const bindings = bindingsSolicitados.filter(f => dimensionCoherenteConBinding(dimensionDeclarada, f));
              if (base && bindings.length === refsSolicitadas.length && bindings.length > 0) {
                const subjectRefs = [...new Set(bindings.flatMap(f => [
                  f.subjectRef, ...(f.evidenciaConceptoIds || []),
                ]).filter(Boolean))];
                const unknownRefs = [...new Set(bindings.map(f => f.unknownRef).filter(Boolean))];
                oportunidadesReparadas = [{
                  ...base,
                  subjectRef: subjectRefs[0] || null,
                  semanticUnknownId: unknownRefs[0] || null,
                  unknownId: null,
                  anclajeConceptoIds: subjectRefs,
                  dimension: dimensionTrasRebind(dimensionDeclarada, bindings[0]),
                  satisfaccionConocimiento: {
                    ...base.satisfaccionConocimiento,
                    evidenciaConceptoIds: subjectRefs.length > 0
                      ? subjectRefs
                      : base.satisfaccionConocimiento.evidenciaConceptoIds,
                  },
                }];
              } else if (base && refsSolicitadas.length > 0 && bindingsSolicitados.length === refsSolicitadas.length) {
                // Dimension incoherent with every requested unknown: no binding.
                // The original opportunity stays intact (neither side rewritten).
                oportunidadesReparadas = [base];
              } else {
                oportunidadesReparadas = [];
              }
            } else {
              // PROPUESTA_COGNITIVA_POST_GOBERNANZA: this candidate was
              // authored fresh by repair, never yet evaluated by any
              // governance. REPAIRED_CANDIDATE MUST_REENTER_THE_GOVERNANCE_
              // THAT_AUTHORIZES_PUBLICATION -- the exact same identity +
              // content-novelty gate that governed the Producer's own
              // first-pass oportunidades runs again here, unchanged, before
              // this proposal is ever accepted. When no directed parent
              // governs this turn (actoDirigidoPrevio null),
              // evaluarOportunidadConGobernanzaDeNovedad's own early return
              // passes everything through unchanged -- never a new
              // restriction on turns this fix does not concern. Bounded:
              // exactly this one repair + one re-governance pass, no loop --
              // rejection here fails closed via the existing frontier
              // -incompatibility branch below, never a silent reopen of the
              // satisfied parent, never a second repair attempt.
              const normalizadas = normalizarOportunidadesConversacionales(oportunidadesReparadas, idTemporalARealEsteTurno);
              const regobernadas = [];
              for (const candidata of normalizadas) {
                const aceptada = await evaluarOportunidadConGobernanzaDeNovedad(candidata);
                if (aceptada) regobernadas.push(aceptada);
              }
              oportunidadesReparadas = regobernadas;
            }
            const repaired = {
              ...r.parsed,
              oportunidadesConversacionales: oportunidadesReparadas,
              gananciaCognitiva: usaRebindEstructural
                ? r.parsed.gananciaCognitiva
                : (repair.parsed.gananciaCognitiva || null),
            };
            if (candidatosCompatiblesConFrontera(repaired, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario).length > 0) {
              r = { ...r, parsed: repaired };
              const compatibleIds = new Set(candidatosCompatiblesConFrontera(repaired, fronteraCognitivaAdmisibleEsteTurno, idTemporalARealParaFrontera(), grafoDelta, mensajeUsuario).map(o => o.idTemporal));
              oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(repaired.oportunidadesConversacionales, idTemporalARealParaFrontera())
                .filter(o => compatibleIds.has(o.idTemporal));
            } else {
              // CONTENT_CLOSURE_REPAIR (PRODUCER_CROSS_FIELD_REFERENTIAL_
              // SELF_INCONSISTENCY cluster, second call site -- covers the
              // sub-path where STRUCTURAL_REBIND/PROPUESTA above already
              // ran and still failed, because the candidate they had to
              // work with (this turn's FINAL attempt) is a DIFFERENT one
              // from the EARLIER attempt that actually carried the
              // dangling-but-otherwise-legitimate WHAT. Tried only once,
              // only here, only after the existing repair outcome above has
              // already failed -- never a second STRUCTURAL_REBIND/PROPUESTA
              // attempt, never a loop.
              const reparacionCierre = mejorCandidatoColganteEsteTurno
                ? await intentarReparacionCierreReferencial({
                  candidato: mejorCandidatoColganteEsteTurno, mensajeUsuario,
                  grafoBase: grafoDelta || estadoActual.knowledgeGraph,
                  idTemporalAReal: idTemporalARealEsteTurno,
                  llmService: llmServiceProductorActivo,
                  turnoId: turnoIdReservadoEnAdmision, turnoClienteId,
                  gramatica: gramaticaActivaAlInicio,
                  contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
                  grafoAntesDelTurno: estadoActual.knowledgeGraph,
                })
                : null;
              // FRONTIER_MUST_BE_REBUILT_AFTER_A_NEW_COMMIT -- the existing
              // fronteraCognitivaAdmisibleEsteTurno was constructed BEFORE
              // this repair ever ran, against the OLD grafoDelta -- it
              // structurally cannot contain an ADMISSIBILITY_ENVELOPE entry
              // for a concept this repair just committed. Reusing the stale
              // frontier here would silently and incorrectly reject every
              // successful repair. Rebuild it, exactly like the original
              // frontier-construction call above, now against the NEW graph.
              const fronteraTrasCierre = reparacionCierre
                ? construirFronteraCognitivaAdmisible({
                  grafo: reparacionCierre.grafoNuevo, gramatica: gramaticaActivaAlInicio,
                  slots: estadoActual.slots || {}, dimension: dimensionFrontera,
                  idTemporalAReal: { ...idTemporalARealEsteTurno, ...reparacionCierre.idTemporalAReal },
                  conceptosHipotesisAbierta: conceptosHipotesisAbiertaEsteTurno,
                })
                : [];
              const compatiblesTrasCierre = reparacionCierre
                ? candidatosCompatiblesConFrontera(reparacionCierre.parsed, fronteraTrasCierre, { ...idTemporalARealEsteTurno, ...reparacionCierre.idTemporalAReal }, reparacionCierre.grafoNuevo, mensajeUsuario)
                : [];
              if (reparacionCierre && compatiblesTrasCierre.length > 0) {
                r = { ...r, parsed: reparacionCierre.parsed };
                grafoDelta = reparacionCierre.grafoNuevo;
                idTemporalARealEsteTurno = { ...idTemporalARealEsteTurno, ...reparacionCierre.idTemporalAReal };
                fronteraCognitivaAdmisibleEsteTurno = fronteraTrasCierre;
                if (contratoRespuestaDirigidaEsteTurno) {
                  relacionRespuestaDirigidaTraza = reparacionCierre.relacionDirigida.relacionTraza;
                  alineacionRespuestaDirigidaResultadoTraza = reparacionCierre.relacionDirigida.alineacionTraza;
                }
                const compatibleIdsCierre = new Set(compatiblesTrasCierre.map(o => o.idTemporal));
                oportunidadesGobernadasEsteTurno = normalizarOportunidadesConversacionales(reparacionCierre.parsed.oportunidadesConversacionales, idTemporalARealParaFrontera())
                  .filter(o => compatibleIdsCierre.has(o.idTemporal));
                // CANDIDATE-SCOPED SALVAGE -- never report a dropped/salvaged
                // gain as a full content closure (reparacionCierre.outcome
                // distinguishes them; see intentarReparacionCierreReferencial).
                trazaAutoridadEsteTurno.repair.outcome = reparacionCierre.outcome || 'REPAIRED_VIA_CONTENT_CLOSURE';
              } else if (respuestaDirigidaSatisfaceActoPrevioEsteTurno()) {
                // GOVERNED_RESPONSE_MAY_COMMIT_WITHOUT_NEW_CURRENT_WHAT -- the
                // optional repair of a NEW act found nothing admissible, but
                // this turn's verified directed response already satisfied
                // the previous act: the turn commits as a response-only turn
                // (no new current act is synthesized, nothing is fabricated).
                falloReparacionDiferido = { outcome: 'REPAIRED_CANDIDATE_REJECTED_BY_REGOVERNANCE' };
                trazaAutoridadEsteTurno.repair.outcome = 'NO_NEW_ACT_ADMISSIBLE_RESPONSE_SATISFIED_PREVIOUS_ACT';
              } else {
                this._marcarEntradaFallidaSiEsSeguro({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, causa: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER', errorCategory: null, retryable: false });
                trazaAutoridadEsteTurno.repair.outcome = 'REPAIRED_CANDIDATE_REJECTED_BY_REGOVERNANCE';
                trazaAutoridadEsteTurno.visibleRoute = 'NONE';
                trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
                this._emitirTrazaAutoridad({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, traza: trazaAutoridadEsteTurno, commit: false, failureClass: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER' });
                return { ok: false, httpStatus: 502, codigo: 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER', mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO };
              }
            }
          }
          } // closes the CONTENT_CLOSURE_REPAIR early-attempt `else` above
        }
      }

      // circulomejora006 — Comprensión conversacional, selector cognitivo de
      // DESTINO/EXPLORANDO (Especificación, corrección final §1/§3): corre
      // ANTES de la Gobernanza de Materialización, nunca subordinado a que
      // Gobernanza ya haya elegido Transformar — el movimiento existe (y se
      // traza) sea cual sea la estrategia que Gobernanza termine
      // seleccionando por sus propias Garantías, que esta corrección NUNCA
      // toca ni evade. (contratoMovimientoDestino/dimensionEnFocoNuevo
      // declaradas a nivel de función — ver más arriba — solo se reasignan
      // aquí, nunca se redeclaran.)
      dimensionEnFocoNuevo = estadoActual.protocoloDimensionEnFoco || null;
      const referenciaRespuestaPreDecision = contratoRespuestaDirigidaEsteTurno
        && contratoRespuestaDirigidaEsteTurno.referenciaResolucion;
      if (referenciaRespuestaPreDecision && alineacionRespuestaDirigidaResultadoTraza
        && alineacionRespuestaDirigidaResultadoTraza.satisfaccionReparacion) {
        const reparacionPreDecision = estadoActual.protocoloReparacionesInterpretativasPendientes
          && estadoActual.protocoloReparacionesInterpretativasPendientes[referenciaRespuestaPreDecision.obligacionId];
        const materialesPreDecision = grafoDelta && Array.isArray(grafoDelta.conceptos)
          ? grafoDelta.conceptos.filter(concepto => !idsConceptosAntesTurno.has(concepto.id)) : [];
        if (reparacionPreDecision) {
          const propuestaPreDecision = alineacionRespuestaDirigidaResultadoTraza.satisfaccionReparacion;
          const normalizadaPreDecision = normalizarPropuestaSatisfaccion({
            reparacion: reparacionPreDecision,
            propuesta: propuestaPreDecision,
            materialIdsDisponibles: materialesPreDecision,
          });
          if (normalizadaPreDecision) {
            certificacionSatisfaccionResolucionEsteTurno = certificarSatisfaccionReparacion({
              reparacion: reparacionPreDecision,
              criterioSatisfaccion: reparacionPreDecision.criterioSatisfaccion,
              obligacionId: reparacionPreDecision.obligacionId,
              intentoInterpretacionId: reparacionPreDecision.intentoInterpretacionId,
              materialIds: normalizadaPreDecision.materialIds,
              materialesDisponibles: materialesPreDecision,
              satisface: normalizadaPreDecision.satisface,
              fuente: 'RESPUESTA_DIRIGIDA',
            });
          }
        }
      }
      if (!certificacionSatisfaccionResolucionEsteTurno && certificacionesSatisfaccionReparacionEsteTurno.length > 0) {
        for (const propuesta of certificacionesSatisfaccionReparacionEsteTurno) {
          const obligacion = propuesta && `reparar_interpretacion:${propuesta.intentoInterpretacionId}`;
          const reparacion = obligacion && estadoActual.protocoloReparacionesInterpretativasPendientes
            && estadoActual.protocoloReparacionesInterpretativasPendientes[obligacion];
          const materiales = grafoDelta && Array.isArray(grafoDelta.conceptos)
            ? grafoDelta.conceptos.filter(concepto => !idsConceptosAntesTurno.has(concepto.id)) : [];
          const normalizada = reparacion && normalizarPropuestaSatisfaccion({ reparacion, propuesta, materialIdsDisponibles: materiales });
          if (normalizada) {
            certificacionSatisfaccionResolucionEsteTurno = certificarSatisfaccionReparacion({
              reparacion, criterioSatisfaccion: reparacion.criterioSatisfaccion,
              obligacionId: reparacion.obligacionId, intentoInterpretacionId: reparacion.intentoInterpretacionId,
              materialIds: normalizada.materialIds, materialesDisponibles: materiales,
              satisface: normalizada.satisface, fuente: 'RECONCILIACION',
            });
            break;
          }
        }
      }
      const reparacionesAntesDireccion = proyectarReparacionesPendientes(
        estadoActual.protocoloReparacionesInterpretativasPendientes,
      );
      const reparacionesParaDireccion = certificacionSatisfaccionResolucionEsteTurno
        ? reparacionesAntesDireccion.filter(r => r.obligacionId !== certificacionSatisfaccionResolucionEsteTurno.obligacionId)
        : reparacionesAntesDireccion;
      const resueltaIdParaDireccion = certificacionSatisfaccionResolucionEsteTurno
        && certificacionSatisfaccionResolucionEsteTurno.obligacionId;
      const activaActualParaDireccion = estadoActual.obligacionCognitivaActivaId || null;
      const obligacionActivaParaDireccion = resueltaIdParaDireccion
        && activaActualParaDireccion === resueltaIdParaDireccion
        ? null : activaActualParaDireccion;
      const obligacionesParaDireccion = certificacionSatisfaccionResolucionEsteTurno
        ? obligacionesCognitivasAbiertas.filter(o => o && o.obligacionId !== certificacionSatisfaccionResolucionEsteTurno.obligacionId)
        : obligacionesCognitivasAbiertas;
      // La autoridad se deriva del estado y configuración del Writer, no de
      // ningún campo que haya podido devolver Generación. Esto mantiene una
      // única fuente para la proyección de next_user_action.
      // La autoridad final de Movimiento se calcula después de la
      // reconciliación, sobre la reparación que acaba de nacer (si la hay).
      // `promptBase` conserva deliberadamente la fotografía previa para
      // Generación; no puede gobernar esta fase downstream.
      destinoMovimientoAplicaEsteTurno = gramaticaActivaAlInicio === 'destino'
        && protocoloEstadoEfectivo === 'EXPLORANDO'
        && (this._movimientoConversacionalEnabled || reparacionesPendientesEsteTurno.length > 0
          || obligacionesCognitivasAbiertas.some(o => o.clase === 'REPARACION'));
      movimientoMisionAplicaEsteTurno = !!(
        gramaticaActivaAlInicio !== 'destino'
        && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
        && protocoloEstadoEfectivo === 'EXPLORANDO'
        && this._movimientoConversacionalEnabled
      );
      if (movimientoMisionAplicaEsteTurno) {
        movimientoComunEsteTurno = null;
      }
      senalCierreConversacionalAplicaEsteTurno = promptBase.senalCierreConversacionalActiva;
      // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — cuando Movimiento en sí NO
      // gobierna este turno (flag experimental apagado, el caso real de
      // todo despliegue de este proyecto) pero la señal de cierre SÍ está
      // activa (senalCierreConversacionalActiva, ver promptBase), P1-B
      // igual debe decidir y persistir el objetivo conversacional — nunca
      // se calculaba antes, así que protocoloIntencionCierre nunca existía
      // fuera de Movimiento. Misma llamada exacta que el bloque de abajo
      // usa para el caso Movimiento-activo (mismo grafo, misma señal, misma
      // continuidad) — nunca alimenta decidirMovimientoDestino ni
      // contratoMovimientoDestino: eso sigue siendo exclusivo del bloque de
      // abajo, sin cambios. Mutuamente exclusivo con ese bloque (if/else),
      // nunca calcula dos veces.
      // HORIZONTE01_P0K — una evaluación NO_PROPUESTA/NO_AGREGA_COMPRENSION
      // no reconoce una interpretación; registra únicamente la fotografía
      // de evidencia que ya fue evaluada para que esta misma oportunidad no
      // vuelva a crear deuda. Si aparece evidencia nueva, los ids cambian y
      // la oportunidad vuelve a ser evaluable.
      dimensionesInterpretacionSinGananciaEsteTurno = {
        ...(estadoActual.protocoloDimensionesInterpretacionSinGanancia || {}),
      };
      if (
        interpretacionPreparadaParaDimension
        && evaluacionInterpretacionResultado === 'NO_PROPUESTA'
        && evaluacionInterpretacionRazon === 'NO_AGREGA_COMPRENSION'
      ) {
        const grafoEvaluado = grafoDelta || estadoActual.knowledgeGraph;
        dimensionesInterpretacionSinGananciaEsteTurno[interpretacionPreparadaParaDimension] = (grafoEvaluado.conceptos || [])
          .filter(c => c && c.activo !== false && c.autoridad === 'experto'
            && dimensionDeProcedencia(c.procedencia) === interpretacionPreparadaParaDimension)
          .map(c => c.id)
          .sort();
      }

      const decisionTipadaOrdinaria = !destinoMovimientoAplicaEsteTurno
        && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
        && protocoloEstadoEfectivo === 'EXPLORANDO'
        && r.parsed
        && (oportunidadesGobernadasEsteTurno.length > 0
          || (typeof r.parsed.gananciaCognitiva === 'string'
            && r.parsed.gananciaCognitiva.trim())
          // STEADY_STATE_REQUIRED_NEED_BOOTSTRAP correction (C007,
          // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_
          // DECISION, Daniel-adjudicated, real evidence: logistica_c0 turns
          // 13-49). Without this clause, a turn whose Producer proposed
          // NOTHING frontier-compatible AND no free-form gananciaCognitiva
          // never even reaches decidirObjetivoConversacional (and therefore
          // never reaches direccionMision's own steady-state fallback,
          // below) -- the turn fails outright
          // (COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER) instead
          // of ever trying the required-need bootstrap. Scoped to non-
          // destino grammars only (destino's own ladder is untouched,
          // governed entirely by destinoMovimientoAplicaEsteTurno above);
          // reuses the SAME authoritative owner
          // (GrafoProyeccion.dimensionesPendientes) as every other check in
          // this cluster, never a parallel notion.
          || (gramaticaActivaAlInicio !== 'destino'
            && dimensionesPendientesDeGrafo(grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio).length > 0));
      if (decisionTipadaOrdinaria
        || (!destinoMovimientoAplicaEsteTurno && promptBase.senalCierreConversacionalActiva && r.parsed)) {
        const intencionPreviaActivaSinMovimiento = !!(
          estadoActual.protocoloIntencionCierre
          && (estadoActual.protocoloIntencionCierre.estado === 'ACTIVA'
              || estadoActual.protocoloIntencionCierre.estado === 'BLOQUEADA_POR_DEUDA_DURA')
        );
        objetivoConversacionalEsteTurno = decidirObjetivoConversacional({
          senalEsteTurno: senalesCierreAceptadas.length > 0,
          intencionActivaPrevia: intencionPreviaActivaSinMovimiento,
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          gramatica: gramaticaActivaAlInicio,
          slots: estadoActual.slots || {},
          reparacionesInterpretativasPendientes: reparacionesParaDireccion,
          obligacionesCognitivasAbiertas: obligacionesParaDireccion,
          obligacionCognitivaActivaId: obligacionActivaParaDireccion,
          dimensionesDiferidas: estadoActual.protocoloDimensionesInterpretacionDiferida || [],
          dimensionesSinGanancia: dimensionesInterpretacionSinGananciaEsteTurno,
          contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
          respuestaDirigida: relacionRespuestaDirigidaTraza,
          oportunidadesConversacionales: oportunidadesGobernadasEsteTurno,
          comprensionTrabajo: comprensionTrabajoEsteTurno,
          focoConversacionalActual,
          cognicionCapa1: r.parsed,
          directedUnknownId: contratoRespuestaDirigidaEsteTurno
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
          directedResponseTurnId: turnoClienteId,
        });
        if (semanticUnknownIdEsteTurno && objetivoConversacionalEsteTurno) {
          objetivoConversacionalEsteTurno = {
            ...objetivoConversacionalEsteTurno,
            semanticUnknownId: semanticUnknownIdEsteTurno,
          };
        }
      } else if (destinoMovimientoAplicaEsteTurno && r.parsed) {
        const nivelDestino = calcularNivelLenguaje(
          state.knowledgeGraph, estadoActual.knowledgeGraph,
          grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio,
        );
        // P1-B (circulomejora006 — autoridad de objetivo conversacional
        // ante cierre) — se calcula AQUÍ, sobre el MISMO grafo que
        // decidirMovimientoDestino está por consultar, y ANTES de esa
        // llamada: la garantía central de este incremento es que la
        // señal (P1-A) de ESTE turno pueda gobernar la respuesta de ESTE
        // mismo turno, nunca solo la del siguiente (ver auditoría P1-B,
        // Fase 1). `intencionActivaPrevia` lee protocoloIntencionCierre
        // TAL COMO entró el turno (estadoActual, post-reconciliación) —
        // nunca inventa continuidad, solo la que ya era durable.
        const intencionPreviaActiva = !!(
          estadoActual.protocoloIntencionCierre
          && (estadoActual.protocoloIntencionCierre.estado === 'ACTIVA'
              || estadoActual.protocoloIntencionCierre.estado === 'BLOQUEADA_POR_DEUDA_DURA')
        );
        objetivoConversacionalEsteTurno = decidirObjetivoConversacional({
          senalEsteTurno: senalesCierreAceptadas.length > 0,
          intencionActivaPrevia: intencionPreviaActiva,
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          gramatica: gramaticaActivaAlInicio,
          slots: estadoActual.slots || {},
          reparacionesInterpretativasPendientes: reparacionesParaDireccion,
          obligacionesCognitivasAbiertas: obligacionesParaDireccion,
          obligacionCognitivaActivaId: obligacionActivaParaDireccion,
          dimensionesDiferidas: estadoActual.protocoloDimensionesInterpretacionDiferida || [],
          contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
          respuestaDirigida: relacionRespuestaDirigidaTraza,
          oportunidadesConversacionales: oportunidadesGobernadasEsteTurno,
          comprensionTrabajo: comprensionTrabajoEsteTurno,
          focoConversacionalActual,
          cognicionCapa1: r.parsed,
          directedUnknownId: contratoRespuestaDirigidaEsteTurno
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
            && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
          directedResponseTurnId: turnoClienteId,
        });
        if (semanticUnknownIdEsteTurno && objetivoConversacionalEsteTurno) {
          objetivoConversacionalEsteTurno = {
            ...objetivoConversacionalEsteTurno,
            semanticUnknownId: semanticUnknownIdEsteTurno,
          };
        }
        const actoCognitivoTransportado = objetivoConversacionalEsteTurno
          && Object.prototype.hasOwnProperty.call(objetivoConversacionalEsteTurno, 'actoCognitivoSeleccionado')
          ? objetivoConversacionalEsteTurno.actoCognitivoSeleccionado
          : undefined;
        let resultadoMovimiento = actoCognitivoTransportado === null
          ? { movimiento: null, codigoRazon: 'NO_COGNITIVE_ACT_AVAILABLE', dimensionObjetivo: null }
          : decidirMovimientoDestino({
          grafo: grafoDelta || estadoActual.knowledgeGraph,
          nivel: nivelDestino,
          // circulomejora006 (corrección final — rechazo visible por
          // identidad): decidirMovimientoDestino recibe la señal YA
          // filtrada por intersección de ids (huboRechazoVisibleEsteTurno/
          // dimensionesRechazadasVisiblesEsteTurno) — nunca la cruda. Un
          // rechazo de inferencia interna nunca mostrada corrige el grafo
          // (ver arriba) pero nunca llega hasta aquí como motivo de
          // REPARAR_TRAS_RECHAZO.
          dimensionEnFocoAnterior: estadoActual.protocoloDimensionEnFoco || null,
          // circulomejora006 (corrección posterior a la prueba real) —
          // fuente única de verdad: CognitiveState.protocoloDimensionesInterpretacionDiferida,
          // tal como entró este turno (post-reconciliación, mismo momento
          // que dimensionEnFocoAnterior de arriba).
          dimensionesDiferidas: estadoActual.protocoloDimensionesInterpretacionDiferida || [],
          reparacionesInterpretativasPendientes: reparacionesParaDireccion,
          dimensionesSinGanancia: dimensionesInterpretacionSinGananciaEsteTurno,
          // P1-B — único punto donde el objetivo llega a Movimiento.
          objetivoConversacional: objetivoConversacionalEsteTurno,
          // T-DIM2 Fase 6 — relación YA declarada y validada por Capa 1
          // este mismo turno (relacionRespuestaDirigidaTraza, calculado
          // arriba, en la validación de construcción) — nunca gobierna
          // dimensión ni movimiento, solo enriquece el texto libre
          // `objetivo` cuando la pregunta de este turno continúa la misma
          // deuda dura de antes (ver decidirMovimientoDestino).
          relacionRespuestaDirigidaAnterior: gramaticaActivaAlInicio === 'destino'
            ? (relacionRespuestaDirigidaTraza && contratoRespuestaDirigidaEsteTurno
              ? {
                  ...relacionRespuestaDirigidaTraza,
                  // El movimiento anterior forma parte de la autoridad del
                  // contrato, aunque no del JSON que declara la relación.
                  // Permite distinguir bloqueo de expresión de ejemplo ya
                  // solicitado e indisponible.
                  movimiento: contratoRespuestaDirigidaEsteTurno.movimiento,
                  viaAcceso: contratoRespuestaDirigidaEsteTurno.viaAcceso,
                  unknownId: contratoRespuestaDirigidaEsteTurno.unknownId,
                  desconocidoPreguntableScoped: contratoRespuestaDirigidaEsteTurno.desconocidoPreguntableScoped,
                  actoInterrogativo: contratoRespuestaDirigidaEsteTurno.actoInterrogativo,
                  resultadoViaAcceso: relacionRespuestaDirigidaTraza && relacionRespuestaDirigidaTraza.resultadoViaAcceso,
                }
              : relacionRespuestaDirigidaTraza)
            : null,
          // La preparación es una capacidad calculada por la misma policy
          // sobre el snapshot previo.  Movimiento decide aquí si la nueva
          // evidencia ya puede proponer una interpretación o si debe
          // conservar la alternativa exploratoria ejecutable.
          movimientoPreparado: resultadoMovimientoPreparado,
          evaluacionInterpretacion: {
            resultado: evaluacionInterpretacionResultado,
            razon: evaluacionInterpretacionRazon,
          },
          obligacionesCognitivasAbiertas,
          // DESTINO_OPTIONAL_DEPTH_STARVES_REQUIRED_COVERAGE -- pre-turn
          // governed mission coverage (GrafoProyeccion.dimensionesPendientes
          // against estadoActual.knowledgeGraph, computed once above, BEFORE
          // this turn's own Producer/repair/reconciliation could add a fresh
          // optional reason to stay) -- this call's own `grafo` above is
          // grafoDelta (POST this turn's commits), deliberately a DIFFERENT
          // snapshot; transported, never re-derived here.
          misionPendienteAntesDeOpcional: pendientesCoberturaAntes,
          });
        // P0K — la identidad materializable se comprueba antes de congelar
        // el movimiento como contrato. Si PROPONER no tiene una propuesta
        // inferida válida de ESTE turno, se registra la misma fotografía de
        // evidencia y se reevalúa la autoridad normal para otra necesidad;
        // no se convierte el candidato imposible en contrato.
        const evaluacionSinGananciaAutorizada = evaluacionInterpretacionResultado === 'NO_PROPUESTA'
          && evaluacionInterpretacionRazon === 'NO_AGREGA_COMPRENSION';
        if (
          actoCognitivoTransportado !== null
          &&
          resultadoMovimiento
          && resultadoMovimiento.movimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION
          && evaluacionSinGananciaAutorizada
          && !(
            evaluacionInterpretacionResultado === 'PROPUESTA'
            && conceptoIdInterpretacionValidado
            && (grafoDelta || estadoActual.knowledgeGraph).conceptos.some(c =>
              c && c.id === conceptoIdInterpretacionValidado
              && c.activo === true
              && c.autoridad === 'inferido'
              && c.origenAbstraccion === true
              && dimensionDeProcedencia(c.procedencia) === resultadoMovimiento.dimensionObjetivo
              && !c.materializadoEnTurno)
          )
        ) {
          const dimensionSinGanancia = resultadoMovimiento.dimensionObjetivo;
          const grafoEvaluado = grafoDelta || estadoActual.knowledgeGraph;
          dimensionesInterpretacionSinGananciaEsteTurno[dimensionSinGanancia] = (grafoEvaluado.conceptos || [])
            .filter(c => c && c.activo !== false && c.autoridad === 'experto'
              && dimensionDeProcedencia(c.procedencia) === dimensionSinGanancia)
            .map(c => c.id)
            .sort();
          resultadoMovimiento = decidirMovimientoDestino({
            grafo: grafoEvaluado,
            nivel: nivelDestino,
            dimensionEnFocoAnterior: estadoActual.protocoloDimensionEnFoco || null,
            dimensionesDiferidas: estadoActual.protocoloDimensionesInterpretacionDiferida || [],
            dimensionesSinGanancia: dimensionesInterpretacionSinGananciaEsteTurno,
            reparacionesInterpretativasPendientes: reparacionesParaDireccion,
          objetivoConversacional: objetivoConversacionalEsteTurno,
          evaluacionInterpretacion: {
            resultado: evaluacionInterpretacionResultado,
            razon: evaluacionInterpretacionRazon,
          },
          obligacionesCognitivasAbiertas,
          // DESTINO_OPTIONAL_DEPTH_STARVES_REQUIRED_COVERAGE -- same
          // transported pre-turn governed signal as the other two call
          // sites, never re-derived here.
          misionPendienteAntesDeOpcional: pendientesCoberturaAntes,
        });
        }
        // circulomejora006 (evaluacionInterpretacion, corrección de carrera
        // — auditoría aprobada) — decisión CRUDA, conservada sin mutar para
        // observabilidad (comprensionConversacional.movimientoDecididoCrudo,
        // más abajo) — nunca la fuente de lo que este turno ejecuta.
        resultadoMovimientoDecididoCrudo = resultadoMovimiento;
        if (!resultadoMovimiento || !resultadoMovimiento.movimiento
          || resultadoMovimiento.codigoRazon === ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES) {
          // Especificación §5 — no se inventa movimiento; el Realizador no
          // corre por causa del selector. ProgresoConversacionalPolicy
          // (decidirProtocolo, más abajo en decidirInteraccion) ya resuelve
          // la transición vía su propio evento COBERTURA_COMPLETADA, sin
          // ayuda ni conocimiento de este selector.
          contratoMovimientoDestino = null;
          dimensionEnFocoNuevo = null;
        } else {
          // circulomejora006_reporte19 — auditoría de a068003 (Opción B):
          // la costura Movimiento→D1 (ContinuidadMovimientoDestinoOrquestacion.js,
          // evaluarContinuidadMovimientoDestino) queda desconectada del
          // Writer, no eliminada. Evidencia: con el único productor de
          // deudasPosibles en alcance (proyectarDeudasPosiblesDestino), la
          // deuda se deriva SIEMPRE del mismo candidato que D1 evalúa
          // (deuda.dimension = candidato.dimensionObjetivo, copiado un paso
          // antes de compararse contra sí mismo) — decisionContinuidad es
          // CONTINUAR en el 100% de las entradas productivamente
          // alcanzables desde este punto, para los 5 movimientos posibles.
          // Reconectar esta línea a evaluarContinuidadMovimientoDestino es
          // un cambio de una sola línea, ya escrito y ya probado
          // (ContinuidadMovimientoDestinoOrquestacion.js + su suite de 11
          // casos, sin tocar) — pendiente de una fuente de deuda
          // independiente del propio candidato (identidad causal /
          // obligaciones abiertas, deliberadamente no construida todavía).
          contratoMovimientoDestino = {
            ...resultadoMovimiento,
            ...(objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.oportunidadSeleccionada
              ? { oportunidadConversacional: objetivoConversacionalEsteTurno.oportunidadSeleccionada }
              : {}),
          };
          dimensionEnFocoNuevo = resultadoMovimiento.dimensionObjetivo;
        }
      }
      if (movimientoMisionAplicaEsteTurno) {
        movimientoComunEsteTurno = decidirMovimiento(
          grafoDelta || estadoActual.knowledgeGraph,
          gramaticaActivaAlInicio,
          { objetivoConversacional: objetivoConversacionalEsteTurno },
        );
      }
      if (destinoMovimientoAplicaEsteTurno || movimientoMisionAplicaEsteTurno) {
        historialVisibleRecienteEsteTurno = this._unitOfWork.turnoRepo
          .paginar(sesionId, null, 3)
          .filter(turno => turno.turnoId !== turnoIdReservadoEnAdmision)
          .reverse()
          .map(turno => ({
            numeroDeTurno: turno.numeroDeTurno,
            mensajeExperto: turno.mensajeExperto,
            mensajeCirculo: turno.mensajeCirculo,
          }));
      }
      // Una decisión de Movimiento produce un único contrato canónico que
      // se transporta a todos los consumidores downstream.  La decisión ya
      // quedó fijada en contratoMovimientoDestino; no se reconstruye dentro
      // de una estrategia de materialización posterior.
      let gananciaGobernadaDeRespuesta = null;
      if (actoCognitivoCanonico === null) {
        let grafoParaDecisionCanonica = grafoDelta || estadoActual.knowledgeGraph;
        // MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET
        // (C007, LOGISTICA_C1_T19_ASK_VALUE_OF_KNOWN_REALIZATION_FIDELITY,
        // VKN-C). WHAT = TARGET + REQUESTED_FACET. The opportunity Decision
        // will consume (the first open one of the SAME governed list the
        // canonical state is built from) may be a VALUE act inside a typed
        // mission. Its requested facet is structural authority
        // (mission + dimension, Decision validates it); WHICH governed entity
        // that facet is about is decided here, once, by the existing target-
        // binding architecture (admissible governed set -> cardinality rule ->
        // bounded semantic binder) -- never by the Producer's first anchor
        // (FIRST_ANCHOR != TARGET_AUTHORITY) and never by Producer prose.
        // The binder decides ONLY which entity; it cannot cancel the need.
        // No bindable target => the value act does not become executable
        // (fail closed): it leaves the governed list instead of reaching the
        // Realizer with an unbound target.
        let vinculoValorFallo = false;
        // PROVIDER_FAILURE != SEMANTIC_NO_SELECTION: set only when the target
        // binder could not RUN (HTTP 400/429/5xx, timeout, transport) -- never
        // when it ran and selected no legal candidate.
        let fallaProveedorValor = null;
        // ACTIVE_REQUIRED_DIMENSION_OUTRANKS_NONPENDING_OPTIONAL_DEPTH.
        // MISSION_OBLIGATION_AUTHORITY IS DECIDED ONCE, by the Objective
        // policy (decidirObjetivoConversacional + its required-need
        // fallback): the Producer's raw opportunities that are not on the
        // Objective-selected required territory are optional depth /
        // memory, not the current executable obligation. This turn's
        // executable set is the Objective's verdict projected onto the list
        // -- the Writer neither re-derives mission priority nor picks "the
        // first raw open opportunity". The full list stays untouched (memory
        // and persistence); only what this gate and Decision may EXECUTE is
        // the projection.
        const prioridadMisionEsteTurno = particionarOportunidadesPorPrioridadDeMision(
          oportunidadesGobernadasEsteTurno, objetivoConversacionalEsteTurno);
        const idsOportunidadesCedidasEsteTurno = new Set(prioridadMisionEsteTurno.cedidas
          .map(o => o && o.idTemporal).filter(Boolean));
        const soloOportunidadesEjecutables = (lista) => lista
          .filter(o => !(o && idsOportunidadesCedidasEsteTurno.has(o.idTemporal)));
        trazaAutoridadEsteTurno.prioridadMision = {
          dimensionRequerida: prioridadMisionEsteTurno.dimensionRequerida,
          cedidas: prioridadMisionEsteTurno.cedidas
            .map(o => ({ id: o && o.idTemporal || null, dimension: o && o.dimension || null })),
        };
        {
          const oportunidadValor = soloOportunidadesEjecutables(oportunidadesGobernadasEsteTurno)
            .find(o => o && o.satisfaccionConocimiento && o.satisfaccionConocimiento.estado !== 'SATISFECHA') || null;
          const exigenciaValor = oportunidadValor
            ? exigenciaDeActoDeValor(oportunidadValor, {
                grammar: gramaticaActivaAlInicio,
                hypothesisConceptIds: conceptosHipotesisAbiertaEsteTurno.map(c => c.id),
              })
            : null;
          if (exigenciaValor && exigenciaValor.facet) {
            const facet = exigenciaValor.facet;
            const unknownIdValor = oportunidadValor.semanticUnknownId || oportunidadValor.unknownId || null;
            const unknownConObjetivo = unknownIdValor
              ? (grafoParaDecisionCanonica.incertidumbres || []).find(u => u && u.id === unknownIdValor
                && u.targetConceptId && u.mission === facet.mission && u.dimension === facet.dimension)
              : null;
            const descriptorValor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
            let vinculoValor;
            if (oportunidadValor.targetBinding && oportunidadValor.targetBinding.targetConceptId
              && oportunidadValor.targetBinding.mission === facet.mission
              && oportunidadValor.targetBinding.dimension === facet.dimension) {
              vinculoValor = { valido: true, source: oportunidadValor.targetBinding.source, targetConceptId: oportunidadValor.targetBinding.targetConceptId };
            } else if (unknownConObjetivo) {
              vinculoValor = { valido: true, source: 'GOVERNED_UNKNOWN_TARGET', targetConceptId: unknownConObjetivo.targetConceptId };
            } else {
              vinculoValor = await resolverVinculacionObjetivoDeActoDeValor({
                llmService: llmServiceProductorActivo,
                mission: facet.mission,
                dimension: facet.dimension,
                operation: oportunidadValor.operacion,
                necesidadTexto: descriptorValor && descriptorValor.direccionConversacional
                  ? descriptorValor.direccionConversacional.necesidad : null,
                candidatos: candidatosObjetivoDeActoDeValor(
                  grafoParaDecisionCanonica, gramaticaActivaAlInicio, oportunidadValor.operacion)
                  .map(c => ({ id: c.id, descripcion: c.descripcion })),
                turnoId: turnoIdReservadoEnAdmision,
              });
            }
            trazaAutoridadEsteTurno.valueActBinding = {
              mission: facet.mission, dimension: facet.dimension,
              source: vinculoValor.valido ? vinculoValor.source : null,
              targetConceptId: vinculoValor.valido ? vinculoValor.targetConceptId : null,
              outcome: vinculoValor.valido ? 'BOUND' : 'FAILED_CLOSED',
              codigoRazon: vinculoValor.valido ? null : (vinculoValor.codigoRazon || null),
              claseFallo: vinculoValor.valido ? null : (vinculoValor.claseFallo || null),
              errorCategory: vinculoValor.valido ? null : (vinculoValor.errorCategory || null),
            };
            if (!vinculoValor.valido && vinculoValor.claseFallo === 'PROVIDER_FAILURE') {
              fallaProveedorValor = vinculoValor.errorCategory || 'PROVIDER_TRANSPORT_ERROR';
            }
            const seleccionadaIdTemporal = objetivoConversacionalEsteTurno
              && objetivoConversacionalEsteTurno.oportunidadSeleccionada
              && objetivoConversacionalEsteTurno.oportunidadSeleccionada.idTemporal;
            const esLaSeleccionada = !!seleccionadaIdTemporal && seleccionadaIdTemporal === oportunidadValor.idTemporal;
            if (vinculoValor.valido) {
              const enriquecida = {
                ...oportunidadValor,
                targetConceptId: vinculoValor.targetConceptId,
                targetBinding: Object.freeze({
                  source: vinculoValor.source, targetConceptId: vinculoValor.targetConceptId,
                  mission: facet.mission, dimension: facet.dimension,
                }),
              };
              oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.map(o => (o === oportunidadValor ? enriquecida : o));
              if (esLaSeleccionada) {
                objetivoConversacionalEsteTurno = {
                  ...objetivoConversacionalEsteTurno,
                  oportunidadSeleccionada: {
                    ...objetivoConversacionalEsteTurno.oportunidadSeleccionada,
                    targetConceptId: enriquecida.targetConceptId, targetBinding: enriquecida.targetBinding,
                  },
                };
              }
            } else {
              vinculoValorFallo = true;
              oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.filter(o => o !== oportunidadValor);
              if (esLaSeleccionada) {
                objetivoConversacionalEsteTurno = { ...objetivoConversacionalEsteTurno, oportunidadSeleccionada: null };
              }
            }
          }
        }
        // The governed opportunity is allowed to become durable state only
        // after Objetivo selected it, but it must be durable before the one
        // canonical Decision validates ASK_HOW.  Reuse that selected
        // proposal verbatim; reconciliation is not responsible for creating
        // or completing its identity.
        const oportunidadSeleccionadaGobernada = objetivoConversacionalEsteTurno
          && objetivoConversacionalEsteTurno.oportunidadSeleccionada;
        if (oportunidadSeleccionadaGobernada
          && oportunidadSeleccionadaGobernada.operacion === 'ABRIR_COMO'
          && !oportunidadSeleccionadaGobernada.semanticUnknownId
          && !oportunidadSeleccionadaGobernada.unknownId
          && oportunidadSeleccionadaGobernada.semanticTarget
          && oportunidadSeleccionadaGobernada.referenteSemantico) {
          const dimensionCandidataGobernada = oportunidadSeleccionadaGobernada.dimension
            || estadoActual.protocoloDimensionEnFoco || slotsFaltantesAntes[0] || null;
          // ACTIVE_TARGET_REUSE (C007,
          // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION).
          // If an already-active obligation of THIS mission already
          // represents this required territory, bind the opportunity to it
          // instead of minting yet another candidate -- this is exactly how
          // semantic_unknown:6..:13 accreted, one per turn, while :5 was the
          // real target. SAME_DIMENSION != SAME_IDENTITY: a genuinely
          // resolved prior target (or a still-unpromoted relevante:false
          // transient) does NOT satisfy esObligacionActivaParaMision, so a
          // legitimate fresh acquisition is never suppressed when the
          // dimension stays authoritatively pending.
          const obligacionReutilizableGobernada = encontrarObligacionActivaReutilizable(
            grafoParaDecisionCanonica, gramaticaActivaAlInicio, dimensionCandidataGobernada);
          if (obligacionReutilizableGobernada) {
            semanticUnknownIdEsteTurno = obligacionReutilizableGobernada.id;
            oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.map(o =>
              o && o.idTemporal === oportunidadSeleccionadaGobernada.idTemporal
                ? { ...o, semanticUnknownId: obligacionReutilizableGobernada.id, semanticUnknown: obligacionReutilizableGobernada }
                : o);
            objetivoConversacionalEsteTurno = {
              ...objetivoConversacionalEsteTurno,
              semanticUnknownId: obligacionReutilizableGobernada.id,
              oportunidadSeleccionada: {
                ...oportunidadSeleccionadaGobernada,
                unknownId: obligacionReutilizableGobernada.id,
                semanticUnknownId: obligacionReutilizableGobernada.id,
                semanticUnknown: obligacionReutilizableGobernada,
              },
            };
          }
          // REQUIRED_MISSION_FALLBACK_TARGET_BINDING (C007, Daniel-adjudicated,
          // real evidence: logistica_c1 turn 9). oportunidadSeleccionadaGobernada
          // may carry targetVinculacionPendiente:true (ObjetivoConversacionalPolicy.js
          // TARGET_CARDINALITY_RULE: more than one eligible anchor) -- this
          // opportunity must NOT become an executable candidate until exactly
          // one concrete governed target is resolved. Zero/one eligible anchors
          // never reach this branch with targetVinculacionPendiente true (the
          // fallback already bound zero to null/returned-null, and one
          // deterministically -- no semantic call needed either way).
          let targetConceptIdResuelto = oportunidadSeleccionadaGobernada.targetConceptId || null;
          let vinculacionObjetivoFallo = false;
          if (!obligacionReutilizableGobernada && oportunidadSeleccionadaGobernada.targetVinculacionPendiente === true) {
            const candidatosObjetivo = Array.isArray(oportunidadSeleccionadaGobernada.targetCandidatos)
              ? oportunidadSeleccionadaGobernada.targetCandidatos : [];
            const vinculacion = candidatosObjetivo.length > 0
              ? await vincularObjetivoConcretoNecesidadRequerida({
                  llmService: llmServiceProductorActivo,
                  mission: gramaticaActivaAlInicio,
                  dimension: dimensionCandidataGobernada,
                  operation: oportunidadSeleccionadaGobernada.operacion,
                  necesidadTexto: oportunidadSeleccionadaGobernada.evidenciaBuscada,
                  candidatos: candidatosObjetivo,
                  turnoId: turnoIdReservadoEnAdmision,
                })
              : { valido: false, targetConceptId: null };
            targetConceptIdResuelto = vinculacion.valido ? vinculacion.targetConceptId : null;
            // TARGET_BINDING_CAPABILITY_FAILURE fails closed exactly like the
            // pre-existing zero-eligible-anchor case: no executable opportunity
            // materializes this turn. Never falls back to the broad support
            // set as if it were the target, and never converts into a
            // Realizer/Fidelity-facing failure -- this is the SAME "no
            // legitimate act this turn" outcome the caller already handles
            // when materializado.unknown stays null, below.
            vinculacionObjetivoFallo = !vinculacion.valido;
          }
          const candidate = (obligacionReutilizableGobernada || vinculacionObjetivoFallo) ? null : crearSemanticUnknownCandidate({
            mission: gramaticaActivaAlInicio,
            dimension: dimensionCandidataGobernada,
            respondent: oportunidadSeleccionadaGobernada.sujetoObjetivo || null,
            referenteSemantico: oportunidadSeleccionadaGobernada.referenteSemantico,
            proposicion: proposicionGobernadaDeOportunidad(oportunidadSeleccionadaGobernada),
            operation: oportunidadSeleccionadaGobernada.operacion,
            procedencia: { turnoId: turnoIdReservadoEnAdmision, decision: 'DECISION_AUTHORITY' },
            sobreConceptos: oportunidadSeleccionadaGobernada.anclajeConceptoIds || [],
            targetConceptId: targetConceptIdResuelto,
          });
          // CANDIDATE_ADMISSIBLE != CANDIDATE_COMMITTED_AS_OBLIGATION (C007,
          // CLOSURE_CONTRACT_ACCEPTANCE_AND_OPTIONAL_OBLIGATION_COORDINATION,
          // Daniel-adjudicated, real evidence: logistica_c0 turns 11-12,
          // session live_complete_logistica_c0_11ec6033). Objetivo's OWN
          // selection (oportunidadSeleccionadaGobernada, above) is NOT the
          // same authority as canonical Decision -- decidirIntervencionConversacional
          // has not run yet at this point in the turn, and may separately,
          // correctly choose something else entirely (e.g. PROPOSE_MISSION_
          // CLOSURE, when missionSufficient is true). Materialized
          // relevante:false: it is reachable by Decision through the bound
          // opportunity (oportunidadesConversacionales), never as an
          // executable-obligation candidate -- esObligacionActivaParaMision
          // excludes relevante:false everywhere. It is promoted to true
          // immediately below, ONLY if canonical Decision selects this exact
          // unknown as this turn's WHAT. Skipped entirely when an active
          // obligation for the same required territory was reused above.
          const materializado = materializarSemanticUnknown(grafoParaDecisionCanonica, candidate, { relevante: false });
          if (materializado.unknown) {
            grafoDelta = materializado.grafo;
            grafoParaDecisionCanonica = materializado.grafo;
            semanticUnknownIdEsteTurno = materializado.unknown.id;
            oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.map(o =>
              o && o.idTemporal === oportunidadSeleccionadaGobernada.idTemporal
                ? { ...o, semanticUnknownId: materializado.unknown.id, semanticUnknown: materializado.unknown }
                : o);
            objetivoConversacionalEsteTurno = {
              ...objetivoConversacionalEsteTurno,
              semanticUnknownId: materializado.unknown.id,
              oportunidadSeleccionada: {
                ...oportunidadSeleccionadaGobernada,
                unknownId: materializado.unknown.id,
                semanticUnknownId: materializado.unknown.id,
                semanticUnknown: materializado.unknown,
              },
            };
          }
        }
        const gananciaCognitivaSeleccionada = objetivoConversacionalEsteTurno
          && objetivoConversacionalEsteTurno.gananciaCognitiva
          || null;
        // Closing/enriching the directed unknown is a canonical state
        // update, not by itself a returnable cognitive gain. Evidence may
        // support a gain, but its literal text never becomes gain content
        // automatically. Only the gain already selected by Objetivo's
        // grounding/novelty policy may cross into Decision as governedGain.
        //
        // C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 2 --
        // NEXT_ACT_AUTHORITY_IS_SINGLE. canonicalNextActStateV1 is built
        // HERE, from the exact same ingredients decidirIntervencionConversacional
        // is about to receive (this durable grafoParaDecisionCanonica, this
        // final oportunidadesGobernadasEsteTurno, this gain derivation) --
        // this IS the authoritative version repair's own v0 (see the repair
        // block above) approximated conservatively before objetivoConversacionalEsteTurno
        // existed. gananciaGobernadaDeRespuesta now reads its value FROM this
        // canonical projection rather than computing it a second, independent
        // time -- single owner, not a second parallel proxy.
        const canonicalNextActStateV1 = construirCanonicalNextActState({
          // Decision's candidate set = the EXECUTABLE projection of the
          // Objective's arbitration (see prioridadMisionEsteTurno above): an
          // opportunity that yielded to the required mission territory
          // cannot re-enter here as an equivalent executable candidate.
          oportunidadesGobernadas: soloOportunidadesEjecutables(oportunidadesGobernadasEsteTurno),
          governedGain: gananciaCognitivaSeleccionada
            && typeof gananciaCognitivaSeleccionada.contenido === 'string'
            && gananciaCognitivaSeleccionada.contenido.trim()
            ? {
                id: `gain-${turnoIdReservadoEnAdmision}`,
                unknownId: Array.isArray(gananciaCognitivaSeleccionada.soporteUnknownIds)
                  ? gananciaCognitivaSeleccionada.soporteUnknownIds[0] || null : null,
                texto: gananciaCognitivaSeleccionada.contenido.trim(),
                soporteConceptoIds: Array.isArray(gananciaCognitivaSeleccionada.soporteConceptoIds)
                  ? [...gananciaCognitivaSeleccionada.soporteConceptoIds] : [],
              }
            : null,
          grafo: grafoParaDecisionCanonica,
          gramatica: gramaticaActivaAlInicio,
          frontierStatus: estadoFronteraCognitivaEsteTurno,
          closureOption: closureOptionEsteTurno,
          version: 1,
        });
        gananciaGobernadaDeRespuesta = canonicalNextActStateV1.governedGain;
        // AUTHORITY_CONTINUITY correction -- the exact same object Decision
        // consumes, one line above, is the ONLY thing the terminal
        // NO_COGNITIVE_ACT_AVAILABLE guard (much later) is allowed to
        // consult: never a freshly-rebuilt "guard snapshot".
        canonicalNextActStateV1EsteTurno = canonicalNextActStateV1;
        trazaAutoridadEsteTurno.canonicalNextActState = proyectarReferenciasParaTraza(canonicalNextActStateV1);
        const decisionCanonica = decidirIntervencionConversacional({
          governedState: {
            ...estadoActual,
            knowledgeGraph: grafoParaDecisionCanonica,
            oportunidadesConversacionales: canonicalNextActStateV1.governedOpportunities,
            governedGain: canonicalNextActStateV1.governedGain,
            // CONVERSATIONAL_HYPOTHESIS_ELIGIBILITY -- ids of THIS turn's
            // KNOWLEDGE-ineligible-but-legitimately-derived concepts (never
            // durable, never in grafoParaDecisionCanonica.conceptos). The
            // single existing owner that turns admissible state into a
            // final executable act (needFromGovernedState, below) consults
            // this to decide whether a presuppositional needKind must be
            // recharacterized as ASK_EXISTENCE over the same target --
            // never mutating the opportunity, never here.
            hypothesisConceptIds: conceptosHipotesisAbiertaEsteTurno.map(c => c.id),
            // C007 CLASS 12 HANDOFF FIX -- for the four non-DESTINO
            // grammars, missionSufficient reads the canonical projection of
            // Progress's own authority (closureOption, threaded above)
            // instead of re-deriving suficiencia from
            // protocoloEstadoEfectivo==='LISTO_PARA_SINTESIS' alone: that
            // check excluded ESPERANDO_CONFIRMACION's own 'confirma' turn --
            // the EXACT turn where Progress legitimately authorizes the
            // handoff -- so PROPOSE_MISSION_CLOSURE could never be reached
            // there. Never a free boolean invented here: canonicalNextActStateV1.
            // closureOption is the SAME object just built above, itself only
            // non-null when the real decidirProtocolo() (Progress's own,
            // single source of truth) already returned avanza===true this
            // turn. DESTINO_MISSION_SUFFICIENCY_NOT_WIRED_TO_CLOSURE --
            // resolverSuficienciaMisionGramaticaActiva (above) is the
            // grammar-adapter boundary: this expression is reproduced byte-
            // for-byte for every OTHER grammar; only 'destino' now consults
            // its own already-certified GrafoProyeccion coverage instead of
            // being categorically excluded.
            missionSufficient: resolverSuficienciaMisionGramaticaActiva({
              gramaticaActivaAlInicio, grafoPreTurnoDestino: estadoActual.knowledgeGraph,
              protocoloEstadoEfectivo, closureOptionEsteTurno,
            }),
          },
          grammar: gramaticaActivaAlInicio,
        });
        let actoCognitivoCanonicoPrevioArbitraje = decisionCanonica && decisionCanonica.actoCognitivoVisible
          ? decisionCanonica.actoCognitivoVisible : null;
        // MISSION_REQUIRED_OPPORTUNITY_OUTRANKS_OPTIONAL_ACQUIRED_ACT (C007)
        // -- the earliest common point where the mission-opportunity path's
        // own already-vetted winner (objetivoConversacionalEsteTurno.
        // oportunidadSeleccionada, scoped to GrafoProyeccion.dimensionesPendientes)
        // and the acquired-act path's own winner (actoCognitivoCanonicoPrevioArbitraje,
        // just computed) can be compared before either one is frozen as
        // this turn's authority. See the predicate's own docstring for the
        // exact narrow scope (provenance:'governed_opportunity' candidates
        // only; REPAIR/MISSION_CLOSURE/RETURN_UNDERSTANDING/RETURN_GOVERNED_GAIN/
        // raw-graph-MECHANISM-fallback remain unconditionally authoritative).
        if (actoCognitivoCanonicoPrevioArbitraje) {
          const oportunidadOrigenActoAdquirido = (canonicalNextActStateV1.governedOpportunities || [])
            .find(o => o && o.satisfaccionConocimiento && o.satisfaccionConocimiento.estado !== 'SATISFECHA');
          if (actoAdquiridoOpcionalDebeCederAMisionRequerida({
            necesidadCognitiva: decisionCanonica.necesidadCognitiva,
            oportunidadOrigenActoAdquirido,
            oportunidadMisionRequerida: objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.oportunidadSeleccionada,
          })) {
            actoCognitivoCanonicoPrevioArbitraje = null;
          }
        }
        trazaAutoridadEsteTurno.decision = {
          operator: actoCognitivoCanonicoPrevioArbitraje && actoCognitivoCanonicoPrevioArbitraje.operator || null,
          target: actoCognitivoCanonicoPrevioArbitraje && actoCognitivoCanonicoPrevioArbitraje.target || null,
          kind: decisionCanonica && decisionCanonica.kind || null,
        };
        actoCognitivoCanonico = actoCognitivoCanonicoPrevioArbitraje;
        // MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET --
        // FAIL CLOSED. A value act that could not become executable (its
        // target could not be bound, or the act lacks a valid facet /
        // coherent binding) must not silently degrade into the legacy,
        // act-less mission contract: that would hand the Realizer a broad,
        // unbound request -- precisely the defect this capability closes.
        // If Decision found no other act this turn, the turn fails closed.
        // The binder could not run at all: that is a provider failure, not a
        // cognitive verdict about the turn (same operational convention as the
        // Producer's LLM_UNAVAILABLE: errorCategory + retryable by category).
        // It still fails closed -- no target is invented -- but it must never
        // be reported as an unbindable value act.
        if (!actoCognitivoCanonico && fallaProveedorValor) {
          this._marcarEntradaFallidaSiEsSeguro({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: 'LLM_UNAVAILABLE', errorCategory: fallaProveedorValor,
            retryable: retryableDesdeErrorCategory(fallaProveedorValor),
          });
          trazaAutoridadEsteTurno.visibleRoute = 'NONE';
          trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
          this._emitirTrazaAutoridad({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            traza: trazaAutoridadEsteTurno, commit: false, failureClass: 'LLM_UNAVAILABLE',
          });
          return {
            ok: false, httpStatus: 502, codigo: 'LLM_UNAVAILABLE',
            mensaje: 'El motor no produjo una respuesta cognitiva válida.',
          };
        }
        const erroresActoDeValor = ['FACETA_SOLICITADA_AUSENTE', 'OBJETIVO_NO_VINCULADO', 'OBJETIVO_FACETA_INCOHERENTES', 'OBJETIVO_Y_FACETA_NO_DISTINTOS'];
        if (!actoCognitivoCanonico
          && (vinculoValorFallo || (decisionCanonica && erroresActoDeValor.includes(decisionCanonica.errorActoCognitivo)))) {
          const codigoActoDeValor = 'OBJETIVO_ACTO_DE_VALOR_NO_VINCULABLE';
          this._marcarEntradaFallidaSiEsSeguro({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: codigoActoDeValor, errorCategory: null, retryable: false,
          });
          trazaAutoridadEsteTurno.visibleRoute = 'NONE';
          trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
          this._emitirTrazaAutoridad({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            traza: trazaAutoridadEsteTurno, commit: false, failureClass: codigoActoDeValor,
          });
          return { ok: false, httpStatus: 502, codigo: codigoActoDeValor, mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO };
        }
        // CANONICAL_REALIZABLE_TARGET -- computed once, here, from the SAME
        // graph Decision itself just consumed (grafoParaDecisionCanonica),
        // and attached to the SAME frozen actoCognitivoVisible object every
        // createContratoIntervencion call below already threads through --
        // never a second Decision, never re-derived downstream.
        if (actoCognitivoCanonico) {
          actoCognitivoCanonico = Object.freeze({
            ...actoCognitivoCanonico,
            realizationTarget: proyectarTargetRealizableCanonico(actoCognitivoCanonico, grafoParaDecisionCanonica),
          });
          // PROSPECTIVE OPPORTUNITY -> DECISION CHOOSES WHAT -> ONLY THE
          // SELECTED OBLIGATION BECOMES DURABLE (C007,
          // CLOSURE_CONTRACT_ACCEPTANCE_AND_OPTIONAL_OBLIGATION_COORDINATION).
          // Canonical Decision just, for real, chose this act's own target
          // as this turn's WHAT -- if that target is a SemanticUnknown that
          // was materialized as a mere candidate (relevante:false, above),
          // promote it now: Decision's own selection is exactly the
          // authority this increment requires before an optional
          // acquisition may become a durable mission obligation. A no-op
          // when the target is already relevante, isn't a SemanticUnknown,
          // or doesn't exist (promoverSemanticUnknownAObligacion is pure
          // and idempotent).
          //
          // PROMOTION IS A CONTRACT BOUNDARY (C007,
          // DESTILAR_REQUIRED_MISSION_NEED_NOT_ESCALATED_TO_CANONICAL_DECISION).
          // Defense-in-depth: a cross-mission SemanticUnknown must NEVER
          // become an active DESTILAR obligation just because a downstream
          // Decision referenced its id (real evidence: turn 14 promoted
          // semantic_unknown:4, mission:"destino", while active grammar was
          // "destilar"). The shared authority already makes such a target
          // non-selectable upstream; this guard refuses the durable write
          // regardless. `ignorarRelevancia` because the target is about to
          // BECOME relevante:true -- only its open state and active mission
          // are preconditions here. Legacy non-SemanticUnknown ids are
          // untouched (predicate returns false only for shaped unknowns it
          // can evaluate; a plain id string simply isn't found and the
          // call stays the prior no-op).
          const objetivoTargetUnknown = (grafoParaDecisionCanonica.incertidumbres || [])
            .find(u => u && u.id === actoCognitivoCanonico.target);
          const objetivoTargetPromovible = !objetivoTargetUnknown
            || esObligacionActivaParaMision(objetivoTargetUnknown, gramaticaActivaAlInicio, { ignorarRelevancia: true });
          if (objetivoTargetPromovible) {
            grafoDelta = promoverSemanticUnknownAObligacion(grafoParaDecisionCanonica, actoCognitivoCanonico.target);
            grafoParaDecisionCanonica = grafoDelta;
          }
        }
        const oportunidadSeleccionadaCanonica = actoCognitivoCanonico
          ? oportunidadesGobernadasEsteTurno.find(o => o
            && o.operacion !== 'ABRIR_COMO'
            && (o.semanticTarget === actoCognitivoCanonico.target
              || o.semanticUnknownId === actoCognitivoCanonico.target
              || o.unknownId === actoCognitivoCanonico.target)
            && (!actoCognitivoCanonico.subjectRef
              || o.subjectRef === actoCognitivoCanonico.subjectRef
              || o.referenteSemantico === actoCognitivoCanonico.subjectRef))
          : null;
        if (oportunidadSeleccionadaCanonica
          && !oportunidadSeleccionadaCanonica.semanticUnknownId
          && !oportunidadSeleccionadaCanonica.unknownId
          && oportunidadSeleccionadaCanonica.semanticTarget
          && oportunidadSeleccionadaCanonica.referenteSemantico) {
          const candidate = crearSemanticUnknownCandidate({
            mission: gramaticaActivaAlInicio,
            dimension: oportunidadSeleccionadaCanonica.dimension
              || estadoActual.protocoloDimensionEnFoco || slotsFaltantesAntes[0] || null,
            respondent: oportunidadSeleccionadaCanonica.sujetoObjetivo || null,
            referenteSemantico: oportunidadSeleccionadaCanonica.referenteSemantico,
            proposicion: proposicionGobernadaDeOportunidad(oportunidadSeleccionadaCanonica),
            operation: oportunidadSeleccionadaCanonica.operacion,
            procedencia: { turnoId: turnoIdReservadoEnAdmision, decision: 'DECISION_AUTHORITY' },
            sobreConceptos: oportunidadSeleccionadaCanonica.anclajeConceptoIds || [],
          });
          const materializado = materializarSemanticUnknown(grafoParaDecisionCanonica, candidate);
          if (materializado.unknown) {
            grafoDelta = materializado.grafo;
            semanticUnknownIdEsteTurno = materializado.unknown.id;
            oportunidadesGobernadasEsteTurno = oportunidadesGobernadasEsteTurno.map(o =>
              o && o.idTemporal === oportunidadSeleccionadaCanonica.idTemporal
                ? { ...o, semanticUnknownId: materializado.unknown.id, semanticUnknown: materializado.unknown }
                : o);
          }
        }
      }
      contratoIntervencionMovimiento = actoCognitivoCanonico
        && ['RETURN_GOVERNED_GAIN', 'RETURN_UNDERSTANDING'].includes(actoCognitivoCanonico.operator)
        ? createContratoIntervencion({
            funcion: 'REFLEJAR',
            actoCognitivoVisible: actoCognitivoCanonico,
            contenido: {
              gainType: 'COMUNICAR_GANANCIA_GOBERNADA',
              // C007 — STRUCTURED GOVERNED GAIN AUTHORITY. GAIN_SUPPORT !=
              // GAIN_WORDING_AUTHORITY: gananciaGobernadaDeRespuesta.texto is
              // the Producer's free-form description of the gain (kept below,
              // for observability/Fidelity diagnostic context only) — it must
              // never itself become the governed visible authority. The
              // authoritative material is the governed CONCEPT description(s)
              // this same gain already cites via soporteConceptoIds — exactly
              // the canonical materialAfirmableParaActo(conceptos, gananciaCognitiva)
              // pattern this file already uses for every other RETURN-shaped
              // act (see the sibling contratoMovimientoDestino branch and the
              // mission/synthesis branches above) — reused here, not
              // reinvented, per RETURN_GOVERNED_GAIN_MUST_RETURN_THE_GOVERNED_
              // COGNITIVE_GAIN_NOT_THE_PRODUCER'S_FREE_FORM_INTERPRETATION_OF_IT.
              materialAfirmable: gananciaGobernadaDeRespuesta
                ? materialAfirmableParaActo(
                    (() => {
                      const grafoAutorizadoGanancia = grafoDelta || estadoActual.knowledgeGraph;
                      return (grafoAutorizadoGanancia && Array.isArray(grafoAutorizadoGanancia.conceptos))
                        ? grafoAutorizadoGanancia.conceptos : [];
                    })(),
                    gananciaGobernadaDeRespuesta,
                  ).map(c => c.descripcion)
                : [],
              gananciaCognitiva: gananciaGobernadaDeRespuesta,
            },
            accionUsuario: { tipo: 'ninguna', objetivo: null },
            criterioExito: 'la ganancia gobernada se comunica sin abrir una nueva pregunta',
          })
        : (gramaticaActivaAlInicio === 'destino' && contratoMovimientoDestino)
        ? (() => {
            const descriptor = getGrammarMissionDescriptor(gramaticaActivaAlInicio);
            const grafoAutorizado = grafoDelta || estadoActual.knowledgeGraph;
            const gananciaContratada = objetivoConversacionalEsteTurno
              && objetivoConversacionalEsteTurno.gananciaCognitiva;
            const idsSoporteGanancia = new Set(gananciaContratada
              && Array.isArray(gananciaContratada.soporteConceptoIds)
              ? gananciaContratada.soporteConceptoIds : []);
            // Continuity memory remains available elsewhere, but material
            // authorized for expression is scoped to the contracted gain.
            // A narrow WHAT must not receive the whole accumulated method.
            const materialAfirmable = (grafoAutorizado && Array.isArray(grafoAutorizado.conceptos)
              ? grafoAutorizado.conceptos : [])
              .filter(c => c && c.activo !== false && c.autoridad === 'experto'
                && (!gananciaContratada || idsSoporteGanancia.has(c.id)))
              .map(c => c.descripcion);
            // La evidencia explorables la decide ObjetivoConversacionalPolicy;
            // Writer solo la transporta. No se vuelve a derivar desde el
            // nombre del movimiento ni desde una dimensión interna.
            const materialExplorable = objetivoConversacionalEsteTurno
              && (objetivoConversacionalEsteTurno.evidenciaBuscada
                || objetivoConversacionalEsteTurno.necesidadConversacional)
              || null;
            // VISIBLE_LANGUAGE_FIDELITY — scoped to the act's own anchor,
            // never to gain support: a co-present governed gain must not
            // starve the acquisition's own phrasing of the expert's words.
            const anclajeOportunidadDestino = contratoMovimientoDestino
              && contratoMovimientoDestino.oportunidadConversacional
              && Array.isArray(contratoMovimientoDestino.oportunidadConversacional.anclajeConceptoIds)
              ? contratoMovimientoDestino.oportunidadConversacional.anclajeConceptoIds : [];
            const anclajeActoCanonicoDestino = actoCognitivoCanonico
              ? [actoCognitivoCanonico.subjectRef, ...(Array.isArray(actoCognitivoCanonico.authorizedPresuppositionIds)
                ? actoCognitivoCanonico.authorizedPresuppositionIds : [])].filter(Boolean)
              : [];
            const lexicalGrounding = lexicalGroundingParaAncla(
              grafoAutorizado.conceptos, [...anclajeOportunidadDestino, ...anclajeActoCanonicoDestino],
            );
            const contrato = construirContratoIntervencionDesdeMovimiento(
              contratoMovimientoDestino,
              {
                // La observación de Capa 1 queda fuera del contrato visible:
                // solo el grafo autorizado puede afirmarse.
                observacion: null,
                mision: descriptor && descriptor.mission,
                propositoGlobal: PROPOSITO_GLOBAL,
                necesidadConversacional: objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.necesidadConversacional
                  || 'comenzar a comprender cómo realiza ese saber en la práctica',
                evidenciaBuscada: objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.evidenciaBuscada
                  || materialExplorable,
                materialAfirmable,
                lexicalGrounding,
                materialExplorable,
                gananciaCognitiva: gananciaContratada,
                oportunidadConversacional: contratoMovimientoDestino && contratoMovimientoDestino.oportunidadConversacional || null,
              },
            );
            const unknownIdDeOportunidad = contratoMovimientoDestino
              && contratoMovimientoDestino.oportunidadConversacional
              && (contratoMovimientoDestino.oportunidadConversacional.semanticUnknownId
                || contratoMovimientoDestino.oportunidadConversacional.unknownId)
              || null;
            const unknownIdGobernado = actoCognitivoCanonico
              && actoCognitivoCanonico.target
              && actoCognitivoCanonico.target === unknownIdDeOportunidad
              ? actoCognitivoCanonico.target
              : null;
            return actoCognitivoCanonico
              ? congelarActoUnico({
                  ...contrato,
                  actoCognitivoVisible: actoCognitivoCanonico,
                  contenido: {
                    ...contrato.contenido,
                    unknownId: contrato.contenido && contrato.contenido.unknownId || unknownIdGobernado,
                  },
                })
              : contrato;
          })()
        // Las misiones tipadas necesitan el mismo contrato común en la
        // costura hacia el Realizer; no se reconstruye desde texto libre.
        : (movimientoMisionAplicaEsteTurno && movimientoComunEsteTurno
          ? congelarActoUnico(construirContratoIntervencionDeMision({
              gramatica: gramaticaActivaAlInicio,
              movimiento: movimientoComunEsteTurno,
              parsed: r.parsed,
              progreso: null,
              objetivoConversacional: objetivoConversacionalEsteTurno,
              materialAfirmable: ((grafoDelta || estadoActual.knowledgeGraph).conceptos || [])
                .filter(c => c && c.activo !== false && c.autoridad === 'experto'
                  && (!(objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.gananciaCognitiva)
                    || (Array.isArray(objetivoConversacionalEsteTurno.gananciaCognitiva.soporteConceptoIds)
                      && objetivoConversacionalEsteTurno.gananciaCognitiva.soporteConceptoIds.includes(c.id))))
                .map(c => c.descripcion),
              materialAfirmableScoped: ((grafoDelta || estadoActual.knowledgeGraph).conceptos || [])
                .filter(c => c && c.activo !== false && c.autoridad === 'experto'
                  && (!objetivoConversacionalEsteTurno || !objetivoConversacionalEsteTurno.gananciaCognitiva
                    || (Array.isArray(objetivoConversacionalEsteTurno.gananciaCognitiva.soporteConceptoIds)
                      && objetivoConversacionalEsteTurno.gananciaCognitiva.soporteConceptoIds.includes(c.id))))
                .map(c => ({ sourceId: c.id, texto: c.descripcion, autoridad: c.autoridad, alcance: alcanceEpistemicoConcepto(c) })),
              // VISIBLE_LANGUAGE_FIDELITY — scoped to the selected
              // opportunity's own anchor, never to gain support (same
              // rationale as the DESTINO branch above).
              lexicalGrounding: lexicalGroundingParaAncla(
                (grafoDelta || estadoActual.knowledgeGraph).conceptos,
                (objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.oportunidadSeleccionada
                  && Array.isArray(objetivoConversacionalEsteTurno.oportunidadSeleccionada.anclajeConceptoIds)
                  ? objetivoConversacionalEsteTurno.oportunidadSeleccionada.anclajeConceptoIds : []),
              ),
              materialExplorable: objetivoConversacionalEsteTurno
                && (objetivoConversacionalEsteTurno.evidenciaBuscada
                  || objetivoConversacionalEsteTurno.necesidadConversacional) || null,
              historialVisibleReciente: historialVisibleRecienteEsteTurno,
              necesidadConversacional: objetivoConversacionalEsteTurno
                && objetivoConversacionalEsteTurno.necesidadConversacional,
              evidenciaBuscada: objetivoConversacionalEsteTurno
                && objetivoConversacionalEsteTurno.evidenciaBuscada,
              comprensionTrabajo: comprensionTrabajoEsteTurno,
              focoConversacionalActual,
              domainScaffold: Array.isArray(r.parsed && r.parsed.domainScaffold) ? r.parsed.domainScaffold : [],
            }))
          : null);
      // circulomejora006 (tercera verificación, Sección C3 — Opción B):
      // ya no hay next_user_action de Capa 1 que estampar cuando Movimiento
      // gobierna DESTINO — el contrato de construcción dejó de pedirlo por
      // completo (ver AgoraPrompts.buildProtocoloBloqueExplorandoGrafo).
      // Movimiento decide QUÉ dimensión y el Realizador redacta la
      // intervención COMPLETA (incluida la pregunta, si corresponde) más
      // abajo, en la rama TRANSFORMAR — nunca hay un campo separado que
      // corregir aquí.

      // Ciclo Cognitivo de Descubrimiento (ADR) — corrección de la brecha de
      // síntesis: LISTO_PARA_SINTESIS (síntesis fresca) ya NO le pide
      // "observacion" al generador — pedirla como campo aparte reabría
      // exactamente el riesgo que se acaba de cerrar para "descripcion"
      // (dos textos que podrían divergir, uno confirmado por el experto y
      // otro promovido en el grafo). No se compensa con una derivación
      // programática de "observacion" a partir de "mensaje": D-037 (ver
      // test_realizador_conversacional.js) ya excluye explícitamente a
      // LISTO_PARA_SINTESIS y ESPERANDO_CONFIRMACION del Realizador — "sin
      // excepción". Retirar el campo del contrato, sin más, deja a este
      // estado en exactamente 1 llamada LLM, tal como ese alcance exige; el
      // texto que el experto juzga es, siempre, "mensaje" de Capa 1 — nunca
      // reescrito por una segunda llamada.

      // Gobernanza de Materialización (Project OS, CONTRATO-Gobernanza-
      // Materializacion-Conversacional.md) — primer flujo gobernado por el
      // Contrato. Antes de este bloque, "¿corre el Realizador?" era un `if`
      // ad hoc leyendo protocoloEstado/validacionContrato/observacion
      // directamente (D-036/037 → D-040). Eso dejaba dos huecos reales,
      // nunca documentados como tales hasta la auditoría: contrato que
      // agota reintentos sin validar nunca (mensaje crudo de Capa 1 sale
      // igual, sin pasar por nada) y contrato válido con "observacion"
      // ausente (mismo resultado, por la condición compuesta simplemente
      // siendo falsa). Ninguno de los dos era un fallo del Realizador — el
      // Realizador nunca llegaba a evaluarse. Se resuelven aquí no como
      // parches puntuales sino dejando que el Contrato decida, con Garantías
      // atómicas (auditoría de tipado semántico posterior a 23b766f —
      // reemplaza el booleano agregado `prosaValidada`, que fusionaba
      // hechos de fuerza distinta):
      //   mensajeValidado            — calculada una sola vez arriba.
      //   contratoDeCamposValidado   — resto del contrato de campos de
      //     EXPLORANDO (next_user_action, sin campos cruzados), capturado
      //     ANTES de que la evaluación de grafo pudiera sobrescribirlo.
      //   evaluacionGrafo            — NO_APLICA/APROBADA/RECHAZADA, del
      //     mismo bucle — en EXPLORANDO_GRAFO el mecanismo SIEMPRE corre
      //     (aplicarDelta se invoca sin condición), así que aquí nunca
      //     vale NO_APLICA en la práctica.
      //   observacionDisponible     — "observacion" de Capa 1 es un string
      //     no vacío (input que Transformar necesita).
      //   materializadorEspecializadoActivo / debeSuprimirse — siempre
      //     falsas en EXPLORANDO hoy; se computan explícitas (no se
      //     asumen) para que la Gobernanza sea la misma función en
      //     cualquier contexto futuro que sí las produzca.
      const garantiasMaterializacion = {
        mensajeValidado,
        contratoDeCamposValidado,
        evaluacionGrafo,
        observacionDisponible: !!(r.parsed && typeof r.parsed.observacion === 'string' && r.parsed.observacion.trim()),
        materializadorEspecializadoActivo: false,
        debeSuprimirse: false,
      };
      // r.parsed es precondición del propio perímetro del Contrato (§2:
      // "cuando el pipeline SÍ produce un turno viable, entrega sus
      // Garantías a la Gobernanza" — LLM_UNAVAILABLE, fallo total de
      // transporte/parseo, ocurre ANTES de llegar acá, fuera de alcance).
      // Sin este chequeo, un contrato nunca-validado por fallo de
      // transporte (r.parsed === null) terminaría igual bajo Determinista
      // más abajo, y `{ ...null, mensaje: '' }` fabricaría un r.parsed
      // no-nulo — ocultando el `!r.parsed` que más abajo (línea ~1052)
      // distingue "no hay turno viable" de "hay turno viable sin prosa
      // confiable". Son dos imposibilidades distintas — la del pipeline
      // (operacional) nunca es responsabilidad de esta Gobernanza.
      // circulomejora006 — movimientoEjecutadoDestino distingue "se decidió
      // un movimiento" (contratoMovimientoDestino) de "ese movimiento
      // efectivamente gobernó la materialización de este turno" (Especificación,
      // corrección final §3 — observabilidad debe distinguir ambos). Las tres
      // variables de traza están declaradas a nivel de función (ver más
      // arriba) — aquí solo se reasignan.
      const resultadoGobernanza = (protocoloEstadoEfectivo === 'EXPLORANDO' && grafoModoSesion && r.parsed)
        ? decidirMaterializacion(garantiasMaterializacion, CONTEXTOS_MATERIALIZACION.EXPLORANDO_GRAFO, contratoMovimientoDestino)
        : { seleccionada: null, movimientoCompatible: true };
      const estrategiaSeleccionada = resultadoGobernanza.seleccionada;
      destinoMovimientoCompatible = resultadoGobernanza.movimientoCompatible;
      estrategiaSeleccionadaTraza = estrategiaSeleccionada;
      estrategiaEfectivaTraza = resultadoGobernanza.estrategiaEfectiva;
      let realizadorInvocado = false;
      let realizadorProdujoSalida = false;
      // C007 — Decision ya congeló el WHAT antes de esta costura legacy.
      // Cuando existe un ContratoIntervencion ejecutable, Movimiento puede
      // aportar trazabilidad/HOW, pero su materializador histórico no puede
      // ejecutarse primero ni abortar el turno: la frontera común de abajo
      // es la única autorizada para Contract -> Realizer -> Fidelity.
      const contratoCognitivoEjecutableAntesDeMaterializar = !debeEjecutarMaterializadorMovimientoLegacy({
        actoCognitivoCanonico,
        contratoIntervencion: contratoIntervencionMovimiento,
      });

      const aplicarFallbackMovimientoTrasFallo = () => {
        if (
          gramaticaActivaAlInicio !== 'destino'
          || !contratoMovimientoDestino
          || (
            !this._movimientoConversacionalEnabled
            && !(
              contratoMovimientoDestino.movimiento === MOVIMIENTOS_DESTINO.REPARAR_TRAS_RECHAZO
              && contratoMovimientoDestino.obligacionId
              && contratoMovimientoDestino.intentoInterpretacionId
            )
          )
        ) return;

        const fallbackMovimiento = fallbackMovimientoTrasFalloRealizador(contratoMovimientoDestino);
        const decisionFallback = decidirFallbackTrasFalloTransformar({
          fallbackMovimiento,
          mensajeValidado,
        });
        realizadorFalloTraza = true;
        estrategiaEfectivaTraza = decisionFallback.estrategiaEfectiva;
        fallbackMovimientoAplicadoTraza = decisionFallback.fallbackAplicado;
        salidaVisibleSeguraTraza = decisionFallback.salidaVisibleSegura;
        movimientoEjecutadoDestino = decisionFallback.movimientoEjecutado;

        if (
          decisionFallback.estrategiaEfectiva === ESTRATEGIAS_MATERIALIZACION.DETERMINISTA
          && fallbackMovimiento.texto
        ) {
          r = { ...r, parsed: { ...r.parsed, mensaje: fallbackMovimiento.texto.trim() } };
          movimientoNoEjecutadoRazon = null;
          return;
        }

        movimientoNoEjecutadoRazon = fallbackMovimiento.codigoRazon;
        if (contratoMovimientoDestino.movimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION) {
          dimensionInterpretacionDiferidaEsteTurno = contratoMovimientoDestino.dimensionObjetivo;
        }
      };

      // HORIZONTE01_P0I — un movimiento PROPONER_INTERPRETACION solo es
      // materializable cuando Capa 1 produjo una propuesta con identidad
      // durable.  Sin esa identidad, Movimiento ya sabe que la decisión no
      // puede ejecutarse; dejarla entrar a Transformar permite que el
      // Realizador invente una interpretación/confirmación distinta.
      // La degradación usa la compuerta Determinista ya existente, cuyo
      // fallback para PROPONER es NO_DETERMINABLE y termina sin persistir un
      // WHAT sustituto.
      const interpretacionNoMaterializable = !!(
        !contratoCognitivoEjecutableAntesDeMaterializar
        &&
        contratoMovimientoDestino
        && contratoMovimientoDestino.movimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION
        && (
          evaluacionInterpretacionResultado !== 'PROPUESTA'
          || !conceptoIdInterpretacionValidado
        )
      );
      if (interpretacionNoMaterializable) {
        movimientoNoEjecutadoRazon = (evaluacionInterpretacionOmitida && evaluacionInterpretacionMotivoOmision === 'contrato')
          ? 'EVALUACION_INTERPRETACION_OMITIDA'
          : 'INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA';
        dimensionInterpretacionDiferidaEsteTurno = contratoMovimientoDestino.dimensionObjetivo || null;
        estrategiaEfectivaTraza = ESTRATEGIAS_MATERIALIZACION.DETERMINISTA;
        r = { ...r, parsed: { ...r.parsed, mensaje: '' } };
      }
      const estrategiaParaMaterializar = estrategiaEfectivaTraza;
      // 007 — la presentabilidad no depende de la etiqueta epistemica de
      // Capa 1. Cuando DESTINO tiene contrato, el Realizador recibe solo
      // material autorizado; el camino sin contrato conserva Transformar
      // para los contextos ya certificados.
      if (!contratoCognitivoEjecutableAntesDeMaterializar
        && estrategiaParaMaterializar === ESTRATEGIAS_MATERIALIZACION.TRANSFORMAR) {
        // Transformar — hoy: el Realizador Conversacional (D-036/037 →
        // D-040, invariante de Alpha: "ningún contenido de la Capa
        // Cognitiva llega al usuario sin pasar por el Realizador"),
        // parametrizado por movimiento/nivel (Contrato §6, §8).
        try {
          // Ciclo Cognitivo de Descubrimiento (ADR §6/§7) — NIVEL DE
          // LENGUAJE PERMITIDO: única señal nueva que cruza hacia el
          // Realizador, calculada determinísticamente por Política
          // (GrafoProyeccion.calcularNivelLenguaje) comparando las tres
          // fotografías reales del grafo de este turno — antes de cualquier
          // fase (state.knowledgeGraph), post-reconciliación
          // (estadoActual.knowledgeGraph) y post-construcción (grafoDelta,
          // o la anterior si este turno no tocó el grafo).
          let nivel = calcularNivelLenguaje(
            state.knowledgeGraph, estadoActual.knowledgeGraph,
            grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio,
          );
          let movimientoDecidido = null;
          // circulomejora006 (corrección final — identidad EXACTA de lo
          // materializado): candidatos autorizados para PROPONER_INTERPRETACION,
          // calculados ANTES de llamar al Realizador — nunca después, nunca
          // por coincidencia textual. Solo existen cuando el movimiento
          // decidido es PROPONER_INTERPRETACION; en cualquier otro caso
          // permanece null y no participa de nada.
          let candidatosMaterializables = null;
          if (gramaticaActivaAlInicio === 'destino') {
            // circulomejora006 (Especificación §1/§3 corregidas) — el
            // movimiento YA fue decidido ANTES de Gobernanza (arriba, junto
            // a contratoMovimientoDestino) — nunca se recalcula aquí.
            // destinoMovimientoCompatible es siempre true para TRANSFORMAR
            // en el catálogo actual (todo movimiento de este vocabulario lo
            // tolera), pero se respeta la variable por honestidad: si algún
            // día dejara de serlo, este bloque no debe ignorar esa señal.
            if (contratoMovimientoDestino && destinoMovimientoCompatible) {
              movimientoDecidido = contratoMovimientoDestino;
              nivel = movimientoDecidido.nivelLenguaje;
              if (movimientoDecidido.movimiento === 'PROPONER_INTERPRETACION') {
                // Ejecución NO se marca aquí — corrección final: que el
                // Realizador produzca texto nunca demuestra, por sí solo,
                // que expresó todos los candidatos disponibles. Se confirma
                // más abajo, solo si hay salida visible Y al menos un
                // conceptoIdsMaterializados válido.
                const grafoParaCandidatos = grafoDelta || estadoActual.knowledgeGraph;
                // circulomejora006 (evaluacionInterpretacion, Commit 2) —
                // identidad EXACTA: el ÚNICO candidato posible es el
                // concepto que Capa 1 mismo identificó este turno vía
                // evaluacionInterpretacion (ya validado estructuralmente en
                // el bucle de construcción — ver evaluacionInterpretacionResultado
                // / conceptoIdInterpretacionValidado, Commit 1). Reemplaza
                // el diseño anterior ("cualquier inferido de la dimensión
                // sin materializar") — la Especificación es explícita: "no
                // permitas que el writer seleccione automáticamente
                // 'cualquier inferido' de la dimensión". Sin una PROPUESTA
                // válida de ESTE turno, no hay candidatos, sea cual sea el
                // estado del grafo — el Realizador nunca recibe una lista
                // para elegir, solo confirma o no expresa la única
                // identidad ya decidida.
                const candidatoIdentificado = evaluacionInterpretacionResultado === 'PROPUESTA' && conceptoIdInterpretacionValidado
                  ? grafoParaCandidatos.conceptos.find(c => c.id === conceptoIdInterpretacionValidado)
                  : null;
                candidatosMaterializables = (candidatoIdentificado
                  && dimensionDeProcedencia(candidatoIdentificado.procedencia) === movimientoDecidido.dimensionObjetivo
                  && candidatoIdentificado.activo === true && !candidatoIdentificado.materializadoEnTurno)
                  ? [candidatoIdentificado]
                  : [];
              }
            }
          } else if (this._movimientoConversacionalEnabled) {
            // Frontera legacy/V2 (Especificación §6) — SIN CAMBIOS para las
            // otras 4 gramáticas: decidirMovimiento (vocabulario viejo,
            // 6 valores) sigue viviendo aquí, exactamente como antes de
            // este incremento.
            movimientoDecidido = movimientoAutoridad
              || decidirMovimiento(estadoActual.knowledgeGraph, gramaticaActivaAlInicio);
            nivel = movimientoDecidido.nivelLenguaje;
          }
          // circulomejora006 (tercera verificación, Sección C3 — Opción B)
          // — EXCLUSIVO de DESTINO+flag activo: Capa 1 ya no produce
          // next_user_action en absoluto (ver AgoraPrompts.
          // buildProtocoloBloqueExplorandoGrafo) — preguntaSiguiente nunca
          // se calcula ni se pasa en ese caso, y el Realizador recibe
          // intervencionCompleta:true para redactar la intervención
          // visible ENTERA (incluida la pregunta, si el movimiento la
          // amerita). Fuera de DESTINO, o con el flag apagado, byte a
          // byte el mismo comportamiento de siempre.
          //
          // DESTINO_AUTORIDAD_INTERPRETATIVA_1 (corrección focal) — la
          // condición ANTES leía `!!contratoMovimientoDestino` en vez del
          // flag de turno: cuando Movimiento decidía algo real pero no
          // accionable todavía (p.ej. DIMENSION_ELEGIBLE_PREPARACION_PENDIENTE,
          // o ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES),
          // contratoMovimientoDestino queda null y esta condición caía en
          // el modo `intervencionCompleta:false` — que asume, sin que sea
          // cierto, que el sistema anexará una pregunta separada tomada de
          // next_user_action.texto. Pero Capa 1 NUNCA produce ese campo
          // bajo el flag (ver comentario de arriba) — así que ninguna
          // pregunta se anexaba nunca, y el Realizador quedaba sin
          // bloqueMovimiento NI bloqueCierre (ambos exclusivos de
          // intervencionCompleta:true): sin la instrucción de cerrar con
          // una pregunta breve o una invitación natural, y sin el
          // recordatorio de economía de palabras del movimiento. La
          // auditoría real encontró exactamente ahí (3 de 4 ejemplos
          // citados) las intervenciones más planas y más sobre-afirmadas
          // de toda la trayectoria — un texto puramente declarativo, sin
          // pregunta, que además el "nivel" por sí solo no lograba frenar.
          // Corrección: la condición pasa a leer el flag de TURNO
          // (promptBase.movimientoConversacionalDestinoActivo — el mismo
          // que ya gobierna nextUserActionRequerido más arriba), no la
          // decisión puntual de contratoMovimientoDestino — Capa 1 sigue
          // sin next_user_action en cualquiera de los dos casos, así que
          // preguntaSiguiente sigue siendo null en la práctica; lo único
          // que cambia es que el Realizador ahora SIEMPRE recibe
          // bloqueCierre (que ya maneja "si lo hay" para el movimiento
          // ausente, y explícitamente permite cerrar sin pregunta cuando
          // de verdad no queda nada que preguntar).
          const destinoMovimientoGobiernaEsteTurno = gramaticaActivaAlInicio === 'destino'
            && destinoMovimientoAplicaEsteTurno;
          const preguntaSiguiente = destinoMovimientoGobiernaEsteTurno
            ? null
            : (r.parsed.next_user_action && r.parsed.next_user_action.texto) || null;
          const historialVisibleReciente = destinoMovimientoGobiernaEsteTurno
            ? this._unitOfWork.turnoRepo
              .paginar(sesionId, null, 3)
              .filter(turno => turno.turnoId !== turnoIdReservadoEnAdmision)
              .reverse()
              .map(turno => ({
                numeroDeTurno: turno.numeroDeTurno,
                mensajeExperto: turno.mensajeExperto,
                mensajeCirculo: turno.mensajeCirculo,
              }))
            : [];
          // CONECTADO_ANCLADO_EN_EVIDENCIA — anclajes reales (los mismos
          // dos hechos que ya justifican nivel==='conectado', ver
          // GrafoProyeccion.seleccionarAnclajesConectados) sobre el grafo
          // tal como queda DESPUÉS de este turno (grafoDelta si construcción
          // tocó el grafo, si no el post-reconciliación) — nunca antes: el
          // propio turno pudo ser el que confirmó la segunda dimensión.
          const anclajesConectados = (gramaticaActivaAlInicio === 'destino' && nivel === 'conectado')
            ? GrafoProyeccion.seleccionarAnclajesConectados(grafoDelta || estadoActual.knowledgeGraph, gramaticaActivaAlInicio)
            : [];
          const hayAnclajesConectados = anclajesConectados.length >= 2;
          // UNIFICACION_INTENCION_CONVERSACIONAL_1 — RECONSTRUCCION_LIFECYCLE_
          // INTERVENCION_T6_T7: Movimiento deja de ser una excepción semántica
          // a la frontera única. Cuando decidió algo accionable, construye
          // AQUÍ su propio ContratoIntervencion real (MovimientoConversacional
          // Policy.construirContratoIntervencionDesdeMovimiento) — FUNCION y
          // ACCION_USUARIO quedan decididas ANTES de materializar, y nivel/
          // anclajesConectados nunca pueden modificarlas después (ver
          // AgoraPrompts.buildRealizadorTurnoConversacional, que ahora exige
          // `funcionIntervencion==='CONECTAR'` -- nunca la sola presencia de
          // anclajes -- para poder exigir una pregunta relacional). Auditado:
          // ningún movimiento de MOVIMIENTOS_DESTINO mapea hoy a 'CONECTAR'
          // (decidirMovimientoDestino nunca selecciona un movimiento POR
          // nivel==='conectado' -- ver el propio cuerpo de esa función), así
          // que `accionRelacionalAutorizada` es estructuralmente false en
          // toda trayectoria real hasta que exista una decisión que
          // explícitamente la autorice -- nunca inferida de que existan
          // anclajes disponibles.
          const funcionIntervencionMovimiento = contratoIntervencionMovimiento ? contratoIntervencionMovimiento.funcion : null;
          const accionRelacionalAutorizada = hayAnclajesConectados && funcionIntervencionMovimiento === 'CONECTAR';
          // CONECTADO_PROCEDENCIA_VERIFICADA (circulomejora006 — corrección
          // sobre CONECTADO_ANCLADO_EN_EVIDENCIA) — el smoke real demostró
          // que "sinAbstraccionNueva:true" era una autodeclaración del MISMO
          // modelo que redactó la prosa, sin nada durable contra qué
          // verificarla. Una PRIMERA corrección (fuenteRelacionId apuntando
          // a cualquier tercer concepto experto) resultó, tras auditoría,
          // insuficiente: un tercer hecho puede ser verdadero y autorizado
          // sin ser, en absoluto, relevante para la relación declarada —
          // "existe un tercer hecho" nunca demuestra "ese hecho vincula
          // exactamente estos dos anclajes con esta operación".
          //
          // Corrección final — FUENTE_RELACIONAL_EXISTENTE_NO_EQUIVALE_A_
          // RELACION_DEMOSTRADA: reutiliza el primitivo YA EXISTENTE
          // KnowledgeGraph.relaciones (nunca arquitectura nueva — ver
          // deltaDesdeParsed/relacionesNuevasExtractivas, arriba en este
          // archivo, que por primera vez lo activa para 'destino', con la
          // misma disciplina extractiva que ya gobierna evidenciaTextual en
          // T-DIM2/S1-DISAGREE1). "fuenteRelacionId" deja de referenciar un
          // concepto cualquiera: ahora referencia una RELACIÓN DURABLE real
          // (grafo.relaciones) cuyo origen/destino son, literalmente, los
          // dos anclajes -- nunca otro par -- y cuyo tipo debe corresponder
          // exactamente a la operación declarada (MAPEO_OPERACION_A_TIPOS_
          // RELACION). Esa relación solo pudo haberse creado, en un turno
          // (este u otro anterior), citando un fragmento LITERAL del
          // mensaje del experto -- la "procedencia/evidencia textual
          // experta" y el "reconocimiento del usuario" que la Especificación
          // exige quedan así demostrados por construcción, nunca por la
          // sola palabra del Realizador.
          // UNIFICACION_INTENCION_CONVERSACIONAL_1 (corrección posterior --
          // CAPACIDAD_PREVIA_VALIDA_DESACOPLADA_DE_SU_ANTIGUA_PUERTA_DE_
          // ENTRADA) -- extraído a src/state/MaterialRelacionalCitable.js,
          // mismo comportamiento exacto, reutilizable como MATERIAL para
          // cualquier función ya decidida (nunca exclusivo de CONECTAR).
          const candidatosFuenteRelacional = hayAnclajesConectados
            ? candidatosRelacionDurableEntreAnclajes(grafoDelta || estadoActual.knowledgeGraph, anclajesConectados)
            : [];
          const validarContratoConectado = (parsed) =>
            validarConexionConectadaDeclarada(parsed, anclajesConectados, candidatosFuenteRelacional);
          const textoDeterministaConectado = () => {
            const [a1, a2] = anclajesConectados;
            return `Por un lado mencionaste "${a1.descripcion}" y, por otro, "${a2.descripcion}". ¿Cuándo empezaste a notar que ambas cosas estaban relacionadas?`;
          };

          let causaReintentoConectado = null;
          let intentosConectado = 0;
          // Distinto de `causaReintentoConectado` (que conserva el motivo
          // del ÚLTIMO fallo real, para trazabilidad) -- este flag es lo
          // único que decide si degrada: debe reflejar el resultado del
          // intento MÁS RECIENTE, nunca "alguna vez falló algo".
          let contratoConectadoValidoEsteTurno = true;
          let rRealizador;
          // C007 — CLOSE EXECUTOR RECOVERY COVERAGE GAP. realizador-
          // conversacional is AUXILIARY: it always runs at least once per
          // `destino` turn (do-while, independent of anclajes), but its
          // output only ever overwrites the Producer's own non-authoritative
          // r.parsed.mensaje (below) -- it never bypasses the canonical
          // Contract -> Realizer (`realizador-contrato`) -> Fidelity gate,
          // which runs separately and later, gated on
          // decision.contratoIntervencionDestino, at the single
          // materializarIntervencionVisible() call site. A bare transport/
          // provider failure here previously had no fallback at all,
          // sinking turns that a healthy fallback executor could have
          // completed. Reuses the ALREADY-EXISTING realizerExecutionCoordinator
          // (same abstraction already wired for the canonical Realizer) —
          // no new coordinator, no change to hayAnclajesConectados/CONECTAR
          // retry semantics, validarMaterializacion gating, or
          // aplicarFallbackMovimientoTrasFallo()'s existing degradation.
          const realizadorConversacionalTask = this._realizerExecutionCoordinator.beginTask({
            tarea: 'realizador_conversacional', gramatica: gramaticaActivaAlInicio,
            userMsg: mensajeUsuario,
          });
          let llmServiceRealizadorConversacionalActivo = realizadorConversacionalTask.current();
          do {
            const { system: realizadorSystem, userMsg: realizadorUserMsg } = buildRealizadorTurnoConversacional({
              observacion: null, preguntaSiguiente, nivel,
              propositoGlobal: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.propositoGlobal
                || PROPOSITO_GLOBAL,
              materialAfirmable: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.materialAfirmable
                || [],
              materialAfirmableScoped: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.materialAfirmableScoped
                || [],
              materialExplorable: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.materialExplorable
                || null,
              gananciaCognitiva: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.gananciaCognitiva
                || null,
              focoExploracion: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.focoExploracion
                || null,
              operacion: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.operacion
                || null,
              desconocidoObjetivo: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.desconocidoObjetivo
                || null,
              desconocidoPreguntableScoped: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.desconocidoPreguntableScoped
                || null,
              actoInterrogativo: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.actoInterrogativo
                || null,
              materialNuevoEsteTurno: (grafoDelta && Array.isArray(grafoDelta.conceptos))
                ? grafoDelta.conceptos
                  .filter(concepto => !idsConceptosAntesTurno.has(concepto.id) && concepto.autoridad === 'experto')
                  .map(concepto => concepto.descripcion)
                : [],
              historialVisibleReciente,
              licenciaEpistemica: contratoIntervencionMovimiento
                && contratoIntervencionMovimiento.contenido
                && contratoIntervencionMovimiento.contenido.licenciaEpistemica
                || 'AFIRMAR_SOLO_AUTORIZADO_Y_PREGUNTAR_LO_DESCONOCIDO',
              movimiento: movimientoDecidido ? movimientoDecidido.movimiento : undefined,
              objetivo: movimientoDecidido ? movimientoDecidido.objetivo : undefined,
              candidatosMaterializables: candidatosMaterializables && candidatosMaterializables.length > 0
                ? candidatosMaterializables.map(c => ({ id: c.id, descripcion: c.descripcion }))
                : null,
              anclajesConectados: hayAnclajesConectados ? anclajesConectados : null,
              candidatosFuenteRelacional: hayAnclajesConectados ? candidatosFuenteRelacional : null,
              causaReintentoConectado,
              intervencionCompleta: destinoMovimientoGobiernaEsteTurno,
              // UNIFICACION_INTENCION_CONVERSACIONAL_1 — la única autoridad
              // que puede exigirle al Realizador declarar "conexionConectada"
              // y cerrar con una pregunta relacional; nunca la sola
              // disponibilidad de anclajes (hayAnclajesConectados).
              funcionIntervencion: funcionIntervencionMovimiento,
            });
            realizadorInvocado = true;
            const invocarRealizadorConversacional = () => llmServiceRealizadorConversacionalActivo.call({
              system: realizadorSystem, userMsg: realizadorUserMsg,
              label: 'realizador-conversacional', callProfile: 'REALIZACION_CONVERSACIONAL', maxRetries: 1,
              // DETERMINISTIC REPLAY CAPTURE -- observability-only, never
              // forwarded to the provider (see LLMService.call docstring):
              // realizadorSystem's own "camposRespuesta" prose IS the
              // contract (AgoraPrompts.buildRealizadorTurnoConversacional)
              // -- no JSON-schema object governs this call anywhere.
              replaySchema: 'NONE',
              turnoId: turnoIdReservadoEnAdmision,
            });
            rRealizador = await invocarRealizadorConversacional();
            if (!rRealizador.parsed
              && realizadorConversacionalTask.escalate(PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE)) {
              // Bounded, same-task escalation on transport/provider failure
              // only -- content/CONECTAR-validity retries below are
              // unaffected and keep using whichever executor is current.
              llmServiceRealizadorConversacionalActivo = realizadorConversacionalTask.current();
              rRealizador = await invocarRealizadorConversacional();
            }
            intentosConectado++;
            if (!hayAnclajesConectados) break;
            const produjoAlgo = !!(rRealizador.parsed && typeof rRealizador.parsed.mensaje === 'string' && rRealizador.parsed.mensaje.trim());
            if (!produjoAlgo) {
              // fallo de transporte/parseo -- solo bloquea el turno si
              // CONECTAR estaba autorizado (contrato exige la estructura);
              // fuera de CONECTAR, un fallo de transporte se resuelve por
              // el camino normal (aplicarFallbackMovimientoTrasFallo, más
              // abajo), nunca por este retry -- "conexionConectada" nunca
              // fue obligatoria fuera de CONECTAR.
              contratoConectadoValidoEsteTurno = !hayAnclajesConectados || !accionRelacionalAutorizada;
              break;
            }
            // UNIFICACION_INTENCION_CONVERSACIONAL_1 (MATERIAL_RELACIONAL_
            // CITABLE) — fuera de CONECTAR, declarar "conexionConectada" es
            // OPCIONAL (el material solo enriquece la función ya decidida):
            // su ausencia es válida por omisión, nunca dispara reintento.
            // Si el Realizador SÍ la declara espontáneamente, debe seguir
            // cumpliendo exactamente la misma verificación estructural que
            // bajo CONECTAR -- nunca una relación inventada, aquí tampoco.
            if (!accionRelacionalAutorizada && rRealizador.parsed.conexionConectada === undefined) {
              contratoConectadoValidoEsteTurno = true;
              conexionConectadaTraza = null;
              break;
            }
            const validacionConectado = validarContratoConectado(rRealizador.parsed);
            contratoConectadoValidoEsteTurno = validacionConectado.valido;
            if (validacionConectado.valido) {
              conexionConectadaTraza = rRealizador.parsed.conexionConectada
                ? {
                    anclajeAId: rRealizador.parsed.conexionConectada.anclajeAId,
                    anclajeBId: rRealizador.parsed.conexionConectada.anclajeBId,
                    operacionRelacional: rRealizador.parsed.conexionConectada.operacionRelacional,
                    fuenteRelacionId: rRealizador.parsed.conexionConectada.fuenteRelacionId || null,
                  }
                : null;
              break;
            }
            causaReintentoConectado = validacionConectado.motivo;
          } while (hayAnclajesConectados && intentosConectado < 2);

          if (hayAnclajesConectados && !contratoConectadoValidoEsteTurno && intentosConectado >= 2) {
            if (accionRelacionalAutorizada) {
              // Segundo fallo bajo CONECTAR -- nunca mostrar la relación
              // causal/contraste/secuencia inventada sin fuente real:
              // degradación determinista y segura (nunca otra llamada al
              // modelo), citando literalmente los dos anclajes reales, con
              // la pregunta concreta que el contrato exige -- equivalente a
              // RELACION_POR_COMPROBAR.
              rRealizador = { parsed: { mensaje: textoDeterministaConectado() } };
              conexionConectadaTraza = {
                anclajeAId: anclajesConectados[0].id, anclajeBId: anclajesConectados[1].id,
                operacionRelacional: 'RELACION_POR_COMPROBAR', fuenteRelacionId: null,
              };
            } else {
              // Segundo fallo fuera de CONECTAR -- el Realizador insistió en
              // una relación fabricada/no citable dentro de OTRA función:
              // degradar al texto determinista de CONECTAR sería inventar
              // una segunda intención que Movimiento nunca decidió. Se
              // trata exactamente como "el Realizador no produjo salida" y
              // cae al MISMO fallback F1 ya gobernado por Movimiento --
              // cero llamadas LLM nuevas, la acción/función real se
              // preserva intacta.
              rRealizador = { parsed: null };
              conexionConectadaTraza = null;
            }
            contratoConectadoDegradadoTraza = true;
          }
          // FRONTERA_INTERVENCION_VISIBLE_1 (corrección focal —
          // MOVIMIENTO_DENTRO_DE_FRONTERA_UNICA) — red de seguridad final,
          // aplicada a CUALQUIER salida real de Movimiento antes de
          // aceptarla como mensaje visible -- nunca exclusiva del camino
          // 'conectado' (que ya reutiliza su propio reintento arriba, ver
          // validarContratoConectado): el hallazgo real de la trayectoria
          // humana ("La estrella", turno 1) nunca pasó por 'conectado'.
          // Mismo validador que ya gobierna ContratoIntervencion
          // (metacomentario + vocabulario interno no ganado) -- Movimiento
          // deja de ser una autoridad visible paralela sin gobierno, sin
          // convertirse en una SEGUNDA materialización: si falla aquí, se
          // trata exactamente como "el Realizador no produjo salida" y cae
          // al MISMO fallback F1 ya gobernado por Movimiento (cero llamadas
          // LLM nuevas, ver punto 8 del incremento).
          if (rRealizador.parsed && typeof rRealizador.parsed.mensaje === 'string' && rRealizador.parsed.mensaje.trim()) {
            const validacionSuperficieMovimiento = validarMaterializacion(
              rRealizador.parsed.mensaje.trim(), { accionUsuario: { tipo: 'ninguna' } }, mensajeUsuario,
            );
            if (!validacionSuperficieMovimiento.valido) {
              rRealizador = { parsed: null };
            }
          }
          realizadorProdujoSalida = !!(
            rRealizador.parsed
            && typeof rRealizador.parsed.mensaje === 'string'
            && rRealizador.parsed.mensaje.trim()
          );
          // AUTHORIZED_VISIBLE_OUTPUT_AVAILABLE — snapshot into the
          // function-scoped mirror right where this flag reaches its final
          // value for this turn (see its own declaration comment).
          realizadorProdujoSalidaEsteTurno = realizadorProdujoSalida;
          if (realizadorProdujoSalida) {
            r = { ...r, parsed: { ...r.parsed, mensaje: rRealizador.parsed.mensaje.trim() } };
            salidaVisibleSeguraTraza = true;
            if (movimientoDecidido && movimientoDecidido.movimiento !== MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION) {
              movimientoEjecutadoDestino = true;
            }
          } else {
            aplicarFallbackMovimientoTrasFallo();
          }

          // circulomejora006 (corrección final) — pasos 5-7 del orden
          // obligatorio: (5) salida visible confirmada, (6) identidad de lo
          // realmente materializado validada contra los candidatos
          // autorizados de ESTE turno, (7) estampado. Ninguno de los tres
          // corre para ningún otro movimiento — PROPONER_INTERPRETACION es
          // el único que exige esta identidad exacta.
          if (
            !realizadorFalloTraza
            && movimientoDecidido
            && movimientoDecidido.movimiento === 'PROPONER_INTERPRETACION'
          ) {
            const textoVisible = !!(r.parsed && typeof r.parsed.mensaje === 'string' && r.parsed.mensaje.trim());
            const idsPropuestos = Array.isArray(rRealizador.parsed && rRealizador.parsed.conceptoIdsMaterializados)
              ? rRealizador.parsed.conceptoIdsMaterializados
              : [];
            const idsAutorizados = new Set((candidatosMaterializables || []).map(c => c.id));
            const idsValidos = idsPropuestos.filter(id => idsAutorizados.has(id));
            if (textoVisible && idsValidos.length > 0) {
              const grafoAntesDeMarcar = grafoDelta || estadoActual.knowledgeGraph;
              const evidenciaBaseIds = conceptosDeGramatica(grafoAntesDeMarcar, gramaticaActivaAlInicio)
                .filter(c => dimensionDeProcedencia(c.procedencia) === movimientoDecidido.dimensionObjetivo && c.autoridad === 'experto')
                .map(c => c.id);
              // El próximo numeroDeTurno es de solo lectura (SELECT MAX+1) y
              // esta sesión ya está serializada por _procesarBajoExclusividad
              // (ningún otro turno de la MISMA sesión corre en paralelo) —
              // leerlo aquí, antes de la transacción, coincide exactamente
              // con el que _confirmarInteraccion calculará más abajo.
              const turnoActual = this._unitOfWork.turnoRepo.proximoNumeroDeTurno(sesionId);
              const { grafoNuevo: grafoMarcado } = aplicarMarcaMaterializacion(grafoAntesDeMarcar, {
                conceptoIds: idsValidos, dimensionObjetivo: movimientoDecidido.dimensionObjetivo,
                turno: turnoActual, movimiento: 'PROPONER_INTERPRETACION', evidenciaBaseIds,
              });
              if (grafoMarcado) {
                grafoDelta = grafoMarcado;
                movimientoEjecutadoDestino = true;
              } else {
                // Defensivo: candidatosMaterializables ya garantiza que
                // idsValidos cumple las cinco condiciones — este camino no
                // debería alcanzarse nunca en la práctica, pero si algo lo
                // invalidara igual se degrada, nunca se rechaza el turno.
                movimientoNoEjecutadoRazon = 'INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA';
                dimensionInterpretacionDiferidaEsteTurno = movimientoDecidido.dimensionObjetivo;
              }
            } else {
              // Ni la falta de texto visible ni una lista vacía/inválida de
              // conceptoIdsMaterializados bloquean el turno: no se estampa
              // nada, la oportunidad NO se consume, Progreso no se bloquea
              // — solo se registra la razón (Especificación, corrección
              // final, condición adicional obligatoria).
              // circulomejora006 (evaluacionInterpretacion, Commit 2) —
              // disambiguación de razón: si la ausencia de candidatos se
              // debe a que Capa 1 NUNCA produjo una evaluación válida este
              // turno (evaluacionInterpretacionOmitida por motivo
              // 'contrato' — resultado ausente/inválido, o razon inválida
              // en NO_PROPUESTA), la razón es la NUEVA
              // EVALUACION_INTERPRETACION_OMITIDA — nunca se confunde con
              // un problema de identidad de materialización. Cualquier otro
              // caso (NO_PROPUESTA válida sin candidatos, PROPUESTA con
              // conceptoId inválido — motivo 'identidad', o el Realizador
              // simplemente no expresó el único candidato disponible)
              // conserva el código EXISTENTE.
              movimientoNoEjecutadoRazon = (evaluacionInterpretacionOmitida && evaluacionInterpretacionMotivoOmision === 'contrato')
                ? 'EVALUACION_INTERPRETACION_OMITIDA'
                : 'INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA';
              // circulomejora006 (corrección posterior a la prueba real) —
              // el hallazgo central: sin esta marca, la dimensión sigue
              // viéndose idéntica a una nunca intentada, y Movimiento la
              // vuelve a proponer turno tras turno indefinidamente. Marcar
              // "diferida" no es un concepto, no toca el grafo, no bloquea
              // Progreso — solo un hecho de turno que la próxima selección
              // podrá consultar (Commit 2).
              dimensionInterpretacionDiferidaEsteTurno = movimientoDecidido.dimensionObjetivo;
            }
          }
        } catch (e) {
          if (realizadorInvocado && !realizadorProdujoSalida) {
            aplicarFallbackMovimientoTrasFallo();
          }
        }
      } else if (!contratoCognitivoEjecutableAntesDeMaterializar
        && estrategiaParaMaterializar === ESTRATEGIAS_MATERIALIZACION.DETERMINISTA) {
        // Determinista — exclusivamente bug #6: el contrato de este turno
        // agotó los reintentos sin validar nunca (contratoDeCamposValidado
        // falso, o evaluacionGrafo===RECHAZADA). Cualquiera de las dos
        // excluye Transformar Y Preservar por igual — Determinista es la
        // única admisible. Ninguna prosa de Capa 1 es confiable aquí —
        // este es un cambio real de comportamiento respecto de antes de
        // este Contrato: antes se mostraba el "mensaje" crudo del último
        // intento fallido de Capa 1 (nunca validado); ahora no se confía
        // en él en absoluto.
        r = { ...r, parsed: { ...r.parsed, mensaje: '' } };
        // P0-B (INVARIANTE_DE_RESPUESTA_VISIBLE_NO_VACIA) — hallazgo: antes
        // de esta corrección, SOLO REPARAR_TRAS_RECHAZO reponía un texto
        // aquí (vía textoDeterministaReparacion, hardcodeado). Para los
        // otros cuatro movimientos (PEDIR_CONTEXTO, PEDIR_EJEMPLO,
        // REFLEJAR_Y_PROFUNDIZAR, PROPONER_INTERPRETACION) `mensaje`
        // quedaba en '' sin que nada la repusiera — el turno se confirmaba
        // igual (ok:true, Turno persistido, mensajeCirculo:'') — un éxito
        // aparente sin salida visible ni causa estructurada. Reproducido en
        // test_p0b_..._invariante_salida_visible.js.
        //
        // Corrección: reutiliza el MISMO F1 (fallbackMovimientoTrasFalloRealizador)
        // que ya declara, por movimiento, qué materialización mínima es
        // admisible sin prosa — nunca una segunda tabla paralela. F1 ya
        // cubre los cinco movimientos, incluido REPARAR_TRAS_RECHAZO (que
        // devuelve exactamente textoDeterministaReparacion) — el bloque
        // especial anterior queda subsumido, nunca duplicado.
        //
        //   - modo DETERMINISTA con texto (PEDIR_CONTEXTO, PEDIR_EJEMPLO,
        //     REPARAR_TRAS_RECHAZO): texto autosuficiente, nunca depende de
        //     prosa — se usa tal cual, movimiento ejecutado.
        //   - modo PRESERVAR/NO_DETERMINABLE (REFLEJAR_Y_PROFUNDIZAR,
        //     PROPONER_INTERPRETACION): a diferencia de
        //     aplicarFallbackMovimientoTrasFallo (Realizador falló pero
        //     mensajeValidado pudo ser true), AQUÍ el contrato completo de
        //     Capa 1 nunca validó — no hay ninguna prosa confiable que
        //     preservar. Sin salida visible segura posible: nunca se
        //     confirma un Turno silencioso — se aborta ANTES de cualquier
        //     persistencia (mismo patrón que SINTESIS_INVALIDA, más abajo:
        //     ni Turno, ni slot, ni evento), con un fallo técnico explícito
        //     y reintentable — el turnoClienteId nunca se consume, un
        //     reintento legítimo puede procesarse normalmente.
        //
        // Exclusivo de contratoMovimientoDestino presente (un movimiento
        // SÍ fue decidido este turno) — auditoría de regresión (suite
        // T1-T10) confirmó que MOVIMIENTO_AUSENTE (Movimiento no decidió
        // nada, p.ej. ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES o un
        // turno de reconciliación/interno) alcanza DETERMINISTA
        // legítimamente en flujos ya probados, sin relación con el hallazgo
        // de la auditoría real (los 8/27 turnos silenciosos observados
        // SIEMPRE tenían un movimiento decidido — ver
        // test_p0b_invariante_salida_visible.js). Escalar también ese caso
        // excedería el alcance evidenciado y rompe comportamiento existente
        // — queda fuera de este incremento, reportado explícitamente en la
        // entrega, no resuelto por omisión.
        //
        // Deliberadamente SIN el chequeo destinoMovimientoCompatible que el
        // bloque anterior (solo REPARAR_TRAS_RECHAZO) sí usaba: esa bandera
        // traza si la estrategia YA seleccionada es la que el movimiento
        // "exige" en operación normal (MATRIZ_COMPATIBILIDAD_MOVIMIENTO_
        // ESTRATEGIA — todo movimiento exploratorio exige Transformar,
        // nunca Determinista) — aquí Determinista YA es una degradación
        // (bug #6), así que esa incompatibilidad es precisamente el caso
        // esperado para PEDIR_CONTEXTO/PEDIR_EJEMPLO/REFLEJAR_Y_PROFUNDIZAR/
        // PROPONER_INTERPRETACION, nunca una razón para negarles el mismo
        // resguardo que REPARAR_TRAS_RECHAZO ya tenía.
        if (gramaticaActivaAlInicio === 'destino' && contratoMovimientoDestino) {
          const fallbackDeterminista = fallbackMovimientoTrasFalloRealizador(contratoMovimientoDestino);
          if (fallbackDeterminista.modo === MODOS_FALLBACK_MOVIMIENTO.DETERMINISTA && fallbackDeterminista.texto) {
            const textoVisible = fallbackDeterminista.texto.trim();
            r = { ...r, parsed: { ...r.parsed, mensaje: textoVisible } };
            movimientoEjecutadoDestino = true;
            fallbackMovimientoAplicadoTraza = true;
            salidaVisibleSeguraTraza = true;
          } else {
            // TERMINACION_CONOCIDA_SIN_TURNO — mismo principio que
            // LLM_UNAVAILABLE más abajo: contrato agotado sin fallback
            // determinista posible es un resultado CONOCIDO, no un crash.
            if (falloReparacionDiferido) return emitirFalloReparacionDiferido();
            this._marcarEntradaFallidaSiEsSeguro({
              turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
              causa: 'SALIDA_VISIBLE_NO_DISPONIBLE', errorCategory: null, retryable: null,
            });
            return {
              // C007 — HONEST FAILURE SURFACE (human canary v10 T2, confirmed
              // executed live in the T1->T2 continuity replay for this same
              // increment). TECHNICAL_FAILURE != COGNITIVE_INTERVENTION: the
              // internal diagnostic (movimiento/codigoRazon) stays in
              // `codigo`/logs; the visible copy is the shared honest
              // operational fallback, never engine/movement/contract jargon.
              ok: false, httpStatus: 502, codigo: 'SALIDA_VISIBLE_NO_DISPONIBLE',
              mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
            };
          }
        }
      }
      // PRESERVAR seleccionada explícitamente: no-op — r.parsed.mensaje ya
      // es el texto validado de Capa 1. Este es el caso de bug #7 (contrato
      // válido, solo faltaba "observacion" para que Transformar pudiera
      // ejecutarse): Preservar SÍ es admisible (mensajeValidado +
      // contratoDeCamposValidado + evaluacionGrafo===APROBADA se cumplen)
      // y queda por delante de Determinista en la prioridad de selección
      // de EXPLORANDO_GRAFO — mismo resultado visible que antes (el
      // "mensaje" ya validado de Capa 1), pero ahora como decisión
      // explícita de la Gobernanza, nunca una omisión.

      // Gobernanza de Materialización — contexto ESPERANDO_CONFIRMACION_
      // RECHAZA (migrado en la corrección posterior a 5616ae5, junto con
      // LISTO_PARA_SINTESIS). Ciclo Cognitivo de Descubrimiento (ADR):
      // eliminar el Realizador de este estado no bastaba, porque el
      // "mensaje" que Capa 1 ya escribió al clasificar (prosa libre, igual
      // que "observacion") puede reintroducir el marco recién negado —
      // afirmado o por negación. Un rechazo no es un espacio para que
      // Círculo demuestre comprensión con una reinterpretación propia: es
      // la orden de dejar de interpretar — de ahí que la Política de
      // admisibilidad de este contexto (GobernanzaMaterializacion.js)
      // excluya Transformar y Preservar SIN condición, nunca solo cuando
      // las Garantías de confianza en la prosa son falsas.
      // reaccionRechazoControlada es, exactamente,
      // la implementación de Determinista para este contexto (Contrato
      // §8): cita correccion_detalle EXTRACTIVAMENTE, nunca lo eleva.
      // Orden conceptual respetado: esto corre DESPUÉS de validar el
      // contrato y clasificar, pero ANTES de que decidirInteraccion/
      // _confirmarInteraccion comprometan la invalidación física del
      // concepto — la salida visible ya refleja la decisión, aunque el
      // commit del grafo ocurra más abajo.
      // S1-DISAGREE1 — la misma disciplina Determinista aplica cuando
      // "corrige" cuestiona semánticamente la relación completa (mismo
      // impacto sobre la autoridad cognitiva que un "rechaza" con
      // ambito_correccion="relacion") — nunca la palabra elegida por Capa 1
      // decide, por sí sola, si la prosa libre es confiable aquí.
      const esCorreccionSemanticaRelacional = r.parsed
        && r.parsed.clasificacion_respuesta === 'corrige'
        && r.parsed.impacto_cambio === IMPACTOS_CAMBIO.SEMANTICO
        && r.parsed.ambito_correccion === AMBITOS_CORRECCION_RELACIONAL.RELACION;
      if (
        protocoloEstadoEfectivo === 'ESPERANDO_CONFIRMACION' &&
        validacionContratoFinal && validacionContratoFinal.valido && r.parsed
        && (r.parsed.clasificacion_respuesta === 'rechaza' || esCorreccionSemanticaRelacional)
      ) {
        // Garantías atómicas: mensajeValidado (calculada arriba, una vez
        // por turno) + contratoDeCamposValidado/evaluacionGrafo (del mismo
        // bucle de reintento — este turno es ESPERANDO_CONFIRMACION, así
        // que reflejan el contrato de esa rama, no el de EXPLORANDO). No
        // determinan nada aquí en la práctica: la Política contextual de
        // este contexto excluye Transformar/Preservar sin condición — se
        // pasan de todos modos, completas y honestas, porque la Gobernanza
        // nunca debe recibir un hueco donde falta una Garantía.
        const garantiasRechazo = {
          mensajeValidado,
          contratoDeCamposValidado,
          evaluacionGrafo,
          observacionDisponible: false,
          materializadorEspecializadoActivo: false,
          debeSuprimirse: false,
        };
        const { seleccionada: estrategiaRechazo } = decidirMaterializacion(
          garantiasRechazo, CONTEXTOS_MATERIALIZACION.ESPERANDO_CONFIRMACION_RECHAZA,
        );
        if (estrategiaRechazo === ESTRATEGIAS_MATERIALIZACION.DETERMINISTA) {
          r = {
            ...r,
            parsed: {
              ...r.parsed,
              mensaje: reaccionRechazoControlada(r.parsed.correccion_detalle, { esCorreccionParcial: esCorreccionSemanticaRelacional }),
            },
          };
        }
        // Ninguna otra rama esperada: la Política de admisibilidad de este
        // contexto excluye Transformar/Preservar siempre — Determinista es
        // la única estrategia que este contexto puede seleccionar.
      }

      // Punto 9 (alcance aprobado): sin fallback determinista posible para
      // una síntesis inventada — ni contenido fabricado, ni una síntesis
      // vacía. Error controlado, sin ningún efecto persistente: ni Turno,
      // ni slot, ni evento, exactamente como LLM_UNAVAILABLE más abajo.
      // Alcance exacto (corrección de endurecimiento): esto SOLO aborta si
      // `mensaje` (la síntesis) sigue inválido — nunca por contaminación
      // cruzada de otros campos que ya sobrevivió a los reintentos. Esa
      // contaminación se descarta sin efecto (ver decidirProtocolo: LISTO_
      // PARA_SINTESIS nunca lee next_user_action/clasificacion_respuesta del
      // generador), pero no amerita fabricar un error sobre una síntesis que
      // sí es válida.
      const mensajeSigueInvalido = !(r.parsed && typeof r.parsed.mensaje === 'string' && r.parsed.mensaje.trim());
      if (r.parsed && mensajeSigueInvalido && protocoloEstadoEfectivo === 'LISTO_PARA_SINTESIS') {
        // TERMINACION_CONOCIDA_SIN_TURNO — misma frontera que LLM_UNAVAILABLE:
        // síntesis inválida tras agotar los reintentos de formato es un
        // resultado CONOCIDO, nunca un crash equivalente.
        this._marcarEntradaFallidaSiEsSeguro({
          turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
          causa: 'SINTESIS_INVALIDA', errorCategory: null, retryable: null,
        });
        return {
          ok: false, httpStatus: 502, codigo: 'SINTESIS_INVALIDA',
          mensaje: `El motor no produjo una síntesis válida tras ${intentosContratoFinal} reintento(s) de formato: ${(validacionContratoFinal && validacionContratoFinal.errores || []).join('; ')}`,
        };
      }
      // Para EXPLORANDO/ESPERANDO_CONFIRMACION, una violación de contrato
      // que sobrevive a los reintentos NO aborta el turno: decidirInteraccion
      // → decidirProtocolo ya sabe resolverla con su propio fallback
      // determinista (Incremento 1/2), sin gastar más llamadas al LLM.

      // Gobernanza de Materialización — contexto LISTO_PARA_SINTESIS
      // (migrado en la corrección posterior a 5616ae5, junto con
      // ESPERANDO_CONFIRMACION/rechaza). Errata documentada en el Contrato
      // §8: este camino corresponde a Preservar, no a Delegar — la
      // "edición dirigida" (AgoraPrompts.buildProtocoloBloqueSintesisGrafo)
      // es una instrucción de prompt dentro de la MISMA llamada que
      // produce "mensaje", nunca un materializador separado que ya haya
      // construido el texto bajo su propia autoridad.
      //
      // Garantías atómicas (auditoría de tipado semántico posterior a
      // 23b766f) — construidas a mano para este contexto, NUNCA
      // reutilizando contratoDeCamposValidado/evaluacionGrafo del bucle de
      // arriba: esas dos reflejan el contrato de EXPLORANDO/ESPERANDO_
      // CONFIRMACION cuando protocoloEstadoEfectivo es ese otro estado —
      // para LISTO_PARA_SINTESIS habría que recalcularlas de cero, y al
      // hacerlo se ve que ninguna aporta nada real en este contrato:
      //   mensajeValidado          — la Garantía real (calculada arriba,
      //     una sola vez); ya la garantizó el abort de arriba (mensaje
      //     inválido aborta ANTES de llegar hasta acá).
      //   contratoDeCamposValidado — `true`, documentado como vacuo: el
      //     contrato de LISTO_PARA_SINTESIS no exige NADA más allá de
      //     "mensaje" (a diferencia de EXPLORANDO/ESPERANDO_CONFIRMACION,
      //     que sí tienen restricciones adicionales — next_user_action,
      //     clasificacion_respuesta). `camposCruzados` (next_user_action/
      //     clasificacion_respuesta/correccion_detalle) SÍ se evalúa en
      //     validarContratoPorEstado para este estado, pero deliberadamente
      //     NO se usa como Garantía aquí — detecta contaminación de campos
      //     ajenos, no falta de confiabilidad de la síntesis misma.
      //   evaluacionGrafo          — NO_APLICA, honesto: este contrato
      //     nunca invoca aplicarDelta/elegibilidad en este bucle (la
      //     promoción del concepto de síntesis ocurre después, vía
      //     debeVersionarSintesis, incondicional — nunca gateada acá). Sería
      //     falsificar la Garantía inventar una aprobación que nunca corrió.
      if (protocoloEstadoEfectivo === 'LISTO_PARA_SINTESIS' && grafoModoSesion && r.parsed) {
        const garantiasSintesis = {
          mensajeValidado,
          contratoDeCamposValidado: true,
          evaluacionGrafo: EVALUACION_GRAFO.NO_APLICA,
          observacionDisponible: false,
          materializadorEspecializadoActivo: false,
          debeSuprimirse: false,
        };
        decidirMaterializacion(garantiasSintesis, CONTEXTOS_MATERIALIZACION.LISTO_PARA_SINTESIS);
        // PRESERVAR es la única estrategia alcanzable en la práctica en
        // este punto (mensajeValidado siempre true tras el abort de
        // arriba) — no-op intencional: r.parsed.mensaje ya es la síntesis
        // validada de Capa 1, exactamente lo que corresponde mostrar. Se
        // invoca la Gobernanza igual (en vez de omitir la llamada) para
        // que esta decisión quede trazada como una selección explícita,
        // no una omisión — mismo espíritu que el resto de este archivo.
      }
    }

    // 7. Sin respuesta cognitiva válida (fallo de transporte/parseo, ya
    // reintentado internamente por LLMService): solo eventos técnicos (ya
    // emitidos en tiempo real). Ningún Turno, ningún numeroDeTurno
    // consumido, ningún cambio de estado.
    //
    // TERMINACION_CONOCIDA_SIN_TURNO (corrección posterior — la frontera no
    // es throw vs return): este RETORNO estructurado, tras agotar la
    // política de reintentos de LLMService (o tras un preflight rechazado),
    // es una terminación tan CONOCIDA como una excepción capturada — el
    // Writer sabe con certeza que este intento terminó sin Turno. Marca
    // FALLIDO igual que un catch(e) — nunca deja la entrada en PENDIENTE
    // fingiendo que el resultado es desconocido (ver Test Q1, distinto de
    // Test Q2 — crash real, sin ningún retorno ni catch).
    if (!r.parsed) {
      const errorCategoryLlmUnavailable = r.errorCategory || null;
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        causa: 'LLM_UNAVAILABLE', errorCategory: errorCategoryLlmUnavailable,
        retryable: retryableDesdeErrorCategory(errorCategoryLlmUnavailable),
      });
      return {
        ok: false, httpStatus: 502, codigo: 'LLM_UNAVAILABLE',
        mensaje: 'El motor no produjo una respuesta cognitiva válida.',
      };
    }

    // circulomejora006 (corrección posterior a la prueba real) — fusiona el
    // diferimiento de ESTE turno (si lo hubo) con el historial ya persistido
    // de la sesión — nunca lo reemplaza (monótono, ver CognitiveState.js).
    // Esta fotografía debe existir antes de evaluar la suficiencia postturno.
    const dimensionesInterpretacionDiferidaAntes = (estadoActual.protocoloDimensionesInterpretacionDiferida || []);
    const turnoInterpretacionDiferida = dimensionInterpretacionDiferidaEsteTurno
      ? this._unitOfWork.turnoRepo.proximoNumeroDeTurno(sesionId)
      : null;
    const dimensionesInterpretacionDiferidaNuevo = dimensionInterpretacionDiferidaEsteTurno
      ? [...new Set([...dimensionesInterpretacionDiferidaAntes, dimensionInterpretacionDiferidaEsteTurno])]
      : dimensionesInterpretacionDiferidaAntes;
    const dimensionesInterpretacionSinGananciaNuevo = dimensionesInterpretacionSinGananciaEsteTurno;

    // C1-B — fotografía postturno proyectada. El comando se deriva UNA sola
    // vez con la API pública de C1-R y se reutiliza, sin recalcular, dentro
    // de la transacción final.
    // La respuesta dirigida conserva la autoridad causal de la intervención
    // anterior. No se hace join con el Movimiento decidido en este turno:
    // una respuesta puede resolver R aunque otra obligación gobierne el
    // siguiente movimiento.
    const referenciaRespuestaDirigida = contratoRespuestaDirigidaEsteTurno
      && contratoRespuestaDirigidaEsteTurno.referenciaResolucion;
    const usaReferenciaRespuesta = !!(referenciaRespuestaDirigida && referenciaRespuestaDirigida.obligacionId);
    const obligacionResolucion = usaReferenciaRespuesta
      ? referenciaRespuestaDirigida.obligacionId
      : (contratoMovimientoDestino && contratoMovimientoDestino.obligacionId);
    const intentoResolucion = usaReferenciaRespuesta
      ? referenciaRespuestaDirigida.intentoInterpretacionId
      : (contratoMovimientoDestino && contratoMovimientoDestino.intentoInterpretacionId);
    const reparacionResolucion = obligacionResolucion
      && estadoActual.protocoloReparacionesInterpretativasPendientes
      && estadoActual.protocoloReparacionesInterpretativasPendientes[obligacionResolucion];
    const propuestaResolucion = intentoResolucion && (
      (usaReferenciaRespuesta && alineacionRespuestaDirigidaResultadoTraza
        && alineacionRespuestaDirigidaResultadoTraza.satisfaccionReparacion
        && alineacionRespuestaDirigidaResultadoTraza.satisfaccionReparacion.intentoInterpretacionId === intentoResolucion
        ? alineacionRespuestaDirigidaResultadoTraza.satisfaccionReparacion : null)
      || certificacionesSatisfaccionReparacionEsteTurno.find(
        certificacion => certificacion && certificacion.intentoInterpretacionId === intentoResolucion,
      )
    );
    const certificacionResolucion = certificacionSatisfaccionResolucionEsteTurno || (reparacionResolucion && propuestaResolucion
      ? (() => {
          const propuestaNormalizada = normalizarPropuestaSatisfaccion({
            reparacion: reparacionResolucion,
            propuesta: propuestaResolucion,
            materialIdsDisponibles: (grafoDelta && Array.isArray(grafoDelta.conceptos)
              ? grafoDelta.conceptos.filter(concepto => !idsConceptosAntesTurno.has(concepto.id))
              : []),
          });
          if (!propuestaNormalizada) return null;
          return certificarSatisfaccionReparacion({
            reparacion: reparacionResolucion,
            criterioSatisfaccion: reparacionResolucion.criterioSatisfaccion,
            obligacionId: reparacionResolucion.obligacionId,
            intentoInterpretacionId: intentoResolucion,
            materialIds: propuestaNormalizada.materialIds,
            materialesDisponibles: (grafoDelta && Array.isArray(grafoDelta.conceptos)
              ? grafoDelta.conceptos.filter(concepto => !idsConceptosAntesTurno.has(concepto.id))
              : []),
            satisface: propuestaNormalizada.satisface,
            fuente: usaReferenciaRespuesta ? 'RESPUESTA_DIRIGIDA' : 'RECONCILIACION',
          });
        })()
      : null);
    const reparacionParaComando = reparacionResolucion || (certificacionResolucion
      && estadoActual.protocoloReparacionesInterpretativasPendientes
      && estadoActual.protocoloReparacionesInterpretativasPendientes[certificacionResolucion.obligacionId]);
    const comandosResolucionReparacion = derivarComandosResolucion(
      certificacionResolucion
        && reparacionParaComando
        ? {
            movimiento: usaReferenciaRespuesta || !contratoMovimientoDestino ? null : contratoMovimientoDestino.movimiento,
            movimientoEjecutado: usaReferenciaRespuesta ? false : movimientoEjecutadoDestino,
            obligacionId: reparacionParaComando.obligacionId,
            intentoInterpretacionId: reparacionParaComando.intentoInterpretacionId,
            dimension: reparacionParaComando.dimension,
            satisfaccionReparacion: certificacionResolucion,
            criterioSatisfaccion: reparacionParaComando.criterioSatisfaccion,
          }
        : null,
    );
    const reparacionesPostTurnoProyectadas = aplicarComandosReparacion({
      secuenciaActual: estadoActual.protocoloSecuenciaReparacionInterpretativa,
      reparacionesActuales: estadoActual.protocoloReparacionesInterpretativasPendientes,
      comandos: comandosResolucionReparacion,
    });
    const reparacionesInterpretativasPostTurno = proyectarReparacionesPendientes(
      reparacionesPostTurnoProyectadas.reparacionesResultantes,
    );

    // circulomejora006_act10l — intento de nueva propuesta relacional.
    // Se calcula AQUÍ, ANTES de decidirInteraccion (que debe permanecer
    // pura, sin efectos): evaluarEstadoRelacionTransformacionalDestino SÍ
    // tiene un efecto real (registra en emisionesLegitimas cuando la
    // propuesta es legítima) — mismo principio que grafoDelta, ya resuelto
    // arriba antes de esta misma llamada. Exclusivo de destino+EXPLORANDO+
    // objetivo dirigido activo (nunca otra gramática, nunca otro estado,
    // nunca sin objetivo — byte-identical en cualquier otro caso).
    //
    // Fuente de la proposición: EXCLUSIVAMENTE grafoDelta (o, si esta rama
    // de construcción no mutó el grafo, estadoActual.knowledgeGraph) — el
    // grafo YA reconciliado/actualizado con lo que este turno aportó. Nunca
    // el mensaje del usuario, next_user_action, ni nada enviado por el
    // cliente: proponerRelacionTransformacionalDestino (dentro de
    // evaluarEstadoRelacionTransformacionalDestino) deriva roles/estructura
    // relacional/formulación exclusivamente de conceptos ya reconciliados
    // con autoridad 'experto', y verifica memoria negativa antes de emitir
    // — nada de eso se reimplementa aquí.
    // relacionTransformacionalEstadoEsteTurno: contrato ESTRECHO de 3
    // valores que decidirProtocolo realmente entiende ('CONFIRMADA_VIGENTE'
    // | 'CANDIDATA_DISPONIBLE' | 'BLOQUEADA_SIN_SENAL_NUEVA' — su propia
    // rama trata cualquier valor que no sea 'BLOQUEADA_SIN_SENAL_NUEVA' como
    // "CANDIDATA_DISPONIBLE", por diseño de act10c). causaRelacionalObservada
    // conserva el estado REAL y más amplio de evaluarEstadoRelacionTransformacionalDestino
    // ('SIN_COBERTURA'/'ERROR_INESPERADO'/etc.) — nunca se pasa tal cual a
    // decidirProtocolo, solo se usa para observabilidad (causa estructurada).
    let relacionTransformacionalEstadoEsteTurno = null;
    let derechoAValidarEsteTurno = null;
    let causaRelacionalObservada = null;
    let diagnosticoEstructuralTransformacionalEsteTurno = null;
    let nuevaHipotesisRelacionalProyeccion = null;
    // COMPATIBILIDAD_HISTORICA — declarada a nivel de función (se puebla,
    // si corresponde, dentro del bloque de propuesta más abajo; se aplica
    // durablemente dentro de la transacción, mucho más abajo). `null`
    // cuando ninguna entrada necesitó recuperación — comportamiento sin
    // efecto observable en cualquier sesión que ya tenga rolesOriginales.
    let rolesOriginalesRecuperadosParaPersistir = null;
    // circulomejora006_reporte03 (productividad de PresentacionTransformacionalEstructurada)
    // — el turno REAL que mostrará esta formulación al usuario debe existir
    // ANTES de proponer la Hipótesis (turnoPresentacionId viaja congelado
    // dentro de la propia Hipótesis — ver HipotesisTransformacionalDestino.js).
    // Se mina aquí, ANTES de invocar evaluarEstadoRelacionTransformacionalDestino,
    // y se compromete como el turnoId REAL de este turno (ver _confirmarInteraccion,
    // parámetro turnoId) únicamente cuando CANDIDATA_DISPONIBLE — nunca se
    // recupera después por coincidencia de texto.
    let turnoIdPreasignadoParaNuevaHipotesis = null;
    // CERRAR_ARRANQUE_DEL_CICLO_TRANSFORMACIONAL_DE_DESTINO — el ciclo
    // Hipótesis→Afirmación aplica por contrato para 'destino', nunca
    // condicionado a protocoloObjetivoRelacionalDirigido (ese campo solo
    // representa una corrección relacional YA en curso — ver su único sitio
    // de escritura no-nula, más abajo — nunca la activación inicial del
    // ciclo; usarlo como gate aquí era exactamente el arranque circular ya
    // demostrado: nada lo activa la primera vez porque solo se escribe
    // DESDE dentro de VALIDANDO_RELACION_TRANSFORMACIONAL). Sin cobertura
    // completa, evaluarEstadoRelacionTransformacionalDestino ya devuelve
    // SIN_COBERTURA de forma segura (construirReferenciasPorRolDestino) —
    // correr esto en cada turno de destino+EXPLORANDO es barato y correcto.
    // S1_R_INCREMENTO_3 — las reparaciones abiertas se descubren por sesión
    // y por identidad durable, no a través de la cabeza vigente.
    let reparacionS1RAbiertaParaEsteTurno = null;
    let afirmacionOrigenS1RParaEsteTurno = null;
    if (this._protocolV2Enabled && this._knowledgeGraphEnabled && gramaticaActivaAlInicio === 'destino') {
      const reparacionesAbiertas = typeof this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion === 'function'
        ? this._unitOfWork.afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion(sesionId)
        : [];
      if (reparacionesAbiertas.length === 1) {
        reparacionS1RAbiertaParaEsteTurno = reparacionesAbiertas[0];
        afirmacionOrigenS1RParaEsteTurno = this._unitOfWork.afirmacionTransformacionalRepo.findById(
          sesionId, reparacionS1RAbiertaParaEsteTurno.afirmacionOrigenId,
        );
      }
    }
    if (
      this._protocolV2Enabled && this._knowledgeGraphEnabled
      && gramaticaActivaAlInicio === 'destino' && protocoloEstadoEfectivoDeConstruccion === 'EXPLORANDO'
      // S1_R_INCREMENTO_3 — si R ya tiene una candidata sucesora registrada
      // (invariante: protocoloEstado debería ser VALIDANDO_RELACION_TRANSFORMACIONAL
      // mientras eso es cierto — llegar aquí en EXPLORANDO sería una
      // inconsistencia defensiva, nunca una vía normal), este turno NUNCA
      // propone una segunda — permanece bloqueado en EXPLORANDO
      // (relacionTransformacionalEstadoEsteTurno queda en su default, ver
      // más abajo), reutilizando la MISMA candidata ya registrada.
      && !(reparacionS1RAbiertaParaEsteTurno && reparacionS1RAbiertaParaEsteTurno.hipotesisSucesoraId)
    ) {
      try {
        const grafoParaPropuesta = grafoDelta || estadoActual.knowledgeGraph;
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 1 — identidad
        // única de turno) — reutiliza el turnoId YA reservado en admisión,
        // nunca uno competidor: antes de este incremento se minaba un
        // turnoId nuevo aquí porque _confirmarInteraccion todavía generaba
        // el suyo propio por defecto; ahora ambos deben coincidir para que
        // EntradaConversacional.turnoId === cognitive_turno.turnoId ===
        // hipotesis.turnoPresentacionId. El nombre de la variable se
        // conserva (turnoIdParaNuevaPropuesta) para minimizar el diff en el
        // resto de este bloque — su VALOR ya no es una identidad nueva.
        const turnoIdParaNuevaPropuesta = turnoIdReservadoEnAdmision;
        // S1_R_INCREMENTO_3 — la reparación actúa como restricción negativa,
        // nunca como hecho experto ni como texto inyectado en el grafo (ver
        // invariantes 11/12 de la entrega): se siembra la memoria negativa
        // (process-local, reconstruida aquí mismo si hace falta — ver
        // auditoría previa) con (a) los roles de la Afirmación A original
        // (para que reproducir la MISMA relación rechazada quede bloqueado
        // por REPRODUCE_HIPOTESIS_RECHAZADA, la misma protección estructural
        // ya existente — nunca una regla nueva) y (b) cada sucesora ya
        // rechazada dentro de esta R. Idempotente y barato — se repite en
        // cada turno EXPLORANDO mientras R siga ABIERTA.
        if (reparacionS1RAbiertaParaEsteTurno) {
          const entradasMemoriaNegativa = [{
            roles: derivarRolesDesdeConstituyentesAfirmacion(afirmacionOrigenS1RParaEsteTurno),
            turnoId: reparacionS1RAbiertaParaEsteTurno.abiertaEnTurnoId,
            textoUsuario: reparacionS1RAbiertaParaEsteTurno.correccionDetalle,
          }].filter(entrada => !!entrada.roles);
          this._unitOfWork.afirmacionTransformacionalRepo
            .listarHipotesisSucesorasRechazadas(sesionId, reparacionS1RAbiertaParaEsteTurno.reparacionId)
            .forEach(sucesora => {
              if (!sucesora.roles) return;
              entradasMemoriaNegativa.push({
                roles: sucesora.roles, turnoId: sucesora.rechazadaEnTurnoId,
                textoUsuario: sucesora.correccionDetalle,
              });
            });
          sembrarMemoriaNegativaDesdeRegistroDurable({
            sesionId, grafoActual: grafoParaPropuesta, entradas: entradasMemoriaNegativa,
          });
        }
        // S1_R_INCREMENTO_3 — mientras R está ABIERTA y sin candidata
        // sucesora registrada (rama que llegamos a ejecutar únicamente en
        // ese caso, ver condición de arriba), `estadoActual.
        // protocoloHipotesisTransformacionalPendiente` NUNCA representa un
        // juicio vigente que evaluarEstadoRelacionTransformacionalDestino
        // deba re-verificar: o es la proyección CONFIRMADA de la Hipótesis
        // original que convergió a A (ahora rechazada vía S1-R — el
        // Incremento 3 no la limpia allí, correctamente, porque sigue
        // siendo verdad histórica de A) o es el residuo de una sucesora ya
        // rechazada y liberada (limpiarHipotesisSucesoraCandidata). Pasar
        // esa proyección igual causaría CONFIRMADA_VIGENTE (A "sigue
        // siendo válida") y bloquearía la reapertura para siempre — se pasa
        // null explícitamente, nunca se re-interpreta.
        const hipotesisPendienteParaPropuesta = reparacionS1RAbiertaParaEsteTurno
          ? null
          : estadoActual.protocoloHipotesisTransformacionalPendiente;
        // S1-R-SCOPE1 — mismo cálculo que el call site de VALIDANDO_RELACION_
        // TRANSFORMACIONAL (ver exclusionesResultadoPorReparacion), aquí a
        // partir de reparacionS1RAbiertaParaEsteTurno/afirmacionOrigenS1RParaEsteTurno
        // ya resueltos arriba en este mismo bloque — nunca una segunda
        // lectura. `null` cuando no hay reparación ABIERTA (comportamiento
        // anterior intacto).
        const exclusionParaPropuesta = exclusionesResultadoPorReparacion(
          reparacionS1RAbiertaParaEsteTurno, afirmacionOrigenS1RParaEsteTurno,
        );
        // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 — fusiona la exclusión
        // S1-R puntual (arriba, post-Afirmación) con las exclusiones durables
        // en CognitiveState.protocoloExclusionesHipotesisPorRol (rechazos
        // 'corrige'+ambito='concepto', con o sin Afirmación — ver
        // fusionarExclusionesPorRol/entradaExclusionHipotesisPorRol arriba).
        // `null` cuando ninguna de las dos fuentes aporta nada — comportamiento
        // anterior byte a byte.
        const exclusionesPorRolParaPropuesta = fusionarExclusionesPorRol(
          estadoActual.protocoloExclusionesHipotesisPorRol, exclusionParaPropuesta,
        );
        // REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS — los roles que
        // NINGUNA corrección focal vigente (hipotesisSucesoraId===null)
        // está reconstruyendo heredan EXACTAMENTE las referencias
        // congeladas de la Hipótesis original (rolesOriginales) — nunca se
        // recalculan contra "todo concepto experto activo de la
        // dimensión", que incorporaría en silencio evidencia lateral ajena
        // a esta corrección (ver construirReferenciasPorRolDestino, que
        // además verifica vigencia antes de aceptar cada herencia). El
        // campoRol de cada corrección vigente queda EXCLUIDO de lo
        // heredable — ese rol siempre se reconstruye contra la autoridad
        // actual (exclusiones/asignación positiva/grafo), nunca se hereda.
        const exclusionesVigentesParaHerencia = (estadoActual.protocoloExclusionesHipotesisPorRol || [])
          .filter(e => e.hipotesisSucesoraId === null);
        const camposAfectadosParaHerencia = new Set(exclusionesVigentesParaHerencia.map(e => e.campoRol));
        // COMPATIBILIDAD_HISTORICA — entradas persistidas ANTES de que
        // rolesOriginales existiera llegan aquí con los 4 campos vacíos
        // (default de deserializeState, ver CognitiveState.js). Único
        // intento de recuperación legítimo: la misma identidad
        // {sesionId, hipotesisId, version} que la propia corrección ya
        // registró, contra emisionesLegitimas (recuperarRolesOriginalesPorIdentidad
        // — nunca fabricado). Determinístico, idempotente (si ya hay
        // rolesOriginales reales, nunca se reintenta), null explícito si el
        // proceso se reinició desde entonces — el llamador nunca hereda a
        // partir de null. `rolesOriginalesRecuperadosParaPersistir` se
        // aplica más abajo, DENTRO de la transacción, para que quede
        // durable desde el siguiente guardado — nunca se recalcula turno
        // tras turno una vez recuperado.
        const todosLosCamposVacios = roles => Object.values(roles || {}).every(ids => Array.isArray(ids) && ids.length === 0);
        const rolesOriginalesRecuperadosEsteTurno = new Map();
        const referenciasHeredablesPorRolParaPropuesta = {};
        // HERENCIA_FOCAL_NO_DEMOSTRABLE_NO_PUEDE_DEGRADAR_A_RECALCULO_SILENCIOSO
        // — campos cuya base heredable era REQUERIDA por una corrección
        // focal vigente pero no pudo demostrarse (ni persistida, ni
        // recuperable por identidad exacta). Nunca se reconstruyen contra
        // el grafo por aproximación — eso sería exactamente el recálculo
        // silencioso que este incremento prohíbe: se acumulan aquí para
        // que evaluarEstadoRelacionTransformacionalDestino falle cerrado.
        const camposConBaseHeredableNoRecuperableEsteTurno = new Set();
        const TODOS_CAMPOS_ROL_HIPOTESIS = Object.values(DIMENSION_A_CAMPO_ROL_HIPOTESIS);
        exclusionesVigentesParaHerencia.forEach(e => {
          let rolesBase = e.rolesOriginales;
          if (!rolesBase || todosLosCamposVacios(rolesBase)) {
            const recuperados = recuperarRolesOriginalesPorIdentidad(sesionId, e.hipotesisId, e.hipotesisVersion);
            if (!recuperados) {
              TODOS_CAMPOS_ROL_HIPOTESIS.forEach(campo => {
                if (campo === e.campoRol) return; // el propio rol corregido siempre se reconstruye, nunca hereda
                if (camposAfectadosParaHerencia.has(campo)) return; // otra corrección vigente ya lo cubre por su cuenta
                camposConBaseHeredableNoRecuperableEsteTurno.add(campo);
              });
              return;
            }
            rolesBase = recuperados;
            rolesOriginalesRecuperadosEsteTurno.set(e.turnoCorreccionId, recuperados);
          }
          Object.entries(rolesBase).forEach(([campo, ids]) => {
            if (camposAfectadosParaHerencia.has(campo)) return;
            if (referenciasHeredablesPorRolParaPropuesta[campo]) return;
            if (Array.isArray(ids) && ids.length > 0) referenciasHeredablesPorRolParaPropuesta[campo] = ids;
          });
        });
        if (rolesOriginalesRecuperadosEsteTurno.size > 0) {
          rolesOriginalesRecuperadosParaPersistir = rolesOriginalesRecuperadosEsteTurno;
        }
        const resultadoPropuesta = evaluarEstadoRelacionTransformacionalDestino({
          sesionId, grafoActual: grafoParaPropuesta,
          hipotesisPendiente: hipotesisPendienteParaPropuesta,
          hipotesisId: generateHipotesisId(),
          turnoPresentacionId: turnoIdParaNuevaPropuesta,
          exclusionesPorRol: exclusionesPorRolParaPropuesta,
          referenciasHeredablesPorRol: referenciasHeredablesPorRolParaPropuesta,
          camposConBaseHeredableNoRecuperable: camposConBaseHeredableNoRecuperableEsteTurno,
          rolesContextualesPorRol: rolesContextualesTransformacionalesEsteTurno,
          autoridadesContextualesPorRol: autoridadesContextualesTransformacionalesEsteTurno,
        });
        causaRelacionalObservada = resultadoPropuesta.estado;
        diagnosticoEstructuralTransformacionalEsteTurno = resultadoPropuesta.diagnosticoEstructural
          || resultadoPropuesta.diagnostico || null;
        if (resultadoPropuesta.estado === 'CANDIDATA_DISPONIBLE') {
          // Solo se consume la autorización que ocupó MECANISMO en esta
          // candidata. Las demás autorizaciones contextuales siguen
          // vigentes y no deben obligar a reinterpretar el conocimiento.
          const mecanismosSeleccionados = new Set(
            resultadoPropuesta.hipotesis.roles.mecanismoConceptoIds || [],
          );
          const referenciasPrevias = (composicionPendienteTransformacionalNuevo
            && composicionPendienteTransformacionalNuevo.referencias) || [];
          const referenciasNuevas = (r.parsed.rolesTransformacionales || [])
            .filter(p => p && p.rol === 'MECANISMO')
            .map(p => ({
              rol: 'MECANISMO',
              conceptoId: Object.prototype.hasOwnProperty.call(idTemporalARealEsteTurno, p.conceptoId)
                ? idTemporalARealEsteTurno[p.conceptoId] : p.conceptoId,
              turnoOrigenId: turnoIdReservadoEnAdmision,
              evidenciaTextual: p.evidenciaTextual,
            }));
          const autorizacionesRestantes = [...new Map(
            [...referenciasPrevias, ...referenciasNuevas].map(x => [x.conceptoId, x]),
          ).values()].filter(x => !mecanismosSeleccionados.has(x.conceptoId));
          composicionPendienteTransformacionalNuevo = autorizacionesRestantes.length > 0
            ? { gramatica: 'destino', referencias: autorizacionesRestantes }
            : null;
          derechoAValidarEsteTurno = evaluarDerechoAValidarDestino({
            candidata: { ...resultadoPropuesta, roles: resultadoPropuesta.hipotesis.roles },
            grafoActual: grafoParaPropuesta,
            reparacionesInterpretativasPendientes: reparacionesInterpretativasPostTurno,
          });
          // proyectarHipotesisParaEstado: proyección plana de observabilidad
          // (nunca autoridad) — el objeto autoritativo real ya quedó
          // registrado, exacto, dentro de emisionesLegitimas por el propio
          // productor. Si esta proyección fallara inesperadamente (nunca
          // debería, dado un objeto CANDIDATA_VALIDA bien formado), cae al
          // catch de abajo — la emisión ya registrada permanece (ver
          // "Atomicidad" en la entrega), pero el protocolo NUNCA transiciona
          // ni limpia el objetivo sin una proyección utilizable.
          nuevaHipotesisRelacionalProyeccion = proyectarHipotesisParaEstado(resultadoPropuesta.hipotesis);
          relacionTransformacionalEstadoEsteTurno = 'CANDIDATA_DISPONIBLE';
          turnoIdPreasignadoParaNuevaHipotesis = turnoIdParaNuevaPropuesta;
        } else {
          // Composición pendiente durable: solo conserva referencias de rol
          // ya gobernadas; nunca copy, causalidad o una propiedad del KG.
          if (rolesContextualesTransformacionalesEsteTurno
            && rolesContextualesTransformacionalesEsteTurno.mecanismoConceptoIds.length > 0) {
            const referenciasPrevias = (composicionPendienteTransformacionalNuevo && composicionPendienteTransformacionalNuevo.referencias) || [];
            const referenciasNuevas = (r.parsed.rolesTransformacionales || [])
              .filter(p => p && p.rol === 'MECANISMO')
              .map(p => ({
                rol: 'MECANISMO',
                conceptoId: Object.prototype.hasOwnProperty.call(idTemporalARealEsteTurno, p.conceptoId)
                  ? idTemporalARealEsteTurno[p.conceptoId] : p.conceptoId,
                // La provenance apunta al turno durable de la fuente primaria,
                // no al identificador externo/idempotente del cliente.
                turnoOrigenId: turnoIdReservadoEnAdmision,
                evidenciaTextual: p.evidenciaTextual,
              }));
            const porId = new Map([...referenciasPrevias, ...referenciasNuevas].map(x => [x.conceptoId, x]));
            composicionPendienteTransformacionalNuevo = {
              gramatica: 'destino',
              referencias: [...porId.values()].filter(x => rolesContextualesTransformacionalesEsteTurno.mecanismoConceptoIds.includes(x.conceptoId)),
            };
          }
          // SIN_COBERTURA (información insuficiente), BLOQUEADA_SIN_SENAL_NUEVA
          // (misma proposición rechazada) o BASE_HEREDABLE_NO_RECUPERABLE
          // (corrección focal sin base heredable demostrable) — los tres
          // mapean a "permanecer bloqueado en EXPLORANDO" para decidirProtocolo
          // (contrato de 3 valores, sin cambios); la distinción real vive en
          // causaRelacionalObservada, nunca se pierde — el mensaje visible
          // específico para BASE_HEREDABLE_NO_RECUPERABLE se aplica más
          // abajo, tras decidirInteraccion, sin tocar ProgresoConversacionalPolicy.
          // turnoIdParaNuevaPropuesta nunca se usó — se descarta sin efecto
          // observable (mismo patrón que hipotesisId minado en vano aquí
          // arriba).
          relacionTransformacionalEstadoEsteTurno = 'BLOQUEADA_SIN_SENAL_NUEVA';
        }
      } catch (errorPropuesta) {
        causaRelacionalObservada = 'ERROR_INESPERADO';
        relacionTransformacionalEstadoEsteTurno = 'BLOQUEADA_SIN_SENAL_NUEVA';
        nuevaHipotesisRelacionalProyeccion = null;
      }
    }

    // CERRAR_FIDELIDAD_DE_SINTESIS_DE_DESTINO — mismo principio que el
    // bloque de arriba (precalculado por el llamador, fuera de la función
    // pura decidirInteraccion): producirSintesisDestinoAutorizadaDesdeRepositorio
    // solo LEE (findHeadBySession/getCausalHistory), sin efecto que mutar,
    // pero se resuelve aquí de todos modos para mantener decidirInteraccion
    // pura y sin I/O — mismo criterio que grafoDelta/relacionTransformacionalEstadoEsteTurno.
    // Exclusivo de 'destino'+grafo+LISTO_PARA_SINTESIS — en cualquier otro
    // caso queda null y decidirInteraccion reproduce el contrato anterior
    // byte a byte (ver default del parámetro).
    let sintesisDestinoAutorizadaEsteTurno = null;
    if (
      this._protocolV2Enabled && this._knowledgeGraphEnabled
      && gramaticaActivaAlInicio === 'destino' && protocoloEstadoEfectivoDeConstruccion === 'LISTO_PARA_SINTESIS'
    ) {
      sintesisDestinoAutorizadaEsteTurno = producirSintesisDestinoAutorizadaDesdeRepositorio({
        afirmacionTransformacionalRepo: this._unitOfWork.afirmacionTransformacionalRepo,
        sesionId,
      });
      // S1 pertenece a la disponibilidad de candidatas, antes de Dirección:
      // una fuente rechazada desaparece del conjunto de opciones y nunca
      // llega a decidirInteraccion/ContratoIntervencion.
      if (sintesisDestinoAutorizadaEsteTurno.estado === 'SINTESIS_PRODUCIDA') {
        const fuente = sintesisDestinoAutorizadaEsteTurno.fuenteSemantica
          || fuenteSemanticaAfirmacion(
            sintesisDestinoAutorizadaEsteTurno.afirmacionId,
            sintesisDestinoAutorizadaEsteTurno.afirmacionVersion,
          );
        const evaluacionFuente = evaluarElegibilidadFuenteSintesis({
          eventRepo: this._unitOfWork.eventRepo,
          sesionId,
          fuenteSemantica: fuente,
        });
        if (!evaluacionFuente.elegible) {
          sintesisDestinoAutorizadaEsteTurno = Object.freeze({
            estado: 'SINTESIS_NO_ELEGIBLE',
            razon: evaluacionFuente.razon,
            fuenteSemantica: fuente,
            afirmacionId: sintesisDestinoAutorizadaEsteTurno.afirmacionId,
            afirmacionVersion: sintesisDestinoAutorizadaEsteTurno.afirmacionVersion,
            presentacionId: sintesisDestinoAutorizadaEsteTurno.presentacionId,
            texto: null,
          });
        }
      }
    }

    // S1_R_INCREMENTO_2 / S1-DISAGREE1 — mismo principio que el bloque de
    // arriba: precalculado por el llamador, fuera de decidirInteraccion
    // (pura, sin I/O). Exclusivo de 'destino'+grafo+ESPERANDO_CONFIRMACION,
    // Y ambito_correccion==="relacion", Y (clasificacion_respuesta==="rechaza"
    // — contrato original sin cambios — O clasificacion_respuesta==="corrige"
    // con impacto_cambio==="semantico" — S1-DISAGREE1: la decisión
    // arquitectónica de la auditoría S1-C0 es que la palabra elegida por
    // Capa 1 deja de ser, por sí sola, la autoridad que decide si existe
    // reparación durable; lo que importa es qué autoridad cognitiva
    // cuestiona el experto, no el verbo con que lo dijo). En cualquier otro
    // caso queda null y ni el override de estado ni la apertura de
    // reparación ocurren (contrato anterior byte a byte, invariantes 1-4 de
    // la entrega original). "nunca adivines identidades": la identidad
    // completa de Afirmación+Presentación se reconfirma AQUÍ, en vivo,
    // contra el repositorio — nunca se confía únicamente en el
    // afirmacionTransformacionalId ya guardado en protocoloSintesisVigente
    // (podría, en teoría, haber quedado desactualizado). Reutiliza
    // EXACTAMENTE el mismo productor que ya reconstruye la síntesis
    // autorizada (arriba) — nunca una segunda regla de resolución de
    // identidad.
    let aperturaS1RPrecalculada = null;
    const clasificacionAbreS1R = r.parsed && (
      r.parsed.clasificacion_respuesta === 'rechaza'
      || (r.parsed.clasificacion_respuesta === 'corrige' && r.parsed.impacto_cambio === IMPACTOS_CAMBIO.SEMANTICO)
    );
    if (
      this._protocolV2Enabled && this._knowledgeGraphEnabled
      && gramaticaActivaAlInicio === 'destino' && protocoloEstadoEfectivoDeConstruccion === 'ESPERANDO_CONFIRMACION'
      && r.parsed && clasificacionAbreS1R
      && r.parsed.ambito_correccion === AMBITOS_CORRECCION_RELACIONAL.RELACION
      && typeof r.parsed.correccion_detalle === 'string' && r.parsed.correccion_detalle.trim()
      && estadoActual.protocoloSintesisVigente && estadoActual.protocoloSintesisVigente.afirmacionTransformacionalId
    ) {
      const identidadVigente = producirSintesisDestinoAutorizadaDesdeRepositorio({
        afirmacionTransformacionalRepo: this._unitOfWork.afirmacionTransformacionalRepo,
        sesionId,
      });
      if (
        identidadVigente.estado === 'SINTESIS_PRODUCIDA'
        && identidadVigente.afirmacionId === estadoActual.protocoloSintesisVigente.afirmacionTransformacionalId
        && identidadVigente.texto === estadoActual.protocoloSintesisVigente.texto
      ) {
        aperturaS1RPrecalculada = {
          afirmacionOrigenId: identidadVigente.afirmacionId,
          afirmacionOrigenVersion: identidadVigente.afirmacionVersion,
          presentacionOrigenId: identidadVigente.presentacionId,
          correccionDetalle: r.parsed.correccion_detalle.trim(),
          // S1-R-SCOPE1 — opcional a propósito (mismo campo, mismo
          // catálogo, que VALIDANDO_RELACION_TRANSFORMACIONAL ya usa para
          // "corrige"): un veredicto de ESPERANDO_CONFIRMACION que no lo
          // declara deja esto en null — nunca se fabrica, nunca se infiere
          // del texto. Gobierna qué rol excluye exclusionesResultadoPorReparacion.
          componenteRelacional: validarComponenteRelacional(r.parsed.componente_relacional),
        };
      }
      // Identidad no confirmable (cabeza distinta, presentación ausente,
      // texto ya no coincide): nunca se abre reparación — el turno sigue su
      // curso con el comportamiento de rechazo ya existente, sin S1-R.
    }

    // CLOSURE_CONTRACT_ACCEPTANCE_AND_OPTIONAL_OBLIGATION_COORDINATION
    // (C007, Daniel-adjudicated, real evidence: logistica_c0 turns 11-12,
    // session live_complete_logistica_c0_11ec6033) — se calcula AQUÍ, ANTES
    // de decidirInteraccion, con las MISMAS autoridades ya resueltas este
    // turno (contratoRespuestaDirigidaEsteTurno: el acto canónico congelado
    // que gobernó la intervención dirigida; alineacionRespuestaDirigidaResultadoTraza:
    // el resultado YA verificado por validarRelacionRespuestaDirigida más
    // arriba) — nunca una segunda verificación, nunca texto libre del
    // Productor. UNA_DECISION_CONTRATADA_NO_SE_VUELVE_A_DERIVAR_DOWNSTREAM:
    // esto NUNCA recalcula missionSufficient ni reabre el contrato de
    // cierre ya congelado -- solo interpreta, contextualmente, qué significa
    // la relación ya verificada contra ESE acto anterior.
    // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION (C007) -- the
    // directed-response relation verification above (proyectarAlineacionRespuestaDirigida)
    // only runs inside the EXPLORANDO block (grafoActivo). A non-DESTINO
    // grammar's closure acceptance happens in ESPERANDO_CONFIRMACION, so
    // verify the relation HERE against the frozen PROPOSE_MISSION_CLOSURE
    // contract, using the SAME authorities (validarRelacionRespuestaDirigida
    // + proyectarAlineacionRespuestaDirigida), never a second, looser check.
    if (confirmationSujetoEsteTurno === CONFIRMATION_SUBJECTS.MISSION_CLOSURE
      && !alineacionRespuestaDirigidaResultadoTraza
      && contratoRespuestaDirigidaEsteTurno
      && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
      && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.operator === 'PROPOSE_MISSION_CLOSURE'
      && r && r.parsed) {
      const validacionCierre = validarRelacionRespuestaDirigida({
        relacionDeclarada: r.parsed.relacionRespuestaDirigida,
        mensajeUsuario,
        contrato: contratoRespuestaDirigidaEsteTurno,
        conceptosNuevosEsteTurno: [],
        dimensionDeProcedencia,
        incertidumbreObjetivoResuelta: false,
      });
      alineacionRespuestaDirigidaResultadoTraza = proyectarAlineacionRespuestaDirigida({
        contrato: contratoRespuestaDirigidaEsteTurno,
        relacionDeclarada: r.parsed.relacionRespuestaDirigida || null,
        validacion: validacionCierre,
      });
      relacionRespuestaDirigidaTraza = r.parsed.relacionRespuestaDirigida
        ? { ...r.parsed.relacionRespuestaDirigida }
        : null;
      // RESPONSE_GOVERNED_TRANSITION_VISIBLE_COMMIT (C007) -- observability
      // fix only. trazaAutoridadEsteTurno.directedResponse was already
      // written earlier this turn (~7857, before this MISSION_CLOSURE-
      // specific relation verification ran), from the then-still-null
      // relacionRespuestaDirigidaTraza. TRACE_MIRRORS_AUTHORITY_NEVER_
      // CREATES_IT: this never changes what the verdict below actually
      // consumes (relacionRespuestaDirigidaTraza/alineacionRespuestaDirigidaResultadoTraza,
      // read directly) -- it only refreshes the PERSISTED authority_trace so
      // it reflects the SAME relation the verdict just used, instead of the
      // stale pre-verification null.
      trazaAutoridadEsteTurno.directedResponse = {
        target: contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible.target || null,
        relation: relacionRespuestaDirigidaTraza && relacionRespuestaDirigidaTraza.relacion || null,
      };
    }
    const veredictoRespuestaActoAnteriorEsteTurno = interpretarVeredictoRespuestaActoAnterior({
      previousCanonicalAct: contratoRespuestaDirigidaEsteTurno && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible,
      relacion: alineacionRespuestaDirigidaResultadoTraza && alineacionRespuestaDirigidaResultadoTraza.relacion,
      verificada: !!(alineacionRespuestaDirigidaResultadoTraza
        && alineacionRespuestaDirigidaResultadoTraza.resultado === RESULTADO_VERIFICADA),
    });

    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (orquestación de cierre —
    // ABIERTO_BLOQUEADO_POR_INCONSISTENCIA_DE_PREPARACION) — se calcula
    // AQUÍ, ANTES de decidirInteraccion, con el MISMO grafo
    // (grafoDelta || estadoActual.knowledgeGraph) que decidirInteraccion
    // usará internamente como grafoResultado -- nunca una segunda fuente
    // de verdad. Reutiliza recalcularCicloPreguntaFinal (la MISMA función
    // pura que ya gobierna el override declarativo, más abajo) para decidir
    // si el snapshot de cierre quedó sin deudas, y objetivoConversacionalEsteTurno
    // (P1-B, ya calculado arriba en este mismo turno) para excluir
    // explícitamente cualquier deuda prioritaria de REPARACION/
    // VEREDICTO_INTERPRETACION/INCERTIDUMBRE_RELEVANTE_ABIERTA -- nunca asumida
    // por el mero orden de prioridad ya existente en ObjetivoConversacionalPolicy.
    const grafoParaCicloCierreTemprano = grafoDelta || estadoActual.knowledgeGraph;
    const dimensionesConEvidenciaCicloCierreTemprano = new Set(
      conceptosDeGramatica(grafoParaCicloCierreTemprano, gramaticaActivaAlInicio)
        .map(c => dimensionDeProcedencia(c.procedencia)),
    );
    const cicloCierreTemprano = recalcularCicloPreguntaFinal(
      estadoActual.protocoloIntencionCierre || null, dimensionesConEvidenciaCicloCierreTemprano,
    );
    const deudaPrioritariaBloqueaHipotesisEsteTurno = !!(
      objetivoConversacionalEsteTurno && objetivoConversacionalEsteTurno.deudaPrioritaria
      && ['REPARACION', 'VEREDICTO_INTERPRETACION', 'INCERTIDUMBRE_RELEVANTE_ABIERTA']
        .includes(objetivoConversacionalEsteTurno.deudaPrioritaria.tipo)
    );
    const cierreConSnapshotSinDeudasEsteTurno = !!(
      senalCierreConversacionalAplicaEsteTurno
      && cicloCierreTemprano
      && cicloCierreTemprano.pendientes.length === 0
      && !deudaPrioritariaBloqueaHipotesisEsteTurno
    );

    // RESPONSE_GOVERNED_HANDOFF_DEFERS_NEXT_GRAMMAR_ACT (C007) -- computed
    // HERE, before decidirInteraccion, so the SAME authoritative boolean can
    // both gate the entering-grammar handoff inside decidirInteraccion and
    // be reused (never recomputed) below for authorizedVisibleOutputEstaDisponible.
    // Grounded in the SAME two authorities interpretarVeredictoRespuestaActoAnterior
    // already consumed above (contratoRespuestaDirigidaEsteTurno,
    // alineacionRespuestaDirigidaResultadoTraza) -- never a second, looser
    // verification, and never inferred merely from actoCognitivoSeleccionado
    // being absent (that absence is checked separately, below).
    const respuestaGobernadaVisibleEsteTurno = !!(
      contratoRespuestaDirigidaEsteTurno
      && contratoRespuestaDirigidaEsteTurno.actoCognitivoVisible
      && alineacionRespuestaDirigidaResultadoTraza
      && alineacionRespuestaDirigidaResultadoTraza.resultado === RESULTADO_VERIFICADA
    );
    // CANONICAL_NO_SELECTED_ACT_NULL_NORMALIZATION (C007) -- earliest
    // representation boundary where this value is derived, before it is
    // passed into decidirInteraccion's own interaction-decision path.
    // NO_SELECTED_CANONICAL_ACT = null, never undefined: the ternary below
    // legitimately yields bare `undefined` whenever objetivoConversacionalEsteTurno
    // itself is falsy this turn (e.g. a response-governed turn with no
    // conversational objective at all) -- `?? null` is the ONE
    // normalization applied here, exactly once, never re-derived per branch.
    const actoCognitivoSeleccionadoParaDecision = (actoCognitivoCanonico || (objetivoConversacionalEsteTurno
      && Object.prototype.hasOwnProperty.call(objetivoConversacionalEsteTurno, 'actoCognitivoSeleccionado')
      ? objetivoConversacionalEsteTurno.actoCognitivoSeleccionado : undefined)) ?? null;
    const turnoGobernadoPorRespuestaAnteriorEsteTurno = !!(
      respuestaGobernadaVisibleEsteTurno && actoCognitivoSeleccionadoParaDecision === null
    );

    const decision = decidirInteraccion({
      state: estadoActual, gramaticaActivaAlInicio, parsed: r.parsed, protocolV2Enabled: this._protocolV2Enabled,
      knowledgeGraphEnabled: this._knowledgeGraphEnabled, grafoDelta,
      cierreConSnapshotSinDeudas: cierreConSnapshotSinDeudasEsteTurno,
      // circulomejora006 (tercera verificación, Sección C3 — Opción B) —
      // ver cabecera de decidirInteraccion: r.parsed.mensaje ya es la
      // intervención visible completa cuando Movimiento gobernó este
      // turno de DESTINO. destinoMovimientoAplicaEsteTurno (nivel de
      // función, ver arriba) es la misma condición que
      // movimientoConversacionalDestinoActivoEsteTurno (bloqueada dentro
      // del bucle V2, sin alcance aquí) — mismo patrón ya usado por
      // comprensionConversacional, más abajo.
      movimientoRigeMaterializacion: destinoMovimientoAplicaEsteTurno || movimientoMisionAplicaEsteTurno,
      movimientoAutoridad: contratoMovimientoDestino || movimientoComunEsteTurno,
      contratoIntervencionMovimiento,
      objetivoConversacional: objetivoConversacionalEsteTurno,
      actoCognitivoSeleccionado: actoCognitivoSeleccionadoParaDecision,
      turnoGobernadoPorRespuestaAnterior: turnoGobernadoPorRespuestaAnteriorEsteTurno,
      oportunidadesConversacionales: oportunidadesGobernadasEsteTurno,
      historialVisibleReciente: historialVisibleRecienteEsteTurno,
      // FRONTERA_INTERVENCION_VISIBLE_1 — GobernanzaMaterializacion.js
      // (Transformar/Determinista/Preservar) es OTRO materializador ya
      // autorizado, anterior a este incremento y fuera de su alcance:
      // cuando decidirMaterializacion() seleccionó una estrategia para
      // este turno de EXPLORANDO+grafo, r.parsed.mensaje YA es el
      // resultado final que esa gobernanza decidió (texto determinista
      // autosuficiente, o la prosa de Capa 1 ya validada por Preservar) —
      // reconstruir un contrato aquí encima sería, otra vez, un productor
      // paralelo, no la frontera única. A diferencia de Movimiento, esta
      // gobernanza NUNCA promete que el mensaje sea la intervención
      // completa -- next_user_action sigue componiéndose aparte, como
      // siempre.
      gobernanzaMaterializacionRigeEsteTurno: estrategiaSeleccionadaTraza !== null,
      dimensionEnFocoNuevo,
      reparacionesInterpretativasPendientes: reparacionesInterpretativasPostTurno,
      dimensionesInterpretacionDiferida: dimensionesInterpretacionDiferidaNuevo,
      relacionTransformacionalEstadoPrecalculado: relacionTransformacionalEstadoEsteTurno,
      diagnosticoEstructuralTransformacional: diagnosticoEstructuralTransformacionalEsteTurno,
      derechoAValidar: derechoAValidarEsteTurno,
      nuevaHipotesisRelacionalProyeccion,
      sintesisDestinoAutorizadaPrecalculada: sintesisDestinoAutorizadaEsteTurno,
      sintesisDestinoNoElegiblePrecalculada: sintesisDestinoAutorizadaEsteTurno
        && sintesisDestinoAutorizadaEsteTurno.estado === 'SINTESIS_NO_ELEGIBLE',
      aperturaS1RPrecalculada,
      // AUTHORITY_CONTINUITY correction -- reuse the SAME decidirProtocolo()
      // result already computed above (non-destino handoff vertical) for
      // closureOption/Decision; null (destino, or any turn that never took
      // that branch) preserves decidirInteraccion's own internal computation
      // exactly as before.
      progresoPrecalculado: progresoEsteTurno,
      veredictoCierreMisionPrecalculado: veredictoRespuestaActoAnteriorEsteTurno.veredicto,
      confirmationSubject: confirmationSujetoEsteTurno,
    });
    if (!decision.contratoIntervencionDestino
      && contratoIntervencionMovimiento
      && actoCognitivoCanonico) {
      // El Contract que transporta la única Decision canónica debe llegar a
      // la frontera común cualquiera sea su operador. Movement nulo solo
      // significa que no aportó HOW; nunca veta el WHAT ya contratado.
      decision.contratoIntervencionDestino = contratoIntervencionMovimiento;
    }


    // HERENCIA_FOCAL_NO_DEMOSTRABLE_NO_PUEDE_DEGRADAR_A_RECALCULO_SILENCIOSO
    // — decidirProtocolo solo entiende el contrato de 3 valores
    // (CONFIRMADA_VIGENTE|CANDIDATA_DISPONIBLE|BLOQUEADA_SIN_SENAL_NUEVA,
    // ver ProgresoConversacionalPolicy.js) y por eso ya devolvió el mensaje
    // determinista de "reparación"/S1-R para este causa — nunca se toca esa
    // función. Este bloque, DESPUÉS de decidirInteraccion, sustituye
    // EXACTAMENTE ese texto por el mensaje determinista propio de esta
    // frontera cuando la causa real (causaRelacionalObservada, más ancha
    // que el contrato de 3 valores) es BASE_HEREDABLE_NO_RECUPERABLE —
    // nunca el fallback genérico, nunca el texto de S1-R que no aplica
    // aquí. Tres campos, los mismos que consumen la persistencia del Turno
    // y el resultado devuelto (mensajeCirculo/mensajeFinalProtocolo) y la
    // observabilidad del next_user_action ya resuelto — nunca solo uno,
    // para que ambos caminos (primera respuesta y reintento idempotente)
    // muestren el mismo texto.
    if (causaRelacionalObservada === 'BASE_HEREDABLE_NO_RECUPERABLE') {
      const mensajeDeterminista = mensajeDeterministaBaseHeredableNoRecuperable();
      decision.mensajeCirculo = mensajeDeterminista;
      decision.mensajeFinalProtocolo = mensajeDeterminista;
      if (decision.progreso && decision.progreso.nextUserAction) {
        decision.progreso = {
          ...decision.progreso,
          nextUserAction: { ...decision.progreso.nextUserAction, texto: mensajeDeterminista },
        };
      }
    } else if (decision.contratoIntervencionDestino) {
      // FRONTERA_INTERVENCION_VISIBLE_1 — único punto donde P1/P4/P5 de
      // 'destino' pierden autoridad visible directa: mensajeCirculo/
      // mensajeFinalProtocolo calculados por decidirInteraccion (arriba)
      // NUNCA llegan al DTO visible cuando hay contrato — se descartan,
      // reemplazados por la materialización real. Fuera de cualquier
      // transacción (igual que el resto de llamadas LLM de esta función,
      // ver cabecera del archivo) — nunca dentro de
      // unitOfWork.ejecutar(...).
      let materializacion;
      try {
        materializacion = await materializarIntervencionVisible({
          contrato: decision.contratoIntervencionDestino,
          llmService: this._llmService,
          fidelityExecutionCoordinator: this._fidelityExecutionCoordinator,
          realizerExecutionCoordinator: this._realizerExecutionCoordinator,
          turnoId: turnoIdReservadoEnAdmision,
          mensajeUsuario,
        });
      } catch (error) {
        // C007 human canary v6, public failure surface — FIDELITY_EXECUTION_
        // UNAVAILABLE is an internal code, never itself the human-facing
        // surface. Reuses the SAME {ok,httpStatus,codigo,mensaje} shape as
        // every sibling failure a few lines below (e.g.
        // NO_COGNITIVE_ACT_AVAILABLE) — no new error-presentation mechanism.
        // Every other error keeps propagating unchanged; this is the only
        // one this frontier is responsible for translating.
        if (error && error.message === 'FIDELITY_EXECUTION_UNAVAILABLE') {
          const respuesta = respuestaOperacionalFalloFidelity(error);
          this._marcarEntradaFallidaSiEsSeguro({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: respuesta.codigo, errorCategory: respuesta.executorFailureClass, retryable: false,
          });
          trazaAutoridadEsteTurno.visibleRoute = 'CANONICAL';
          // C007 CONVERSATIONAL ENGINE STABILIZATION -- contract.id: the
          // ContratoIntervencion schema mints no id of its own (frozen WHAT,
          // never a durable identity object); turnoId is the natural 1:1
          // reference (exactly one canonical Contract per committed turn).
          trazaAutoridadEsteTurno.contract = { id: turnoIdReservadoEnAdmision, hasContract: true, operator: decision.contratoIntervencionDestino.actoCognitivoVisible && decision.contratoIntervencionDestino.actoCognitivoVisible.operator || null };
          trazaAutoridadEsteTurno.realization = { realizerResult: 'SUCCESS', fidelityResult: 'EXECUTOR_UNAVAILABLE', outcome: 'FIDELITY_EXECUTION_UNAVAILABLE' };
          this._emitirTrazaAutoridad({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, traza: trazaAutoridadEsteTurno, commit: false, failureClass: respuesta.codigo });
          return { ok: false, httpStatus: respuesta.httpStatus, codigo: respuesta.codigo, mensaje: respuesta.mensaje };
        }
        // C007 human canary v9 — VISIBLE_REALIZATION_DISCIPLINE. Both bounded
        // Realizer attempts were correctly rejected by Fidelity's fail-closed
        // gate (a genuine semantic/discipline/lexical rejection, never an
        // executor failure) -- the draft never ships, exactly as intended,
        // but this internal code must not become the literal HTTP surface
        // either (same PUBLIC FAILURE SURFACE discipline as above, never a
        // second presentation mechanism -- same MENSAJE_OPERACIONAL_FALLO_GENERICO).
        if (error && error.message === 'REALIZACION_CONTRATO_NO_FIEL') {
          this._marcarEntradaFallidaSiEsSeguro({
            turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
            causa: 'REALIZACION_CONTRATO_NO_FIEL', errorCategory: null, retryable: false,
          });
          trazaAutoridadEsteTurno.visibleRoute = 'CANONICAL';
          trazaAutoridadEsteTurno.contract = { id: turnoIdReservadoEnAdmision, hasContract: true, operator: decision.contratoIntervencionDestino.actoCognitivoVisible && decision.contratoIntervencionDestino.actoCognitivoVisible.operator || null };
          trazaAutoridadEsteTurno.realization = { realizerResult: 'EXHAUSTED', fidelityResult: 'REJECTED', outcome: 'REALIZACION_CONTRATO_NO_FIEL' };
          this._emitirTrazaAutoridad({ turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId, traza: trazaAutoridadEsteTurno, commit: false, failureClass: 'REALIZACION_CONTRATO_NO_FIEL' });
          return { ok: false, httpStatus: 502, codigo: 'REALIZACION_CONTRATO_NO_FIEL', mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO };
        }
        throw error;
      }
      decision.mensajeCirculo = materializacion.mensajeCirculo;
      decision.mensajeFinalProtocolo = materializacion.mensajeCirculo;
      decision.origenMaterializacionVisible = materializacion.origenMaterializacion;
      // La frontera común acaba de ejecutar el contrato y producir su salida
      // visible. Esa condición es la autoridad para proyectarlo como
      // presentado, también cuando el WHAT canónico no necesitó un
      // movimiento interrogativo legado.
      salidaVisibleSeguraTraza = !!(
        materializacion
        && typeof materializacion.mensajeCirculo === 'string'
        && materializacion.mensajeCirculo.trim()
        && typeof materializacion.origenMaterializacion === 'string'
        && materializacion.origenMaterializacion.trim()
      );
      const actoVisibleMaterializado = decision.contratoIntervencionDestino.actoCognitivoVisible;
      const contratoEjecutaObtencionDecidida = !!(
        salidaVisibleSeguraTraza
        && contratoMovimientoDestino
        && [MOVIMIENTOS_DESTINO.PEDIR_CONTEXTO, MOVIMIENTOS_DESTINO.PEDIR_EJEMPLO]
          .includes(contratoMovimientoDestino.movimiento)
        && actoVisibleMaterializado
        && OPERADORES_QUE_ESPERAN_RESPUESTA_DIRIGIDA.includes(actoVisibleMaterializado.operator)
        && decision.contratoIntervencionDestino.accionUsuario
        && decision.contratoIntervencionDestino.accionUsuario.tipo === 'responder_pregunta'
      );
      if (contratoEjecutaObtencionDecidida) {
        // La traza pertenece a la intervención que finalmente llegó a la
        // superficie. Una degradación legacy previa deja de ser el HOW
        // efectivo cuando el Contract común ejecutó la obtención decidida.
        movimientoEjecutadoDestino = true;
        fallbackMovimientoAplicadoTraza = false;
        destinoMovimientoCompatible = true;
      }
      if (decision.progreso && decision.progreso.nextUserAction) {
        const accionVisible = decision.contratoIntervencionDestino.accionUsuario || null;
        decision.progreso = {
          ...decision.progreso,
          nextUserAction: accionVisible && accionVisible.tipo !== 'ninguna'
            ? { tipo: accionVisible.tipo, objetivo: accionVisible.objetivo || null, texto: null }
            : null,
          nextUserActionOrigen: 'contrato_intervencion',
        };
      }
    }

    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — presupuesto de
    // pregunta final consolidada) — el smoke real con Gemini demostró que,
    // con DOS dimensiones genuinamente vacías a la vez bajo cierre activo,
    // resolverlas de a una (el mecanismo de la ronda anterior) producía DOS
    // preguntas finales consecutivas y exponía nombres internos de slot
    // ("Después", "Evidencia") -- clasificación
    // CIERRE_RECONOCIDO_PERO_PRESUPUESTO_FINAL_NO_GOBERNADO. Corrección:
    // dimensionesConEvidenciaPostTurnoEsteTurno es el conjunto REAL de
    // dimensiones de destino con al menos un concepto en el grafo resultante
    // de este turno (decision.grafoResultado, el mismo que avanzaReal usa
    // más abajo) -- única fuente para reevaluar un ciclo YA abierto, nunca
    // para agregar dimensiones nuevas.
    const dimensionesConEvidenciaPostTurnoEsteTurno = new Set(
      (decision.grafoResultado ? conceptosDeGramatica(decision.grafoResultado, 'destino') : [])
        .map(c => dimensionDeProcedencia(c.procedencia)),
    );
    // Reevalúa un ciclo YA abierto (turno anterior) contra este turno --
    // null si ningún ciclo estaba en curso.
    const cicloPreguntaFinalEsteTurno = recalcularCicloPreguntaFinal(
      estadoActual.protocoloIntencionCierre || null, dimensionesConEvidenciaPostTurnoEsteTurno,
    );
    // Snapshot CANDIDATO para ABRIR un ciclo nuevo -- solo cuando ninguno
    // estaba ya en curso (cicloPreguntaFinalEsteTurno===null) y P1-B decidió
    // EXPONER_DEUDA_DURA_MINIMA con tipo DIMENSION_SIN_EVIDENCIA este turno
    // (todasLasDimensionesSinEvidenciaAlguna, ver ObjetivoConversacionalPolicy
    // -- TODAS las dimensiones vacías de ESTE turno, no solo la primera).
    const deudasFinalesSnapshotCandidatoEsteTurno = (
      !cicloPreguntaFinalEsteTurno
      && objetivoConversacionalEsteTurno
      && objetivoConversacionalEsteTurno.objetivo === 'EXPONER_DEUDA_DURA_MINIMA'
      && objetivoConversacionalEsteTurno.deudaPrioritaria
      && objetivoConversacionalEsteTurno.deudaPrioritaria.tipo === 'DIMENSION_SIN_EVIDENCIA'
      && Array.isArray(objetivoConversacionalEsteTurno.todasLasDimensionesSinEvidenciaAlguna)
      && objetivoConversacionalEsteTurno.todasLasDimensionesSinEvidenciaAlguna.length > 0
    )
      ? objetivoConversacionalEsteTurno.todasLasDimensionesSinEvidenciaAlguna.map(
          dim => ({ dimension: dim, identidad: `sin_evidencia:${gramaticaActivaAlInicio}:${dim}` }),
        )
      : null;
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
    // PRESUPUESTO_CONSUMIDO_REEMITE_LA_PREGUNTA_FINAL) — el smoke real
    // demostró que, tras una respuesta ambigua o parcial tras haber
    // consumido el presupuesto, el turno SIGUIENTE volvía a mostrar la
    // MISMA pregunta interrogativa -- una segunda emisión visible, aunque
    // fuera literalmente el mismo texto. La pregunta interrogativa
    // consolidada (mensajeDeterministaPreguntaFinalConsolidada) SOLO puede
    // mostrarse el turno que abre el ciclo (deudasFinalesSnapshotCandidatoEsteTurno,
    // cicloPreguntaFinalEsteTurno todavía null ese turno). Cualquier turno
    // POSTERIOR con el ciclo ya abierto (cicloPreguntaFinalEsteTurno no
    // null) usa el estado DECLARATIVO (mensajeDeterministaEstadoPreguntaFinalConsolidada)
    // en su lugar -- nunca otra interrogación, sea la misma, reformulada o
    // lateral. `deudasResueltasEsteTurno` es el diff contra lo YA resuelto
    // en turnos anteriores (estadoActual.protocoloIntencionCierre.deudasResueltas)
    // -- `[]` si la respuesta de este turno no aportó nada del snapshot.
    const deudasResueltasEsteTurno = cicloPreguntaFinalEsteTurno
      ? cicloPreguntaFinalEsteTurno.resueltas.filter(
          dim => !((estadoActual.protocoloIntencionCierre && estadoActual.protocoloIntencionCierre.deudasResueltas) || []).includes(dim),
        )
      : [];

    // Frontera causal (mismo patrón exacto que el bloque
    // BASE_HEREDABLE_NO_RECUPERABLE, arriba: sustituye el texto DESPUÉS de
    // decidirInteraccion, nunca toca ProgresoConversacionalPolicy ni su
    // contrato de 3 valores) — cuando el experto ya expresó una intención de
    // cierre real y existe(n) deuda(s) dura(s) GENUINA(s) (nunca una mera
    // oportunidad lateral — MATERIALIZAR_SIGUIENTE_INTERPRETACION_ELEGIBLE
    // queda deliberadamente afuera, y un ciclo ya abierto GANA sobre ella
    // incluso si esta apareciera este turno, ver recalcularCicloPreguntaFinal/
    // avanzarIntencionCierre) — nunca lo que Capa 1/el flujo legado hubiera
    // generado libremente, nunca una por dimensión, nunca más de una
    // interrogación en toda la vida del ciclo. Exclusivo del camino SIN
    // Movimiento activo (!destinoMovimientoAplicaEsteTurno): con Movimiento
    // activo, decidirMovimientoDestino ancla su propio "objetivo"
    // (P1-B2/P1-B3) -- nunca dos mecanismos paralelos. REPARACION queda
    // fuera a propósito: tiene su propio camino robusto y probado
    // (drenajeReparacionInterpretativaActivo/REPARAR_TRAS_RECHAZO).
    if (!destinoMovimientoAplicaEsteTurno && senalCierreConversacionalAplicaEsteTurno && deudasFinalesSnapshotCandidatoEsteTurno) {
      // Turno que ABRE el ciclo -- única interrogación permitida en toda su vida.
      const mensajeDeterminista = mensajeDeterministaPreguntaFinalConsolidada(deudasFinalesSnapshotCandidatoEsteTurno.map(d => d.dimension));
      decision.mensajeCirculo = mensajeDeterminista;
      decision.mensajeFinalProtocolo = mensajeDeterminista;
      if (decision.progreso && decision.progreso.nextUserAction) {
        decision.progreso = {
          ...decision.progreso,
          nextUserAction: { ...decision.progreso.nextUserAction, texto: mensajeDeterminista },
        };
      }
    } else if (!destinoMovimientoAplicaEsteTurno && senalCierreConversacionalAplicaEsteTurno && cicloPreguntaFinalEsteTurno && cicloPreguntaFinalEsteTurno.pendientes.length > 0) {
      // Ciclo YA abierto, todavía con deudas pendientes -- ESTADO
      // declarativo, nunca otra pregunta (el presupuesto ya se consumió).
      const mensajeDeterminista = mensajeDeterministaEstadoPreguntaFinalConsolidada(deudasResueltasEsteTurno, cicloPreguntaFinalEsteTurno.pendientes);
      decision.mensajeCirculo = mensajeDeterminista;
      decision.mensajeFinalProtocolo = mensajeDeterminista;
      if (decision.progreso && decision.progreso.nextUserAction) {
        decision.progreso = {
          ...decision.progreso,
          nextUserAction: { ...decision.progreso.nextUserAction, texto: mensajeDeterminista },
        };
      }
    } else if (
      !destinoMovimientoAplicaEsteTurno
      && senalCierreConversacionalAplicaEsteTurno
      && !cicloPreguntaFinalEsteTurno
      && objetivoConversacionalEsteTurno
      && objetivoConversacionalEsteTurno.objetivo === 'EXPONER_DEUDA_DURA_MINIMA'
      && objetivoConversacionalEsteTurno.deudaPrioritaria
      && objetivoConversacionalEsteTurno.deudaPrioritaria.tipo === 'INCERTIDUMBRE_RELEVANTE_ABIERTA'
    ) {
      // Incertidumbre relevante: deuda mono-valor, ajena al snapshot
      // multi-dimensión de arriba (prioridad ya mutuamente excluyente en
      // decidirObjetivoConversacional -- ver ObjetivoConversacionalPolicy).
      const mensajeDeterminista = mensajeDeterministaDeudaDuraConCierreActivo(objetivoConversacionalEsteTurno.deudaPrioritaria);
      decision.mensajeCirculo = mensajeDeterminista;
      decision.mensajeFinalProtocolo = mensajeDeterminista;
      if (decision.progreso && decision.progreso.nextUserAction) {
        decision.progreso = {
          ...decision.progreso,
          nextUserAction: { ...decision.progreso.nextUserAction, texto: mensajeDeterminista },
        };
      }
    }

    // avanzaReal (Incremento 1, corrección arquitectónica): comparación
    // determinista entre el grafo verdaderamente-antes (`state`, previo a
    // AMBAS fases de este turno) y el verdaderamente-después
    // (`decision.grafoResultado`, posterior a construcción) — diagnóstico
    // puro, nunca gobierna cierre ni next_user_action. Se calcula siempre
    // que el grafo de este turno realmente cambió — no solo bajo
    // grafoActivo (EXPLORANDO): la cascada de rechazo de síntesis completa
    // (Ciclo Cognitivo de Descubrimiento, ver decidirInteraccion) también
    // muta el grafo desde ESPERANDO_CONFIRMACION, y merece el mismo rastro
    // de auditoría — nunca un rechazo que cambia el grafo en silencio.
    // Identidad de referencia basta: grafoResultado es literalmente
    // state.knowledgeGraph (mismo objeto) cuando nada cambió, o un objeto
    // nuevo de createKnowledgeGraph cuando sí.
    const grafoRealmenteCambio = decision.grafoResultado !== state.knowledgeGraph;
    const avance = (grafoActivo || grafoRealmenteCambio)
      ? avanzaRealDeGrafo(state.knowledgeGraph, decision.grafoResultado, gramaticaActivaAlInicio)
      : null;

    // circulomejora006 (Especificación, correcciones finales §3/§4) —
    // observabilidad + persistencia de foco, empaquetadas en un solo objeto
    // que solo existe cuando este turno pasó por el selector de DESTINO
    // (null en cualquier otro caso — flag apagado, otra gramática, otro
    // protocoloEstado — sin efecto observable sobre el resto del sistema).
    const comprensionConversacional = (destinoMovimientoAplicaEsteTurno || movimientoMisionAplicaEsteTurno)
      ? {
          movimientoDecidido: contratoMovimientoDestino || movimientoComunEsteTurno,
          contratoIntervencion: contratoIntervencionMovimiento || decision.contratoIntervencionDestino,
          movimientoEjecutado: destinoMovimientoAplicaEsteTurno ? movimientoEjecutadoDestino : !!decision.contratoIntervencionDestino,
          movimientoNoEjecutadoRazon,
          estrategiaSeleccionada: estrategiaSeleccionadaTraza,
          estrategiaEfectiva: estrategiaEfectivaTraza,
          realizadorFallo: realizadorFalloTraza,
          fallbackMovimientoAplicado: fallbackMovimientoAplicadoTraza,
          contratoConectadoDegradado: contratoConectadoDegradadoTraza,
          conexionConectada: conexionConectadaTraza,
          salidaVisibleSegura: salidaVisibleSeguraTraza,
          compatibilidadMovimientoEstrategia: destinoMovimientoCompatible,
          dimensionEnFoco: dimensionEnFocoNuevo,
          // circulomejora006 (evaluacionInterpretacion, corrección de
          // carrera) — corregido para leer el codigoRazon CRUDO
          // (resultadoMovimientoDecididoCrudo), no la mera nulidad de
          // contratoMovimientoDestino: desde esta corrección,
          // contratoMovimientoDestino también puede ser null por
          // DIMENSION_ELEGIBLE_PREPARACION_PENDIENTE (ver
          // movimientoNoAccionableRazon, abajo) — un hecho DISTINTO de
          // "no hay ninguna dimensión pendiente" que este campo nunca debe
          // confundir.
          estadoImposible: (r.parsed && resultadoMovimientoDecididoCrudo
            && resultadoMovimientoDecididoCrudo.codigoRazon === ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES)
            ? ESTADO_EXPLORANDO_SIN_DIMENSIONES_PENDIENTES
            : null,
          observacionNaturaleza: {
            declarada: observacionNaturalezaValor,
            gobernada: observacionNaturalezaGobernada,
            degradada: observacionNaturalezaDegradada,
          },
          huboRechazoEsteTurno,
          dimensionesRechazadasEsteTurno,
          // circulomejora006 (corrección final) — intersección exacta por
          // id (ver más arriba): la única señal que gobernó, de verdad,
          // REPARAR_TRAS_RECHAZO este turno. huboRechazoEsteTurno/
          // dimensionesRechazadasEsteTurno de arriba siguen siendo la señal
          // cruda (cualquier rechazo, visible o no) — nunca se pierden,
          // solo dejan de ser, por sí solas, lo que decide el movimiento.
          huboRechazoVisibleEsteTurno,
          dimensionesRechazadasVisiblesEsteTurno,
          huboObsolescenciaEsteTurno,
          atribucionSinJustificar,
          // T-DIM2 (circulomejora006 — contrato causal de respuesta a
          // intervención dirigida) — traza pura del contrato/relación/
          // resultado de ESTE turno (null cuando no hubo intervención
          // dirigida vigente). Reemplaza a atribucionSinJustificar como
          // resultado real observable — ver ContratoRespuestaDirigidaPolicy.
          contratoRespuestaDirigida: contratoRespuestaDirigidaEsteTurno,
          relacionRespuestaDirigida: relacionRespuestaDirigidaTraza,
          alineacionRespuestaDirigida: alineacionRespuestaDirigidaResultadoTraza,
          // SATISFIED_PREVIOUS_ACT != ACTIVE_PREVIOUS_ACT
          // (CURRENT_CANONICAL_ACT_MUST_OVERRIDE_STALE_CONVERSATIONAL_HISTORY,
          // C007, Daniel-adjudicated). True only when THIS turn's own
          // contextual verdict (veredictoRespuestaActoAnteriorEsteTurno,
          // computed just above from the SAME verified relacion/acto
          // canónico -- never re-derived here) already accepted the closure
          // this turn responded to. A LATER turn's reconstruction of
          // contratoRespuestaDirigidaEsteTurno (this same block, above)
          // reads this exact flag off THIS turn's own presented act to know
          // whether THAT act -- even though it may itself be a
          // PROPOSE_MISSION_CLOSURE restatement (Decision computes against
          // gramaticaActivaAlInicio) -- is the tail of an obligation already
          // governed-satisfied, never a fresh ask. Never set from grammar
          // transition alone (FA4); never set for RECHAZA_PREMISA/AMBIGUA/
          // any non-accepted verdict (FA5/FA6).
          respuestaDirigidaConsumidaPorAceptacion:
            veredictoRespuestaActoAnteriorEsteTurno.veredicto === VEREDICTOS_RESPUESTA_ACTO_ANTERIOR.MISSION_CLOSURE_ACCEPTED,
          // circulomejora006 (evaluacionInterpretacion) — traza pura de la
          // validación estructural de este bucle (ver arriba, dentro del
          // reintento de contrato). Commit 1 termina aquí: observabilidad
          // únicamente, todavía SIN conexión al Realizador ni a
          // candidatosMaterializables (eso es de un commit posterior).
          // "omitida" es la degradación simétrica a atribucionSinJustificar
          // — solo true cuando se agotaron los 3 intentos sin un
          // "resultado" válido.
          evaluacionInterpretacion: {
            resultado: evaluacionInterpretacionResultado,
            conceptoId: conceptoIdInterpretacionValidado,
            razon: evaluacionInterpretacionRazon,
            omitida: evaluacionInterpretacionOmitida,
          },
          // circulomejora006 (corrección posterior a la prueba real) — hecho
          // de ESTE turno únicamente (null si no hubo diferimiento); el
          // historial acumulado vive en protocoloDimensionesInterpretacionDiferida
          // (persistido aparte, ver dimensionesInterpretacionDiferidaNuevo).
          dimensionInterpretacionDiferida: dimensionInterpretacionDiferidaEsteTurno,
          // circulomejora006 (evaluacionInterpretacion, Commit 2) — refleja
          // la MISMA razón ya calculada arriba (movimientoNoEjecutadoRazon),
          // nunca un string fijo: la única razón real por la que este turno
          // difirió puede ahora ser la NUEVA EVALUACION_INTERPRETACION_OMITIDA,
          // no solo la existente INTERPRETACION_SIN_IDENTIDAD_MATERIALIZADA.
          razonInterpretacionDiferida: dimensionInterpretacionDiferidaEsteTurno ? movimientoNoEjecutadoRazon : null,
          turnoInterpretacionDiferida,
          // circulomejora006 (evaluacionInterpretacion, corrección de
          // carrera — auditoría aprobada) — tres hechos de ESTE turno,
          // nunca colapsados entre sí:
          //   movimientoPreparado      — dimensión (o null) para la que
          //     Movimiento, mirando solo el estado YA comprometido al
          //     inicio del turno, ya habría decidido PROPONER_INTERPRETACION.
          //     Gobierna evaluacionInterpretacionRequerida/dimensionFocal
          //     del prompt de este mismo turno.
          //   movimientoDecididoCrudo  — decisión de Movimiento tal cual,
          //     DESPUÉS de construcción, sin ninguna corrección del writer.
          //   movimientoDecidido (arriba) — la ÚNICA "realmente autorizada":
          //     igual a movimientoDecididoCrudo cuando es accionable; null
          //     cuando no lo es (ver movimientoNoAccionableRazon).
          // Ninguno se persiste en CognitiveState — son hechos de turno,
          // derivados de estado ya persistido (protocoloDimensionEnFoco/
          // protocoloDimensionesInterpretacionDiferida).
          movimientoPreparado: interpretacionPreparadaParaDimension,
          movimientoDecididoCrudo: resultadoMovimientoDecididoCrudo,
          // circulomejora006 (evaluacionInterpretacion, corrección de
          // carrera) — distinta de movimientoNoEjecutadoRazon: esta explica
          // por qué una decisión CRUDA de Movimiento nunca llegó a ser
          // accionable este turno (cruzó elegibilidad recién en esta misma
          // construcción, nunca ofrecida a Capa 1) — movimientoNoEjecutadoRazon
          // sigue siendo, sin cambios, la razón de un movimiento SÍ
          // accionable que no llegó a ejecutarse/materializarse.
          movimientoNoAccionableRazon,
        }
      : null;

    // P1-A (circulomejora006 — autoridad de cierre conversacional, primer
    // incremento) — DELIBERADAMENTE un objeto hermano de comprensionConversacional
    // (arriba), nunca fusionado dentro de él: "el usuario pidió avanzar" es
    // un hecho conversacional distinto de "cómo Círculo decidió responder" —
    // ver auditoría P1-D, "el Writer debe reconciliar cada bloque mediante
    // contratos distintos". Misma población que comprensionConversacional
    // (solo cuando el selector de DESTINO gobernó este turno) — nunca una
    // condición nueva. DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — la condición ya
    // no es destinoMovimientoAplicaEsteTurno (eso apagaba esto junto con
    // todo Movimiento): senalCierreConversacionalAplicaEsteTurno es la
    // misma condición, independiente, que ya gobierna si Capa 1 recibió el
    // campo "observacionesConversacionales" este turno.
    const senalCierreConversacional = senalCierreConversacionalAplicaEsteTurno
      ? { aceptadas: senalesCierreAceptadas, descartadas: senalesCierreDescartadas }
      : null;

    // P1-B (circulomejora006 — autoridad de objetivo conversacional ante
    // cierre) — objeto hermano de comprensionConversacional/senalCierreConversacional
    // (arriba), nunca fusionado: "qué debía intentar conseguir este turno"
    // es un hecho de gobernanza distinto tanto de "qué dijo el experto"
    // (P1-A) como de "cómo Círculo terminó respondiendo" (comprensionConversacional).
    // `movimientoObedecioObjetivo` es puramente observacional (ver
    // ObjetivoConversacionalPolicy) — nunca gobierna nada por sí mismo, ya
    // que para cuando se calcula, Movimiento/Gobernanza ya decidieron.
    // `objetivoConversacionalEsteTurno` puede seguir null aun con
    // senalCierreConversacionalAplicaEsteTurno true (p.ej. fallo de
    // transporte/parseo de Capa 1 que interrumpió el bucle antes de
    // calcularlo) — nunca se fabrica un objetivo en ese caso, igual que
    // comprensionConversacional deja sus propios campos en null/false en
    // vez de inventar un valor. DESTINO_RECONOCIMIENTO_DE_CIERRE_1 — misma
    // sustitución de condición que senalCierreConversacional, arriba: P1-B
    // debe decidir/persistir el objetivo (y protocoloIntencionCierre, más
    // abajo en _confirmarInteraccion) siempre que la señal de cierre esté
    // activa, exista o no Movimiento.
    const objetivoConversacional = (senalCierreConversacionalAplicaEsteTurno && objetivoConversacionalEsteTurno)
      ? {
          ...objetivoConversacionalEsteTurno,
          movimientoObedecioObjetivo: movimientoObedeceObjetivo(
            objetivoConversacionalEsteTurno.objetivo,
            contratoMovimientoDestino ? contratoMovimientoDestino.movimiento : null,
          ),
        }
      : null;

    // Un turno tipado de grafo sin acto contratado es una condición interna
    // de decisión, nunca permiso para publicar el mensaje bruto de Capa 1.
    // La frontera ya distinguió entre ausencia legítima de territorio y un
    // productor que no materializó una propuesta dentro de territorio
    // admisible; ambos casos abortan antes de la transacción corta y jamás
    // alcanzan el fallback histórico de next_user_action.
    //
    // AUTHORIZED_VISIBLE_OUTPUT_AVAILABLE (C007, Daniel-adjudicated,
    // faithful-replay-proven -- logistica_c0 turn 42). This guard used to
    // recognize only the two Decision-authority contract paths (typed-
    // direction / MOVIMIENTO) -- but GobernanzaMaterializacion(TRANSFORMAR)
    // -> Realizer is a THIRD, independently authorized visible-output path
    // (documented at "Un turno tipado de grafo sin acto contratado..."
    // above and at contratoCognitivoEjecutableAntesDeMaterializar's own
    // comment: "cuando existe un ContratoIntervencion ejecutable... la
    // frontera común... es la única autorizada para Contract -> Realizer;
    // OTRO materializador ya autorizado" for the case where none exists).
    // A real turn-42 attempt took exactly this third path, had the
    // Realizer produce and PASS every one of its own required gates
    // (validarContratoConectado when applicable, then the unconditional
    // FRONTERA_INTERVENCION_VISIBLE_1 safety validator, validarMaterializacion
    // -- see realizadorProdujoSalida's own assignment above, the SAME red
    // de seguridad final every Movimiento output already passes through),
    // and still had its complete, legitimate visible response discarded
    // here as COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER --
    // FAILED_TO_RECOGNIZE_AN_AUTHORIZED_ACT != NO_ACT.
    //
    // AUTHORITY_SOURCE_NOT_TEXT_PRESENCE: this deliberately does NOT check
    // decision.mensajeCirculo or r.parsed.mensaje (mere text presence is
    // never authority -- a raw, ungoverned Producer message would satisfy
    // that test too). realizadorProdujoSalida is a structural provenance
    // flag: true only when the TRANSFORMAR strategy was actually selected
    // AND the Realizer's own output survived every gate above. Any other
    // path (DETERMINISTA, PRESERVAR, a transport/validation failure inside
    // TRANSFORMAR) leaves it false -- fail-closed, unchanged, exactly as
    // before this fix.
    // RESPONSE_GOVERNED_TRANSITION_VISIBLE_COMMIT (C007) -- eligibility is
    // VALID_GOVERNED_PREVIOUS_ACT_RESPONSE (a frozen previous act existed
    // AND this turn's relation to it was structurally verified), never
    // avanzaReal alone: a verified rejection/correction/ambiguous response
    // is just as eligible to express itself here as an accepted one --
    // whether the turn actually advances stays exclusively Progreso's
    // authority (decidirInteraccion's avanzaReal, read elsewhere,
    // untouched by this flag). Reuses the SAME two authorities
    // interpretarVeredictoRespuestaActoAnterior itself consumes just above
    // (contratoRespuestaDirigidaEsteTurno, alineacionRespuestaDirigidaResultadoTraza)
    // -- never a second, looser verification. RESPONSE_GOVERNED_HANDOFF_DEFERS_NEXT_GRAMMAR_ACT
    // (C007): this is the SAME respuestaGobernadaVisibleEsteTurno already
    // computed above, before decidirInteraccion -- reused here, never
    // recomputed, per TRACE_MIRRORS_AUTHORITY_NEVER_CREATES_IT.
    const authorizedVisibleOutputAvailable = authorizedVisibleOutputEstaDisponible({
      contratoIntervencionDestino: decision.contratoIntervencionDestino,
      contratoIntervencionMovimiento,
      estrategiaParaMaterializar: estrategiaEfectivaTraza,
      realizadorProdujoSalida: realizadorProdujoSalidaEsteTurno,
      respuestaGobernadaVisible: respuestaGobernadaVisibleEsteTurno,
    });
    if (this._protocolV2Enabled && this._knowledgeGraphEnabled
      && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
      && decision.gramaticaSiguiente !== null
      && !authorizedVisibleOutputAvailable) {
      // AUTHORITY_CONTINUITY correction (RAW_FRONTIER_VETO_AFTER_
      // LEGITIMATE_CLOSURE / NEXT_ACT_AUTHORITY_IS_SINGLE). This guard no
      // longer builds ANY next-act projection of its own -- it consults
      // canonicalNextActStateV1EsteTurno, the EXACT SAME object Decision
      // (decidirIntervencionConversacional) already consumed earlier this
      // turn (see canonicalNextActStateV1, above) -- literally the same
      // reference, never a semantically-similar rebuild. That object
      // already carries closureOption (a pure projection of
      // ProgresoConversacionalPolicy's own single decidirProtocolo() result
      // for this turn, threaded in above -- decision.avanzaReal/
      // gramaticaSiguiente, read just below, come from decidirInteraccion()
      // reusing that SAME result via progresoPrecalculado, never a second
      // derivation). For 'destino' (out of scope for this fix) or any turn
      // that never reached the typed-direction block above,
      // canonicalNextActStateV1EsteTurno stays null;
      // tieneAlternativaCanonicaEjecutable(null) safely returns false,
      // preserving the legitimate fail-closed default unchanged.
      const fronteraNoEvaluada = estadoFronteraCognitivaEsteTurno === 'NOT_EVALUATED';
      // sinTerritorio now asks the CANONICAL question (is there anything
      // Decision could legitimately consume, closure included), never the
      // raw frontier signal alone -- a valid closureOption whose Contract
      // still failed to materialize correctly falls to
      // COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER below (Negative
      // Control D: FAILED_TO_REALIZE_AUTHORIZED_ACT != NO_ACT), never
      // NO_COGNITIVE_ACT_AVAILABLE.
      const sinTerritorio = estadoFronteraCognitivaEsteTurno === 'EVALUATED_EMPTY'
        && !tieneAlternativaCanonicaEjecutable(canonicalNextActStateV1EsteTurno);
      const codigo = fronteraNoEvaluada
        ? 'COGNITIVE_FRONTIER_NOT_EVALUATED'
        : (sinTerritorio
          ? 'NO_COGNITIVE_ACT_AVAILABLE'
          : 'COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER');
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        causa: codigo, errorCategory: null, retryable: false,
      });
      trazaAutoridadEsteTurno.visibleRoute = 'NONE';
      trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
      this._emitirTrazaAutoridad({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        traza: trazaAutoridadEsteTurno, commit: false, failureClass: codigo,
      });
      // C007 human canary v7/v8 — codigo stays internal identity for
      // logs/API observability (already reused above via
      // _marcarEntradaFallidaSiEsSeguro); mensaje is the only field a human
      // surface may read, and none of these three internal-architecture
      // strings are safe there.
      return {
        ok: false, httpStatus: 502, codigo,
        mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
      };
    }

    // A contract is not sufficient by itself: its authorized materialization
    // must also yield a non-empty visible message.  Never persist/report a
    // generated response when Realizer/materialization produced blank text.
    if (this._protocolV2Enabled && this._knowledgeGraphEnabled
      && direccionConversacionalTipadaActiva(gramaticaActivaAlInicio)
      && decision.gramaticaSiguiente !== null
      && authorizedVisibleOutputAvailable
      && !(typeof decision.mensajeCirculo === 'string' && decision.mensajeCirculo.trim())) {
      if (falloReparacionDiferido) return emitirFalloReparacionDiferido();
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        causa: 'SALIDA_VISIBLE_NO_DISPONIBLE', errorCategory: null, retryable: false,
      });
      trazaAutoridadEsteTurno.visibleRoute = decision.contratoIntervencionDestino ? 'CANONICAL' : 'LEGACY';
      if (decision.contratoIntervencionDestino) {
        trazaAutoridadEsteTurno.contract = {
          id: turnoIdReservadoEnAdmision,
          hasContract: true,
          operator: decision.contratoIntervencionDestino.actoCognitivoVisible
            && decision.contratoIntervencionDestino.actoCognitivoVisible.operator || null,
        };
      }
      trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_REACHED', fidelityResult: 'NOT_REACHED' };
      this._emitirTrazaAutoridad({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        traza: trazaAutoridadEsteTurno, commit: false, failureClass: 'SALIDA_VISIBLE_NO_DISPONIBLE',
      });
      return {
        // C007 — HONEST FAILURE SURFACE: same failure class as the sibling
        // branch above (SALIDA_VISIBLE_NO_DISPONIBLE) -- same shared honest
        // operational fallback, never "intervención contratada" jargon.
        ok: false, httpStatus: 502, codigo: 'SALIDA_VISIBLE_NO_DISPONIBLE',
        mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
      };
    }

    // GOVERNED_RESPONSE_MAY_COMMIT_WITHOUT_NEW_CURRENT_WHAT -- last line of
    // the deferral: a response-only continuation is only legitimate if the
    // existing machinery produced a real visible message; otherwise the
    // original fail-closed verdict stands.
    if (falloReparacionDiferido
      && !(typeof decision.mensajeCirculo === 'string' && decision.mensajeCirculo.trim())) {
      return emitirFalloReparacionDiferido();
    }

    // 8. Transacción corta y síncrona — ningún await puede ocurrir aquí dentro.
    // Si la transacción falla (p.ej. error de disco), better-sqlite3 ya hizo
    // rollback automático de Turno/Estado/Eventos — se traduce a un
    // resultado estructurado, igual que cualquier otro camino de fallo, en
    // vez de dejar propagar la excepción cruda.
    let resultado;
    try {
      resultado = this._unitOfWork.ejecutar(({ turnoRepo, stateRepo, eventRepo, outboxRepo, afirmacionTransformacionalRepo, entradaConversacionalRepo }) =>
        this._confirmarInteraccion({
          turnoRepo, stateRepo, eventRepo, outboxRepo, afirmacionTransformacionalRepo, entradaConversacionalRepo,
          sesionId, turnoClienteId, mensajeUsuario,
          // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §8 — la fila de
          // EntradaConversacional a marcar COMPLETADO, en la MISMA
          // transacción que crea el Turno. Siempre la reservada en
          // admisión (nunca turnoIdPreasignadoParaNuevaHipotesis, que puede
          // diferir — ver turnoId más abajo): es la única identidad
          // garantizada de haber sido persistida por _procesarBajoExclusividad.
          turnoIdEntradaAdmitida: turnoIdReservadoEnAdmision,
          state: estadoActual, gramaticaActivaAlInicio, decision, avance,
          dimensionEnFocoNuevo, comprensionConversacional, senalCierreConversacional, objetivoConversacional,
          obligacionCognitivaActivaId: (certificacionSatisfaccionResolucionEsteTurno || comandosResolucionReparacion.length > 0)
            ? ((certificacionSatisfaccionResolucionEsteTurno || (comandosResolucionReparacion[0] && comandosResolucionReparacion[0].obligacionId)).obligacionId === estadoActual.obligacionCognitivaActivaId
              ? null : (estadoActual.obligacionCognitivaActivaId || null))
            : (objetivoConversacionalEsteTurno
              && objetivoConversacionalEsteTurno.deudaPrioritaria
              && objetivoConversacionalEsteTurno.deudaPrioritaria.tipo === 'REPARACION'
              ? objetivoConversacionalEsteTurno.deudaPrioritaria.identidad : null),
          // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final) — mismos
          // valores YA calculados arriba para decidir el mensaje visible de
          // este turno; _confirmarInteraccion los reutiliza, dentro de la
          // MISMA transacción, para que avanzarIntencionCierre persista
          // exactamente el ciclo que el mensaje mostrado describe (nunca un
          // recálculo divergente).
          deudasFinalesSnapshotCandidatoEsteTurno, dimensionesConEvidenciaPostTurnoEsteTurno,
          // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — traza
          // durable de mutaciones destructivas rechazadas, requisito 5).
          mutacionesLateralesRechazadasTraza,
          // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final) — veredictos
          // NUEVOS de ValidadorSemanticoMutacionConcepto emitidos en este
          // turno (nunca los reutilizados de autoridadesPreviasMutacion,
          // que ya están persistidos) — _confirmarInteraccion los añade a
          // state.protocoloAutoridadesMutacionValidadas y emite su traza.
          autoridadesMutacionNuevasEsteTurno,
          // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — traza de
          // GOBERNANZA_DELTA_DIMENSIONAL de este turno (concordante o
          // adjudicada) — _confirmarInteraccion solo la emite, puramente
          // observacional, nunca la reinterpreta.
          gobernanzaDimensionTrazaEsteTurno,
      dimensionesInterpretacionDiferidaNuevo,
      dimensionesInterpretacionSinGananciaNuevo,
          comandosResolucionReparacion,
          reparacionesInterpretativasPostTurno,
          idsConceptosAlInicioTurno,
          protocoloComposicionTransformacionalPendiente: composicionPendienteTransformacionalNuevo,
          causaRelacionalObservada,
          // S1_R_INCREMENTO_3 — reparación ABIERTA vinculada a la cabeza
          // actual, si existe (ver bloque de arriba) — _confirmarInteraccion
          // la usa, dentro de la MISMA transacción, para persistir
          // durablemente la nueva candidata sucesora cuando este turno
          // realmente propuso una (huboNuevaHipotesisRelacionalEsteTurno).
          reparacionS1RAbiertaParaEsteTurno,
          // COMPATIBILIDAD_HISTORICA (REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS)
          // — snapshot de rolesOriginales recuperado, si corresponde, contra
          // emisionesLegitimas para una entrada persistida antes de que ese
          // campo existiera (ver bloque de propuesta, arriba). null cuando
          // ninguna entrada lo necesitó — _confirmarInteraccion lo aplica,
          // DENTRO de la misma transacción, para que quede durable desde el
          // siguiente guardado.
          rolesOriginalesRecuperadosParaPersistir,
          // circulomejora006_reporte03 — cuando este turno propuso una nueva
          // Hipótesis, el Turno REAL debe nacer con el MISMO turnoId que ya
          // quedó congelado dentro de ella (hipotesis.turnoPresentacionId) —
          // nunca uno distinto minado de nuevo aquí abajo. DURABILIDAD_
          // ENTRADA_CONVERSACIONAL_1 (condición 1) — ambas ramas del `||`
          // son AHORA el mismo valor: turnoIdPreasignadoParaNuevaHipotesis
          // (cuando existe) ya ES turnoIdReservadoEnAdmision, reutilizado
          // por el propio productor de la propuesta (ver
          // turnoIdParaNuevaPropuesta, arriba) — nunca una identidad
          // competidora. El `||` se conserva solo por claridad de lectura
          // (turnoIdPreasignadoParaNuevaHipotesis es null en cualquier turno
          // sin propuesta nueva), no porque puedan divergir.
          turnoId: turnoIdPreasignadoParaNuevaHipotesis || turnoIdReservadoEnAdmision,
          // S1-DISAGREE1 — contrato común de desacuerdo, tal como Capa 1 lo
          // declaró ESTE turno (r.parsed no sobrevive fuera de este método) —
          // puramente observacional dentro de _confirmarInteraccion, nunca
          // gobierna ninguna decisión ahí (esa autoridad ya la resolvió
          // decision.aperturaS1RPrecalculada, arriba).
          desacuerdoSemanticoEsteTurno: r.parsed ? {
            impactoCambio: r.parsed.impacto_cambio || null,
            ambitoCorreccion: r.parsed.ambito_correccion || null,
            evidenciaTextual: r.parsed.evidencia_textual || null,
            elementosConservados: Array.isArray(r.parsed.elementos_conservados) ? r.parsed.elementos_conservados : null,
          } : null,
        }));
    } catch (e) {
      // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 2) — el proceso
      // SIGUE VIVO y sabe, con certeza, que este intento terminó sin
      // Turno: marca FALLIDO en vez de dejar la entrada en PENDIENTE
      // indefinidamente (PENDIENTE queda reservado para el caso en que el
      // proceso muere y nunca llega a ejecutar este catch — ver Test Q).
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId: turnoIdReservadoEnAdmision, sesionId, turnoClienteId,
        causa: 'PERSISTENCE_ERROR', retryable: null,
      });
      return {
        ok: false, httpStatus: 500, codigo: 'PERSISTENCE_ERROR',
        mensaje: `No se pudo confirmar la interacción: ${e.message}`,
      };
    }

    // 9b. Incremento 7d (corrección post-revisión): despacho INMEDIATO — pura
    // optimización de latencia, después de que la transacción ya confirmó y
    // liberó la base, nunca dentro de ella. Fire-and-forget deliberado: no
    // bloquea la respuesta HTTP (la sesión ya no tiene gramaticaActiva, así
    // que no hay turno siguiente con el que pueda competir). Si el proceso
    // muriera ANTES de esta línea (o durante), la solicitud ya quedó
    // durable en el outbox dentro de la transacción — un
    // recuperarPendientes() posterior (en este proceso o en otro) la
    // recupera igual. PipelineDownstreamDispatcher nunca lanza — el
    // .catch() es una red de seguridad adicional.
    if (resultado.pipelineSolicitado && this._downstreamDispatcher) {
      this._downstreamDispatcher.despacharInmediato(sesionId).catch(() => {});
    }

    // C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 4. visibleRoute
    // is derived, never re-decided: CANONICAL iff the canonical Contract
    // (decision.contratoIntervencionDestino) actually carried the visible
    // response; LEGACY otherwise for any turn that still committed (the
    // pre-existing Movimiento path, upstream of this point, already wrote
    // r.parsed.mensaje directly) -- routing itself is untouched by this
    // increment, only observed.
    trazaAutoridadEsteTurno.visibleRoute = decision.contratoIntervencionDestino ? 'CANONICAL' : 'LEGACY';
    if (decision.contratoIntervencionDestino) {
      trazaAutoridadEsteTurno.contract = {
        id: (resultado && resultado.turnoId) || turnoIdReservadoEnAdmision,
        hasContract: true,
        operator: decision.contratoIntervencionDestino.actoCognitivoVisible
          && decision.contratoIntervencionDestino.actoCognitivoVisible.operator || null,
      };
    }
    if (decision.origenMaterializacionVisible) {
      // origen ∈ {'realizador','material_candidato_validado','fallback_determinista'}
      // (MaterializacionIntervencionVisible.js) -- only 'realizador' means the
      // Realizer+Fidelity loop actually ran and Fidelity returned FIEL; the
      // other two never needed either.
      const realizadorFueNecesario = decision.origenMaterializacionVisible === 'realizador';
      trazaAutoridadEsteTurno.realization = {
        origen: decision.origenMaterializacionVisible,
        realizerResult: realizadorFueNecesario ? 'SUCCESS' : 'NOT_NEEDED',
        fidelityResult: realizadorFueNecesario ? 'FIEL' : 'NOT_NEEDED',
      };
    } else if (decision.contratoIntervencionDestino) {
      trazaAutoridadEsteTurno.realization = { realizerResult: 'NOT_NEEDED', fidelityResult: 'NOT_NEEDED' };
    }
    // C007 CONVERSATIONAL ENGINE STABILIZATION -- CLASS 12 (grammar handoff)
    // instrumentation gap: `grammar` (set at admission, top of this method)
    // already carries grammar-BEFORE; nothing previously carried grammar-
    // AFTER. Pure transport of what ProgresoConversacionalPolicy/GatePolicy
    // (via decidirInteraccion, above) already decided this turn -- never
    // recalculated here, never a new gate, never new cognitive authority.
    // PREVIOUS_INTERVENTION_DIMENSION_SURVIVES_TO_RESPONSE_ATTRIBUTION --
    // temporal response provenance for the NEXT turn's capture, derived from
    // the intervention actually COMMITTED/presented (this trace is emitted
    // with commit:true only on this success path). Null unless the presented
    // intervention carries its own legitimate dimension identity -- never the
    // Objective's current required dimension, never a grammar default.
    {
      const contratoPresentado = decision.contratoIntervencionDestino || null;
      trazaAutoridadEsteTurno.responseAttributionContext = gramaticaActivaAlInicio === 'destino' ? null
        : construirContextoAtribucionRespuesta({
          mision: gramaticaActivaAlInicio,
          sourceTurnId: (resultado && resultado.turnoId) || turnoIdReservadoEnAdmision,
          acto: contratoPresentado ? contratoPresentado.actoCognitivoVisible || null : null,
          oportunidadFuente: contratoPresentado && contratoPresentado.contenido
            ? contratoPresentado.contenido.oportunidadConversacional || null : null,
        });
    }
    trazaAutoridadEsteTurno.handoff = {
      occurred: !!decision.avanzaReal,
      grammarAfter: decision.avanzaReal ? decision.gramaticaSiguiente : gramaticaActivaAlInicio,
    };
    this._emitirTrazaAutoridad({
      turnoId: (resultado && resultado.turnoId) || turnoIdReservadoEnAdmision,
      sesionId, turnoClienteId, traza: trazaAutoridadEsteTurno, commit: true,
    });
    // 9. Solo después del commit (ya ocurrido de forma síncrona dentro de
    // ejecutar()) se devuelve éxito.
    return { ok: true, httpStatus: 200, ...resultado };
  }

  /**
   * Transacción PROPIA de la fase de RECONCILIACIÓN HISTÓRICA (Incremento 1,
   * corrección arquitectónica) — independiente de _confirmarInteraccion.
   * Solo toca knowledgeGraph + versión + un evento de auditoría; nunca crea
   * Turno, nunca toca slots/protocolo. Devuelve el nuevo estado (en memoria)
   * para que el resto del turno (fase de construcción) parta de él.
   */
  _confirmarReconciliacion({
    stateRepo, eventRepo, sesionId, turnoClienteId, gramaticaActivaAlInicio, state, grafoNuevo,
    // Ley de Integridad Cognitiva — hechos comprobables de ESTE turno,
    // nunca una interpretación (concepto afectado, operación realizada,
    // cita del experto, sustituto cuando exista) — ver _confirmarReconciliacion
    // más abajo, donde se emiten como eventos propios, distintos de
    // 'reconciliacion.aplicada'. Vacíos por defecto — turnos que nunca
    // tocan conocimiento exportado no emiten nada nuevo.
    refinaciones = [], contradicciones = [], rechazosVisiblesAtribuidos = [],
  }) {
    const rechazosAutorizados = rechazosVisiblesAtribuidos.filter(hecho => {
      const intento = state.knowledgeGraph.conceptos.find(c => c.id === hecho.intentoInterpretacionId);
      return intento
        && intento.materializadoViaMovimiento === MOVIMIENTOS_DESTINO.PROPONER_INTERPRETACION
        && dimensionDeProcedencia(intento.procedencia) === hecho.dimension;
    });
    const comandosApertura = derivarComandosApertura(rechazosAutorizados);
    const reparacionesAplicadas = aplicarComandosReparacion({
      secuenciaActual: state.protocoloSecuenciaReparacionInterpretativa,
      reparacionesActuales: state.protocoloReparacionesInterpretativasPendientes,
      comandos: comandosApertura,
    });
    const correlationId = `${gramaticaActivaAlInicio}_reconciliacion_${turnoClienteId || 'sinclave'}`;
    eventRepo.save(createEvent({
      tipo: 'reconciliacion.aplicada', sesionId, correlationId,
      payload: {
        gramaticaActiva: gramaticaActivaAlInicio,
        incertidumbresAntes: incertidumbresRelevantesAbiertas(state.knowledgeGraph, gramaticaActivaAlInicio).length,
        incertidumbresDespues: incertidumbresRelevantesAbiertas(grafoNuevo, gramaticaActivaAlInicio).length,
        reparacionesInterpretativasAbiertas: reparacionesAplicadas.aperturasAplicadas,
      },
    }));

    // Ley de Integridad Cognitiva — un evento por operación, nunca un
    // campo dentro de 'reconciliacion.aplicada': la distinción entre
    // resolver razonamiento transitorio y revisar conocimiento exportado
    // debe quedar visible en el propio tipo de evento, no oculta dentro de
    // uno genérico. Cada payload registra solo hechos comprobables — nunca
    // una garantía sobre lo que pudo depender de este conocimiento.
    refinaciones.forEach(r => {
      eventRepo.save(createEvent({
        tipo: 'conocimiento.refinado', sesionId, correlationId,
        payload: {
          gramaticaActiva: gramaticaActivaAlInicio,
          // circulomejora006 (segunda auditoría, Sección 2) — qué contrato
          // público produjo esta entrada: 'gramatica_activa'
          // (aplicarDeltaRevisionActiva) o 'gramatica_exportada'
          // (aplicarDeltaIntegridad) — un hecho comprobable más, nunca un
          // estado cognitivo nuevo.
          ambito: r.ambito,
          conceptoAnteriorId: r.conceptoAnteriorId, conceptoNuevoId: r.conceptoNuevoId,
          procedencia: r.procedencia,
          descripcionAnterior: r.descripcionAnterior, descripcionNueva: r.descripcionNueva,
          porQue: r.porQue,
        },
      }));
    });
    contradicciones.forEach(c => {
      eventRepo.save(createEvent({
        tipo: 'conocimiento.contradicho', sesionId, correlationId,
        payload: {
          gramaticaActiva: gramaticaActivaAlInicio,
          ambito: c.ambito,
          conceptoId: c.conceptoId, procedencia: c.procedencia,
          descripcionAnterior: c.descripcionAnterior, porQue: c.porQue,
          conReemplazo: false,
        },
      }));
    });

    const versionAnterior = state.versionId;
    const version = createVersion({
      sesionId, motivacion: `Reconciliación histórica — ${gramaticaActivaAlInicio}`, estadoPrevioId: versionAnterior,
    });
    const nuevoEstado = {
      ...state,
      knowledgeGraph: grafoNuevo,
      protocoloSecuenciaReparacionInterpretativa: reparacionesAplicadas.secuenciaResultante,
      protocoloReparacionesInterpretativasPendientes: reparacionesAplicadas.reparacionesResultantes,
      versionId: version.id,
      versionPreviaId: versionAnterior,
      actualizadoEn: new Date().toISOString(),
    };
    // Reconciliation is staged for the enclosing grammar-turn transaction.
    // Its audit events may persist independently, but the cognitive state
    // must not advance current until a visible turn succeeds.
    return nuevoEstado;
  }

  /**
   * Registra que la fase de reconciliación agotó sus reintentos sin
   * producir un delta válido — nunca bloquea el turno, nunca modifica el
   * grafo. Diagnóstico puro (ver estrategia de degradación, Incremento 1).
   */
  _registrarReconciliacionFallida({ eventRepo, sesionId, turnoClienteId, gramaticaActivaAlInicio, errores }) {
    const correlationId = `${gramaticaActivaAlInicio}_reconciliacion_${turnoClienteId || 'sinclave'}`;
    eventRepo.save(createEvent({
      tipo: 'reconciliacion.fallida', sesionId, correlationId,
      payload: { gramaticaActiva: gramaticaActivaAlInicio, errores },
    }));
  }

  /**
   * circulomejora006_act10j — rama TERMINAL exclusiva de
   * VALIDANDO_RELACION_TRANSFORMACIONAL. Coordina EXACTAMENTE lo que la
   * cabecera del archivo exige de cualquier turno: LLM fuera de
   * transacción (delegado por completo a
   * ValidacionRelacionTransformacionalDestinoCasoDeUso, que además valida
   * el contrato, decide protocolo y aplica el veredicto — ninguna de esas
   * tres decisiones se repite aquí), persistencia dentro de una única
   * transacción síncrona. Este método nunca reimplementa lógica de
   * dominio: solo traduce el resultado estructurado del caso de uso hacia
   * el mecanismo de Turno/CognitiveState ya existente, reutilizando
   * createTurno/createVersion/serializeState/stateRepo.save tal cual el
   * resto del archivo ya los usa.
   */
  async _procesarValidacionRelacionTransformacionalDestino({
    sesionId, mensajeUsuario, turnoClienteId, state, gramaticaActivaAlInicio,
    // S1-R-SCOPE1 — ver call site (_procesarBajoExclusividad). null en
    // cualquier sesión sin reparación S1-R ABIERTA.
    exclusionesResultado = null,
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §6 — identidad interna reservada
    // en admisión (ver _procesarBajoExclusividad); ya no se genera aquí.
    // Reutilizada, sin regenerarse, en cualquier reintento de este mismo
    // turnoClienteId, y como turnoId del cognitive_turno final si converge.
    turnoId,
  }) {
    // Defensivo — VALIDANDO_RELACION_TRANSFORMACIONAL nunca debería
    // persistirse fuera de 'destino' (única gramática con
    // HipotesisTransformacionalDestino); nunca se intenta adivinar qué
    // hacer si ocurriera.
    if (gramaticaActivaAlInicio !== 'destino') {
      throw new Error(
        'InteraccionCognitivaWriter: protocoloEstado VALIDANDO_RELACION_TRANSFORMACIONAL '
        + `fuera de la gramática 'destino' (recibida: ${gramaticaActivaAlInicio})`,
      );
    }

    // Fuera de cualquier transacción — mismo principio documentado en la
    // cabecera del archivo: la llamada al LLM (aquí, delegada por completo
    // al caso de uso) nunca ocurre dentro de unitOfWork.ejecutar(...).
    const resultado = await procesarRespuestaValidacionRelacionTransformacionalDestino({
      sesionId, grafoActual: state.knowledgeGraph, cognitiveState: state,
      mensajeUsuario, generador: this._llmService, turnoId, exclusionesResultado,
    });

    // Bloqueado ANTES de invocar el generador (identidad no verificable,
    // emisión ya consumida/sustituida, hipótesis recién obsoletada) o
    // contrato inválido tras invocarlo: 0 nuevas transiciones — nunca se
    // persiste un Turno nuevo ni se reescribe protocoloEstado. Causa
    // estructurada preservada tal cual la produjo el caso de uso, nunca
    // convertida en mensaje genérico.
    if (resultado.evento === null) {
      // circulomejora006_reporte02 (incremento correctivo — idempotencia y
      // recuperación durable) — EMISION_YA_CONFIRMADA es la señal exacta de
      // que esta identidad {sesionId,hipotesisId,version} ya fue confirmada
      // process-localmente (recuperarContextoAutoritativoRelacionTransformacionalDestino
      // la bloqueó ANTES de invocar el generador — nunca se llegó a llamar
      // al LLM ni a reclasificar). Nunca se trata como bloqueo genérico:
      // puede ser un reintento tras un fallo de convergencia durable previo,
      // o una segunda confirmación genuina del usuario — ambos casos
      // indistinguibles aquí y ambos resueltos igual (ver docstring del
      // método de recuperación).
      if (resultado.causa === 'EMISION_YA_CONFIRMADA' && resultado.hipotesisEstado === 'CONFIRMADA') {
        return this._recuperarOCompletarConvergenciaTransformacional({
          sesionId, mensajeUsuario, turnoClienteId, state, gramaticaActivaAlInicio, turnoId,
        });
      }
      // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §9 — ninguna operación posterior
      // a la admisión produjo un Turno (bloqueo determinístico antes de
      // invocar al generador, o CONTRATO_INVALIDO tras invocarlo con el
      // mensaje real — ver ValidacionRelacionTransformacionalDestinoCasoDeUso).
      // La EntradaConversacional ya admitida permanece — nunca se finge que
      // el Turno ocurrió. Transacción propia, corta: solo marca estado +
      // traza, nunca toca CognitiveState ni el grafo.
      const retryable = retryableDesdeErrorCategory(resultado.errorCategory || null);
      this._unitOfWork.ejecutar(({ entradaConversacionalRepo, eventRepo }) => {
        if (entradaConversacionalRepo) {
          entradaConversacionalRepo.marcarEstado({
            turnoId, estadoProcesamiento: 'FALLIDO',
            ultimaCausaFallo: resultado.causa || null,
            ultimaCategoriaFallo: resultado.errorCategory || null,
            retryable,
          });
        }
        eventRepo.save(createEvent({
          tipo: 'entrada_conversacional.procesamiento_fallido', sesionId, turnoId,
          correlationId: turnoClienteId,
          payload: { causa: resultado.causa || null, errorCategory: resultado.errorCategory || null, retryable },
        }));
      });
      return {
        ok: true, httpStatus: 200,
        mensaje: resultado.mensaje,
        state,
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — contrato de fallo
        // explícito: nunca `mensaje:null` indistinguible de un éxito con
        // respuesta vacía. entradaRegistrada:true es lo que rompe la
        // regresión de FASE_46B — el mensaje del usuario sigue siendo
        // recuperable aunque el procesamiento no lo haya sido.
        entradaRegistrada: true,
        procesamientoCompletado: false,
        respuestaGenerada: false,
        turnoId,
        turnoClienteId,
        protocolo: {
          estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
          estadoNuevo: resultado.protocoloEstadoSiguiente,
          evento: null,
          avanzaReal: false,
          hipotesisEstado: resultado.hipotesisEstado,
          ambitoCorreccion: resultado.ambitoCorreccion,
          componenteRelacional: resultado.componenteRelacional,
          causa: resultado.causa,
          errorCategory: resultado.errorCategory || null,
          retryable,
        },
      };
    }

    // circulomejora006_act10j (continuidad del objetivo dirigido) —
    // conserva EXCLUSIVAMENTE el dato (ver nota completa en CognitiveState.js,
    // junto a VALID_OBJETIVO_RELACIONAL_DIRIGIDO): ningún productor lo
    // consume todavía para construir el próximo prompt — esa pieza es un
    // incremento posterior. Se limpia a null salvo que ESTE turno haya
    // dejado un componente relacional cuestionado.
    const nuevoEstado = {
      ...state,
      protocoloEstado: resultado.protocoloEstadoSiguiente,
      // Ambigua deja la hipótesis en 'CANDIDATA' — la emisión sigue
      // pendiente y la proyección debe conservarse intacta para que el
      // siguiente turno pueda resolver identidad contra el mismo registro
      // autoritativo (nunca null: eso simularía una emisión inexistente).
      protocoloHipotesisTransformacionalPendiente: resultado.hipotesisEstado === 'CANDIDATA'
        ? state.protocoloHipotesisTransformacionalPendiente
        : (resultado.hipotesisEstado === 'CONFIRMADA'
          ? { ...state.protocoloHipotesisTransformacionalPendiente, estado: 'CONFIRMADA' }
          : null),
      protocoloObjetivoRelacionalDirigido: resultado.componenteRelacional || null,
      protocoloIntentosAmbiguos: resultado.evento === PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_ACLARACION_SOLICITADA
        ? (state.protocoloIntentosAmbiguos || 0) + 1
        : 0,
    };
    const versionAnterior = state.versionId;
    const version = createVersion({
      sesionId, motivacion: `Validación de relación transformacional — ${resultado.evento}`,
      estadoPrevioId: versionAnterior,
    });
    nuevoEstado.versionId = version.id;
    nuevoEstado.versionPreviaId = versionAnterior;
    nuevoEstado.actualizadoEn = new Date().toISOString();

    // circulomejora006_reporte01 (Paso 1 — convergencia productiva) —
    // EXCLUSIVAMENTE cuando la Hipótesis acaba de quedar CONFIRMADA (nunca
    // rechaza/corrige/ambigua/bloqueada — ver "Rechazo y corrección" de la
    // entrega). `hipotesisAutoritativa` es el objeto AUTORITATIVO exacto
    // (nunca una proyección, nunca reconstruido) que el caso de uso ya
    // devolvió — la única fuente de la proposición.
    let convergencia = null;
    const debeConverger = resultado.hipotesisEstado === 'CONFIRMADA' && !!resultado.hipotesisAutoritativa;

    let turno;
    try {
      turno = this._unitOfWork.ejecutar(({ turnoRepo, stateRepo, eventRepo, afirmacionTransformacionalRepo, entradaConversacionalRepo }) => {
        const numeroDeTurno = turnoRepo.proximoNumeroDeTurno(sesionId);
        const turnoCreado = createTurno({
          sesionId, turnoClienteId, turnoId, numeroDeTurno,
          gramatica: gramaticaActivaAlInicio, etapaCognitivaAsociada: state.etapaActual || 'idle',
          mensajeExperto: mensajeUsuario, mensajeCirculo: resultado.mensaje || '',
          aportesBrutos: {},
        });
        turnoRepo.save(turnoCreado);
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §8 — misma transacción,
        // todo-o-nada con turnoRepo.save de arriba. turnoId aquí ES el
        // reservado en admisión (parámetro de esta función — ver
        // _procesarValidacionRelacionTransformacionalDestino), sin la
        // excepción de turnoIdPreasignadoParaNuevaHipotesis que sí existe
        // en _confirmarInteraccion.
        if (entradaConversacionalRepo) {
          entradaConversacionalRepo.marcarEstado({
            turnoId, estadoProcesamiento: 'COMPLETADO', actualizadoEn: turnoCreado.creadoEn,
          });
        }
        const correlationId = `${gramaticaActivaAlInicio}_${turnoCreado.turnoId}`;
        eventRepo.save(createEvent({
          tipo: 'relacion_transformacional.veredicto_procesado',
          sesionId, turnoId: turnoCreado.turnoId, correlationId,
          payload: {
            evento: resultado.evento, hipotesisEstado: resultado.hipotesisEstado,
            ambitoCorreccion: resultado.ambitoCorreccion, componenteRelacional: resultado.componenteRelacional,
            causa: resultado.causa,
          },
        }));

        // S1_R_INCREMENTO_4 — identidad de R capturada ANTES de converger
        // (mientras A TODAVÍA es la cabeza vigente — convergerHipotesisConfirmadaAAfirmacionDurable
        // moverá la cabeza a C dentro de este mismo bloque, ver más abajo).
        // Mismo patrón de lectura que el bloque RECHAZADA de más abajo —
        // nunca una segunda regla de vínculo B↔R.
        const cabezaAntesDeConverger = debeConverger && afirmacionTransformacionalRepo
          ? afirmacionTransformacionalRepo.findHeadBySession(sesionId)
          : null;
        const reparacionVinculadaAConvergencia = cabezaAntesDeConverger && cabezaAntesDeConverger.afirmacion
          ? afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
              sesionId, cabezaAntesDeConverger.afirmacion.id, cabezaAntesDeConverger.afirmacion.version,
            )
          : null;
        const debeResolverReparacion = !!(
          reparacionVinculadaAConvergencia
          && reparacionVinculadaAConvergencia.hipotesisSucesoraId === resultado.hipotesisAutoritativa.id
          && reparacionVinculadaAConvergencia.hipotesisSucesoraVersion === resultado.hipotesisAutoritativa.version
        );

        // Todo-o-nada dentro de ESTA MISMA transacción SQLite: si
        // convergerHipotesisConfirmadaAAfirmacionDurable lanza, better-sqlite3
        // revierte turnoRepo.save/eventRepo.save de arriba también — nunca se
        // persiste un turno que reclame convergencia sin que la Afirmación
        // durable exista realmente (ver "Atomicidad" de la entrega).
        if (debeConverger) {
          convergencia = convergerHipotesisConfirmadaAAfirmacionDurable({
            repo: afirmacionTransformacionalRepo, sesionId, turnoId,
            hipotesisConfirmada: resultado.hipotesisAutoritativa,
            grafoActual: nuevoEstado.knowledgeGraph, gramatica: gramaticaActivaAlInicio,
            mensajeUsuario,
          });
          nuevoEstado.knowledgeGraph = convergencia.grafoNuevo;
          nuevoEstado.protocoloSintesisVigente = {
            gramatica: gramaticaActivaAlInicio,
            texto: convergencia.formulacionCongelada,
            turnoOrigenId: turnoCreado.turnoId,
            version: 1,
            // La proyección normativa vive en knowledgeGraph y se identifica
            // por Afirmación+versión; este puntero pertenece exclusivamente
            // al lifecycle de síntesis conversacional local.
            conceptoInterpretativoId: null,
            afirmacionTransformacionalId: convergencia.afirmacionTransformacionalId,
            fuenteSemantica: fuenteSemanticaAfirmacion(
              convergencia.afirmacionTransformacionalId, convergencia.afirmacionVersion,
            ),
          };
          eventRepo.save(createEvent({
            tipo: 'hipotesis_transformacional.convergio_a_afirmacion',
            sesionId, turnoId: turnoCreado.turnoId, correlationId,
            payload: {
              hipotesisId: convergencia.hipotesisId, hipotesisVersion: convergencia.hipotesisVersion,
              afirmacionTransformacionalId: convergencia.afirmacionTransformacionalId,
              afirmacionVersion: convergencia.afirmacionVersion,
              afirmacionEstado: convergencia.afirmacionEstado,
              cabezaInstalada: convergencia.cabezaInstalada,
            },
          }));

          // S1_R_INCREMENTO_4 — orden causal obligatorio: converger (arriba)
          // → superar A → resolver R. Nunca antes de que C exista realmente
          // AUTORIZADA (convergencia ya lanzó si algo falló). Nunca fuera de
          // esta transacción — un fallo aquí revierte también la
          // convergencia recién comprometida, sin excepción.
          if (debeResolverReparacion) {
            afirmacionTransformacionalRepo.marcarAfirmacionSuperadaPorSucesion({
              sesionId, afirmacionId: cabezaAntesDeConverger.afirmacion.id,
              afirmacionSustitutaId: convergencia.afirmacionTransformacionalId,
            });
            afirmacionTransformacionalRepo.resolverReparacionS1R({
              sesionId, reparacionId: reparacionVinculadaAConvergencia.reparacionId,
              afirmacionSucesoraId: convergencia.afirmacionTransformacionalId,
              turnoId: turnoCreado.turnoId,
            });
            eventRepo.save(createEvent({
              tipo: 'reparacion_s1r.resuelta', sesionId, turnoId: turnoCreado.turnoId, correlationId,
              payload: {
                reparacionId: reparacionVinculadaAConvergencia.reparacionId,
                afirmacionOrigenId: cabezaAntesDeConverger.afirmacion.id,
                afirmacionOrigenVersion: cabezaAntesDeConverger.afirmacion.version,
                hipotesisSucesoraId: resultado.hipotesisAutoritativa.id,
                hipotesisSucesoraVersion: resultado.hipotesisAutoritativa.version,
                afirmacionSucesoraId: convergencia.afirmacionTransformacionalId,
                afirmacionSucesoraVersion: convergencia.afirmacionVersion,
                turnoId: turnoCreado.turnoId,
              },
            }));
          }
        }

        // S1_R_INCREMENTO_3 — cuando la Hipótesis que acaba de quedar
        // RECHAZADA es la candidata sucesora que una reparación S1-R ABIERTA
        // tenía registrada (ver registrarHipotesisSucesoraCandidata), en la
        // MISMA transacción: (a) se registra el rechazo, append-only, en la
        // memoria negativa durable (ya existente desde el Incremento 1,
        // ahora con roles — ver auditoría previa) y (b) se libera el slot de
        // candidata pendiente — nunca se resuelve R, nunca se toca A. Fuera
        // de este caso exacto (Hipótesis sin vínculo con ninguna R ABIERTA —
        // el arranque normal de DESTINO, sin reparación), este bloque nunca
        // se ejecuta — contrato anterior intacto.
        if (
          resultado.hipotesisEstado === 'RECHAZADA' && resultado.hipotesisAutoritativa
          && afirmacionTransformacionalRepo
        ) {
          const cabezaActual = afirmacionTransformacionalRepo.findHeadBySession(sesionId);
          const reparacionVinculada = cabezaActual && cabezaActual.afirmacion
            ? afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
                sesionId, cabezaActual.afirmacion.id, cabezaActual.afirmacion.version,
              )
            : null;
          if (
            reparacionVinculada && reparacionVinculada.hipotesisSucesoraId === resultado.hipotesisAutoritativa.id
            && reparacionVinculada.hipotesisSucesoraVersion === resultado.hipotesisAutoritativa.version
          ) {
            afirmacionTransformacionalRepo.registrarHipotesisSucesoraRechazada({
              sesionId, reparacionId: reparacionVinculada.reparacionId,
              hipotesisId: resultado.hipotesisAutoritativa.id,
              hipotesisVersion: resultado.hipotesisAutoritativa.version,
              turnoId: turnoCreado.turnoId, correccionDetalle: mensajeUsuario,
              roles: resultado.hipotesisAutoritativa.roles,
            });
            afirmacionTransformacionalRepo.limpiarHipotesisSucesoraCandidata({
              sesionId, reparacionId: reparacionVinculada.reparacionId,
            });
          }
        }

        // S1-R-SCOPE1 — mismo tratamiento durable que un rechazo explícito
        // de sucesora (bloque de arriba), pero disparado por el propio
        // sistema (candidataIncompatibleConReparacion), nunca por un
        // veredicto del usuario: registra la incompatibilidad en la MISMA
        // memoria negativa append-only (para que reproducir, sin cambios,
        // el mismo rol "resultado" quede bloqueado por
        // REPRODUCE_HIPOTESIS_RECHAZADA la próxima vez) y libera el slot de
        // candidata pendiente — nunca resuelve R, nunca toca A, nunca borra
        // la Hipótesis (sigue existiendo, CANDIDATA, como registro
        // histórico/diagnóstico — ver Fase 8 de la auditoría).
        if (resultado.candidataIncompatibleConReparacion && afirmacionTransformacionalRepo) {
          const cabezaActual = afirmacionTransformacionalRepo.findHeadBySession(sesionId);
          const reparacionVinculada = cabezaActual && cabezaActual.afirmacion
            ? afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
                sesionId, cabezaActual.afirmacion.id, cabezaActual.afirmacion.version,
              )
            : null;
          if (
            reparacionVinculada && reparacionVinculada.hipotesisSucesoraId === resultado.hipotesisIdCandidataIncompatible
            && reparacionVinculada.hipotesisSucesoraVersion === resultado.hipotesisVersionCandidataIncompatible
          ) {
            afirmacionTransformacionalRepo.registrarHipotesisSucesoraRechazada({
              sesionId, reparacionId: reparacionVinculada.reparacionId,
              hipotesisId: resultado.hipotesisIdCandidataIncompatible,
              hipotesisVersion: resultado.hipotesisVersionCandidataIncompatible,
              turnoId: turnoCreado.turnoId,
              correccionDetalle: 'Candidata sucesora incompatible: reutilizaba, sin cambios, el resultado que esta reparación ya cuestiona (detectado por el sistema, S1-R-SCOPE1).',
              roles: resultado.rolesCandidataIncompatible,
            });
            afirmacionTransformacionalRepo.limpiarHipotesisSucesoraCandidata({
              sesionId, reparacionId: reparacionVinculada.reparacionId,
            });
          }
        }

        // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 — ver
        // entradaExclusionHipotesisPorRol/DIMENSION_A_CAMPO_ROL_HIPOTESIS
        // arriba. Aplica en CUALQUIER rechazo 'corrige'+ambito='concepto' con
        // dimensión localizable — con o sin reparación S1-R vinculada (mismo
        // Modelo B, nunca dos mecanismos paralelos: el caso post-Afirmación
        // sigue, además, protegido por REPRODUCE_HIPOTESIS_RECHAZADA/
        // S1-R-SCOPE1 de arriba, que este bloque nunca reemplaza ni
        // duplica). Dedup por (campoRol, conceptoId): la misma exclusión
        // nunca se registra dos veces aunque el experto repita la corrección
        // (caso real: turno 13 de la auditoría V2 repite el rechazo del
        // turno 9 sobre el mismo conceptoId).
        if (
          resultado.hipotesisEstado === 'RECHAZADA' && resultado.ambitoCorreccion === 'concepto'
          && resultado.dimensionConcepto && resultado.hipotesisAutoritativa
        ) {
          // Frontera positiva (auditoría del smoke real) — si el MISMO turno
          // de corrección ya trae un reemplazo extraído por Capa 1
          // (resultado.conceptosNuevosReemplazo), se materializa AHORA,
          // dentro de esta misma transacción, con la MISMA gobernanza de
          // autoridad (autoridadGobernada vía aplicarDelta) que cualquier
          // otro conceptosNuevos del sistema — un "experto" no literal
          // degrada a "inferido" en silencio, y solo lo que sobrevive como
          // 'experto' cuenta como asignación positiva real (mismo criterio
          // de candidatura que construirReferenciasPorRolDestino ya exige
          // para cualquier rol).
          let conceptosPositivosIdsEsteTurno = [];
          if (Array.isArray(resultado.conceptosNuevosReemplazo) && resultado.conceptosNuevosReemplazo.length > 0) {
            const { grafoNuevo: grafoConReemplazo, errores: erroresReemplazo, idTemporalAReal: idsReemplazo } = aplicarDelta(
              nuevoEstado.knowledgeGraph, { conceptosNuevos: resultado.conceptosNuevosReemplazo },
              { mensajeUsuario, turnoOrigenId: turnoClienteId },
            );
            if (grafoConReemplazo && (!erroresReemplazo || erroresReemplazo.length === 0)) {
              nuevoEstado.knowledgeGraph = grafoConReemplazo;
              const idsNuevos = new Set(Object.values(idsReemplazo || {}));
              conceptosPositivosIdsEsteTurno = grafoConReemplazo.conceptos
                .filter(c => idsNuevos.has(c.id) && c.autoridad === 'experto' && c.activo === true)
                .map(c => c.id);
            }
          }
          const nuevaEntrada = entradaExclusionHipotesisPorRol({
            dimensionConcepto: resultado.dimensionConcepto,
            hipotesisAutoritativa: resultado.hipotesisAutoritativa,
            turnoCorreccionId: turnoCreado.turnoId,
            evidenciaTextual: mensajeUsuario,
            conceptosPositivosIds: conceptosPositivosIdsEsteTurno,
            // "no aceptar que la parte positiva desaparezca silenciosamente"
            // — declarado por Capa 1 (con o sin reintento) pero, incluso
            // tras materializar, ningún concepto sobrevivió como 'experto'
            // activo: la entrada queda con este estado explícito, nunca
            // como SOLO_EXCLUSION indistinguible de "nunca hubo reemplazo".
            reemplazoDeclaradoSinMaterializar: !!resultado.reemplazoDeclaradoSinMaterializar
              || (resultado.conceptosNuevosReemplazo && resultado.conceptosNuevosReemplazo.length > 0
                  && conceptosPositivosIdsEsteTurno.length === 0),
          });
          if (nuevaEntrada) {
            const yaExcluidos = new Set(
              (nuevoEstado.protocoloExclusionesHipotesisPorRol || [])
                .filter(e => e.campoRol === nuevaEntrada.campoRol)
                .flatMap(e => e.conceptoIds),
            );
            const conceptoIdsNuevos = nuevaEntrada.conceptoIds.filter(id => !yaExcluidos.has(id));
            if (conceptoIdsNuevos.length > 0) {
              nuevoEstado.protocoloExclusionesHipotesisPorRol = [
                ...(nuevoEstado.protocoloExclusionesHipotesisPorRol || []),
                { ...nuevaEntrada, conceptoIds: conceptoIdsNuevos },
              ];
              if (nuevaEntrada.estadoCorreccion === 'REEMPLAZO_DECLARADO_SIN_MATERIALIZAR') {
                eventRepo.save(createEvent({
                  tipo: 'destino_correccion_semantica.reemplazo_declarado_sin_materializar',
                  sesionId, turnoId: turnoCreado.turnoId, correlationId,
                  payload: { campoRol: nuevaEntrada.campoRol, dimension: nuevaEntrada.dimension, hipotesisId: nuevaEntrada.hipotesisId },
                }));
              }
            }
          }
        }

        stateRepo.save(sesionId, serializeState(nuevoEstado));
        return turnoCreado;
      });
    } catch (e) {
      // circulomejora006_reporte01 — "si la persistencia durable falla: no
      // pierdas la posibilidad de reintentar; no presentes el turno como
      // convergencia exitosa; conserva una causa estructurada; no instales
      // una autoridad parcial." better-sqlite3 ya revirtió TODA la
      // transacción (Turno/Eventos/Estado/Afirmación) — nunca queda una
      // autoridad parcial en SQLite. Límite real, documentado, no resuelto
      // aquí: el registro process-local de HipotesisTransformacionalDestino
      // (emisionesLegitimas) ya marcó esta emisión CONFIRMADA ANTES de esta
      // transacción (en el caso de uso, fuera de unitOfWork.ejecutar — mismo
      // principio que decidirInteraccion/grafoDelta) y no tiene reversión:
      // un reintento del MISMO turno chocaría con EMISION_YA_CONFIRMADA. Se
      // devuelve un fallo explícito, nunca un éxito silencioso, para que el
      // límite sea detectable en vez de oculto.
      //
      // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 2) — el proceso
      // sigue vivo y sabe que este intento terminó sin Turno: marca
      // FALLIDO. Un reintento del mismo turnoClienteId encontrará la
      // entrada FALLIDA, reprocesará, y (dado EMISION_YA_CONFIRMADA
      // process-local) caerá exactamente en
      // _recuperarOCompletarConvergenciaTransformacional — el mecanismo de
      // recuperación que ya existía para este límite, sin cambios.
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId, sesionId, turnoClienteId,
        causa: 'CONVERGENCIA_AFIRMACION_FALLIDA', retryable: null,
      });
      return {
        ok: false, httpStatus: 500, codigo: 'CONVERGENCIA_AFIRMACION_FALLIDA',
        mensaje: `No se pudo converger la hipótesis confirmada hacia una afirmación durable: ${e.message}`,
        protocolo: {
          estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
          hipotesisEstado: resultado.hipotesisEstado,
          causa: 'CONVERGENCIA_AFIRMACION_FALLIDA',
        },
      };
    }

    return {
      ok: true, httpStatus: 200,
      turno, state: nuevoEstado, mensaje: resultado.mensaje,
      entendido: state.slots,
      gramaticaCompletada: false,
      pipelineSolicitado: false,
      avanzoDeGramatica: false,
      protocolo: {
        estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
        estadoNuevo: resultado.protocoloEstadoSiguiente,
        evento: resultado.evento,
        avanzaReal: false,
        hipotesisEstado: resultado.hipotesisEstado,
        ambitoCorreccion: resultado.ambitoCorreccion,
        componenteRelacional: resultado.componenteRelacional,
        causa: resultado.causa,
        // circulomejora006_reporte01 — sin obligar al Writer (ni a quien lo
        // llame) a reconstruir decisiones de dominio: null en cualquier
        // turno que no convergió (rechaza/corrige/ambigua/bloqueada).
        hipotesisId: convergencia ? convergencia.hipotesisId : null,
        afirmacionTransformacionalId: convergencia ? convergencia.afirmacionTransformacionalId : null,
        afirmacionEstado: convergencia ? convergencia.afirmacionEstado : null,
        cabezaInstalada: convergencia ? convergencia.cabezaInstalada : null,
      },
    };
  }

  /**
   * circulomejora006_reporte02 (incremento correctivo — idempotencia y
   * recuperación durable de la convergencia Hipótesis→Afirmación).
   *
   * Único punto de entrada, exclusivo de causa==='EMISION_YA_CONFIRMADA':
   * la Hipótesis {sesionId,hipotesisId,version} ya quedó CONFIRMADA
   * process-localmente (emisionesLegitimas) — pero eso, por sí solo, NUNCA
   * demuestra que la convergencia durable (Afirmación AUTORIZADA + cabeza +
   * evento causal) llegó a completarse: `emisionesLegitimas` no tiene
   * reversión (ver docstring de ConvergenciaTransformacionalDestinoOrquestacion),
   * así que un fallo de transacción en un turno anterior deja exactamente
   * esta huella. Este método NUNCA llama al generador, NUNCA reclasifica,
   * NUNCA acuña una segunda Hipótesis — resuelve, dentro de una única
   * transacción nueva:
   *
   *   1. ¿Ya existe una convergencia durable para esta identidad exacta?
   *      (buscarConvergenciaDurablePorHipotesis, vía el evento causal) — si
   *      sí, la recupera tal cual (nunca reinstala cabeza, nunca
   *      incrementa revisión, nunca persiste un segundo evento causal):
   *      cubre tanto el reintento post-fallo-ya-completado como una
   *      segunda confirmación genuina del usuario.
   *   2. Si no existe: ¿la Hipótesis sigue confirmable process-localmente?
   *      (recuperarHipotesisConfirmadaPendienteDeConvergencia) — si sí,
   *      completa AHORA la convergencia que quedó pendiente (mismo
   *      mecanismo que _procesarValidacionRelacionTransformacionalDestino
   *      ya usa, nunca reimplementado) y persiste su evento causal.
   *   3. Si ninguna de las dos: límite estructural documentado, nunca
   *      resuelto por invención (el proceso se reinició después de
   *      CONFIRMADA y antes de que la convergencia durable completara —
   *      emisionesLegitimas es process-local y no sobrevive un reinicio) —
   *      se reporta CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE, explícito.
   *
   * Persiste, en la MISMA transacción, un Turno para este intento y el
   * CognitiveState resultante (protocoloEstado→LISTO_PARA_SINTESIS,
   * protocoloSintesisVigente con la referencia durable) — nunca dos
   * Turnos, nunca dos Afirmaciones.
   */
  async _recuperarOCompletarConvergenciaTransformacional({
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §6 — turnoId ya no se genera
    // aquí: es la identidad reservada en admisión, threaded desde
    // _procesarValidacionRelacionTransformacionalDestino (el único llamador).
    sesionId, mensajeUsuario, turnoClienteId, state, gramaticaActivaAlInicio, turnoId,
  }) {
    const hipotesisPendienteProyectada = state.protocoloHipotesisTransformacionalPendiente;
    const { hipotesisId, version } = hipotesisPendienteProyectada;

    let convergencia = null;
    let recuperada = false;
    let resultadoTransaccion;
    try {
      resultadoTransaccion = this._unitOfWork.ejecutar(({
        turnoRepo, stateRepo, eventRepo, afirmacionTransformacionalRepo, entradaConversacionalRepo,
      }) => {
        const existente = buscarConvergenciaDurablePorHipotesis({
          eventRepo, afirmacionTransformacionalRepo, sesionId, hipotesisId, version,
        });

        if (existente.encontrada) {
          recuperada = true;
          const afirmacionAutorizada = existente.afirmacion;
          convergencia = {
            hipotesisId, hipotesisVersion: version,
            afirmacionTransformacionalId: afirmacionAutorizada.id,
            afirmacionVersion: afirmacionAutorizada.version,
            afirmacionEstado: afirmacionAutorizada.estado,
            cabezaInstalada: afirmacionAutorizada.estado === 'AUTORIZADA',
            conceptoProyectadoId: null,
            grafoNuevo: state.knowledgeGraph,
            formulacionCongelada: hipotesisPendienteProyectada.formulacionCongelada,
          };
        } else {
          const hipotesisConfirmada = recuperarHipotesisConfirmadaPendienteDeConvergencia({
            sesionId, hipotesisPendienteProyectada,
          });
          if (!hipotesisConfirmada) {
            throw Object.assign(
              new Error('La hipótesis confirmada ya no está disponible process-localmente (probable reinicio) y no existe convergencia durable previa.'),
              { codigoConvergencia: 'CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE' },
            );
          }
          // S1_R_INCREMENTO_4 — mismo vínculo B↔R, misma disciplina que
          // _procesarValidacionRelacionTransformacionalDestino: capturado
          // ANTES de converger, mientras A todavía es cabeza. Este es el
          // único call site de convergerHipotesisConfirmadaAAfirmacionDurable
          // dentro de la recuperación que realmente CONVIERTE (el otro,
          // `existente.encontrada` arriba, es una lectura pura de una
          // convergencia YA comprometida — y por atomicidad, si esa
          // convergencia original pasó por este mismo código, R ya quedó
          // RESUELTA en la MISMA transacción original; nada que repetir aquí).
          const cabezaAntesDeConverger = afirmacionTransformacionalRepo.findHeadBySession(sesionId);
          const reparacionVinculada = cabezaAntesDeConverger && cabezaAntesDeConverger.afirmacion
            ? afirmacionTransformacionalRepo.findReparacionAbiertaPorAfirmacion(
                sesionId, cabezaAntesDeConverger.afirmacion.id, cabezaAntesDeConverger.afirmacion.version,
              )
            : null;
          const debeResolverReparacion = !!(
            reparacionVinculada && reparacionVinculada.hipotesisSucesoraId === hipotesisConfirmada.id
            && reparacionVinculada.hipotesisSucesoraVersion === hipotesisConfirmada.version
          );

          convergencia = convergerHipotesisConfirmadaAAfirmacionDurable({
            repo: afirmacionTransformacionalRepo, sesionId, turnoId,
            hipotesisConfirmada, grafoActual: state.knowledgeGraph,
            gramatica: gramaticaActivaAlInicio, mensajeUsuario,
          });
          eventRepo.save(createEvent({
            tipo: 'hipotesis_transformacional.convergio_a_afirmacion',
            sesionId, turnoId, correlationId: `${gramaticaActivaAlInicio}_${turnoId}`,
            payload: {
              hipotesisId: convergencia.hipotesisId, hipotesisVersion: convergencia.hipotesisVersion,
              afirmacionTransformacionalId: convergencia.afirmacionTransformacionalId,
              afirmacionVersion: convergencia.afirmacionVersion,
              afirmacionEstado: convergencia.afirmacionEstado,
              cabezaInstalada: convergencia.cabezaInstalada,
            },
          }));

          if (debeResolverReparacion) {
            afirmacionTransformacionalRepo.marcarAfirmacionSuperadaPorSucesion({
              sesionId, afirmacionId: cabezaAntesDeConverger.afirmacion.id,
              afirmacionSustitutaId: convergencia.afirmacionTransformacionalId,
            });
            afirmacionTransformacionalRepo.resolverReparacionS1R({
              sesionId, reparacionId: reparacionVinculada.reparacionId,
              afirmacionSucesoraId: convergencia.afirmacionTransformacionalId, turnoId,
            });
            eventRepo.save(createEvent({
              tipo: 'reparacion_s1r.resuelta', sesionId, turnoId,
              correlationId: `${gramaticaActivaAlInicio}_${turnoId}`,
              payload: {
                reparacionId: reparacionVinculada.reparacionId,
                afirmacionOrigenId: cabezaAntesDeConverger.afirmacion.id,
                afirmacionOrigenVersion: cabezaAntesDeConverger.afirmacion.version,
                hipotesisSucesoraId: hipotesisConfirmada.id,
                hipotesisSucesoraVersion: hipotesisConfirmada.version,
                afirmacionSucesoraId: convergencia.afirmacionTransformacionalId,
                afirmacionSucesoraVersion: convergencia.afirmacionVersion,
                turnoId,
              },
            }));
          }
        }

        const nuevoEstado = {
          ...state,
          protocoloEstado: 'LISTO_PARA_SINTESIS',
          protocoloHipotesisTransformacionalPendiente: { ...hipotesisPendienteProyectada, estado: 'CONFIRMADA' },
          protocoloObjetivoRelacionalDirigido: null,
          protocoloIntentosAmbiguos: 0,
          knowledgeGraph: convergencia.grafoNuevo,
          protocoloSintesisVigente: {
            gramatica: gramaticaActivaAlInicio,
            texto: convergencia.formulacionCongelada,
            turnoOrigenId: turnoId,
            version: 1,
            // No mezclar la proyección durable cross-grammar con el puntero
            // de síntesis local reemplazable.
            conceptoInterpretativoId: null,
            afirmacionTransformacionalId: convergencia.afirmacionTransformacionalId,
            fuenteSemantica: fuenteSemanticaAfirmacion(
              convergencia.afirmacionTransformacionalId, convergencia.afirmacionVersion,
            ),
          },
        };
        const versionAnterior = state.versionId;
        const version_ = createVersion({
          sesionId, motivacion: `Recuperación/completado idempotente de convergencia — ${hipotesisId}`,
          estadoPrevioId: versionAnterior,
        });
        nuevoEstado.versionId = version_.id;
        nuevoEstado.versionPreviaId = versionAnterior;
        nuevoEstado.actualizadoEn = new Date().toISOString();

        const numeroDeTurno = turnoRepo.proximoNumeroDeTurno(sesionId);
        const turnoCreado = createTurno({
          sesionId, turnoClienteId, turnoId, numeroDeTurno,
          gramatica: gramaticaActivaAlInicio, etapaCognitivaAsociada: state.etapaActual || 'idle',
          mensajeExperto: mensajeUsuario,
          mensajeCirculo: recuperada
            ? 'Esta confirmación ya había sido registrada — se recuperó la afirmación existente.'
            : 'Confirmación registrada.',
          aportesBrutos: {},
        });
        turnoRepo.save(turnoCreado);
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §8 — misma transacción,
        // todo-o-nada. turnoId aquí es el parámetro de esta función (ver
        // _procesarValidacionRelacionTransformacionalDestino, único
        // llamador) — el reservado en admisión, sin excepciones.
        if (entradaConversacionalRepo) {
          entradaConversacionalRepo.marcarEstado({
            turnoId, estadoProcesamiento: 'COMPLETADO', actualizadoEn: turnoCreado.creadoEn,
          });
        }
        stateRepo.save(sesionId, serializeState(nuevoEstado));
        return { turnoCreado, nuevoEstado };
      });
    } catch (e) {
      if (e.codigoConvergencia === 'CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE') {
        // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 2) — límite
        // conocido y permanente dentro de este proceso (el registro
        // process-local se perdió y no hay convergencia durable previa):
        // retryable:false, un reintento del mismo turnoClienteId chocaría
        // con la misma imposibilidad.
        this._marcarEntradaFallidaSiEsSeguro({
          turnoId, sesionId, turnoClienteId,
          causa: 'CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE', retryable: false,
        });
        return {
          ok: false, httpStatus: 500, codigo: 'CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE',
          mensaje: e.message,
          state,
          protocolo: {
            estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
            hipotesisEstado: 'CONFIRMADA',
            causa: 'CONVERGENCIA_HIPOTESIS_NO_RECUPERABLE',
          },
        };
      }
      // Mismo criterio que _procesarValidacionRelacionTransformacionalDestino:
      // better-sqlite3 ya revirtió toda la transacción — nunca una
      // autoridad parcial, nunca un éxito silencioso.
      this._marcarEntradaFallidaSiEsSeguro({
        turnoId, sesionId, turnoClienteId,
        causa: 'CONVERGENCIA_AFIRMACION_FALLIDA', retryable: null,
      });
      return {
        ok: false, httpStatus: 500, codigo: 'CONVERGENCIA_AFIRMACION_FALLIDA',
        mensaje: `No se pudo recuperar ni completar la convergencia pendiente: ${e.message}`,
        state,
        protocolo: {
          estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
          hipotesisEstado: 'CONFIRMADA',
          causa: 'CONVERGENCIA_AFIRMACION_FALLIDA',
        },
      };
    }

    const { turnoCreado, nuevoEstado } = resultadoTransaccion;
    return {
      ok: true, httpStatus: 200,
      turno: turnoCreado, state: nuevoEstado,
      mensaje: turnoCreado.mensajeCirculo,
      entendido: state.slots,
      gramaticaCompletada: false,
      pipelineSolicitado: false,
      avanzoDeGramatica: false,
      protocolo: {
        estadoAnterior: 'VALIDANDO_RELACION_TRANSFORMACIONAL',
        estadoNuevo: 'LISTO_PARA_SINTESIS',
        evento: PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_CONFIRMADA,
        avanzaReal: false,
        hipotesisEstado: 'CONFIRMADA',
        ambitoCorreccion: null,
        componenteRelacional: null,
        causa: recuperada ? 'CONVERGENCIA_RECUPERADA' : 'CONVERGENCIA_COMPLETADA',
        hipotesisId: convergencia.hipotesisId,
        afirmacionTransformacionalId: convergencia.afirmacionTransformacionalId,
        afirmacionEstado: convergencia.afirmacionEstado,
        cabezaInstalada: convergencia.cabezaInstalada,
      },
    };
  }

  /**
   * DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (condición 2 — PENDIENTE vs
   * FALLIDO; corregida en la revisión posterior: la frontera NO es throw
   * vs return, es TERMINACION_CONOCIDA_SIN_TURNO vs TERMINACION_DESCONOCIDA).
   * Se llama desde dos formas de terminación conocida:
   *
   *   (a) un `catch` ya en curso, cuando la transacción que debía crear el
   *       Turno acaba de fallar y el proceso SIGUE VIVO para saberlo — se
   *       marca en su PROPIA transacción nueva (la que falló ya hizo
   *       rollback completo — nunca se reabre);
   *   (b) un RETORNO estructurado (nunca un throw) desde un punto donde el
   *       Writer sabe con certeza que el intento terminó sin Turno —
   *       LLM_UNAVAILABLE, SALIDA_VISIBLE_NO_DISPONIBLE, SINTESIS_INVALIDA,
   *       ESTADO_PROTOCOLAR_INCONSISTENTE (ver call sites en
   *       _procesarBajoExclusividad). No importa el mecanismo de
   *       terminación (throw, resultado estructurado, agotamiento de
   *       reintentos) — lo que importa es que el resultado es CONOCIDO.
   *
   * Nunca se llama para una terminación DESCONOCIDA (crash real, proceso
   * muerto antes de ejecutar cualquier código de terminación): ese caso, por
   * definición, no ejecuta ni un catch ni un return — la entrada
   * correctamente permanece PENDIENTE hasta que un retry la recupere (ver
   * Test Q2).
   *
   * Defensivo por diseño: si esta escritura de recuperación TAMBIÉN falla
   * (p.ej. el propio motor SQLite está caído), se traga el error sin
   * relanzar — nunca enmascara el error original que ya se está
   * propagando desde el `catch` que la invocó (caso (a)). La entrada queda
   * como estaba (PENDIENTE) en ese caso — sigue siendo durable, solo sin la
   * precisión de causa; un futuro retry la recupera igual.
   */
  _marcarEntradaFallidaSiEsSeguro({ turnoId, sesionId, turnoClienteId, causa, errorCategory = null, retryable = null }) {
    if (!turnoId || !sesionId) return;
    try {
      this._unitOfWork.ejecutar(({ entradaConversacionalRepo, eventRepo }) => {
        if (!entradaConversacionalRepo) return;
        entradaConversacionalRepo.marcarEstado({
          turnoId, estadoProcesamiento: 'FALLIDO',
          ultimaCausaFallo: causa || null, ultimaCategoriaFallo: errorCategory, retryable,
        });
        eventRepo.save(createEvent({
          tipo: 'entrada_conversacional.procesamiento_fallido', sesionId, turnoId,
          correlationId: turnoClienteId || null,
          payload: { causa: causa || null, errorCategory, retryable },
        }));
      });
    } catch { /* nunca enmascara el error original que ya se está propagando */ }
  }

  /**
   * C007 CONVERSATIONAL ENGINE STABILIZATION, Deliverable 4 -- TURN
   * AUTHORITY TRACE. Reuses EventBus/cognitive_events exactly like
   * _marcarEntradaFallidaSiEsSeguro above (same persistence pattern, same
   * defensive swallow -- never masks the real error/result already being
   * returned). Emitted for the exact turnoId, success OR failure, covering
   * the next-act-authority vertical this stabilization increment targets
   * (novelty/CanonicalNextActState/repair/Decision/Contract/route/
   * realization/commit) -- IDs and short reasons only, never prompts or raw
   * payload dumps. AuthorityTrace != CognitiveState: this event is pure
   * observability and is never read back to govern any decision.
   */
  _emitirTrazaAutoridad({ turnoId, sesionId, turnoClienteId, traza, commit, failureClass = null }) {
    if (!turnoId || !sesionId) return;
    try {
      this._unitOfWork.ejecutar(({ eventRepo }) => {
        eventRepo.save(createEvent({
          tipo: 'authority_trace.turno', sesionId, turnoId,
          correlationId: turnoClienteId || null,
          payload: { ...traza, commit: !!commit, failureClass },
        }));
      });
    } catch { /* observabilidad nunca enmascara el resultado real del turno */ }
    // DETERMINISTIC REPLAY CAPTURE -- terminal record (Section 8). Every
    // real call site of _emitirTrazaAutoridad already carries turnoId/
    // sesionId/turnoClienteId/commit/failureClass -- reused verbatim here,
    // never recalculated. Links the capture ledger to the turn's actual
    // outcome without duplicating the AuthorityTrace itself.
    this._capturarTerminalReplaySiCorresponde({ turnoId, sesionId, turnoClienteId, commit, failureClass });
  }

  /**
   * DETERMINISTIC REPLAY CAPTURE (Section 3) -- exact preState (JSON +
   * SHA-256), emitted ONCE per turn, right after admission reserves
   * turnoId (call site: _procesarBajoExclusividad, immediately after
   * turnoIdReservadoEnAdmision is set) and BEFORE any cognitive mutation.
   * Its OWN transaction (same defensive-swallow pattern as
   * _emitirTrazaAutoridad/_marcarEntradaFallidaSiEsSeguro) -- durable even
   * if the turn never reaches a commit or a final AuthorityTrace. `state`
   * is the exact pre-mutation CognitiveState this turn started from --
   * never re-read later, never approximated.
   */
  _capturarPreStateSiCorresponde({ turnoId, sesionId, turnoClienteId, gramaticaActivaAlInicio, state }) {
    if (!this._deterministicReplayCaptureEnabled || !turnoId || !sesionId) return;
    try {
      const preStateJson = serializeState(state);
      this._unitOfWork.ejecutar(({ eventRepo }) => {
        eventRepo.save(createEvent({
          tipo: 'replay_capture.prestate', sesionId, turnoId,
          correlationId: turnoClienteId || null,
          payload: {
            grammar: gramaticaActivaAlInicio,
            preStateVersion: state.versionId,
            preState: JSON.parse(preStateJson),
            preStateSha256: sha256Hex(preStateJson),
            engineBuildFingerprint: computeEngineBuildFingerprint(),
          },
        }));
      });
    } catch { /* observabilidad nunca enmascara el resultado real del turno */ }
  }

  /** DETERMINISTIC REPLAY CAPTURE (Section 8) -- see _emitirTrazaAutoridad, its only call site. */
  _capturarTerminalReplaySiCorresponde({ turnoId, sesionId, turnoClienteId, commit, failureClass }) {
    if (!this._deterministicReplayCaptureEnabled || !turnoId || !sesionId) return;
    try {
      this._unitOfWork.ejecutar(({ eventRepo }) => {
        eventRepo.save(createEvent({
          tipo: 'replay_capture.terminal', sesionId, turnoId,
          correlationId: turnoClienteId || null,
          payload: {
            status: commit ? 'COMMITTED' : 'FAILED',
            failureClass: failureClass || null,
            commit: !!commit,
          },
        }));
      });
    } catch { /* observabilidad nunca enmascara el resultado real del turno */ }
    // OBSERVABILITY_O1 -- this IS the one point (success or failure alike,
    // via _emitirTrazaAutoridad's only call site) after which no executor
    // for this turnoId legitimately calls again; release the shared turn
    // capture context here so it never grows unbounded across the process.
    try { LLMService.clearReplayCaptureContext(turnoId); } catch { /* nunca enmascara el resultado real del turno */ }
  }

  /** Ejecuta síncronamente dentro de unitOfWork.ejecutar(). */
  _confirmarInteraccion({
    turnoRepo, stateRepo, eventRepo, outboxRepo, sesionId, turnoClienteId, mensajeUsuario, state,
    idsConceptosAlInicioTurno = new Set((state.knowledgeGraph && state.knowledgeGraph.conceptos || []).map(c => c.id)),
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §8 — misma transacción que crea
    // el Turno: marca la EntradaConversacional ya admitida como COMPLETADO.
    // Siempre la reservada en admisión (ver call site) — nunca `turnoId`
    // (más abajo), que en el caso raro de nueva Hipótesis propuesta puede
    // diferir (ver nota junto a turnoId).
    entradaConversacionalRepo = null, turnoIdEntradaAdmitida = null,
    // S1_R_INCREMENTO_2 — misma conexión/transacción que el resto de estos
    // repositorios (CognitiveUnitOfWork.ejecutar los entrega juntos, ver
    // "Antes de editar" de la entrega); no conectado hasta este incremento
    // porque ningún camino previo necesitaba escribir aquí.
    afirmacionTransformacionalRepo = null, obligacionCognitivaActivaId = null,
    // S1_R_INCREMENTO_3 — reparación ABIERTA vinculada a la cabeza actual de
    // esta sesión, ya resuelta por el llamador (ver _procesarBajoExclusividad,
    // lectura pura, fuera de transacción) — null en cualquier caso sin
    // reparación (arranque normal de DESTINO, contrato anterior intacto).
    reparacionS1RAbiertaParaEsteTurno = null,
    // COMPATIBILIDAD_HISTORICA (REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS)
    // — ver _procesarBajoExclusividad, bloque de propuesta. `null` (default)
    // reproduce el comportamiento anterior byte a byte: ninguna entrada
    // necesitó recuperación, o no había ninguna exclusión vigente.
    rolesOriginalesRecuperadosParaPersistir = null,
    gramaticaActivaAlInicio, decision, avance = null,
    // circulomejora006 — dimensionEnFocoNuevo ya viene resuelto (incluye la
    // limpieza por "dimensión ya no pendiente"/"flag apagado", ver
    // _procesarBajoExclusividad); comprensionConversacional es null salvo
    // que este turno haya pasado por el selector de DESTINO.
    dimensionEnFocoNuevo = null, comprensionConversacional = null,
    // P1-A (circulomejora006 — autoridad de cierre conversacional, primer
    // incremento) — mismo patrón que comprensionConversacional (arriba):
    // null salvo que este turno haya pasado por el selector de DESTINO.
    // Deliberadamente un parámetro separado, nunca fusionado dentro de
    // comprensionConversacional — ver auditoría P1-D.
    senalCierreConversacional = null,
    // P1-B (circulomejora006 — autoridad de objetivo conversacional ante
    // cierre) — mismo patrón: null salvo que este turno haya pasado por el
    // selector de DESTINO. Objeto hermano de comprensionConversacional/
    // senalCierreConversacional, nunca fusionado — ver ObjetivoConversacionalPolicy.
    objetivoConversacional = null,
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final — presupuesto de
    // pregunta final consolidada) — ya calculados por el llamador
    // (_procesarBajoExclusividad, mismo momento que decide el mensaje
    // visible de este turno); avanzarIntencionCierre los consume para abrir
    // o reevaluar el ciclo, dentro de la MISMA transacción. `null` (default)
    // reproduce el comportamiento anterior byte a byte.
    deudasFinalesSnapshotCandidatoEsteTurno = null,
    dimensionesConEvidenciaPostTurnoEsteTurno = null,
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final) — traza
    // durable de mutaciones destructivas rechazadas por
    // validarMutacionesDestructivasBajoCierre, sea cual sea el productor.
    // `[]` (default) reproduce el comportamiento anterior byte a byte —
    // nunca emite el evento de abajo.
    mutacionesLateralesRechazadasTraza = [],
    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final) — veredictos NUEVOS
    // de ValidadorSemanticoMutacionConcepto de este turno, a persistir en
    // state.protocoloAutoridadesMutacionValidadas (autoridad durable
    // reutilizable) y a trazar vía el evento correspondiente, abajo. `[]`
    // (default) reproduce el comportamiento anterior byte a byte.
    autoridadesMutacionNuevasEsteTurno = [],
    // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — traza de
    // GOBERNANZA_DELTA_DIMENSIONAL de este turno. `[]` (default) reproduce
    // el comportamiento anterior byte a byte — nunca emite el evento de
    // abajo.
    gobernanzaDimensionTrazaEsteTurno = [],
    // circulomejora006 (corrección posterior a la prueba real) — ya viene
    // fusionado con el historial previo (nunca lo recalcula esta función).
    dimensionesInterpretacionDiferidaNuevo = [],
    dimensionesInterpretacionSinGananciaNuevo = {},
    comandosResolucionReparacion = [],
    reparacionesInterpretativasPostTurno = [],
    protocoloComposicionTransformacionalPendiente = null,
    // S1-DISAGREE1 — null salvo que este turno haya producido un contrato
    // de ESPERANDO_CONFIRMACION (rechaza/corrige); puramente observacional,
    // ver uso en el evento sintesis.correccion_recibida más abajo.
    desacuerdoSemanticoEsteTurno = null,
    // circulomejora006_act10l — estado real (más amplio que el de 3
    // valores que decidirProtocolo entiende) de haber intentado, ESTE
    // turno, una nueva propuesta relacional — null si no se intentó nada
    // (objetivo inactivo, otra gramática, otro estado). Únicamente
    // observabilidad — nunca gobierna ninguna transición (eso ya lo
    // resolvió decision.progreso).
    causaRelacionalObservada = null,
    // circulomejora006_reporte03 — turnoId PRE-ASIGNADO por el llamador
    // cuando este turno propone una nueva HipotesisTransformacionalDestino
    // (debe coincidir exactamente con hipotesis.turnoPresentacionId, ver
    // _procesarBajoExclusividad). undefined en cualquier otro turno —
    // createTurno conserva su propio generateTurnoId() por defecto, byte-
    // idéntico al comportamiento previo a este incremento.
    turnoId,
  }) {
    // Numeración: determinada y confirmada dentro de la misma frontera
    // protegida — nunca calculada por fuera y reutilizada aquí.
    const numeroDeTurno = turnoRepo.proximoNumeroDeTurno(sesionId);

    const turno = createTurno({
      turnoId,
      sesionId,
      turnoClienteId,
      numeroDeTurno,
      gramatica: gramaticaActivaAlInicio,
      etapaCognitivaAsociada: state.etapaActual || 'idle',
      mensajeExperto: mensajeUsuario,
      mensajeCirculo: decision.mensajeCirculo,
      aportesBrutos: decision.aportesBrutos,
    });
    turnoRepo.save(turno);
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §8 — todo-o-nada con turnoRepo.save
    // de arriba: si esta transacción falla más abajo, better-sqlite3 revierte
    // ambas escrituras — la EntradaConversacional nunca queda COMPLETADA sin
    // que el Turno exista realmente. `entradaConversacionalRepo` es null en
    // callers legado (tests que no pasan por CognitiveUnitOfWork completo) —
    // nunca bloquea el turno si falta.
    if (entradaConversacionalRepo && turnoIdEntradaAdmitida) {
      entradaConversacionalRepo.marcarEstado({
        turnoId: turnoIdEntradaAdmitida, estadoProcesamiento: 'COMPLETADO',
        actualizadoEn: turno.creadoEn,
      });
    }

    const correlationId = `${gramaticaActivaAlInicio}_${turno.turnoId}`;

    // avanzaReal (Incremento 1, corrección arquitectónica): diagnóstico
    // puro — nunca gobierna cierre, nunca bloquea nada. `avance` es null
    // fuera del grafo vivo (legacy, u otros estados del protocolo).
    if (avance) {
      eventRepo.save(createEvent({
        tipo: 'turno.avance_evaluado', sesionId, turnoId: turno.turnoId, correlationId,
        payload: { gramaticaActiva: gramaticaActivaAlInicio, avanzaReal: avance.avanzaReal, razones: avance.razones },
      }));
    }

    decision.slotsActualizados.forEach(slot => {
      eventRepo.save(createEvent({
        tipo: 'slot.updated', sesionId, turnoId: turno.turnoId, correlationId,
        payload: {
          slot, anterior: state.slots[slot], nuevo: decision.nuevosSlots[slot],
          evidencia: `Turno ${numeroDeTurno} (${gramaticaActivaAlInicio})`,
        },
      }));
    });

    eventRepo.save(createEvent({
      tipo: 'slots.snapshot', sesionId, turnoId: turno.turnoId, correlationId,
      payload: {
        slots: { ...decision.nuevosSlots },
        updated: decision.slotsActualizados,
        unchanged: Object.keys(state.slots).filter(k => !decision.slotsActualizados.includes(k)),
      },
    }));

    eventRepo.save(createEvent({
      tipo: decision.avanzaReal ? 'gate.approved' : 'gate.rejected',
      sesionId, turnoId: turno.turnoId, correlationId,
      payload: {
        etapa: gramaticaActivaAlInicio,
        razon: decision.gate.razon,
        detalles: decision.gate.detalles,
      },
    }));

    eventRepo.save(createEvent({
      tipo: 'intelligence.completed', sesionId, turnoId: turno.turnoId, correlationId,
      payload: { etapa: gramaticaActivaAlInicio, result: decision.avanzaReal ? 'completed' : 'gate_failed' },
    }));

    // Bajo legacy, decision.progreso es null — nada de lo que sigue en este
    // bloque (protocolo.*, next_user_action.*, sintesis.*) tiene sentido ni
    // se ejecuta: son eventos exclusivos de V2. protocoloEstado/Ambiguos/
    // CorreccionPendiente/SintesisVigente se pasan intactos (rollback-safe:
    // legacy nunca destruye metadata V2 porque nunca la toca) — CON UNA
    // excepción estructural, no de protocolo: CognitiveState exige
    // protocoloEstado===null cuando gramaticaActiva===null (las 5 gramáticas
    // ya cerraron). Esa es una invariante del schema, no una decisión del
    // protocolo — se respeta en ambos modos, GatePolicy incluido, para que
    // la sesión terminal (tras darvida, bajo legacy) siga siendo un estado
    // válido y deserializable.
    let protocoloEstadoNuevo = decision.gramaticaSiguiente === null ? null : state.protocoloEstado;
    let protocoloIntentosAmbiguosFinal = state.protocoloIntentosAmbiguos || 0;
    let nuevaSintesisVigente = state.protocoloSintesisVigente || null;
    // Declarado aquí (no dentro del bloque de abajo) porque nuevoEstado, más
    // abajo, lo necesita incluso bajo legacy (decision.progreso === null),
    // caso en el que nunca se muta y queda igual a decision.grafoResultado.
    let grafoTrasSintesis = decision.grafoResultado;

    if (decision.progreso) {
      // ── Protocolo de cierre — autoridad real bajo V2 (Incremento 4) ───────
      // Avance real: protocoloEstado se reinicia a EXPLORANDO (o a null si
      // no queda gramática siguiente — DAR VIDA recién confirmada, estado
      // terminal) SIN IMPORTAR el detalle de protocoloEstadoSiguiente — un
      // avance real nunca deja ESPERANDO_CONFIRMACION "colgado" de la
      // gramática anterior.
      protocoloEstadoNuevo = decision.avanzaReal
        ? (decision.gramaticaSiguiente ? 'EXPLORANDO' : null)
        : decision.progreso.protocoloEstadoSiguiente;
      protocoloIntentosAmbiguosFinal = decision.avanzaReal ? 0 : decision.protocoloIntentosAmbiguosNuevo;

      eventRepo.save(createEvent({
        tipo: 'protocolo.estado_cambiado', sesionId, turnoId: turno.turnoId, correlationId,
        payload: {
          estadoAnterior: decision.protocoloEstadoActual,
          estadoNuevo: protocoloEstadoNuevo,
          gramaticaActiva: gramaticaActivaAlInicio,
          evento: decision.progreso.evento,
          avanzaReal: decision.avanzaReal, // el veredicto real bajo V2 — no una sugerencia paralela
          sintesisJuzgada: state.protocoloSintesisVigente
            ? { gramatica: state.protocoloSintesisVigente.gramatica, version: state.protocoloSintesisVigente.version, turnoOrigenId: state.protocoloSintesisVigente.turnoOrigenId }
            : null,
          // circulomejora006_act10l — solo presente cuando este turno
          // intentó una nueva propuesta relacional (objetivo dirigido
          // activo en destino+EXPLORANDO): 'CANDIDATA_DISPONIBLE' |
          // 'SIN_COBERTURA' | 'BLOQUEADA_SIN_SENAL_NUEVA' | 'ERROR_INESPERADO'
          // — causa estructurada, nunca colapsada en el evento genérico.
          causaPropuestaRelacional: causaRelacionalObservada,
          diagnosticoEstructuralTransformacional: decision.diagnosticoEstructuralTransformacional || null,
        },
      }));

      eventRepo.save(createEvent({
        tipo: 'next_user_action.resuelta', sesionId, turnoId: turno.turnoId, correlationId,
        payload: {
          tipo: decision.progreso.nextUserAction ? decision.progreso.nextUserAction.tipo : null,
          objetivo: decision.progreso.nextUserAction ? decision.progreso.nextUserAction.objetivo : null,
          texto: decision.progreso.nextUserAction ? decision.progreso.nextUserAction.texto : null,
          origen: decision.progreso.nextUserActionOrigen,
          mensajeFinal: decision.mensajeFinalProtocolo,
        },
      }));

      if (decision.progreso.nextUserActionOrigen === 'fallback' || decision.progreso.nextUserActionOrigen === 'fallback_escalado') {
        eventRepo.save(createEvent({
          tipo: 'next_user_action.fallback_aplicado', sesionId, turnoId: turno.turnoId, correlationId,
          payload: {
            tipo: decision.progreso.nextUserAction.tipo,
            objetivo: decision.progreso.nextUserAction.objetivo,
            origen: decision.progreso.nextUserActionOrigen,
            razon: decision.progreso.nextUserActionRazonFallback || null,
          },
        }));
      }

      if (decision.progreso.nextUserActionOrigen === 'fallback_escalado') {
        eventRepo.save(createEvent({
          tipo: 'protocolo.confirmacion_bloqueada', sesionId, turnoId: turno.turnoId, correlationId,
          payload: {
            gramaticaActiva: gramaticaActivaAlInicio,
            intentosAmbiguosPrevios: state.protocoloIntentosAmbiguos || 0,
          },
        }));
      }

      // Corrección expresada por el experto: se persiste como evidencia de
      // auditoría (nunca escribe slots directamente — ver nota de diseño en
      // el ADR, sección "Semántica de corrección". La única vía de
      // escritura de slots sigue siendo SlotSynthesisPolicy, más arriba en
      // esta misma transacción, sobre lo que el turno de re-síntesis
      // finalmente produzca en `entendido`).
      if ((decision.progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_CORREGIDA || decision.progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_RECHAZADA)
          && decision.protocoloCorreccionPendienteNuevo) {
        eventRepo.save(createEvent({
          tipo: 'sintesis.correccion_recibida', sesionId, turnoId: turno.turnoId, correlationId,
          payload: {
            gramaticaActiva: gramaticaActivaAlInicio,
            tipo: decision.protocoloCorreccionPendienteNuevo.tipo,
            correccionDetalle: decision.protocoloCorreccionPendienteNuevo.detalle,
            sintesisCorregidaVersion: state.protocoloSintesisVigente ? state.protocoloSintesisVigente.version : null,
            fuenteSemantica: state.protocoloSintesisVigente
              ? (state.protocoloSintesisVigente.fuenteSemantica || null)
              : null,
            // S1-DISAGREE1 — contrato común de desacuerdo, puramente
            // observacional aquí (nunca gobierna esta escritura de evento):
            // impactoCambio/ambitoCorreccion/evidenciaTextual/elementosConservados
            // vienen tal cual Capa 1 los declaró para ESTE turno — null
            // cuando no aplican (p.ej. "rechaza", o "corrige" editorial).
            // aperturaS1R indica si este mismo turno abrió la reparación
            // durable (ver reparacion_s1r.abierta, más abajo) — nunca se
            // infiere después por coincidencia de campos.
            impactoCambio: desacuerdoSemanticoEsteTurno ? desacuerdoSemanticoEsteTurno.impactoCambio : null,
            ambitoCorreccion: desacuerdoSemanticoEsteTurno ? desacuerdoSemanticoEsteTurno.ambitoCorreccion : null,
            evidenciaTextual: desacuerdoSemanticoEsteTurno ? desacuerdoSemanticoEsteTurno.evidenciaTextual : null,
            elementosConservados: desacuerdoSemanticoEsteTurno ? desacuerdoSemanticoEsteTurno.elementosConservados : null,
            aperturaS1R: !!decision.aperturaS1RPrecalculada,
          },
        }));
      }

      // ── Síntesis vigente — representación canónica versionada (Incremento 4),
      // y su concepto tipo:'sintesis_interpretativa' gobernado (Ciclo Cognitivo
      // de Descubrimiento — ADR, corrección de la brecha de síntesis: la
      // prosa que Círculo propone y pide confirmar dejó de ser un canal
      // paralelo sin procedencia, elegibilidad, reconocimiento ni rechazo —
      // ahora es, literalmente, un concepto del grafo, con el mismo ciclo de
      // vida que cualquier otro). grafoTrasSintesis parte de decision.
      // grafoResultado (lo que construcción/reconciliación ya produjeron
      // este turno) y se muta, como mucho, una vez más aquí — todavía dentro
      // de la misma transacción síncrona, sin I/O adicional. ──
      if (decision.avanzaReal) {
        // Confirmación real: si había un concepto interpretativo vigente,
        // se promueve inferido→experto (inferenciasConfirmadas — el mismo
        // mecanismo de reconocimiento que gobierna cualquier inferencia)
        // ANTES de limpiar el puntero, para no perder la promoción.
        if (nuevaSintesisVigente && nuevaSintesisVigente.conceptoInterpretativoId) {
          const { grafoNuevo } = aplicarDeltaReconciliacion(grafoTrasSintesis, {
            inferenciasConfirmadas: [{
              id: nuevaSintesisVigente.conceptoInterpretativoId,
              porQue: 'El experto confirmó la síntesis completa que representa este concepto.',
            }],
          });
          if (grafoNuevo) grafoTrasSintesis = grafoNuevo;
        }
        nuevaSintesisVigente = null; // avance real: ningún residuo del ciclo de cierre anterior
      } else if (
        decision.progreso && (
          decision.progreso.evento === PROTOCOLO_EVENTOS.SINTESIS_RECHAZADA
          // S1-DISAGREE1 — decision.aperturaS1RPrecalculada es la autoridad
          // real (nunca el evento, que para "corrige"+semántico queda
          // honestamente SINTESIS_CORREGIDA, no RECHAZADA): en cuanto S1-R
          // va a abrirse, la síntesis cuestionada necesita EXACTAMENTE el
          // mismo bloqueo (invalidación del concepto vigente, limpieza
          // inmediata de protocoloSintesisVigente) que un rechazo — de lo
          // contrario "no puede volver a materializarse" (Fase 5 de la
          // auditoría S1-C0) quedaría sin cumplir para este camino nuevo.
          || decision.aperturaS1RPrecalculada
        )
      ) {
        // Rechazo (o desacuerdo semántico relacional expresado como
        // "corrige"): el concepto interpretativo vigente (si existía) queda
        // invalidado de inmediato (inferenciasRechazadas — activo:false,
        // rechazado:true) y protocoloSintesisVigente se limpia YA, en este
        // mismo turno — nunca sobrevive para ser "editado" en el próximo
        // LISTO_PARA_SINTESIS. Sin sintesisVigente, la rama "edítalo, no lo
        // reescribas" de AgoraPrompts es estructuralmente inalcanzable: el
        // marco rechazado no puede reaparecer ni afirmado ni negado.
        if (nuevaSintesisVigente && nuevaSintesisVigente.conceptoInterpretativoId) {
          // Frontera semántica local (Ciclo Cognitivo de Descubrimiento —
          // ADR, corrección de la "amnesia regenerativa"): `porQue` deja de
          // ser un texto genérico — es la aclaración REAL del experto sobre
          // qué estaba mal, la misma que sintesisRechazadasDeGramatica va a
          // reinyectar como restricción explícita en la próxima síntesis
          // fresca (ver AgoraPrompts.buildProtocoloBloqueSintesisGrafo). Sin
          // aclaración textual (rechazo que solo trajo evidencia nueva
          // estructurada), se conserva un texto neutro — nunca se inventa
          // una razón que el experto no dio.
          const porQueRechazo = (decision.protocoloCorreccionPendienteNuevo && decision.protocoloCorreccionPendienteNuevo.detalle)
            ? decision.protocoloCorreccionPendienteNuevo.detalle
            : 'El experto rechazó la síntesis sin agregar una aclaración textual, pero aportó evidencia nueva en el mismo turno.';
          const { grafoNuevo } = aplicarDeltaReconciliacion(grafoTrasSintesis, {
            inferenciasRechazadas: [{
              id: nuevaSintesisVigente.conceptoInterpretativoId,
              porQue: porQueRechazo,
            }],
          });
          if (grafoNuevo) grafoTrasSintesis = grafoNuevo;
        }
        nuevaSintesisVigente = null;

        // S1_R_INCREMENTO_2 — apertura atómica, misma transacción que
        // Turno/Estado/Eventos de arriba: better-sqlite3 revierte todo si
        // abrirReparacionS1R lanza (identidad incoherente, Afirmación no
        // persistida, etc.) — nunca un turno que reclame el rechazo sin que
        // la reparación durable exista realmente. decision.
        // aperturaS1RPrecalculada ya trae la identidad completa,
        // reconfirmada en vivo contra el repositorio ANTES de esta
        // transacción (ver _procesarBajoExclusividad) — aquí solo se
        // persiste. abrirReparacionS1R es idempotente por identidad
        // (sesionId, afirmacionOrigenId, afirmacionOrigenVersion): un
        // retry del mismo turnoClienteId nunca llega aquí dos veces (ver
        // idempotencia de CognitiveUnitOfWork), y un turno distinto contra
        // la misma Afirmación mientras R sigue ABIERTA recupera la fila
        // existente sin sobrescribir su causa original.
        if (decision.aperturaS1RPrecalculada && afirmacionTransformacionalRepo) {
          const reparacionS1R = afirmacionTransformacionalRepo.abrirReparacionS1R({
            sesionId,
            afirmacionOrigenId: decision.aperturaS1RPrecalculada.afirmacionOrigenId,
            afirmacionOrigenVersion: decision.aperturaS1RPrecalculada.afirmacionOrigenVersion,
            presentacionOrigenId: decision.aperturaS1RPrecalculada.presentacionOrigenId,
            alcance: 'RELACION',
            correccionDetalle: decision.aperturaS1RPrecalculada.correccionDetalle,
            turnoId: turno.turnoId,
            componenteRelacional: decision.aperturaS1RPrecalculada.componenteRelacional || null,
          });
          eventRepo.save(createEvent({
            tipo: 'reparacion_s1r.abierta', sesionId, turnoId: turno.turnoId, correlationId,
            payload: {
              reparacionId: reparacionS1R.reparacionId,
              afirmacionOrigenId: reparacionS1R.afirmacionOrigenId,
              afirmacionOrigenVersion: reparacionS1R.afirmacionOrigenVersion,
              presentacionOrigenId: reparacionS1R.presentacionOrigenId,
              alcance: reparacionS1R.alcance,
              turnoId: turno.turnoId,
            },
          }));
        }
      } else if (decision.debeVersionarSintesis) {
        // Propuesta fresca o corregida: nace UN concepto nuevo — autoridad
        // SIEMPRE 'inferido' (esto lo decide este método, nunca un campo que
        // el LLM pueda declarar) — con la MISMA descripción que el texto que
        // el experto va a juzgar (decision.mensajeBase: ya incluye, si
        // corrió, el paso del Realizador — ver más arriba en este archivo).
        // Nunca dos representaciones que puedan divergir.
        const conceptoAnteriorId = (nuevaSintesisVigente && nuevaSintesisVigente.gramatica === gramaticaActivaAlInicio)
          ? nuevaSintesisVigente.conceptoInterpretativoId
          : null;
        // Ciclo Cognitivo de Descubrimiento (ADR) — continuidad monotónica
        // de versiones: `protocoloSintesisVigente` representa únicamente la
        // propuesta VIGENTE — un rechazo lo limpia a propósito (memoria
        // negativa), y derivar la siguiente versión de ahí perdía la cuenta
        // (volvía a version:1 tras cada rechazo). La secuencia real ya vive,
        // completa, en el log append-only de eventos `sintesis.propuesta`
        // por (sesionId, gramática) — nunca se borra (LEY DE MONOTONICIDAD),
        // así que no hace falta ningún contador nuevo en CognitiveState:
        // cuenta TODAS las propuestas anteriores de esta gramática en esta
        // sesión (rechazadas, superseded por corrección, o confirmadas —
        // todas fueron versiones reales mostradas al experto), calculado
        // dentro de la misma exclusividad de sesión, antes de emitir esta
        // propuesta.
        const versionAnterior = eventRepo.findBySesionAndType(sesionId, 'sintesis.propuesta')
          .filter(e => e.payload && e.payload.gramaticaActiva === gramaticaActivaAlInicio)
          .length;

        // El concepto tipo:'sintesis_interpretativa' es parte del grafo de
        // conocimiento — exclusivo de knowledgeGraphEnabled, igual que el
        // resto de la gobernanza de autoridad (elegibilidad, reconocimiento,
        // rechazo). Bajo V2 sin grafo, protocoloSintesisVigente sigue
        // funcionando exactamente igual que antes de este cambio — solo
        // como texto — porque no hay ningún grafo gobernado al que enlazarlo.
        let conceptoInterpretativoId = null;
        if (this._knowledgeGraphEnabled) {
          if (conceptoAnteriorId) {
            // "corrige": la versión anterior queda SUPERSEDIDA (marcarObsoletos
            // — nunca "rechazado": el marco no fue invalidado, solo su
            // redacción se reemplaza), preservando trazabilidad entre
            // versiones — nunca se reescribe su descripción in situ.
            const { grafoNuevo: gObsoleto } = aplicarDelta(grafoTrasSintesis, {
              marcarObsoletos: [{ id: conceptoAnteriorId, porQue: 'Reemplazada por una nueva versión de la síntesis tras corrección del experto.' }],
            });
            if (gObsoleto) grafoTrasSintesis = gObsoleto;
          }

          const { grafoNuevo: gConcepto } = aplicarDelta(grafoTrasSintesis, {
            conceptosNuevos: [{
              idTemporal: 'sintesis_interpretativa_actual',
              tipo: 'sintesis_interpretativa',
              descripcion: decision.mensajeBase,
              autoridad: 'inferido',
              procedencia: sintesisProcedencia(gramaticaActivaAlInicio),
            }],
          });
          conceptoInterpretativoId = gConcepto ? gConcepto.conceptos[gConcepto.conceptos.length - 1].id : null;
          if (gConcepto) grafoTrasSintesis = gConcepto;
        }

        nuevaSintesisVigente = Object.freeze({
          gramatica: gramaticaActivaAlInicio,
          texto: decision.mensajeBase,
          turnoOrigenId: turno.turnoId, // el propio turno recién creado — ya existe en este punto
          version: versionAnterior + 1,
          conceptoInterpretativoId,
          // S1_R_INCREMENTO_2 (corrección de fondo, ver auditoría previa) —
          // sin esto, la identidad de la Afirmación que gobernó decision.
          // mensajeBase (cuando aplica, ver sintesisDestinoAutorizadaAplica
          // en decidirInteraccion) se perdía exactamente en este turno —
          // el único punto donde protocoloSintesisVigente pasa a ser lo que
          // el experto realmente juzga en ESPERANDO_CONFIRMACION. null en
          // cualquier caso fuera de DESTINO+grafo+Afirmación AUTORIZADA
          // (legacy, otra gramática, slot-based) — contrato anterior byte a
          // byte.
          afirmacionTransformacionalId: decision.sintesisDestinoAutorizadaIdentidad
            ? decision.sintesisDestinoAutorizadaIdentidad.afirmacionTransformacionalId
            : null,
          fuenteSemantica: decision.sintesisDestinoAutorizadaIdentidad
            ? decision.sintesisDestinoAutorizadaIdentidad.fuenteSemantica
            : null,
        });
        // Auditoría (no gobernanza): qué restricciones negativas estaban
        // disponibles en el prompt que generó ESTA versión — nunca prueba
        // que el generador las respetó, solo qué historial rechazado pudo
        // haber visto. Nunca toca autoridad ni cobertura.
        const versionesRechazadasConsideradas = this._knowledgeGraphEnabled
          ? sintesisRechazadasDeGramatica(grafoTrasSintesis, gramaticaActivaAlInicio).map(c => c.id)
          : [];
        eventRepo.save(createEvent({
          tipo: 'sintesis.propuesta', sesionId, turnoId: turno.turnoId, correlationId,
          payload: {
            gramaticaActiva: gramaticaActivaAlInicio, version: nuevaSintesisVigente.version,
            texto: nuevaSintesisVigente.texto, conceptoInterpretativoId,
            fuenteSemantica: nuevaSintesisVigente.fuenteSemantica || null,
            versionesRechazadasConsideradas,
          },
        }));
      }
    }

    // circulomejora006 (Especificación §4) — limpieza de protocoloDimensionEnFoco
    // por cambio de gramática (incluye "DESTINO cierre"): mismo chequeo que
    // gramatica.avanzada, más abajo. _procesarBajoExclusividad ya resolvió
    // la limpieza por "sin dimensiones pendientes"/flag apagado — aquí se
    // agrega la única limpieza que ese método no podía conocer todavía
    // (decision.gramaticaSiguiente se resuelve recién en decidirInteraccion).
    const protocoloDimensionEnFocoNuevo = (decision.gramaticaSiguiente !== state.gramaticaActiva)
      ? null
      : (dimensionEnFocoNuevo || null);
    // circulomejora006 (corrección posterior a la prueba real) — mismo
    // criterio de limpieza que protocoloDimensionEnFoco: el historial de
    // diferimiento es exclusivo de "esta sesión de DESTINO" — al cambiar de
    // gramática, deja de tener referente y se limpia junto con el foco.
    const protocoloDimensionesInterpretacionDiferidaNuevo = (decision.gramaticaSiguiente !== state.gramaticaActiva)
      ? []
      : dimensionesInterpretacionDiferidaNuevo;
    const protocoloDimensionesInterpretacionSinGananciaNuevo = (decision.gramaticaSiguiente !== state.gramaticaActiva)
      ? {}
      : dimensionesInterpretacionSinGananciaNuevo;
    // circulomejora006_act10l — condición de éxito ATÓMICA (todo-o-nada):
    // la nueva hipótesis debe (a) haber sido creada por el productor
    // existente, (b) pasar memoria negativa, (c) registrarse
    // autoritativamente, y (d) proyectarse correctamente — las cuatro ya
    // ocurrieron, sin excepción, exactamente cuando decision.progreso.evento
    // es RELACION_TRANSFORMACIONAL_PROPUESTA Y decision.nuevaHipotesisRelacionalProyeccion
    // no es null (ver _procesarBajoExclusividad: nuevaHipotesisRelacionalProyeccion
    // solo se puebla tras evaluarEstadoRelacionTransformacionalDestino
    // devolver CANDIDATA_DISPONIBLE, y decidirProtocolo solo emite ese
    // evento cuando recibió relacionTransformacionalEstado==='CANDIDATA_DISPONIBLE',
    // el mismo valor que _procesarBajoExclusividad solo asigna en esa misma
    // rama de éxito). Si cualquiera de los cuatro pasos hubiera fallado, la
    // rama else de abajo se ejecuta — el objetivo NUNCA se limpia primero.
    const huboNuevaHipotesisRelacionalEsteTurno = !!(
      decision.progreso && decision.progreso.evento === PROTOCOLO_EVENTOS.RELACION_TRANSFORMACIONAL_PROPUESTA
      && decision.nuevaHipotesisRelacionalProyeccion
    );
    // S1_R_INCREMENTO_3 — cuando la nueva Hipótesis (huboNuevaHipotesisRelacionalEsteTurno)
    // nació con una reparación S1-R ABIERTA vinculada (reparacionS1RAbiertaParaEsteTurno,
    // resuelto por el llamador ANTES de esta transacción), en la MISMA
    // transacción: se registra durablemente cuál es la candidata sucesora
    // pendiente (recuperable tras reinicio, ver auditoría previa) y se emite
    // observabilidad causal. Nunca resuelve R, nunca instala Afirmación,
    // nunca desbloquea A — eso queda, sin excepción, fuera de este
    // incremento. Fuera de este caso exacto (arranque normal de DESTINO,
    // sin reparación), este bloque nunca se ejecuta.
    if (huboNuevaHipotesisRelacionalEsteTurno && reparacionS1RAbiertaParaEsteTurno && afirmacionTransformacionalRepo) {
      const hipotesisProyectada = decision.nuevaHipotesisRelacionalProyeccion;
      afirmacionTransformacionalRepo.registrarHipotesisSucesoraCandidata({
        sesionId, reparacionId: reparacionS1RAbiertaParaEsteTurno.reparacionId,
        hipotesisId: hipotesisProyectada.hipotesisId, hipotesisVersion: hipotesisProyectada.version,
        roles: hipotesisProyectada.roles, turnoPresentacionId: turno.turnoId,
      });
      eventRepo.save(createEvent({
        tipo: 'reparacion_s1r.hipotesis_sucesora_propuesta', sesionId, turnoId: turno.turnoId, correlationId,
        payload: {
          reparacionId: reparacionS1RAbiertaParaEsteTurno.reparacionId,
          hipotesisId: hipotesisProyectada.hipotesisId, hipotesisVersion: hipotesisProyectada.version,
          afirmacionOrigenId: reparacionS1RAbiertaParaEsteTurno.afirmacionOrigenId,
          afirmacionOrigenVersion: reparacionS1RAbiertaParaEsteTurno.afirmacionOrigenVersion,
          turnoId: turno.turnoId,
        },
      }));
    }
    // circulomejora006_act10k — mismo criterio de limpieza que
    // protocoloDimensionEnFoco: protocoloObjetivoRelacionalDirigido es
    // exclusivo de "esta sesión de DESTINO" — al cambiar de gramática deja
    // de tener referente y se limpia junto con el foco. Esta función
    // (ruta genérica de EXPLORANDO/LISTO_PARA_SINTESIS/ESPERANDO_CONFIRMACION)
    // nunca decide POR SÍ SOLA limpiarlo por ninguna otra razón — ni por
    // construir una pregunta, ni por una respuesta ambigua/fuera de tema,
    // ni por contrato inválido, ni por error del generador (ninguno de esos
    // casos llega siquiera hasta aquí sin haber pasado por este mismo
    // spread): mientras la gramática activa no cambie, el valor persistido
    // sobrevive intacto. circulomejora006_act10l cierra la única otra vía de
    // limpieza documentada en act10k como pendiente: una nueva
    // HipotesisTransformacionalDestino legítimamente distinta que reemplaza
    // la proposición rechazada.
    const protocoloObjetivoRelacionalDirigidoNuevo = (decision.gramaticaSiguiente !== state.gramaticaActiva)
      ? null
      : (huboNuevaHipotesisRelacionalEsteTurno ? null : (state.protocoloObjetivoRelacionalDirigido || null));
    // circulomejora006_act10l — proyección plana (nunca la entidad
    // autoritativa) en CognitiveState, disponible para el lookup del
    // siguiente turno (ValidacionRelacionTransformacionalDestinoCasoDeUso,
    // ya existente, sin cambios). Se conserva la anterior salvo que este
    // turno haya reemplazado la referencia con una nueva legítima.
    const protocoloHipotesisTransformacionalPendienteNuevo = huboNuevaHipotesisRelacionalEsteTurno
      ? decision.nuevaHipotesisRelacionalProyeccion
      : state.protocoloHipotesisTransformacionalPendiente;
    const reparacionesTrasInteraccion = aplicarComandosReparacion({
      secuenciaActual: state.protocoloSecuenciaReparacionInterpretativa,
      reparacionesActuales: state.protocoloReparacionesInterpretativasPendientes,
      comandos: comandosResolucionReparacion,
    });
    const reparacionesConfirmadas = proyectarReparacionesPendientes(
      reparacionesTrasInteraccion.reparacionesResultantes,
    );
    if (JSON.stringify(reparacionesConfirmadas) !== JSON.stringify(reparacionesInterpretativasPostTurno)) {
      throw new Error('La proyección postturno de reparaciones no coincide con el comando confirmado.');
    }

    // FRONTERA_INTERVENCION_VISIBLE_1 (corrección focal — RECHAZO_NO_
    // PROPAGADO) — traza puramente observacional (nunca gobierna nada por sí
    // sola, ver docstring del campo en CognitiveState.js): si ESTE turno
    // propuso una conexión ANCLADA nueva, la reemplaza; si no, conserva la
    // anterior sin cambios. Las dimensiones se resuelven contra
    // grafoTrasSintesis (nunca contra el id crudo, que por sí solo no dice
    // a qué dimensión pertenece cada anclaje) -- si por algún motivo alguno
    // de los dos ids ya no resuelve a un concepto real, se conserva el
    // valor anterior en vez de persistir una referencia rota.
    const conexionConectadaEsteTurno = comprensionConversacional && comprensionConversacional.conexionConectada;
    const protocoloUltimaConexionConectadaPropuestaNuevo = conexionConectadaEsteTurno
      ? (() => {
          const conceptoA = (grafoTrasSintesis.conceptos || []).find(c => c.id === conexionConectadaEsteTurno.anclajeAId);
          const conceptoB = (grafoTrasSintesis.conceptos || []).find(c => c.id === conexionConectadaEsteTurno.anclajeBId);
          if (!conceptoA || !conceptoB) return state.protocoloUltimaConexionConectadaPropuesta || null;
          return {
            anclajeAId: conexionConectadaEsteTurno.anclajeAId,
            anclajeBId: conexionConectadaEsteTurno.anclajeBId,
            dimensionA: dimensionDeProcedencia(conceptoA.procedencia),
            dimensionB: dimensionDeProcedencia(conceptoB.procedencia),
            operacionRelacional: conexionConectadaEsteTurno.operacionRelacional,
          };
        })()
      : (state.protocoloUltimaConexionConectadaPropuesta || null);

    const nuevoEstado = {
      ...state,
      slots: decision.nuevosSlots,
      knowledgeGraph: grafoTrasSintesis,
      gramaticaActiva: decision.gramaticaSiguiente,
      gramaticasCompletadas: decision.gramaticasCompletadasNuevas,
      status: decision.statusNuevo,
      protocoloEstado: protocoloEstadoNuevo,
      protocoloIntentosAmbiguos: protocoloIntentosAmbiguosFinal,
      protocoloCorreccionPendiente: decision.progreso ? decision.protocoloCorreccionPendienteNuevo : state.protocoloCorreccionPendiente,
      protocoloSintesisVigente: nuevaSintesisVigente,
      // MISSION_CLOSURE_ACCEPTANCE_CONTRACT_SEPARATION -- freeze/carry the
      // confirmation subject while a grammar waits in ESPERANDO_CONFIRMACION;
      // clear it on any advance or on leaving the waiting state.
      protocoloConfirmacionSujeto: decision.avanzaReal
        ? null
        : (protocoloEstadoNuevo === 'ESPERANDO_CONFIRMACION'
          ? ((decision.progreso ? decision.confirmationSubject : state.protocoloConfirmacionSujeto) || null)
          : null),
      protocoloDimensionEnFoco: protocoloDimensionEnFocoNuevo,
      protocoloDimensionesInterpretacionDiferida: protocoloDimensionesInterpretacionDiferidaNuevo,
      protocoloDimensionesInterpretacionSinGanancia: protocoloDimensionesInterpretacionSinGananciaNuevo,
      protocoloObjetivoRelacionalDirigido: protocoloObjetivoRelacionalDirigidoNuevo,
      protocoloHipotesisTransformacionalPendiente: protocoloHipotesisTransformacionalPendienteNuevo,
      protocoloComposicionTransformacionalPendiente,
      protocoloSecuenciaReparacionInterpretativa: reparacionesTrasInteraccion.secuenciaResultante,
      protocoloReparacionesInterpretativasPendientes: reparacionesTrasInteraccion.reparacionesResultantes,
      obligacionCognitivaActivaId: (() => {
        const reparacionesS1RPost = afirmacionTransformacionalRepo
          && typeof afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion === 'function'
          ? afirmacionTransformacionalRepo.findReparacionesAbiertasPorSesion(sesionId) : [];
        const abiertasPost = proyectarObligacionesAbiertasDestino({
          reparacionesInterpretativasPendientes: proyectarReparacionesPendientes(
            reparacionesTrasInteraccion.reparacionesResultantes,
          ),
          reparacionesS1RAbiertas: reparacionesS1RPost,
        }).filter(o => o.clase === 'REPARACION');
        const nuevas = [
          ...(reparacionesTrasInteraccion.aperturasAplicadas || []).map(a => a.obligacionId),
          ...reparacionesS1RPost
            .filter(r => r.abiertaEnTurnoId === turno.turnoId)
            .map(r => `s1r:${r.reparacionId}`),
        ];
        const nuevasUnicas = [...new Set(nuevas)];
        if (nuevasUnicas.length === 1 && abiertasPost.some(o => o.obligacionId === nuevasUnicas[0])) return nuevasUnicas[0];
        if (nuevasUnicas.length > 1) return null;
        const activaSolicitada = obligacionCognitivaActivaId || state.obligacionCognitivaActivaId || null;
        if (activaSolicitada && abiertasPost.some(o => o.obligacionId === activaSolicitada)) return activaSolicitada;
        if (abiertasPost.length === 1) return abiertasPost[0].obligacionId;
        return null;
      })(),
      protocoloUltimaConexionConectadaPropuesta: protocoloUltimaConexionConectadaPropuestaNuevo,
      actualizadoEn: new Date().toISOString(),
    };

    // REFERENCIA_DIRECTA_TURNO_VERSION — el cómputo de la versión (puramente
    // en memoria: createVersion no toca SQLite, ver Version.js) se adelanta
    // aquí, ANTES de los eventos de este turno, para que cualquier evento
    // emitido más abajo (en particular comprension_conversacional.turno)
    // pueda referenciar la versión que ESTE turno produce — nunca la
    // heredada de state. stateRepo.save() sigue exactamente donde estaba:
    // ningún INSERT SQL cambia de orden, solo el momento en que la variable
    // en memoria queda calculada dentro de la misma transacción.
    const versionAnterior = state.versionId;
    const version = createVersion({
      sesionId, motivacion: `Turno ${numeroDeTurno} — ${gramaticaActivaAlInicio}`, estadoPrevioId: versionAnterior,
    });
    nuevoEstado.versionId = version.id;
    nuevoEstado.versionPreviaId = versionAnterior;

    // P1-B (circulomejora006 — autoridad de objetivo conversacional ante
    // cierre) — ciclo de vida de la intención de cierre, calculado sobre
    // state (antes) vs nuevoEstado (después) YA FINALIZADOS arriba. Un
    // hito formal es un HECHO de estado, nunca prosa: salir de EXPLORANDO,
    // o una Hipótesis CANDIDATA genuinamente NUEVA este turno (id distinto
    // de la que ya existía antes) — nunca "se formuló otra pregunta" ni
    // "se pidió un veredicto" (contrato P1-B, Fase 5). Solo se evalúa
    // cuando el selector de DESTINO gobernó este turno (objetivoConversacional
    // no-null) — en cualquier otro caso, protocoloIntencionCierre viaja
    // sin cambios (ya heredado por el spread `...state` de nuevoEstado).
    if (objetivoConversacional) {
      let causaHito = null;
      if (nuevoEstado.protocoloEstado !== 'EXPLORANDO' && state.protocoloEstado === 'EXPLORANDO') {
        causaHito = `SALIO_DE_EXPLORANDO_A_${nuevoEstado.protocoloEstado}`;
      } else if (
        nuevoEstado.protocoloHipotesisTransformacionalPendiente
        && nuevoEstado.protocoloHipotesisTransformacionalPendiente.estado === 'CANDIDATA'
        && (!state.protocoloHipotesisTransformacionalPendiente
            || state.protocoloHipotesisTransformacionalPendiente.hipotesisId
               !== nuevoEstado.protocoloHipotesisTransformacionalPendiente.hipotesisId)
      ) {
        causaHito = 'HIPOTESIS_CANDIDATA_MOSTRADA';
      }
      nuevoEstado.protocoloIntencionCierre = avanzarIntencionCierre({
        intencionAntes: state.protocoloIntencionCierre || null,
        cierreSolicitadoEsteTurno: senalCierreConversacional ? senalCierreConversacional.aceptadas.length > 0 : false,
        tiposSenalEsteTurno: senalCierreConversacional ? senalCierreConversacional.aceptadas.map(s => s.tipo) : [],
        objetivoDecidido: objetivoConversacional.objetivo,
        hitoAlcanzadoEsteTurno: causaHito,
        // P1-B2 — misma identidad causal ya calculada por
        // ObjetivoConversacionalPolicy.decidirObjetivoConversacional, nunca
        // recalculada aquí.
        deudaPrioritaria: objetivoConversacional.deudaPrioritaria,
        turnoId: turno.turnoId,
        // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final) — mismos
        // valores que decidieron el mensaje visible de este turno (ver
        // _procesarBajoExclusividad); avanzarIntencionCierre los usa para
        // abrir/reevaluar el ciclo de pregunta final consolidada, nunca
        // para inventar uno nuevo aquí.
        deudasFinalesSnapshotCandidato: deudasFinalesSnapshotCandidatoEsteTurno,
        dimensionesConEvidenciaEsteTurno: dimensionesConEvidenciaPostTurnoEsteTurno,
      });
      // Se traza aquí (no como variable de función) porque el evento
      // objetivo_conversacional.turno, más abajo, es el único lector.
      objetivoConversacional.causaHito = causaHito;
      objetivoConversacional.estadoIntencionCierreAntes = state.protocoloIntencionCierre ? state.protocoloIntencionCierre.estado : null;
      objetivoConversacional.estadoIntencionCierreDespues = nuevoEstado.protocoloIntencionCierre ? nuevoEstado.protocoloIntencionCierre.estado : null;
    }

    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final —
    // CITA_LITERAL_ESPECIFICA_NO_EQUIVALE_A_CORRECCION_DEL_CONCEPTO) —
    // persiste los veredictos NUEVOS de este turno como autoridad durable
    // reutilizable, mergeados (nunca reemplazados) con los ya persistidos
    // — la MISMA identidad nunca se duplica ni se re-adjudica.
    if (Array.isArray(autoridadesMutacionNuevasEsteTurno) && autoridadesMutacionNuevasEsteTurno.length > 0) {
      const previas = Array.isArray(state.protocoloAutoridadesMutacionValidadas)
        ? state.protocoloAutoridadesMutacionValidadas : [];
      const identidadesPrevias = new Set(previas.map(v => v.identidad));
      const nuevasSinDuplicar = autoridadesMutacionNuevasEsteTurno.filter(v => !identidadesPrevias.has(v.identidad));
      nuevoEstado.protocoloAutoridadesMutacionValidadas = previas.concat(nuevasSinDuplicar);
    }

    // No emitir gramatica.avanzada / sesion.status.cambiado si el valor no cambió realmente.
    if (nuevoEstado.gramaticaActiva !== state.gramaticaActiva) {
      eventRepo.save(createEvent({
        tipo: 'gramatica.avanzada', sesionId, turnoId: turno.turnoId, correlationId,
        payload: { anterior: state.gramaticaActiva, nueva: nuevoEstado.gramaticaActiva },
      }));
    }
    if (nuevoEstado.status !== state.status) {
      eventRepo.save(createEvent({
        tipo: 'sesion.status.cambiado', sesionId, turnoId: turno.turnoId, correlationId,
        payload: { anterior: state.status, nueva: nuevoEstado.status },
      }));
    }

    // circulomejora006 (Especificación, correcciones finales §1/§3/§4/§5) —
    // un único evento de observabilidad por turno gobernado por el selector
    // de DESTINO. Ausente por completo (nunca emitido) en cualquier otro
    // caso — flag apagado, otra gramática, otro protocoloEstado.
    if (comprensionConversacional) {
      eventRepo.save(createEvent({
        tipo: 'comprension_conversacional.turno', sesionId, turnoId: turno.turnoId, correlationId,
        // REFERENCIA_DIRECTA_TURNO_VERSION — versionId ya calculado arriba
        // (la versión que ESTE turno produce, nunca la heredada): permite a
        // un lector futuro correlacionar turno↔versión sin inferencia
        // ordinal (descartada: la reconciliación histórica puede crear
        // versiones sin turno, rompiendo cualquier correspondencia por
        // posición — ver auditoría del incremento).
        versionId: nuevoEstado.versionId,
        payload: {
          movimientoDecidido: comprensionConversacional.movimientoDecidido
            ? {
                movimiento: comprensionConversacional.movimientoDecidido.movimiento,
                codigoRazon: comprensionConversacional.movimientoDecidido.codigoRazon,
                dimensionObjetivo: comprensionConversacional.movimientoDecidido.dimensionObjetivo,
                nivelLenguaje: comprensionConversacional.movimientoDecidido.nivelLenguaje,
                obligacionId: comprensionConversacional.movimientoDecidido.obligacionId,
                intentoInterpretacionId: comprensionConversacional.movimientoDecidido.intentoInterpretacionId,
                criterioSatisfaccion: comprensionConversacional.movimientoDecidido.criterioSatisfaccion || null,
              }
            : null,
          // Solo el contrato cuya estrategia produjo una salida visible
          // validada puede originar contexto causal para N+1. Una decisión
          // no ejecutada no fue presentada al usuario.
          contratoIntervencion: proyectarContratoIntervencionPresentada({
            contrato: comprensionConversacional.contratoIntervencion,
            movimientoEjecutado: comprensionConversacional.movimientoEjecutado,
            salidaVisibleSegura: comprensionConversacional.salidaVisibleSegura,
          }),
          movimientoEjecutado: comprensionConversacional.movimientoEjecutado,
          movimientoNoEjecutadoRazon: comprensionConversacional.movimientoNoEjecutadoRazon,
          estrategiaSeleccionada: comprensionConversacional.estrategiaSeleccionada,
          estrategiaEfectiva: comprensionConversacional.estrategiaEfectiva,
          realizadorFallo: comprensionConversacional.realizadorFallo,
          fallbackMovimientoAplicado: comprensionConversacional.fallbackMovimientoAplicado,
          contratoConectadoDegradado: comprensionConversacional.contratoConectadoDegradado,
          conexionConectada: comprensionConversacional.conexionConectada,
          salidaVisibleSegura: comprensionConversacional.salidaVisibleSegura,
          compatibilidadMovimientoEstrategia: comprensionConversacional.compatibilidadMovimientoEstrategia,
          dimensionEnFoco: protocoloDimensionEnFocoNuevo,
          estadoImposible: comprensionConversacional.estadoImposible,
          observacionNaturaleza: comprensionConversacional.observacionNaturaleza,
          huboRechazoEsteTurno: comprensionConversacional.huboRechazoEsteTurno,
          dimensionesRechazadasEsteTurno: comprensionConversacional.dimensionesRechazadasEsteTurno,
          huboRechazoVisibleEsteTurno: comprensionConversacional.huboRechazoVisibleEsteTurno,
          dimensionesRechazadasVisiblesEsteTurno: comprensionConversacional.dimensionesRechazadasVisiblesEsteTurno,
          huboObsolescenciaEsteTurno: comprensionConversacional.huboObsolescenciaEsteTurno,
          atribucionSinJustificar: comprensionConversacional.atribucionSinJustificar,
          contratoRespuestaDirigida: comprensionConversacional.contratoRespuestaDirigida,
          relacionRespuestaDirigida: comprensionConversacional.relacionRespuestaDirigida,
          alineacionRespuestaDirigida: comprensionConversacional.alineacionRespuestaDirigida,
          // SATISFIED_PREVIOUS_ACT != ACTIVE_PREVIOUS_ACT -- explicit
          // persisted allowlist, same discipline as every other field here
          // (a bare spread would silently drop this like everything else
          // not already listed). Read back by a LATER turn's own
          // reconstruction of contratoPresentadoAnterior, above.
          respuestaDirigidaConsumidaPorAceptacion: comprensionConversacional.respuestaDirigidaConsumidaPorAceptacion,
          evaluacionInterpretacion: comprensionConversacional.evaluacionInterpretacion,
          dimensionInterpretacionDiferida: comprensionConversacional.dimensionInterpretacionDiferida,
          razonInterpretacionDiferida: comprensionConversacional.razonInterpretacionDiferida,
          turnoInterpretacionDiferida: comprensionConversacional.turnoInterpretacionDiferida,
          // circulomejora006 (evaluacionInterpretacion, corrección de
          // carrera — auditoría aprobada) — tres hechos de ESTE turno, sin
          // colapsar: preparado (antes de Capa 1), decidido crudo (después
          // de construcción, sin corregir), y movimientoDecidido de arriba
          // (la única "realmente autorizada"). movimientoDecididoCrudo se
          // reduce a los mismos 4 campos que movimientoDecidido, arriba —
          // mismo shape, para que ambos sean directamente comparables.
          movimientoPreparado: comprensionConversacional.movimientoPreparado,
          movimientoDecididoCrudo: comprensionConversacional.movimientoDecididoCrudo
            ? {
                movimiento: comprensionConversacional.movimientoDecididoCrudo.movimiento,
                codigoRazon: comprensionConversacional.movimientoDecididoCrudo.codigoRazon,
                dimensionObjetivo: comprensionConversacional.movimientoDecididoCrudo.dimensionObjetivo,
                nivelLenguaje: comprensionConversacional.movimientoDecididoCrudo.nivelLenguaje,
                obligacionId: comprensionConversacional.movimientoDecididoCrudo.obligacionId,
                intentoInterpretacionId: comprensionConversacional.movimientoDecididoCrudo.intentoInterpretacionId,
              }
            : null,
          movimientoNoAccionableRazon: comprensionConversacional.movimientoNoAccionableRazon,
        },
      }));
    }

    // P1-A (circulomejora006 — autoridad de cierre conversacional, primer
    // incremento) — evento HERMANO de 'comprension_conversacional.turno'
    // (arriba), nunca fusionado con él: contratos deliberadamente
    // separados (ver auditoría P1-D y SenalCierreConversacionalPolicy).
    // Misma transacción, mismo turno — un retry del mismo turnoClienteId
    // nunca vuelve a llegar aquí (ver _procesarBajoExclusividad, paso 4:
    // idempotencia resuelta ANTES de abrir la transacción), así que este
    // evento hereda la misma garantía de no-duplicación sin lógica propia.
    // Puramente observacional: no altera nuevoEstado, no toca el grafo, no
    // gobierna Movimiento ni Progreso.
    if (senalCierreConversacional) {
      eventRepo.save(createEvent({
        tipo: 'senal_cierre_conversacional.turno', sesionId, turnoId: turno.turnoId, correlationId,
        versionId: nuevoEstado.versionId,
        payload: {
          senalesAceptadas: senalCierreConversacional.aceptadas,
          senalesDescartadas: senalCierreConversacional.descartadas,
        },
      }));
    }

    // P1-B (circulomejora006 — autoridad de objetivo conversacional ante
    // cierre) — evento HERMANO de 'senal_cierre_conversacional.turno' y
    // 'comprension_conversacional.turno' (arriba), nunca fusionado con
    // ninguno: registra la DECISIÓN de gobernanza (qué debía intentar
    // conseguir este turno, y si el movimiento efectivo la obedeció),
    // separada de la observación cruda de la señal y de la traza de
    // comprensión de Capa 1. Puramente observacional — no vuelve a tocar
    // nuevoEstado, el grafo, Movimiento ni Progreso desde aquí.
    if (objetivoConversacional) {
      eventRepo.save(createEvent({
        tipo: 'objetivo_conversacional.turno', sesionId, turnoId: turno.turnoId, correlationId,
        versionId: nuevoEstado.versionId,
        payload: {
          objetivo: objetivoConversacional.objetivo,
          razon: objetivoConversacional.razon,
          origen: objetivoConversacional.origen,
          deudaPrioritaria: objetivoConversacional.deudaPrioritaria,
          hitoEsperado: objetivoConversacional.hitoEsperado,
          movimientoDecidido: (comprensionConversacional && comprensionConversacional.movimientoDecidido)
            ? comprensionConversacional.movimientoDecidido.movimiento : null,
          movimientoObedecioObjetivo: objetivoConversacional.movimientoObedecioObjetivo,
          causaHito: objetivoConversacional.causaHito,
          estadoIntencionCierreAntes: objetivoConversacional.estadoIntencionCierreAntes,
          estadoIntencionCierreDespues: objetivoConversacional.estadoIntencionCierreDespues,
        },
      }));
    }

    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (corrección final —
    // AMBITO_DE_CIERRE_GOBIERNA_PRODUCTORES_PERO_NO_LA_FRONTERA_COMUN_DE_MUTACION,
    // requisito 5) — traza durable de cada mutación destructiva rechazada
    // por validarMutacionesDestructivasBajoCierre, sea cual sea el
    // productor (origen: CONSTRUCCION | RECONCILIACION_HISTORICA) — nunca
    // se descarta en silencio. Puramente observacional, igual que el
    // evento de arriba.
    if (mutacionesLateralesRechazadasTraza && mutacionesLateralesRechazadasTraza.length > 0) {
      eventRepo.save(createEvent({
        tipo: 'mutacion_destructiva_rechazada.turno', sesionId, turnoId: turno.turnoId, correlationId,
        versionId: nuevoEstado.versionId,
        payload: { mutaciones: mutacionesLateralesRechazadasTraza },
      }));
    }

    // DESTINO_RECONOCIMIENTO_DE_CIERRE_1 (ronda final —
    // CITA_LITERAL_ESPECIFICA_NO_EQUIVALE_A_CORRECCION_DEL_CONCEPTO) — traza
    // durable de cada NUEVA adjudicación de ValidadorSemanticoMutacionConcepto
    // este turno (VALIDADA, NO_VALIDADA o INCONCLUSA — las tres, nunca solo
    // los rechazos: la autoridad de una corrección ACEPTADA también debe
    // quedar trazada). Nunca reemite un veredicto ya persistido en turnos
    // anteriores (autoridadesMutacionNuevasEsteTurno ya viene filtrado a
    // solo lo nuevo de este turno). Puramente observacional.
    if (Array.isArray(autoridadesMutacionNuevasEsteTurno) && autoridadesMutacionNuevasEsteTurno.length > 0) {
      eventRepo.save(createEvent({
        tipo: 'validacion_semantica_mutacion.turno', sesionId, turnoId: turno.turnoId, correlationId,
        versionId: nuevoEstado.versionId,
        payload: { validaciones: autoridadesMutacionNuevasEsteTurno },
      }));
    }

    // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — traza durable de cada
    // GOBERNANZA_DELTA_DIMENSIONAL de este turno (concordante, adjudicada,
    // no resuelta, o descartada por identidad) — nunca solo los casos
    // divergentes: el camino concordante también queda trazado (autoridad
    // utilizada explícita). Puramente observacional.
    if (Array.isArray(gobernanzaDimensionTrazaEsteTurno) && gobernanzaDimensionTrazaEsteTurno.length > 0) {
      eventRepo.save(createEvent({
        tipo: 'gobernanza_dimension_concepto.turno', sesionId, turnoId: turno.turnoId, correlationId,
        versionId: nuevoEstado.versionId,
        payload: { gobernanzas: gobernanzaDimensionTrazaEsteTurno },
      }));
    }

    // Incremento 7d (corrección post-revisión): decisión — nunca ejecución —
    // de solicitar el pipeline downstream. Atómica con la aprobación del
    // Gate de DAR VIDA porque ocurre aquí, dentro de la misma transacción:
    // si algo más abajo hace rollback, ni "pipelineStatus: pending" ni la
    // fila del outbox quedan persistidos a medias.
    //
    // outboxRepo.registrar() (misma conexión, misma transacción) es el
    // mecanismo DURABLE — sobrevive a que el proceso caiga justo después de
    // este commit y antes de que se invoque cualquier ejecutor, porque un
    // dispatcher posterior (inmediato o de recuperación, en este proceso o
    // en otro) puede reclamarlo directamente desde SQL. turno.turnoId es la
    // clave idempotente estable de la sesión: sesion_id es PK en el outbox,
    // así que nunca existen dos solicitudes lógicas para la misma conversación.
    const pipelineSolicitado = debeSolicitarDownstream({
      gramaticaActivaAlInicio,
      gateAprobado: decision.avanzaReal,
      gramaticaSiguiente: decision.gramaticaSiguiente,
      pipelineStatusActual: state.pipelineStatus,
    });
    if (pipelineSolicitado) {
      nuevoEstado.pipelineStatus = 'pending';
      outboxRepo.registrar({ sesionId, turnoId: turno.turnoId });
      eventRepo.save(createEvent({
        tipo: 'downstream.requested', sesionId, turnoId: turno.turnoId, correlationId,
        payload: { motivo: 'darvida_confirmada', turnoId: turno.turnoId },
      }));
    }

    // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera positiva, Path
    // B) — ver resolverAsignacionPositivaAbierta arriba. Cuando el experto
    // declara la exclusión y el reemplazo en turnos SEPARADOS (corrige+
    // concepto sin reemplazo_declarado, luego evidencia normal de
    // EXPLORANDO más adelante), este es el turno EXPLORANDO/construcción
    // que puede resolverla — nunca el de VALIDANDO_RELACION_TRANSFORMACIONAL
    // (ese ya se resuelve arriba, Path A, dentro de
    // _procesarValidacionRelacionTransformacionalDestino). idsAntesDeEsteTurno
    // se recalcula FRESCO contra `state` (el grafo tal como entró a ESTE
    // turno) — la comparación usa la fotografía inmutable capturada antes
    // de cualquier reconciliación/construcción; el grafo pudo ganar, después,
    // el nodo de síntesis y otras cascadas. Sin
    // ninguna corrección abierta (el caso general), este bloque no tiene
    // ningún efecto observable.
    if ((nuevoEstado.protocoloExclusionesHipotesisPorRol || []).length > 0) {
      const conceptosNuevosParaAsignacionPositiva = (nuevoEstado.knowledgeGraph.conceptos || [])
        .filter(c => !idsConceptosAlInicioTurno.has(c.id));
      nuevoEstado.protocoloExclusionesHipotesisPorRol = resolverAsignacionPositivaAbierta(
        nuevoEstado.protocoloExclusionesHipotesisPorRol, conceptosNuevosParaAsignacionPositiva,
      );
    }

    // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera causal —
    // SUFICIENCIA_GLOBAL_IGNORA_EL_AMBITO_DE_LA_CORRECCION_DE_HIPOTESIS) —
    // una vez que ESTE turno propuso una nueva Hipótesis
    // (huboNuevaHipotesisRelacionalEsteTurno) que efectivamente usa, en el
    // rol correspondiente, el concepto positivo de una corrección ya
    // REEMPLAZO_MATERIALIZADO, se registra durablemente cuál es su
    // sucesora (hipotesisSucesoraId) — la ÚNICA señal que "suficiencia
    // acotada" (ver ámbitoDeCorreccionParaSuficiencia, arriba en
    // decidirInteraccion/este mismo método) consulta para dejar de aplicar
    // su ámbito reducido en turnos futuros: en cuanto la corrección ya
    // produjo su sucesora, el resto de la sesión vuelve a la suficiencia
    // global normal, sin excepción — ninguna oportunidad ajena queda
    // suprimida más allá del turno que de verdad la necesitaba. Nunca
    // sobreescribe una vinculación ya existente.
    if (huboNuevaHipotesisRelacionalEsteTurno && (nuevoEstado.protocoloExclusionesHipotesisPorRol || []).length > 0) {
      const rolesDeLaNuevaHipotesis = decision.nuevaHipotesisRelacionalProyeccion.roles || {};
      nuevoEstado.protocoloExclusionesHipotesisPorRol = nuevoEstado.protocoloExclusionesHipotesisPorRol.map(e => {
        if (e.hipotesisSucesoraId !== null) return e;
        const idsDelRolEnNuevaHipotesis = rolesDeLaNuevaHipotesis[e.campoRol] || [];
        const usaElPositivo = (e.conceptosPositivosIds || []).some(id => idsDelRolEnNuevaHipotesis.includes(id));
        return usaElPositivo
          ? { ...e, hipotesisSucesoraId: decision.nuevaHipotesisRelacionalProyeccion.hipotesisId }
          : e;
      });
    }

    // COMPATIBILIDAD_HISTORICA (REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS)
    // — si este turno recuperó, contra emisionesLegitimas, el snapshot de
    // rolesOriginales de una entrada persistida ANTES de que ese campo
    // existiera (ver rolesOriginalesRecuperadosParaPersistir, arriba), se
    // aplica AQUÍ, dentro de la misma transacción — desde el siguiente
    // guardado, esa entrada ya no depende de emisionesLegitimas (que no
    // sobrevive un reinicio): queda durable, exactamente igual que si
    // hubiera tenido rolesOriginales desde el principio. Idempotente —
    // nunca sobreescribe una entrada que ya tenía roles reales.
    if (rolesOriginalesRecuperadosParaPersistir && (nuevoEstado.protocoloExclusionesHipotesisPorRol || []).length > 0) {
      nuevoEstado.protocoloExclusionesHipotesisPorRol = nuevoEstado.protocoloExclusionesHipotesisPorRol.map(e => {
        const recuperados = rolesOriginalesRecuperadosParaPersistir.get(e.turnoCorreccionId);
        return recuperados ? { ...e, rolesOriginales: recuperados } : e;
      });
    }

    // Versionado + persistencia del estado canónico. El cómputo de `version`
    // ya ocurrió más arriba (ver REFERENCIA_DIRECTA_TURNO_VERSION) — aquí
    // solo se persiste. createVersion exige un 'motivacion' no vacío por
    // contrato, pero — auditoría de dominio — ese texto no se persiste en
    // ningún lado: no emitimos 'state.committed' (evaluado y descartado: no
    // aporta semántica nueva al Event Log; la cadena de versiones ya vive en
    // state_versions vía versionId/versionPreviaId, y el "porqué" del commit
    // ya lo explican el Turno y los eventos cognitivos de esta misma
    // transacción). El string existe solo para satisfacer la validación de
    // createVersion.
    stateRepo.save(sesionId, serializeState(nuevoEstado));

    return {
      turno,
      state: nuevoEstado,
      mensaje: decision.mensajeCirculo,
      entendido: decision.aportesBrutos,
      // completed (vía gramaticaCompletada, leído por CognitivoApiServer):
      // se deriva exclusivamente de decision.avanzaReal — GatePolicy bajo
      // legacy, la transición real AVANZAR bajo V2. Una sola fuente, sin
      // importar el modo.
      gramaticaCompletada: decision.avanzaReal,
      pipelineSolicitado,
      avanzoDeGramatica: nuevoEstado.gramaticaActiva !== state.gramaticaActiva,
      // null bajo legacy (decision.progreso no existe en ese modo — no hay
      // nada que exponer). Bajo V2, avanzaReal AQUÍ es el veredicto real,
      // no una sugerencia paralela para comparar contra otra autoridad.
      protocolo: decision.progreso ? {
        estadoAnterior: decision.protocoloEstadoActual,
        estadoNuevo: protocoloEstadoNuevo,
        evento: decision.progreso.evento,
        avanzaReal: decision.avanzaReal,
        nextUserAction: decision.progreso.nextUserAction,
        nextUserActionOrigen: decision.progreso.nextUserActionOrigen,
        mensajeFinal: decision.mensajeFinalProtocolo,
        intentosAmbiguos: protocoloIntentosAmbiguosFinal,
        sintesisVigente: nuevaSintesisVigente,
      } : null,
    };
  }

  /**
   * Reconstruye el resultado de un Turno YA persistido, sin volver a llamar
   * al LLM y sin leer el estado ACTUAL de la sesión (que pudo haber
   * avanzado desde entonces) — se apoya únicamente en el propio Turno y en
   * los eventos que quedaron vinculados a él en su transacción original.
   */
  _reconstruirResultadoIdempotente(sesionId, turno) {
    const eventosDelTurno = this._unitOfWork.eventRepo.findByTurnoId(sesionId, turno.turnoId);
    const gateEvento   = eventosDelTurno.find(e => e.tipo === 'gate.approved' || e.tipo === 'gate.rejected');
    const avanceEvento = eventosDelTurno.find(e => e.tipo === 'gramatica.avanzada');
    // Solo lectura del rastro ya persistido — NUNCA vuelve a invocar al
    // dispatcher: por eso repetir el mismo turnoClienteId no puede duplicar
    // la solicitud (este método se llama antes de que exista ninguna
    // oportunidad de volver a decidir o ejecutar nada).
    const pipelineEvento = eventosDelTurno.find(e => e.tipo === 'downstream.requested');
    const gateAprobado = gateEvento ? gateEvento.tipo === 'gate.approved' : false;

    // Mismo principio para el protocolo: se lee de vuelta lo que ya quedó
    // persistido en la transacción original, nunca se vuelve a calcular —
    // así un reintento nunca puede producir una segunda transición ni una
    // segunda next_user_action distinta de la primera.
    const protocoloEvento = eventosDelTurno.find(e => e.tipo === 'protocolo.estado_cambiado');
    const nextUserActionEvento = eventosDelTurno.find(e => e.tipo === 'next_user_action.resuelta');

    return {
      ok: true, httpStatus: 200, idempotente: true,
      turno,
      mensaje: turno.mensajeCirculo,
      entendido: turno.aportesBrutos,
      gramaticaCompletada: gateAprobado,
      pipelineSolicitado: !!pipelineEvento,
      avanzoDeGramatica: !!avanceEvento,
      protocolo: protocoloEvento ? {
        estadoAnterior: protocoloEvento.payload.estadoAnterior,
        estadoNuevo: protocoloEvento.payload.estadoNuevo,
        evento: protocoloEvento.payload.evento,
        avanzaReal: protocoloEvento.payload.avanzaReal,
        nextUserAction: nextUserActionEvento && nextUserActionEvento.payload.tipo ? {
          tipo: nextUserActionEvento.payload.tipo,
          objetivo: nextUserActionEvento.payload.objetivo,
          texto: nextUserActionEvento.payload.texto,
        } : null,
        nextUserActionOrigen: nextUserActionEvento ? nextUserActionEvento.payload.origen : null,
        mensajeFinal: nextUserActionEvento ? nextUserActionEvento.payload.mensajeFinal : null,
      } : null,
    };
  }
}

module.exports = {
  InteraccionCognitivaWriter, decidirInteraccion,
  canonicalizarMapaReferenciasTurno,
  normalizarOportunidadesConversacionales,
  proposicionGobernadaDeOportunidad,
  debeRepararCandidatoEnFrontera,
  construirFronteraCognitivaAdmisible,
  clasificarEstadoFronteraCognitiva,
  debeRepararCandidatoEnFrontera,
  candidatosCompatiblesConFrontera,
  validarBusquedaActoCognitivo,
  obtenerUltimoActoCanonicoComprometidoAnterior,
  validarIntegridadReferencialRepresentacionProductor,
  debeEjecutarMaterializadorMovimientoLegacy,
  // MISSION_REQUIRED_OPPORTUNITY_OUTRANKS_OPTIONAL_ACQUIRED_ACT -- isolable
  // unit test of the cross-mechanism arbitration predicate without needing
  // the full writer.procesar() harness (see its own docstring).
  actoAdquiridoOpcionalDebeCederAMisionRequerida,
  // AUTHORIZED_VISIBLE_OUTPUT_AVAILABLE — isolable unit test of the
  // three-path visible-output authority predicate without needing the
  // full writer.procesar() harness (see its own docstring).
  authorizedVisibleOutputEstaDisponible,
  // DESTINO_AUTORIDAD_SEMANTICA_DIMENSIONAL_1 — exportadas para prueba focal
  // directa (mismo criterio que ValidadorSemanticoDeltaConceptos, unidad
  // aislable sin necesitar el harness completo de writer.procesar()).
  gobernarDimensionDeltaConceptos, dimensionesLegalesDeGramatica,
  // C007 — STRUCTURED GOVERNED GAIN AUTHORITY — same rationale as above:
  // isolable unit test of the GAIN_SUPPORT projection (concept descriptions
  // scoped to soporteConceptoIds) without needing the full writer.procesar()
  // harness.
  materialAfirmableParaActo,
  // CONTENT_CLOSURE_REPAIR — isolable unit test of the third repair outcome
  // (see intentarReparacionCierreReferencial's own docstring) without
  // needing the full writer.procesar() harness.
  extraerIdsColgantesDeReferenciasInvalidas,
  intentarReparacionCierreReferencial,
  respuestaDirigidaSatisfaceActoPrevio,
  proyectarTargetRealizableCanonico,
  normalizarReferenciasTemporalesDeCandidatoReparado,
  gobernarRelacionDirigidaDeCandidatoReparado,
  detectarDefectosEstructuralesProductor,
  // BOOTSTRAP_SEMANTICUNKNOWN_TO_ACQUISITION_CORRECTION — isolable unit
  // test without needing the full writer.procesar() harness.
  intentarCorreccionAdquisicionBootstrap,
  // BOOTSTRAP_REACQUISITION — isolable unit test without needing the full
  // writer.procesar() harness.
  intentarReadquisicionBootstrap,
  // BOOTSTRAP_ACQUISITION_YIELD_RELIABILITY / R3 — isolable unit test of
  // the correction-eligibility predicate without needing the full
  // writer.procesar() harness.
  elegibleCorreccionAdquisicionBootstrap,
  // NEW_OPPORTUNITY_REQUIRES_SAME_BATCH_GROUNDING — isolable unit test of
  // the fresh-grounding eligibility predicate and correction function
  // without needing the full writer.procesar() harness.
  elegibleCorreccionFundamentoFrescoOportunidad,
  primerCandidatoSinFundamento,
  intentarCorreccionFundamentoFrescoOportunidad,
  // CONTRATO_RESPUESTA_DIRIGIDA_CANONICAL_DIMENSION_LOST — isolable unit
  // test of the canonical-target dimension resolver without needing the
  // full writer.procesar() harness.
  resolverDimensionDeTargetGobernado,
  // DESTINO_MISSION_SUFFICIENCY_NOT_WIRED_TO_CLOSURE — isolable unit test
  // of the grammar-adapter mission-sufficiency boundary without needing
  // the full writer.procesar() harness.
  resolverSuficienciaMisionGramaticaActiva,
};
