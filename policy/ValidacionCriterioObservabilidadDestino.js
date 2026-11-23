'use strict';

/**
 * circulomejora006_act07c — validador determinista de la propuesta emitida
 * por el evaluador de criterio de observabilidad.
 *
 * Comprueba exclusivamente legitimidad estructural y epistemológica:
 * versión de contrato, unidad evaluada, identidad de unidad, catálogo,
 * anclaje verbatim, pertenencia a la unidad, autorización vigente de los
 * conceptos citados y coherencia estructural estado↔tipo de evidencia.
 * Nunca relee el texto para juzgar si "realmente" es observable ni si la
 * evidencia es pertinente — esa lectura ya la hizo el evaluador; este
 * módulo no la repite ni la corrige. Fail-closed: cualquier fallo produce
 * INDETERMINADO, nunca reclasifica ni completa evidencia ausente.
 */

const {
  CONTRATO_VERSION,
  esEstadoValido,
  esUnidadEvaluadaValida,
  esTipoEvidenciaValido,
  esRazonIndeterminadoValida,
  identidadUnidad,
  RAZON_POR_ESTADO_PROPUESTO,
} = require('../schemas/CriterioObservabilidadDestino');

function esUnidadValida(unidad) {
  return !!unidad && typeof unidad === 'object' && esUnidadEvaluadaValida(unidad.tipo)
    && !!unidad.soporte && Array.isArray(unidad.soporte.conceptoIds) && Array.isArray(unidad.soporte.referenciasLiterales);
}

function evidenciaAnclaEnUnidad(item, unidad, autorizados) {
  if (!item || typeof item !== 'object' || !esTipoEvidenciaValido(item.tipo)) return { ok: false };
  if (item.tipo === 'LITERAL') {
    const existe = unidad.soporte.referenciasLiterales.some(referencia => (
      referencia.turnoId === item.turnoId && referencia.cita === item.cita
    ));
    return existe ? { ok: true } : { ok: false };
  }
  const pertenece = unidad.soporte.conceptoIds.includes(item.conceptoId);
  if (!pertenece) return { ok: false };
  if (!autorizados.has(item.conceptoId)) return { ok: false, razon: 'CONCEPTO_CITADO_NO_AUTORIZADO' };
  return { ok: true };
}

function validarCriterioObservabilidadDestino({ propuesta, unidad, conocimientoAutorizado } = {}) {
  if (!esUnidadValida(unidad)) throw new Error('VALIDACION_OBSERVABILIDAD_UNIDAD_INVALIDA');
  if (!Array.isArray(conocimientoAutorizado)) throw new Error('VALIDACION_OBSERVABILIDAD_CONOCIMIENTO_AUTORIZADO_INVALIDO');

  const identidadEsperada = identidadUnidad(unidad);
  const diagnosticoBase = { unidadEvaluada: unidad.tipo, identidadUnidad: identidadEsperada };

  const rechazar = razon => Object.freeze({
    dimension: 'criterioObservabilidad',
    estado: 'INDETERMINADO',
    razon,
    diagnostico: Object.freeze({ ...diagnosticoBase }),
  });

  if (!propuesta || typeof propuesta !== 'object') return rechazar('PROPUESTA_AUSENTE_O_INVALIDA');
  if (propuesta.contratoVersion !== CONTRATO_VERSION) return rechazar('PROPUESTA_AUSENTE_O_INVALIDA');
  if (propuesta.unidadEvaluada !== unidad.tipo) return rechazar('PROPUESTA_AUSENTE_O_INVALIDA');
  if (propuesta.identidadUnidad !== identidadEsperada) return rechazar('PROPUESTA_AUSENTE_O_INVALIDA');
  if (!esEstadoValido(propuesta.estadoPropuesto)) return rechazar('PROPUESTA_AUSENTE_O_INVALIDA');
  if (!Array.isArray(propuesta.evidenciaCitada) || propuesta.evidenciaCitada.length === 0) {
    return rechazar('EVIDENCIA_CITADA_NO_ANCLADA_EN_LA_UNIDAD');
  }

  const autorizados = new Set(conocimientoAutorizado.map(concepto => concepto && concepto.id));
  for (const item of propuesta.evidenciaCitada) {
    const anclaje = evidenciaAnclaEnUnidad(item, unidad, autorizados);
    if (!anclaje.ok) return rechazar(anclaje.razon || 'EVIDENCIA_CITADA_NO_ANCLADA_EN_LA_UNIDAD');
  }

  // Requisito estructural específico del estado: un criterio subjetivamente
  // reconocible exige al menos una cita literal — un conceptoId aislado no
  // sostiene un reconocimiento subjetivo explícito.
  if (propuesta.estadoPropuesto === 'CRITERIO_SUBJETIVAMENTE_RECONOCIBLE'
      && !propuesta.evidenciaCitada.some(item => item.tipo === 'LITERAL')) {
    return rechazar('EVIDENCIA_CITADA_NO_ANCLADA_EN_LA_UNIDAD');
  }

  const evidenciaValidada = Object.freeze(propuesta.evidenciaCitada.map(item => Object.freeze({ ...item })));

  if (propuesta.estadoPropuesto === 'INDETERMINADO') {
    const razon = esRazonIndeterminadoValida(propuesta.razonIndeterminado)
      ? propuesta.razonIndeterminado : 'EVIDENCIA_INSUFICIENTE_PARA_CLASIFICAR';
    return Object.freeze({
      dimension: 'criterioObservabilidad',
      estado: 'INDETERMINADO',
      razon,
      diagnostico: Object.freeze({ ...diagnosticoBase, evidenciaValidada }),
    });
  }

  return Object.freeze({
    dimension: 'criterioObservabilidad',
    estado: propuesta.estadoPropuesto,
    razon: RAZON_POR_ESTADO_PROPUESTO[propuesta.estadoPropuesto],
    diagnostico: Object.freeze({ ...diagnosticoBase, evidenciaValidada }),
  });
}

module.exports = { validarCriterioObservabilidadDestino };
