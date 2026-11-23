'use strict';

/**
 * HITL POLICY (Human-In-The-Loop)
 * Determina qué decisiones requieren confirmación explícita del experto
 * antes de que el pipeline avance.
 *
 * Ref: Implementation Specification EPIC 06 (HITLPolicy);
 *      Matriz de Autoridad — 'ia_propone_experto_elige';
 *      Gap Analysis 2.4.
 *
 * Decisiones que SIEMPRE requieren HITL (Matriz de Autoridad validada en Sprint 1):
 *   - Selección de Avatar (etapa 'opciones')
 *   - Selección de Promesa (etapa 'opciones')
 *   - Selección de Arquitectura (etapa 'arquitectura')
 *
 * Decisiones que la IA toma sola (gate de calidad, sin HITL):
 *   - Inferencia de Avatar/Promesa (antes de presentar opciones)
 *   - Selección de evidencias por módulo
 *   - Forma del producto
 *   - Desarrollo de contenido
 *   - Bonus
 */

// ── Matriz HITL ───────────────────────────────────────────────────────────────

const HITL_DECISIONS = Object.freeze({
  // etapa → { campo, descripcion, escape: qué pasa si el experto rechaza todo }
  opciones_avatar: {
    etapa:       'opciones',
    campo:       'avatarElegido',
    descripcion: 'El experto debe elegir cuál descripción de su avatar conecta más con la realidad',
    autoridad:   'ia_propone_experto_elige',
    escape:      'repreguntar',  // si ninguna opción convence → volver a inferencia con contexto nuevo
  },
  opciones_promesa: {
    etapa:       'opciones',
    campo:       'promesaElegida',
    descripcion: 'El experto debe elegir cuál promesa expresa mejor lo que quiere lograr',
    autoridad:   'ia_propone_experto_elige',
    escape:      'repreguntar',
  },
  arquitectura: {
    etapa:       'arquitectura',
    campo:       'arquitecturaElegida',
    descripcion: 'El experto debe confirmar o elegir el camino de aprendizaje',
    autoridad:   'ia_propone_experto_elige',
    escape:      'continuar_con_recomendada', // si solo hay 1, se confirma automáticamente
  },
});

// Etapas con puntos de confirmación HITL
const HITL_STAGES = new Set(['arquitectura']); // opciones se gestiona internamente via elegirOpcionValida (AgoraStages)

// ── Estado de una decisión HITL ───────────────────────────────────────────────

const HITL_STATUS = Object.freeze({
  PENDING:   'pending',     // esperando respuesta del experto
  CONFIRMED: 'confirmed',   // el experto eligió
  REJECTED:  'rejected',    // el experto rechazó todas las opciones
  BYPASSED:  'bypassed',    // única opción → confirmación automática justificada
});

function hitlResult(required, decisionKey, status, razon, metadata = {}) {
  return Object.freeze({ required, decisionKey, status, razon, metadata });
}

// ── HITLPolicy ────────────────────────────────────────────────────────────────

const HITLPolicy = {

  /**
   * ¿Esta etapa tiene un punto de confirmación HITL?
   * @returns {boolean}
   */
  requiresHITL: (etapa) => HITL_STAGES.has(etapa),

  /**
   * Evalúa el estado de la decisión HITL para una etapa.
   * @param {object} state — CognitiveState
   * @param {string} etapa
   * @returns {HitlResult}
   */
  evaluate: (state, etapa) => {
    if (!HITLPolicy.requiresHITL(etapa)) {
      return hitlResult(false, null, HITL_STATUS.BYPASSED,
        `Etapa '${etapa}' no tiene punto HITL`);
    }

    if (etapa === 'opciones') {
      const avatarOk  = !!state.avatarElegido;
      const promesaOk = !!state.promesaElegida;

      if (avatarOk && promesaOk) {
        return hitlResult(false, 'opciones_avatar+promesa', HITL_STATUS.CONFIRMED,
          'Avatar y Promesa confirmados por el experto',
          { avatarElegido: state.avatarElegido, promesaElegida: state.promesaElegida });
      }
      const pendiente = [
        !avatarOk  && 'Avatar',
        !promesaOk && 'Promesa',
      ].filter(Boolean).join(' y ');
      return hitlResult(true, 'opciones_avatar+promesa', HITL_STATUS.PENDING,
        `El experto debe confirmar: ${pendiente}`,
        { avatarPendiente: !avatarOk, promesaPendiente: !promesaOk });
    }

    if (etapa === 'arquitectura') {
      if (state.arquitecturaElegida) {
        return hitlResult(false, 'arquitectura', HITL_STATUS.CONFIRMED,
          'Arquitectura confirmada por el experto o por confirmación automática (única opción)');
      }
      return hitlResult(true, 'arquitectura', HITL_STATUS.PENDING,
        'El experto debe confirmar el camino de aprendizaje');
    }

    return hitlResult(false, null, HITL_STATUS.BYPASSED,
      `Etapa '${etapa}': no hay definición HITL explícita — se pasa automáticamente`);
  },

  /**
   * Registra la elección del experto en el estado.
   * Devuelve el estado modificado + el resultado HITL actualizado.
   * @param {object} state
   * @param {string} decisionKey — 'opciones_avatar', 'opciones_promesa', 'arquitectura'
   * @param {*}      valor       — el valor elegido
   * @returns {{ state, result: HitlResult }}
   */
  recordChoice: (state, decisionKey, valor) => {
    const decision = HITL_DECISIONS[decisionKey];
    if (!decision) {
      return {
        state,
        result: hitlResult(false, decisionKey, HITL_STATUS.BYPASSED,
          `Decisión '${decisionKey}' no reconocida en HITLPolicy`),
      };
    }
    state[decision.campo] = valor;
    return {
      state,
      result: hitlResult(false, decisionKey, HITL_STATUS.CONFIRMED,
        `Experto eligió '${decisionKey}'`,
        { campo: decision.campo, valor }),
    };
  },

  /**
   * Registra que el experto rechazó todas las opciones.
   * Devuelve el escape recomendado.
   */
  recordRejection: (decisionKey) => {
    const decision = HITL_DECISIONS[decisionKey];
    const escape   = decision?.escape ?? 'repreguntar';
    return hitlResult(true, decisionKey, HITL_STATUS.REJECTED,
      `El experto rechazó todas las opciones para '${decisionKey}'`,
      { escape, instruccion: escape === 'repreguntar'
        ? 'Pedir al experto que aclare qué cambiaría, y reintentar inferencia con esa evidencia adicional'
        : 'Usar la opción recomendada por el sistema' });
  },

  /**
   * Verifica si el pipeline puede avanzar desde esta etapa.
   * Combina HITL con el estado actual.
   */
  canAdvance: (state, etapa) => {
    const r = HITLPolicy.evaluate(state, etapa);
    return { ok: !r.required || r.status === HITL_STATUS.CONFIRMED, hitlResult: r };
  },

  HITL_DECISIONS,
  HITL_STATUS,
  HITL_STAGES,
};

module.exports = { HITLPolicy, HITL_STATUS };
