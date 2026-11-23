'use strict';

/**
 * circulomejora006_reporte12 — productor mínimo comprometido de
 * `decisionD1` para DESTINO.
 *
 * D1 responde ÚNICAMENTE: ¿existe una deuda material que justifique
 * continuar, y existe AHORA un movimiento legal certificado capaz de
 * atenderla? Nunca decide si la base es defendible, si una obligación
 * bloquea síntesis, ni ninguno de los cuatro criterios semánticos — esas
 * dimensiones permanecen exclusivamente en BaseDefendibleDestinoPolicy.js
 * y en `obligacionesAbiertas` (evaluadas después, por Progreso, con
 * precedencia de CONTINUAR ya establecida en ProgresoConversacionalPolicy.js).
 *
 * Deliberadamente NO promueve la taxonomía amplia de deudas del WIP
 * D1.7-A (`DireccionConversacionalDestinoPolicy.js`: TIPOS_DEUDA,
 * NECESIDADES, VALOR_MARGINAL, evaluación de costo conversacional,
 * ranking multi-candidato) — permanece como modificación local no
 * comprometida, fuera de alcance de este incremento. Este módulo cubre
 * únicamente lo mínimo demostrable con la capacidad de Movimiento YA
 * comprometida (`proyectarMovimientosLegalesDestino`, reporte11), que hoy
 * proyecta como máximo UN candidato legal por turno.
 *
 * Nunca lee el grafo directamente: toda la evidencia le llega ya
 * proyectada (deudas, candidatos legales certificados). Nunca persiste
 * nada — se recalcula por completo en cada llamada, mismo principio que
 * el resto de Movimiento/Progreso ("el movimiento es una decisión, no un
 * estado").
 */

const { ORDEN_DESTINO, validarCandidatoLegalDestinoCertificado } = require('../state/MovimientoConversacionalPolicy');

const MATERIALIDADES_VALIDAS = new Set(['MATERIAL', 'NO_MATERIAL']);

function esDeudaValida(deuda) {
  return !!deuda && typeof deuda === 'object'
    && typeof deuda.deudaId === 'string' && deuda.deudaId.trim().length > 0
    && typeof deuda.tipo === 'string' && deuda.tipo.trim().length > 0
    && MATERIALIDADES_VALIDAS.has(deuda.materialidad)
    && Number.isInteger(deuda.prioridad) && deuda.prioridad >= 0;
}

/**
 * circulomejora006_reporte12 — única fuente de deuda de este incremento:
 * deriva, determinísticamente y SIN leer el grafo, una deuda material por
 * cada candidato legal certificado ya proyectado por Movimiento — la
 * dimensión que ese candidato atendería es, por construcción, la misma
 * deuda que justifica su propia existencia (Movimiento nunca proyecta un
 * candidato sin que exista alguna dimensión con trabajo pendiente).
 *
 * No es una proyección general de obligaciones (eso permanece en
 * ObligacionesAbiertasDestinoProjection.js — D1.7-A, WIP, sin promover
 * aquí): cubre EXACTAMENTE la deuda "queda una intervención conversacional
 * pendiente en esta dimensión", nunca reparaciones, contradicciones,
 * síntesis rechazadas ni incertidumbres — esas categorías, si algún día se
 * necesitan, pertenecen a D1.7-A.
 */
function proyectarDeudasPosiblesDestino({ movimientosLegalesCertificados } = {}) {
  if (!Array.isArray(movimientosLegalesCertificados)) return Object.freeze([]);
  return Object.freeze(movimientosLegalesCertificados
    .filter(candidato => (
      candidato && typeof candidato === 'object'
      && typeof candidato.dimensionObjetivo === 'string' && typeof candidato.codigoRazon === 'string'
    ))
    .map(candidato => Object.freeze({
      deudaId: `deuda_destino_${candidato.dimensionObjetivo}_${candidato.codigoRazon}`,
      tipo: 'INTERVENCION_CONVERSACIONAL_PENDIENTE',
      materialidad: 'MATERIAL',
      prioridad: Math.max(0, ORDEN_DESTINO.indexOf(candidato.dimensionObjetivo)),
      dimension: candidato.dimensionObjetivo,
    })));
}

/**
 * Compatibilidad deuda↔movimiento (Especificación §7 del encargo): nunca
 * análisis semántico, siempre estructural. Si la deuda declara `dimension`,
 * debe coincidir EXACTAMENTE con `dimensionObjetivo` del candidato. Si la
 * deuda no declara dimensión, solo se acepta "por construcción" cuando el
 * candidato es el ÚNICO movimiento legal certificado disponible — no hay
 * ambigüedad posible sobre a cuál se refiere.
 */
function esDeudaCompatibleConMovimiento(deuda, movimiento, totalCertificados) {
  if (typeof deuda.dimension === 'string' && deuda.dimension) {
    return deuda.dimension === movimiento.dimensionObjetivo;
  }
  return totalCertificados === 1;
}

function ordenDeterministaDeDeudas(deudas) {
  return [...deudas].sort((a, b) => (
    a.prioridad - b.prioridad || a.deudaId.localeCompare(b.deudaId)
  ));
}

const NO_CONTINUAR = Object.freeze({
  decisionContinuidad: 'NO_CONTINUAR', deudaPrioritaria: null, movimientoPreferido: null,
});

/**
 * circulomejora006_reporte12 — productor mínimo de decisionD1.
 *
 * @param {object} params
 * @param {Array} params.deudasPosibles — deudas ya proyectadas (nunca se
 *   reconstruyen desde el grafo aquí).
 * @param {Array} params.movimientosLegalesCertificados — candidatos ya
 *   certificados por Movimiento (`proyectarMovimientosLegalesDestino`);
 *   cualquier entrada que NO pase `validarCandidatoLegalDestinoCertificado`
 *   se descarta sin excepción, nunca produce CONTINUAR.
 * @returns {{decisionContinuidad: 'CONTINUAR'|'NO_CONTINUAR', deudaPrioritaria: object|null, movimientoPreferido: object|null}}
 *   Nunca lanza. Cualquier entrada ausente, mal formada, o sin combinación
 *   deuda+movimiento certificado compatible degrada a NO_CONTINUAR — nunca
 *   un tercer estado público, nunca CONTINUAR por incertidumbre.
 */
function decidirD1Destino({ deudasPosibles, movimientosLegalesCertificados } = {}) {
  if (!Array.isArray(deudasPosibles) || !Array.isArray(movimientosLegalesCertificados)) return NO_CONTINUAR;

  const certificados = movimientosLegalesCertificados.filter(candidato => (
    validarCandidatoLegalDestinoCertificado(candidato)
  ));
  if (certificados.length === 0) return NO_CONTINUAR;

  const deudasMateriales = ordenDeterministaDeDeudas(deudasPosibles.filter(esDeudaValida)
    .filter(deuda => deuda.materialidad === 'MATERIAL'));
  if (deudasMateriales.length === 0) return NO_CONTINUAR;

  for (const deuda of deudasMateriales) {
    const movimiento = certificados.find(candidato => (
      esDeudaCompatibleConMovimiento(deuda, candidato, certificados.length)
    ));
    if (movimiento) {
      return Object.freeze({
        decisionContinuidad: 'CONTINUAR',
        deudaPrioritaria: deuda,
        movimientoPreferido: movimiento,
      });
    }
  }
  return NO_CONTINUAR;
}

module.exports = {
  proyectarDeudasPosiblesDestino,
  decidirD1Destino,
};
