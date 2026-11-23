'use strict';

/**
 * circulomejora006_reporte15 — frontera productiva única de la síntesis de
 * DESTINO. Compone:
 *
 *   vista certificada (BaseDefendibleDestinoEvaluationReader, ya llamado
 *   por el caller antes de esta frontera)
 *   → resultadoBaseDefendible (BaseDefendibleDestinoPolicy, PRODUCIDO aquí
 *     internamente desde la vista — nunca recibido como parámetro)
 *   → resultadoProgreso (ProgresoDestinoProductivoOrquestacion, PRODUCIDO
 *     aquí internamente — nunca recibido como parámetro fabricable)
 *   → síntesis (SintesisDestinoDesdePresentacionPolicy, solo si
 *     resultadoProgreso.resultado === 'SINTETIZAR')
 *
 * Esta es la ÚNICA función productiva de este incremento. No existe
 * ninguna API que acepte `resultadoProgreso`, `decisionD1` ni
 * `debeSintetizar` como parámetro externo — quien necesite construir esos
 * objetos a mano para un test unitario sigue pudiendo hacerlo contra las
 * funciones puras correspondientes (DireccionMinimaDestinoPolicy.js,
 * SintesisDestinoDesdePresentacionPolicy.js), nunca contra esta frontera.
 *
 * Síncrona por diseño, igual que ProgresoDestinoProductivoOrquestacion.js:
 * la vista ya llega calculada (su cómputo es asíncrono — LLM — pero eso
 * ocurre ANTES, al preparar la vista). No persiste nada.
 */

const { derivarBaseDefendibleDestino } = require('./BaseDefendibleDestinoPolicy');
const { resolverProgresoDestinoProductivo } = require('./ProgresoDestinoProductivoOrquestacion');
const { producirSintesisDestinoDesdeProgreso } = require('./SintesisDestinoDesdePresentacionPolicy');

function producirSintesisDestinoProductiva({
  vista, obligacionesAbiertas,
  grafo, nivel, dimensionEnFocoAnterior, dimensionesDiferidas, reparacionesInterpretativasPendientes,
} = {}) {
  let resultadoBaseDefendible;
  try {
    // derivarBaseDefendibleDestino lanza VISTA_DESTINO_NO_CERTIFICADA ante
    // cualquier vista no certificada (fabricada, copiada, reconstruida) —
    // se traduce aquí a la degradación fail-closed de este incremento en
    // vez de propagarse; producirSintesisDestinoDesdeProgreso, más abajo,
    // vuelve a comprobar la certificación de forma independiente.
    resultadoBaseDefendible = derivarBaseDefendibleDestino(vista);
  } catch (error) {
    resultadoBaseDefendible = null;
  }
  const resultadoProgreso = resolverProgresoDestinoProductivo({
    resultadoBaseDefendible, obligacionesAbiertas,
    grafo, nivel, dimensionEnFocoAnterior, dimensionesDiferidas, reparacionesInterpretativasPendientes,
  });
  return producirSintesisDestinoDesdeProgreso({ resultadoProgreso, vista });
}

module.exports = { producirSintesisDestinoProductiva };
