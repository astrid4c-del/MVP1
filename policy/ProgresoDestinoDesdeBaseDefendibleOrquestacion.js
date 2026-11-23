'use strict';

/**
 * circulomejora006_reporte10 — única ruta productiva desde el resultado
 * gobernado de BaseDefendibleDestinoPolicy hacia
 * ProgresoConversacionalPolicy.resolverEstadoConversacionalDestino.
 *
 * La autoridad permanece exclusivamente en
 * `resultadoBaseDefendible.resultado`. La única condición válida para
 * proyectar `baseDefendible=true` es
 * `resultadoBaseDefendible?.resultado === 'BASE_DEFENDIBLE'` — nunca
 * `Boolean(resultadoBaseDefendible)`, ausencia de `razones`, los cuatro
 * criterios semánticos por separado, autorización de la Afirmación por sí
 * sola, ni un booleano recibido de otra frontera. Esta función no
 * reconstruye ni reinterpreta `razones`: son diagnóstico, nunca una
 * segunda fuente de reglas.
 *
 * `resolverEstadoConversacionalDestino` sigue siendo una función pura
 * exportada y utilizable directamente (sus tests existentes la ejercitan
 * con un booleano crudo como detalle interno) — pero esta función es la
 * ÚNICA ruta productiva por la que un `resultadoBaseDefendible` real puede
 * llegar a influir el estado conversacional. No persiste nada: la decisión
 * es process-local, recalculada cada vez a partir de la vista vigente.
 */

const { resolverEstadoConversacionalDestino } = require('./ProgresoConversacionalPolicy');

function proyectarBaseDefendibleDestino(resultadoBaseDefendible) {
  return !!resultadoBaseDefendible && resultadoBaseDefendible.resultado === 'BASE_DEFENDIBLE';
}

function resolverProgresoDestinoDesdeBaseDefendible({
  resultadoBaseDefendible, obligacionesAbiertas, decisionD1,
} = {}) {
  const baseDefendible = proyectarBaseDefendibleDestino(resultadoBaseDefendible);
  return resolverEstadoConversacionalDestino({ baseDefendible, obligacionesAbiertas, decisionD1 });
}

module.exports = {
  proyectarBaseDefendibleDestino,
  resolverProgresoDestinoDesdeBaseDefendible,
};
