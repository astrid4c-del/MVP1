'use strict';

/**
 * D1.7-A — proyección estrecha de obligaciones causales YA soportadas.
 * No crea obligaciones desde oportunidades, cobertura o incertidumbres.
 */
function proyectarObligacionesAbiertasDestino({
  interpretacionesMaterializadasPendientes = [],
  reparacionesInterpretativasPendientes = [],
  reparacionesS1RAbiertas = [],
} = {}) {
  const obligaciones = [];
  interpretacionesMaterializadasPendientes.forEach(interpretacion => {
    if (!interpretacion || !interpretacion.intentoInterpretacionId || !interpretacion.dimension) {
      throw new Error('ObligacionesAbiertasDestinoProjection: interpretación pendiente sin identidad causal');
    }
    obligaciones.push({
      obligacionId: `veredicto_interpretacion:${interpretacion.intentoInterpretacionId}`,
      clase: 'VEREDICTO',
      tipo: 'VEREDICTO_INTERPRETACION_PENDIENTE',
      origenId: interpretacion.intentoInterpretacionId,
      dimension: interpretacion.dimension,
      foco: { tipo: 'DIMENSION', dimension: interpretacion.dimension },
      origen: { tipo: 'INTERPRETACION', intentoInterpretacionId: interpretacion.intentoInterpretacionId },
      mecanismoResolucion: 'VEREDICTO_EXACTO_DEL_USUARIO',
    });
  });
  reparacionesInterpretativasPendientes.forEach(reparacion => {
    if (
      !reparacion || !reparacion.obligacionId
      || !reparacion.intentoInterpretacionId || !reparacion.dimension
    ) throw new Error('ObligacionesAbiertasDestinoProjection: reparación sin identidad causal');
    obligaciones.push({
      obligacionId: reparacion.obligacionId,
      clase: 'REPARACION',
      tipo: 'REPARACION_INTERPRETATIVA_PENDIENTE',
      origenId: reparacion.intentoInterpretacionId,
      dimension: reparacion.dimension,
      foco: { tipo: 'DIMENSION', dimension: reparacion.dimension },
      origen: { tipo: 'REPARACION_INTERPRETATIVA', intentoInterpretacionId: reparacion.intentoInterpretacionId },
      temporalidad: reparacion.abiertaEnSecuencia === undefined ? undefined : { abiertaEnSecuencia: reparacion.abiertaEnSecuencia },
      mecanismoResolucion: 'REPARAR_TRAS_RECHAZO_CERTIFICADO',
    });
  });
  reparacionesS1RAbiertas.forEach(reparacion => {
    if (!reparacion || !reparacion.reparacionId || !reparacion.afirmacionOrigenId
      || reparacion.afirmacionOrigenVersion === undefined) {
      throw new Error('ObligacionesAbiertasDestinoProjection: reparación S1-R sin identidad durable');
    }
    obligaciones.push({
      obligacionId: `s1r:${reparacion.reparacionId}`,
      clase: 'REPARACION',
      tipo: 'REPARACION_S1R_ABIERTA',
      foco: { tipo: 'RELACION_TRANSFORMACIONAL', alcance: reparacion.alcance || null },
      origen: {
        tipo: 'REPARACION_S1R',
        reparacionId: reparacion.reparacionId,
        afirmacionOrigenId: reparacion.afirmacionOrigenId,
        afirmacionOrigenVersion: reparacion.afirmacionOrigenVersion,
      },
      mecanismoResolucion: 'REPARAR_RELACION_TRANSFORMACIONAL',
    });
  });
  const ids = new Set();
  obligaciones.forEach(obligacion => {
    if (ids.has(obligacion.obligacionId)) {
      throw new Error(`ObligacionesAbiertasDestinoProjection: obligación duplicada ${obligacion.obligacionId}`);
    }
    ids.add(obligacion.obligacionId);
    if (obligacion.foco) Object.freeze(obligacion.foco);
    if (obligacion.origen) Object.freeze(obligacion.origen);
    if (obligacion.temporalidad) Object.freeze(obligacion.temporalidad);
    Object.freeze(obligacion);
  });
  return Object.freeze(obligaciones);
}

module.exports = { proyectarObligacionesAbiertasDestino };
