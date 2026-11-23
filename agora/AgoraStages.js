'use strict';
/**
 * AGORA STAGES
 * Executors de las etapas DOWNSTREAM del Modelo Agora (inferencia..blueprint)
 * para OrchestratorService. Cada executor recibe (state, etapa, maxTokens) y
 * muta el estado. No interpreta ni genera razonamiento propio.
 *
 * Incremento 8: gramaticaExecutor (DESTINO..DAR VIDA) fue retirado de este
 * archivo — auditoría de autoridad única. Esas 5 gramáticas ya no las
 * ejecuta OrchestratorService/AgoraStages en ningún camino vivo: desde el
 * Incremento 4, /grammar-turn usa exclusivamente InteraccionCognitivaWriter,
 * y ningún plan que construye OrchestratorService (buildPlan('inferencia'),
 * buildPartialPlan sobre _remainingAgoraStages) incluye jamás esas 5 etapas
 * — solo arrancan en 'inferencia' o después. Consumidor legítimo restante,
 * documentado explícitamente: el pipeline DOWNSTREAM (inferencia..blueprint),
 * vía PipelineApplicationService.runFromAgora() → OrchestratorService.run()
 * → executeStage() — disparado exclusivamente por PipelineDownstreamDispatcher
 * (Incremento 7d) tras el cierre cognitivo, nunca por el cliente.
 *
 * Ref: Arquitectura Cognitiva (Doc 4) — Modelo Agora; EPIC 12.
 * Tareas: 3.3 (opciones→blueprint), 3.4 (desarrollo), 3.5 (bonus), 3.6 (blueprint).
 */

const {
  buildArquitecturaPrompt, buildEvidenciaPrompt,
  buildFormaPrompt, buildTerritorio, buildDesarrolloPrompt, buildBonusPrompt,
} = require('./AgoraPrompts');
const { TransformationIntelligence } = require('./TransformationIntelligence');
const { GatePolicy }                 = require('../policy/GatePolicy');
const { HITLPolicy }                 = require('../policy/HITLPolicy');
const { serializeSlots }             = require('../schemas/AgoraSlots');

// ── EXECUTOR FACTORY ──────────────────────────────────────────────────────────

/**
 * Crea el objeto de executors del Modelo Agora para usar con OrchestratorService.
 * Cubre exclusivamente las etapas downstream (inferencia..blueprint) — ver
 * nota de cabecera sobre el retiro de gramaticaExecutor (Incremento 8).
 *
 * @param {LLMService}                   llmService
 * @param {object}                       [options]
 * @param {Function}                     [options.onMessage]  — cb(msg, etapa) para UI
 */
function createAgoraExecutors(llmService, options = {}) {
  const onMsg = options.onMessage || (() => {});
  const ti    = new TransformationIntelligence(llmService);

  // ── 3.2 Executor de inferencia ────────────────────────────────────────────────

  async function inferenciaExecutor(state, etapa, maxTokens) {
    const result = await ti.infer(state, maxTokens);

    state.avatarInferido  = result.avatarInferido;
    state.promesaInferida = result.promesaInferida;

    if (result.mensajeUsuario) onMsg(result.mensajeUsuario, 'inferencia');
  }

  // ── 3.3 Executor de opciones (con auditor P-02) ───────────────────────────────

  async function opcionesExecutor(state, etapa, maxTokens) {
    const opciones = await ti.generateOptions({
      avatarInferido:  state.avatarInferido,
      promesaInferida: state.promesaInferida,
    }, maxTokens);

    if (!opciones) return;

    const hechosPermitidos = { avatar: state.avatarInferido, promesa: state.promesaInferida };

    // P-02: elegirOpcionValida con auditor de fidelidad
    const avatarOps  = opciones.avatar_opciones  || [];
    const promesaOps = opciones.promesa_opciones || [];

    const avatarElegido  = await ti.elegirOpcionValida(avatarOps,  hechosPermitidos, 'avatar');
    const promesaElegida = await ti.elegirOpcionValida(promesaOps, hechosPermitidos, 'promesa');

    // HITL: registrar elecciones validadas en el estado
    if (avatarElegido)  HITLPolicy.recordChoice(state, 'opciones_avatar',  avatarElegido);
    if (promesaElegida) HITLPolicy.recordChoice(state, 'opciones_promesa', promesaElegida);

    if (opciones.mensaje_usuario) onMsg(opciones.mensaje_usuario, 'opciones');
  }

  // ── 3.3 Executor de arquitectura ──────────────────────────────────────────────

  async function arquitecturaExecutor(state, etapa, maxTokens) {
    const systemPrompt = buildArquitecturaPrompt({
      slots:        serializeSlots(state.slots),
      avatarElegido:  state.avatarElegido,
      promesaElegida: state.promesaElegida,
    });
    const r = await llmService.call({
      system:    systemPrompt,
      userMsg:   'Genera las arquitecturas candidatas ahora.',
      label:     'arquitectura',
      maxTokens: maxTokens || 4000,
    });

    if (!r.parsed) return;

    // Aplicar GatePolicy: filtrar candidatas que no pasan el gate
    const candidatasBrutas = (r.parsed.arquitecturas || []);
    const gateResults = GatePolicy.evaluateArquitectura(candidatasBrutas, state);
    const candidatasValidas = candidatasBrutas.filter((_, i) =>
      gateResults[i] && gateResults[i].outcome !== 'rejected'
    );

    if (candidatasValidas.length === 0) return; // gate bloqueó todo → executor no muta state

    // Gate de bifurcación
    const bifurGate = GatePolicy.evaluateBifurcacion(candidatasValidas);
    const candidatasFinales = bifurGate.outcome === 'rejected' && candidatasValidas.length > 1
      ? [candidatasValidas[0]] // colapsar a la recomendada
      : candidatasValidas;

    // HITL: si hay 1 sola, confirmar automáticamente; si hay 2, dejar pending
    const arquitectura = candidatasFinales[0];
    if (candidatasFinales.length === 1) {
      HITLPolicy.recordChoice(state, 'arquitectura', arquitectura);
    }
    // Con 2, el HITL queda pending — el OrchestratorService detectará HITL_PAUSED

    state.arquitecturaElegida = arquitectura;
    if (r.parsed.mensaje_usuario) onMsg(r.parsed.mensaje_usuario, 'arquitectura');
  }

  // ── 3.3 Executor de evidencia ─────────────────────────────────────────────────

  async function evidenciaExecutor(state, etapa, maxTokens) {
    const arch  = state.arquitecturaElegida;
    const systemPrompt = buildEvidenciaPrompt({
      modulos: arch.modulos,
      slots:   serializeSlots(state.slots),
    });
    const r = await llmService.call({
      system:    systemPrompt,
      userMsg:   'Define la evidencia de cada módulo ahora.',
      label:     'evidencia',
      maxTokens: maxTokens || 2000,
    });

    if (!r.parsed) return;

    const evidencias = (r.parsed.evidencias || []).filter(
      ev => ev && ev.modulo && ev.evidencia && ev.anclaje
    );
    if (evidencias.length === 0) return;

    state.evidenciasModulos = evidencias;
    if (r.parsed.mensaje_usuario) onMsg(r.parsed.mensaje_usuario, 'evidencia');
  }

  // ── 3.3 Executor de forma ────────────────────────────────────────────────────

  async function formaExecutor(state, etapa, maxTokens) {
    const arch = state.arquitecturaElegida;
    const systemPrompt = buildFormaPrompt({
      avatarElegido:  state.avatarElegido,
      promesaElegida: state.promesaElegida,
      modulos:        arch ? arch.modulos : [],
      evidencias:     state.evidenciasModulos || [],
      slots:          serializeSlots(state.slots),
    });
    const r = await llmService.call({
      system:    systemPrompt,
      userMsg:   'Ensambla la forma del producto y los dos activos ahora.',
      label:     'forma',
      maxTokens: maxTokens || 4000,
    });

    if (!r.parsed || !r.parsed.producto_estructura || !r.parsed.blueprint_privado) return;

    state.formaProducto = {
      producto_estructura: r.parsed.producto_estructura,
      blueprint_privado:   r.parsed.blueprint_privado,
      forma_recomendada:   r.parsed.forma_recomendada || null,
      forma_alternativa:   r.parsed.forma_alternativa || null,
    };
    if (r.parsed.mensaje_usuario) onMsg(r.parsed.mensaje_usuario, 'forma');
  }

  // ── 3.4 Executor de desarrollo con territorio longitudinal ────────────────────

  async function desarrolloExecutor(state, etapa, maxTokens) {
    const modulos   = state.formaProducto?.producto_estructura?.modulos || [];
    const evidencias = state.evidenciasModulos || [];
    const resultados = [];

    for (let i = 0; i < modulos.length; i++) {
      const m  = modulos[i];
      const ev = evidencias[i] || evidencias.find(e => e.modulo === m.titulo) || { evidencia: m.que_contiene || '' };

      // Territorio longitudinal (corrección 1 del E2E)
      const territorio = buildTerritorio(modulos, evidencias, i);

      const tokensModulo = i === modulos.length - 1 ? 2600 : (maxTokens || 1500);

      const r = await llmService.call({
        system:    buildDesarrolloPrompt({
          modulo:        m,
          evidencia:     ev.evidencia || '',
          avatarElegido: state.avatarElegido,
          promesaElegida:state.promesaElegida,
          voz:           state.slots?.voz || '',
          territorio,
        }),
        userMsg:   'Desarrolla este módulo ahora.',
        label:     `desarrollo_${i}`,
        maxTokens: tokensModulo,
      });

      if (r.parsed && (r.parsed.experiencias || r.parsed.contenido)) {
        resultados.push(r.parsed);
      } else {
        resultados.push(null); // módulo sin desarrollo — el gate de desarrollo_completo lo detectará
      }
    }

    state.desarrolloResultados = resultados;
  }

  // ── 3.5 Executor de bonus (opcional) ─────────────────────────────────────────

  async function bonusExecutor(state, etapa, maxTokens) {
    const avatar   = state.avatarElegido;
    const friccion = avatar?.porque || avatar?.texto || '';

    const systemPrompt = buildBonusPrompt({
      avatarElegido:  avatar,
      promesaElegida: state.promesaElegida,
      friccion,
      evidencias:     state.evidenciasModulos || [],
      voz:            state.slots?.voz || '',
    });
    const r = await llmService.call({
      system:    systemPrompt,
      userMsg:   'Propón el bonus ahora.',
      label:     'bonus',
      maxTokens: maxTokens || 1000,
    });

    if (r.parsed && r.parsed.bonus_recomendado) {
      state.bonus = {
        bonus_recomendado: r.parsed.bonus_recomendado,
        bonus_alternativo: r.parsed.bonus_alternativo || null,
      };
      if (r.parsed.mensaje_usuario) onMsg(r.parsed.mensaje_usuario, 'bonus');
    }
  }

  // ── 3.6 Executor de blueprint final ──────────────────────────────────────────

  async function blueprintExecutor(state, etapa, maxTokens) {
    // El blueprint ya está en state.formaProducto.blueprint_privado
    // Esta etapa consolida y produce los 2 activos finales (ProductoEstructura + BlueprintPrivado).
    // No llama al LLM — los activos ya están en el estado; solo los promueve al campo arquitectura.
    const forma = state.formaProducto;
    if (!forma) return;

    // Consolidar en TransformationArchitecture si existe
    if (!state.arquitectura) {
      state.arquitectura = {
        id:              `ta_${state.sesionId}`,
        sesionId:        state.sesionId,
        avatarElegido:   state.avatarElegido,
        promesaElegida:  state.promesaElegida,
        modulos:         state.arquitecturaElegida?.modulos || [],
        evidenciasModulos: state.evidenciasModulos || [],
        formaProducto:   forma,
        desarrolloModulos: state.desarrolloResultados || [],
        bonus:           state.bonus || null,
        etapaAlcanzada:  'blueprint',
        materialesPendientes: (state.desarrolloResultados || [])
          .flatMap(r => (r && r.materiales_pendientes) ? r.materiales_pendientes : []),
      };
    }

    onMsg('Aquí está. Es tuyo.', 'blueprint');
  }

  // ── Dispatcher principal ──────────────────────────────────────────────────────

  /**
   * Executor universal que despacha según la etapa. Cubre exclusivamente el
   * downstream (inferencia..blueprint) — las 5 gramáticas ya no pasan por
   * aquí (ver nota de cabecera, Incremento 8).
   * Uso: orch.run(state, agoraExecutors.execute)
   */
  async function execute(state, etapa, maxTokens) {
    switch (etapa) {
      case 'inferencia':     return inferenciaExecutor(state, etapa, maxTokens);
      case 'opciones':       return opcionesExecutor(state, etapa, maxTokens);
      case 'arquitectura':   return arquitecturaExecutor(state, etapa, maxTokens);
      case 'evidencia':      return evidenciaExecutor(state, etapa, maxTokens);
      case 'forma':          return formaExecutor(state, etapa, maxTokens);
      case 'desarrollo':     return desarrolloExecutor(state, etapa, maxTokens);
      case 'bonus':          return bonusExecutor(state, etapa, maxTokens);
      case 'blueprint':      return blueprintExecutor(state, etapa, maxTokens);
      default:               return; // etapa no reconocida — no hace nada
    }
  }

  return {
    execute,
    // Exportar executors individuales para tests unitarios
    inferenciaExecutor,
    opcionesExecutor,
    arquitecturaExecutor,
    evidenciaExecutor,
    formaExecutor,
    desarrolloExecutor,
    bonusExecutor,
    blueprintExecutor,
    // Acceso a la inteligencia de transformación
    transformationIntelligence: ti,
  };
}

module.exports = { createAgoraExecutors };
