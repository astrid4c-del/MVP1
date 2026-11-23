'use strict';

/**
 * AUTHORITY POLICY
 * Determina quién tiene autoridad sobre cada tipo de afirmación.
 * Formaliza el Artículo 13 (De la Autoridad Epistémica) de la Constitución (Doc 1)
 * y el Principio de Autoridad (Doc 2).
 *
 * La autoridad no depende únicamente del origen — depende de la naturaleza
 * de cada afirmación:
 *   - El experto tiene autoridad primaria sobre su experiencia, historia,
 *     identidad, filosofía, criterio y metodología propia.
 *   - La evidencia verificable tiene autoridad primaria sobre hechos actuales,
 *     datos, ciencia, normas y regulaciones.
 *   - El Modelo Agora tiene autoridad metodológica sobre el diseño de
 *     experiencias de aprendizaje.
 *   - La IA nunca constituye autoridad por sí misma.
 *
 * Ref: Constitución Art. 13; Principio de Autoridad (Doc 2);
 *      Gap Analysis — AuthorityPolicy desde hasAnchor() + auditor de fidelidad.
 */

const { hasAnchor }      = require('../schemas/CognitiveObject');
const { VALID_AUTHORITY } = require('../schemas/CognitiveObject');

// ── Tipos de afirmación y su autoridad canónica ───────────────────────────────

const AUTHORITY_MATRIX = Object.freeze({
  // El experto manda sobre su propia experiencia y criterio
  experiencia_vivida:      'experto',
  historia_personal:       'experto',
  identidad_intelectual:   'experto',
  filosofia_propia:        'experto',
  criterio_propio:         'experto',
  metodologia_propia:      'experto',
  // Evidencia verificable manda sobre hechos del mundo externo
  hecho_actual:            'evidencia_verificable',
  dato_verificable:        'evidencia_verificable',
  norma_regulacion:        'evidencia_verificable',
  ciencia_establecida:     'evidencia_verificable',
  // El Modelo Agora tiene autoridad metodológica instruccional
  diseno_instruccional:    'ia',  // IA propone, experto confirma
  estructura_aprendizaje:  'ia',
  // Inferido por el sistema
  inferido_del_contexto:   'inferido',
});

const AUTHORITY_WEIGHTS = Object.freeze({
  experto:              4,   // máxima autoridad sobre su propio conocimiento
  evidencia_verificable: 3,  // alta autoridad sobre hechos verificables
  ia:                   2,   // propone, no decide unilateralmente
  inferido:             1,   // la más débil — requiere confirmación
});

// ── Resultado de evaluación de autoridad ──────────────────────────────────────

/**
 * @typedef {object} AuthorityResult
 * @property {boolean}  valid        — la afirmación tiene autoridad suficiente
 * @property {string}   autoridad    — autoridad detectada
 * @property {number}   peso         — peso epistémico (1–4)
 * @property {string}   razon
 * @property {string[]} advertencias
 */

function authorityResult(valid, autoridad, razon, advertencias = []) {
  return Object.freeze({
    valid,
    autoridad,
    peso: AUTHORITY_WEIGHTS[autoridad] || 0,
    razon,
    advertencias,
  });
}

// ── AuthorityPolicy pública ───────────────────────────────────────────────────

const AuthorityPolicy = {

  /**
   * Evalúa si un CognitiveObject tiene autoridad y anclaje real.
   * Replica y formaliza hasAnchor() de circulo_v0.
   * @param {object} cognitiveObject
   * @returns {AuthorityResult}
   */
  evaluateObject: (cognitiveObject) => {
    if (!cognitiveObject || typeof cognitiveObject !== 'object') {
      return authorityResult(false, 'inferido', 'El objeto no existe o no es válido');
    }
    if (!hasAnchor(cognitiveObject)) {
      const razon = cognitiveObject.confianza !== 'alta'
        ? `Confianza insuficiente: '${cognitiveObject.confianza}' (se requiere 'alta')`
        : !cognitiveObject.evidencia
          ? 'Sin evidencia declarada'
          : 'Valor vacío';
      return authorityResult(false, cognitiveObject.autoridad || 'inferido', razon,
        [`campo: ${cognitiveObject.id || '?'}`]);
    }
    const peso = AUTHORITY_WEIGHTS[cognitiveObject.autoridad] || 1;
    return authorityResult(true, cognitiveObject.autoridad, 'Objeto con anclaje real verificado');
  },

  /**
   * Evalúa el avatar inferido: filtra campos sin anclaje, devuelve solo los válidos.
   * Replica la lógica de filtrado del Motor de Inferencia de circulo_v0.
   * @param {object} avatarRaw — respuesta cruda del modelo { campo: {valor, evidencia, confianza} }
   * @returns {{ camposValidos: object, camposDescartados: string[], result: AuthorityResult }}
   */
  evaluateAvatar: (avatarRaw) => {
    if (!avatarRaw || typeof avatarRaw !== 'object') {
      return {
        camposValidos: {},
        camposDescartados: [],
        result: authorityResult(false, 'inferido', 'Avatar nulo o inválido'),
      };
    }
    const camposValidos = {};
    const camposDescartados = [];

    Object.entries(avatarRaw).forEach(([k, v]) => {
      if (hasAnchor(v)) {
        camposValidos[k] = v;
      } else {
        camposDescartados.push(k);
      }
    });

    const nValidos = Object.keys(camposValidos).length;
    const result = nValidos > 0
      ? authorityResult(true, 'experto',
          `${nValidos} campo(s) con anclaje real del experto`,
          camposDescartados.map(k => `Campo descartado sin anclaje: ${k}`))
      : authorityResult(false, 'inferido',
          'Todos los campos del avatar carecen de anclaje real',
          camposDescartados.map(k => `Campo descartado: ${k}`));

    return { camposValidos, camposDescartados, result };
  },

  /**
   * Evalúa la promesa inferida: requiere valor + evidencia.
   * @param {object} promesaRaw — { valor, evidencia }
   * @returns {AuthorityResult}
   */
  evaluatePromesa: (promesaRaw) => {
    if (!promesaRaw || !promesaRaw.valor || !String(promesaRaw.valor).trim()) {
      return authorityResult(false, 'inferido', 'Promesa sin valor');
    }
    if (!promesaRaw.evidencia || !String(promesaRaw.evidencia).trim()) {
      return authorityResult(false, 'inferido', 'Promesa sin evidencia — no puede afirmarse sin anclaje');
    }
    return authorityResult(true, 'experto',
      'Promesa con valor y evidencia declarada');
  },

  /**
   * Evalúa si una decisión respeta la Matriz de Autoridad.
   * Detecta decisiones donde la IA afirma sin autoridad sobre dominio del experto.
   * @param {object} decision — { etapa, autoridad, valor, evidenciaIds }
   * @returns {AuthorityResult}
   */
  evaluateDecision: (decision) => {
    if (!decision) {
      return authorityResult(false, 'inferido', 'Decisión nula');
    }
    if (!VALID_AUTHORITY.includes(decision.autoridad)) {
      return authorityResult(false, 'inferido',
        `Autoridad '${decision.autoridad}' no reconocida en la Matriz de Autoridad`);
    }
    // La IA nunca puede ser la única autoridad sobre experiencia del experto
    if (decision.autoridad === 'ia' && decision.etapa === 'inferencia') {
      return authorityResult(false, 'ia',
        'La IA no puede ser autoridad única en la etapa de inferencia — requiere anclaje en slots del experto',
        ['Usar autoridad "inferido" con evidenciaIds declarados']);
    }
    const peso = AUTHORITY_WEIGHTS[decision.autoridad] || 0;
    return authorityResult(true, decision.autoridad,
      `Decisión con autoridad '${decision.autoridad}' (peso ${peso})`);
  },

  /**
   * Clasifica el tipo de afirmación y devuelve su autoridad canónica.
   * @param {string} tipoAfirmacion — clave de AUTHORITY_MATRIX
   * @returns {{ autoridad: string, peso: number }}
   */
  getCanonicalAuthority: (tipoAfirmacion) => {
    const autoridad = AUTHORITY_MATRIX[tipoAfirmacion] || 'inferido';
    return { autoridad, peso: AUTHORITY_WEIGHTS[autoridad] };
  },

  AUTHORITY_MATRIX,
  AUTHORITY_WEIGHTS,
};

module.exports = { AuthorityPolicy };
