'use strict';

/**
 * circulomejora006_reporte04 — validador determinista de la propuesta
 * emitida por el evaluador de criterio de proporcionalidad.
 *
 * Comprueba EXCLUSIVAMENTE legitimidad estructural y epistemológica:
 * versión de contrato, identidad real de Afirmación/presentación/unidad,
 * catálogo cerrado, coherencia estado↔dimensiones, anclaje verbatim del
 * fragmento visible y del fragmento de soporte, pertenencia/autoridad
 * vigente del concepto citado, y — a diferencia de Observabilidad — un
 * re-chequeo explícito de VIGENCIA: nada garantiza que la cabeza, la
 * autoridad de un soporte o sus contradicciones sigan siendo las mismas
 * entre el momento de seleccionar (síncrono) y el momento de validar
 * (después de un await real al auditor). Cualquier discrepancia falla
 * cerrado — nunca relee el texto para juzgar si "realmente" excede la
 * fuerza del soporte: esa lectura ya la hizo el evaluador: este módulo no
 * la repite ni la corrige.
 *
 * Fail-closed total: cualquier fallo de cualquier comprobación produce
 * INDETERMINADA — nunca reclasifica, nunca completa evidencia ausente,
 * nunca "sube" un resultado a PROPORCIONADA.
 */

const {
  CONTRATO_VERSION, esEstadoUnidadValido, esArrayDimensionesCoherente,
} = require('../schemas/CriterioProporcionalidadDestino');

function resultadoIndeterminada(seleccionOriginal, razon) {
  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId: seleccionOriginal.afirmacionId,
    presentacionId: seleccionOriginal.presentacionId,
    revisionEvaluada: seleccionOriginal.revisionEvaluada,
    unidadLocalId: seleccionOriginal.unidadLocalId,
    rol: seleccionOriginal.rol,
    estado: 'INDETERMINADA',
    dimensionesExceso: Object.freeze([]),
    razon,
    evidencia: Object.freeze({
      fragmentoVisible: null, fragmentoSoporte: null, conceptoId: null,
      tipoEvidenciaSoporte: null, explicacion: null,
    }),
  });
}

function identidadCoincide(propuesta, seleccionOriginal) {
  return propuesta.afirmacionId === seleccionOriginal.afirmacionId
    && propuesta.presentacionId === seleccionOriginal.presentacionId
    && propuesta.revisionEvaluada === seleccionOriginal.revisionEvaluada
    && propuesta.unidadLocalId === seleccionOriginal.unidadLocalId
    && propuesta.rol === seleccionOriginal.rol;
}

/**
 * ¿Sigue vigente exactamente el mismo conjunto de autoridad que se leyó al
 * seleccionar? Compara el conjunto de conceptoIds autorizados (mismo id,
 * misma descripción) entre la selección original y la re-selección hecha
 * DESPUÉS del await al auditor.
 */
function autoridadSigueIgual(seleccionOriginal, reSeleccion) {
  if (seleccionOriginal.conceptosAutorizados.length !== reSeleccion.conceptosAutorizados.length) return false;
  const original = new Map(seleccionOriginal.conceptosAutorizados.map(c => [c.id, c.descripcion]));
  return reSeleccion.conceptosAutorizados.every(c => original.get(c.id) === c.descripcion);
}

/**
 * @param {object} params
 * @param {object} params.propuesta — salida de evaluarProporcionalidadDestino (o null)
 * @param {object} params.seleccionOriginal — registro NO bloqueado, capturado ANTES del await al auditor
 * @param {object} params.reSeleccion — resultado de volver a llamar a
 *   seleccionarUnidadesProporcionalidadDestino (misma unidad) DESPUÉS del
 *   await al auditor, sobre una trazabilidad recién recalculada
 * @returns {object} resultado por unidad — nunca lanza
 */
function validarProporcionalidadDestino({ propuesta, seleccionOriginal, reSeleccion } = {}) {
  if (!seleccionOriginal || typeof seleccionOriginal !== 'object') {
    throw new Error('VALIDACION_PROPORCIONALIDAD_SELECCION_INVALIDA');
  }

  // 1. Re-chequeo de vigencia — PRIMERO, antes de mirar la propuesta: si la
  // revisión, la autoridad o las contradicciones cambiaron entre
  // seleccionar y validar, ninguna propuesta (por válida que parezca)
  // puede certificarse contra evidencia que ya no es la vigente.
  if (!reSeleccion || reSeleccion.bloqueada) {
    const razonReSeleccion = reSeleccion && reSeleccion.razonBloqueo;
    if (razonReSeleccion === 'REVISION_YA_NO_VIGENTE') {
      return resultadoIndeterminada(seleccionOriginal, 'REVISION_CAMBIO_ENTRE_SELECCION_Y_VALIDACION');
    }
    if (razonReSeleccion === 'CONTRADICCION_ACTIVA_VINCULADA') {
      return resultadoIndeterminada(seleccionOriginal, 'CONTRADICCION_APARECIO_ENTRE_SELECCION_Y_VALIDACION');
    }
    if (razonReSeleccion === 'SOPORTE_INACTIVO' || razonReSeleccion === 'SOPORTE_RECHAZADO' || razonReSeleccion === 'SOPORTE_SIN_AUTORIDAD_VALIDA' || razonReSeleccion === 'SOPORTE_NO_RESUELTO') {
      return resultadoIndeterminada(seleccionOriginal, 'AUTORIDAD_CAMBIO_ENTRE_SELECCION_Y_VALIDACION');
    }
    return resultadoIndeterminada(seleccionOriginal, 'REVISION_CAMBIO_ENTRE_SELECCION_Y_VALIDACION');
  }
  if (reSeleccion.revisionEvaluada !== seleccionOriginal.revisionEvaluada) {
    return resultadoIndeterminada(seleccionOriginal, 'REVISION_CAMBIO_ENTRE_SELECCION_Y_VALIDACION');
  }
  if (!autoridadSigueIgual(seleccionOriginal, reSeleccion)) {
    return resultadoIndeterminada(seleccionOriginal, 'AUTORIDAD_CAMBIO_ENTRE_SELECCION_Y_VALIDACION');
  }

  // 2. Legitimidad estructural de la propuesta.
  if (!propuesta || typeof propuesta !== 'object') {
    return resultadoIndeterminada(seleccionOriginal, 'PROPUESTA_AUSENTE_O_INVALIDA');
  }
  if (propuesta.contratoVersion !== CONTRATO_VERSION) {
    return resultadoIndeterminada(seleccionOriginal, 'VERSION_CONTRATO_DESCONOCIDA');
  }
  if (!identidadCoincide(propuesta, seleccionOriginal)) {
    return resultadoIndeterminada(seleccionOriginal, 'PROPUESTA_AUSENTE_O_INVALIDA');
  }
  if (!esEstadoUnidadValido(propuesta.estadoPropuesto)) {
    return resultadoIndeterminada(seleccionOriginal, 'CATALOGO_DESCONOCIDO');
  }

  const estado = propuesta.estadoPropuesto;
  const dimensiones = propuesta.dimensionesExcesoPropuestas || [];
  if (!esArrayDimensionesCoherente(dimensiones, estado)) {
    return resultadoIndeterminada(seleccionOriginal, 'ESTADO_DIMENSIONES_INCOHERENTE');
  }

  if (estado === 'INDETERMINADA') {
    return Object.freeze({
      contratoVersion: CONTRATO_VERSION,
      afirmacionId: seleccionOriginal.afirmacionId,
      presentacionId: seleccionOriginal.presentacionId,
      revisionEvaluada: seleccionOriginal.revisionEvaluada,
      unidadLocalId: seleccionOriginal.unidadLocalId,
      rol: seleccionOriginal.rol,
      estado: 'INDETERMINADA',
      dimensionesExceso: Object.freeze([]),
      razon: 'EVIDENCIA_INSUFICIENTE_PARA_CLASIFICAR',
      evidencia: Object.freeze({
        fragmentoVisible: null, fragmentoSoporte: null, conceptoId: null,
        tipoEvidenciaSoporte: null, explicacion: null,
      }),
    });
  }

  if (estado === 'PROPORCIONADA') {
    // Nunca se exige fabricar una oposición entre fragmentos — ver encargo.
    return Object.freeze({
      contratoVersion: CONTRATO_VERSION,
      afirmacionId: seleccionOriginal.afirmacionId,
      presentacionId: seleccionOriginal.presentacionId,
      revisionEvaluada: seleccionOriginal.revisionEvaluada,
      unidadLocalId: seleccionOriginal.unidadLocalId,
      rol: seleccionOriginal.rol,
      estado: 'PROPORCIONADA',
      dimensionesExceso: Object.freeze([]),
      razon: 'FUERZA_VISIBLE_DENTRO_DE_SOPORTE',
      evidencia: Object.freeze({
        fragmentoVisible: null, fragmentoSoporte: null, conceptoId: null,
        tipoEvidenciaSoporte: null, explicacion: null,
      }),
    });
  }

  // estado === 'EXCEDE_SOPORTE' — exige evidencia real y anclada.
  const fragmentoVisible = propuesta.fragmentoVisiblePropuesto;
  const fragmentoSoporte = propuesta.fragmentoSoportePropuesto;
  const conceptoId = propuesta.conceptoIdPropuesto;

  if (typeof fragmentoVisible !== 'string' || !fragmentoVisible.trim() || !seleccionOriginal.textoVisible.includes(fragmentoVisible)) {
    return resultadoIndeterminada(seleccionOriginal, 'EVIDENCIA_NO_ANCLADA');
  }
  if (typeof conceptoId !== 'string' || !seleccionOriginal.conceptoIds.includes(conceptoId)) {
    return resultadoIndeterminada(seleccionOriginal, 'CONCEPTO_CITADO_NO_PERTENECE_A_LA_UNIDAD');
  }
  const conceptoAutorizado = seleccionOriginal.conceptosAutorizados.find(c => c.id === conceptoId);
  if (!conceptoAutorizado) {
    return resultadoIndeterminada(seleccionOriginal, 'CONCEPTO_CITADO_NO_AUTORIZADO');
  }
  if (typeof fragmentoSoporte !== 'string' || !fragmentoSoporte.trim()) {
    return resultadoIndeterminada(seleccionOriginal, 'EVIDENCIA_NO_ANCLADA');
  }

  // Determina el TIPO de evidencia por DÓNDE ancla realmente — nunca por lo
  // que el modelo diga ser: primero se intenta como descripción de concepto
  // (la única fuente que existe hoy); solo si NO ancla ahí se intenta como
  // referencia literal real — y solo si la unidad de verdad tiene alguna.
  // Mientras `referenciasLiterales` esté vacía, es estructuralmente
  // imposible etiquetar nada como LITERAL_USUARIO.
  let tipoEvidenciaSoporte = null;
  if (conceptoAutorizado.descripcion.includes(fragmentoSoporte)) {
    tipoEvidenciaSoporte = 'DESCRIPCION_CONCEPTO_AUTORIZADA';
  } else {
    const literalQueAncla = seleccionOriginal.referenciasLiterales.find(ref => (
      typeof ref.cita === 'string' && ref.cita.includes(fragmentoSoporte)
    ));
    if (literalQueAncla) {
      tipoEvidenciaSoporte = 'LITERAL_USUARIO';
    } else {
      return resultadoIndeterminada(seleccionOriginal, 'EVIDENCIA_NO_ANCLADA');
    }
  }
  if (tipoEvidenciaSoporte === 'LITERAL_USUARIO' && seleccionOriginal.referenciasLiterales.length === 0) {
    return resultadoIndeterminada(seleccionOriginal, 'LITERAL_SIN_REFERENCIA_REAL');
  }

  return Object.freeze({
    contratoVersion: CONTRATO_VERSION,
    afirmacionId: seleccionOriginal.afirmacionId,
    presentacionId: seleccionOriginal.presentacionId,
    revisionEvaluada: seleccionOriginal.revisionEvaluada,
    unidadLocalId: seleccionOriginal.unidadLocalId,
    rol: seleccionOriginal.rol,
    estado: 'EXCEDE_SOPORTE',
    dimensionesExceso: Object.freeze([...dimensiones]),
    razon: 'FUERZA_VISIBLE_EXCEDE_SOPORTE_AUTORIZADO',
    evidencia: Object.freeze({
      fragmentoVisible,
      fragmentoSoporte,
      conceptoId,
      tipoEvidenciaSoporte,
      explicacion: propuesta.explicacionPropuesta,
    }),
  });
}

module.exports = {
  validarProporcionalidadDestino,
};
