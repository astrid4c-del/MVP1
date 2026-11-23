'use strict';

/**
 * circulomejora006_reporte12 — frontera productiva que reúne:
 *   resultadoBaseDefendible (ya certificado, ver BaseDefendibleDestinoPolicy.js)
 *   + candidatos legales de Movimiento certificados (proyectarMovimientosLegalesDestino, reporte11)
 *   + deudas derivadas de esos mismos candidatos (DireccionMinimaDestinoPolicy.js, reporte12)
 *   → decisionD1 PRODUCIDA internamente (nunca recibida como parámetro fabricable)
 *   → resolverProgresoDestinoDesdeBaseDefendible (reporte10, sin modificar)
 *
 * Esta es la ÚNICA función productiva de este incremento: no expone
 * ninguna vía para que un caller inyecte `decisionD1` directamente. Quien
 * necesite construir `decisionD1` a mano (tests unitarios de
 * DireccionMinimaDestinoPolicy.js, o de resolverProgresoDestinoDesdeBaseDefendible
 * mismo) sigue pudiendo hacerlo contra esas funciones puras — nunca contra
 * esta frontera.
 *
 * Síncrona por diseño: `resultadoBaseDefendible` ya llega calculado (su
 * cómputo es asíncrono — LLM, ver BaseDefendibleDestinoEvaluationReader.js
 * — pero eso ocurre ANTES de llamar aquí, igual que en reporte10);
 * `proyectarMovimientosLegalesDestino` es puramente estructural sobre el
 * grafo, sin I/O. No persiste nada — se recalcula por completo en cada
 * llamada.
 */

const { proyectarMovimientosLegalesDestino } = require('../state/MovimientoConversacionalPolicy');
const { proyectarDeudasPosiblesDestino, decidirD1Destino } = require('./DireccionMinimaDestinoPolicy');
const { resolverProgresoDestinoDesdeBaseDefendible } = require('./ProgresoDestinoDesdeBaseDefendibleOrquestacion');

function resolverProgresoDestinoProductivo({
  resultadoBaseDefendible, obligacionesAbiertas,
  grafo, nivel, dimensionEnFocoAnterior, dimensionesDiferidas, reparacionesInterpretativasPendientes,
} = {}) {
  // Mismo patrón fail-closed que el resto de la orquestación de DESTINO
  // (Observabilidad/Proporcionalidad/Especificidad/DiferenciaTransformacional):
  // un grafo ausente o malformado degrada a "sin candidatos legales" — nunca
  // se propaga como excepción hacia el llamador productivo, y nunca se
  // interpreta como evidencia de que sí existe una intervención útil.
  let movimientosLegalesCertificados;
  try {
    movimientosLegalesCertificados = proyectarMovimientosLegalesDestino({
      grafo, nivel, dimensionEnFocoAnterior, dimensionesDiferidas, reparacionesInterpretativasPendientes,
    });
  } catch (error) {
    movimientosLegalesCertificados = [];
  }
  const deudasPosibles = proyectarDeudasPosiblesDestino({ movimientosLegalesCertificados });
  const decisionD1 = decidirD1Destino({ deudasPosibles, movimientosLegalesCertificados });
  return resolverProgresoDestinoDesdeBaseDefendible({ resultadoBaseDefendible, obligacionesAbiertas, decisionD1 });
}

module.exports = { resolverProgresoDestinoProductivo };
