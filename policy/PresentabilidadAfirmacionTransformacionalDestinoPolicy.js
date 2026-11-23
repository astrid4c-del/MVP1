'use strict';

/**
 * S1_R_INCREMENTO_1 — política pura de presentabilidad de una Afirmación
 * AUTORIZADA.
 *
 * Responde EXCLUSIVAMENTE: "dada esta Afirmación head, su Presentación
 * causal, y la reparación abierta que pudiera tener asociada, ¿puede
 * mostrarse hoy como síntesis vigente?" — nunca decide protocolo, nunca
 * produce texto, nunca elige Hipótesis, nunca abre ni resuelve
 * reparaciones, nunca lee SQLite (recibe los tres objetos ya resueltos por
 * el llamador). Separación deliberada: la Afirmación permanece AUTORIZADA
 * (verdad histórica, inmutable) mientras esta política puede bloquearla
 * para reutilización (verdad operativa, mutable) — dos preguntas distintas
 * sobre el mismo objeto, nunca una transición de estado nueva en el schema
 * de Afirmación.
 *
 * No es responsabilidad del repositorio (persistencia, identidad, cabeza
 * vigente, historial causal, reparaciones abiertas almacenadas) decidir
 * esta regla de producto — el repositorio solo entrega los hechos; esta
 * función decide.
 */

const VEREDICTOS = Object.freeze({
  PRESENTABLE: 'PRESENTABLE',
  BLOQUEADA_POR_REPARACION: 'BLOQUEADA_POR_REPARACION',
  PRESENTACION_AUSENTE: 'PRESENTACION_AUSENTE',
  IDENTIDAD_INCOHERENTE: 'IDENTIDAD_INCOHERENTE',
});

/**
 * @param {object} params
 * @param {object} params.afirmacionHead — Afirmación AUTORIZADA vigente, ya resuelta por el llamador.
 * @param {object|null} params.presentacionCausal — Presentación estructurada ligada a esa Afirmación, o null si no existe.
 * @param {object|null} params.reparacionAbierta — reparación S1-R con estado==='ABIERTA' para esa identidad exacta, o null si no hay ninguna.
 * @returns {string} uno de VEREDICTOS — nunca lanza, nunca aproxima.
 */
function determinarPresentabilidadAfirmacion({
  afirmacionHead, presentacionCausal, reparacionAbierta = null,
} = {}) {
  if (!afirmacionHead || typeof afirmacionHead !== 'object') {
    return VEREDICTOS.IDENTIDAD_INCOHERENTE;
  }
  if (!presentacionCausal || typeof presentacionCausal !== 'object') {
    return VEREDICTOS.PRESENTACION_AUSENTE;
  }
  // Fail-closed: la Presentación entregada debe pertenecer EXACTAMENTE a
  // esta Afirmación — nunca se asume, siempre se revalida aquí también,
  // aunque el llamador ya la haya localizado por identidad.
  if (
    presentacionCausal.afirmacionId !== afirmacionHead.id
    || presentacionCausal.afirmacionVersion !== afirmacionHead.version
  ) {
    return VEREDICTOS.IDENTIDAD_INCOHERENTE;
  }
  if (reparacionAbierta) {
    // Fail-closed: una reparación abierta que no coincide con ESTA
    // Afirmación exacta es una incoherencia del llamador, nunca un
    // bloqueo válido — nunca se asume "más vale prevenir".
    if (
      reparacionAbierta.afirmacionOrigenId !== afirmacionHead.id
      || reparacionAbierta.afirmacionOrigenVersion !== afirmacionHead.version
    ) {
      return VEREDICTOS.IDENTIDAD_INCOHERENTE;
    }
    if (reparacionAbierta.estado === 'ABIERTA') {
      return VEREDICTOS.BLOQUEADA_POR_REPARACION;
    }
  }
  return VEREDICTOS.PRESENTABLE;
}

module.exports = { VEREDICTOS, determinarPresentabilidadAfirmacion };
