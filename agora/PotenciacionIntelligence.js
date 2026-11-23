'use strict';

/**
 * POTENCIACION INTELLIGENCE
 * Responsabilidad única: fortalecer el patrimonio intelectual sin modificar su identidad.
 * Detecta vacíos, propone enriquecimientos, contrasta contradicciones.
 * NUNCA sobrescribe el KnowledgeGraph original.
 * NUNCA realiza investigación externa (eso es ContextualIntelligence).
 * Produce: EnhancedKnowledge con propuestas trazables pendientes de aprobación.
 *
 * Ref: Arquitectura Cognitiva (Doc 4) — Inteligencia de Potenciación;
 *      Implementation Specification EPIC 09; Gap Analysis tarea 4.2.
 *
 * Flujo:
 *   1. potenciar(state) → llama al LLM con el KG como contexto
 *   2. El LLM propone vacíos, enriquecimientos, contradicciones e inferencias nuevas
 *   3. Cada propuesta nace con estado 'pendiente'
 *   4. accept(ek, propuestaId) y reject(ek, propuestaId) aplican decisiones explícitas
 *   5. promote(ek, state) aplica PromotionPolicy antes de aceptar el resultado como canónico
 */

const {
  createEnhancedKnowledge,
  VALID_PROPOSAL_TYPES,
} = require('../schemas/EnhancedKnowledge');
const { validateEnhancedKnowledge }  = require('../schemas/EnhancedKnowledge');
const { AuthorityPolicy }            = require('../policy/AuthorityPolicy');
const { PromotionPolicy, PROMOTION_STATUS } = require('../policy/PromotionPolicy');

// ── Prompt del sistema ─────────────────────────────────────────────────────────

const POTENCIACION_SYSTEM = `Eres la Inteligencia de Potenciación de Círculo. Tu único trabajo: fortalecer el patrimonio intelectual del experto sin modificar su identidad.

LEYES ABSOLUTAS:
1. NUNCA inventes hechos externos: no cites estadísticas, estudios, tendencias de mercado ni investigación que no esté ya en el patrimonio. Eso no es tu trabajo.
2. NUNCA sobrescribas: cada propuesta es una SUGERENCIA explícita que el experto debe aprobar.
3. PRESERVA LA VOZ: si el experto usa "foto del momento" para hablar de balances, no lo traduzcas a "estado financiero estático". Su lenguaje es parte del conocimiento.

TU TRABAJO es detectar únicamente dentro del patrimonio ya capturado:

VACÍOS: ¿qué está implícito pero no articulado? ¿qué preguntas dejaría sin responder el patrimonio actual?

ENRIQUECIMIENTOS: ¿qué conexión entre conceptos existentes no está declarada? ¿qué matiz del experto no se capturó del todo? Solo a partir de lo que el experto ya dijo.

CONTRADICCIONES: ¿hay tensiones entre conceptos del grafo? No son errores del experto — son zonas de complejidad que vale la pena explicitar.

INFERENCIAS NUEVAS: ¿qué conclusiones se derivan de la combinación de conceptos existentes, sin añadir información externa?

ESTRUCTURA DE RESPUESTA:
{
  "vaciosDetectados": ["descripcion del vacío en el lenguaje del experto"],
  "propuestas": [
    {
      "id": "p_1",
      "tipo": "enriquecimiento|vacio_detectado|contradiccion|inferencia_nueva",
      "descripcion": "qué se propone, en el idioma del experto",
      "origen": "inferida",
      "estado": "pendiente",
      "procedencia": "derivado de concepto c_X o relación entre c_Y y c_Z",
      "justificacion": "por qué esta propuesta fortalece el patrimonio sin cambiar la identidad"
    }
  ],
  "conceptosNuevos": [
    {
      "id": "cn_1",
      "tipo": "principio|heuristica|proceso_mental|...",
      "descripcion": "...",
      "confianza": "media",
      "autoridad": "inferido",
      "procedencia": "inferido de slot:esencia + slot:errores"
    }
  ],
  "relacionesNuevas": [
    {"origen": "c_X", "destino": "c_Y", "tipo": "complementa|requiere|...", "descripcion": "..."}
  ],
  "contradicciones": [
    {"descripcion": "tension entre X e Y", "impacto": "alto|medio|bajo", "sugerencia": "cómo el experto podría resolverla"}
  ],
  "resumenPotenciacion": "frase que describe qué se fortaleció y qué quedó pendiente de aprobar"
}

PATRIMONIO ORIGINAL (única fuente):
KNOWLEDGE_GRAPH_PLACEHOLDER

Responde SOLO JSON válido.`;

function buildPotenciacionPrompt(knowledgeGraph) {
  const kgSummary = {
    conceptos: knowledgeGraph.conceptos.map(c => ({
      id: c.id, tipo: c.tipo, descripcion: c.descripcion,
      confianza: c.confianza, procedencia: c.procedencia,
    })),
    relaciones: knowledgeGraph.relaciones,
    experienciaTacita: knowledgeGraph.experienciaTacita,
    principiosYCriterios: knowledgeGraph.principiosYCriterios,
    incertidumbres: knowledgeGraph.incertidumbres,
  };
  return POTENCIACION_SYSTEM.replace('KNOWLEDGE_GRAPH_PLACEHOLDER', JSON.stringify(kgSummary, null, 2));
}

// ── PotenciacionIntelligence ───────────────────────────────────────────────────

class PotenciacionIntelligence {
  /**
   * @param {LLMService} llmService
   */
  constructor(llmService) {
    if (!llmService || typeof llmService.call !== 'function')
      throw new Error('PotenciacionIntelligence: llmService debe implementar { call }');
    this._llm = llmService;
  }

  /**
   * Potencia el KnowledgeGraph produciendo propuestas trazables.
   * No modifica el KG original.
   *
   * @param {KnowledgeGraph} knowledgeGraph — original producido por ComprensionIntelligence
   * @param {object}         state          — CognitiveState (para sesionId)
   * @param {number}         maxTokens
   * @returns {Promise<{ enhancedKnowledge: EnhancedKnowledge|null, errores: string[] }>}
   */
  async potenciar(knowledgeGraph, state, maxTokens = 2500) {
    if (!knowledgeGraph || !knowledgeGraph.id)
      return { enhancedKnowledge: null, errores: ['KnowledgeGraph es requerido'] };

    const systemPrompt = buildPotenciacionPrompt(knowledgeGraph);
    const r = await this._llm.call({
      system:    systemPrompt,
      userMsg:   'Detecta vacíos, propone enriquecimientos y contrasta contradicciones ahora.',
      label:     'potenciacion',
      maxTokens,
    });

    if (!r.parsed) {
      return { enhancedKnowledge: null, errores: ['LLMService no devolvió JSON válido'] };
    }

    // Aplicar AuthorityPolicy: propuestas con origen 'propuesta_externa' tienen peso 2 (ia)
    // Propuestas 'inferida' tienen peso 1. El experto decide cuáles aceptar.
    const propuestasNormalizadas = (r.parsed.propuestas || []).map(p => ({
      ...p,
      // Forzar origen válido: si el modelo pone algo no válido, degradar a 'inferida'
      origen: ['original', 'inferida', 'propuesta_externa', 'aceptada', 'rechazada'].includes(p.origen)
        ? p.origen
        : 'inferida',
      // Forzar estado pendiente: las propuestas siempre nacen pendientes
      estado: 'pendiente',
    }));

    let ek;
    const errores = [];
    try {
      ek = createEnhancedKnowledge({
        id:                  `ek_${state.sesionId}`,
        sesionId:            state.sesionId,
        knowledgeGraphId:    knowledgeGraph.id,
        propuestas:          propuestasNormalizadas,
        conceptosNuevos:     r.parsed.conceptosNuevos    || [],
        relacionesNuevas:    r.parsed.relacionesNuevas   || [],
        vaciosDetectados:    r.parsed.vaciosDetectados   || [],
        contradicciones:     r.parsed.contradicciones    || [],
        status:              'pendiente',
        resumenPotenciacion: r.parsed.resumenPotenciacion || null,
      });
    } catch (e) {
      errores.push(`EnhancedKnowledge inválido: ${e.message}`);
      return { enhancedKnowledge: null, errores };
    }

    return { enhancedKnowledge: ek, errores };
  }

  /**
   * Acepta una propuesta específica del EnhancedKnowledge.
   * Produce un nuevo EnhancedKnowledge con la propuesta marcada 'aceptada'.
   * No muta el original.
   *
   * @param {EnhancedKnowledge} ek
   * @param {string}            propuestaId
   * @returns {EnhancedKnowledge}
   */
  accept(ek, propuestaId) {
    return this._updatePropuestaStatus(ek, propuestaId, 'aceptada', 'aceptada');
  }

  /**
   * Rechaza una propuesta específica.
   * Produce un nuevo EnhancedKnowledge con la propuesta marcada 'rechazada'.
   * La propuesta permanece en el historial (trazabilidad).
   *
   * @param {EnhancedKnowledge} ek
   * @param {string}            propuestaId
   * @returns {EnhancedKnowledge}
   */
  reject(ek, propuestaId) {
    return this._updatePropuestaStatus(ek, propuestaId, 'rechazada', 'rechazada');
  }

  /**
   * Aplica PromotionPolicy para determinar si el EnhancedKnowledge puede
   * promoverse al Estado canónico (asignarse a state.enhancedKnowledge).
   *
   * Gate de promoción: requiere al menos 1 propuesta en estado distinto a 'pendiente'
   * (el experto debe haber tomado al menos 1 decisión explícita).
   *
   * @param {EnhancedKnowledge} ek
   * @param {object}            state — CognitiveState para verificar consistencia
   * @returns {{ status, razon, detalles }}
   */
  promote(ek, state) {
    const { valid, errors } = validateEnhancedKnowledge(ek);
    if (!valid) {
      return { status: PROMOTION_STATUS.REJECTED, razon: `EnhancedKnowledge inválido: ${errors.join('; ')}`, detalles: errors };
    }

    // Gate explícito: si hay propuestas, al menos 1 debe tener decisión
    const hasPropuestas = ek.propuestas.length > 0;
    const hasDecision   = ek.propuestas.some(p => p.estado !== 'pendiente');
    if (hasPropuestas && !hasDecision) {
      return {
        status: PROMOTION_STATUS.REJECTED,
        razon:  'El experto debe aceptar o rechazar al menos 1 propuesta antes de promover',
        detalles: [`Propuestas pendientes: ${ek.propuestas.length}`],
      };
    }

    // Delegar al PromotionPolicy para verificar estado del CognitiveState
    const fakeGate = { outcome: 'approved', bloqueante: false, razon: 'EnhancedKnowledge válido', detalles: [] };
    return PromotionPolicy.evaluatePromotion('potenciacion', state, fakeGate);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _updatePropuestaStatus(ek, propuestaId, nuevoEstado, nuevoOrigen) {
    const idx = ek.propuestas.findIndex(p => p.id === propuestaId);
    if (idx === -1) throw new Error(`PotenciacionIntelligence: propuesta '${propuestaId}' no encontrada`);

    const propuestasActualizadas = ek.propuestas.map((p, i) =>
      i === idx ? { ...p, estado: nuevoEstado, origen: nuevoOrigen } : { ...p }
    );

    const todasDecididas  = propuestasActualizadas.every(p => p.estado !== 'pendiente');
    const algunaAceptada  = propuestasActualizadas.some(p => p.estado === 'aceptada');
    const newStatus = todasDecididas
      ? (algunaAceptada ? 'aceptado_parcial' : 'rechazado')
      : 'pendiente';

    return createEnhancedKnowledge({
      ...ek,
      propuestas:       propuestasActualizadas,
      conceptosNuevos:  [...ek.conceptosNuevos],
      relacionesNuevas: [...ek.relacionesNuevas],
      vaciosDetectados: [...ek.vaciosDetectados],
      contradicciones:  [...ek.contradicciones],
      status:           newStatus,
    });
  }
}

module.exports = { PotenciacionIntelligence, buildPotenciacionPrompt };
