'use strict';

/**
 * MATERIALIZACIÓN DE INTERVENCIÓN VISIBLE.
 *
 * FRONTERA_INTERVENCION_VISIBLE_1 — la única función con autoridad para
 * producir mensajeCirculo a partir de un ContratoIntervencion
 * (src/schemas/ContratoIntervencion.js). Reemplaza la autoridad dispersa
 * de P1 (r.parsed.mensaje crudo), P3 (fallback determinista ad-hoc fuera
 * de la frontera), P4 (formulacionCongelada expuesta directamente) y P5
 * (texto de síntesis autorizada expuesto directamente) — ninguno de esos
 * cuatro puede llegar a mensajeCirculo sin pasar por aquí.
 *
 * Estrategias de materialización, en orden (nunca obliga una llamada LLM
 * nueva por turno cuando ya existe un candidato válido — ver punto 7 del
 * incremento):
 *   1. Si el contrato trae `contenido.materialCandidato` (texto ya
 *      producido por algún productor cognitivo — Capa 1, un Realizador
 *      previo) y ese texto SATISFACE el contrato (política de superficie +
 *      coherencia con accionUsuario), se usa tal cual — cero llamadas
 *      nuevas.
 *   2. Si no, se invoca el Realizador con buildRealizadorDesdeContrato
 *      (callProfile REALIZACION_CONVERSACIONAL) — hasta 2 intentos, el
 *      segundo con la causa exacta del primer rechazo.
 *   3. Si ambos intentos fallan, materialización determinista SEGURA
 *      compuesta desde el propio contrato (nunca un string genérico fuera
 *      de contexto como el P3 anterior) — reemplaza el fallback P3 sin
 *      crear un camino lateral: vive DENTRO de esta misma frontera.
 *
 * La política de "no metacomentario" (punto 9 del incremento) es
 * semántica, no una blacklist literal como mecanismo principal: vive
 * primero en el PROMPT del Realizador (PROHIBICION_METACOMENTARIO, en todo
 * contrato) — la validación heurística de aquí es una red de seguridad
 * para decidir si reintentar, no la defensa primaria.
 */

const { buildRealizadorDesdeContrato } = require('../agora/AgoraPrompts');
const { MOVIMIENTOS_DESTINO } = require('../state/MovimientoConversacionalPolicy');
const { proyectarWhatContratado } = require('../schemas/ContratoIntervencion');
const { SEMANTICA_OPERADORES_ACTO } = require('../state/DecisorIntervencionConversacional');
const { ProducerExecutionCoordinator, PRODUCER_FAILURE_CLASSES } = require('../llm/ProducerExecutionCoordinator');
const { ERROR_CATEGORIES } = require('../llm/LLMErrorTaxonomy');
const { computeSchemaFingerprint } = require('../observability/ReplayFingerprints');

// C007 human canary v6 — FIDELITY_EXECUTOR_FAILURE != FIDELITY_VERDICT.
// PROVIDER_FAILURE / VALIDATOR_CAPABILITY_FAILURE reuse the exact same
// neutral failure-class vocabulary ProducerExecutionCoordinator already
// governs for the producer — the mechanism is executor-agnostic; only the
// caller differs. Never a third, Fidelity-only string: escalate() checks
// these literal values.
const CATEGORIAS_FALLO_TRANSPORTE = Object.freeze([
  ERROR_CATEGORIES.MODEL_UNAVAILABLE,
  ERROR_CATEGORIES.AUTH_CONFIGURATION_ERROR,
  ERROR_CATEGORIES.QUOTA_OR_RATE_LIMIT,
  ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR,
  // C007 human canary v9 — FIDELITY_LATENCY_CONTAINMENT. A deadline firing
  // on Fidelity's own transport call (LLMService.call({ timeoutMs })) is a
  // SLOW_EXECUTOR fact, not a semantic verdict — it reuses the exact same
  // PROVIDER_FAILURE escalation path as any other transport failure here.
  ERROR_CATEGORIES.PROVIDER_TIMEOUT,
]);

// C007 human canary v9 — FIDELITY_LATENCY_CONTAINMENT execution policy, not
// a magic constant buried in a prompt. SLOW_EXECUTOR != UNBOUNDED_USER_WAIT:
// this bounds a single Fidelity transport attempt, never a cognitive
// timeout, never the turn's own deadline.
//
// Derivación (evidencia real, no un número elegido para pasar un test):
// (a) latencia sana de Fidelity en el mismo ciclo de canary (v7, v8,
//     AUTOMATIC_FULL_PATH_T1, y las otras 3 llamadas de v9 mismo —
//     reconciliación 1.3-1.6s, producer 2.6-3.3s, realizador 1.5s): 1-2s;
// (b) calibración real del candidato a fallback (mismo Contract/draft
//     congelados de v9, llamada real): gemini-flash-latest devolvió un
//     veredicto correcto (transporte exitoso, schema válido, gobernanza
//     semántica correcta — identificó exactamente la recapitulación y el
//     meta-lenguaje de v9) en 10,023ms; gemini-3.5-flash, en cambio, no
//     produjo veredicto derivable (VALIDATOR_CAPABILITY_FAILURE) en 7,528ms
//     — confirma que "bueno para Producer" no implica "bueno para
//     Fidelity", y que la capacidad real, no solo la latencia, decide el
//     fallback.
// El mismo deadline gobierna tanto el intento primario como el escalado al
// fallback (ProducerExecutionCoordinator no distingue ejecutor al aplicar
// timeoutMs) — debe cubrir ambos sin tratar la latencia sana del fallback
// verificado como si fuera la anomalía. 15000ms deja margen (~1.5x sobre
// los 10,023ms del fallback verificado, ~7-10x sobre la latencia sana del
// primary) y sigue muy por debajo de la anomalía real que motivó este
// incremento (16,660ms), a la que sí debe reaccionar. No es un SLA global
// de Círculo: limita únicamente un executor de Fidelity claramente
// estancado.
const FIDELITY_EXECUTION_DEADLINE_MS = 15000;

// The provider never delivered a usable response at all (429, timeout, auth,
// unknown transport error) -> PROVIDER_FAILURE. Anything else where no
// verdict could be derived -- truncated, non-JSON, or JSON missing the
// required fields -- means the executor DID run but its output does not
// satisfy the Fidelity contract -> VALIDATOR_CAPABILITY_FAILURE. Neither is
// ever a semantic rejection (CAMBIA_WHAT); this function is only consulted
// when no real verdict was derivable at all.
function clasificarFalloEjecutorFidelidad(r) {
  if (r && r.errorCategory && CATEGORIAS_FALLO_TRANSPORTE.includes(r.errorCategory)) {
    return PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE;
  }
  return PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE;
}

// FIDELITY_FROZEN_CONTRACT_REFERENCE_AUTHORITY (C007, Daniel-adjudicated,
// real evidence: logistica_c1 turn 9). Fidelity's own rejection reasoning
// cited "el operador contratado es PROPOSE_MISSION_CLOSURE" four consecutive
// times, when the actually-frozen WHAT (whatCanonicoContratado, unchanged
// throughout) was ABRIR_COMO/destilar/obvio -- PROPOSE_MISSION_CLOSURE
// existed only inside contrato.historialVisibleReciente, a field the SAME
// prompt already labels soloContexto, under a "current canonical act must
// override stale history" instruction that was already explicit and
// unambiguous. PROMPT-ONLY AUTHORITY IS NOT SUFFICIENTLY RELIABLE. These two
// fields make the reference WHAT machine-verifiable instead of trusting the
// model to have read/honored the prose hierarchy: required, so a validator
// response missing them is already schema-invalid (never silently accepted),
// and checked byte-for-byte against a projection this module computes
// itself, never derived from the model's own free-form reasoning.
const FIDELITY_RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    referenceFingerprint: { type: 'STRING' },
    referenceOperation: { type: 'STRING' },
    fidelidadWhat: { type: 'STRING', enum: ['FIEL', 'CAMBIA_WHAT'] },
    fidelidadViaAcceso: { type: 'STRING', enum: ['FIEL', 'CAMBIA_VIA_ACCESO'] },
    // VISIBLE_LANGUAGE_FIDELITY — tercer eje, independiente de WHAT/vía:
    // el WHAT puede conservarse intacto y aun así introducir un registro
    // léxico innecesariamente elevado (etiqueta de dominio acuñada, o
    // simplemente una sustitución de registro sin beneficio) que ni el
    // contrato ni la evidencia gobernada autorizan.
    fidelidadLexica: { type: 'STRING', enum: ['FIEL', 'INTRODUCE_ETIQUETA_NO_AUTORIZADA'] },
    // C007 human canary v9 — VISIBLE_REALIZATION_DISCIPLINE. Cuarto eje,
    // independiente de A/B/C: el WHAT y el registro léxico pueden estar
    // intactos y aun así el draft agregar framing conversacional sin
    // función contractual (recapitulación innecesaria, meta-lenguaje sobre
    // el propio proceso de Círculo, o una única necesidad expresada como
    // dos formulaciones redundantes).
    fidelidadDisciplinaConversacional: { type: 'STRING', enum: ['FIEL', 'NO_FIEL'] },
    veredicto: { type: 'STRING', enum: ['FIEL', 'CAMBIA_WHAT'] },
    razon: { type: 'STRING' },
  },
  required: ['referenceFingerprint', 'referenceOperation', 'fidelidadWhat', 'fidelidadViaAcceso', 'fidelidadLexica', 'fidelidadDisciplinaConversacional', 'veredicto', 'razon'],
});

// Frontera común de ejecutabilidad: el movimiento del contrato vive dentro
// de `contenido`; ningún origen del contrato puede materializar un reflejo
// sin WHAT cognitivo.
function esReflejoSinGananciaCognitiva(contrato) {
  const contenido = contrato && contrato.contenido;
  const ganancia = contenido && contenido.gananciaCognitiva;
  return !!(
    contenido
    && contenido.movimiento === MOVIMIENTOS_DESTINO.REFLEJAR_Y_PROFUNDIZAR
    && contrato.accionUsuario
    && contrato.accionUsuario.tipo === 'ninguna'
    && !(ganancia && typeof ganancia.contenido === 'string' && ganancia.contenido.trim())
    && !(contenido.actoInterrogativo || contenido.semanticUnknown || contenido.unknownId)
  );
}

// Red de seguridad, NO mecanismo principal (ver docstring del archivo): la
// defensa primaria es el prompt. Estos patrones capturan el caso más
// flagrante -- una intervención que es PURO metacomentario, sin contenido
// real -- para decidir si vale la pena reintentar. Deliberadamente cortos
// y genéricos (verbo de proceso + sujeto implícito "nosotros/Círculo"),
// nunca las frases literales de un incidente puntual.
const PATRONES_METACOMENTARIO = Object.freeze([
  /^(perfecto[.,]?\s*)?(entonces\s+)?(confirmamos|avanzamos|seguimos|continuamos)\b/i,
  /\b(la\s+)?(estructura|transformaci[oó]n|relaci[oó]n|s[ií]ntesis)\s+(qued[oó]|est[aá])\s+(confirmada|validada|firme|definid[ao]|estructurad[ao])\b/i,
  /\bqueda\s+(confirmada|validada|registrada|as[ií])\b/i,
]);

// FRONTERA_INTERVENCION_VISIBLE_1 (corrección focal — AUTORIDAD_DE_LENGUAJE)
// — red de seguridad, NO mecanismo principal (mismo criterio que
// PATRONES_METACOMENTARIO arriba: la defensa primaria es no ALIMENTAR este
// vocabulario a quien redacta texto visible -- ver AgoraSlots.
// SLOT_LABELS_SUPERFICIE, MovimientoConversacionalPolicy.js). Catálogo
// CERRADO y pequeño de VOCABULARIO_INTERNO_NO_AUTORIZADO_A_SUPERFICIE
// (nombres de marca/metodología, nunca palabras comunes) -- nunca una
// blacklist genérica. Reconstrucción causal real (trayectoria humana,
// turno 1): "La estrella" llegó al usuario vía el prompt de Movimiento, sin
// que él la hubiera mencionado nunca. Si el propio experto usa la MISMA
// expresión primero (requerimiento I -- nunca bloquear por coincidencia
// léxica con el usuario), deja de tratarse como fuga: ya es su lenguaje.
const VOCABULARIO_INTERNO_NO_AUTORIZADO = Object.freeze([
  'la estrella',
]);

// PROPOSE_MISSION_CLOSURE_SINGLE_ACT_FIDELITY (C007, Daniel-adjudicated,
// real evidence: logistica_c0 turns 23 y 29). Red de seguridad
// DETERMINÍSTICA, scoped ÚNICAMENTE a contratos con
// actoCognitivoVisible.operator==='PROPOSE_MISSION_CLOSURE' -- nunca una
// regla léxica global (la misma palabra es perfectamente legítima bajo
// cualquier otro operador). Antes de este incremento, ESTE patrón exacto
// (cierre + mención de avanzar/continuar) dependía ÚNICAMENTE del juicio
// semántico de Fidelity turno a turno -- turno 23 lo aceptó una vez y lo
// rechazó dos veces con el mismo contenido antes de eso; turno 29 lo
// rechazó cuatro veces seguidas. Esta red no reemplaza a Fidelity (que
// sigue siendo la autoridad semántica primaria y evalúa todo lo demás);
// solo hace determinística la ÚNICA distinción que real evidence probó
// inestable: cierre-de-la-misión-actual vs. negociación-del-siguiente-paso
// son dos actos distintos, y el segundo nunca está autorizado aquí.
const PROPOSE_MISSION_CLOSURE_MENCION_AVANCE = /\b(avanzar|avanzamos|avancemos|seguir\s+a|seguimos(?:\s+a)?|continuar(?:\s+a)?|continuemos|pasar\s+a|pasamos\s+a|la\s+siguiente\s+(parte|fase|etapa|gram[aá]tica)|el\s+siguiente\s+paso|otra\s+(fase|etapa)|nueva\s+(fase|etapa|exploraci[oó]n))\b/i;

function violaSingleActoPropuestaCierre(mensaje, contrato) {
  const operador = contrato && contrato.actoCognitivoVisible && contrato.actoCognitivoVisible.operator;
  if (operador !== 'PROPOSE_MISSION_CLOSURE') return false;
  return PROPOSE_MISSION_CLOSURE_MENCION_AVANCE.test(mensaje);
}

/**
 * @param {string} mensaje
 * @param {object} contrato
 * @param {string|null} [mensajeUsuario] — el mensaje real de ESTE turno; si
 *   el experto ya usó el mismo término, deja de bloquearse (requerimiento I).
 * @returns {{ valido: boolean, motivo: string|null }}
 */
function validarMaterializacion(mensaje, contrato, mensajeUsuario = null) {
  if (contrato && contrato.accionUsuario && contrato.accionUsuario.tipo !== 'ninguna'
    && !(contrato.contenido && typeof contrato.contenido.gainType === 'string' && contrato.contenido.gainType.trim())
    && !(contrato.contenido && contrato.contenido.estadoProspectivoTerminal)) {
    return { valido: false, motivo: 'INTERVENCION_SIN_GANANCIA_PRIMARIA' };
  }
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
    return { valido: false, motivo: 'RESPUESTA_VACIA' };
  }
  const texto = mensaje.trim();
  if (violaSingleActoPropuestaCierre(texto, contrato)) {
    return { valido: false, motivo: 'PROPOSE_MISSION_CLOSURE_SEGUNDO_ACTO -- menciona avanzar/continuar/seguir a otra parte, negociando el siguiente paso además del cierre actual' };
  }
  // Metacomentario puro: el mensaje ENTERO (o casi) coincide con un patrón
  // de proceso, sin margen para contenido real -- un mensaje largo que
  // simplemente EMPIEZA con una de estas frases y sigue con contenido real
  // no cae aquí (solo se rechaza cuando el patrón consume la mayor parte
  // del mensaje).
  for (const patron of PATRONES_METACOMENTARIO) {
    const m = texto.match(patron);
    if (m && m[0].length >= texto.length * 0.6) {
      return { valido: false, motivo: 'METACOMENTARIO_SIN_CONTENIDO_REAL' };
    }
  }
  // FRONTERA_INTERVENCION_VISIBLE_1 (corrección focal) — vocabulario interno
  // no ganado: el experto nunca lo dijo, así que Círculo tampoco tiene
  // autoridad para introducirlo. Comparación case-insensitive, nunca sobre
  // fragmentos de palabra (para no bloquear coincidencias parciales
  // accidentales) -- ver VOCABULARIO_INTERNO_NO_AUTORIZADO arriba.
  const textoLower = texto.toLowerCase();
  const usuarioLower = (typeof mensajeUsuario === 'string' ? mensajeUsuario : '').toLowerCase();
  for (const termino of VOCABULARIO_INTERNO_NO_AUTORIZADO) {
    if (textoLower.includes(termino) && !usuarioLower.includes(termino)) {
      return { valido: false, motivo: `VOCABULARIO_INTERNO_NO_AUTORIZADO ("${termino}") -- el experto nunca introdujo ese término` };
    }
  }
  // La acción de usuario puede pedirse con una pregunta literal ("?") o con
  // una instrucción directa ("dime...", "cuéntame...", "cuál..."); ambas
  // formas son igual de válidas en español natural -- nunca exigir
  // exactamente un signo de interrogación.
  const accionTipo = contrato.accionUsuario.tipo;
  const pareceUnaSolicitud = /[?¿]/.test(texto) || /\b(dime|cu[eé]ntame|cu[aá]l(es)?|puedes?|podr[ií]as?|indica|comparte)\b/i.test(texto);
  if (!(contrato.contenido && contrato.contenido.estadoProspectivoTerminal)
    && accionTipo !== 'ninguna' && !pareceUnaSolicitud) {
    return { valido: false, motivo: `ACCION_USUARIO_REQUIERE_PREGUNTA (tipo=${accionTipo}) pero el mensaje no parece pedir nada` };
  }
  return { valido: true, motivo: null };
}

function validarFidelidadViaAcceso(resultado, contrato) {
  // La vía es relevante para intervenciones que solicitan una respuesta
  // abierta; síntesis/veredictos mantienen el contrato histórico y no
  // necesitan un campo auxiliar del Realizer.
  if (!contrato || contrato.funcion === 'RESUMIR' || (contrato.contenido && contrato.contenido.tipo === 'sintesis_autorizada')
    || !(contrato.contenido && contrato.contenido.validarViaAcceso === true)
    || !contrato.accionUsuario
    || !['responder_pregunta', 'dar_ejemplo'].includes(contrato.accionUsuario.tipo)) {
    return { valido: true, motivo: null };
  }
  const autorizada = contrato && contrato.accionUsuario && contrato.accionUsuario.viaAcceso
    ? contrato.accionUsuario.viaAcceso : null;
  if (!resultado || typeof resultado !== 'object') return { valido: false, motivo: 'REALIZADOR_SIN_RESULTADO' };
  // Compatibilidad con realizaciones históricas: la ausencia del campo no
  // autoriza una vía nueva; solo una declaración explícita incompatible se
  // rechaza. Los contratos nuevos que declaran vía deben transportarla.
  if (!Object.prototype.hasOwnProperty.call(resultado, 'viaAccesoUsada')) return { valido: true, motivo: null };
  if ((resultado.viaAccesoUsada || null) !== autorizada) {
    return { valido: false, motivo: `REALIZADOR_CAMBIO_VIA_ACCESO (autorizada=${autorizada || 'null'}, usada=${resultado.viaAccesoUsada || 'null'})` };
  }
  return { valido: true, motivo: null };
}

// FIDELITY_FROZEN_CONTRACT_REFERENCE_AUTHORITY -- the deterministic
// reference projection is TRANSPORT, never reinterpretation: it reuses the
// exact same authoritative fields the prompt below already declares
// (contrato.actoCognitivoVisible / contrato.whatCanonicoContratado, via
// proyectarWhatContratado -- the SAME projection already sent to Fidelity),
// canonicalized and hashed with the SAME fingerprint utility the engine
// already uses elsewhere (ReplayFingerprints.sha256Hex/canonicalize), never
// a second serialization framework. `referenceOperation` is a single,
// human-and-machine-readable summary of the SAME authoritative act (the
// canonical act's own operator when one is frozen, otherwise the
// interrogative/semantic-unknown's own operation -- exactly the two shapes
// proyectarWhatContratado already distinguishes) -- 'NONE' only when
// whatCanonicoContratado itself resolves to no authoritative act at all.
// Never infers a replacement operator from history; never synthesizes
// PROPOSE_MISSION_CLOSURE or anything else when actoCognitivoVisible is
// null -- absence of a canonical act is preserved as null, not filled.
// `contractId` is this turn's own reserved turnoId -- the SAME identity
// authority_trace.turno already reports as `contract.id` elsewhere in the
// engine; threaded through here purely as an observability/identity field,
// never hashed into referenceFingerprint (the fingerprint identifies the
// WHAT content itself, so two calls judging the exact same frozen act
// produce the exact same fingerprint regardless of which turnoId reserved
// it -- FR9's own requirement).
function construirFidelityReferenceProjection(contrato, contractId = null) {
  const proyeccion = proyectarWhatContratado(contrato);
  const operacionReferencia = contrato.actoCognitivoVisible
    ? contrato.actoCognitivoVisible.operator
    : (proyeccion.semanticUnknown && proyeccion.semanticUnknown.operation)
      || (proyeccion.actoInterrogativo && proyeccion.actoInterrogativo.operacion)
      || null;
  const semanticUnknownId = (proyeccion.semanticUnknown && proyeccion.semanticUnknown.id) || null;
  // MISSION_REQUIRED_VALUE_ACT_REQUIRES_TYPED_TARGET_AND_REQUESTED_FACET --
  // the reference states WHICH entity and WHICH facet the frozen act is
  // about, read from the SAME frozen act the fingerprint hashes (so
  // reference target / facet == contract target / facet by construction).
  const actoReferencia = contrato.actoCognitivoVisible || null;
  const referenceTargetConceptId = (actoReferencia && actoReferencia.targetBinding
    && actoReferencia.targetBinding.targetConceptId) || (actoReferencia && actoReferencia.requestedFacet
    ? actoReferencia.subjectRef || null : null);
  const referenceRequestedFacet = actoReferencia && actoReferencia.requestedFacet
    ? Object.freeze({ mission: actoReferencia.requestedFacet.mission, dimension: actoReferencia.requestedFacet.dimension })
    : null;
  const referencia = Object.freeze({
    actoCognitivoVisible: contrato.actoCognitivoVisible || null,
    whatCanonicoContratado: proyeccion,
  });
  return Object.freeze({
    contractId: contractId || null,
    referenceFingerprint: computeSchemaFingerprint(referencia),
    referenceOperation: operacionReferencia || 'NONE',
    referenceSemanticUnknownId: semanticUnknownId || 'NONE',
    referenceTargetConceptId: referenceTargetConceptId || 'NONE',
    referenceRequestedFacet,
    authoritativeFields: Object.freeze(['actoCognitivoVisible', 'whatCanonicoContratado']),
    referencia,
  });
}

// CANONICAL_REFERENCE_EXCLUSIVELY_OWNS_FIDELITY_WHAT (C007, live
// DAR VIDA turn 79, D79-B -- the Fidelity-side twin of the Realizer-side
// canonical-act exclusivity, abd51e2).
// IF A FROZEN CANONICAL REFERENCE EXISTS THEN IT IS THE ONLY AUTHORITY
// FIDELITY MAY USE TO DETERMINE WHAT. The payload Fidelity reads next to the
// reference used to carry the legacy, Producer-prose act-like descriptors the
// Realizer prompt already stopped rendering (actoInterrogativo, foco /
// operacion / desconocidoObjetivo, accionUsuario.objetivo): live turn 79's
// verdict named "la proposición de la voz interior" as the contracted WHAT, a
// phrase that exists ONLY in those legacy fields, while the frozen reference
// was ASK_EVIDENCE over a different proposition. Labelling them
// "non-authoritative" was not enough (the same lesson as RUN-3 / the
// evidenciaBuscada leak): an LLM handed a second act-like description treats
// it as WHAT. So, structurally, with a canonical reference they are not sent
// as act-like content at all; the reference (operator, target, proposition,
// requested facet, authorized presuppositions, fingerprint -- all computed
// by construirFidelityReferenceProjection, UNCHANGED) is the single WHAT
// surface. What remains is context that cannot redefine WHAT: HOW routing
// (funcion / movimiento), the user-action TYPE and access route, governed
// material, lexical register, history, anchors-as-support, the governed
// gain. With NO canonical reference the certified legacy payload is kept
// byte for byte (the interrogative/semantic-unknown projection stays the
// reference there).
const CAMPOS_LEGADOS_ACT_LIKE_FIDELIDAD = Object.freeze([
  'operacion', 'foco', 'actoInterrogativo', 'semanticUnknown', 'sujetoObjetivo',
  'desconocidoObjetivo', 'evidenciaBuscada', 'accionUsuario.objetivo',
]);

function proyectarContextoLegadoParaFidelidad(contrato) {
  const contenido = contrato.contenido || {};
  const acto = contrato.actoCognitivoVisible || null;
  if (!acto) {
    return {
      referenciaCanonicaExclusiva: false,
      accionUsuario: contrato.accionUsuario,
      operacion: contenido.operacion
        || (contenido.actoInterrogativo && contenido.actoInterrogativo.operacion)
        || (contenido.oportunidadConversacional && contenido.oportunidadConversacional.operacion)
        || null,
      foco: contenido.focoExploracion || null,
      actoInterrogativo: contenido.actoInterrogativo || null,
      semanticUnknown: contenido.semanticUnknown || null,
      sujetoObjetivo: contenido.desconocidoPreguntableScoped ? contenido.desconocidoPreguntableScoped.sujeto : null,
      desconocidoObjetivo: contenido.desconocidoObjetivo || null,
      evidenciaBuscada: contenido.evidenciaBuscada || null,
      presuposicionesAutorizadas: contenido.actoInterrogativo && contenido.actoInterrogativo.presuposicionesAutorizadas
        ? contenido.actoInterrogativo.presuposicionesAutorizadas : [],
    };
  }
  const accion = contrato.accionUsuario && typeof contrato.accionUsuario === 'object'
    ? { tipo: contrato.accionUsuario.tipo, viaAcceso: contrato.accionUsuario.viaAcceso || null }
    : contrato.accionUsuario;
  return {
    referenciaCanonicaExclusiva: true,
    accionUsuario: accion,
    operacion: null,
    foco: null,
    actoInterrogativo: null,
    semanticUnknown: null,
    sujetoObjetivo: null,
    desconocidoObjetivo: null,
    evidenciaBuscada: null,
    presuposicionesAutorizadas: Array.isArray(acto.authorizedPresuppositionIds) ? acto.authorizedPresuppositionIds : [],
  };
}

// Only appended to the Fidelity system prompt when a canonical reference
// exists: the legacy-path prompt stays byte-identical.
const BLOQUE_REFERENCIA_CANONICA_EXCLUSIVA = `
REFERENCIA CANÓNICA EXCLUSIVA (CANONICAL_REFERENCE_EXCLUSIVELY_OWNS_FIDELITY_WHAT): en este turno existe una referencia congelada. Es la ÚNICA autoridad del WHAT: operador, target, subject, proposición (realizationTarget), faceta solicitada y presuposiciones autorizadas del acto congelado. Tú puedes JUZGAR si la realización conserva ese WHAT; NO puedes reconstruirlo. Ningún otro campo del payload define, completa ni modifica el WHAT: el historial, el material afirmable, los anclajes, el mensaje del experto, la ganancia y cualquier descripción de la tarea del usuario son CONTEXTO para interpretar la realización (resolver referencias, entender palabras, juzgar disciplina conversacional), nunca un segundo WHAT. Los descriptores legados de acto ya no se envían en este turno; si crees ver uno, ignóralo.
Cuando devuelvas CAMBIA_WHAT, tu "razon" debe identificar el delta ÚNICAMENTE respecto de la referencia congelada, nombrando UNA categoría y el campo de la referencia contra el que la mides: TARGET_CHANGED | PROPOSITION_CHANGED | REQUESTED_FACET_CHANGED | OPERATOR_CHANGED | EVIDENCE_RELATION_CHANGED | SECOND_WHAT_ADDED | OTHER_EXPLICIT_DELTA. Una razón que describa un WHAT que no está en la referencia congelada no es evidencia de que la realización lo cambió. Una reformulación o un refinamiento dentro del mismo target y la misma proposición congelados, con el mismo operador, no es por sí mismo un delta.
`;

async function validarFidelidadSemantica({ mensaje, contrato, llmService, turnoId, mensajeUsuario = null, timeoutMs = null }) {
  if (!contrato || !contrato.contenido || (!contrato.actoCognitivoVisible
      && contrato.contenido.validarViaAcceso !== true
      && contrato.contenido.fidelidadVisibleRequerida !== true)
    ) {
    return { veredicto: 'FIEL', razon: 'contrato fuera del rollout de vía' };
  }
  const via = contrato.accionUsuario && contrato.accionUsuario.viaAcceso
    ? contrato.accionUsuario.viaAcceso : null;
  const fidelityReference = construirFidelityReferenceProjection(contrato, turnoId || null);
  const bloqueReferenciaAutoritativa = `AUTHORITATIVE_FIDELITY_REFERENCE (única fuente del WHAT contra el que juzgas -- fingerprint y operation calculados de forma determinista por el sistema, NUNCA por vos; debes devolverlos EXACTAMENTE en tu JSON de salida):
  referenceFingerprint: "${fidelityReference.referenceFingerprint}"
  referenceOperation: "${fidelityReference.referenceOperation}"${fidelityReference.referenceRequestedFacet ? `
  referenceTargetConceptId (ENTIDAD CONOCIDA del acto): "${fidelityReference.referenceTargetConceptId}"
  referenceRequestedFacet (FACETA SOLICITADA del acto): ${JSON.stringify(fidelityReference.referenceRequestedFacet)}` : ''}
Estos dos valores identifican, byte a byte, el mismo contrato.actoCognitivoVisible/contrato.whatCanonicoContratado que aparece más abajo en NON_AUTHORITATIVE_CONTEXT_AND_STRUCTURAL_DETAIL -- nunca los recalcules ni los derives de contrato.historialVisibleReciente ni de ningún otro campo: cópialos tal cual de esta sección. Si tu razonamiento sobre el WHAT contratado no coincide con lo que este bloque declara, este bloque es la autoridad, no tu propia lectura del historial.

NON_AUTHORITATIVE_CONTEXT_AND_STRUCTURAL_DETAIL (el resto del campo "contrato" -- incluye la MISMA autoridad ya resumida arriba, en su forma estructural completa, junto con contexto que nunca es autoridad):`;
  const system = `El ContratoIntervencion ya decidió el WHAT y sus presuposiciones autorizadas. Ejecuta exactamente el operador y su semántica canónica: ${JSON.stringify(SEMANTICA_OPERADORES_ACTO)}. No decidas un operador alternativo.

${bloqueReferenciaAutoritativa}

JERARQUÍA DE AUTORIDAD (CURRENT_CANONICAL_ACT_MUST_OVERRIDE_STALE_CONVERSATIONAL_HISTORY — C007, Daniel-adjudicated, real evidence: logistica_c0 fresh-live turn 13 DESTILAR, session live_complete_logistica_c0_11ec6033). El campo "contrato" de este payload mezcla, en el mismo objeto, autoridad canónica de ESTE turno y contexto no autoritativo — nunca asumas que el orden en que aparecen los campos importa; la autoridad es la que sigue, sin excepción:
  1. AUTORIDAD MÁXIMA, absoluta: contrato.actoCognitivoVisible y contrato.whatCanonicoContratado — el operador, target, subject y efecto cognitivo YA CONGELADOS para ESTE turno. Este es el ÚNICO WHAT vigente.
  2. AUTORIDAD SECUNDARIA: los demás campos de contrato.actoCognitivoVisible/whatCanonicoContratado ya evaluados en las fronteras A-D de abajo (presuposicionesAutorizadas, materialAfirmable, materialAfirmableScoped, registroLexicoDisponible, semanticaOperador).
  3. SOLO CONTEXTO, nunca autoridad: contrato.historialVisibleReciente (turnos recientes, incluido cualquier mensaje de Círculo que haya propuesto o mencionado un cierre de misión) y los campos legado contrato.funcion/contrato.movimiento/contrato.operacion/contrato.desconocidoObjetivo/contrato.accionUsuario — estos describen ruteo interno o conversación pasada, NUNCA el acto contratado de este turno.
CONTEXT_AVAILABLE != CONTEXT_HAS_WHAT_AUTHORITY: el historial o los campos legado NUNCA pueden (a) seleccionar un operador distinto al de actoCognitivoVisible, (b) resucitar como vigente un acto anterior ya presentado (p.ej. un PROPOSE_MISSION_CLOSURE de un turno previo) cuando actoCognitivoVisible de ESTE turno es otro operador, (c) reinterpretar el acto actual, ni (d) invalidar target/missionNeed/expectedCognitiveEffect ya congelados. Si el historial reciente parece describir un cierre de misión, una pregunta anterior, o cualquier otro acto, y actoCognitivoVisible de este turno es un operador DIFERENTE, ese historial es SOLO conversación pasada — el acto vigente y el único que debes evaluar es el declarado en actoCognitivoVisible/whatCanonicoContratado de ESTE turno. El historial sigue siendo útil para (y ÚNICAMENTE para) juzgar continuidad conversacional, repetición, o si la realización contradice material ya gobernado — nunca para decidir CUÁL es el acto vigente.

Evalúa tres fronteras separadas y fail-closed:
A. FIDELIDAD WHAT: verifica operador, target, subject, estado epistémico, presuposiciones autorizadas, efecto cognitivo, modalidad pregunta/retorno y que exista un solo acto cognitivo. La frontera exacta del WHAT es la IDENTIDAD estructural ya congelada (operador + subject + target + presuposicionesAutorizadas + efecto cognitivo + requestedFacet cuando el acto la congeló: pedir otra entidad o pedir otra faceta/dimensión distinta de la solicitada es CAMBIA_WHAT) — nunca la redacción de evidenciaBuscada/semanticTarget/semanticUnknown.proposicion, que son descripción de contexto, no autoridad (C007 — COMPLETE FREE-FORM AUTHORITY REMOVAL: esa prosa puede ayudarte a entender de qué trata el target, pero nunca amplía ni redefine el WHAT, y una realización no se vuelve CAMBIA_WHAT solo por no citarla o parafrasearla). Preguntar o afirmar sobre una identidad estructural distinta (otro subject, otro target, otra presuposición no autorizada), aunque pertenezca a la misma dimensión, es CAMBIA_WHAT.
INTERROGATIVE_FORM_DOES_NOT_MAKE_ALL_EMBEDDED_CONTENT_OPEN (C007 — INTERROGATIVE PRESUPPOSITION FIDELITY): que la realización sea gramaticalmente una pregunta NO abre automáticamente todo lo que esa pregunta menciona. Distingue dentro de la propia formulación visible entre CONTENIDO ABIERTO (lo que el operador tiene derecho a preguntar — para ASK_HOW, el mecanismo/criterio en sí, cuyo valor es genuinamente desconocido) y CONTENIDO PRESUPUESTO (cualquier entidad, categoría, relación, comparación, condición temporal o hecho causal/social que la formulación da por existente o relevante para poder siquiera plantear la pregunta — p.ej. "¿cómo distingues A de B?" presupone que A y B existen y que esa distinción aplica al sujeto, aunque la pregunta en sí sea sobre el mecanismo de distinguirlos). RIGHT_TO_ASK_HOW != RIGHT_TO_PRESUPPOSE_ANY_FRAME_INSIDE_THE_QUESTION: todo contenido presupuesto debe resolver contra subject/target ya congelados o contra authorizedPresuppositionIds; si no resuelve contra ninguno de los dos, es CAMBIA_WHAT aunque la oración sea interrogativa y aunque esa entidad/categoría/condición provenga literalmente de evidenciaBuscada/semanticTarget/semanticUnknown.proposicion (esos textos son contexto no autoritativo — si el Realizer copió esa entidad/categoría/condición como si fuera parte del acto contratado, eso es exactamente lo que aquí se rechaza). ASK_EXISTENCE queda exento de esto para el propio target cuya existencia se pregunta: el acto mismo consiste en preguntar si algo existe, así que ese "algo" es, por definición, contenido todavía no nombrado formalmente — cualquier sustantivo o frase que la realización use para nombrarlo es el target verbalizado, no una entidad nueva, aunque ese nombre exacto no aparezca ya en expectedEvidence/materialAfirmable (preguntar si X existe no presupone que X existe). Sigue aplicando CAMBIA_WHAT si, además de nombrar el target, la formulación da por existente/relevante OTRA entidad, comparación o condición distinta que el target no cubre. No evalúes esto comparando contra el mensaje crudo del usuario: la comparación es siempre realización ↔ Structured Contract ya congelado.
RETURN_SCOPE_FIDELITY (C007 — STRUCTURED GOVERNED GAIN AUTHORITY): para RETURN_GOVERNED_GAIN/RETURN_UNDERSTANDING, el WHAT congelado también fija el ALCANCE de lo que puede comunicarse — el material afirmable transportado (materialAfirmable/materialAfirmableScoped) describe lo que el experto estableció, con SU alcance original (un método o criterio que el experto aplica, una observación puntual, una distinción particular), nunca una regla universal o categórica de dominio salvo que ese mismo material ya la exprese así. DECLARATIVE_RETURN_MUST_NOT_INCREASE_SCOPE_OR_QUANTIFICATION: si la realización convierte una afirmación específica del experto o de su método en una regla universal ("siempre", "nunca", "todos", "cualquier", "en general", o una reformulación que generalice con el mismo efecto sin usar esas palabras), y ese alcance universal no está ya en el material afirmable gobernado, marca CAMBIA_WHAT — incluso si el vocabulario es natural/llano y ningún término calificaría como etiqueta no autorizada bajo C. USER-SPECIFIC METHOD != UNIVERSAL DOMAIN RULE. No lo detectes buscando palabras prohibidas: evalúa semánticamente si el ALCANCE de lo afirmado (a qué aplica, bajo qué condición, con qué certeza) excede lo que el material afirmable realmente sostiene, sea cual sea la redacción exacta.
B. FIDELIDAD VÍA DE ACCESO: viaAccesoContratada es HOW conversacional, no un segundo WHAT. Si está presente, la realización puede y debe pedir el mismo WHAT mediante esa vía. En particular, APORTAR_EJEMPLO_CONCRETO permite pedir que el mismo mecanismo, criterio o evidencia esperada se muestre en un caso concreto; esa forma no amplía el WHAT por sí sola. Es CAMBIA_VIA_ACCESO si la realización omite o sustituye la vía contratada, la aplica a otro target/subject/evidencia, o introduce mediante ella otra entidad, proposición, métrica, causalidad, criterio o necesidad. Si viaAccesoContratada es null, inventar una solicitud material de ejemplo sí cambia la frontera autorizada.
C. FIDELIDAD LÉXICA (VISIBLE_LANGUAGE_FIDELITY — independiente de A, B y D; el WHAT puede conservarse intacto y aun así fallar aquí): la realización es INTRODUCE_ETIQUETA_NO_AUTORIZADA cuando reemplaza una palabra o frase que el propio experto ya usó en mensajeUsuario, o que está disponible en registroLexicoDisponible/materialAfirmable/materialAfirmableScoped, por una alternativa de registro más elevado, abstracto, técnico o genérico — sea una etiqueta de dominio acuñada (tipo "causa raíz", "origen real", "fricción operativa", "punto de desviación", "efectos secundarios") o simplemente una formulación más formal que la del experto — cuando esa sustitución no aporta ninguna claridad que el vocabulario ya disponible no aportara. Regla exacta: si el registro léxico del experto estaba disponible para expresar el mismo WHAT, Y la alternativa elegida no agrega claridad necesaria, Y esa alternativa eleva o cambia el registro respecto del disponible, marca INTRODUCE_ETIQUETA_NO_AUTORIZADA. NUNCA marques INTRODUCE_ETIQUETA_NO_AUTORIZADA por: conectores o lenguaje conversacional ordinario (entonces, cuando, cómo, qué pasa si); una paráfrasis o síntesis natural que mejora fluidez, elimina repetición, adapta sintaxis o aporta claridad genuinamente necesaria sin imponer vocabulario ajeno; una palabra del dominio que el propio experto ya usó en mensajeUsuario; o una abstracción genuinamente necesaria para devolver una comprensión nueva y gobernada que no tiene forma más simple. No exige copia literal: NATURAL_LANGUAGE_FIDELITY != VERBATIM_COPY. Esto no es una revisión de estilo general: solo evalúa si se impuso registro/vocabulario innecesario, no calidad, tono ni fluidez.

D. DISCIPLINA DE REALIZACIÓN VISIBLE (VISIBLE_REALIZATION_DISCIPLINE — independiente de A, B y C): VISIBLE_REALIZATION = MINIMUM_SUFFICIENT_EXPRESSION del acto cognitivo contratado. Cada componente conversacional visible debe cumplir una función legítima en ejecutar ese acto; HOW_MAY_EXPRESS_WHAT pero HOW_MUST_NOT_ADD_UNCONTRACTED_CONVERSATIONAL_FRAMING. Marca NO_FIEL cuando el draft, sin necesidad contractual: (1) recapitula o resume lo que el propio experto ya dijo en mensajeUsuario, sin que esa recapitulación sea necesaria para fijar sujeto/target del acto — RESTATEMENT_WITHOUT_CONTRACTUAL_FUNCTION; (2) describe el propio proceso interno, propósito o motivo de Círculo para preguntar/afirmar (p.ej. frases que explican "para qué" Círculo pregunta, en vez de simplemente ejecutar el acto) — self-process/meta-lenguaje; (3) expresa una única necesidad cognitiva contratada mediante dos o más formulaciones que no obtienen evidencia adicional entre sí — duplicated formulation, ONE_CONTRACTED_NEED debe producir ONE_SUFFICIENT_VISIBLE_FORMULATION. La necesidad de recapitulación/reformulación depende del operador ejecutado (ver semánticaOperador y actoCognitivoVisible.operator): RESTATEMENT != ALWAYS_INVALID. NUNCA marques NO_FIEL cuando el propio operador contratado exige o admite legítimamente ese contenido: RETURN_UNDERSTANDING y RETURN_GOVERNED_GAIN pueden CONSISTIR en una síntesis/reformulación — esa reformulación ES el acto, no framing añadido; REPAIR_UNDERSTANDING puede requerir reconocer la premisa rechazada antes de corregirla; y un ASK_* puede incluir el grounding mínimo estrictamente necesario para identificar sujeto/target cuando el experto mencionó varias cosas a la vez — eso es grounding funcional, no recapitulación gratuita. No evalúes aquí belleza, simpatía, personalidad, calidad literaria, gusto ni "naturalidad" genérica — solo disciplina respecto de lo que el Contract exige ejecutar.

PROPOSE_MISSION_CLOSURE_SINGLE_ACT_FIDELITY (C007, Daniel-adjudicated, real evidence: logistica_c0 turns 23 y 29 — el mismo patrón de contenido fue aceptado una vez y rechazado seis veces por juicios de Fidelity distintos, prueba de que la ambigüedad estaba en el contrato compartido, no en el modelo). Para PROPOSE_MISSION_CLOSURE, la forma interrogativa NO es por sí misma un segundo acto: "propongo cerrar esta parte" y "¿te parece si cerramos esta parte?" son la MISMA propuesta de cierre, ambas FIEL, siempre que el objeto de la pregunta sea inequívocamente ESE cierre. Lo que SÍ constituye un segundo acto (CAMBIA_WHAT, nunca solo disciplina) es cualquier mención de avanzar, continuar, seguir a otra parte/fase/gramática, o cualquier otra negociación de qué pasa DESPUÉS del cierre — cerrar la misión actual y negociar el siguiente paso son dos actos distintos, y este operador solo autoriza el primero. Una pregunta de acuerdo genérica y desanclada ("¿estás de acuerdo?") sin nombrar el cierre que se propone es insuficientemente anclada (NO_FIEL): el objeto de la confirmación debe ser explícito. Ejemplos de referencia (la distinción es de conteo de actos semánticos, nunca de puntuación o de una palabra prohibida):
  A. "Propongo cerrar esta parte." -> FIEL (un acto, declarativo)
  B. "¿Te parece si cerramos esta parte?" -> FIEL (un acto, interrogativo, objeto explícito)
  C. "¿Te parece si cerramos esta parte y avanzamos?" -> CAMBIA_WHAT (dos actos: cierre + negociación del siguiente paso)
  D. "¿Estás de acuerdo?" sin nombrar el cierre -> NO_FIEL (objeto de confirmación no anclado)
  E. "Podemos cerrar esta parte y pasar a la siguiente." -> CAMBIA_WHAT (dos actos)

El Realizer solo puede elegir HOW dentro de las cuatro fronteras. Evalúa si el mensaje visible introduce como hecho una premisa no autorizada sobre usuario, aprendiz, experto, proceso, causalidad, temporalidad, emoción, escenario, requisito o condición; evalúa explícitamente también afirmaciones declarativas, presuposiciones de preguntas y relaciones sujeto-predicado-objeto nuevas. La evidenciaBuscada describe lo que el experto debe aportar; no autoriza asumir que ya lo usa, maneja o practica. Cada premisa o relación visible debe estar en el WHAT contratado, en presuposicionesAutorizadas o en evidencia gobernada; el conocimiento general del dominio no cuenta. No evalúes tono, pedagogía ni calidad salvo lo descrito en C y D.

Devuelve referenceFingerprint y referenceOperation EXACTAMENTE como aparecen en AUTHORITATIVE_FIDELITY_REFERENCE arriba (copia literal, nunca recalculada), fidelidadWhat=FIEL|CAMBIA_WHAT, fidelidadViaAcceso=FIEL|CAMBIA_VIA_ACCESO, fidelidadLexica=FIEL|INTRODUCE_ETIQUETA_NO_AUTORIZADA y fidelidadDisciplinaConversacional=FIEL|NO_FIEL. veredicto solo puede ser FIEL cuando las cuatro fronteras son FIEL; en cualquier otro caso debe ser CAMBIA_WHAT. Responde solo JSON. La razón es diagnóstica, no autoritativa.${contrato.actoCognitivoVisible ? BLOQUE_REFERENCIA_CANONICA_EXCLUSIVA : ''}`;
  const contextoLegado = proyectarContextoLegadoParaFidelidad(contrato);
  const buildUserMsg = (correccionReferencia) => JSON.stringify({
    contrato: {
      accionUsuario: contextoLegado.accionUsuario,
      funcion: contrato.funcion,
      movimiento: contrato.contenido.movimiento,
      operacion: contextoLegado.operacion,
      foco: contextoLegado.foco,
      actoInterrogativo: contextoLegado.actoInterrogativo,
      gananciaCognitiva: contrato.contenido.gananciaCognitiva || null,
      semanticUnknown: contextoLegado.semanticUnknown,
      sujetoObjetivo: contextoLegado.sujetoObjetivo,
      desconocidoObjetivo: contextoLegado.desconocidoObjetivo,
      materialAfirmable: contrato.contenido.materialAfirmable || [],
      materialAfirmableScoped: contrato.contenido.materialAfirmableScoped || [],
      registroLexicoDisponible: contrato.contenido.lexicalGrounding || [],
      presuposicionesAutorizadas: contextoLegado.presuposicionesAutorizadas,
      // FIDELITY_AUTHORITY_LEAK correction (evidenciaBuscada is Producer
      // free-form prose, never authority) -- now part of the single
      // canonical-reference projection above: null whenever a frozen act
      // exists, unchanged (legacy value) otherwise.
      evidenciaBuscada: contextoLegado.evidenciaBuscada,
      anclajesRelevantes: contrato.contenido.oportunidadConversacional
        ? contrato.contenido.oportunidadConversacional.anclajeConceptoIds || [] : [],
      historialVisibleReciente: contrato.contenido.historialVisibleReciente || [],
      whatCanonicoContratado: proyectarWhatContratado(contrato),
      // FIDELITY_AUTHORITY_LEAK correction -- reuses the SAME filtered
      // projection whatCanonicoContratado already computed just above
      // (expectedEvidence excluded, ContratoIntervencion.js), never the
      // raw contrato.actoCognitivoVisible.
      actoCognitivoVisible: proyectarWhatContratado(contrato).actoCognitivoVisible || null,
      semanticaOperador: contrato.actoCognitivoVisible ? SEMANTICA_OPERADORES_ACTO[contrato.actoCognitivoVisible.operator] || null : null,
      // CURRENT_CANONICAL_ACT_MUST_OVERRIDE_STALE_CONVERSATIONAL_HISTORY --
      // additive-only structural authority manifest (see the system prompt).
      autoridad: {
        contratoActualAutoritativo: ['actoCognitivoVisible', 'whatCanonicoContratado'],
        // Same manifest in both paths (existing suites assert it): with a
        // canonical reference the legacy fields it names are sent null.
        soloContexto: ['historialVisibleReciente', 'funcion', 'movimiento', 'operacion', 'desconocidoObjetivo', 'accionUsuario'],
        ...(contextoLegado.referenciaCanonicaExclusiva ? { referenciaCanonicaExclusiva: true } : {}),
      },
    },
    realizacion: mensaje,
    viaAccesoContratada: via,
    mensajeUsuario: typeof mensajeUsuario === 'string' ? mensajeUsuario : null,
    ...(correccionReferencia ? { correccionReferencia } : {}),
  });
  // FIDELITY_FROZEN_CONTRACT_REFERENCE_AUTHORITY -- bounded same-executor
  // retry (mirrors the Realizer's own causaReintento pattern, never the
  // executor-escalation loop below, which is for transport/capability
  // failures only). A validator response that DECLARES referenceFingerprint/
  // referenceOperation but they don't match the frozen projection gets ONE
  // corrective retry, on the SAME executor, before falling through to the
  // existing executor-failure/fail-closed path -- "retry FIDELITY, not
  // Realizer" (this loop never touches the Realizer draft or the outer
  // executorLoop in materializarIntervencionVisible). A response that omits
  // both fields entirely (legacy/mocked fixtures predating this capability,
  // which the native responseSchema below now makes impossible for a real
  // provider call but existing test doubles may still return) is treated as
  // undeclared, not mismatched -- REFERENCE_UNDECLARED != REFERENCE_MISMATCH,
  // same backward-compatibility discipline already used for fidelidadLexica/
  // fidelidadDisciplinaConversacional below.
  let r = null;
  let parsed = null;
  let referenceDeclarada = false;
  let referenceMatch = true;
  for (let intento = 0; intento < 2; intento++) {
    const correccion = intento === 0 ? null : 'CORRECCION_DE_REFERENCIA: tu respuesta anterior devolvió referenceFingerprint/referenceOperation que NO coinciden con AUTHORITATIVE_FIDELITY_REFERENCE de este mismo prompt -- el contrato está congelado y no cambia entre intentos. Copia literalmente referenceFingerprint y referenceOperation del bloque AUTHORITATIVE_FIDELITY_REFERENCE (nunca los derives de contrato.historialVisibleReciente ni de un acto cognitivo de un turno anterior) y evalúa la MISMA realización contra ESE mismo WHAT ya congelado.';
    // eslint-disable-next-line no-await-in-loop
    r = await llmService.call({
      system, userMsg: buildUserMsg(correccion), label: 'validador-fidelidad-realizacion',
      callProfile: 'VALIDACION_FIDELIDAD_REALIZACION', maxRetries: 1,
      responseMimeType: 'application/json', responseSchema: FIDELITY_RESPONSE_SCHEMA,
      turnoId, timeoutMs,
    });
    parsed = r && r.parsed;
    referenceDeclarada = !!(parsed && typeof parsed.referenceFingerprint === 'string' && typeof parsed.referenceOperation === 'string');
    referenceMatch = !referenceDeclarada || (
      parsed.referenceFingerprint === fidelityReference.referenceFingerprint
      && parsed.referenceOperation === fidelityReference.referenceOperation
    );
    if (!parsed || referenceMatch) break; // no parsed reply to correct, or already bound correctly
  }
  const hasAxisVerdicts = referenceMatch && parsed
    && ['FIEL', 'CAMBIA_WHAT'].includes(parsed.fidelidadWhat)
    && ['FIEL', 'CAMBIA_VIA_ACCESO'].includes(parsed.fidelidadViaAcceso);
  // Compatibilidad con realizaciones históricas (mismo criterio que arriba):
  // un validador que todavía no declara este eje no bloquea por él.
  const fidelidadLexicaDeclarada = referenceMatch && parsed
    && ['FIEL', 'INTRODUCE_ETIQUETA_NO_AUTORIZADA'].includes(parsed.fidelidadLexica)
    ? parsed.fidelidadLexica : null;
  // C007 human canary v9 — VISIBLE_REALIZATION_DISCIPLINE. Same backward-
  // compatibility discipline as fidelidadLexica above: a validator response
  // that doesn't declare this axis never blocks on it (every mocked/legacy
  // fixture across the existing test suites returns {veredicto:'FIEL'}
  // alone, and must keep passing byte for byte).
  const disciplinaConversacionalDeclarada = referenceMatch && parsed
    && ['FIEL', 'NO_FIEL'].includes(parsed.fidelidadDisciplinaConversacional)
    ? parsed.fidelidadDisciplinaConversacional : null;
  const verdict = hasAxisVerdicts
    ? (parsed.fidelidadWhat === 'FIEL' && parsed.fidelidadViaAcceso === 'FIEL'
      && fidelidadLexicaDeclarada !== 'INTRODUCE_ETIQUETA_NO_AUTORIZADA'
      && disciplinaConversacionalDeclarada !== 'NO_FIEL'
      ? 'FIEL' : 'CAMBIA_WHAT')
    : (referenceMatch ? parsed && parsed.veredicto : null);
  // FIDELITY_EXECUTOR_FAILURE != FIDELITY_VERDICT — a missing/invalid
  // aggregate is never itself an authority: it means no verdict could be
  // derived, which the caller must classify (PROVIDER_FAILURE vs
  // VALIDATOR_CAPABILITY_FAILURE) and may escalate to a fallback executor
  // for this SAME frozen task. Returning here — never throwing — keeps
  // EXECUTOR_IDENTITY != SEMANTIC_AUTHORITY: this function only reports
  // what happened, the orchestrator (materializarIntervencionVisible)
  // decides what to do about it.
  //
  // FIDELITY_REFERENCE_MISMATCH (this increment) is classified the SAME way
  // as any other non-derivable verdict -- VALIDATOR_CAPABILITY_FAILURE,
  // never REALIZACION_CONTRATO_NO_FIEL, never a semantic CAMBIA_WHAT/NO_FIEL
  // against the Realizer's draft. It reuses the exact same
  // fidelityTask.escalate() + fail-closed FIDELITY_EXECUTION_UNAVAILABLE
  // path materializarIntervencionVisible already has for any other
  // undeliverable verdict -- a mismatched reference IS "the executor ran but
  // its output does not satisfy the Fidelity contract" (clasificarFalloEjecutorFidelidad's
  // own existing definition), not a new failure category to invent.
  if (!['FIEL', 'CAMBIA_WHAT'].includes(verdict)) {
    return {
      veredicto: null, razon: null, fidelidadWhat: null, fidelidadViaAcceso: null, fidelidadLexica: null,
      fidelidadDisciplinaConversacional: null,
      executorFailureClass: clasificarFalloEjecutorFidelidad(r),
      referenceMismatch: referenceDeclarada && !referenceMatch,
      frozenReferenceFingerprint: fidelityReference.referenceFingerprint,
      returnedReferenceFingerprint: (parsed && parsed.referenceFingerprint) || null,
      referenceMatch,
    };
  }
  return {
    veredicto: verdict,
    razon: parsed.razon || null,
    fidelidadWhat: hasAxisVerdicts ? parsed.fidelidadWhat : null,
    fidelidadViaAcceso: hasAxisVerdicts ? parsed.fidelidadViaAcceso : null,
    fidelidadLexica: fidelidadLexicaDeclarada,
    fidelidadDisciplinaConversacional: disciplinaConversacionalDeclarada,
    executorFailureClass: null,
    referenceMismatch: false,
    frozenReferenceFingerprint: fidelityReference.referenceFingerprint,
    returnedReferenceFingerprint: (parsed && parsed.referenceFingerprint) || null,
    referenceMatch: true,
  };
}

/**
 * Materialización determinista de último recurso -- reemplaza al P3
 * anterior (textoDeterministaConectado), pero vive DENTRO de la frontera
 * y se compone desde el contrato real, nunca desde un template fijo de
 * dominio ("Por un lado... y, por otro...") ajeno al contenido de este
 * turno específico.
 */
function materializarDeterministaDesdeContrato(contrato) {
  const partesContenido = [];
  const c = contrato.contenido;
  if (c.observacion) partesContenido.push(c.observacion);
  if (c.resultado) partesContenido.push(c.detalle ? `${c.resultado}: ${c.detalle}` : c.resultado);
  const base = partesContenido.length > 0
    ? partesContenido.join(' ')
    : 'Sigo con lo que contaste.';
  const accionTipo = contrato.accionUsuario.tipo;
  if (accionTipo === 'ninguna') return base;
  // preguntaSugerida (cuando existe) ya es guía determinista de alta
  // confianza -- ProgresoConversacionalPolicy.construirNextUserAction, el
  // mismo mecanismo que antes de esta frontera vivía como
  // next_user_action.texto -- se prioriza sobre la pregunta genérica.
  const pregunta = (typeof c.preguntaSugerida === 'string' && c.preguntaSugerida.trim())
    ? c.preguntaSugerida
    : ({
        responder_pregunta: '¿Puedes contarme un poco más sobre eso?',
        confirmar: '¿Esto refleja bien lo que quisiste decir: lo confirmas, lo corriges o lo rechazas?',
        elegir_opcion: '¿Cuál de estas opciones se ajusta mejor?',
        dar_ejemplo: '¿Tienes un ejemplo concreto de esto?',
      }[accionTipo] || '¿Puedes contarme un poco más?');
  return `${base} ${pregunta}`;
}

/**
 * @param {object} params
 * @param {object} params.contrato — de createContratoIntervencion, nunca null.
 * @param {object} params.llmService — LLMService real.
 * @param {string|null} [params.turnoId]
 * @param {string} [params.callProfile] — default REALIZACION_CONVERSACIONAL.
 * @param {string|null} [params.mensajeUsuario] — FRONTERA_INTERVENCION_VISIBLE_1
 *   (corrección focal) — el mensaje real de ESTE turno, para que
 *   validarMaterializacion pueda distinguir vocabulario interno no ganado
 *   de una expresión que el propio experto ya usó (requerimiento I).
 * @returns {Promise<{ mensajeCirculo: string, origenMaterializacion: string, intentos: number }>}
 */
async function materializarIntervencionVisible({
  contrato, llmService, turnoId = null, callProfile = 'REALIZACION_CONVERSACIONAL', mensajeUsuario = null,
  // FIDELITY_EXECUTOR_FAILURE != FIDELITY_VERDICT — optional; defaults to a
  // coordinator with llmService as sole primary (no fallback), preserving
  // prior behavior byte for byte when the caller doesn't configure one.
  fidelityExecutionCoordinator = null,
  // C007 — REALIZER EXECUTION RECOVERY — optional; same default-to-no-
  // fallback discipline as fidelityExecutionCoordinator above.
  realizerExecutionCoordinator = null,
}) {
  if (!contrato) {
    throw new Error('materializarIntervencionVisible: contrato es obligatorio -- ningún productor tiene autoridad para producir mensajeCirculo sin él');
  }
  if (esReflejoSinGananciaCognitiva(contrato)) {
    throw new Error('SALIDA_VISIBLE_NO_DISPONIBLE: REFLEJO_SIN_WHAT_COGNITIVO');
  }

  // Estrategia 1 -- material candidato ya validable, cero llamadas nuevas.
  // materialCandidato por sí solo (contenido de Capa 1/Realizador previo)
  // históricamente NUNCA incluía la pregunta -- eso lo componía
  // componerMensajeFinal, por separado, con next_user_action.texto (ver
  // preguntaSugerida). Replicar esa misma composición aquí, como PRIMER
  // intento (antes de gastar una llamada nueva), preserva exactamente el
  // comportamiento previo cuando ya alcanza para cumplir el contrato.
  // Un WHAT cognitivo ya congelado nunca puede ejecutarse usando prosa de
  // Capa1 como sustituto, aunque esa prosa parezca superficialmente válida.
  // El candidato libre permanece disponible para contratos históricos sin
  // acto; todo acto canónico cruza Realizer + Fidelity.
  const candidato = !contrato.actoCognitivoVisible
    && typeof contrato.contenido.materialCandidato === 'string'
    ? contrato.contenido.materialCandidato.trim()
    : null;
  const preguntaSugerida = typeof contrato.contenido.preguntaSugerida === 'string'
    ? contrato.contenido.preguntaSugerida.trim()
    : null;
  if (candidato) {
    const viaAutorizada = contrato.accionUsuario && contrato.accionUsuario.viaAcceso;
    const preguntaContratada = viaAutorizada || !preguntaSugerida ? preguntaSugerida : null;
    const candidatoCompuesto = preguntaContratada ? `${candidato} ${preguntaContratada}` : candidato;
    const validacionCandidato = validarMaterializacion(candidatoCompuesto, contrato, mensajeUsuario);
    if (validacionCandidato.valido) {
      return { mensajeCirculo: candidatoCompuesto, origenMaterializacion: 'material_candidato_validado', intentos: 0 };
    }
  }

  const fidelityCoordinator = fidelityExecutionCoordinator
    || new ProducerExecutionCoordinator({ primary: llmService });
  // C007 — REALIZER EXECUTION RECOVERY. Same neutral abstraction already
  // reused for Producer and Fidelity -- no duplicated coordinator. Task
  // identity here is the frozen Contract itself: SAME_FROZEN_CONTRACT +
  // SAME cognitive act + DIFFERENT_REALIZER_EXECUTOR = SAME_COGNITIVE_
  // GOVERNANCE. Defaults to a coordinator with llmService as sole primary
  // (no fallback) when the caller doesn't configure one, preserving prior
  // behavior byte for byte.
  const realizerCoordinator = realizerExecutionCoordinator
    || new ProducerExecutionCoordinator({ primary: llmService });
  const realizerTask = realizerCoordinator.beginTask({ contrato, mensajeUsuario });
  let llmServiceRealizerActivo = realizerTask.current();

  // Estrategia 2 -- Realizador, hasta 2 intentos por executor. Un NO_FIEL
  // individual sigue causando el retry normal (mismo executor, mismo
  // Contract, causaReintento con la dimensión fallida). Solo agotar los 2
  // intentos de UN executor sin éxito habilita escalar al fallback --
  // nunca una re-decisión cognitiva, nunca un Contract distinto.
  let intentosTotales = 0;
  let mensajeExitoso = null;
  executorLoop: while (true) {
    let intentos = 0;
    let causaReintento = null;
    let ultimoResultado = null;
    while (intentos < 2) {
      const { system, userMsg } = buildRealizadorDesdeContrato(contrato, { causaReintento });
      const r = await llmServiceRealizerActivo.call({
        system, userMsg, label: 'realizador-contrato', callProfile, maxRetries: 1, turnoId,
        // DETERMINISTIC REPLAY CAPTURE (OBSERVABILITY_O2) -- investigated,
        // not assumed: buildRealizadorDesdeContrato's contract is a literal
        // JSON template embedded in prompt prose (`{"mensaje": "...",
        // "viaAccesoUsada": ...}`), never a JSON-schema object anywhere.
        // validarFidelidadViaAcceso (below) validates `viaAccesoUsada`
        // procedurally, and only conditionally (its requiredness depends on
        // contrato.contenido.validarViaAcceso, per-turn) -- not a fixed
        // shape safe to formalize as one reusable reference schema without
        // inventing one from the observed output, which the correction
        // explicitly forbids. Same genuine architectural fact as
        // realizador-conversacional (AgoraPrompts.buildRealizadorTurnoConversacional):
        // no schema object governs this call, observability-only.
        replaySchema: 'NONE',
      });
      intentos++; intentosTotales++;
      ultimoResultado = r;
      const mensaje = r.parsed && typeof r.parsed.mensaje === 'string' ? r.parsed.mensaje.trim() : null;
      const validacion = validarMaterializacion(mensaje, contrato, mensajeUsuario);
      const fidelidad = validarFidelidadViaAcceso(r.parsed, contrato);
      // C007 — NO REALIZATION CANDIDATE → NO FIDELITY TASK. Fidelity
      // evaluates a REALIZATION (this exact draft against the frozen
      // Contract) -- with no draft (Realizer transport/provider failure,
      // r.parsed null or mensaje empty), there is nothing for Fidelity to
      // evaluate: TRANSPORT_FAILURE_WITHOUT_DRAFT != SEMANTIC_FIDELITY_FAILURE.
      // Dispatching Fidelity anyway (as before) sent a real LLM call to
      // validate `mensaje: null`, manufacturing no verdict of substance and
      // adding pure downstream call pressure on every Realizer transport
      // failure -- confirmed live in human canary v12 T2 (3 cycles, 6 wasted
      // calls). `fidelidadSemantica` here is a neutral placeholder, never a
      // manufactured verdict: veredicto stays null (never 'FIEL' nor
      // 'CAMBIA_WHAT', so it can never satisfy the success check below nor
      // be misread as a semantic NO_FIEL), and it carries no
      // executorFailureClass, so the existing REALIZER_EXECUTOR_FAILURE
      // path below (line ~556, unchanged) is what continues to own recovery
      // -- never re-labeled as a Fidelity failure.
      let fidelidadSemantica = { veredicto: null, fidelidadWhat: null, fidelidadViaAcceso: null, fidelidadLexica: null, fidelidadDisciplinaConversacional: null };
      if (mensaje) {
        // SAME_FIDELITY_TASK + DIFFERENT_EXECUTOR -> SAME_GOVERNANCE. The task
        // identity is this exact draft/contract/evidence -- never the producer's
        // task, never re-derived. At most one escalation, only for an executor
        // failure (PROVIDER_FAILURE/VALIDATOR_CAPABILITY_FAILURE); a genuine
        // semantic rejection (CAMBIA_WHAT) never escalates the executor -- it
        // falls straight through to the existing same-Contract Realizer retry
        // below, unchanged.
        const fidelityTask = fidelityCoordinator.beginTask({ contrato, mensaje, mensajeUsuario });
        fidelidadSemantica = await validarFidelidadSemantica({
          mensaje, contrato, llmService: fidelityTask.current(), turnoId, mensajeUsuario,
          timeoutMs: FIDELITY_EXECUTION_DEADLINE_MS,
        });
        if (fidelidadSemantica.executorFailureClass
          && fidelityTask.escalate(fidelidadSemantica.executorFailureClass)) {
          fidelidadSemantica = await validarFidelidadSemantica({
            mensaje, contrato, llmService: fidelityTask.current(), turnoId, mensajeUsuario,
            timeoutMs: FIDELITY_EXECUTION_DEADLINE_MS,
          });
        }
      }
      if (fidelidadSemantica.executorFailureClass) {
        // Every available Fidelity executor failed for executor reasons --
        // never a semantic rejection. The draft that was produced (valid or
        // not) MUST_NOT_BECOME_VISIBLE without a real verdict. Fail closed.
        // `error.message` ('FIDELITY_EXECUTION_UNAVAILABLE') and
        // `error.executorFailureClass` are internal identity for the caller's
        // own logs/observability -- respuestaOperacionalFalloFidelity (below)
        // is the ONLY sanctioned translation of this error into anything a
        // human-facing surface may read; nothing here is that surface itself.
        const error = new Error('FIDELITY_EXECUTION_UNAVAILABLE');
        error.executorFailureClass = fidelidadSemantica.executorFailureClass;
        throw error;
      }
      if (validacion.valido && fidelidad.valido && fidelidadSemantica.veredicto === 'FIEL') {
        mensajeExitoso = mensaje;
        break executorLoop;
      }
      const viaContratada = contrato.accionUsuario && contrato.accionUsuario.viaAcceso;
      // VISIBLE_LANGUAGE_FIDELITY / VISIBLE_REALIZATION_DISCIPLINE — un
      // rechazo puramente en estas fronteras (WHAT y vía intactos) debe
      // retener el mismo Contract/WHAT y corregir solo HOW: nunca el mensaje
      // genérico de "cambió el WHAT", que orientaría mal el reintento hacia
      // algo que en este caso no ocurrió. Ambas fronteras pueden fallar a la
      // vez; el feedback nombra la dimensión fallida, nunca prescribe una
      // frase exacta (A6 — nunca dictar el texto de reemplazo).
      // PROPOSE_MISSION_CLOSURE_SINGLE_ACT_FIDELITY (C007, Daniel-adjudicated,
      // real evidence: logistica_c0 turn 29). Checked BEFORE the generic
      // whatYViaIntactos branching below, and independent of whether THIS
      // particular Fidelity call happened to classify the violation under
      // fidelidadWhat or fidelidadDisciplinaConversacional (real evidence:
      // that classification itself was inconsistent turn to turn) -- the
      // deterministic regex is the SAME one validarMaterializacion already
      // uses, so retry feedback and the fast gate never disagree about what
      // counts as a second act here.
      const segundoActoDeAvance = mensaje
        && contrato && contrato.actoCognitivoVisible
        && contrato.actoCognitivoVisible.operator === 'PROPOSE_MISSION_CLOSURE'
        && fidelidadSemantica.veredicto && fidelidadSemantica.veredicto !== 'FIEL'
        && violaSingleActoPropuestaCierre(mensaje, contrato);
      const whatYViaIntactos = fidelidadSemantica.veredicto === 'CAMBIA_WHAT'
        && fidelidadSemantica.fidelidadWhat === 'FIEL'
        && fidelidadSemantica.fidelidadViaAcceso === 'FIEL';
      const fallaLexica = whatYViaIntactos
        && fidelidadSemantica.fidelidadLexica === 'INTRODUCE_ETIQUETA_NO_AUTORIZADA';
      const fallaDisciplina = whatYViaIntactos
        && fidelidadSemantica.fidelidadDisciplinaConversacional === 'NO_FIEL';
      causaReintento = segundoActoDeAvance
        ? 'conserva exactamente la misma propuesta de cierre; corrige solo lo siguiente: la realización agregó un segundo acto sobre qué pasa DESPUÉS del cierre (mención de avanzar, continuar o seguir a otra parte/fase/gramática); eliminá esa mención por completo y expresá únicamente la propuesta de cerrar esta parte de la misión -- declarativa o interrogativamente, sin negociar el siguiente paso'
        : (fallaLexica || fallaDisciplina)
        ? [
            'conserva exactamente el mismo WHAT y vía; corrige solo lo siguiente:',
            fallaLexica
              ? 'la realización introdujo una etiqueta, conceptualización de dominio o registro léxico más elevado que no aportaba claridad necesaria; redacta con el registro léxico del experto disponible o lenguaje llano, sin esa sustitución'
              : null,
            fallaDisciplina
              ? 'la realización agregó material conversacional sin función en el acto contratado (recapitulación innecesaria de lo que el experto ya dijo, lenguaje sobre el propio proceso de Círculo, o la misma necesidad expresada más de una vez); exprésala de forma directa y suficiente para ejecutar el acto, sin ese material añadido'
              : null,
          ].filter(Boolean).join(' ')
        : fidelidadSemantica.veredicto === 'CAMBIA_WHAT'
        ? (viaContratada
          ? `la realización incumplió el WHAT o su vía; conserva el mismo WHAT y aplica exactamente la vía autorizada ${viaContratada} únicamente al mismo target y evidencia esperada`
          : 'la realización cambió el WHAT contratado; expresa nuevamente el mismo contrato sin introducir una vía de acceso material')
        : (!fidelidad.valido ? fidelidad.motivo : validacion.motivo);
    }
    // Both bounded attempts on THIS executor exhausted without a FIEL
    // verdict -- REALIZER_CAPABILITY_EXHAUSTED_ON_VALID_CONTRACT. Never a
    // cognitive re-decision: same Contract, same governed act. Escalate the
    // EXECUTOR only, exactly once (ProducerExecutionCoordinator's own bound).
    const providerFailure = !ultimoResultado || !ultimoResultado.parsed;
    const failureClass = providerFailure
      ? PRODUCER_FAILURE_CLASSES.PROVIDER_FAILURE
      : PRODUCER_FAILURE_CLASSES.PRODUCER_CAPABILITY_FAILURE;
    if (realizerTask.escalate(failureClass)) {
      llmServiceRealizerActivo = realizerTask.current();
      continue executorLoop;
    }
    break executorLoop;
  }

  if (mensajeExitoso) {
    return { mensajeCirculo: mensajeExitoso, origenMaterializacion: 'realizador', intentos: intentosTotales };
  }

  if (!contrato.actoCognitivoVisible
    && !(contrato.contenido && (contrato.contenido.validarViaAcceso === true
      || contrato.contenido.fidelidadVisibleRequerida === true))) {
    return {
      mensajeCirculo: materializarDeterministaDesdeContrato(contrato),
      origenMaterializacion: 'fallback_determinista',
      intentos: intentosTotales,
    };
  }
  throw new Error('REALIZACION_CONTRATO_NO_FIEL');
}

// C007 human canary v6/v7/v8 — PUBLIC FAILURE SURFACE. Única copia humana
// compartida por cada traducción de un fallo interno de arquitectura
// (Fidelity aquí; producer/frontier en InteraccionCognitivaWriter.js) hacia
// una superficie que el usuario puede leer. Nunca el código interno
// (FIDELITY_EXECUTION_UNAVAILABLE, COGNITIVE_PRODUCER_FAILED_WITHIN_ADMISSIBLE_FRONTIER,
// NO_COGNITIVE_ACT_AVAILABLE, CONTRATO_INVALIDO...) llega literalmente aquí.
const MENSAJE_OPERACIONAL_FALLO_GENERICO = 'No pude completar esta respuesta. Intenta de nuevo en un momento.';

/**
 * Única traducción sancionada de un fallo FIDELITY_EXECUTION_UNAVAILABLE a
 * algo que una superficie humana puede leer. Reutiliza exactamente la misma
 * forma { ok, httpStatus, codigo, mensaje } que ya usa cualquier otro fallo
 * de InteraccionCognitivaWriter (p.ej. NO_COGNITIVE_ACT_AVAILABLE) — nunca
 * un mecanismo de presentación de error nuevo. `codigo`/`executorFailureClass`
 * son identidad interna para logs/observabilidad de quien la reciba; SOLO
 * `mensaje` es apto para una superficie humana. No genera una respuesta
 * cognitiva sustituta ni reintroduce el draft no validado.
 */
function respuestaOperacionalFalloFidelity(error) {
  return {
    ok: false,
    httpStatus: 502,
    codigo: 'FIDELITY_EXECUTION_UNAVAILABLE',
    mensaje: MENSAJE_OPERACIONAL_FALLO_GENERICO,
    executorFailureClass: (error && error.executorFailureClass) || null,
  };
}

module.exports = {
  materializarIntervencionVisible,
  esReflejoSinGananciaCognitiva,
  validarMaterializacion,
  validarFidelidadSemantica,
  materializarDeterministaDesdeContrato,
  clasificarFalloEjecutorFidelidad,
  respuestaOperacionalFalloFidelity,
  MENSAJE_OPERACIONAL_FALLO_GENERICO,
  FIDELITY_EXECUTION_DEADLINE_MS,
  construirFidelityReferenceProjection,
  proyectarContextoLegadoParaFidelidad, CAMPOS_LEGADOS_ACT_LIKE_FIDELIDAD, BLOQUE_REFERENCIA_CANONICA_EXCLUSIVA,
  FIDELITY_RESPONSE_SCHEMA,
};
