'use strict';

/**
 * Política conservadora de evidencia de round-trip.
 *
 * Produce un registro diagnóstico durable en forma, pero no persiste,
 * autoriza, corrige, invalida ni reemplaza la afirmación.
 */

const runtime = require('../domain/_AfirmacionTransformacionalDestinoProcessLocal');

const REGLAS_CORRECCION = Object.freeze([
  /^no\s+(?:es|son)\s+.+,\s*(?:es|son)\s+.+$/,
  /^(?:si|exacto|correcto),?\s+(?:pero|aunque)\s+(?:(?:el\s+resultado\s+)?no\s+(?:es|son)|no\s+les?\s+enseno)\s+.+$/,
  /^mas\s+bien\s+(?:lo\s+que\s+hago|la\s+idea|el\s+resultado)\s+es\s+.+$/,
  /^(?:mas\s+o\s+menos,?\s+)?en\s+realidad\s+(?:empieza|comienza|termina|el\s+resultado\s+es)\s+.+$/,
  /^correcto,?\s+excepto\s+por\s+(?:el|la|los|las)\s+.+$/,
  /^(?:yo\s+)?no\s+les?\s+enseno\s+.+$/,
]);

const REGLAS_RECHAZO = Object.freeze([
  /^no$/,
  /^eso\s+no\s+es$/,
  /^no\s+me\s+representa$/,
  /^lo\s+entendiste\s+mal$/,
]);

const REGLAS_RECONOCIMIENTO = Object.freeze([
  /^si,?\s+eso\s+es$/,
  /^eso\s+es$/,
  /^exactamente$/,
  /^asi\s+lo\s+veo$/,
  /^eso\s+describe\s+(?:bien|correctamente)\s+lo\s+que\s+hago$/,
  /^si,?\s+esa\s+es\s+la\s+idea$/,
]);

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?¡¿]+$/g, '')
    .replace(/\s+/g, ' ');
}

function clasificarRoundTrip(textoUsuario) {
  const texto = normalizar(textoUsuario);
  if (!texto) return { resultado: 'SIN_EVIDENCIA', regla: 'RESPUESTA_VACIA' };
  if (REGLAS_CORRECCION.some(regla => regla.test(texto))) {
    return { resultado: 'CORRECCION_SEMANTICA', regla: 'GRAMATICA_CORRECCION_SEMANTICA' };
  }
  if (REGLAS_RECHAZO.some(regla => regla.test(texto))) {
    return { resultado: 'RECHAZADA', regla: 'GRAMATICA_RECHAZO_GLOBAL' };
  }
  if (REGLAS_RECONOCIMIENTO.some(regla => regla.test(texto))) {
    return { resultado: 'RECONOCIDA_SIN_CORRECCION', regla: 'GRAMATICA_RECONOCIMIENTO_EXPLICITO' };
  }
  return { resultado: 'SIN_EVIDENCIA', regla: 'EVIDENCIA_AMBIGUA_O_IRRELEVANTE' };
}

function evaluarRoundTripTransformacional(params = {}) {
  const clasificacion = clasificarRoundTrip(
    params.turnoRespuesta && params.turnoRespuesta.textoUsuario,
  );
  return runtime.registrarEvaluacionRoundTripTransformacional({
    ...params,
    clasificacion,
  });
}

module.exports = {
  evaluarRoundTripTransformacional,
};
