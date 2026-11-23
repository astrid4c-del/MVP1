'use strict';

/**
 * COMPRENSION INTELLIGENCE
 * Responsabilidad única: comprender profundamente el Patrimonio Intelectual.
 * Nunca transforma. Nunca organiza. Nunca investiga.
 * Produce: KnowledgeGraph provisional a partir de ExpertProfile + slots del Modelo Agora.
 *
 * Ref: Arquitectura Cognitiva (Doc 4) — Inteligencia de Comprensión;
 *      Implementation Specification EPIC 08; Gap Analysis tarea 4.1.
 *
 * Entrada: CognitiveState con expertProfile + slots llenos
 * Salida:  state.knowledgeGraph (KnowledgeGraph provisional)
 *
 * No llama a investigación externa (eso es PotenciacionIntelligence).
 * No enriquece el patrimonio (eso es PotenciacionIntelligence).
 */

const { createKnowledgeGraph, validateKnowledgeGraph,
        VALID_CONCEPT_TYPES, VALID_RELATION_TYPES }  = require('../schemas/KnowledgeGraph');
const { AuthorityPolicy }                            = require('../policy/AuthorityPolicy');
const { serializeSlots }                             = require('../schemas/AgoraSlots');

// ── Prompt del sistema ────────────────────────────────────────────────────────

const COMPRENSION_SYSTEM = `Eres la Inteligencia de Comprensión de Círculo. Tu única función es COMPRENDER el patrimonio intelectual del experto que se te presenta — nunca transformarlo, investigarlo ni enriquecerlo.

LEY DE COMPRENSIÓN: solo puedes afirmar lo que el experto dijo o mostró. Si algo no está en la memoria de Círculo, no lo incluyas. Preferible un grafo incompleto a uno con invenciones.

ESTRUCTURA que debes producir:

1. CONCEPTOS — cada pieza de conocimiento identificable:
   - tipo: uno de [${VALID_CONCEPT_TYPES.join(', ')}]
   - descripcion: qué es, en el idioma del experto (no académico)
   - confianza: "alta" (dijo explícitamente), "media" (inferido de contexto), "baja" (supuesto)
   - autoridad: "experto" (proviene del experto) | "inferido" (derivado del análisis)
   - procedencia: qué slot exacto lo originó (ej: "slot:conocimiento", "slot:esencia", "slot:errores")

2. RELACIONES — cómo se conectan los conceptos:
   - origen, destino: IDs de conceptos del grafo
   - tipo: uno de [${VALID_RELATION_TYPES.join(', ')}]
   - descripcion: por qué existe esta relación

3. EXPERIENCIA TÁCITA — lo que el experto ejecuta sin verbalizar:
   Lista de strings, extraídos principalmente de los slots "obvio", "errores", "esencia".

4. PRINCIPIOS Y CRITERIOS — las reglas propias de decisión del experto:
   Lista de strings, extraídos de "esencia", "secuencia", "voz".

5. INCERTIDUMBRES — zonas donde la evidencia es insuficiente o contradictoria:
   Cada incertidumbre: { descripcion, impacto: "alto"|"medio"|"bajo" }

REGLA DE PROCEDENCIA: todo concepto debe referenciar al menos un slot de Círculo.
REGLA DE HONESTIDAD COGNITIVA: si algo es incierto, ponlo en incertidumbres, no lo inventes.

MEMORIA DE CÍRCULO (única fuente):
SLOTS_PLACEHOLDER

PERFIL DEL EXPERTO:
PROFILE_PLACEHOLDER

Responde SOLO JSON válido:
{
  "conceptos": [
    {"id":"c_1","tipo":"...","descripcion":"...","confianza":"alta","autoridad":"experto","procedencia":"slot:conocimiento"}
  ],
  "relaciones": [
    {"origen":"c_1","destino":"c_2","tipo":"requiere","descripcion":"..."}
  ],
  "experiencia_tacita": ["..."],
  "principios_y_criterios": ["..."],
  "incertidumbres": [
    {"descripcion":"...","impacto":"medio"}
  ]
}`;

function buildComprensionPrompt(state) {
  const slotsStr   = serializeSlots(state.slots);
  const profileStr = state.expertProfile
    ? JSON.stringify({
        dominio:           state.expertProfile.dominio,
        subdominio:        state.expertProfile.subdominio,
        nivelExperiencia:  state.expertProfile.nivelExperiencia,
        riesgoDominio:     state.expertProfile.riesgoDominio,
        contextoProfesional: state.expertProfile.contextoProfesional,
      })
    : '(sin perfil explícito — derivar del patrimonio)';

  return COMPRENSION_SYSTEM
    .replace('SLOTS_PLACEHOLDER', slotsStr || '(slots vacíos)')
    .replace('PROFILE_PLACEHOLDER', profileStr);
}

// ── ComprensionIntelligence ───────────────────────────────────────────────────

class ComprensionIntelligence {
  /**
   * @param {LLMService} llmService
   */
  constructor(llmService) {
    if (!llmService || typeof llmService.call !== 'function')
      throw new Error('ComprensionIntelligence: llmService debe implementar { call }');
    this._llm = llmService;
  }

  /**
   * Comprende el patrimonio intelectual del experto y produce un KnowledgeGraph provisional.
   *
   * @param {object} state    — CognitiveState con slots llenos y opcionalmente expertProfile
   * @param {number} maxTokens
   * @returns {Promise<{ knowledgeGraph: KnowledgeGraph|null, errores: string[] }>}
   */
  async comprend(state, maxTokens = 3000) {
    const systemPrompt = buildComprensionPrompt(state);
    const r = await this._llm.call({
      system:    systemPrompt,
      userMsg:   'Comprende el patrimonio intelectual del experto ahora.',
      label:     'comprension',
      maxTokens,
    });

    if (!r.parsed) {
      return { knowledgeGraph: null, errores: ['LLMService no devolvió JSON válido'] };
    }

    // Aplicar AuthorityPolicy: verificar que conceptos con autoridad "experto"
    // tienen confianza adecuada (alta o media)
    const conceptosValidados = (r.parsed.conceptos || []).map(c => {
      if (c.autoridad === 'experto' && c.confianza === 'baja') {
        // Degradar autoridad: si la confianza es baja, no puede ser "experto" con certeza
        return { ...c, autoridad: 'inferido' };
      }
      return c;
    });

    // Construir el KnowledgeGraph — puede fallar si la estructura del modelo es inválida
    let kg;
    const errores = [];
    try {
      kg = createKnowledgeGraph({
        id:                   `kg_${state.sesionId}`,
        sesionId:             state.sesionId,
        expertoId:            state.expertoId || (state.expertProfile?.id ?? null),
        conceptos:            conceptosValidados,
        relaciones:           r.parsed.relaciones || [],
        experienciaTacita:    r.parsed.experiencia_tacita || [],
        principiosYCriterios: r.parsed.principios_y_criterios || [],
        incertidumbres:       r.parsed.incertidumbres || [],
        status:               'provisional',
        slotsFuente:          Object.keys(state.slots).filter(k => state.slots[k] !== null),
      });
    } catch (e) {
      errores.push(`KnowledgeGraph inválido: ${e.message}`);
      return { knowledgeGraph: null, errores };
    }

    return { knowledgeGraph: kg, errores };
  }

  /**
   * Promueve el KnowledgeGraph de provisional a validado.
   * Solo debe llamarse cuando el experto o un gate de calidad lo confirmen.
   *
   * @param {KnowledgeGraph} kg
   * @returns {KnowledgeGraph} nueva instancia con status 'validado'
   */
  promote(kg, motivacion = 'Gate de comprensión superado') {
    const { valid, errors } = validateKnowledgeGraph(kg);
    if (!valid) throw new Error(`ComprensionIntelligence.promote: KG inválido — ${errors.join('; ')}`);
    if (kg.status === 'validado') return kg; // idempotente

    return createKnowledgeGraph({
      ...kg,
      conceptos:            [...kg.conceptos],
      relaciones:           [...kg.relaciones],
      experienciaTacita:    [...kg.experienciaTacita],
      principiosYCriterios: [...kg.principiosYCriterios],
      incertidumbres:       [...kg.incertidumbres],
      slotsFuente:          [...kg.slotsFuente],
      status:               'validado',
      motivacionStatus:     motivacion,
      actualizadoEn:        new Date().toISOString(),
    });
  }
}

module.exports = { ComprensionIntelligence, buildComprensionPrompt };
