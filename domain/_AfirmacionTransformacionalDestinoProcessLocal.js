'use strict';

/**
 * Runtime privado de integridad process-local para D1.7-C1-1/C1-2.
 *
 * La política reconoce únicamente confirmación/rechazo explícitos y emite
 * una capacidad opaca. El aplicador es el único consumidor. El registro y
 * el comando explican la decisión, pero nunca pueden ejecutarla solos.
 *
 * Este archivo no es una superficie de dominio. Las fachadas públicas
 * exponen operaciones completas y estrechas; nunca registradores,
 * certificadores ni acceso a los WeakSet/WeakMap.
 *
 * Garantía: las instancias recorrieron estas operaciones en este proceso.
 * No garantiza autenticidad de conocimiento, turno, sesión o repositorio.
 */

const schema = require('../schemas/AfirmacionTransformacionalDestino');
const crypto = require('crypto');

const capacidadesEmitidas = new WeakMap();
const entidadesLegitimas = new WeakSet();
const sesionDurablePorEntidad = new WeakMap();
const propuestasLegitimas = new WeakSet();
const pendientesLegitimas = new WeakSet();
const autorizadasLegitimas = new WeakSet();
const materializacionesLegitimas = new WeakMap();
const registrosVeredictoLegitimos = new WeakMap();
const presentacionesRoundTripLegitimas = new WeakMap();
const respuestasRoundTripAtribuidas = new WeakMap();
const atribucionesRoundTripPorTurnoId = new Map();
const registrosRoundTripLegitimos = new WeakMap();
const capacidadesCorreccionEmitidas = new WeakMap();
const sucesionesPorRegistroRoundTrip = new WeakMap();
const procedenciaCorreccionPorEntidad = new WeakMap();

const REGLAS_CONFIRMACION = Object.freeze([
  /^(?:si,?\s+)?(?:esa|esta)\s+es\s+(?:exactamente\s+)?(?:mi|la)\s+transformacion$/,
  /^confirmo\s+(?:esa|esta|la)\s+transformacion$/,
  /^si,?\s+eso\s+describe\s+(?:bien|correctamente|exactamente)\s+(?:mi|la)\s+transformacion$/,
]);

const REGLAS_RECHAZO = Object.freeze([
  /^no,?\s+(?:esa|esta)\s+no\s+es\s+(?:mi|la)\s+transformacion$/,
  /^rechazo\s+(?:esa|esta|la)\s+transformacion$/,
  /^no,?\s+eso\s+no\s+describe\s+(?:mi|la)\s+transformacion$/,
]);

function congelarProfundo(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(congelarProfundo);
  return Object.freeze(value);
}

function copiarProfundo(value) {
  if (Array.isArray(value)) return value.map(copiarProfundo);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([clave, contenido]) => [clave, copiarProfundo(contenido)]));
  }
  return value;
}

function crearPropuestaTransformacional(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('crearPropuestaTransformacional: params debe ser objeto');
  }
  ['estado', 'autorizacion', 'invalidadaPor'].forEach(campo => {
    if (Object.prototype.hasOwnProperty.call(params, campo)) {
      throw new Error(`crearPropuestaTransformacional: '${campo}' no puede indicarse en creación`);
    }
  });
  if (params.origen && Object.prototype.hasOwnProperty.call(params.origen, 'materializadaEnTurnoId')) {
    throw new Error("crearPropuestaTransformacional: una PROPUESTA no admite 'materializadaEnTurnoId'");
  }
  const propuesta = { ...copiarProfundo(params), estado: 'PROPUESTA' };
  const validacion = schema.validarAfirmacionTransformacionalDestino(propuesta);
  if (!validacion.valid) {
    throw new Error(`AfirmacionTransformacionalDestino inválida — ${validacion.errors.join('; ')}`);
  }
  const creada = congelarProfundo(propuesta);
  entidadesLegitimas.add(creada);
  propuestasLegitimas.add(creada);
  return creada;
}

function materializarPropuestaTransformacional({ propuesta, turnoId } = {}) {
  if (!propuesta || typeof propuesta !== 'object' || !propuestasLegitimas.has(propuesta)) {
    throw new Error('materializarPropuestaTransformacional: PROPUESTA_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  if (propuesta.estado !== 'PROPUESTA') {
    throw new Error('materializarPropuestaTransformacional: ESTADO_NO_PROPUESTA');
  }
  if (typeof turnoId !== 'string' || !turnoId.trim()) {
    throw new Error('materializarPropuestaTransformacional: turnoId es obligatorio');
  }
  const pendiente = copiarProfundo(propuesta);
  pendiente.estado = 'MATERIALIZADA_PENDIENTE';
  pendiente.origen.materializadaEnTurnoId = turnoId;
  const validacion = schema.validarAfirmacionTransformacionalDestino(pendiente);
  if (!validacion.valid) {
    throw new Error(`MATERIALIZADA_PENDIENTE inválida — ${validacion.errors.join('; ')}`);
  }
  const materializada = congelarProfundo(pendiente);
  entidadesLegitimas.add(materializada);
  pendientesLegitimas.add(materializada);
  materializacionesLegitimas.set(materializada, {
    propuestaRef: propuesta,
    turnoId,
  });
  const procedenciaSucesora = procedenciaCorreccionPorEntidad.get(propuesta);
  if (procedenciaSucesora) {
    procedenciaCorreccionPorEntidad.set(materializada, procedenciaSucesora);
  }
  return materializada;
}

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?¡¿]+$/g, '')
    .replace(/\s+/g, ' ');
}

// C4-vertical-1 — catálogo cerrado de CAUSA normativa, campo de primer
// nivel de registroVeredicto, nunca enterrado dentro de
// diagnosticoAtribucion.regla. `tipo` (CONFIRMACION_EXPLICITA/
// RECHAZO_EXPLICITO) sigue siendo el único vocabulario que gobierna
// commitVerdict/aplicarDecisionNormativaTransformacional — `causa` es un
// eje DISTINTO, orientado a consumidores semánticos (p.ej. la proyección
// hacia sintesis_interpretativa) que necesitan distinguir honestamente una
// corrección preautorización de un rechazo total, aunque ambas produzcan
// el mismo estado durable RECHAZADA. CORRECCION_PREAUTORIZACION nunca es
// un tipo de autorización — no aparece en TIPOS_AUTORIZACION del schema ni
// en estadosPorVeredicto del repositorio.
const CAUSAS_VEREDICTO = Object.freeze([
  'CONFIRMACION_EXPLICITA', 'CORRECCION_PREAUTORIZACION', 'RECHAZO_TOTAL',
]);

function clasificarExplicito(textoUsuario) {
  const normalizado = normalizar(textoUsuario);
  if (!normalizado) return null;
  if (REGLAS_CONFIRMACION.some(regla => regla.test(normalizado))) {
    return {
      tipo: 'CONFIRMACION_EXPLICITA', operacion: 'AUTORIZAR',
      causa: 'CONFIRMACION_EXPLICITA', regla: 'GRAMATICA_CONFIRMACION_EXPLICITA',
    };
  }
  if (REGLAS_RECHAZO.some(regla => regla.test(normalizado))) {
    return {
      tipo: 'RECHAZO_EXPLICITO', operacion: 'RECHAZAR',
      causa: 'RECHAZO_TOTAL', regla: 'GRAMATICA_RECHAZO_EXPLICITO',
    };
  }
  return null;
}

function resultadoSinDecision(codigo, hechos = {}) {
  return congelarProfundo({
    tipo: 'SIN_DECISION',
    diagnostico: {
      codigo,
      hechos,
      alcance: 'SOLO_CONFIRMACION_O_RECHAZO_EXPLICITOS',
    },
  });
}

function idRegistro({ afirmacionId, version, turnoId, tipo }) {
  return [
    'veredicto_transformacional',
    encodeURIComponent(afirmacionId),
    `v${version}`,
    encodeURIComponent(turnoId),
    tipo,
  ].join(':');
}

function validarEntradaVeredicto(afirmacion, turno) {
  const validacion = schema.validarAfirmacionTransformacionalDestino(afirmacion);
  if (!validacion.valid) {
    return resultadoSinDecision('AFIRMACION_ESTRUCTURALMENTE_INVALIDA', {
      errores: validacion.errors,
    });
  }
  if (!pendientesLegitimas.has(afirmacion)) {
    return resultadoSinDecision('FOTOGRAFIA_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  if (afirmacion.estado !== 'MATERIALIZADA_PENDIENTE') {
    return resultadoSinDecision('AFIRMACION_NO_PENDIENTE', { estado: afirmacion.estado });
  }
  if (!turno || typeof turno !== 'object' || typeof turno.turnoId !== 'string' || !turno.turnoId.trim()) {
    return resultadoSinDecision('TURNO_SIN_IDENTIDAD');
  }
  if (typeof turno.textoUsuario !== 'string') {
    return resultadoSinDecision('TURNO_SIN_TEXTO_USUARIO');
  }
  return null;
}

/**
 * Cola compartida de emisión: idéntica en ambas entradas (explícita y
 * derivada del protocolo) desde que ya existe una `clasificacion` resuelta.
 * evidenciaAtribucion cita siempre el texto REAL del usuario — nunca un
 * texto sintético fabricado para satisfacer un patrón.
 */
function emitirDecisionNormativaDesdeClasificacion({
  afirmacion, turno, clasificacion, referenteExplicito, alternativasDescartadas,
}) {
  const evidenciaAtribucion = Object.freeze([Object.freeze({
    turnoId: turno.turnoId,
    cita: turno.textoUsuario.trim(),
  })]);
  const registroVeredicto = congelarProfundo({
    id: idRegistro({
      afirmacionId: afirmacion.id,
      version: afirmacion.version,
      turnoId: turno.turnoId,
      tipo: clasificacion.tipo,
    }),
    afirmacionId: afirmacion.id,
    version: afirmacion.version,
    tipo: clasificacion.tipo,
    causa: clasificacion.causa,
    turnoId: turno.turnoId,
    evidenciaAtribucion,
    diagnosticoAtribucion: {
      regla: clasificacion.regla,
      referenteExplicito,
      ambiguedad: false,
      autenticidadExternaVerificada: false,
      alternativasDescartadas: Object.freeze(alternativasDescartadas),
    },
  });
  const comando = congelarProfundo({
    operacion: clasificacion.operacion,
    afirmacionId: afirmacion.id,
    version: afirmacion.version,
    registroVeredicto,
  });
  const capacidad = Object.freeze({});
  registrosVeredictoLegitimos.set(registroVeredicto, {
    fotografiaAnteriorRef: afirmacion,
    operacion: clasificacion.operacion,
    fotografiaResultanteRef: null,
  });
  capacidadesEmitidas.set(capacidad, {
    operacion: clasificacion.operacion,
    afirmacionId: afirmacion.id,
    version: afirmacion.version,
    registroVeredictoRef: registroVeredicto,
    registroVeredictoId: registroVeredicto.id,
    comandoRef: comando,
    estadoPrevioEsperado: 'MATERIALIZADA_PENDIENTE',
    fotografiaAutorizada: afirmacion,
    consumida: false,
  });

  return congelarProfundo({
    tipo: 'DECISION_NORMATIVA',
    registroVeredicto,
    comando,
    capacidad,
  });
}

/**
 * Única entrada de emisión explícita. No acepta clasificaciones externas:
 * reconoce el acto desde textoUsuario mediante una gramática deliberadamente
 * estrecha.
 */
function evaluarVeredictoTransformacionalExplicito({ afirmacion, turno } = {}) {
  const fallo = validarEntradaVeredicto(afirmacion, turno);
  if (fallo) return fallo;

  const clasificacion = clasificarExplicito(turno.textoUsuario);
  if (!clasificacion) {
    return resultadoSinDecision('EVIDENCIA_AMBIGUA_O_FUERA_DE_ALCANCE', {
      huboTexto: turno.textoUsuario.trim().length > 0,
    });
  }
  return emitirDecisionNormativaDesdeClasificacion({
    afirmacion, turno, clasificacion, referenteExplicito: true,
    alternativasDescartadas: [
      'COOPERACION_GENERICA', 'CONTINUACION_SIN_VEREDICTO', 'ROUND_TRIP_IMPLICITO', 'CORRECCION',
    ],
  });
}

// C3-vertical-1 — mapa cerrado: la única fuente admitida es la clasificación
// YA REAL del protocolo (ProgresoConversacionalPolicy.decidirProtocolo,
// clasificacion_respuesta) — nunca una segunda gramática de regex sobre el
// mismo texto. 'ambiguo' deliberadamente no aparece aquí: no produce
// ninguna decisión normativa (conserva la pendiente intacta). 'corrige'
// produce el MISMO tipo durable que 'rechaza' (RECHAZO_EXPLICITO — nunca un
// tercer valor en TIPOS_AUTORIZACION ni en el vocabulario de commitVerdict:
// la corrección preautorización nunca autoriza parcial ni totalmente).
// `causa` (campo de primer nivel, ver CAUSAS_VEREDICTO) es lo que distingue
// honestamente una corrección de un rechazo total para cualquier
// consumidor semántico — nunca enterrado solo en diagnosticoAtribucion.regla.
const MAPA_CLASIFICACION_PROTOCOLO = Object.freeze({
  confirma: Object.freeze({
    tipo: 'CONFIRMACION_EXPLICITA', operacion: 'AUTORIZAR', causa: 'CONFIRMACION_EXPLICITA',
    regla: 'PROTOCOLO_CLASIFICACION_RESPUESTA_CONFIRMA',
  }),
  rechaza: Object.freeze({
    tipo: 'RECHAZO_EXPLICITO', operacion: 'RECHAZAR', causa: 'RECHAZO_TOTAL',
    regla: 'PROTOCOLO_CLASIFICACION_RESPUESTA_RECHAZA',
  }),
  corrige: Object.freeze({
    tipo: 'RECHAZO_EXPLICITO', operacion: 'RECHAZAR', causa: 'CORRECCION_PREAUTORIZACION',
    regla: 'PROTOCOLO_CLASIFICACION_RESPUESTA_CORRIGE_PREAUTORIZACION',
  }),
});

/**
 * Segunda entrada de emisión, gemela de evaluarVeredictoTransformacionalExplicito
 * pero SIN re-clasificar el texto: consume clasificacion_respuesta, ya real
 * y ya producida por el protocolo conversacional, en vez de aplicar una
 * segunda gramática de regex sobre el mismo turno. La evidencia persistida
 * sigue siendo el texto real del usuario — nunca un texto sintético.
 */
function evaluarVeredictoTransformacionalDesdeProtocolo({
  afirmacion, turno, clasificacionProtocolo,
} = {}) {
  const fallo = validarEntradaVeredicto(afirmacion, turno);
  if (fallo) return fallo;

  const clasificacion = MAPA_CLASIFICACION_PROTOCOLO[clasificacionProtocolo];
  if (!clasificacion) {
    return resultadoSinDecision('CLASIFICACION_PROTOCOLO_NO_APLICABLE', {
      clasificacionProtocolo: clasificacionProtocolo || null,
    });
  }
  return emitirDecisionNormativaDesdeClasificacion({
    afirmacion, turno, clasificacion, referenteExplicito: true,
    alternativasDescartadas: ['CORRECCION_PREAUTORIZACION', 'AMBIGUO_SIN_VEREDICTO'],
  });
}

function falloAplicacion(codigo) {
  const error = new Error(`DecisionNormativaTransformacional rechazada: ${codigo}`);
  error.codigo = codigo;
  throw error;
}

/**
 * Única entrada de consumo. No es un transicionador general: solo aplica una
 * decisión emitida por evaluarVeredictoTransformacionalExplicito.
 */
function aplicarDecisionNormativaTransformacional({
  afirmacion, comando, capacidad,
  // C6-vertical-2 (preservación de identidad en sustitución preautorización
  // de cabeza) — opcional, aditivo: nunca cambia el comportamiento existente
  // cuando se omite. Solo tiene efecto junto con AUTORIZAR: fija
  // reemplazaAId sobre la MISMA entidad que se autoriza, en vez de acuñar
  // una identidad sucesora distinta (ver commitAuthorizationReplacingHead).
  reemplazaAId,
} = {}) {
  const permiso = capacidad && typeof capacidad === 'object'
    ? capacidadesEmitidas.get(capacidad) : null;
  if (!permiso) falloAplicacion('CAPACIDAD_DESCONOCIDA');
  if (permiso.consumida) falloAplicacion('CAPACIDAD_YA_CONSUMIDA');
  if (permiso.fotografiaAutorizada !== afirmacion) falloAplicacion('FOTOGRAFIA_DISTINTA');
  if (permiso.comandoRef !== comando) falloAplicacion('COMANDO_DISTINTO');
  if (afirmacion.estado !== permiso.estadoPrevioEsperado) falloAplicacion('ESTADO_PREVIO_DISTINTO');
  if (afirmacion.id !== permiso.afirmacionId || comando.afirmacionId !== permiso.afirmacionId) {
    falloAplicacion('AFIRMACION_DISTINTA');
  }
  if (afirmacion.version !== permiso.version || comando.version !== permiso.version) {
    falloAplicacion('VERSION_DISTINTA');
  }
  if (comando.operacion !== permiso.operacion) falloAplicacion('OPERACION_DISTINTA');
  if (comando.registroVeredicto !== permiso.registroVeredictoRef) {
    falloAplicacion('REGISTRO_REFERENCIA_DISTINTA');
  }
  if (comando.registroVeredicto.id !== permiso.registroVeredictoId) {
    falloAplicacion('REGISTRO_IDENTIDAD_DISTINTA');
  }

  const compatibilidad = (
    permiso.operacion === 'AUTORIZAR'
    && comando.registroVeredicto.tipo === 'CONFIRMACION_EXPLICITA'
  ) || (
    permiso.operacion === 'RECHAZAR'
    && comando.registroVeredicto.tipo === 'RECHAZO_EXPLICITO'
  );
  if (!compatibilidad) falloAplicacion('VEREDICTO_INCOMPATIBLE');

  const estadoDestino = permiso.operacion === 'AUTORIZAR' ? 'AUTORIZADA' : 'RECHAZADA';
  if (!schema.esTransicionTransformacionalDeclarada(afirmacion.estado, estadoDestino)) {
    falloAplicacion('TRANSICION_NO_DECLARADA');
  }

  const siguiente = copiarProfundo(afirmacion);
  siguiente.estado = estadoDestino;
  if (estadoDestino === 'AUTORIZADA') {
    siguiente.autorizacion = {
      tipo: 'CONFIRMACION_EXPLICITA',
      turnoId: comando.registroVeredicto.turnoId,
      referenciasLiterales: copiarProfundo(comando.registroVeredicto.evidenciaAtribucion),
      afirmacionId: afirmacion.id,
      version: afirmacion.version,
    };
    if (reemplazaAId !== undefined) {
      siguiente.reemplazaAId = reemplazaAId;
    }
  } else {
    delete siguiente.autorizacion;
  }

  const validacion = schema.validarAfirmacionTransformacionalDestino(siguiente);
  if (!validacion.valid) falloAplicacion(`RESULTADO_ESTRUCTURALMENTE_INVALIDO:${validacion.errors.join('|')}`);
  const resultado = congelarProfundo(siguiente);
  entidadesLegitimas.add(resultado);
  const procedenciaCorreccion = procedenciaCorreccionPorEntidad.get(afirmacion);
  if (procedenciaCorreccion) {
    procedenciaCorreccionPorEntidad.set(resultado, procedenciaCorreccion);
  }
  if (estadoDestino === 'AUTORIZADA') autorizadasLegitimas.add(resultado);
  const vinculoVeredicto = registrosVeredictoLegitimos.get(comando.registroVeredicto);
  if (vinculoVeredicto) vinculoVeredicto.fotografiaResultanteRef = resultado;
  permiso.consumida = true;
  return resultado;
}

function crearPresentacionRoundTripTransformacional({ afirmacion, turnoPresentacionId } = {}) {
  if (!afirmacion || typeof afirmacion !== 'object' || !autorizadasLegitimas.has(afirmacion)) {
    throw new Error('crearPresentacionRoundTripTransformacional: AFIRMACION_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  if (afirmacion.estado !== 'AUTORIZADA') {
    throw new Error('crearPresentacionRoundTripTransformacional: AFIRMACION_NO_AUTORIZADA');
  }
  if (typeof turnoPresentacionId !== 'string' || !turnoPresentacionId.trim()) {
    throw new Error('crearPresentacionRoundTripTransformacional: turnoPresentacionId es obligatorio');
  }
  const presentacion = congelarProfundo({
    afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version,
    turnoPresentacionId,
    formulacionPresentada: afirmacion.origen.formulacionPropuesta,
    constituyentesReferenciados: Object.keys(afirmacion.constituyentes).sort(),
    autenticidadExternaVerificada: false,
  });
  presentacionesRoundTripLegitimas.set(presentacion, {
    afirmacionRef: afirmacion,
    afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version,
    turnoPresentacionId,
    formulacionPresentada: presentacion.formulacionPresentada,
  });
  return presentacion;
}

function canonico(value) {
  if (Array.isArray(value)) return value.map(canonico);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonico(value[k])]));
  }
  return value;
}

function identidadRender(unidades, texto) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonico({ unidades, texto })))
    .digest('hex');
}

const TIPOS_UNIDAD_ESTRUCTURADA = Object.freeze([
  'CONSTITUYENTE', 'ENLACE_CAUSAL',
]);
// circulomejora006_reporte03 (productividad de PresentacionTransformacionalEstructurada)
// — OBSERVABILIDAD/RESULTADO_A_OBSERVABILIDAD se agregan de forma aditiva:
// el contrato original (C1) nunca los admitía porque predata el modo
// CONSTITUYENTE_SEPARADO de 'destino' — ninguna presentación histórica
// (modo INTEGRADA_EN_RESULTADO) los usa ni los necesita, ver TOPOLOGIA_POR_MODO.
const ROLES_UNIDAD_ESTRUCTURADA = Object.freeze([
  'INICIO', 'MECANISMO', 'RESULTADO', 'OBSERVABILIDAD',
  'INICIO_A_MECANISMO', 'MECANISMO_A_RESULTADO', 'RESULTADO_A_OBSERVABILIDAD',
]);
const ROLES_CONSTITUYENTE = new Set(['INICIO', 'MECANISMO', 'RESULTADO', 'OBSERVABILIDAD']);
const ROLES_ENLACE = new Set(['INICIO_A_MECANISMO', 'MECANISMO_A_RESULTADO', 'RESULTADO_A_OBSERVABILIDAD']);
const CLAVE_ENLACE_POR_ROL = Object.freeze({
  INICIO_A_MECANISMO: 'inicioAMecanismo',
  MECANISMO_A_RESULTADO: 'mecanismoAResultado',
  RESULTADO_A_OBSERVABILIDAD: 'resultadoAObservabilidad',
});
// circulomejora006_reporte03 — topología válida DERIVADA del modo real de
// la Afirmación (nunca un número mágico global): `completa` es el conjunto
// total de unidades trazables (visibles + estructurales); `visible` es el
// subconjunto — y ORDEN causal exacto — que debe aparecer en secuenciaVisible.
//   INTEGRADA_EN_RESULTADO — topología histórica, sin cambios: 5 unidades,
//     TODAS visibles (compatibilidad total con presentaciones/tests ya
//     existentes bajo este modo).
//   CONSTITUYENTE_SEPARADO — modo real de 'destino' (ver
//     ConvergenciaTransformacionalDestinoOrquestacion.js): 7 unidades
//     trazables, pero solo las 4 CONSTITUYENTE son visibles. Auditoría de
//     _FormulacionTransformacionalDestinoTemplate.js: el conector causal de
//     cada enlace ("Mediante:", "Se llega a:", "Esto se sabrá porque:") vive
//     PEGADO al texto del constituyente siguiente — nunca existe un
//     segmento visual propio para el enlace en sí. Forzar una unidad visible
//     para un enlace inventaría una frase que el usuario nunca vio como tal
//     — los tres enlaces viajan como unidades ESTRUCTURALES trazables
//     (soporte C1 real, `procedenciaOperativa:'SOPORTADO_PERO_NO_EXPRESADO'`,
//     sin contenido visible propio), nunca como texto visible.
const TOPOLOGIA_POR_MODO = Object.freeze({
  INTEGRADA_EN_RESULTADO: Object.freeze({
    completa: Object.freeze(['INICIO', 'INICIO_A_MECANISMO', 'MECANISMO', 'MECANISMO_A_RESULTADO', 'RESULTADO']),
    visible: Object.freeze(['INICIO', 'INICIO_A_MECANISMO', 'MECANISMO', 'MECANISMO_A_RESULTADO', 'RESULTADO']),
  }),
  CONSTITUYENTE_SEPARADO: Object.freeze({
    completa: Object.freeze([
      'INICIO', 'INICIO_A_MECANISMO', 'MECANISMO', 'MECANISMO_A_RESULTADO',
      'RESULTADO', 'RESULTADO_A_OBSERVABILIDAD', 'OBSERVABILIDAD',
    ]),
    visible: Object.freeze(['INICIO', 'MECANISMO', 'RESULTADO', 'OBSERVABILIDAD']),
  }),
});

function clavesPermitidas(obj, permitidas, nombre) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${nombre}_INVALIDO`);
  Object.keys(obj).forEach(k => { if (!permitidas.includes(k)) throw new Error(`${nombre}_CAMPO_NO_PERMITIDO:${k}`); });
}

function soportesCanonicos(soportes) {
  if (!soportes || typeof soportes !== 'object' || Array.isArray(soportes)) throw new Error('SOPORTES_REFERENCIADOS_INVALIDOS');
  clavesPermitidas(soportes, ['conceptoIds', 'referenciasLiterales'], 'SOPORTES_REFERENCIADOS');
  if (!Array.isArray(soportes.conceptoIds) || !Array.isArray(soportes.referenciasLiterales)) {
    throw new Error('SOPORTES_REFERENCIADOS_INCOMPLETOS');
  }
  return canonico({ conceptoIds: [...soportes.conceptoIds].sort(), referenciasLiterales: soportes.referenciasLiterales });
}

function soporteEsSubconjunto(declarados, disponibles) {
  const conceptos = new Set(disponibles.conceptoIds || []);
  const literales = new Set((disponibles.referenciasLiterales || []).map(x => JSON.stringify(canonico(x))));
  return (declarados.conceptoIds || []).every(id => conceptos.has(id))
    && (declarados.referenciasLiterales || []).every(x => literales.has(JSON.stringify(canonico(x))));
}

function soporteC1ParaUnidad(afirmacion, unidad) {
  const ref = unidad.referenciaC1;
  if (!ref || typeof ref !== 'object') throw new Error('REFERENCIA_C1_OBLIGATORIA');
  clavesPermitidas(ref, ['tipo', 'rol'], 'REFERENCIA_C1');
  if (ref.tipo === 'CONSTITUYENTE' && ROLES_CONSTITUYENTE.has(ref.rol)) {
    return afirmacion.constituyentes[ref.rol.toLowerCase()];
  }
  if (ref.tipo === 'ENLACE_CAUSAL' && ROLES_ENLACE.has(ref.rol)) {
    return afirmacion.enlacesCausales[CLAVE_ENLACE_POR_ROL[ref.rol]];
  }
  throw new Error('REFERENCIA_C1_TIPO_ROL_INCOHERENTE');
}

function normalizarUnidad(afirmacion, unidad, visible, orden) {
  if (!unidad || typeof unidad !== 'object' || Array.isArray(unidad)) throw new Error('UNIDAD_INVALIDA');
  clavesPermitidas(unidad, [
    'unidadLocalId', 'tipo', 'rol', 'referenciaC1', 'soportesReferenciados',
    'contenidoVisibleEstructurado', 'metadatosRender', 'procedenciaOperativa',
  ], 'UNIDAD');
  if (typeof unidad.unidadLocalId !== 'string' || !unidad.unidadLocalId.trim()) throw new Error('UNIDAD_ID_INVALIDO');
  if (!TIPOS_UNIDAD_ESTRUCTURADA.includes(unidad.tipo) || !ROLES_UNIDAD_ESTRUCTURADA.includes(unidad.rol)) {
    throw new Error('UNIDAD_TIPO_O_ROL_INVALIDO');
  }
  if (unidad.tipo === 'CONSTITUYENTE' && !ROLES_CONSTITUYENTE.has(unidad.rol)) throw new Error('TIPO_ROL_INCOMPATIBLE');
  if (unidad.tipo === 'ENLACE_CAUSAL' && !ROLES_ENLACE.has(unidad.rol)) throw new Error('TIPO_ROL_INCOMPATIBLE');
  const disponible = soporteC1ParaUnidad(afirmacion, unidad);
  if (unidad.referenciaC1.tipo !== unidad.tipo || unidad.referenciaC1.rol !== unidad.rol) throw new Error('REFERENCIA_C1_UNIDAD_INCOHERENTE');
  if (!disponible) throw new Error('REFERENCIA_C1_INEXISTENTE');
  const soportes = soportesCanonicos(unidad.soportesReferenciados);
  if (soportes.conceptoIds.length + soportes.referenciasLiterales.length === 0) throw new Error('SOPORTE_REAL_OBLIGATORIO');
  const disponibles = disponible.referenciasConceptoIds
    ? { conceptoIds: disponible.referenciasConceptoIds, referenciasLiterales: disponible.referenciasLiterales || [] }
    : disponible;
  if (!soporteEsSubconjunto(soportes, disponibles)) throw new Error('SOPORTE_NO_PERTENECE_A_REFERENCIA_C1');
  const contenido = unidad.contenidoVisibleEstructurado;
  const textoNormalizado = visible ? String(contenido && contenido.texto || '').trim().replace(/\s+/g, ' ') : null;
  if (visible && (!contenido || typeof contenido !== 'object' || typeof contenido.texto !== 'string' || !textoNormalizado)) {
    throw new Error('UNIDAD_VISIBLE_SIN_CONTENIDO');
  }
  const metadatos = unidad.metadatosRender && typeof unidad.metadatosRender === 'object'
    ? canonico({ ...unidad.metadatosRender }) : {};
  if (Object.prototype.hasOwnProperty.call(metadatos, 'incluirEnTexto') || Object.prototype.hasOwnProperty.call(metadatos, 'orden')) {
    throw new Error('METADATOS_RENDER_NO_CONTROLAN_VISIBILIDAD');
  }
  if (metadatos.secuencia !== undefined && metadatos.secuencia !== orden) {
    throw new Error('METADATOS_RENDER_SECUENCIA_INCOHERENTE');
  }
  const procedencia = visible ? 'EXPRESADO_EN_FORMULACION' : 'SOPORTADO_PERO_NO_EXPRESADO';
  if (unidad.procedenciaOperativa !== undefined && unidad.procedenciaOperativa !== procedencia) throw new Error('PROCEDENCIA_OPERATIVA_INCOHERENTE');
  return {
    unidadLocalId: unidad.unidadLocalId, tipo: unidad.tipo, rol: unidad.rol,
    referenciaC1: canonico(unidad.referenciaC1), soportesReferenciados: soportes,
    contenidoVisibleEstructurado: visible ? { texto: textoNormalizado } : null,
    metadatosRender: { ...metadatos, secuencia: visible ? orden : null },
    procedenciaOperativa: procedencia,
  };
}

function crearPresentacionIdEstructurada({ sesionId, afirmacionId, version, turnoPresentacionId, identidadRender: renderId }) {
  return [
    'presentacion_transformacional_estructurada', encodeURIComponent(sesionId),
    encodeURIComponent(afirmacionId), `v${version}`,
    encodeURIComponent(turnoPresentacionId), renderId,
  ].join(':');
}

function validarYNormalizarUnidades(afirmacion, unidades, secuenciaVisible) {
  if (!Array.isArray(unidades) || !Array.isArray(secuenciaVisible)) throw new Error('UNIDADES_ESTRUCTURADAS_INVALIDAS');
  const topologiaModo = TOPOLOGIA_POR_MODO[afirmacion && afirmacion.modoObservabilidad];
  if (!topologiaModo) throw new Error('TOPOLOGIA_C1_MODO_OBSERVABILIDAD_DESCONOCIDO');
  const { completa: topologiaCompleta, visible: topologiaVisible } = topologiaModo;
  const visibles = new Set(secuenciaVisible);

  if (unidades.length > topologiaCompleta.length) throw new Error('TOPOLOGIA_C1_UNIDADES_ADICIONALES');
  if (secuenciaVisible.length !== topologiaVisible.length) throw new Error('TOPOLOGIA_C1_INCOMPLETA');

  const ids = new Set();
  const normalizadas = unidades.map(unidad => {
    if (!unidad || ids.has(unidad.unidadLocalId)) throw new Error('UNIDAD_DUPLICADA');
    const visible = visibles.has(unidad.unidadLocalId);
    const normalizada = normalizarUnidad(afirmacion, unidad, visible, visible ? secuenciaVisible.indexOf(unidad.unidadLocalId) : null);
    // circulomejora006_reporte03 — un enlace estructural nunca puede
    // declararse visible bajo un modo cuya topología no lo expone como
    // cláusula propia (ver docstring de TOPOLOGIA_POR_MODO): evita inventar
    // contenido que el usuario nunca vio como frase independiente.
    if (visible && !topologiaVisible.includes(normalizada.rol)) {
      throw new Error('TOPOLOGIA_C1_UNIDAD_NO_VISIBLE_PARA_ESTE_MODO');
    }
    ids.add(normalizada.unidadLocalId);
    return normalizada;
  });

  if (new Set(secuenciaVisible).size !== secuenciaVisible.length) throw new Error('SECUENCIA_VISIBLE_DUPLICADA');
  if (secuenciaVisible.some(id => !ids.has(id))) throw new Error('SECUENCIA_VISIBLE_REFERENCIA_UNIDAD_INEXISTENTE');
  // Mismo orden de comprobación que el contrato histórico (INTEGRADA_EN_RESULTADO,
  // completa===visible): orden/unicidad de lo VISIBLE se verifica antes que
  // la completitud del conjunto total — un rol repetido entre visibles ya es
  // TOPOLOGIA_C1_ORDEN_INCOHERENTE, nunca INCOMPLETA, preservando el mensaje
  // exacto que ya esperan las pruebas existentes.
  const rolesVisibles = secuenciaVisible.map(id => normalizadas.find(u => u.unidadLocalId === id).rol);
  if (
    rolesVisibles.some((rol, i) => rol !== topologiaVisible[i])
    || new Set(rolesVisibles).size !== topologiaVisible.length
  ) {
    throw new Error('TOPOLOGIA_C1_ORDEN_INCOHERENTE');
  }

  if (normalizadas.length !== topologiaCompleta.length) throw new Error('TOPOLOGIA_C1_UNIDADES_ADICIONALES');
  const rolesCompletos = normalizadas.map(u => u.rol);
  if (
    new Set(rolesCompletos).size !== topologiaCompleta.length
    || !topologiaCompleta.every(rol => rolesCompletos.includes(rol))
  ) {
    throw new Error('TOPOLOGIA_C1_INCOMPLETA');
  }
  return normalizadas;
}

function validarPresentacionEstructuradaInterna({ contenido, row, afirmacion } = {}) {
  if (!contenido || contenido.schemaVersion !== 2 || !Array.isArray(contenido.unidades) || !Array.isArray(contenido.secuenciaVisible)) throw new Error('PRESENTACION_ESTRUCTURADA_SCHEMA_INVALIDO');
  clavesPermitidas(contenido, ['presentacionId', 'sesionId', 'afirmacionId', 'afirmacionVersion', 'schemaVersion', 'turnoPresentacionId', 'secuenciaVisible', 'unidades', 'textoRenderizadoExacto', 'identidadRender', 'autenticidadExternaVerificada'], 'PRESENTACION_ESTRUCTURADA');
  if (contenido.presentacionId !== row.presentacion_id || contenido.sesionId !== row.sesion_id
      || contenido.afirmacionId !== row.afirmacion_id || contenido.afirmacionVersion !== afirmacion.version) {
    throw new Error('PRESENTACION_ESTRUCTURADA_IDENTIDAD_INCOHERENTE');
  }
  const unidades = validarYNormalizarUnidades(afirmacion, contenido.unidades, contenido.secuenciaVisible);
  const visibles = contenido.secuenciaVisible.map(idLocal => unidades.find(u => u.unidadLocalId === idLocal));
  if (visibles.length === 0 || visibles.some((u, i) => !u || u.metadatosRender.secuencia !== i)) throw new Error('PRESENTACION_ESTRUCTURADA_SECUENCIA_INCOHERENTE');
  const texto = visibles.map(u => u.contenidoVisibleEstructurado.texto).join(' ');
  const hash = identidadRender(unidades, texto);
  const id = crearPresentacionIdEstructurada({ sesionId: contenido.sesionId, afirmacionId: contenido.afirmacionId, version: contenido.afirmacionVersion, turnoPresentacionId: contenido.turnoPresentacionId, identidadRender: hash });
  if (texto !== contenido.textoRenderizadoExacto || hash !== contenido.identidadRender || id !== contenido.presentacionId) throw new Error('PRESENTACION_ESTRUCTURADA_RENDER_INCOHERENTE');
  return true;
}

function crearPresentacionTransformacionalEstructurada({
  afirmacion, sesionId, turnoPresentacionId, estructura,
} = {}) {
  if (!afirmacion || !autorizadasLegitimas.has(afirmacion)) {
    throw new Error('crearPresentacionTransformacionalEstructurada: AFIRMACION_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  if (afirmacion.estado !== 'AUTORIZADA') {
    throw new Error('crearPresentacionTransformacionalEstructurada: AFIRMACION_NO_AUTORIZADA');
  }
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('crearPresentacionTransformacionalEstructurada: sesionId es obligatorio');
  }
  if (typeof turnoPresentacionId !== 'string' || !turnoPresentacionId.trim()) {
    throw new Error('crearPresentacionTransformacionalEstructurada: turnoPresentacionId es obligatorio');
  }
  const sesionConocida = sesionDurablePorEntidad.get(afirmacion);
  if (sesionConocida && sesionConocida !== sesionId) {
    throw new Error('crearPresentacionTransformacionalEstructurada: AFIRMACION_PERTENECE_A_OTRA_SESION');
  }
  if (!estructura || typeof estructura !== 'object' || Array.isArray(estructura)) throw new Error('ESTRUCTURA_PRESENTACION_INVALIDA');
  // circulomejora006_reporte03 — unidadesEstructurales es aditivo y
  // opcional (default []): unidades trazables (con soporte C1 real) que la
  // topología del modo real de la Afirmación exige para estar COMPLETA,
  // pero que esa MISMA topología nunca expone como texto visible (ver
  // TOPOLOGIA_POR_MODO) — nunca se les asigna contenidoVisibleEstructurado
  // (normalizarUnidad ya lo fuerza a null para toda unidad no visible).
  // Cualquier llamador histórico que solo conocía `unidadesVisibles` sigue
  // funcionando byte-idéntico (unidadesEstructurales=[] no cambia nada).
  clavesPermitidas(estructura, ['unidadesVisibles', 'unidadesEstructurales'], 'ESTRUCTURA_PRESENTACION');
  const unidadesVisibles = estructura.unidadesVisibles;
  const unidadesEstructurales = estructura.unidadesEstructurales !== undefined ? estructura.unidadesEstructurales : [];
  if (!Array.isArray(unidadesVisibles) || unidadesVisibles.length === 0) throw new Error('UNIDADES_VISIBLES_OBLIGATORIAS');
  if (!Array.isArray(unidadesEstructurales)) throw new Error('UNIDADES_ESTRUCTURALES_INVALIDAS');
  const secuenciaVisible = unidadesVisibles.map(unidad => unidad && unidad.unidadLocalId);
  const normalizadas = validarYNormalizarUnidades(
    afirmacion, [...unidadesVisibles, ...unidadesEstructurales], secuenciaVisible,
  );
  const textoRenderizadoExacto = secuenciaVisible.map(idLocal => normalizadas.find(x => x.unidadLocalId === idLocal).contenidoVisibleEstructurado.texto).join(' ');
  if (!textoRenderizadoExacto) throw new Error('crearPresentacionTransformacionalEstructurada: RENDER_VACIO');
  const unidadesNormalizadas = normalizadas;
  const renderId = identidadRender(unidadesNormalizadas, textoRenderizadoExacto);
  const presentacionId = crearPresentacionIdEstructurada({ sesionId, afirmacionId: afirmacion.id, version: afirmacion.version, turnoPresentacionId, identidadRender: renderId });
  const presentacion = congelarProfundo({
    presentacionId, sesionId, afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version, schemaVersion: 2,
    turnoPresentacionId, secuenciaVisible, unidades: normalizadas,
    textoRenderizadoExacto, identidadRender: renderId,
    autenticidadExternaVerificada: false,
  });
  presentacionesRoundTripLegitimas.set(presentacion, {
    afirmacionRef: afirmacion, afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version, turnoPresentacionId,
    formulacionPresentada: textoRenderizadoExacto,
    presentacionId, sesionId, estructurada: true,
  });
  return presentacion;
}

function idRegistroRoundTrip({
  afirmacionId, afirmacionVersion, turnoPresentacionId, turnoRespuestaId, resultado,
}) {
  return [
    'round_trip_transformacional',
    encodeURIComponent(afirmacionId),
    `v${afirmacionVersion}`,
    encodeURIComponent(turnoPresentacionId),
    encodeURIComponent(turnoRespuestaId),
    resultado,
  ].join(':');
}

function registrarEvaluacionRoundTripTransformacional({
  afirmacion, presentacion, turnoRespuesta, clasificacion,
} = {}) {
  const vinculacion = presentacion && typeof presentacion === 'object'
    ? presentacionesRoundTripLegitimas.get(presentacion) : null;
  if (!vinculacion) throw new Error('evaluarRoundTripTransformacional: PRESENTACION_SIN_INTEGRIDAD_PROCESS_LOCAL');
  if (vinculacion.afirmacionRef !== afirmacion) {
    throw new Error('evaluarRoundTripTransformacional: AFIRMACION_DISTINTA');
  }
  if (
    afirmacion.id !== vinculacion.afirmacionId
    || afirmacion.version !== vinculacion.afirmacionVersion
  ) {
    throw new Error('evaluarRoundTripTransformacional: IDENTIDAD_DURABLE_DISTINTA');
  }
  const textoPresentado = presentacion.textoRenderizadoExacto !== undefined
    ? presentacion.textoRenderizadoExacto : presentacion.formulacionPresentada;
  if (
    presentacion.turnoPresentacionId !== vinculacion.turnoPresentacionId
    || textoPresentado !== vinculacion.formulacionPresentada
  ) {
    throw new Error('evaluarRoundTripTransformacional: PRESENTACION_ALTERADA');
  }
  if (
    !turnoRespuesta || typeof turnoRespuesta !== 'object'
    || typeof turnoRespuesta.turnoId !== 'string' || !turnoRespuesta.turnoId.trim()
    || typeof turnoRespuesta.textoUsuario !== 'string'
  ) {
    throw new Error('evaluarRoundTripTransformacional: RESPUESTA_INVALIDA');
  }
  if (turnoRespuesta.turnoId === vinculacion.turnoPresentacionId) {
    throw new Error('evaluarRoundTripTransformacional: RESPUESTA_MISMO_TURNO_PRESENTACION');
  }
  if (
    !clasificacion || typeof clasificacion !== 'object'
    || ![
      'RECONOCIDA_SIN_CORRECCION',
      'CORRECCION_SEMANTICA',
      'RECHAZADA',
      'SIN_EVIDENCIA',
    ].includes(clasificacion.resultado)
    || typeof clasificacion.regla !== 'string'
  ) {
    throw new Error('evaluarRoundTripTransformacional: CLASIFICACION_INVALIDA');
  }

  const presentacionPrevia = respuestasRoundTripAtribuidas.get(turnoRespuesta);
  if (presentacionPrevia && presentacionPrevia !== presentacion) {
    throw new Error('evaluarRoundTripTransformacional: RESPUESTA_YA_ATRIBUIDA_A_OTRA_PRESENTACION');
  }

  const textoExacto = turnoRespuesta.textoUsuario;
  const atribucionExistente = atribucionesRoundTripPorTurnoId.get(turnoRespuesta.turnoId);
  if (atribucionExistente) {
    if (atribucionExistente.textoExacto !== textoExacto) {
      throw new Error('evaluarRoundTripTransformacional: TURNO_RESPUESTA_TEXTO_CONFLICTIVO');
    }
    if (
      atribucionExistente.presentacionRef !== presentacion
      || atribucionExistente.afirmacionRef !== afirmacion
    ) {
      throw new Error('evaluarRoundTripTransformacional: TURNO_RESPUESTA_YA_ATRIBUIDO');
    }
    if (atribucionExistente.resultado !== clasificacion.resultado) {
      throw new Error('evaluarRoundTripTransformacional: TURNO_RESPUESTA_RESULTADO_CONFLICTIVO');
    }
    respuestasRoundTripAtribuidas.set(turnoRespuesta, presentacion);
    return atribucionExistente.registroRef;
  }

  const registro = congelarProfundo({
    id: idRegistroRoundTrip({
      afirmacionId: afirmacion.id,
      afirmacionVersion: afirmacion.version,
      turnoPresentacionId: vinculacion.turnoPresentacionId,
      turnoRespuestaId: turnoRespuesta.turnoId,
      resultado: clasificacion.resultado,
    }),
    afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version,
    turnoPresentacionId: vinculacion.turnoPresentacionId,
    turnoRespuestaId: turnoRespuesta.turnoId,
    formulacionPresentada: vinculacion.formulacionPresentada,
    resultado: clasificacion.resultado,
    evidencia: [{
      turnoId: turnoRespuesta.turnoId,
      cita: turnoRespuesta.textoUsuario.trim(),
    }],
    diagnosticoAtribucion: {
      regla: clasificacion.regla,
      prioridadAplicada: [
        'CORRECCION_SEMANTICA',
        'RECHAZADA',
        'RECONOCIDA_SIN_CORRECCION',
        'SIN_EVIDENCIA',
      ],
      autenticidadExternaVerificada: false,
      ordenConversacionalVerificado: false,
      concedeAutorizacionNormativa: false,
    },
  });
  respuestasRoundTripAtribuidas.set(turnoRespuesta, presentacion);
  atribucionesRoundTripPorTurnoId.set(turnoRespuesta.turnoId, {
    presentacionRef: presentacion,
    afirmacionRef: afirmacion,
    textoExacto,
    resultado: clasificacion.resultado,
    registroRef: registro,
  });
  registrosRoundTripLegitimos.set(registro, {
    afirmacionRef: afirmacion,
    presentacionRef: presentacion,
    turnoRespuestaRef: turnoRespuesta,
    afirmacionId: afirmacion.id,
    afirmacionVersion: afirmacion.version,
    formulacionPresentada: vinculacion.formulacionPresentada,
  });
  return registro;
}

function prepararCorreccionTransformacionalInterna({
  afirmacion, presentacion, registroRoundTrip,
} = {}) {
  const vinculo = registroRoundTrip && typeof registroRoundTrip === 'object'
    ? registrosRoundTripLegitimos.get(registroRoundTrip) : null;
  if (!vinculo) throw new Error('prepararCorreccionTransformacional: REGISTRO_SIN_INTEGRIDAD_PROCESS_LOCAL');
  if (registroRoundTrip.resultado !== 'CORRECCION_SEMANTICA') {
    throw new Error('prepararCorreccionTransformacional: RESULTADO_NO_CORRECTIVO');
  }
  if (vinculo.afirmacionRef !== afirmacion) {
    throw new Error('prepararCorreccionTransformacional: AFIRMACION_DISTINTA');
  }
  if (vinculo.presentacionRef !== presentacion) {
    throw new Error('prepararCorreccionTransformacional: PRESENTACION_DISTINTA');
  }
  if (
    registroRoundTrip.afirmacionId !== afirmacion.id
    || registroRoundTrip.afirmacionVersion !== afirmacion.version
    || registroRoundTrip.turnoPresentacionId !== presentacion.turnoPresentacionId
    || registroRoundTrip.formulacionPresentada !== presentacion.formulacionPresentada
  ) {
    throw new Error('prepararCorreccionTransformacional: VINCULACION_DURABLE_INCONSISTENTE');
  }

  const comando = congelarProfundo({
    operacion: 'CREAR_PROPUESTA_SUCESORA',
    afirmacionAnteriorId: afirmacion.id,
    afirmacionAnteriorVersion: afirmacion.version,
    registroRoundTrip,
  });
  const capacidad = Object.freeze({});
  capacidadesCorreccionEmitidas.set(capacidad, {
    afirmacionRef: afirmacion,
    presentacionRef: presentacion,
    registroRoundTripRef: registroRoundTrip,
    comandoRef: comando,
    consumida: false,
  });
  return congelarProfundo({
    tipo: 'CORRECCION_PREPARADA',
    comando,
    capacidad,
  });
}

function stringifyEstable(value) {
  if (Array.isArray(value)) return `[${value.map(stringifyEstable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      clave => `${JSON.stringify(clave)}:${stringifyEstable(value[clave])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function crearPropuestaSucesoraTransformacionalInterna({
  afirmacionAnterior,
  presentacion,
  registroRoundTrip,
  comando,
  capacidad,
  formulacionPropuesta,
  constituyentes,
  modoObservabilidad,
  enlacesCausales,
  // C5-vertical-1 (sucesión normativa tras reformulación) — opcional,
  // aditivo: nunca cambia el comportamiento existente cuando se omite.
  // Preserva la genealogía EDITORIAL (reformulaAId, entre propuestas nunca
  // autorizadas) sobre la MISMA entidad que aquí recibe la genealogía
  // NORMATIVA (reemplazaAId, ya calculada abajo desde afirmacionAnterior).
  // Ambas relaciones son ortogonales — ver AfirmacionTransformacionalDestino.js.
  reformulaAId,
} = {}) {
  const permiso = capacidad && typeof capacidad === 'object'
    ? capacidadesCorreccionEmitidas.get(capacidad) : null;
  if (!permiso) throw new Error('crearPropuestaSucesoraTransformacional: CAPACIDAD_DESCONOCIDA');
  if (permiso.consumida) throw new Error('crearPropuestaSucesoraTransformacional: CAPACIDAD_YA_CONSUMIDA');
  if (
    permiso.afirmacionRef !== afirmacionAnterior
    || permiso.presentacionRef !== presentacion
    || permiso.registroRoundTripRef !== registroRoundTrip
  ) {
    throw new Error('crearPropuestaSucesoraTransformacional: VINCULACION_DISTINTA');
  }
  if (permiso.comandoRef !== comando) {
    throw new Error('crearPropuestaSucesoraTransformacional: COMANDO_DISTINTO');
  }
  if (
    comando.operacion !== 'CREAR_PROPUESTA_SUCESORA'
    || comando.registroRoundTrip !== registroRoundTrip
  ) {
    throw new Error('crearPropuestaSucesoraTransformacional: COMANDO_INCOHERENTE');
  }

  const version = afirmacionAnterior.version + 1;
  const id = `${afirmacionAnterior.id}:v${version}:correccion:${encodeURIComponent(registroRoundTrip.turnoRespuestaId)}`;
  const parametrosPropuesta = {
    id,
    version,
    reemplazaAId: afirmacionAnterior.id,
    ...(reformulaAId !== undefined ? { reformulaAId } : {}),
    constituyentes,
    modoObservabilidad,
    enlacesCausales,
    origen: {
      composicion: 'PROPUESTA_SISTEMA',
      soportes: 'CONOCIMIENTO_AUTORIZADO_DISTRIBUIDO',
      propuestaEnTurnoId: registroRoundTrip.turnoRespuestaId,
      formulacionPropuesta,
    },
  };
  const firmaCandidata = stringifyEstable(parametrosPropuesta);
  const sucesionExistente = sucesionesPorRegistroRoundTrip.get(registroRoundTrip);
  if (sucesionExistente) {
    if (sucesionExistente.firmaCandidata !== firmaCandidata) {
      throw new Error('crearPropuestaSucesoraTransformacional: CORRECCION_YA_MATERIALIZADA_EN_OTRA_PROPUESTA');
    }
    permiso.consumida = true;
    return sucesionExistente.resultadoRef;
  }

  const propuesta = crearPropuestaTransformacional(parametrosPropuesta);
  const resultado = congelarProfundo({
    tipo: 'PROPUESTA_SUCESORA_TRANSFORMACIONAL',
    estado: 'PROPUESTA',
    propuesta,
    procedenciaCorreccion: {
      afirmacionAnteriorId: afirmacionAnterior.id,
      afirmacionAnteriorVersion: afirmacionAnterior.version,
      versionPropuesta: version,
      reemplazaAId: afirmacionAnterior.id,
      registroRoundTripId: registroRoundTrip.id,
      turnoPresentacionId: presentacion.turnoPresentacionId,
      turnoCorreccionId: registroRoundTrip.turnoRespuestaId,
      formulacionAnterior: presentacion.formulacionPresentada,
      formulacionPropuesta,
      evidenciaLiteralCorreccion: copiarProfundo(registroRoundTrip.evidencia),
      autenticidadExternaVerificada: false,
      ordenConversacionalVerificado: false,
    },
  });
  sucesionesPorRegistroRoundTrip.set(registroRoundTrip, {
    firmaCandidata,
    resultadoRef: resultado,
  });
  procedenciaCorreccionPorEntidad.set(propuesta, Object.freeze({
    procedenciaCorreccion: resultado.procedenciaCorreccion,
    afirmacionAnteriorRef: afirmacionAnterior,
    presentacionRef: presentacion,
    registroRoundTripRef: registroRoundTrip,
  }));
  permiso.consumida = true;
  return resultado;
}

function obtenerProcedenciaCorreccionTransformacionalInterna(entidad) {
  const vinculo = entidad && typeof entidad === 'object'
    ? procedenciaCorreccionPorEntidad.get(entidad) : null;
  if (!vinculo) return null;
  return Object.freeze({
    procedenciaCorreccion: vinculo.procedenciaCorreccion,
    afirmacionAnterior: vinculo.afirmacionAnteriorRef,
    presentacion: vinculo.presentacionRef,
    registroRoundTrip: vinculo.registroRoundTripRef,
  });
}

function obtenerMaterializacionParaPersistenciaInterna({ anterior, resultante } = {}) {
  const vinculo = resultante && materializacionesLegitimas.get(resultante);
  if (!vinculo || vinculo.propuestaRef !== anterior) return null;
  return Object.freeze({
    id: `materializacion_transformacional:${encodeURIComponent(resultante.id)}:v${resultante.version}`,
    afirmacionId: resultante.id,
    version: resultante.version,
    estadoPrevio: 'PROPUESTA',
    estadoPosterior: 'MATERIALIZADA_PENDIENTE',
    turnoMaterializacionId: vinculo.turnoId,
  });
}

function obtenerVeredictoParaPersistenciaInterna({
  anterior, registroVeredicto, resultante,
} = {}) {
  const vinculo = registroVeredicto && registrosVeredictoLegitimos.get(registroVeredicto);
  if (
    !vinculo
    || vinculo.fotografiaAnteriorRef !== anterior
    || vinculo.fotografiaResultanteRef !== resultante
  ) return null;
  return registroVeredicto;
}

function obtenerPresentacionParaPersistenciaInterna({ afirmacion, presentacion } = {}) {
  const vinculo = presentacion && presentacionesRoundTripLegitimas.get(presentacion);
  return vinculo && vinculo.afirmacionRef === afirmacion ? presentacion : null;
}

function obtenerIdentidadPresentacionParaPersistenciaInterna({ afirmacion, presentacion, sesionId } = {}) {
  const vinculo = presentacion && presentacionesRoundTripLegitimas.get(presentacion);
  if (!vinculo || vinculo.afirmacionRef !== afirmacion) return null;
  if (vinculo.sesionId && vinculo.sesionId !== sesionId) return null;
  return vinculo.presentacionId || null;
}

function obtenerRoundTripParaPersistenciaInterna({
  afirmacion, presentacion, registroRoundTrip,
} = {}) {
  const vinculo = registroRoundTrip && registrosRoundTripLegitimos.get(registroRoundTrip);
  if (
    !vinculo
    || vinculo.afirmacionRef !== afirmacion
    || vinculo.presentacionRef !== presentacion
  ) return null;
  return registroRoundTrip;
}

function obtenerSucesionParaPersistenciaInterna({
  afirmacionAnterior, presentacion, registroRoundTrip, propuestaSucesora,
} = {}) {
  const vinculo = propuestaSucesora && procedenciaCorreccionPorEntidad.get(propuestaSucesora);
  if (
    !vinculo
    || vinculo.afirmacionAnteriorRef !== afirmacionAnterior
    || vinculo.presentacionRef !== presentacion
    || vinculo.registroRoundTripRef !== registroRoundTrip
  ) return null;
  return vinculo.procedenciaCorreccion;
}

function acreditarEntidadParaPersistenciaInterna({ entidad, sesionId } = {}) {
  if (!entidad || typeof entidad !== 'object' || !entidadesLegitimas.has(entidad)) {
    throw new Error('AfirmacionTransformacionalDestino durable: ENTIDAD_SIN_INTEGRIDAD_PROCESS_LOCAL');
  }
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('AfirmacionTransformacionalDestino durable: sesionId es obligatorio');
  }
  const sesionExistente = sesionDurablePorEntidad.get(entidad);
  if (sesionExistente && sesionExistente !== sesionId) {
    throw new Error('AfirmacionTransformacionalDestino durable: ENTIDAD_PERTENECE_A_OTRA_SESION');
  }
  sesionDurablePorEntidad.set(entidad, sesionId);
}

function rehidratarEntidadComprometidaInterna({ entidad, sesionId } = {}) {
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('AfirmacionTransformacionalDestino durable: sesionId es obligatorio');
  }
  const copia = copiarProfundo(entidad);
  const validacion = schema.validarAfirmacionTransformacionalDestino(copia);
  if (!validacion.valid) {
    throw new Error(`AfirmacionTransformacionalDestino durable inválida — ${validacion.errors.join('; ')}`);
  }
  const rehidratada = congelarProfundo(copia);
  entidadesLegitimas.add(rehidratada);
  sesionDurablePorEntidad.set(rehidratada, sesionId);
  if (rehidratada.estado === 'PROPUESTA') propuestasLegitimas.add(rehidratada);
  if (rehidratada.estado === 'MATERIALIZADA_PENDIENTE') pendientesLegitimas.add(rehidratada);
  if (rehidratada.estado === 'AUTORIZADA') autorizadasLegitimas.add(rehidratada);
  return rehidratada;
}

module.exports = {
  CAUSAS_VEREDICTO,
  crearPropuestaTransformacional,
  materializarPropuestaTransformacional,
  evaluarVeredictoTransformacionalExplicito,
  evaluarVeredictoTransformacionalDesdeProtocolo,
  aplicarDecisionNormativaTransformacional,
  crearPresentacionRoundTripTransformacional,
  crearPresentacionTransformacionalEstructurada,
  registrarEvaluacionRoundTripTransformacional,
  prepararCorreccionTransformacionalInterna,
  crearPropuestaSucesoraTransformacionalInterna,
  obtenerProcedenciaCorreccionTransformacionalInterna,
  obtenerMaterializacionParaPersistenciaInterna,
  obtenerVeredictoParaPersistenciaInterna,
  obtenerPresentacionParaPersistenciaInterna,
  obtenerIdentidadPresentacionParaPersistenciaInterna,
  identidadRenderEstructurada: identidadRender,
  crearPresentacionIdEstructurada,
  validarPresentacionEstructuradaInterna,
  obtenerRoundTripParaPersistenciaInterna,
  obtenerSucesionParaPersistenciaInterna,
  acreditarEntidadParaPersistenciaInterna,
  rehidratarEntidadComprometidaInterna,
};
