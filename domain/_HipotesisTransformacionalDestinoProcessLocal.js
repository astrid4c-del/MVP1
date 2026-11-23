'use strict';

/**
 * Runtime privado de HipotesisTransformacionalDestino.
 *
 * Responsabilidad exacta: representar "estos conceptos vigentes ocupan
 * estos roles dentro de esta transformación específica" — con identidad,
 * vigencia y autoridad PROPIAS, nunca modificando la autoridad de los
 * conceptos que referencia. No decide causalidad leyendo texto — solo
 * verifica existencia, vigencia y compatibilidad rol↔dimensión, todo
 * estructural.
 *
 * Deliberadamente NO es un concepto del grafo: nunca se escribe en
 * `grafo.conceptos`, nunca cuenta para `coberturaCompleta`/
 * `dimensionesPendientes`, nunca se confunde con `sintesis_interpretativa`
 * (esa representa texto ya mostrado o una proyección posterior de un acto
 * normativo ya cerrado — esta entidad existe ANTES de cualquier texto,
 * como estructura candidata que el propio módulo congela en formulación
 * determinística).
 *
 * Sin persistencia, sin Writer, sin compositor, sin LLM, sin regex
 * semántico. Migración futura documentada (no implementada aquí): las
 * causas RESULTADO_NO_CONCRETO/OBSERVABILIDAD_NO_DEMOSTRADA del compositor
 * (`_ComposicionTransformacionalDestinoProcessLocal.js`) deberán, en un
 * incremento posterior, migrar hacia "ausencia de una
 * HipotesisTransformacionalDestino CONFIRMADA y vigente que vincule
 * resultado↔observabilidad" — nunca hacia clasificación léxica de
 * `despues`. Ese incremento no se hace aquí.
 *
 * Este archivo no es una superficie de dominio. La fachada pública
 * (HipotesisTransformacionalDestinoPolicy.js) expone las operaciones
 * estrechas; nunca el WeakSet de legitimidad ni el registro de huellas
 * rechazadas.
 *
 * Aislamiento de estado global (auditoría posterior a 71e76f8):
 *   - `hipotesisLegitimas` (WeakSet, identidad de objeto) — seguro por
 *     construcción: dos hipótesis de sesiones distintas son siempre
 *     objetos JS distintos, nunca pueden colisionar aunque sus campos
 *     tengan los mismos valores.
 *   - `huellasRechazadas` (Map) — NO era seguro: su clave original era
 *     solo la huella de roles (ids de concepto), y esos ids son
 *     deterministas sobre `grafo.id` — dos sesiones independientes pueden
 *     producir la MISMA cadena de id sin relación alguna entre sí. Corregido:
 *     la clave ahora es el compuesto {sesionId, gramática, huella} — ver
 *     `claveMemoriaNegativa`.
 */

const crypto = require('crypto');
const { dimensionDeProcedencia } = require('../state/GrafoProyeccion');
const {
  construirRenderEstructuradoDesdeEstructura, reconstruirTextoDesdeRenderPorUnidad,
} = require('./_FormulacionTransformacionalDestinoTemplate');
const schema = require('../schemas/HipotesisTransformacionalDestino');
const {
  TIPOS_RELACION_INTERNA, COMPONENTES_ESTRUCTURA_RELACIONAL, VERSION_CONTRATO_RELACIONAL_ACTUAL,
  ROL_RENDER_A_CAMPO_ROL, VERSION_CONTRATO_RENDER_ACTUAL,
} = schema;

const GRAMATICA_SOPORTADA = 'destino';

// Único mapeo campo-de-rol → dimensión de procedencia esperada, para ESTA
// primera versión (ver invariante 3 del encargo): no declara que todo
// 'conocimiento' sea universalmente mecanismo — solo expresa qué rol se
// invita a confirmar dentro de esta hipótesis concreta.
const CAMPO_ROL_A_DIMENSION = Object.freeze({
  inicioConceptoIds: 'antes',
  mecanismoConceptoIds: 'conocimiento',
  resultadoConceptoIds: 'despues',
  observabilidadConceptoIds: 'evidencia',
});
const CAMPOS_ROL = Object.freeze(Object.keys(CAMPO_ROL_A_DIMENSION));

const hipotesisLegitimas = new WeakSet();
// Memoria negativa — nunca persistida, nunca comparación de texto.
//
// CORRECCIÓN (auditoría de aislamiento posterior a 71e76f8): la clave NUNCA
// puede ser solo `huellaRoles` (los ids de concepto, ordenados) — los ids
// de concepto son deterministas sobre `grafo.id` (siguienteId,
// GrafoConocimientoPolicy.js), así que dos sesiones DISTINTAS e
// independientes pueden legítimamente producir la MISMA cadena de id para
// conceptos que no tienen relación alguna entre sí. Depender de que los
// ids sean globalmente únicos sería un supuesto no garantizado por ningún
// contrato del grafo.
//
// La clave real es el compuesto {sesionId, gramática, huella de roles} —
// "esta sesión + esta gramática + esta estructura relacional" — nunca una
// prohibición global del proceso. `grafoActualizadoEn` NUNCA participa de
// la clave: es un timestamp de TODO el grafo, cambia con cualquier mutación
// en cualquier dimensión — incluirlo levantaría el bloqueo ante cambios
// irrelevantes, exactamente lo que esta memoria negativa debe evitar.
const huellasRechazadas = new Map();

/**
 * Clave compuesta de memoria negativa — nunca solo la huella de roles.
 * circulomejora006_act10e — extendida con `huellaDeEstructuraRelacional` y
 * `versionContratoRelacional`: la MISMA sesión, la MISMA gramática, el
 * MISMO conjunto exacto de conceptoIds por rol Y la MISMA proposición
 * relacional sobre ellos — cualquier cambio en cualquiera de esos cuatro
 * cambia la clave, permitiendo una candidata nueva. Deliberadamente
 * excluye evidencia del grafo (grafo.relaciones no es autoridad — una
 * nueva relación en el grafo que reafirma la MISMA proposición nunca
 * reabre un rechazo) y la formulación textual (nunca identidad). Ningún
 * otro dato del grafo participa — ver nota de `huellasRechazadas` arriba.
 */
function claveMemoriaNegativa(sesionId, gramatica, huellaDeRoles, huellaDeEstructuraRelacional, versionContratoRelacional) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      sesionId, gramatica, huellaDeRoles, huellaDeEstructuraRelacional, versionContratoRelacional,
    }))
    .digest('hex');
}

/**
 * Deriva, determinísticamente e internamente, la estructura relacional del
 * agregado a partir de los roles YA validados — nunca acepta
 * estructuraRelacional como input del llamador (contrato del incremento:
 * "un caller no puede fabricar otro tipo relacional ni invertir la
 * dirección"). Vocabulario, dirección y versión de contrato viven
 * exclusivamente en el schema (COMPONENTES_ESTRUCTURA_RELACIONAL) — esta
 * función es la única fuente que los aplica.
 */
function construirEstructuraRelacionalInterna(rolesCongelados) {
  const componentes = {};
  Object.entries(COMPONENTES_ESTRUCTURA_RELACIONAL).forEach(([nombre, spec]) => {
    componentes[nombre] = Object.freeze({
      tipo: spec.tipo,
      desdeConceptoIds: Object.freeze([...rolesCongelados[spec.desdeRol]]),
      haciaConceptoIds: Object.freeze([...rolesCongelados[spec.haciaRol]]),
    });
  });
  return Object.freeze(componentes);
}

/**
 * Huella de la estructura relacional — nunca depende de texto libre ni de
 * timestamps. Determinística: mismos roles + mismo vocabulario ⇒ misma
 * huella siempre (hoy no hay variación posible entre dos hipótesis con los
 * mismos roles, porque solo existe un tipo legítimo por componente — la
 * huella participa igual en la identidad para que una futura versión de
 * contrato con tipos alternativos SÍ produzca huellas distintas).
 */
function huellaEstructuraRelacional(estructuraRelacional) {
  const canonico = Object.keys(COMPONENTES_ESTRUCTURA_RELACIONAL).sort().map(nombre => ({
    nombre,
    tipo: estructuraRelacional[nombre].tipo,
    desde: [...estructuraRelacional[nombre].desdeConceptoIds],
    hacia: [...estructuraRelacional[nombre].haciaConceptoIds],
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonico)).digest('hex');
}

function congelarProfundo(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(congelarProfundo);
  return Object.freeze(value);
}

function diagnostico(resultado, hechos = {}) {
  return congelarProfundo({ resultado, diagnostico: { ...hechos } });
}

function buscarConcepto(grafoActual, conceptoId) {
  return (grafoActual.conceptos || []).find(c => c.id === conceptoId) || null;
}

function esVigente(concepto) {
  return !!concepto && concepto.activo === true && concepto.autoridad === 'experto';
}

function causaDeNoVigencia(concepto) {
  if (!concepto) return 'CONCEPTO_INEXISTENTE';
  if (concepto.rechazado === true) return 'RECHAZADO';
  if (concepto.activo === false) return 'OBSOLETO';
  return 'PENDIENTE_RECONOCIMIENTO';
}

function huellaRoles(roles) {
  const canonico = CAMPOS_ROL.map(campo => ({
    campo, ids: [...roles[campo]].sort(),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonico)).digest('hex');
}

function descripcionResumenDe(grafoActual, conceptoIds) {
  return conceptoIds.map(id => buscarConcepto(grafoActual, id).descripcion).join('. ');
}

/**
 * Construye una candidata — validando integridad estructural real, nunca
 * causalidad por lectura de texto.
 *
 * @param {object} params
 * @param {string} params.id
 * @param {number} [params.version] — default 1
 * @param {string} params.sesionId
 * @param {string} params.gramatica — únicamente 'destino'
 * @param {object} params.grafoActual — KnowledgeGraph, contexto 'vivo'
 * @param {object} params.roles — { inicioConceptoIds, mecanismoConceptoIds, resultadoConceptoIds, observabilidadConceptoIds }
 * @param {string} [params.reemplazaAId] — sucesión normativa explícita (nunca auto-derivada)
 * @param {string} [params.reformulaAId] — genealogía editorial explícita (nunca auto-derivada)
 * @param {string} params.turnoPresentacionId — circulomejora006_reporte03: el
 *   turno REAL en el que esta formulación se muestra al usuario (nunca el de
 *   una confirmación/convergencia posterior) — el llamador lo decide ANTES
 *   de invocar esta función (mismo criterio que id/hipotesisId), nunca se
 *   recupera después buscando coincidencias de texto.
 * @returns {{ resultado: 'CANDIDATA_VALIDA'|'CANDIDATA_INVALIDA', hipotesis?: object, diagnostico?: object }}
 */
/**
 * Única autoridad process-local para que un destino pueda cruzar desde
 * evidencia a RESULTADO: la misma candidata debe usar el origen como
 * MECANISMO y la relación debe ser activa, produce, experta y procedenciada.
 */
function relacionProduceAutorizadaParaResultado(grafoActual, mecanismoConceptoIds, destinoConceptoId) {
  const mecanismoIds = new Set(mecanismoConceptoIds || []);
  const destino = (grafoActual && grafoActual.conceptos || []).find(c => c.id === destinoConceptoId);
  if (!destino || destino.activo !== true || destino.autoridad !== 'experto') return false;
  return (grafoActual.relaciones || []).some(r => (
    r && r.activo !== false && r.tipo === 'produce'
    && mecanismoIds.has(r.origen) && r.destino === destinoConceptoId
    && r.autoridad === 'experto'
    && typeof r.procedencia === 'string' && r.procedencia.trim()
    && typeof r.evidenciaTextual === 'string' && r.evidenciaTextual.trim()
  ));
}

function crearHipotesisTransformacionalDestinoInterna({
  id, version = 1, sesionId, gramatica, grafoActual, roles, reemplazaAId, reformulaAId, turnoPresentacionId,
  autoridadesContextualesPorRol = null,
} = {}) {
  // Corrupción de contrato — nunca un resultado "no candidata": estos son
  // errores de programación del llamador, no desenlaces conversacionales.
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('crearHipotesisTransformacionalDestino: id es obligatorio');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('crearHipotesisTransformacionalDestino: version debe ser entero >= 1');
  }
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('crearHipotesisTransformacionalDestino: sesionId es obligatorio');
  }
  if (typeof turnoPresentacionId !== 'string' || !turnoPresentacionId.trim()) {
    throw new Error('crearHipotesisTransformacionalDestino: turnoPresentacionId es obligatorio');
  }
  if (gramatica !== GRAMATICA_SOPORTADA) {
    throw new Error(`crearHipotesisTransformacionalDestino: GRAMATICA_NO_SOPORTADA '${gramatica}'`);
  }
  if (!grafoActual || typeof grafoActual !== 'object' || !Array.isArray(grafoActual.conceptos)) {
    throw new Error('crearHipotesisTransformacionalDestino: grafoActual inválido');
  }
  if (!roles || typeof roles !== 'object') {
    throw new Error('crearHipotesisTransformacionalDestino: roles es obligatorio');
  }
  CAMPOS_ROL.forEach(campo => {
    if (!Array.isArray(roles[campo]) || roles[campo].length === 0) {
      throw new Error(`crearHipotesisTransformacionalDestino: roles.${campo} debe ser un array no vacío de ids reales`);
    }
  });
  if (reemplazaAId !== undefined && reemplazaAId === id) {
    throw new Error('crearHipotesisTransformacionalDestino: reemplazaAId no puede coincidir con id');
  }
  if (reformulaAId !== undefined && reformulaAId === id) {
    throw new Error('crearHipotesisTransformacionalDestino: reformulaAId no puede coincidir con id');
  }

  // Invariante 1: todos los ids referenciados deben existir — corrupción
  // de contrato si falta alguno (el llamador nunca debería referenciar un
  // id que no viene del propio grafo).
  CAMPOS_ROL.forEach(campo => {
    roles[campo].forEach(conceptoId => {
      if (!buscarConcepto(grafoActual, conceptoId)) {
        throw new Error(`crearHipotesisTransformacionalDestino: REFERENCIA_INEXISTENTE '${conceptoId}' en ${campo}`);
      }
    });
  });

  // Invariante 2: todos deben estar vigentes en el snapshot base — esto SÍ
  // es un desenlace legítimo y esperable (los conceptos pierden vigencia
  // con el tiempo), nunca una corrupción de contrato.
  for (const campo of CAMPOS_ROL) {
    const idNoVigente = roles[campo].find(conceptoId => !esVigente(buscarConcepto(grafoActual, conceptoId)));
    if (idNoVigente) {
      return diagnostico('CANDIDATA_INVALIDA', {
        codigo: 'REFERENCIA_NO_VIGENTE', campo, conceptoId: idNoVigente,
        causa: causaDeNoVigencia(buscarConcepto(grafoActual, idNoVigente)),
      });
    }
  }

  // Invariante 3: cada concepto solo puede ocupar el rol permitido por su
  // dimensión de procedencia, salvo una participación contextual demostrada
  // por la misma relación produce autorizada que usa RESULTADO u
  // OBSERVABILIDAD. La dimensión no cambia ni decide causalidad universal.
  for (const campo of CAMPOS_ROL) {
    const dimensionEsperada = CAMPO_ROL_A_DIMENSION[campo];
    const autoridadesContextuales = new Set(
      (autoridadesContextualesPorRol && autoridadesContextualesPorRol[campo]) || [],
    );
    const idIncompatible = roles[campo].find(conceptoId => (
      dimensionDeProcedencia(buscarConcepto(grafoActual, conceptoId).procedencia) !== dimensionEsperada
      && !autoridadesContextuales.has(conceptoId)
      && !((campo === 'resultadoConceptoIds' || campo === 'observabilidadConceptoIds')
        && relacionProduceAutorizadaParaResultado(grafoActual, roles.mecanismoConceptoIds, conceptoId))
    ));
    if (idIncompatible) {
      return diagnostico('CANDIDATA_INVALIDA', {
        codigo: 'ROL_INCOMPATIBLE_CON_DIMENSION', campo, conceptoId: idIncompatible, dimensionEsperada,
      });
    }
  }

  const rolesCongelados = Object.freeze(Object.fromEntries(
    CAMPOS_ROL.map(campo => [campo, Object.freeze([...roles[campo]])]),
  ));
  const huella = huellaRoles(rolesCongelados);

  // circulomejora006_act10e — estructura relacional interna: derivada
  // SIEMPRE internamente desde los roles ya validados, nunca aceptada como
  // input (el llamador solo entrega `roles`). Ver
  // construirEstructuraRelacionalInterna/COMPONENTES_ESTRUCTURA_RELACIONAL.
  const estructuraRelacional = construirEstructuraRelacionalInterna(rolesCongelados);
  const huellaRelacional = huellaEstructuraRelacional(estructuraRelacional);

  // Memoria negativa (invariante 4 del rechazo, sección "Rechazo" del
  // encargo, extendida por circulomejora006_act10e): misma SESIÓN, misma
  // GRAMÁTICA, misma huella de roles Y misma huella de estructura relacional
  // bajo la misma versión de contrato — sin ninguna señal estructural
  // nueva, bloquear. Nunca comparación semántica de texto, nunca evidencia
  // del grafo, nunca dependiente de que los ids sean globalmente únicos
  // entre sesiones (ver nota de `huellasRechazadas`).
  const claveNegativa = claveMemoriaNegativa(
    sesionId, GRAMATICA_SOPORTADA, huella, huellaRelacional, VERSION_CONTRATO_RELACIONAL_ACTUAL,
  );
  if (huellasRechazadas.has(claveNegativa)) {
    const previa = huellasRechazadas.get(claveNegativa);
    return diagnostico('CANDIDATA_INVALIDA', {
      codigo: 'REPRODUCE_HIPOTESIS_RECHAZADA', huella, hipotesisRechazadaId: previa.hipotesisId,
    });
  }

  // La formulación depende de roles Y de estructuraRelacional — nunca solo
  // del orden fijo de los roles: si algún componente tuviera un tipo
  // distinto del único que la plantilla mecánica sabe expresar hoy, esto
  // falla alto en vez de producir en silencio el mismo texto para una
  // afirmación distinta. Mapa exacto cláusula↔componente (lenguaje natural
  // sin cambios respecto a la plantilla ya existente):
  //   "Mediante: <mecanismo>. Se llega a: <resultado>."  ← mecanismoResultado (MECANISMO_CONDUCE_A_RESULTADO)
  //   "Se llega a: <resultado>. Esto se sabrá porque: <observabilidad>." ← resultadoObservabilidad (RESULTADO_SE_EVIDENCIA_EN)
  if (estructuraRelacional.mecanismoResultado.tipo !== TIPOS_RELACION_INTERNA.MECANISMO_CONDUCE_A_RESULTADO) {
    throw new Error('crearHipotesisTransformacionalDestino: TIPO_RELACIONAL_NO_SOPORTADO_POR_LA_PLANTILLA (mecanismoResultado)');
  }
  if (estructuraRelacional.resultadoObservabilidad.tipo !== TIPOS_RELACION_INTERNA.RESULTADO_SE_EVIDENCIA_EN) {
    throw new Error('crearHipotesisTransformacionalDestino: TIPO_RELACIONAL_NO_SOPORTADO_POR_LA_PLANTILLA (resultadoObservabilidad)');
  }
  const estructuraParaFormulacion = {
    inicio: { descripcionResumen: descripcionResumenDe(grafoActual, rolesCongelados.inicioConceptoIds) },
    mecanismo: { descripcionResumen: descripcionResumenDe(grafoActual, rolesCongelados.mecanismoConceptoIds) },
    resultado: { descripcionResumen: descripcionResumenDe(grafoActual, rolesCongelados.resultadoConceptoIds) },
    observabilidad: { descripcionResumen: descripcionResumenDe(grafoActual, rolesCongelados.observabilidadConceptoIds) },
  };
  // circulomejora006_reporte03 (productividad de PresentacionTransformacionalEstructurada)
  // — ÚNICO momento en que se lee concepto.descripcion para construir el
  // render por unidad: aquí, mientras el propio texto se ensambla. `render`
  // y `formulacionCongelada` nacen de la MISMA llamada (nunca dos cálculos
  // separados que puedan divergir) — construirRenderEstructuradoDesdeEstructura
  // es la única fuente, compartida con construirFormulacionDesdeEstructura.
  // Después de este punto, ningún código vuelve a llamar
  // descripcionResumenDe ni a leer grafoActual.conceptos[].descripcion para
  // esta Hipótesis — el render queda congelado para siempre junto con la
  // formulación.
  const { texto: formulacionCongelada, unidades: unidadesRender } = (
    construirRenderEstructuradoDesdeEstructura(estructuraParaFormulacion)
  );
  const renderPorUnidad = Object.freeze(Object.fromEntries(
    unidadesRender.map(u => [u.rol, Object.freeze({
      rol: u.rol,
      texto: u.texto,
      conceptoIds: Object.freeze([...rolesCongelados[ROL_RENDER_A_CAMPO_ROL[u.rol]]]),
      offsetInicio: u.offsetInicio,
      offsetFin: u.offsetFin,
    })]),
  ));
  // Consistencia interna obligatoria (nunca solo confiada a que ambas
  // provengan de la misma llamada — verificación explícita, re-derivada
  // EXCLUSIVAMENTE desde renderPorUnidad ya congelado, nunca del grafo):
  // si algún día esta construcción y la plantilla divergieran, esto falla
  // alto en vez de congelar una Hipótesis con formulacionCongelada A y
  // unidades visibles B.
  if (reconstruirTextoDesdeRenderPorUnidad(renderPorUnidad) !== formulacionCongelada) {
    throw new Error('crearHipotesisTransformacionalDestino: RENDER_INCONSISTENTE_CON_FORMULACION');
  }

  const snapshotBase = Object.freeze({
    sesionId,
    gramatica: GRAMATICA_SOPORTADA,
    huella,
    huellaRelacional,
    grafoActualizadoEn: grafoActual.actualizadoEn || null,
  });

  const hipotesis = congelarProfundo({
    id,
    version,
    estado: 'CANDIDATA',
    roles: rolesCongelados,
    versionContratoRelacional: VERSION_CONTRATO_RELACIONAL_ACTUAL,
    estructuraRelacional,
    snapshotBase,
    formulacionCongelada,
    renderPorUnidad,
    versionContratoRender: VERSION_CONTRATO_RENDER_ACTUAL,
    turnoPresentacionId,
    procedencia: { sesionId, gramatica: GRAMATICA_SOPORTADA },
    ...(reemplazaAId !== undefined ? { reemplazaAId } : {}),
    ...(reformulaAId !== undefined ? { reformulaAId } : {}),
  });

  const validacion = schema.validarHipotesisTransformacionalDestino(hipotesis);
  if (!validacion.valid) {
    // No debería alcanzarse nunca (la construcción de arriba ya respeta el
    // contrato) — pero si el schema evoluciona sin este runtime, falla alto
    // en vez de acuñar una candidata inválida.
    throw new Error(`HipotesisTransformacionalDestino inválida — ${validacion.errors.join('; ')}`);
  }

  hipotesisLegitimas.add(hipotesis);
  return { resultado: 'CANDIDATA_VALIDA', hipotesis };
}

function exigirLegitimidad(hipotesis, nombreOperacion) {
  if (!hipotesis || typeof hipotesis !== 'object' || !hipotesisLegitimas.has(hipotesis)) {
    throw new Error(`${nombreOperacion}: HIPOTESIS_SIN_INTEGRIDAD_PROCESS_LOCAL`);
  }
}

function construirVeredicto({ tipo, turnoId, textoUsuario, hipotesis }) {
  if (typeof turnoId !== 'string' || !turnoId.trim()) {
    throw new Error('HipotesisTransformacionalDestino: turnoId es obligatorio para el veredicto');
  }
  if (typeof textoUsuario !== 'string') {
    throw new Error('HipotesisTransformacionalDestino: textoUsuario es obligatorio para el veredicto');
  }
  return Object.freeze({
    tipo,
    turnoId,
    evidenciaAtribucion: Object.freeze([Object.freeze({ turnoId, cita: textoUsuario.trim() })]),
    hipotesisId: hipotesis.id,
    version: hipotesis.version,
  });
}

/**
 * confirmarHipotesisTransformacionalDestinoInterna — única promoción
 * legítima CANDIDATA → CONFIRMADA. El veredicto representa confirmación
 * explícita del OBJETO COMPLETO ya mostrado (formulacionCongelada, que ya
 * hace visibles los cuatro roles y sus vínculos) — una confirmación única
 * es válida precisamente porque el texto confirmado ya narra la cadena
 * entera, nunca un resumen ni una paráfrasis.
 *
 * circulomejora006_reporte03 — el spread `{...hipotesis}` de abajo preserva,
 * sin cambio alguno y sin releer el grafo, `renderPorUnidad`/
 * `versionContratoRender`/`turnoPresentacionId` exactamente igual que
 * preserva `formulacionCongelada` — CANDIDATA→CONFIRMADA nunca los toca.
 *
 * Preserva EXACTAMENTE (mismas referencias de objeto congeladas, nunca
 * copias): id, version, roles, snapshotBase, formulacionCongelada.
 */
function confirmarHipotesisTransformacionalDestinoInterna({ hipotesis, turnoId, textoUsuario } = {}) {
  exigirLegitimidad(hipotesis, 'confirmarHipotesisTransformacionalDestino');
  if (hipotesis.estado !== 'CANDIDATA') {
    throw new Error(`confirmarHipotesisTransformacionalDestino: ESTADO_PREVIO_INVALIDO (${hipotesis.estado})`);
  }
  const veredicto = construirVeredicto({ tipo: 'CONFIRMACION_EXPLICITA', turnoId, textoUsuario, hipotesis });
  const siguiente = congelarProfundo({ ...hipotesis, estado: 'CONFIRMADA', veredicto });
  const validacion = schema.validarHipotesisTransformacionalDestino(siguiente);
  if (!validacion.valid) {
    throw new Error(`HipotesisTransformacionalDestino inválida tras confirmar — ${validacion.errors.join('; ')}`);
  }
  hipotesisLegitimas.add(siguiente);
  return siguiente;
}

/**
 * rechazarHipotesisTransformacionalDestinoInterna — única transición
 * CANDIDATA → RECHAZADA. Nunca modifica los conceptos referenciados.
 * Registra la huella estructural para impedir que una reconstrucción con
 * el MISMO conjunto exacto de referencias, sin ninguna señal estructural
 * nueva, vuelva a proponerse — nunca por comparación semántica de texto.
 */
function rechazarHipotesisTransformacionalDestinoInterna({ hipotesis, turnoId, textoUsuario } = {}) {
  exigirLegitimidad(hipotesis, 'rechazarHipotesisTransformacionalDestino');
  if (hipotesis.estado !== 'CANDIDATA') {
    throw new Error(`rechazarHipotesisTransformacionalDestino: ESTADO_PREVIO_INVALIDO (${hipotesis.estado})`);
  }
  const veredicto = construirVeredicto({ tipo: 'RECHAZO_EXPLICITO', turnoId, textoUsuario, hipotesis });
  const siguiente = congelarProfundo({ ...hipotesis, estado: 'RECHAZADA', veredicto });
  const validacion = schema.validarHipotesisTransformacionalDestino(siguiente);
  if (!validacion.valid) {
    throw new Error(`HipotesisTransformacionalDestino inválida tras rechazar — ${validacion.errors.join('; ')}`);
  }
  hipotesisLegitimas.add(siguiente);
  const claveNegativa = claveMemoriaNegativa(
    hipotesis.snapshotBase.sesionId, hipotesis.snapshotBase.gramatica,
    hipotesis.snapshotBase.huella, hipotesis.snapshotBase.huellaRelacional,
    hipotesis.versionContratoRelacional,
  );
  huellasRechazadas.set(claveNegativa, {
    hipotesisId: hipotesis.id, motivo: textoUsuario.trim(),
  });
  return siguiente;
}

/**
 * obsoletarHipotesisPorCambioDeConceptoInterna — transición
 * CANDIDATA|CONFIRMADA → OBSOLETA cuando cualquiera de los conceptos
 * referenciados deja de estar vigente en `grafoActual` (obsoleto,
 * rechazado o degradado a pendiente-de-reconocimiento). Nunca modifica los
 * OTROS conceptos referenciados. Si ninguno cambió, devuelve la MISMA
 * hipótesis sin alterar (no-op explícito, nunca un error).
 */
function obsoletarHipotesisPorCambioDeConceptoInterna({ hipotesis, grafoActual } = {}) {
  exigirLegitimidad(hipotesis, 'obsoletarHipotesisPorCambioDeConcepto');
  if (hipotesis.estado !== 'CANDIDATA' && hipotesis.estado !== 'CONFIRMADA') {
    throw new Error(`obsoletarHipotesisPorCambioDeConcepto: ESTADO_PREVIO_INVALIDO (${hipotesis.estado})`);
  }
  if (!grafoActual || typeof grafoActual !== 'object' || !Array.isArray(grafoActual.conceptos)) {
    throw new Error('obsoletarHipotesisPorCambioDeConcepto: grafoActual inválido');
  }
  const conceptosCausantes = [];
  CAMPOS_ROL.forEach(campo => {
    hipotesis.roles[campo].forEach(conceptoId => {
      const concepto = buscarConcepto(grafoActual, conceptoId);
      if (!esVigente(concepto)) {
        conceptosCausantes.push({ campo, conceptoId, causa: causaDeNoVigencia(concepto) });
      }
    });
  });
  if (conceptosCausantes.length === 0) {
    return hipotesis; // ningún concepto referenciado cambió — no-op explícito.
  }
  const siguiente = congelarProfundo({
    ...hipotesis,
    estado: 'OBSOLETA',
    obsolescencia: { causa: 'CONCEPTO_NO_VIGENTE', conceptosCausantes: Object.freeze(conceptosCausantes) },
  });
  const validacion = schema.validarHipotesisTransformacionalDestino(siguiente);
  if (!validacion.valid) {
    throw new Error(`HipotesisTransformacionalDestino inválida tras obsoletar — ${validacion.errors.join('; ')}`);
  }
  hipotesisLegitimas.add(siguiente);
  return siguiente;
}

module.exports = {
  crearHipotesisTransformacionalDestinoInterna,
  relacionProduceAutorizadaParaResultado,
  confirmarHipotesisTransformacionalDestinoInterna,
  rechazarHipotesisTransformacionalDestinoInterna,
  obsoletarHipotesisPorCambioDeConceptoInterna,
};
