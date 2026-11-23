'use strict';
/**
 * TRANSFORMATION INTELLIGENCE
 * Inteligencia de Transformación del Motor Cognitivo.
 * Responsabilidad: infer() — deriva Avatar y Promesa desde los 16 slots.
 * No genera contenido. Diseña transformación.
 * Ref: Arquitectura Cognitiva (Doc 4) — Inteligencia de Transformación; 3.2.
 *
 * P-02 RESUELTO: integra LLMService.callAuditor() + AuthorityPolicy dentro
 * del flujo de opciones mediante elegirOpcionValida().
 */

const { buildInferencePrompt, buildAuditorPrompt, buildOpcionesPrompt } = require('../agora/AgoraPrompts');
const { AuthorityPolicy } = require('../policy/AuthorityPolicy');
const { proyectarSlotsReconocidos } = require('../state/GrafoProyeccion');

class TransformationIntelligence {
  /**
   * @param {LLMService} llmService
   */
  constructor(llmService) {
    if (!llmService || typeof llmService.call !== 'function')
      throw new Error('TransformationIntelligence: llmService debe implementar { call, callAuditor }');
    this._llm = llmService;
  }

  /**
   * Deriva Avatar y Promesa desde los 16 slots del Estado Cognitivo.
   * Réplica de runMotorInferencia() de circulo_v0, con AuthorityPolicy integrada.
   *
   * Ciclo Cognitivo de Descubrimiento (ADR) — punto único donde el pipeline
   * downstream completo (Avatar→Promesa→Arquitectura→Evidencia→Forma→
   * Desarrollo→Blueprint deriva TODO de este primer paso) entra en contacto
   * con la memoria de la sesión. `state.slots` mezcla autoridad "experto" e
   * "inferido" sin distinción — correcto para la conversación EN CURSO,
   * pero nunca para algo que se presenta como definitivo. Con grafo vivo
   * realmente usado en esta sesión (conceptos.length > 0 — no basta con que
   * el campo exista: toda sesión lo tiene, vacío, incluso bajo legacy),
   * se sustituye por GrafoProyeccion.proyectarSlotsReconocidos — la
   * proyección restringida a "experto", la única fuente legítima de "lo ya
   * reconocido". Sesiones sin grafo (legacy) siguen leyendo state.slots
   * exactamente igual que siempre.
   *
   * @param {object} state — CognitiveState con slots llenos
   * @param {number} maxTokens
   * @returns {Promise<{ avatarInferido, promesaInferida, preguntaPendiente, mensajeUsuario }>}
   */
  async infer(state, maxTokens = 1200) {
    const grafoUsado = state.knowledgeGraph && Array.isArray(state.knowledgeGraph.conceptos) && state.knowledgeGraph.conceptos.length > 0;
    const estadoParaPrompt = grafoUsado
      ? { ...state, slots: proyectarSlotsReconocidos(state.knowledgeGraph) }
      : state;
    const systemPrompt = buildInferencePrompt(estadoParaPrompt);
    const r = await this._llm.call({
      system:    systemPrompt,
      userMsg:   'Genera el Avatar y la Promesa ahora, siguiendo la estructura JSON indicada.',
      label:     'inferencia',
      maxTokens,
    });

    if (!r.parsed) return { avatarInferido: {}, promesaInferida: null, preguntaPendiente: null, mensajeUsuario: null };

    // Aplicar AuthorityPolicy: filtrar campos sin anclaje real
    const raw = r.parsed.avatar || {};
    const { camposValidos: avatarInferido } = AuthorityPolicy.evaluateAvatar(raw);

    const promesaRaw   = r.parsed.promesa || null;
    const promesaCheck = AuthorityPolicy.evaluatePromesa(promesaRaw);
    const promesaInferida = promesaCheck.valid ? promesaRaw : null;

    return {
      avatarInferido,
      promesaInferida,
      preguntaPendiente: r.parsed.pregunta_pendiente || null,
      mensajeUsuario:    r.parsed.mensaje_usuario || null,
    };
  }

  /**
   * Genera opciones de Avatar y Promesa para presentar al experto (HITL).
   * @param {{ avatarInferido, promesaInferida }} inferred
   * @param {number} maxTokens
   */
  async generateOptions(inferred, maxTokens = 1500) {
    const systemPrompt = buildOpcionesPrompt({
      avatarInferido:  inferred.avatarInferido,
      promesaInferida: inferred.promesaInferida,
    });
    const r = await this._llm.call({
      system:    systemPrompt,
      userMsg:   'Genera las opciones ahora.',
      label:     'opciones',
      maxTokens,
    });
    return r.parsed;
  }

  /**
   * P-02: Audita la fidelidad factual de una opción de Avatar o Promesa.
   * Integra LLMService.callAuditor() + AuthorityPolicy.
   * Réplica de validarFidelidad() + elegirOpcionValida() de circulo_e2e.
   *
   * @param {string} textoOpcion    — texto de la opción a auditar
   * @param {object} hechosPermitidos — { avatar, promesa } — hechos verificados
   * @returns {Promise<{ ok: boolean, motivo: string }>}
   */
  async auditFidelity(textoOpcion, hechosPermitidos) {
    const prompt = buildAuditorPrompt({ texto: textoOpcion, hechosPermitidos });
    let audit;
    try {
      audit = await this._llm.callAuditor(prompt);
    } catch {
      audit = null;
    }
    // Degradación segura: si el auditor falla, no aprobamos automáticamente
    if (!audit || typeof audit.valida === 'undefined' || !Array.isArray(audit.afirmaciones_no_cubiertas)) {
      return { ok: false, motivo: 'auditor sin veredicto válido (degradación segura: no se aprueba)' };
    }
    if (audit.afirmaciones_no_cubiertas.length > 0) {
      const primera = audit.afirmaciones_no_cubiertas[0];
      return { ok: false, motivo: `afirmación no anclada: "${primera.afirmacion || '?'}" (${primera.tipo || '?'})` };
    }
    return { ok: true, motivo: 'fidelidad verificada' };
  }

  /**
   * Elige la primera opción válida según fidelidad factual.
   * Réplica exacta de elegirOpcionValida() de circulo_e2e:
   *   - Ordena recomendada primero
   *   - Audita una a la vez
   *   - Sustituye por alternativa si la recomendada falla
   *   - Devuelve null si ninguna pasa
   *
   * @param {object[]} opciones       — array de { label, texto, ... }
   * @param {object}   hechosPermitidos
   * @param {string}   tipo           — 'avatar' | 'promesa' (para trazabilidad)
   * @returns {Promise<object|null>}
   */
  async elegirOpcionValida(opciones, hechosPermitidos, tipo) {
    if (!Array.isArray(opciones) || opciones.length === 0) return null;
    // Ordenar: recomendada primero
    const ordenadas = [...opciones].sort((a, b) =>
      (/recomendada/i.test(b.label) ? 1 : 0) - (/recomendada/i.test(a.label) ? 1 : 0)
    );
    for (const op of ordenadas) {
      const veredicto = await this.auditFidelity(op.texto || '', hechosPermitidos);
      if (veredicto.ok) return op;
      // si no pasa, continúa con la siguiente
    }
    return null;
  }
}

module.exports = { TransformationIntelligence };
