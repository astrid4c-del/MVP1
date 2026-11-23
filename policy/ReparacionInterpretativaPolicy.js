'use strict';

const TIPOS_COMANDO_REPARACION = Object.freeze({
  ABRIR: 'ABRIR_REPARACION_INTERPRETATIVA',
  RESOLVER: 'RESOLVER_REPARACION_INTERPRETATIVA',
});

function obligacionIdParaIntento(intentoInterpretacionId) {
  if (typeof intentoInterpretacionId !== 'string' || !intentoInterpretacionId.trim()) {
    throw new Error('ReparacionInterpretativaPolicy: intentoInterpretacionId debe ser un string no vacío');
  }
  return `reparar_interpretacion:${intentoInterpretacionId}`;
}

function comandoDesdeHecho(tipo, hecho) {
  if (!hecho || typeof hecho !== 'object') return null;
  const intentoInterpretacionId = hecho.intentoInterpretacionId;
  const dimension = hecho.dimension;
  if (typeof intentoInterpretacionId !== 'string' || !intentoInterpretacionId.trim()) return null;
  if (typeof dimension !== 'string' || !dimension.trim()) return null;
  const obligacionId = obligacionIdParaIntento(intentoInterpretacionId);
  if (hecho.obligacionId && hecho.obligacionId !== obligacionId) return null;
  return Object.freeze({
    tipo, obligacionId, intentoInterpretacionId, dimension,
    interpretacionRechazadaSnapshot: hecho.interpretacionRechazadaSnapshot || null,
    criterioSatisfaccion: hecho.criterioSatisfaccion || Object.freeze({
      tipo: 'CORREGIR_INTERPRETACION',
      intentoInterpretacionId,
    }),
  });
}

function derivarComandosApertura(rechazosVisiblesAtribuidos = []) {
  const comandos = [];
  const vistos = new Set();
  for (const hecho of rechazosVisiblesAtribuidos) {
    const comando = comandoDesdeHecho(TIPOS_COMANDO_REPARACION.ABRIR, hecho);
    if (!comando || vistos.has(comando.obligacionId)) continue;
    vistos.add(comando.obligacionId);
    comandos.push(comando);
  }
  return comandos;
}

function derivarComandosResolucion(certificacion) {
  const satisfaccion = certificacion && certificacion.satisfaccionReparacion;
  const satisfaccionValida = !!(
    satisfaccion
    && satisfaccion.satisface === true
    && satisfaccion.obligacionId === certificacion.obligacionId
    && satisfaccion.intentoInterpretacionId === certificacion.intentoInterpretacionId
    && (!certificacion.criterioSatisfaccion
      || (satisfaccion.criterioSatisfaccion
        && satisfaccion.criterioSatisfaccion.tipo === certificacion.criterioSatisfaccion.tipo
        && satisfaccion.criterioSatisfaccion.intentoInterpretacionId === certificacion.criterioSatisfaccion.intentoInterpretacionId))
    && Array.isArray(satisfaccion.materialIds)
    && satisfaccion.materialIds.length > 0
    && satisfaccion.materialIds.every(id => typeof id === 'string' && id.trim())
    && ['RECONCILIACION', 'RESPUESTA_DIRIGIDA'].includes(satisfaccion.fuente)
  );
  // La certificación causal es la autoridad del lifecycle. El movimiento
  // solo decide si una deuda necesita atención; nunca concede el derecho a
  // resolverla. Esto permite resolver SAME-TURN (RECONCILIACION) y
  // LATER-TURN (RESPUESTA_DIRIGIDA) con la misma semántica.
  if (!certificacion || !satisfaccionValida) return [];
  const comando = comandoDesdeHecho(TIPOS_COMANDO_REPARACION.RESOLVER, certificacion);
  return comando ? [comando] : [];
}

function aplicarComandosReparacion({
  secuenciaActual = 0,
  reparacionesActuales = {},
  comandos = [],
}) {
  if (!Number.isInteger(secuenciaActual) || secuenciaActual < 0) {
    throw new Error('ReparacionInterpretativaPolicy: secuenciaActual debe ser un entero no negativo');
  }
  const reparacionesResultantes = { ...reparacionesActuales };
  const aperturasNuevas = [];
  const resolucionesAplicadas = [];
  const dimensionesReservadas = new Set(
    Object.values(reparacionesResultantes).map(r => r.dimension),
  );

  for (const comando of comandos.filter(c => c && c.tipo === TIPOS_COMANDO_REPARACION.ABRIR)) {
    if (reparacionesResultantes[comando.obligacionId]) continue;
    if (dimensionesReservadas.has(comando.dimension)) continue;
    dimensionesReservadas.add(comando.dimension);
    aperturasNuevas.push(comando);
  }

  const secuenciaResultante = aperturasNuevas.length > 0 ? secuenciaActual + 1 : secuenciaActual;
  for (const comando of aperturasNuevas) {
    reparacionesResultantes[comando.obligacionId] = Object.freeze({
      obligacionId: comando.obligacionId,
      intentoInterpretacionId: comando.intentoInterpretacionId,
      dimension: comando.dimension,
      criterioSatisfaccion: comando.criterioSatisfaccion,
      interpretacionRechazadaSnapshot: comando.interpretacionRechazadaSnapshot || null,
      abiertaEnSecuencia: secuenciaResultante,
    });
  }

  for (const comando of comandos.filter(c => c && c.tipo === TIPOS_COMANDO_REPARACION.RESOLVER)) {
    const pendiente = reparacionesResultantes[comando.obligacionId];
    if (
      !pendiente
      || pendiente.intentoInterpretacionId !== comando.intentoInterpretacionId
      || pendiente.dimension !== comando.dimension
    ) continue;
    delete reparacionesResultantes[comando.obligacionId];
    resolucionesAplicadas.push(Object.freeze({
      obligacionId: comando.obligacionId,
      intentoInterpretacionId: comando.intentoInterpretacionId,
      dimension: comando.dimension,
    }));
  }

  return Object.freeze({
    secuenciaResultante,
    reparacionesResultantes,
    aperturasAplicadas: aperturasNuevas.map(c => Object.freeze({
      obligacionId: c.obligacionId,
      intentoInterpretacionId: c.intentoInterpretacionId,
      dimension: c.dimension,
      criterioSatisfaccion: c.criterioSatisfaccion,
      abiertaEnSecuencia: secuenciaResultante,
    })),
    resolucionesAplicadas,
  });
}

function proyectarReparacionesPendientes(reparaciones = {}) {
  return Object.entries(reparaciones).map(([obligacionId, reparacion]) => Object.freeze({
    obligacionId,
    intentoInterpretacionId: reparacion.intentoInterpretacionId,
    dimension: reparacion.dimension,
    criterioSatisfaccion: reparacion.criterioSatisfaccion,
    interpretacionRechazadaSnapshot: reparacion.interpretacionRechazadaSnapshot || null,
    abiertaEnSecuencia: reparacion.abiertaEnSecuencia,
  }));
}

module.exports = {
  TIPOS_COMANDO_REPARACION,
  obligacionIdParaIntento,
  derivarComandosApertura,
  derivarComandosResolucion,
  aplicarComandosReparacion,
  proyectarReparacionesPendientes,
};
