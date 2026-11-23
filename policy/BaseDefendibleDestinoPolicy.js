'use strict';

const { esVistaCertificada } = require('./_BaseDefendibleDestinoViewProcessLocal');
const { ESTADOS_QUE_RETIRAN_OBSERVABILIDAD_NO_DEMOSTRADA } = require('../schemas/CriterioObservabilidadDestino');

const RESULTADOS_ROUNDTRIP_VALIDOS = new Set([
  'RECONOCIDA_SIN_CORRECCION', 'CORRECCION_SEMANTICA', 'RECHAZADA', 'SIN_EVIDENCIA',
]);

const ESTADOS_OBSERVABILIDAD_QUE_RETIRAN = new Set(ESTADOS_QUE_RETIRAN_OBSERVABILIDAD_NO_DEMOSTRADA);

// circulomejora006_act07c: única condición del umbral aprobado que
// BaseDefendibleDestinoPolicy evalúa. resultadoObservabilidad ya llega
// gobernado (selector→evaluador→validador ya se ejecutaron y ya fallaron
// cerrado en cualquier caso dudoso) — esta policy no invoca a ninguno de
// los tres, no hace I/O, no repite el juicio semántico.
function observabilidadDemostrada(resultadoObservabilidad) {
  return !!resultadoObservabilidad
    && resultadoObservabilidad.dimension === 'criterioObservabilidad'
    && ESTADOS_OBSERVABILIDAD_QUE_RETIRAN.has(resultadoObservabilidad.estado);
}

function normalizarTexto(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\s+/g, ' ').trim();
}

function identidadSoportes(soporte) {
  return new Set([...(soporte && soporte.conceptoIds || [])]);
}

function todosConceptosAutorizados(ids, autorizados) {
  return ids.size > 0 && [...ids].every(id => autorizados.has(id));
}

function encontrarResultadoRoundTrip(vista, afirmacion) {
  const presentaciones = vista.historialCausal.presentaciones || [];
  const resultados = vista.historialCausal.roundTrips || [];
  const presentacionesVigentes = presentaciones.filter(item => (
    item.afirmacionId === afirmacion.id && item.afirmacionVersion === afirmacion.version
  ));
  if (presentacionesVigentes.length === 0) return { estado: 'SIN_PRESENTACION' };
  if (presentacionesVigentes.length !== 1) return { estado: 'PRESENTACION_AMBIGUA' };
  const presentacion = presentacionesVigentes[0];
  const candidatos = resultados.filter(item => (
    item.presentacionId === presentacion.presentacionId
    && item.afirmacionId === afirmacion.id
  ));
  if (candidatos.length !== 1) return { estado: candidatos.length === 0 ? 'SIN_RESULTADO' : 'RESULTADO_AMBIGUO' };
  const resultado = candidatos[0].resultado;
  if (!RESULTADOS_ROUNDTRIP_VALIDOS.has(resultado)) return { estado: 'RESULTADO_INVALIDO' };
  return { estado: resultado, presentacionId: presentacion.presentacionId };
}

// circulomejora006_reporte09 — el flujo productivo vigente (Hipótesis
// confirmada → convergencia → Afirmación autorizada) nunca recorre el ciclo
// round-trip clásico: nunca llama a registrarEvaluacionRoundTripTransformacional,
// así que `roundTrip.estado` jamás es 'RECONOCIDA_SIN_CORRECCION' para una
// Afirmación nacida de ese flujo, sin relación alguna con su calidad real.
// Exigirlo haría BASE_DEFENDIBLE estructuralmente inalcanzable para
// cualquier Afirmación de ese flujo.
//
// La evidencia durable que el flujo SÍ produce, en la MISMA transacción SQL
// que autoriza la Afirmación (ver InteraccionCognitivaWriter.js): el evento
// 'hipotesis_transformacional.convergio_a_afirmacion' (liga esta Afirmación
// exacta — por id y version — a una Hipótesis que el usuario CONFIRMÓ) y una
// PresentacionTransformacionalEstructurada (schemaVersion 2) para esa MISMA
// afirmacionId+version (derivada de hipotesisConfirmada.renderPorUnidad,
// nunca reconstruida desde el grafo — ver _AfirmacionTransformacionalDestinoProcessLocal.js).
// Ningún camino del código produce esa combinación sin haber recorrido la
// convergencia real; su sola presencia es prueba suficiente de
// reconocimiento, sin inventar una segunda confirmación.
//
// Compatibilidad legacy: una Afirmación del ciclo clásico (compositor +
// round-trip, o una sucesión/corrección posterior a la autorización — que
// tampoco emite el evento de convergencia) sigue reconociéndose por su
// propia señal durable real — roundTrip.estado==='RECONOCIDA_SIN_CORRECCION'
// — nunca por heurísticas de fecha, ausencia de datos o nombres. Ambas
// señales son mutuamente independientes; basta con que UNA sea real. Nunca
// se exigen las dos a la vez (un único gate de reconocimiento).
function reconocimientoDemostrado(vista, afirmacion, roundTrip) {
  if (roundTrip.estado === 'RECONOCIDA_SIN_CORRECCION') return true;
  if (!afirmacion) return false;
  const eventoConvergencia = (vista.eventosConvergenciaHipotesisAfirmacion || []).some(evento => (
    evento && evento.payload
    && evento.payload.afirmacionTransformacionalId === afirmacion.id
    && evento.payload.afirmacionVersion === afirmacion.version
  ));
  if (!eventoConvergencia) return false;
  const presentaciones = vista.historialCausal.presentaciones || [];
  return presentaciones.some(item => (
    item.afirmacionId === afirmacion.id && item.afirmacionVersion === afirmacion.version && item.schemaVersion === 2
  ));
}

function evaluarVista(vista) {
  if (!esVistaCertificada(vista)) throw new Error('VISTA_DESTINO_NO_CERTIFICADA');
  const razones = [];
  const vacios = [];
  const contradicciones = [...(vista.contradiccionesActivas || [])];
  const afirmacion = vista.afirmacionVigente;
  const autorizados = new Set((vista.conocimientoAutorizado || []).map(concepto => concepto.id));
  if (!afirmacion || afirmacion.estado !== 'AUTORIZADA') razones.push('AFIRMACION_NO_AUTORIZADA');
  if (!vista.sesionId || vista.sesionId !== vista.grafoSesionId) razones.push('SESION_INCOHERENTE');

  const constituyentes = afirmacion && afirmacion.constituyentes;
  const inicio = identidadSoportes(constituyentes && constituyentes.inicio);
  const mecanismo = identidadSoportes(constituyentes && constituyentes.mecanismo);
  const resultado = identidadSoportes(constituyentes && constituyentes.resultado);
  const observabilidad = afirmacion && afirmacion.modoObservabilidad === 'CONSTITUYENTE_SEPARADO'
    ? identidadSoportes(constituyentes && constituyentes.observabilidad) : resultado;
  [['INICIO', inicio], ['MECANISMO', mecanismo], ['RESULTADO', resultado]].forEach(([nombre, ids]) => {
    if (!todosConceptosAutorizados(ids, autorizados)) razones.push(`SOPORTE_${nombre}_NO_AUTORIZADO`);
  });
  if (afirmacion && afirmacion.modoObservabilidad === 'CONSTITUYENTE_SEPARADO'
      && !todosConceptosAutorizados(observabilidad, autorizados)) razones.push('OBSERVABILIDAD_NO_RESPALDADA');

  const mismoContenido = inicio.size === resultado.size && [...inicio].every(id => resultado.has(id));
  if (mismoContenido) razones.push('SIN_DIFERENCIA_TRANSFORMACIONAL');
  const descripcion = [...(vista.conocimientoAutorizado || [])].filter(c => (
    inicio.has(c.id) || mecanismo.has(c.id) || resultado.has(c.id) || observabilidad.has(c.id)
  )).map(c => normalizarTexto(c.descripcion));
  // circulomejora006_reporte09 — defensa estructural residual, anterior a
  // los criterios semánticos de especificidad (reporte05). Protege contra
  // descripciones de concepto EN BLANCO, algo que KnowledgeGraph.validateConcept
  // ya rechaza a nivel de esquema — por eso es, en la práctica, casi
  // inalcanzable con datos productivos reales. Se conserva sin cambios ni
  // fusión con ESPECIFICIDAD_NO_DEMOSTRADA (ese es un juicio semántico
  // gobernado por LLM sobre GENERICIDAD, un defecto completamente distinto
  // de "descripción vacía"); una prueba productiva real demuestra que no
  // bloquea una Afirmación válida.
  if (descripcion.some(texto => !texto)) razones.push('ESPECIFICIDAD_INSUFICIENTE');

  // circulomejora006_reporte09 — el respaldo de un enlace causal ya NO
  // exige una relación equivalente en grafo.relaciones: ningún productor
  // actual de 'destino' lo puebla (la convergencia Hipótesis→Afirmación
  // nunca escribe relacionesNuevas), así que exigirlo hacía BASE_DEFENDIBLE
  // estructuralmente inalcanzable. La fuente canónica pasa a ser
  // AfirmacionTransformacionalDestino.enlacesCausales mismo, verificado en
  // dos capas independientes (nunca una sustituye a la otra):
  //   - estructura/topología: ¿los conceptoIds del enlace realmente tocan
  //     AMBOS lados que dice conectar? (nunca solo "están autorizados", sin
  //     relación real con inicio/mecanismo/resultado)
  //   - semántica transformacional: ¿resultadoDiferenciaTransformacional
  //     (evaluador gobernado, ver reporte07) demuestra que el mecanismo
  //     realmente conecta la tríada?
  // grafo.relaciones deja de ser requisito de BaseDefendible para esta
  // capacidad — se documenta aquí, no se mantienen dos fuentes obligatorias
  // de la misma relación.
  const diferenciaTransformacionalDemostrada = !!(vista.resultadoDiferenciaTransformacional
    && vista.resultadoDiferenciaTransformacional.estado === 'DIFERENCIA_DEMOSTRADA');
  const enlaces = afirmacion && afirmacion.enlacesCausales || {};
  [['inicioAMecanismo', inicio, mecanismo], ['mecanismoAResultado', mecanismo, resultado]].forEach(([nombre, desde, hacia]) => {
    const enlace = enlaces[nombre];
    const refs = new Set((enlace && enlace.referenciasConceptoIds) || []);
    if (!todosConceptosAutorizados(refs, autorizados)) razones.push(`ENLACE_${nombre}_SIN_SOPORTE`);
    const topologiaCompatible = [...desde].some(id => refs.has(id)) && [...hacia].some(id => refs.has(id));
    if (!topologiaCompatible || !diferenciaTransformacionalDemostrada) razones.push(`ENLACE_${nombre}_NO_RESPALDADO`);
  });

  const roundTrip = encontrarResultadoRoundTrip(vista, afirmacion);
  if (!reconocimientoDemostrado(vista, afirmacion, roundTrip)) razones.push('RECONOCIMIENTO_NO_DEMOSTRADO');
  if (contradicciones.length > 0) razones.push('CONTRADICCION_NUCLEAR_ACTIVA');

  // El contrato actual no conserva hechos suficientes para demostrar estas
  // propiedades cualitativas. Se bloquean explícitamente en vez de suplirlas
  // con texto, conteos o IDs.
  // circulomejora006_reporte05 — mismo criterio exacto que proporcionalidad
  // (ver comentario de abajo): vista.resultadoEspecificidad ya llega
  // gobernado; INDETERMINADA y ausencia (null) conservan la razón igual que
  // NO_DEMOSTRADA — solo DEMOSTRADA la retira. dimensionesAcumuladas queda
  // disponible en vista.resultadoEspecificidad para auditoría, nunca como
  // razón pública nueva todavía.
  if (!(vista.resultadoEspecificidad && vista.resultadoEspecificidad.estado === 'DEMOSTRADA')) {
    razones.push('ESPECIFICIDAD_NO_DEMOSTRADA');
  }
  if (!observabilidadDemostrada(vista.resultadoObservabilidad)) razones.push('OBSERVABILIDAD_NO_DEMOSTRADA');
  // circulomejora006_reporte04 — única condición del umbral aprobado que
  // este bloque evalúa para proporcionalidad: vista.resultadoProporcionalidad
  // ya llega gobernado (selección→evaluación→validación→agregación ya se
  // ejecutaron y ya fallaron cerrado en cualquier caso dudoso, ver
  // _BaseDefendibleDestinoViewProcessLocal.js) — esta policy no repite ese
  // juicio, solo lee su estado agregado. INDETERMINADA y ausencia (null)
  // conservan la razón exactamente igual que NO_DEMOSTRADA — solo
  // DEMOSTRADA la retira. Las dimensiones detectadas (si las hay) quedan
  // disponibles en vista.resultadoProporcionalidad.dimensionesExceso para
  // auditoría, nunca como razones públicas nuevas todavía.
  if (!(vista.resultadoProporcionalidad && vista.resultadoProporcionalidad.estado === 'DEMOSTRADA')) {
    razones.push('PROPORCIONALIDAD_NO_DEMOSTRADA');
  }
  // circulomejora006_reporte07 — mismo criterio exacto que proporcionalidad/
  // especificidad: vista.resultadoDiferenciaTransformacional ya llega
  // gobernado (selección de la tríada→evaluación única→validación ya se
  // ejecutaron y ya fallaron cerrado en cualquier caso dudoso — nunca hay
  // agregación N→1 aquí, ver SeleccionDiferenciaTransformacionalDestino.js/
  // ValidacionDiferenciaTransformacionalDestino.js). El campo `estado` usa,
  // sin conversión, el vocabulario propio del contrato
  // (DIFERENCIA_DEMOSTRADA/DIFERENCIA_NO_DEMOSTRADA/INDETERMINADA) — nunca
  // una segunda función de mapeo que pueda divergir. INDETERMINADA y
  // ausencia (null) conservan la razón igual que DIFERENCIA_NO_DEMOSTRADA —
  // solo DIFERENCIA_DEMOSTRADA la retira. `SIN_DIFERENCIA_TRANSFORMACIONAL`
  // (arriba, línea ~78) es una defensa estructural DISTINTA — basada en
  // identidad de conceptoIds entre inicio/resultado, nunca en un auditor —
  // y sigue operando de forma independiente, nunca fusionada con esta.
  if (!diferenciaTransformacionalDemostrada) {
    razones.push('DIFERENCIA_TRANSFORMACIONAL_NO_DEMOSTRADA');
  }

  // Una literal no resuelta nunca es autoridad; solo se tolera si ya existen
  // soportes conceptuales independientes para la misma composición.
  const citasNoVerificadas = [];
  let citaSinSoporteIndependiente = false;
  [constituyentes && constituyentes.inicio, constituyentes && constituyentes.mecanismo,
    constituyentes && constituyentes.resultado].forEach(soporte => {
    if (!soporte) return;
    (soporte.referenciasLiterales || []).forEach(cita => citasNoVerificadas.push(cita));
    if ((!Array.isArray(soporte.conceptoIds) || soporte.conceptoIds.length === 0)
        && (soporte.referenciasLiterales || []).length > 0) citaSinSoporteIndependiente = true;
  });
  Object.values(enlaces).forEach(enlace => {
    (enlace && enlace.referenciasLiterales || []).forEach(cita => citasNoVerificadas.push(cita));
    if (enlace && (!Array.isArray(enlace.referenciasConceptoIds) || enlace.referenciasConceptoIds.length === 0)
        && (enlace.referenciasLiterales || []).length > 0) citaSinSoporteIndependiente = true;
  });
  if (citaSinSoporteIndependiente) razones.push('CITA_NO_VERIFICADA_SIN_SOPORTE_INDEPENDIENTE');

  const razonesFinales = [...new Set(razones)];
  const defendible = razonesFinales.length === 0 && inicio.size > 0 && mecanismo.size > 0 && resultado.size > 0;
  if (!defendible && razonesFinales.length === 0) vacios.push('REPRESENTACION_TRANSFORMACIONAL_INSUFICIENTE');
  return Object.freeze({
    resultado: defendible ? 'BASE_DEFENDIBLE' : 'BASE_NO_DEFENDIBLE',
    razones: Object.freeze(razonesFinales),
    soportesUtilizados: Object.freeze([...new Set([...inicio, ...mecanismo, ...resultado, ...observabilidad])]),
    vacios: Object.freeze(vacios),
    contradiccionesRelevantes: Object.freeze(contradicciones),
    diagnostico: Object.freeze({
      sesionId: vista.sesionId,
      afirmacionId: afirmacion && afirmacion.id,
      version: afirmacion && afirmacion.version,
      revisionCabeza: vista.cabeza && vista.cabeza.revisionCabeza,
      roundTrip,
      citasNoVerificadas: Object.freeze(citasNoVerificadas),
      autenticidadExternaVerificada: false,
    }),
  });
}

module.exports = { derivarBaseDefendibleDestino: evaluarVista };
