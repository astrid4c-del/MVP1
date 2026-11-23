'use strict';

/**
 * Runtime interno único de D1.7-B.
 * No exporta registradores ni certificadores. La única operación pública del
 * runtime prepara una vista desde un CognitiveUnitOfWork real; la identidad se
 * registra dentro de la clausura y solo se consulta mediante el predicado.
 *
 * circulomejora006_act07c: si se recibe `llmService`, compone además
 * selector → evaluador → validador de criterioObservabilidad y añade el
 * resultado gobernado a la vista antes de congelarla. Sin `llmService`,
 * `resultadoObservabilidad` queda en null (fail-closed, mismo efecto que
 * cualquier otro fallo del pipeline). Esta composición nunca persiste nada:
 * se recalcula en cada llamada, igual que roundTrip.
 *
 * circulomejora006_reporte04: mismo precedente para 'criterioProporcionalidad'
 * — compone selección → evaluación (4 unidades, en paralelo) → validación
 * (con re-chequeo de vigencia) → agregación, y añade `resultadoProporcionalidad`
 * a la vista. Deliberadamente NUNCA durable: la evaluación certifica
 * proporcionalidad respecto de la REVISIÓN vigente en el momento de esta
 * llamada — nunca "verdad histórica" reutilizable — así que se recalcula
 * cada vez, exactamente como resultadoObservabilidad. Requiere una
 * PresentacionTransformacionalEstructurada real (schemaVersion 2) para la
 * cabeza vigente; sin ella (o sin llmService), queda en null.
 *
 * circulomejora006_reporte05: mismo precedente para 'criterioEspecificidad'
 * — añade `resultadoEspecificidad`. Única diferencia real de orquestación:
 * la selección de especificidad adjunta, a cada unidad objetivo, el texto
 * completo de las otras tres unidades visibles (nunca solo evidencia
 * aislada) — ver SeleccionEspecificidadDestino.js. Mismo requisito de
 * presentación estructurada real, mismo fail-closed, mismo recálculo total
 * en cada llamada.
 *
 * circulomejora006_reporte07: mismo precedente para
 * 'criterioDiferenciaTransformacional' — añade `resultadoDiferenciaTransformacional`.
 * Diferencia arquitectónica real (nunca "una evaluación por unidad"): el
 * objeto de evaluación es la TRÍADA completa (INICIO→MECANISMO→RESULTADO)
 * en una sola selección compuesta y una sola llamada al auditor — nunca
 * cuatro registros ni una agregación N→1 (no existe
 * AgregacionDiferenciaTransformacionalDestino.js). El validador produce
 * directamente el resultado final.
 *
 * circulomejora006_reporte09: añade `eventosConvergenciaHipotesisAfirmacion`
 * — lectura simple (nunca reconstrucción) de los eventos durables
 * 'hipotesis_transformacional.convergio_a_afirmacion' ya persistidos por el
 * Writer, en la MISMA transacción que autorizó la Afirmación. Es la
 * evidencia que BaseDefendibleDestinoPolicy usa para el gate de
 * reconocimiento del flujo Hipótesis→Afirmación (reemplaza la dependencia
 * del ciclo round-trip clásico para ese flujo específico — ver
 * BaseDefendibleDestinoPolicy.js). Solo LECTURA de un evento que ya existe;
 * no se persiste nada nuevo aquí.
 */

const { CognitiveUnitOfWork } = require('../persistence/CognitiveUnitOfWork');
const { seleccionarUnidadObservabilidad } = require('./SeleccionCriterioObservabilidadDestino');
const { evaluarCriterioObservabilidadDestino } = require('./EvaluadorCriterioObservabilidadDestino');
const { validarCriterioObservabilidadDestino } = require('./ValidacionCriterioObservabilidadDestino');
const { proyectarTrazabilidadPresentacionC1 } = require('../projection/TrazabilidadPresentacionC1Projection');
const { seleccionarUnidadesProporcionalidadDestino } = require('./SeleccionProporcionalidadDestino');
const { evaluarProporcionalidadDestino } = require('./EvaluadorProporcionalidadDestino');
const { validarProporcionalidadDestino } = require('./ValidacionProporcionalidadDestino');
const { agregarProporcionalidadDestino } = require('./AgregacionProporcionalidadDestino');
const { CONTRATO_VERSION: CONTRATO_VERSION_PROPORCIONALIDAD } = require('../schemas/CriterioProporcionalidadDestino');
const { seleccionarUnidadesEspecificidadDestino } = require('./SeleccionEspecificidadDestino');
const { evaluarEspecificidadDestino } = require('./EvaluadorEspecificidadDestino');
const { validarEspecificidadDestino } = require('./ValidacionEspecificidadDestino');
const { agregarEspecificidadDestino } = require('./AgregacionEspecificidadDestino');
const { CONTRATO_VERSION: CONTRATO_VERSION_ESPECIFICIDAD } = require('../schemas/CriterioEspecificidadDestino');
const { seleccionarDiferenciaTransformacionalDestino } = require('./SeleccionDiferenciaTransformacionalDestino');
const { evaluarDiferenciaTransformacionalDestino } = require('./EvaluadorDiferenciaTransformacionalDestino');
const { validarDiferenciaTransformacionalDestino } = require('./ValidacionDiferenciaTransformacionalDestino');
const { CONTRATO_VERSION: CONTRATO_VERSION_DIFERENCIA } = require('../schemas/CriterioDiferenciaTransformacionalDestino');
const vistasCertificadas = new WeakSet();

function deepFreeze(value, vistos = new WeakSet()) {
  if (!value || typeof value !== 'object' || vistos.has(value)) return value;
  vistos.add(value);
  Object.values(value).forEach(child => deepFreeze(child, vistos));
  return Object.freeze(value);
}

function requireString(value, nombre) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`VISTA_DESTINO_${nombre}_INVALIDO`);
}

function parseState(raw, sesionId) {
  if (typeof raw !== 'string') throw new Error('VISTA_DESTINO_ESTADO_SESION_INEXISTENTE');
  let state;
  try { state = JSON.parse(raw); } catch (error) { throw new Error(`VISTA_DESTINO_ESTADO_INVALIDO: ${error.message}`); }
  if (!state || state.sesionId !== sesionId) throw new Error('VISTA_DESTINO_SESION_INCOHERENTE');
  const graph = state.knowledgeGraph;
  if (!graph || graph.sesionId !== sesionId || !Array.isArray(graph.conceptos) || !Array.isArray(graph.relaciones)) {
    throw new Error('VISTA_DESTINO_GRAFO_SESION_INCOHERENTE');
  }
  return graph;
}

function comprobarHistorial(historial, sesionId, afirmacionId) {
  if (!historial || typeof historial !== 'object') throw new Error('VISTA_DESTINO_HISTORIAL_INEXISTENTE');
  [
    ['materializaciones', 'afirmacionId'], ['veredictos', 'afirmacionId'],
    ['presentaciones', 'afirmacionId'], ['roundTrips', 'afirmacionId'],
  ].forEach(([nombre, campo]) => (historial[nombre] || []).forEach(registro => {
    if (registro.sesionId !== undefined && registro.sesionId !== sesionId) {
      throw new Error(`VISTA_DESTINO_HISTORIAL_${nombre.toUpperCase()}_SESION_INCOHERENTE`);
    }
    if (registro[campo] !== undefined && registro[campo] !== afirmacionId) {
      throw new Error(`VISTA_DESTINO_HISTORIAL_${nombre.toUpperCase()}_AFIRMACION_INCOHERENTE`);
    }
  }));
  (historial.sucesionesOriginadas || []).forEach(registro => {
    if (registro.sesionId !== undefined && registro.sesionId !== sesionId) {
      throw new Error('VISTA_DESTINO_HISTORIAL_SUCESION_SESION_INCOHERENTE');
    }
    if (registro.afirmacionAnteriorId !== undefined && registro.afirmacionAnteriorId !== afirmacionId) {
      throw new Error('VISTA_DESTINO_HISTORIAL_SUCESION_AFIRMACION_INCOHERENTE');
    }
  });
}

/**
 * circulomejora006_reporte04 — orquestación completa de proporcionalidad
 * para UNA presentación estructurada real: selecciona las 4 unidades
 * visibles, evalúa las no-bloqueadas en paralelo, re-selecciona (contra una
 * trazabilidad recién recalculada) para detectar cualquier cambio de
 * vigencia ocurrido durante el await al auditor, valida cada propuesta
 * contra esa re-selección, y agrega los 4 resultados en un veredicto único.
 * Nunca persiste nada — mismo criterio que resultadoObservabilidad.
 */
async function evaluarProporcionalidadDestinoCompleta({
  uow, sesionId, afirmacionId, presentacionId, llmService, model,
}) {
  const trazabilidadInicial = proyectarTrazabilidadPresentacionC1({
    uow, sesionId, afirmacionId, presentacionId,
  });
  const seleccionInicial = seleccionarUnidadesProporcionalidadDestino({ trazabilidad: trazabilidadInicial });

  const resultadosPorUnidad = await Promise.all(seleccionInicial.map(async seleccion => {
    if (seleccion.bloqueada) {
      return Object.freeze({
        contratoVersion: CONTRATO_VERSION_PROPORCIONALIDAD,
        afirmacionId: seleccion.afirmacionId,
        presentacionId: seleccion.presentacionId,
        revisionEvaluada: seleccion.revisionEvaluada,
        unidadLocalId: seleccion.unidadLocalId,
        rol: seleccion.rol,
        estado: 'INDETERMINADA',
        dimensionesExceso: Object.freeze([]),
        razon: seleccion.razonBloqueo,
        evidencia: Object.freeze({
          fragmentoVisible: null, fragmentoSoporte: null, conceptoId: null,
          tipoEvidenciaSoporte: null, explicacion: null,
        }),
      });
    }
    const propuesta = await evaluarProporcionalidadDestino({ llmService, seleccion, model });
    // Re-chequeo de vigencia: la trazabilidad se recalcula DESPUÉS del
    // await real al auditor — nunca se confía en que nada cambió mientras
    // tanto (ver ValidacionProporcionalidadDestino.js).
    const trazabilidadReciente = proyectarTrazabilidadPresentacionC1({
      uow, sesionId, afirmacionId, presentacionId,
    });
    const reSeleccion = seleccionarUnidadesProporcionalidadDestino({ trazabilidad: trazabilidadReciente })
      .find(s => s.rol === seleccion.rol);
    return validarProporcionalidadDestino({ propuesta, seleccionOriginal: seleccion, reSeleccion });
  }));

  return agregarProporcionalidadDestino({
    resultadosPorUnidad, afirmacionId, presentacionId, revisionEvaluada: trazabilidadInicial.afirmacionVersion,
  });
}

/**
 * circulomejora006_reporte05 — orquestación completa de especificidad para
 * UNA presentación estructurada real: mismo esqueleto que
 * evaluarProporcionalidadDestinoCompleta (selección → evaluación en
 * paralelo → re-selección → validación → agregación), nunca compartido con
 * ella (Proporcionalidad no se modifica) — la única diferencia es que el
 * SELECTOR de especificidad ya adjunta, por unidad, el texto de las otras
 * tres unidades visibles, así que no hace falta pasar nada adicional aquí.
 * Nunca persiste nada.
 */
async function evaluarEspecificidadDestinoCompleta({
  uow, sesionId, afirmacionId, presentacionId, llmService, model,
}) {
  const trazabilidadInicial = proyectarTrazabilidadPresentacionC1({
    uow, sesionId, afirmacionId, presentacionId,
  });
  const seleccionInicial = seleccionarUnidadesEspecificidadDestino({ trazabilidad: trazabilidadInicial });

  const resultadosPorUnidad = await Promise.all(seleccionInicial.map(async seleccion => {
    if (seleccion.bloqueada) {
      return Object.freeze({
        contratoVersion: CONTRATO_VERSION_ESPECIFICIDAD,
        afirmacionId: seleccion.afirmacionId,
        presentacionId: seleccion.presentacionId,
        revisionEvaluada: seleccion.revisionEvaluada,
        unidadLocalId: seleccion.unidadLocalId,
        rol: seleccion.rol,
        estado: 'INDETERMINADA',
        dimensionesGenericidad: Object.freeze([]),
        razon: seleccion.razonBloqueo,
        evidencia: Object.freeze({
          fragmentoVisible: null, dimensionesGenericidad: [], conceptoIdsRelacionados: [],
          unidadContextualRelacionadaIds: [], tipoEvidenciaSoporte: null, explicacion: null,
        }),
      });
    }
    const propuesta = await evaluarEspecificidadDestino({ llmService, seleccion, model });
    // Re-chequeo de vigencia: la trazabilidad se recalcula DESPUÉS del
    // await real al auditor — nunca se confía en que nada cambió mientras
    // tanto, ni en la autoridad de los soportes ni en el texto de las
    // otras unidades usadas como contexto (ver ValidacionEspecificidadDestino.js).
    const trazabilidadReciente = proyectarTrazabilidadPresentacionC1({
      uow, sesionId, afirmacionId, presentacionId,
    });
    const reSeleccion = seleccionarUnidadesEspecificidadDestino({ trazabilidad: trazabilidadReciente })
      .find(s => s.rol === seleccion.rol);
    return validarEspecificidadDestino({ propuesta, seleccionOriginal: seleccion, reSeleccion });
  }));

  return agregarEspecificidadDestino({
    resultadosPorUnidad, afirmacionId, presentacionId, revisionEvaluada: trazabilidadInicial.afirmacionVersion,
  });
}

/**
 * circulomejora006_reporte07 — orquestación completa de diferencia
 * transformacional para UNA presentación estructurada real: selecciona la
 * tríada compuesta (INICIO/MECANISMO/RESULTADO), evalúa en una única
 * llamada, re-selecciona (contra una trazabilidad recién recalculada) para
 * detectar cualquier cambio de vigencia ocurrido durante el await al
 * auditor, y valida la propuesta contra esa re-selección. Nunca hay
 * agregación N→1: el validador YA produce el resultado final único. Nunca
 * persiste nada.
 */
async function evaluarDiferenciaTransformacionalDestinoCompleta({
  uow, sesionId, afirmacionId, presentacionId, llmService, model,
}) {
  const trazabilidadInicial = proyectarTrazabilidadPresentacionC1({
    uow, sesionId, afirmacionId, presentacionId,
  });
  const seleccionInicial = seleccionarDiferenciaTransformacionalDestino({ trazabilidad: trazabilidadInicial });

  if (seleccionInicial.bloqueada) {
    return Object.freeze({
      contratoVersion: CONTRATO_VERSION_DIFERENCIA,
      afirmacionId: seleccionInicial.afirmacionId,
      presentacionId: seleccionInicial.presentacionId,
      revisionEvaluada: seleccionInicial.revisionEvaluada,
      identidadEvaluacion: null,
      estado: 'INDETERMINADA',
      dimensionesFaltaDiferencia: Object.freeze([]),
      razon: seleccionInicial.razonBloqueo,
      evidencia: Object.freeze({
        fragmentoInicio: null, fragmentoMecanismo: null, fragmentoResultado: null,
        conceptoIdsRelacionados: [], tipoEvidenciaConceptos: null, explicacion: null,
      }),
    });
  }

  const propuesta = await evaluarDiferenciaTransformacionalDestino({ llmService, seleccion: seleccionInicial, model });
  // Re-chequeo de vigencia: la trazabilidad se recalcula DESPUÉS del await
  // real al auditor — nunca se confía en que el texto, los soportes o la
  // topología de la tríada siguen siendo los mismos (ver
  // ValidacionDiferenciaTransformacionalDestino.js).
  const trazabilidadReciente = proyectarTrazabilidadPresentacionC1({
    uow, sesionId, afirmacionId, presentacionId,
  });
  const reSeleccion = seleccionarDiferenciaTransformacionalDestino({ trazabilidad: trazabilidadReciente });
  return validarDiferenciaTransformacionalDestino({ propuesta, seleccionOriginal: seleccionInicial, reSeleccion });
}

async function prepararVista({ uow, sesionId, llmService, model } = {}) {
  if (!(uow instanceof CognitiveUnitOfWork)) throw new Error('VISTA_DESTINO_UOW_NO_AUTENTICO');
  requireString(sesionId, 'SESION');
  const repo = uow.afirmacionTransformacionalRepo;
  const head = repo.findHeadBySession(sesionId);
  if (!head) throw new Error('VISTA_DESTINO_SIN_CABEZA_VIGENTE');
  if (!head.afirmacion || head.afirmacion.estado !== 'AUTORIZADA') {
    throw new Error('VISTA_DESTINO_CABEZA_NO_AUTORIZADA');
  }
  if (head.sesionId !== sesionId || !Number.isInteger(head.revisionCabeza) || head.revisionCabeza < 1) {
    throw new Error('VISTA_DESTINO_CABEZA_INCOHERENTE');
  }
  const historial = repo.getCausalHistory(sesionId, head.afirmacion.id);
  comprobarHistorial(historial, sesionId, head.afirmacion.id);
  const graph = parseState(uow.stateRepo.load(sesionId), sesionId);
  const conceptos = graph.conceptos.map(concepto => ({ ...concepto }));
  const relaciones = graph.relaciones.map(relacion => ({ ...relacion }));
  const conocimientoAutorizado = conceptos.filter(concepto => (
    concepto.autoridad === 'experto' && concepto.activo !== false && concepto.rechazado !== true
  ));
  const idsAutorizados = new Set(conocimientoAutorizado.map(concepto => concepto.id));
  // KnowledgeGraph valida forma y actividad de relaciones, pero no almacena
  // autoridad/procedencia propia. Solo una relación que las declare
  // explícitamente puede sostener un enlace normativo; las demás quedan como
  // candidatas no certificadas y harán fallar la policy de forma conservadora.
  const relacionesAutorizadas = relaciones.filter(relacion => (
    relacion.autoridad === 'experto' && Boolean(relacion.procedencia)
    && relacion.activo !== false && idsAutorizados.has(relacion.origen) && idsAutorizados.has(relacion.destino)
  ));
  const afirmacion = JSON.parse(JSON.stringify(head.afirmacion));
  const historialSnapshot = JSON.parse(JSON.stringify(historial));
  const idsRelevantes = new Set([
    ...(afirmacion.constituyentes && afirmacion.constituyentes.inicio && afirmacion.constituyentes.inicio.conceptoIds || []),
    ...(afirmacion.constituyentes && afirmacion.constituyentes.mecanismo && afirmacion.constituyentes.mecanismo.conceptoIds || []),
    ...(afirmacion.constituyentes && afirmacion.constituyentes.resultado && afirmacion.constituyentes.resultado.conceptoIds || []),
    ...(afirmacion.constituyentes && afirmacion.constituyentes.observabilidad && afirmacion.constituyentes.observabilidad.conceptoIds || []),
  ]);
  const contradiccionesActivas = [];
  (Array.isArray(graph.incertidumbres) ? graph.incertidumbres : []).forEach(incertidumbre => {
    if (incertidumbre.activo === false || !Array.isArray(incertidumbre.sobreConceptos)) return;
    if (incertidumbre.sobreConceptos.some(id => idsRelevantes.has(id))) {
      contradiccionesActivas.push({ ...incertidumbre });
    }
  });
  let resultadoObservabilidad = null;
  if (llmService) {
    try {
      const unidadObservabilidad = seleccionarUnidadObservabilidad(afirmacion);
      const propuestaObservabilidad = await evaluarCriterioObservabilidadDestino({
        llmService, unidad: unidadObservabilidad, conocimientoAutorizado, model,
      });
      resultadoObservabilidad = validarCriterioObservabilidadDestino({
        propuesta: propuestaObservabilidad, unidad: unidadObservabilidad, conocimientoAutorizado,
      });
    } catch (error) {
      resultadoObservabilidad = null;
    }
  }

  // circulomejora006_reporte04 — requiere una PresentacionTransformacionalEstructurada
  // real (schemaVersion 2) de la cabeza vigente; si no existe exactamente
  // una (nunca existió, o quedó ambigua), no hay evidencia productiva sobre
  // la que evaluar — resultadoProporcionalidad permanece null, igual que
  // resultadoObservabilidad sin llmService.
  let resultadoProporcionalidad = null;
  const presentacionesEstructuradas = (historialSnapshot.presentaciones || []).filter(p => (
    p.afirmacionId === head.afirmacion.id && p.afirmacionVersion === head.afirmacion.version && p.schemaVersion === 2
  ));
  if (llmService && presentacionesEstructuradas.length === 1) {
    try {
      resultadoProporcionalidad = await evaluarProporcionalidadDestinoCompleta({
        uow,
        sesionId,
        afirmacionId: head.afirmacion.id,
        presentacionId: presentacionesEstructuradas[0].presentacionId,
        llmService,
        model,
      });
    } catch (error) {
      resultadoProporcionalidad = null;
    }
  }

  // circulomejora006_reporte05 — misma presentación estructurada ya
  // localizada arriba para Proporcionalidad; reutilizada aquí (nunca
  // recalculada dos veces) — mismo requisito de existencia exacta.
  let resultadoEspecificidad = null;
  if (llmService && presentacionesEstructuradas.length === 1) {
    try {
      resultadoEspecificidad = await evaluarEspecificidadDestinoCompleta({
        uow,
        sesionId,
        afirmacionId: head.afirmacion.id,
        presentacionId: presentacionesEstructuradas[0].presentacionId,
        llmService,
        model,
      });
    } catch (error) {
      resultadoEspecificidad = null;
    }
  }

  // circulomejora006_reporte07 — misma presentación estructurada ya
  // localizada arriba; reutilizada aquí (nunca recalculada dos veces).
  let resultadoDiferenciaTransformacional = null;
  if (llmService && presentacionesEstructuradas.length === 1) {
    try {
      resultadoDiferenciaTransformacional = await evaluarDiferenciaTransformacionalDestinoCompleta({
        uow,
        sesionId,
        afirmacionId: head.afirmacion.id,
        presentacionId: presentacionesEstructuradas[0].presentacionId,
        llmService,
        model,
      });
    } catch (error) {
      resultadoDiferenciaTransformacional = null;
    }
  }

  // circulomejora006_reporte09 — lectura simple del evento durable que la
  // convergencia Hipótesis→Afirmación persiste en la MISMA transacción que
  // autoriza la Afirmación (ver InteraccionCognitivaWriter.js). Nunca se
  // reconstruye ni se infiere: si el evento no existe, el array queda
  // vacío y el gate de reconocimiento (BaseDefendibleDestinoPolicy.js) falla
  // cerrado para la vía nueva (y recae en la señal legacy si esta existe).
  const eventosConvergenciaHipotesisAfirmacion = uow.eventRepo.findBySesionAndType(
    sesionId, 'hipotesis_transformacional.convergio_a_afirmacion',
  );

  const vista = {
    sesionId,
    cabeza: { afirmacion, revisionCabeza: head.revisionCabeza },
    afirmacionVigente: afirmacion,
    historialCausal: historialSnapshot,
    conocimientoAutorizado,
    relacionesAutorizadas,
    relacionesCandidatas: relaciones,
    contradiccionesActivas,
    grafoSesionId: graph.sesionId,
    autenticidadExternaVerificada: false,
    resultadoObservabilidad,
    resultadoProporcionalidad,
    resultadoEspecificidad,
    resultadoDiferenciaTransformacional,
    eventosConvergenciaHipotesisAfirmacion,
  };
  const certificada = deepFreeze(vista);
  vistasCertificadas.add(certificada);
  return certificada;
}

function esVistaCertificada(vista) {
  return !!vista && typeof vista === 'object' && vistasCertificadas.has(vista);
}

module.exports = { prepararVista, esVistaCertificada };
