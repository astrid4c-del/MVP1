'use strict';

/**
 * CONTEXTUAL INTELLIGENCE
 * Responsabilidad única: comprender el entorno donde el patrimonio será utilizado.
 * Integra: fuentes, mercado, freshness, riesgo de dominio, jurisdicción,
 *          contradicciones contextuales, incertidumbres, recomendaciones.
 *
 * NO modifica el patrimonio intelectual original.
 * NO realiza búsquedas web reales (las fuentes son inyectables).
 * Informa y recomienda. No decide por el experto.
 * Toda información externa se convierte en PROPUESTA con procedencia y autoridad.
 * PromotionPolicy decide cuándo el ContextModel puede ser canónico.
 *
 * Ref: Arquitectura Cognitiva (Doc 4) — Inteligencia Contextual;
 *      Implementation Specification EPIC 11; Gap Analysis tarea 4.3.
 *
 * Entradas inyectables (contextualInputs):
 *   {
 *     fuentesExternas: [{ url, titulo, resumen, fechaConsulta }],
 *     contextoMercado: { segmento, tamanoAudiencia, competidores, brecha },
 *     jurisdiccion:    string | null,
 *     riesgoRegulatorio: string | null,
 *     notas:           string | null,
 *   }
 * Esto permite tests deterministas sin llamadas de red y permite que en
 * producción se inyecten resultados de búsqueda web real (Fase 6+).
 */

const { createContextModel, validateContextModel,
        VALID_FRESHNESS_STATUS, VALID_MARKET_SEGMENTS } = require('../schemas/ContextModel');
const { AuthorityPolicy }                               = require('../policy/AuthorityPolicy');
const { PromotionPolicy, PROMOTION_STATUS }             = require('../policy/PromotionPolicy');

// ── Prompt del sistema ─────────────────────────────────────────────────────────

const CONTEXTUAL_SYSTEM = `Eres la Inteligencia Contextual de Círculo. Tu único trabajo: describir el entorno donde el patrimonio intelectual del experto será utilizado. No modificas el patrimonio. No decides por el experto.

LEYES:
1. Todo lo que afirmes sobre el entorno debe tener procedencia declarada (fuentes inyectadas, inferencia del dominio o del KG).
2. Nunca afirmes algo como canónico: tus salidas son PROPUESTAS que el experto o un gate de calidad debe confirmar.
3. Si no tienes información suficiente sobre un tema, decláralo como incertidumbre, no lo inventes.

TU ANÁLISIS cubre únicamente:
- MERCADO: ¿a quién más sirve este conocimiento? ¿hay demanda? ¿qué competidores existen? ¿cuál es la brecha?
- FRESHNESS: ¿qué tan vigente es este conocimiento? ¿ha cambiado el entorno recientemente?
- RIESGO DE DOMINIO: ¿qué nivel de rigor requiere este dominio (salud, finanzas, legal, educación general)?
- JURISDICCIÓN: ¿hay regulaciones específicas que afecten lo que el experto puede enseñar o cómo lo distribuye?
- CONTRADICCIONES CONTEXTUALES: ¿hay tensiones entre lo que dice el experto y el contexto externo?
- RECOMENDACIONES: qué ajustes de posicionamiento o presentación podrían mejorar el impacto, sin cambiar el contenido.

PATRIMONIO DEL EXPERTO (solo para entender el dominio):
KG_SUMMARY_PLACEHOLDER

INFORMACIÓN CONTEXTUAL INYECTADA (tu fuente principal):
CONTEXT_INPUTS_PLACEHOLDER

Responde SOLO JSON:
{
  "dominio_identificado": "descripción concisa del dominio del experto",
  "segmento_mercado": "b2c|b2b|b2b2c|educacion_formal|otro",
  "tamano_audiencia_estimado": null,
  "competidores_identificados": ["..."],
  "brecha_mercado": "qué necesidad no está cubierta",
  "freshness_status": "vigente|desactualizado|sin_verificar|obsoleto",
  "freshness_razon": "por qué asignas ese status de freshness",
  "riesgo_regulatorio": null,
  "riesgo_dominio": "bajo|medio|alto|critico",
  "jurisdiccion_relevante": null,
  "contradicciones_contextuales": [
    {"descripcion": "...", "impacto": "alto|medio|bajo", "procedencia": "fuente o inferencia"}
  ],
  "incertidumbres_contextuales": ["..."],
  "recomendaciones": ["recomendación de posicionamiento o presentación — sin modificar el contenido"],
  "alertas": ["algo que requiere atención urgente del experto"],
  "notas": null
}`;

function buildContextualPrompt(knowledgeGraph, enhancedKnowledge, contextualInputs) {
  const kgSummary = knowledgeGraph ? {
    dominio:          knowledgeGraph.sesionId,
    conceptosClave:   (knowledgeGraph.conceptos || []).slice(0, 5).map(c => c.descripcion),
    principios:       (knowledgeGraph.principiosYCriterios || []).slice(0, 3),
    experienciaTacita:(knowledgeGraph.experienciaTacita   || []).slice(0, 2),
    incertidumbres:   (knowledgeGraph.incertidumbres      || []).map(u => u.descripcion),
  } : '(sin KnowledgeGraph disponible)';

  const ekSummary = enhancedKnowledge ? {
    vaciosDetectados: enhancedKnowledge.vaciosDetectados || [],
    contradicciones:  (enhancedKnowledge.contradicciones || []).map(c => c.descripcion),
  } : '(sin EnhancedKnowledge disponible)';

  const inputsStr = contextualInputs
    ? JSON.stringify(contextualInputs, null, 2)
    : '(sin información contextual inyectada — usar solo inferencia del patrimonio)';

  return CONTEXTUAL_SYSTEM
    .replace('KG_SUMMARY_PLACEHOLDER', JSON.stringify({ kg: kgSummary, ek: ekSummary }, null, 2))
    .replace('CONTEXT_INPUTS_PLACEHOLDER', inputsStr);
}

// ── ContextualIntelligence ────────────────────────────────────────────────────

class ContextualIntelligence {
  /**
   * @param {LLMService} llmService
   */
  constructor(llmService) {
    if (!llmService || typeof llmService.call !== 'function')
      throw new Error('ContextualIntelligence: llmService debe implementar { call }');
    this._llm = llmService;
  }

  /**
   * Produce un ContextModel provisional a partir del patrimonio y entradas inyectables.
   *
   * @param {object} state             — CognitiveState
   * @param {object} knowledgeGraph    — KnowledgeGraph | null
   * @param {object} enhancedKnowledge — EnhancedKnowledge | null
   * @param {object} contextualInputs  — entradas inyectables (fuentes, mercado, etc.)
   * @param {number} maxTokens
   * @returns {Promise<{ contextModel: ContextModel|null, errores: string[] }>}
   */
  async analizar(state, knowledgeGraph, enhancedKnowledge, contextualInputs = null, maxTokens = 2000) {
    const systemPrompt = buildContextualPrompt(knowledgeGraph, enhancedKnowledge, contextualInputs);

    const r = await this._llm.call({
      system:    systemPrompt,
      userMsg:   'Analiza el contexto del dominio ahora.',
      label:     'contextual',
      maxTokens,
    });

    if (!r.parsed) {
      return { contextModel: null, errores: ['LLMService no devolvió JSON válido'] };
    }

    const raw = r.parsed;

    // Aplicar AuthorityPolicy: información contextual es 'evidencia_verificable' si viene
    // de fuentes inyectadas con procedencia, o 'inferido' si es solo inferencia del LLM.
    const tieneFuentesExternas = contextualInputs?.fuentesExternas?.length > 0;
    const riesgoDominioFinal   = this._validateRiesgoDominio(raw.riesgo_dominio, state);

    // Validar freshness_status
    const freshnessStatus = VALID_FRESHNESS_STATUS.includes(raw.freshness_status)
      ? raw.freshness_status
      : 'sin_verificar';

    // Validar segmento_mercado
    const segmentoMercado = VALID_MARKET_SEGMENTS.includes(raw.segmento_mercado)
      ? raw.segmento_mercado
      : null;

    // Construir alertas: unir alertas del LLM + alertas de contradicciones de alto impacto
    const alertasContrad = (raw.contradicciones_contextuales || [])
      .filter(c => c.impacto === 'alto')
      .map(c => `Contradicción contextual: ${c.descripcion}`);
    const alertas = [...(raw.alertas || []), ...alertasContrad];

    const fuentesConsultadas = tieneFuentesExternas
      ? contextualInputs.fuentesExternas.map(f => f.url || f.titulo || String(f))
      : [];

    let contextModel;
    const errores = [];
    try {
      contextModel = createContextModel({
        id:                          `ctx_${state.sesionId}`,
        dominio:                     raw.dominio_identificado || (knowledgeGraph?.sesionId ?? 'desconocido'),
        segmentoMercado,
        tamanoAudienciaEstimado:     raw.tamano_audiencia_estimado || null,
        competidoresIdentificados:   raw.competidores_identificados || [],
        brechaMercado:               raw.brecha_mercado || null,
        fuentesConsultadas,
        freshnessStatus,
        freshnessUltimaRevision:     new Date().toISOString(),
        freshnessRazon:              raw.freshness_razon || null,
        riesgoRegulatorio:           raw.riesgo_regulatorio || contextualInputs?.riesgoRegulatorio || null,
        riesgoDominio:               riesgoDominioFinal,
        jurisdiccionRelevante:       raw.jurisdiccion_relevante || contextualInputs?.jurisdiccion || null,
        contradiccionesContextuales: raw.contradicciones_contextuales || [],
        incertidumbresContextuales:  raw.incertidumbres_contextuales || [],
        recomendaciones:             raw.recomendaciones || [],
        autoridadFuentes:            tieneFuentesExternas ? 'evidencia_verificable' : 'inferido',
        alertas,
        notas:                       raw.notas || contextualInputs?.notas || null,
      });
    } catch (e) {
      errores.push(`ContextModel inválido: ${e.message}`);
      return { contextModel: null, errores };
    }

    return { contextModel, errores };
  }

  /**
   * Aplica PromotionPolicy para determinar si el ContextModel puede
   * ser canónico (asignarse a state.contexto).
   *
   * Gate: si hay fuentes externas inyectadas, el modelo se puede promover directamente.
   * Si es pura inferencia del LLM (sin fuentes), requiere confirmación explícita.
   *
   * @param {object} contextModel
   * @param {object} state
   * @param {boolean} confirmar — el experto confirmó explícitamente
   * @returns {{ status, razon, detalles }}
   */
  promote(contextModel, state, confirmar = false) {
    const { valid, errors } = validateContextModel(contextModel);
    if (!valid) {
      return { status: PROMOTION_STATUS.REJECTED, razon: `ContextModel inválido: ${errors.join('; ')}`, detalles: errors };
    }

    const tieneFuentes = contextModel.autoridadFuentes === "evidencia_verificable";
    if (!tieneFuentes && !confirmar) {
      return {
        status: PROMOTION_STATUS.REJECTED,
        razon:  'ContextModel basado en inferencia pura requiere confirmación explícita del experto (confirmar=true)',
        detalles: ['Sin fuentes externas inyectadas y sin confirmación'],
      };
    }

    const fakeGate = { outcome: 'approved', bloqueante: false, razon: 'ContextModel válido', detalles: [] };
    return PromotionPolicy.evaluatePromotion('contextual', state, fakeGate);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _validateRiesgoDominio(valorLLM, state) {
    const niveles = ['bajo', 'medio', 'alto', 'critico'];
    // Si el expertProfile tiene un riesgoDominio, respetarlo (autoridad del experto > IA)
    if (state.expertProfile?.riesgoDominio && niveles.includes(state.expertProfile.riesgoDominio)) {
      return state.expertProfile.riesgoDominio;
    }
    return niveles.includes(valorLLM) ? valorLLM : 'bajo';
  }
}

module.exports = { ContextualIntelligence, buildContextualPrompt };
