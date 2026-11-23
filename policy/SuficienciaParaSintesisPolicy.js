'use strict';

/**
 * C1-B — composición pura de una fotografía de suficiencia.
 * La función no conoce momentos del turno: postreconciliación, postturno y
 * estado confirmado usan exactamente el mismo contrato.
 */
function evaluarSuficienciaParaSintesis(fotografia) {
  if (!fotografia || typeof fotografia !== 'object') {
    throw new Error('SuficienciaParaSintesisPolicy: fotografia es requerida');
  }
  const hechos = fotografia.hechosSemanticos || {};
  const pendientesCobertura = Array.isArray(hechos.dimensionesPendientesCobertura)
    ? [...hechos.dimensionesPendientesCobertura] : [];
  const interpretacionesPendientes = Array.isArray(hechos.dimensionesConInterpretacionPendiente)
    ? [...hechos.dimensionesConInterpretacionPendiente] : [];
  const oportunidadesNoAtendidas = Array.isArray(hechos.dimensionesElegiblesNoAtendidas)
    ? [...hechos.dimensionesElegiblesNoAtendidas] : [];
  const reparaciones = Array.isArray(fotografia.reparacionesInterpretativasPendientes)
    ? fotografia.reparacionesInterpretativasPendientes.map(r => Object.freeze({ ...r })) : [];

  const suficienciaSemantica = pendientesCobertura.length === 0
    && interpretacionesPendientes.length === 0
    && oportunidadesNoAtendidas.length === 0;
  const sinReparacionesInterpretativasPendientes = reparaciones.length === 0;

  return Object.freeze({
    suficienciaSemantica,
    sinReparacionesInterpretativasPendientes,
    suficienciaParaSintesis: suficienciaSemantica && sinReparacionesInterpretativasPendientes,
    razones: Object.freeze({
      dimensionesPendientesCobertura: Object.freeze(pendientesCobertura),
      dimensionesConInterpretacionPendiente: Object.freeze(interpretacionesPendientes),
      dimensionesElegiblesNoAtendidas: Object.freeze(oportunidadesNoAtendidas),
      reparacionesInterpretativasPendientes: Object.freeze(reparaciones),
    }),
  });
}

module.exports = { evaluarSuficienciaParaSintesis };
