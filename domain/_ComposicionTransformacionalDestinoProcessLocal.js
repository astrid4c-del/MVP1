'use strict';

/**
 * Runtime privado del compositor de AfirmacionTransformacionalDestino.
 *
 * Responsabilidad exacta: producir la candidata estructurada (Composicion)
 * a partir de comprensión YA reconocida en el grafo — nunca decide
 * confirmación, autorización, sucesión ni proyección. Esas siguen siendo
 * decisiones exclusivas del lifecycle/orquestador ya existentes (D1.7-C1,
 * CicloTransformacionalDestinoOrquestacion) y de este runtime NUNCA se sale
 * un id, una version, un reformulaAId ni un reemplazaAId — quien los decide
 * es siempre el llamador de crearPropuestaDesdeComposicionTransformacional.
 *
 * Decisión de diseño (auditoría previa): NO requiere LLM. El grafo de
 * conocimiento ya organiza, para la gramática 'destino', sus conceptos por
 * dimensión (procedencia `slot:<dimension>`, ver GrafoProyeccion.js) — y las
 * cuatro dimensiones de 'destino' (antes/conocimiento/despues/evidencia,
 * AgoraSlots.js) corresponden exactamente a los cuatro roles causales que
 * AfirmacionTransformacionalDestino.constituyentes ya exige
 * (inicio/mecanismo/resultado/observabilidad). La formulación se construye
 * por plantilla determinística a partir de esa estructura — nunca al revés
 * (texto libre → estructura inventada) — así que no hay salida de modelo
 * que validar ni JSON externo que aceptar.
 *
 * Este archivo no es una superficie de dominio. Las fachadas públicas
 * (CompositorTransformacionalDestinoPolicy.js) exponen las dos operaciones
 * estrechas; nunca el WeakSet de legitimidad ni los validadores internos.
 */

const crypto = require('crypto');
const {
  conceptosDeGramatica, sintesisRechazadasDeGramatica, coberturaCompleta, dimensionDeProcedencia,
  dimensionesConIncertidumbresRelevantes,
} = require('../state/GrafoProyeccion');
const { crearPropuestaTransformacional } = require('./AfirmacionTransformacionalDestinoDomain');
const schema = require('../schemas/ComposicionTransformacionalDestino');
// Plantilla mecánica compartida con _HipotesisTransformacionalDestinoProcessLocal.js
// — una sola fuente, nunca dos copias que puedan divergir.
const { construirFormulacionDesdeEstructura } = require('./_FormulacionTransformacionalDestinoTemplate');

const composicionesLegitimas = new WeakSet();
const evaluacionesLegitimas = new WeakSet();

const GRAMATICA_SOPORTADA = 'destino';

/**
 * Catálogo cerrado de causas de bloqueo relacional — evaluarRelacionTransformacionalDestinoInterna.
 *
 * Auditoría previa (sesión anterior): mecanismo/observabilidad/relación
 * global SÍ tienen una comprobación estructural real y no fabricada
 * disponible hoy — grafo.relaciones (VALID_RELATION_TYPES,
 * GrafoConocimientoPolicy.aplicarDelta) — pero el contrato JSON real de
 * 'destino' (AgoraPrompts.js) nunca solicita `relacionesNuevas`: hoy esa
 * comprobación siempre falla, no por diseño de este evaluador sino porque
 * el productor upstream (la conversación real) nunca puebla esa parte del
 * grafo. Si algún incremento futuro empieza a poblarla, este evaluador
 * empieza a aprobar esas causas sin que haga falta tocarlo.
 *
 * concreción del resultado (RESULTADO_NO_CONCRETO) es la única causa sin
 * ningún productor estructural concebible hoy: ningún campo distingue una
 * capacidad observable concreta de una aspiración/estado deseado — ambas
 * llegan como `descripcion` de texto libre, indistinguibles sin interpretar
 * el texto (prohibido: ver restricciones de esta ronda).
 */
const CAUSAS_BLOQUEO_RELACIONAL = Object.freeze({
  MECANISMO_NO_DEMOSTRADO: {
    productorFaltante: 'grafo.relaciones nunca conecta un concepto de dimensión "antes" con uno de '
      + '"conocimiento" — VALID_RELATION_TYPES ya admite tipos aptos (requiere/precede/produce) y '
      + 'GrafoConocimientoPolicy.aplicarDelta ya sabe crearlas, pero el contrato JSON real de \'destino\' '
      + '(AgoraPrompts.js) nunca solicita relacionesNuevas — falta ese productor upstream, no una '
      + 'estructura nueva.',
  },
  RESULTADO_NO_CONCRETO: {
    productorFaltante: 'ningún campo estructural distingue una capacidad observable concreta de una '
      + 'aspiración/estado deseado en "despues" — se necesitaría un productor upstream que etiquete '
      + 'esa distinción explícitamente (p.ej. un tipo de concepto o relación "ejemplifica" hacia un '
      + 'caso_real); hoy no existe en ningún punto del sistema.',
  },
  OBSERVABILIDAD_NO_DEMOSTRADA: {
    productorFaltante: 'grafo.relaciones nunca conecta un concepto de "despues" con uno de "evidencia" '
      + '— mismo productor faltante que MECANISMO_NO_DEMOSTRADO. Nota: D1.7-B '
      + '(BaseDefendibleDestinoPolicy.js) ya declara esta MISMA causa, de forma independiente, sobre la '
      + 'afirmación ya autorizada — confirma que la ausencia es real y no exclusiva de este evaluador.',
  },
  RELACION_NO_DEMOSTRADA: {
    productorFaltante: 'grafo.relaciones nunca conecta un concepto de "conocimiento" con uno de '
      + '"despues" — el enlace causal central (mecanismo→resultado). Mismo productor faltante que '
      + 'MECANISMO_NO_DEMOSTRADO.',
  },
});

// Única correspondencia dimensión→rol causal — ver cabecera. No se deriva
// de ningún otro lugar del sistema porque hoy no existe (auditoría,
// sección 3): esta es la primera vez que ambos vocabularios se conectan.
const DIMENSION_A_ROL = Object.freeze({
  antes: 'inicio',
  conocimiento: 'mecanismo',
  despues: 'resultado',
  evidencia: 'observabilidad',
});

function congelarProfundo(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(congelarProfundo);
  return Object.freeze(value);
}

function diagnostico(resultado, hechos = {}) {
  return congelarProfundo({ resultado, diagnostico: { ...hechos } });
}

function conceptosExpertoDeDimension(grafoActual, dimension) {
  return conceptosDeGramatica(grafoActual, GRAMATICA_SOPORTADA)
    .filter(c => dimensionDeProcedencia(c.procedencia) === dimension && c.autoridad === 'experto');
}

function conceptosRechazadosDeDimension(grafoActual, dimension) {
  return (grafoActual.conceptos || []).filter(
    c => dimensionDeProcedencia(c.procedencia) === dimension && c.rechazado === true,
  );
}

/** Todos los conceptos de una dimensión, sin filtrar por autoridad ni vigencia. */
function todosConceptosDeDimension(grafoActual, dimension) {
  return (grafoActual.conceptos || []).filter(c => dimensionDeProcedencia(c.procedencia) === dimension);
}

/**
 * Distingue, para una dimensión, el conjunto vigente (activo && 'experto')
 * de lo excluido — y POR QUÉ. Estructural, nunca textual:
 *   RECHAZADO   — rechazado===true (Reconciliación: inferenciasRechazadas,
 *                  solo actúa sobre 'inferido' — Círculo propuso, el experto dijo no).
 *   OBSOLETO    — activo===false && rechazado!==true (Construcción:
 *                  marcarObsoletos — el experto contradijo o corrigió algo
 *                  que SÍ había sido 'experto'; nunca fue "rechazado").
 *   PENDIENTE_RECONOCIMIENTO — activo && autoridad==='inferido' (todavía no
 *                  confirmado ni rechazado).
 * Estas tres causas son estructuralmente distinguibles hoy — nunca
 * indistinguibles (corrección del hallazgo de la auditoría anterior).
 */
function vigenciaDeDimension(grafoActual, dimension) {
  const todos = todosConceptosDeDimension(grafoActual, dimension);
  const vigentes = todos.filter(c => c.activo && c.autoridad === 'experto');
  const excluidos = todos
    .filter(c => !(c.activo && c.autoridad === 'experto'))
    .map(c => {
      let causa;
      if (c.rechazado === true) causa = 'RECHAZADO';
      else if (c.activo === false) causa = 'OBSOLETO';
      else causa = 'PENDIENTE_RECONOCIMIENTO';
      return Object.freeze({ conceptoId: c.id, descripcion: c.descripcion, causa });
    });
  return Object.freeze({
    conceptoIds: Object.freeze(vigentes.map(c => c.id)),
    excluidos: Object.freeze(excluidos),
  });
}

/**
 * Única comprobación REAL y no fabricada disponible hoy para un enlace
 * causal entre dos conjuntos de conceptos: ¿existe una relación ACTIVA
 * (grafo.relaciones, cualquier VALID_RELATION_TYPES) cuyo origen y destino
 * caigan, en cualquier orden, uno en cada conjunto? Estructural — nunca lee
 * `descripcion` ni interpreta texto. Devuelve también las relaciones
 * encontradas, para diagnóstico.
 */
function relacionActivaEntre(grafoActual, idsA, idsB) {
  const A = new Set(idsA);
  const B = new Set(idsB);
  const encontradas = (grafoActual.relaciones || []).filter(r => r && r.activo !== false && (
    (A.has(r.origen) && B.has(r.destino)) || (A.has(r.destino) && B.has(r.origen))
  ));
  return { demostrado: encontradas.length > 0, relaciones: encontradas };
}

/**
 * Componentes REALES usados para la huella — nunca inventados. Documentado
 * honestamente (sección 5 del encargo):
 *   - conceptoIds vigentes por dimensión (grafo.conceptos[].id).
 *   - estado de vigencia de cada uno (autoridad, activo) — no solo el id:
 *     dos snapshots con los MISMOS ids pero autoridad/activo distintos
 *     producen huellas distintas.
 *   - grafoActualizadoEn: KnowledgeGraph.actualizadoEn (timestamp de la
 *     última mutación real del grafo, GrafoConocimientoPolicy) — la única
 *     señal de "revisión de grafo" que el sistema realmente persiste hoy.
 *     Es un timestamp, NUNCA un contador monótono — se documenta como tal,
 *     nunca como una "revisión" inventada.
 * NO incluye (porque no existen en esta capa, y no se fabrican):
 *   - revisión de CognitiveState (el compositor no recibe el estado, solo
 *     el grafo — ver componerAfirmacionTransformacionalDestinoInterna).
 *   - turnoClienteId (pertenece al wiring del Writer, fuera de alcance).
 * Un futuro wiring que necesite esas dos señales debe pasarlas como
 * parámetros adicionales explícitos — nunca inventarlas aquí.
 */
function componentesSnapshot(grafoActual, vigenciaPorRol) {
  const porDimension = {};
  Object.entries(DIMENSION_A_ROL).forEach(([dimension, rol]) => {
    porDimension[dimension] = vigenciaPorRol[rol].conceptoIds.map(id => {
      const concepto = (grafoActual.conceptos || []).find(c => c.id === id);
      return { conceptoId: id, autoridad: concepto ? concepto.autoridad : null, activo: concepto ? !!concepto.activo : null };
    });
  });
  return {
    grafoActualizadoEn: grafoActual.actualizadoEn || null,
    porDimension,
  };
}

function huellaCompositiva(componentes) {
  const canonico = {
    grafoActualizadoEn: componentes.grafoActualizadoEn,
    porDimension: Object.keys(componentes.porDimension).sort().map(dim => ({
      dimension: dim,
      conceptos: [...componentes.porDimension[dim]]
        .sort((a, b) => a.conceptoId.localeCompare(b.conceptoId)),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonico)).digest('hex');
}

/**
 * Estabilidad de una dimensión — estructural, nunca textual. Distingue tres
 * señales reales, nunca fusionadas:
 *   INCERTIDUMBRE_ABIERTA    — dimensionesConIncertidumbresRelevantes ya
 *                              marca esta dimensión como todavía en disputa,
 *                              tenga o no anclaje vigente hoy.
 *   RECHAZADO_EXPLICITAMENTE — cero conceptos vigentes, y todo lo excluido
 *                              para esta dimensión fue RECHAZADO (el experto
 *                              dijo que no) — nunca confundido con obsolescencia.
 *   OBSOLETO_POR_CORRECCION  — cero conceptos vigentes, y todo lo excluido
 *                              fue OBSOLETO (una corrección posterior lo
 *                              reemplazó) — nunca confundido con rechazo.
 * Precedencia cuando coexisten: INCERTIDUMBRE_ABIERTA > RECHAZADO > OBSOLETO
 * (documentada, no arbitraria: una incertidumbre abierta es la señal más
 * urgente porque implica que ni siquiera hay consenso sobre la exclusión).
 * Ausencia total de historial (nunca se tocó la dimensión) devuelve null —
 * eso es COMPRENSION_INSUFICIENTE genérica, no inestabilidad.
 */
function estabilidadDeDimension(grafoActual, dimension, dimensionesConIncertidumbre, vigenciaInfo) {
  if (dimensionesConIncertidumbre.includes(dimension)) return 'INCERTIDUMBRE_ABIERTA';
  if (vigenciaInfo.conceptoIds.length > 0) return null;
  if (vigenciaInfo.excluidos.length === 0) return null;
  if (vigenciaInfo.excluidos.some(e => e.causa === 'RECHAZADO')) return 'RECHAZADO_EXPLICITAMENTE';
  if (vigenciaInfo.excluidos.some(e => e.causa === 'OBSOLETO')) return 'OBSOLETO_POR_CORRECCION';
  return null; // únicamente PENDIENTE_RECONOCIMIENTO — todavía no es inestabilidad, es insuficiencia.
}

/**
 * evaluarRelacionTransformacionalDestinoInterna — capacidad de evaluación
 * exigida por el incremento: determina, con datos estructurales reales
 * (nunca texto interpretado, nunca regex, nunca LLM), qué puede y qué no
 * puede certificarse hoy sobre la relación transformacional de una sesión.
 *
 * `resultado` es 'RELACION_TRANSFORMACIONAL_INSUFICIENTE' siempre que
 * `causasBloqueo` no esté vacío — y hoy SIEMPRE lo tendrá al menos con
 * RESULTADO_NO_CONCRETO (sin productor estructural concebible, ver
 * CAUSAS_BLOQUEO_RELACIONAL), así que la certificación completa nunca puede
 * aprobarse con el modelo de datos actual: 'RELACION_TRANSFORMACIONAL_SUFICIENTE'
 * existe como valor legítimo del contrato, pero es inalcanzable hoy — nunca
 * se fabrica, nunca se fuerza. Lo que SÍ varía, genuinamente, de una sesión
 * a otra: vigencia, causas de exclusión, estabilidad por dimensión y las
 * otras tres causas de bloqueo relacional (MECANISMO/OBSERVABILIDAD/
 * RELACION), que SÍ tienen una comprobación real vía grafo.relaciones y
 * empezarían a aprobarse solas si algún día existe un productor upstream
 * que las pueble.
 */
function evaluarRelacionTransformacionalDestinoInterna({ sesionId, grafoActual, gramatica } = {}) {
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('evaluarRelacionTransformacionalDestino: sesionId es obligatorio');
  }
  if (gramatica !== GRAMATICA_SOPORTADA) {
    throw new Error(`evaluarRelacionTransformacionalDestino: GRAMATICA_NO_SOPORTADA '${gramatica}'`);
  }
  if (!grafoActual || typeof grafoActual !== 'object' || !Array.isArray(grafoActual.conceptos)) {
    throw new Error('evaluarRelacionTransformacionalDestino: grafoActual inválido');
  }

  const vigencia = {};
  const porDimensionIds = {};
  for (const dimension of Object.keys(DIMENSION_A_ROL)) {
    const rol = DIMENSION_A_ROL[dimension];
    const v = vigenciaDeDimension(grafoActual, dimension);
    vigencia[rol] = v;
    porDimensionIds[dimension] = v.conceptoIds;
  }

  // Estabilidad: una incertidumbre relevante todavía abierta, un rechazo
  // explícito o una obsolescencia por corrección sin reemplazo vigente son
  // las tres señales estructurales reales (ya existentes en GrafoProyeccion.js/
  // GrafoConocimientoPolicy.js) de que el contenido de una dimensión sigue
  // en disputa — el riesgo de staleness demostrado empíricamente en la
  // auditoría anterior (componer sobre contenido a punto de corregirse o
  // contradecirse).
  const dimensionesConIncertidumbre = dimensionesConIncertidumbresRelevantes(grafoActual, GRAMATICA_SOPORTADA);
  const estabilidadPorDimension = {};
  Object.keys(DIMENSION_A_ROL).forEach(dimension => {
    const rol = DIMENSION_A_ROL[dimension];
    estabilidadPorDimension[dimension] = estabilidadDeDimension(
      grafoActual, dimension, dimensionesConIncertidumbre, vigencia[rol],
    );
  });
  const dimensionesInestables = Object.entries(estabilidadPorDimension)
    .filter(([, causa]) => causa !== null)
    .map(([dimension, causa]) => Object.freeze({ dimension, causa }));

  const mecanismo = relacionActivaEntre(grafoActual, porDimensionIds.antes, porDimensionIds.conocimiento);
  const relacionGlobal = relacionActivaEntre(grafoActual, porDimensionIds.conocimiento, porDimensionIds.despues);
  const observabilidad = relacionActivaEntre(grafoActual, porDimensionIds.despues, porDimensionIds.evidencia);

  const causasBloqueo = [];
  if (!mecanismo.demostrado) causasBloqueo.push({ codigo: 'MECANISMO_NO_DEMOSTRADO', ...CAUSAS_BLOQUEO_RELACIONAL.MECANISMO_NO_DEMOSTRADO });
  // RESULTADO_NO_CONCRETO: sin condición — ver docstring, no tiene productor concebible hoy.
  causasBloqueo.push({ codigo: 'RESULTADO_NO_CONCRETO', ...CAUSAS_BLOQUEO_RELACIONAL.RESULTADO_NO_CONCRETO });
  if (!observabilidad.demostrado) causasBloqueo.push({ codigo: 'OBSERVABILIDAD_NO_DEMOSTRADA', ...CAUSAS_BLOQUEO_RELACIONAL.OBSERVABILIDAD_NO_DEMOSTRADA });
  if (!relacionGlobal.demostrado) causasBloqueo.push({ codigo: 'RELACION_NO_DEMOSTRADA', ...CAUSAS_BLOQUEO_RELACIONAL.RELACION_NO_DEMOSTRADA });

  const componentes = componentesSnapshot(grafoActual, vigencia);
  const snapshot = Object.freeze({
    sesionId,
    gramatica: GRAMATICA_SOPORTADA,
    huella: huellaCompositiva(componentes),
    grafoActualizadoEn: componentes.grafoActualizadoEn,
    dimensiones: Object.freeze(Object.fromEntries(
      Object.entries(porDimensionIds).map(([dim, ids]) => [dim, Object.freeze([...ids])]),
    )),
  });

  const evaluacion = congelarProfundo({
    resultado: causasBloqueo.length > 0
      ? 'RELACION_TRANSFORMACIONAL_INSUFICIENTE'
      : 'RELACION_TRANSFORMACIONAL_SUFICIENTE',
    vigencia,
    estabilidad: {
      estable: dimensionesInestables.length === 0,
      dimensionesInestables,
    },
    causasBloqueo,
    snapshot,
  });
  evaluacionesLegitimas.add(evaluacion);
  return evaluacion;
}

// construirFormulacionDesdeEstructura ahora vive en
// _FormulacionTransformacionalDestinoTemplate.js (importado arriba) —
// compartida con _HipotesisTransformacionalDestinoProcessLocal.js. Solo se
// alcanza aquí cuando evaluarRelacionTransformacionalDestinoInterna declaró
// la relación SUFICIENTE — ver componerAfirmacionTransformacionalDestinoInterna.

/**
 * Compone una candidata a AfirmacionTransformacionalDestino a partir del
 * grafo de conocimiento ya reconocido de la sesión — determinística, sin
 * llamada LLM, sin efectos secundarios (no escribe en el grafo, no concede
 * autoridad, no promueve conceptos).
 *
 * Flujo exacto exigido por el contrato original (corrección de bb6dcdb):
 *   snapshot cognitivo estable → seleccionar conceptos vigentes → construir
 *   estructura candidata → evaluar relación transformacional → SOLO SI la
 *   relación es suficiente: construir formulación → acuñar composición.
 * `RELACION_TRANSFORMACIONAL_INSUFICIENTE` (mecanismo/resultado/
 * observabilidad/relación global no demostrados) y
 * `RELACION_TRANSFORMACIONAL_INESTABLE` (staleness/rechazo/obsolescencia)
 * detienen el flujo ANTES de construirFormulacionDesdeEstructura y ANTES de
 * acuñar nada en `composicionesLegitimas` — nunca como anexo posterior.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual — KnowledgeGraph, contexto 'vivo'
 * @param {string} params.gramatica — únicamente 'destino' en este incremento
 * @returns {{ resultado: string, tipo?: string, causas?: object[], composicion?: object, diagnostico?: object }}
 */
function componerAfirmacionTransformacionalDestinoInterna({ sesionId, grafoActual, gramatica } = {}) {
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    return diagnostico('COMPRENSION_INSUFICIENTE', { codigo: 'SESION_SIN_IDENTIDAD' });
  }
  if (gramatica !== GRAMATICA_SOPORTADA) {
    return diagnostico('COMPRENSION_INSUFICIENTE', {
      codigo: 'GRAMATICA_NO_SOPORTADA', gramatica: gramatica || null,
    });
  }
  if (!grafoActual || typeof grafoActual !== 'object' || !Array.isArray(grafoActual.conceptos)) {
    return diagnostico('COMPRENSION_INSUFICIENTE', { codigo: 'GRAFO_INVALIDO' });
  }

  // Evaluación de relación transformacional (capacidad real, ver
  // evaluarRelacionTransformacionalDestinoInterna arriba) — corre ANTES de
  // cualquier otra cosa. Snapshot estable primero: una incertidumbre
  // relevante todavía abierta, un rechazo explícito o una obsolescencia sin
  // reemplazo vigente sobre una dimensión de 'destino' bloquean AQUÍ, con
  // el diagnóstico preciso de estabilidad — nunca llegan a
  // coberturaCompleta ni a la construcción de estructura.
  const evaluacionRelacional = evaluarRelacionTransformacionalDestinoInterna({ sesionId, grafoActual, gramatica });
  if (!evaluacionRelacional.estabilidad.estable) {
    return diagnostico('RELACION_TRANSFORMACIONAL_INESTABLE', {
      codigo: 'DIMENSION_INESTABLE',
      dimensionesInestables: evaluacionRelacional.estabilidad.dimensionesInestables.map(d => ({ ...d })),
    });
  }

  // Fuente ÚNICA de suficiencia semántica — la misma que ya gobierna
  // ProgresoConversacionalPolicy.decidirProtocolo (dimensionesPendientes/
  // coberturaCompleta, GrafoProyeccion.js). El compositor no inventa una
  // segunda regla de cobertura: si el protocolo todavía no considera esta
  // gramática semánticamente suficiente, el compositor tampoco puede.
  // Alcanzado solo cuando ninguna dimensión está en disputa (arriba) pero
  // alguna sigue sin NINGÚN historial (nunca se tocó) — el residual
  // genuinamente genérico.
  if (!coberturaCompleta(grafoActual, GRAMATICA_SOPORTADA)) {
    return diagnostico('COMPRENSION_INSUFICIENTE', {
      codigo: 'DIMENSIONES_SIN_SUFICIENCIA_SEMANTICA',
    });
  }

  // Estructura candidata — construida siempre que hay anclaje vigente
  // estable, ANTES de decidir si la relación es suficiente (así lo exige el
  // contrato: "construir estructura candidata → evaluar relación"). Nunca
  // se convierte en formulación ni en composición si el paso siguiente
  // bloquea.
  const estructura = {};
  const procedencia = {};
  for (const [dimension, rol] of Object.entries(DIMENSION_A_ROL)) {
    const conceptos = conceptosExpertoDeDimension(grafoActual, dimension);
    // Redundante con coberturaCompleta arriba por construcción (ambas leen
    // la misma fuente) — defensivo, nunca sustituye la comprobación real.
    if (conceptos.length === 0) {
      return diagnostico('COMPRENSION_INSUFICIENTE', {
        codigo: 'DIMENSION_SIN_ANCLAJE_EXPERTO', dimension,
      });
    }
    const conceptoIds = Object.freeze(conceptos.map(c => c.id));
    estructura[rol] = Object.freeze({
      conceptoIds,
      descripcionResumen: conceptos.map(c => c.descripcion).join('. '),
      autoridadOrigen: 'experto',
    });
    procedencia[rol] = Object.freeze({
      dimension,
      conceptoIds,
      autoridades: Object.freeze(conceptos.map(() => 'experto')),
    });
  }

  // GATE CENTRAL de esta corrección: si la relación transformacional no fue
  // demostrada (mecanismo/resultado/observabilidad/relación global), el
  // flujo TERMINA aquí — nunca se llama construirFormulacionDesdeEstructura,
  // nunca se acuña nada en composicionesLegitimas, nunca se devuelve una
  // ComposicionTransformacionalDestino. La estructura candidata y la
  // evaluación viajan solo como diagnóstico, explícitamente NUNCA
  // etiquetadas como composición válida.
  if (evaluacionRelacional.causasBloqueo.length > 0) {
    return Object.freeze({
      resultado: 'RELACION_TRANSFORMACIONAL_INSUFICIENTE',
      tipo: 'RELACION_TRANSFORMACIONAL_INSUFICIENTE',
      causas: evaluacionRelacional.causasBloqueo,
      diagnostico: Object.freeze({
        codigo: 'RELACION_TRANSFORMACIONAL_NO_DEMOSTRADA',
        estructuraCandidata: estructura,
        evaluacionRelacional,
      }),
    });
  }

  const formulacionPropuesta = construirFormulacionDesdeEstructura(estructura);

  // Memoria negativa (sección 8/9): ni la formulación completa ni el
  // resumen de una dimensión pueden reproducir, literalmente, una
  // interpretación que el experto ya rechazó para esa misma dimensión —
  // comprobación estructural (coincidencia exacta de texto), nunca
  // semántica ni basada en listas de frases (sección 15).
  const restriccionesConsultadas = [];
  for (const [dimension, rol] of Object.entries(DIMENSION_A_ROL)) {
    const rechazados = conceptosRechazadosDeDimension(grafoActual, dimension);
    rechazados.forEach(c => restriccionesConsultadas.push({
      dimension, conceptoId: c.id, descripcion: c.descripcion, porQueRechazado: c.porQueRechazado || null,
    }));
    const reproduceRechazo = rechazados.some(c => c.descripcion === estructura[rol].descripcionResumen);
    if (reproduceRechazo) {
      return diagnostico('MEMORIA_NEGATIVA_REPRODUCIDA', {
        codigo: 'DIMENSION_REPRODUCE_INTERPRETACION_RECHAZADA', dimension,
      });
    }
  }
  const sintesisRechazadas = sintesisRechazadasDeGramatica(grafoActual, GRAMATICA_SOPORTADA);
  sintesisRechazadas.forEach(c => restriccionesConsultadas.push({
    dimension: null, conceptoId: c.id, descripcion: c.descripcion, porQueRechazado: c.porQueRechazado || null,
  }));
  if (sintesisRechazadas.some(c => c.descripcion === formulacionPropuesta)) {
    return diagnostico('MEMORIA_NEGATIVA_REPRODUCIDA', {
      codigo: 'FORMULACION_REPRODUCE_SINTESIS_RECHAZADA',
    });
  }

  const composicion = congelarProfundo({
    sesionId,
    gramatica: GRAMATICA_SOPORTADA,
    estructura,
    formulacionPropuesta,
    procedencia,
    restriccionesConsultadas,
    // Alcanzado solo cuando evaluacionRelacional.causasBloqueo === [] — esta
    // composición SÍ tiene su relación transformacional demostrada. El
    // anexo documenta CÓMO se demostró, nunca sirve para "componer de todos
    // modos" (eso ya se decidió arriba, antes de llegar aquí).
    evaluacionRelacional,
  });

  const validacion = schema.validarComposicionTransformacionalDestino(composicion);
  if (!validacion.valid) {
    // No debería alcanzarse nunca (la construcción de arriba ya respeta el
    // contrato) — pero si el schema evoluciona sin este runtime, falla alto
    // en vez de acuñar una composición inválida.
    throw new Error(`ComposicionTransformacionalDestino inválida — ${validacion.errors.join('; ')}`);
  }

  composicionesLegitimas.add(composicion);
  return { resultado: 'COMPOSICION_VALIDA', composicion };
}

/**
 * Integración mínima permitida (sección 13): traduce una Composicion
 * legítima en los parámetros de crearPropuestaTransformacional — nunca
 * persiste, nunca materializa, nunca transiciona el protocolo. id/version/
 * reformulaAId/cabezaBaseId/cabezaBaseRevision los decide EXCLUSIVAMENTE el
 * llamador (el orquestador ya existente) — nunca el compositor.
 *
 * @param {object} params
 * @param {object} params.composicion — debe venir de componerAfirmacionTransformacionalDestinoInterna
 * @param {string} params.id
 * @param {number} params.version
 * @param {string} params.turnoId — origen.propuestaEnTurnoId
 * @param {string} [params.reformulaAId]
 * @param {string|null} [params.cabezaBaseId]
 * @param {number|null} [params.cabezaBaseRevision]
 * @returns {object} PROPUESTA congelada (mismo contrato que crearPropuestaTransformacional)
 */
function crearPropuestaDesdeComposicionTransformacionalInterna({
  composicion, id, version, turnoId, reformulaAId, cabezaBaseId, cabezaBaseRevision,
} = {}) {
  if (!composicion || typeof composicion !== 'object' || !composicionesLegitimas.has(composicion)) {
    throw new Error('crearPropuestaDesdeComposicionTransformacional: COMPOSICION_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  const { estructura, formulacionPropuesta } = composicion;
  // Consistencia estructura↔formulación, verificada de nuevo aquí (nunca
  // solo confiada al momento de componer): si algo alteró `composicion`
  // entre componer y este punto, la reconstrucción ya no coincidiría.
  if (construirFormulacionDesdeEstructura(estructura) !== formulacionPropuesta) {
    throw new Error('crearPropuestaDesdeComposicionTransformacional: FORMULACION_INCONSISTENTE_CON_ESTRUCTURA');
  }

  const soporte = rol => ({
    conceptoIds: [...estructura[rol].conceptoIds],
    referenciasLiterales: [],
  });
  const enlace = (desde, hacia, rolA, rolB) => ({
    desde,
    hacia,
    referenciasConceptoIds: [...estructura[rolA].conceptoIds, ...estructura[rolB].conceptoIds],
    referenciasLiterales: [],
  });

  const params = {
    id,
    version,
    constituyentes: {
      inicio: soporte('inicio'),
      mecanismo: soporte('mecanismo'),
      resultado: soporte('resultado'),
      observabilidad: soporte('observabilidad'),
    },
    modoObservabilidad: 'CONSTITUYENTE_SEPARADO',
    enlacesCausales: {
      inicioAMecanismo: enlace('INICIO', 'MECANISMO', 'inicio', 'mecanismo'),
      mecanismoAResultado: enlace('MECANISMO', 'RESULTADO', 'mecanismo', 'resultado'),
      resultadoAObservabilidad: enlace('RESULTADO', 'OBSERVABILIDAD', 'resultado', 'observabilidad'),
    },
    origen: {
      composicion: 'PROPUESTA_SISTEMA',
      soportes: 'CONOCIMIENTO_AUTORIZADO_DISTRIBUIDO',
      propuestaEnTurnoId: turnoId,
      formulacionPropuesta,
    },
    ...(reformulaAId !== undefined ? { reformulaAId } : {}),
    ...(cabezaBaseId !== undefined ? { cabezaBaseId } : {}),
    ...(cabezaBaseRevision !== undefined ? { cabezaBaseRevision } : {}),
  };
  return crearPropuestaTransformacional(params);
}

module.exports = {
  componerAfirmacionTransformacionalDestinoInterna,
  crearPropuestaDesdeComposicionTransformacionalInterna,
  evaluarRelacionTransformacionalDestinoInterna,
  CAUSAS_BLOQUEO_RELACIONAL,
  // Expuesta únicamente para prueba directa de la plantilla mecánica
  // (sección 8 del encargo) — pura, sin efectos, sin legitimidad
  // process-local que proteger: no crea ni acredita ninguna entidad.
  construirFormulacionDesdeEstructura,
};
