'use strict';

/**
 * circulomejora006_reporte18 — frontera productiva mínima Movimiento→D1:
 * D1 como autoridad de CONTINUIDAD sobre el único candidato certificado que
 * Movimiento ya decidió, nunca como autoridad de selección entre varios
 * (eso sigue sin existir — ver MovimientoConversacionalPolicy.js) ni como
 * autoridad de síntesis (eso es resolverProgresoDestinoProductivo /
 * resolverProgresoDestinoDesdeBaseDefendible, deliberadamente NO
 * compuestos aquí: SINTETIZAR/DETENER_SIN_SINTESIS y baseDefendible/
 * obligacionesAbiertas exceden este incremento).
 *
 * Compone únicamente las dos piezas YA comprometidas y productivas de D1
 * mínimo (reporte12): `proyectarDeudasPosiblesDestino` (deriva la deuda
 * EXCLUSIVAMENTE de los candidatos certificados que recibe — nunca lee el
 * grafo) + `decidirD1Destino` (nunca fabrica, nunca muta, nunca lanza).
 *
 * Contrato de salida discriminado — nunca colapsa estados distintos:
 *   NO_APLICA    — Movimiento no certificó ningún candidato; D1 no tiene
 *                  nada que evaluar. El Writer debe conservar exactamente
 *                  su comportamiento histórico (contratoMovimientoDestino
 *                  = null por ausencia de candidato, no por veto de D1).
 *   CONTINUAR    — D1 confirma el candidato certificado; `movimientoPreferido`
 *                  es, por identidad, uno de los objetos recibidos en
 *                  `candidatosLegalesCertificados` — nunca uno reconstruido.
 *   NO_CONTINUAR — D1 decide no continuar con el candidato certificado
 *                  disponible; el Writer no debe ejecutarlo por esa causa.
 *
 * Fail-closed por excepción (nunca por continuidad silenciosa) cuando la
 * entrada o la salida de D1 viola su propio contrato — un candidato no
 * certificado, o un movimientoPreferido que no pertenece por identidad al
 * conjunto recibido: eso nunca es un NO_CONTINUAR válido, es una violación
 * de contrato que debe propagarse, nunca convertirse en "no hacer nada".
 */

const { validarCandidatoLegalDestinoCertificado } = require('../state/MovimientoConversacionalPolicy');
const { proyectarDeudasPosiblesDestino, decidirD1Destino } = require('./DireccionMinimaDestinoPolicy');

const RESULTADOS_CONTINUIDAD_MOVIMIENTO_DESTINO = Object.freeze({
  NO_APLICA: 'NO_APLICA',
  CONTINUAR: 'CONTINUAR',
  NO_CONTINUAR: 'NO_CONTINUAR',
});

function evaluarContinuidadMovimientoDestino({ candidatosLegalesCertificados } = {}) {
  if (!Array.isArray(candidatosLegalesCertificados)) {
    throw new Error(
      'evaluarContinuidadMovimientoDestino: candidatosLegalesCertificados debe ser un array (contrato violado por el llamador)',
    );
  }

  if (candidatosLegalesCertificados.length === 0) {
    return Object.freeze({
      decisionContinuidad: RESULTADOS_CONTINUIDAD_MOVIMIENTO_DESTINO.NO_APLICA,
      movimientoPreferido: null,
      codigoRazon: 'NO_APLICA_SIN_CANDIDATO_LEGAL',
    });
  }

  if (!candidatosLegalesCertificados.every(validarCandidatoLegalDestinoCertificado)) {
    throw new Error(
      'evaluarContinuidadMovimientoDestino: candidato no certificado por Movimiento — violación de contrato, nunca degradado a NO_CONTINUAR',
    );
  }

  const deudasPosibles = proyectarDeudasPosiblesDestino({
    movimientosLegalesCertificados: candidatosLegalesCertificados,
  });
  const decisionD1 = decidirD1Destino({ deudasPosibles, movimientosLegalesCertificados: candidatosLegalesCertificados });

  if (!decisionD1 || !['CONTINUAR', 'NO_CONTINUAR'].includes(decisionD1.decisionContinuidad)) {
    throw new Error('evaluarContinuidadMovimientoDestino: decidirD1Destino devolvió un resultado contractualmente inválido');
  }

  if (decisionD1.decisionContinuidad === 'NO_CONTINUAR') {
    if (decisionD1.movimientoPreferido) {
      throw new Error('evaluarContinuidadMovimientoDestino: NO_CONTINUAR con movimientoPreferido — contrato de D1 violado');
    }
    return Object.freeze({
      decisionContinuidad: RESULTADOS_CONTINUIDAD_MOVIMIENTO_DESTINO.NO_CONTINUAR,
      movimientoPreferido: null,
      codigoRazon: 'D1_NO_CONTINUAR',
    });
  }

  const preferido = decisionD1.movimientoPreferido;
  if (!preferido || !candidatosLegalesCertificados.includes(preferido)) {
    throw new Error(
      'evaluarContinuidadMovimientoDestino: movimientoPreferido no pertenece por identidad al conjunto certificado recibido',
    );
  }

  return Object.freeze({
    decisionContinuidad: RESULTADOS_CONTINUIDAD_MOVIMIENTO_DESTINO.CONTINUAR,
    movimientoPreferido: preferido,
    codigoRazon: 'D1_CONTINUAR_CANDIDATO_CERTIFICADO',
  });
}

module.exports = {
  RESULTADOS_CONTINUIDAD_MOVIMIENTO_DESTINO,
  evaluarContinuidadMovimientoDestino,
};
