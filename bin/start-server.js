#!/usr/bin/env node
'use strict';

/**
 * BOOTSTRAP LOCAL — CognitivoApiServer
 * Ensambla el Motor Cognitivo con sus dependencias reales (SQLite, pipeline
 * completo) y lo deja escuchando en un puerto local.
 *
 * No hace ninguna llamada LLM durante el arranque: LLMService solo se invoca
 * cuando una sesión real llega a una etapa que lo requiere. Si en ese momento
 * falta ANTHROPIC_API_KEY, la llamada falla con un error explícito (ver
 * createAnthropicFetch) en vez de arrancar o de fallar en silencio.
 *
 * Uso: node bin/start-server.js
 *      (o vía "npm run start:server" desde la raíz del repo)
 *
 * Variables de entorno (todas opcionales, con valores seguros por defecto):
 *   CIRCULO_HOST             — host de escucha (default: 127.0.0.1)
 *   CIRCULO_PORT             — puerto de escucha (default: 3000)
 *   CIRCULO_DB_PATH          — ruta al archivo SQLite (default: <pkg>/.data/circulo.db)
 *   ANTHROPIC_API_KEY        — clave real de Anthropic (sin default: sin ella,
 *                              el servidor arranca pero las llamadas LLM reales fallan)
 *   CIRCULO_ANTHROPIC_API_URL— endpoint del LLM (default: el de LLMService/AnthropicProvider)
 *   GEMINI_API_KEY           — clave real de Google AI Studio, solo si CIRCULO_LLM_PROVIDER=gemini
 *   CIRCULO_LLM_PROVIDER     — "anthropic" (default) o "gemini". Cualquier valor que no
 *                              sea exactamente "gemini" se trata como "anthropic" — el
 *                              comportamiento actual queda intacto sin definir esta variable.
 *   CIRCULO_LLM_MODEL        — modelo del LLM (default: el del proveedor activo)
 *   CIRCULO_LLM_MODE         — si es exactamente "mock", usa un fetch determinístico
 *                              que nunca toca la red (ver MockAnthropicFetch.js).
 *                              Tiene PRECEDENCIA sobre CIRCULO_LLM_PROVIDER: con mock
 *                              activo, el proveedor real (Anthropic o Gemini) se ignora.
 *                              Cualquier otro valor (incluido no definirla) deja el
 *                              comportamiento normal intacto. No puede activarse con
 *                              NODE_ENV=production salvo que además se defina
 *                              CIRCULO_ALLOW_MOCK_IN_PRODUCTION=true.
 *   CIRCULO_PROGRESS_PROTOCOL_V2 — si es exactamente "true", InteraccionCognitivaWriter
 *                              usa el contrato del generador por estado del protocolo
 *                              de cierre (Incremento 3: EXPLORANDO/LISTO_PARA_SINTESIS/
 *                              ESPERANDO_CONFIRMACION) en vez del prompt legacy — ver
 *                              ProgresoConversacionalPolicy.js y AgoraPrompts.
 *                              buildGramaticaPromptV2. GatePolicy sigue siendo, en
 *                              ambos modos, la única autoridad real de avance de
 *                              gramática (Incremento 4 la reemplaza). Se resuelve UNA
 *                              vez aquí, al arrancar — ningún otro módulo (API HTTP,
 *                              bridge, cliente legacy) vuelve a leer esta variable.
 *                              Cualquier otro valor (incluido no definirla) deja el
 *                              comportamiento productivo actual intacto.
 *   CIRCULO_KNOWLEDGE_GRAPH_ENABLED — si es exactamente "true", InteraccionCognitivaWriter
 *                              construye el Grafo de Conocimiento vivo turno a
 *                              turno durante EXPLORANDO (Incremento 1, Contrato
 *                              Arquitectónico v1.0) en vez del merge de slots por
 *                              presencia — ver GrafoConocimientoPolicy.aplicarDelta
 *                              y GrafoProyeccion. Independiente de
 *                              CIRCULO_PROGRESS_PROTOCOL_V2 (gobiernan capas
 *                              distintas), pero SOLO tiene efecto junto con él:
 *                              activarla con CIRCULO_PROGRESS_PROTOCOL_V2 en su
 *                              valor por defecto (false) es un error de arranque
 *                              explícito (ver resolveConfig) — esa combinación
 *                              reintroduciría cierre por presencia de slots a
 *                              través de GatePolicy legacy, exactamente lo que
 *                              este incremento existe para eliminar. Cualquier
 *                              otro valor (incluido no definirla) deja el
 *                              comportamiento actual intacto.
 *
 *   CIRCULO_FIDELITY_FALLBACK_PROVIDER — "gemini" o "anthropic"; si se define, un
 *                              fallo del executor de Fidelity (transporte/provider,
 *                              nunca un rechazo semántico real) escala como máximo
 *                              una vez a este proveedor, sobre la MISMA tarea de
 *                              Fidelity ya congelada (mismo Contract, mismo draft
 *                              del Realizer, misma evidencia) — nunca reabre
 *                              Producer/Decision/Contract/Realizer. Contrato propio,
 *                              deliberadamente separado de CIRCULO_PRODUCER_FALLBACK_*.
 *                              Sin definir, Fidelity no tiene fallback (comportamiento
 *                              previo intacto).
 *   CIRCULO_FIDELITY_FALLBACK_MODEL — modelo del fallback de Fidelity (default: el
 *                              DEFAULT_MODEL del proveedor de fallback resuelto).
 *
 *   CIRCULO_REALIZER_FALLBACK_PROVIDER — "gemini" o "anthropic"; si se define, un
 *                              executor de Realizer que agota sus 2 intentos sobre
 *                              el MISMO Contract congelado sin lograr un veredicto
 *                              FIEL de Fidelity (REALIZER_CAPABILITY_EXHAUSTED_ON_
 *                              VALID_CONTRACT — nunca transporte, que ya se reintenta
 *                              dentro de esos mismos 2 intentos) escala como máximo
 *                              una vez a este proveedor, sobre el mismo Contract/acto
 *                              cognitivo — nunca reabre Producer/Decision/Contract.
 *                              Contrato propio, deliberadamente separado de
 *                              CIRCULO_PRODUCER_FALLBACK_* y de CIRCULO_FIDELITY_FALLBACK_*.
 *                              Sin definir, Realizer no tiene fallback (comportamiento
 *                              previo intacto).
 *   CIRCULO_REALIZER_FALLBACK_MODEL — modelo del fallback de Realizer (default: el
 *                              DEFAULT_MODEL del proveedor de fallback resuelto).
 *
 * Ref: NEXT_TASK.md — Validación Conversacional con Anthropic real — Gemini como
 *      segundo proveedor seleccionable.
 */

const fs   = require('fs');
const path = require('path');

const { CognitivoApiServer }         = require('../src/api/CognitivoApiServer');
const { CognitiveUnitOfWork }        = require('../src/persistence/CognitiveUnitOfWork');
const { EventBus }                   = require('../src/events/EventBus');
const { CognitiveStateService }      = require('../src/state/CognitiveStateService');
const { OrchestratorService }        = require('../src/orchestrator/OrchestratorService');
const { BudgetPolicy }                = require('../src/policy/BudgetPolicy');
const { LLMService }                  = require('../src/llm/LLMService');
const { ComprensionIntelligence }    = require('../src/agora/ComprensionIntelligence');
const { PotenciacionIntelligence }   = require('../src/agora/PotenciacionIntelligence');
const { ContextualIntelligence }     = require('../src/agora/ContextualIntelligence');
const { createAgoraExecutors }       = require('../src/agora/AgoraStages');
const { PipelineApplicationService } = require('../src/pipeline/PipelineApplicationService');
const { CognitiveSessionRegistry }   = require('../src/pipeline/CognitiveSessionRegistry');
const { InteraccionCognitivaWriter } = require('../src/pipeline/InteraccionCognitivaWriter');
const { PipelineDownstreamDispatcher } = require('../src/pipeline/PipelineDownstreamDispatcher');
const { createMockAnthropicFetch }   = require('../src/llm/MockAnthropicFetch');
const AnthropicProvider              = require('../src/llm/providers/AnthropicProvider');
const GeminiProvider                 = require('../src/llm/providers/GeminiProvider');
const { ProducerExecutionCoordinator } = require('../src/llm/ProducerExecutionCoordinator');

// ── Configuración ─────────────────────────────────────────────────────────────

function resolveConfig(env = process.env) {
  const llmModeRequested     = env.CIRCULO_LLM_MODE === 'mock';
  const isProduction         = env.NODE_ENV === 'production';
  const allowMockInProduction = env.CIRCULO_ALLOW_MOCK_IN_PRODUCTION === 'true';

  if (llmModeRequested && isProduction && !allowMockInProduction) {
    throw new Error(
      'CIRCULO_LLM_MODE=mock no puede activarse con NODE_ENV=production sin además definir ' +
      'CIRCULO_ALLOW_MOCK_IN_PRODUCTION=true. Esto evita activar el modo mock por accidente en producción.'
    );
  }

  const llmProvider = env.CIRCULO_LLM_PROVIDER === 'gemini' ? 'gemini' : 'anthropic';
  const producerFallbackProvider = env.CIRCULO_PRODUCER_FALLBACK_PROVIDER || undefined;
  if (producerFallbackProvider
    && !['gemini', 'anthropic'].includes(producerFallbackProvider)) {
    throw new Error(
      `CIRCULO_PRODUCER_FALLBACK_PROVIDER no soportado: ${producerFallbackProvider}. `
      + 'Los valores soportados actualmente son "gemini" y "anthropic".'
    );
  }
  // C007 — PRODUCER MULTI-EXECUTOR RECOVERY (human canary v10 T2). El pool
  // de executors del productor puede necesitar más de un fallback: un
  // ejecutor puede agotarse por PRODUCER_CAPABILITY_FAILURE y el siguiente
  // por PROVIDER_FAILURE genuino, en la misma tarea gobernada. En vez de una
  // variable por ordinal (FALLBACK2/FALLBACK3/...), una única variable
  // opcional con un plan en JSON — deliberadamente sin tocar .env.local: el
  // human canary la define solo en runtime cuando la necesita. Sin definir,
  // el pool queda exactamente en primary+fallback, comportamiento previo
  // intacto. Misma disciplina de "unknown provider -> fail fast" que ya
  // rige CIRCULO_PRODUCER_FALLBACK_PROVIDER, nunca un mapeo silencioso.
  let producerFallbackPlan = [];
  const producerFallbackPlanRaw = env.CIRCULO_PRODUCER_FALLBACK_PLAN || undefined;
  if (producerFallbackPlanRaw) {
    let parsedPlan;
    try {
      parsedPlan = JSON.parse(producerFallbackPlanRaw);
    } catch (err) {
      throw new Error(
        `CIRCULO_PRODUCER_FALLBACK_PLAN no es JSON válido: ${err.message}. `
        + 'Formato esperado: [{"provider":"gemini","model":"..."}, ...].'
      );
    }
    if (!Array.isArray(parsedPlan)) {
      throw new Error('CIRCULO_PRODUCER_FALLBACK_PLAN debe ser un array JSON de {provider, model}.');
    }
    producerFallbackPlan = parsedPlan.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || !entry.provider) {
        throw new Error(`CIRCULO_PRODUCER_FALLBACK_PLAN[${i}] debe incluir "provider".`);
      }
      if (!['gemini', 'anthropic'].includes(entry.provider)) {
        throw new Error(
          `CIRCULO_PRODUCER_FALLBACK_PLAN[${i}].provider no soportado: ${entry.provider}. `
          + 'Los valores soportados actualmente son "gemini" y "anthropic".'
        );
      }
      return { provider: entry.provider, model: entry.model || undefined };
    });
  }
  // C007 human canary v6 — FIDELITY_EXECUTOR_FAILURE != FIDELITY_VERDICT.
  // Configuración propia, deliberadamente separada de CIRCULO_PRODUCER_
  // FALLBACK_*: ese nombre pertenece al contrato del productor cognitivo,
  // nunca al de Fidelity — misma disciplina explícita de "unknown provider
  // -> fail fast" que ya rige el fallback del productor, sin mapeo silencioso.
  const fidelityFallbackProvider = env.CIRCULO_FIDELITY_FALLBACK_PROVIDER || undefined;
  if (fidelityFallbackProvider
    && !['gemini', 'anthropic'].includes(fidelityFallbackProvider)) {
    throw new Error(
      `CIRCULO_FIDELITY_FALLBACK_PROVIDER no soportado: ${fidelityFallbackProvider}. `
      + 'Los valores soportados actualmente son "gemini" y "anthropic".'
    );
  }
  // C007 — REALIZER EXECUTION RECOVERY. Su propia variable, deliberadamente
  // separada de CIRCULO_PRODUCER_FALLBACK_*/CIRCULO_FIDELITY_FALLBACK_*:
  // REALIZER_CAPABILITY_EXHAUSTED_ON_VALID_CONTRACT es una clase de fallo
  // distinta de ambas (transporta el MISMO Contract congelado, nunca
  // re-decide el WHAT) — misma disciplina de "unknown provider -> fail
  // fast", sin mapeo silencioso.
  const realizerFallbackProvider = env.CIRCULO_REALIZER_FALLBACK_PROVIDER || undefined;
  if (realizerFallbackProvider
    && !['gemini', 'anthropic'].includes(realizerFallbackProvider)) {
    throw new Error(
      `CIRCULO_REALIZER_FALLBACK_PROVIDER no soportado: ${realizerFallbackProvider}. `
      + 'Los valores soportados actualmente son "gemini" y "anthropic".'
    );
  }

  const protocolV2Enabled = env.CIRCULO_PROGRESS_PROTOCOL_V2 === 'true';
  const knowledgeGraphEnabled = env.CIRCULO_KNOWLEDGE_GRAPH_ENABLED === 'true';
  const movimientoConversacionalEnabled = env.CIRCULO_MOVIMIENTO_CONVERSACIONAL_ENABLED === 'true';
  // C007 CONVERSATIONAL ENGINE STABILIZATION -- DETERMINISTIC REPLAY CAPTURE
  // (Human Canary observability gap correction). Opt-in, off by default:
  // when false/unset, product behavior AND persistence are byte-for-byte
  // unchanged (see src/observability/ReplayFingerprints.js,
  // LLMService.js capture hook, InteraccionCognitivaWriter.js preState
  // capture). Observability only -- never read back to govern any decision.
  const deterministicReplayCaptureEnabled = env.CIRCULO_DETERMINISTIC_REPLAY_CAPTURE === 'true';

  // Matriz de flags aprobada (Incremento 1): KG=ON exige V2=ON. Bajo legacy,
  // GatePolicy seguiría leyendo state.slots — ahora una proyección del grafo
  // — con su chequeo de presencia sin cambios, reintroduciendo exactamente
  // el cierre-por-presencia que este incremento existe para eliminar.
  // Corregirlo exigiría tocar GatePolicy.evaluateGramatica, fuera de alcance
  // de un incremento vertical-mínimo — se rechaza explícito, no en silencio.
  if (knowledgeGraphEnabled && !protocolV2Enabled) {
    throw new Error(
      'CIRCULO_KNOWLEDGE_GRAPH_ENABLED=true requiere CIRCULO_PROGRESS_PROTOCOL_V2=true. ' +
      'La combinación inversa (grafo activo bajo cierre legacy) reintroduciría cierre por ' +
      'presencia de slots a través de GatePolicy — no soportada en este incremento.'
    );
  }

  // Motor de Movimientos Conversacionales (vertical slice — Project OS,
  // ADR-Motor-de-Movimientos-Conversacionales.md): MovimientoConversacionalPolicy
  // lee el grafo vivo directamente — sin él, no tiene qué leer. Misma
  // disciplina que KG/V2: se rechaza explícito en bootstrap, nunca en silencio.
  if (movimientoConversacionalEnabled && !knowledgeGraphEnabled) {
    throw new Error(
      'CIRCULO_MOVIMIENTO_CONVERSACIONAL_ENABLED=true requiere CIRCULO_KNOWLEDGE_GRAPH_ENABLED=true. ' +
      'La política decide el movimiento leyendo evidencia y reconocimiento del grafo vivo — sin el grafo activo no hay nada que leer.'
    );
  }

  return {
    host:      env.CIRCULO_HOST || '127.0.0.1',
    // Railway/Render/Fly inyectan PORT — CIRCULO_PORT sigue teniendo
    // prioridad si se define explícito, esto es solo un fallback (D-039).
    port:      Number(env.CIRCULO_PORT) || Number(env.PORT) || 3000,
    dbPath:    env.CIRCULO_DB_PATH || path.join(__dirname, '..', '.data', 'circulo.db'),
    apiKey:    env.ANTHROPIC_API_KEY || null,
    geminiApiKey: env.GEMINI_API_KEY || null,
    apiUrl:    env.CIRCULO_ANTHROPIC_API_URL || undefined,
    model:     env.CIRCULO_LLM_MODEL || undefined,
    producerFallbackProvider,
    producerFallbackModel: env.CIRCULO_PRODUCER_FALLBACK_MODEL || undefined,
    producerFallbackPlan,
    fidelityFallbackProvider,
    fidelityFallbackModel: env.CIRCULO_FIDELITY_FALLBACK_MODEL || undefined,
    realizerFallbackProvider,
    realizerFallbackModel: env.CIRCULO_REALIZER_FALLBACK_MODEL || undefined,
    llmMode:   llmModeRequested ? 'mock' : 'normal',
    llmProvider,
    protocolV2Enabled,
    knowledgeGraphEnabled,
    movimientoConversacionalEnabled,
    deterministicReplayCaptureEnabled,
  };
}

/**
 * Envuelve el fetch global para inyectar las credenciales de Anthropic.
 * No ejecuta ninguna llamada por sí mismo: solo se invoca cuando LLMService.call()
 * lo necesita. Si falta apiKey, rechaza con un error claro en vez de intentar
 * una llamada sin autenticar.
 */
function createAnthropicFetch(apiKey) {
  return function anthropicFetch(url, options) {
    if (!apiKey) {
      return Promise.reject(new Error(
        'ANTHROPIC_API_KEY no está configurada. Defínela como variable de entorno ' +
        'antes de ejecutar una sesión que necesite invocar al LLM real.'
      ));
    }
    return fetch(url, {
      ...options,
      headers: {
        ...(options && options.headers),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
  };
}

/**
 * Envuelve el fetch global para inyectar la credencial de Google AI Studio (Gemini).
 * Misma forma que createAnthropicFetch: no ejecuta ninguna llamada por sí mismo,
 * y si falta la clave, rechaza con un error claro sin tocar la red.
 */
function createGeminiFetch(apiKey) {
  return function geminiFetch(url, options) {
    if (!apiKey) {
      return Promise.reject(new Error(
        'GEMINI_API_KEY no está configurada. Defínela como variable de entorno ' +
        'antes de ejecutar una sesión que necesite invocar a Gemini real.'
      ));
    }
    return fetch(url, {
      ...options,
      headers: {
        ...(options && options.headers),
        'x-goog-api-key': apiKey,
      },
    });
  };
}

/**
 * Construye (sin levantar el puerto) el CognitivoApiServer con todas sus
 * dependencias reales. No realiza ninguna llamada LLM.
 *
 * Ciclo de vida de Sesión Cognitiva: OrchestratorService (con su `_log`
 * interno), BudgetPolicy y LLMService dejaron de ser singletons compartidos
 * por todo el proceso — ver CognitiveSessionRegistry.js para la motivación
 * completa (autopsia Smoke Test #2: `_log` de una sesión contaminaba la
 * evaluación HITL de la siguiente). Aquí solo se construyen las piezas
 * realmente compartibles entre sesiones (repositorios SQLite, EventBus,
 * CognitiveStateService, y la config de fetch/proveedor del LLM, que es
 * configuración de servidor, no estado de ejecución) y se arma un
 * `bundleFactory` que el registry usa para crear un bundle fresco por
 * sessionId la primera vez que esa sesión se toca.
 *
 * Incremento 4: CognitiveUnitOfWork es ahora el único dueño de la conexión
 * SQLite compartida — stateRepo/eventRepo/turnoRepo la reciben desde ahí en
 * vez de abrir cada uno la suya, para que InteraccionCognitivaWriter pueda
 * escribir Turno + Estado + Eventos en una sola transacción real.
 */
function buildServer(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const unitOfWork = new CognitiveUnitOfWork(config.dbPath);
  const stateRepo  = unitOfWork.stateRepo;
  const eventRepo  = unitOfWork.eventRepo;
  const bus        = new EventBus(eventRepo);
  const svc        = new CognitiveStateService(stateRepo, bus);

  // El modo mock tiene precedencia sobre CIRCULO_LLM_PROVIDER: con mock activo,
  // el proveedor real (Anthropic o Gemini) se ignora por completo.
  let fetchImpl, provider;
  if (config.llmMode === 'mock') {
    fetchImpl = createMockAnthropicFetch();
    provider  = AnthropicProvider; // el mock responde con la forma de Anthropic
  } else if (config.llmProvider === 'gemini') {
    fetchImpl = createGeminiFetch(config.geminiApiKey);
    provider  = GeminiProvider;
  } else {
    fetchImpl = createAnthropicFetch(config.apiKey);
    provider  = AnthropicProvider;
  }

  // Incremento 7d (corrección post-revisión): dispatcher ÚNICO y compartido
  // entre todas las Sesiones Cognitivas — a diferencia de orch/llm/budget
  // (por sesión, ver buildSessionBundle abajo), recuperarPendientes() barre
  // TODAS las sesiones con downstream pendiente/abandonado, así que no tiene
  // sentido que exista uno por sesión. Usa una fábrica hacia
  // sessionRegistry.get(sesionId).pipelineService porque cada sesión corre
  // su downstream con SU PROPIO pipelineService — sessionRegistry se asigna
  // más abajo; la fábrica solo se invoca en tiempo de despacho, nunca aquí,
  // así que la referencia diferida es segura.
  let sessionRegistry;
  const downstreamDispatcher = new PipelineDownstreamDispatcher({
    stateService: svc,
    eventBus: bus,
    outboxRepository: unitOfWork.outboxRepo,
    pipelineServiceFactory: (sesionId) => sessionRegistry.get(sesionId).pipelineService,
  });

  /**
   * Bundle de ejecución de UNA Sesión Cognitiva: su propio Orchestrator (y
   * por tanto su propio `_log`, aislado de cualquier otra sesión), su propio
   * BudgetPolicy, su propio LLMService (atribuye correctamente sus eventos
   * `llm.*` a ESTE sessionId, no a un valor fijo) y el PipelineApplicationService
   * que los conecta. CognitiveStateService (`svc`) se reutiliza: es correctamente
   * compartible porque toda su lectura/escritura pasa `sessionId` explícito
   * hacia SQLite.
   */
  function buildSessionBundle(sessionId) {
    const budget = new BudgetPolicy();
    const orch   = new OrchestratorService(bus, svc, budget);

    const llmConfig = {
      fetch:    fetchImpl,
      provider,
      eventBus: bus,
      sesionId: sessionId || 'sin-sesion',
      replayCaptureEnabled: config.deterministicReplayCaptureEnabled,
    };
    if (config.apiUrl) llmConfig.apiUrl = config.apiUrl;
    if (config.model)  llmConfig.model  = config.model;
    const llm = new LLMService(llmConfig);
    // Construcción local compartida (no un refactor de ProducerExecutionCoordinator
    // ni una migración de variables): misma forma para el fallback del
    // productor y el de Fidelity, cada uno con su propia configuración
    // explícita -- "unknown provider -> fail fast", nunca mapeo silencioso.
    function construirLlmFallback(fallbackProviderName, fallbackModel, etiquetaFalloVariable) {
      let fallbackProvider;
      let fallbackFetch;
      switch (fallbackProviderName) {
        case 'gemini':
          fallbackProvider = GeminiProvider;
          fallbackFetch = createGeminiFetch(config.geminiApiKey);
          break;
        case 'anthropic':
          fallbackProvider = AnthropicProvider;
          fallbackFetch = createAnthropicFetch(config.apiKey);
          break;
        default:
          throw new Error(`${etiquetaFalloVariable} no soportado: ${fallbackProviderName}`);
      }
      return new LLMService({
        fetch: fallbackFetch,
        provider: fallbackProvider,
        eventBus: bus,
        sesionId: sessionId || 'sin-sesion',
        model: fallbackModel || fallbackProvider.DEFAULT_MODEL,
        replayCaptureEnabled: config.deterministicReplayCaptureEnabled,
      });
    }
    let producerFallbackLlm = null;
    if (config.producerFallbackModel || config.producerFallbackProvider) {
      producerFallbackLlm = construirLlmFallback(
        config.producerFallbackProvider || config.llmProvider,
        config.producerFallbackModel,
        'Proveedor fallback del productor',
      );
    }
    // C007 — PRODUCER MULTI-EXECUTOR RECOVERY: additional executors beyond
    // primary+fallback, from CIRCULO_PRODUCER_FALLBACK_PLAN (see
    // resolveConfig). Deliberately scoped to the Producer's own coordinator
    // only — Fidelity/Realizer keep their existing primary+one-fallback
    // shape unchanged, per this increment's explicit boundary.
    const producerAdditionalExecutors = (config.producerFallbackPlan || []).map((entry, i) =>
      construirLlmFallback(entry.provider, entry.model, `CIRCULO_PRODUCER_FALLBACK_PLAN[${i}]`));
    const producerExecutionCoordinator = new ProducerExecutionCoordinator({
      primary: llm,
      fallback: producerFallbackLlm,
      additionalExecutors: producerAdditionalExecutors,
    });
    // C007 human canary v6 — coordinador propio de Fidelity, nunca comparte
    // identity/escalation state con el del productor (FIDELITY_EXECUTOR_
    // FAILURE != FIDELITY_VERDICT; SAME_FIDELITY_TASK + DIFFERENT_EXECUTOR
    // -> SAME_GOVERNANCE, nunca la tarea del productor).
    let fidelityFallbackLlm = null;
    if (config.fidelityFallbackModel || config.fidelityFallbackProvider) {
      fidelityFallbackLlm = construirLlmFallback(
        config.fidelityFallbackProvider || config.llmProvider,
        config.fidelityFallbackModel,
        'CIRCULO_FIDELITY_FALLBACK_PROVIDER',
      );
    }
    const fidelityExecutionCoordinator = new ProducerExecutionCoordinator({
      primary: llm,
      fallback: fidelityFallbackLlm,
    });
    // C007 — REALIZER EXECUTION RECOVERY — same pattern, own coordinator,
    // own fallback variable. REALIZER_CAPABILITY_EXHAUSTED_ON_VALID_CONTRACT
    // is neither a producer nor a Fidelity failure: same frozen Contract,
    // different executor, never a re-decided WHAT.
    let realizerFallbackLlm = null;
    if (config.realizerFallbackModel || config.realizerFallbackProvider) {
      realizerFallbackLlm = construirLlmFallback(
        config.realizerFallbackProvider || config.llmProvider,
        config.realizerFallbackModel,
        'CIRCULO_REALIZER_FALLBACK_PROVIDER',
      );
    }
    const realizerExecutionCoordinator = new ProducerExecutionCoordinator({
      primary: llm,
      fallback: realizerFallbackLlm,
    });

    const comprension   = new ComprensionIntelligence(llm);
    const potenciacion  = new PotenciacionIntelligence(llm);
    const contextual    = new ContextualIntelligence(llm);
    const agoraExecutor = createAgoraExecutors(llm).execute;

    const pipelineService = new PipelineApplicationService({
      stateService: svc,
      orchestrator: orch,
      comprension,
      potenciacion,
      contextual,
      agoraExecutor,
      llmService: llm,
    });

    // Incremento 4: /grammar-turn pasa a usar este writer en vez del camino
    // viejo (orch.executeStage vía PipelineApplicationService/AgoraStages).
    // unitOfWork es compartido (una sola conexión); llm es propio de esta
    // sesión, igual que el resto del bundle. downstreamDispatcher (arriba)
    // es el ÚNICO compartido entre todas las sesiones.
    const writer = new InteraccionCognitivaWriter({
      unitOfWork, llmService: llm, downstreamDispatcher,
      producerExecutionCoordinator,
      fidelityExecutionCoordinator,
      realizerExecutionCoordinator,
      protocolV2Enabled: config.protocolV2Enabled,
      knowledgeGraphEnabled: config.knowledgeGraphEnabled,
      movimientoConversacionalEnabled: config.movimientoConversacionalEnabled,
      deterministicReplayCaptureEnabled: config.deterministicReplayCaptureEnabled,
    });

    return { orchestrator: orch, budget, llmService: llm, pipelineService, writer };
  }

  sessionRegistry = new CognitiveSessionRegistry(buildSessionBundle);

  const server = new CognitivoApiServer({
    sessionRegistry,
    stateRepository: stateRepo,
    eventRepository: eventRepo,
    // Habilita GET /session/:id/turnos (Incremento 5) — el MISMO turnoRepo
    // que usa InteraccionCognitivaWriter, vía el CognitiveUnitOfWork
    // compartido: ninguna conexión SQLite nueva ni distinta.
    turnoRepository: unitOfWork.turnoRepo,
    port: config.port,
    // Habilita POST /grammar-turn (Task 1 — corrección del flujo conversacional).
    stateService: svc,
    // Habilita POST /trace (instrumentación de observabilidad end-to-end).
    eventBus: bus,
    // GET /health (diagnóstico del Alpha, D-038) — el modelo real puede ser
    // undefined (usa el default del proveedor); GeminiProvider/AnthropicProvider
    // exponen su DEFAULT_MODEL para ese caso.
    llmProvider: config.llmProvider,
    llmModel: config.model || provider.DEFAULT_MODEL,
  });

  return { server, stateRepo, eventRepo, svc, sessionRegistry, unitOfWork, downstreamDispatcher };
}

/** Cierra el servidor de forma ordenada. No llama a process.exit. */
function createShutdownHandler(server, { log = () => {} } = {}) {
  let shuttingDown = false;
  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[bootstrap] Señal ${signal} recibida. Cerrando CognitivoApiServer...`);
    await server.close();
    log('[bootstrap] Servidor cerrado correctamente.');
  };
}

// ── Arranque real (solo cuando se ejecuta este archivo directamente) ────────

if (require.main === module) {
  const config = resolveConfig();
  const { server, downstreamDispatcher } = buildServer(config);

  const shutdown = createShutdownHandler(server, { log: console.log });
  process.on('SIGINT',  () => shutdown('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));

  server.listen(config.port, config.host)
    .then(() => {
      console.log(`[bootstrap] CognitivoApiServer escuchando en http://${config.host}:${config.port}`);
      console.log(`[bootstrap] SQLite: ${config.dbPath}`);
      console.log(`[bootstrap] Protocolo de cierre: ${config.protocolV2Enabled ? 'V2 (ProgresoConversacionalPolicy es la única autoridad de cierre — GatePolicy.evaluateGramatica no se invoca)' : 'legacy (GatePolicy es la única autoridad, sin cambios)'}.`);
      console.log(`[bootstrap] Grafo de Conocimiento vivo: ${config.knowledgeGraphEnabled ? 'ACTIVO (EXPLORANDO gobernado por GrafoConocimientoPolicy/GrafoProyeccion — slots son una proyección del grafo, nunca un blanco de escritura directa)' : 'inactivo (comportamiento actual intacto)'}.`);
      console.log(`[bootstrap] Motor de Movimientos Conversacionales (vertical slice): ${config.movimientoConversacionalEnabled ? 'ACTIVO (el Realizador recibe movimiento/nivel decididos por MovimientoConversacionalPolicy, no por Capa 1)' : 'inactivo (comportamiento actual intacto)'}.`);
      console.log(`[bootstrap] Deterministic Replay Capture: ${config.deterministicReplayCaptureEnabled ? 'ACTIVO (observability-only -- preState + cada salida semántica externa parseada quedan en cognitive_events, replay_capture.*)' : 'inactivo (comportamiento actual intacto)'}.`);
      // Incremento 7d (corrección post-revisión): recupera al arrancar
      // cualquier solicitud downstream que haya quedado 'pending' o
      // 'claimed'-abandonada de una corrida anterior del proceso (crash,
      // reinicio) — el outbox es durable, así que sobrevive a que este
      // dispatcher no exista todavía cuando esa solicitud se creó.
      downstreamDispatcher.recuperarPendientes()
        .then(({ candidatos, recuperadas }) => {
          if (candidatos > 0) console.log(`[bootstrap] Downstream: ${recuperadas}/${candidatos} solicitud(es) pendiente(s) recuperada(s) al arrancar.`);
        })
        .catch((e) => console.error('[bootstrap] Error al recuperar solicitudes downstream pendientes:', e.message));
      if (config.llmMode === 'mock') {
        console.log('[bootstrap] *** CIRCULO_LLM_MODE=mock activo: NO se realizarán llamadas reales a Anthropic. ' +
          'Todas las respuestas del LLM son deterministas y locales (smoke test). ***');
      } else if (config.llmProvider === 'gemini') {
        console.log('[bootstrap] Proveedor: Gemini (Google AI Studio).');
        if (!config.geminiApiKey) {
          console.warn('[bootstrap] GEMINI_API_KEY no configurada: el servidor arrancó, ' +
            'pero cualquier llamada real a Gemini fallará con un error explícito hasta que se configure.');
        }
      } else {
        console.log('[bootstrap] Proveedor: Anthropic.');
        if (!config.apiKey) {
          console.warn('[bootstrap] ANTHROPIC_API_KEY no configurada: el servidor arrancó, ' +
            'pero cualquier llamada real al LLM fallará con un error explícito hasta que se configure.');
        }
      }
    })
    .catch((e) => {
      console.error('[bootstrap] No se pudo iniciar el servidor:', e.message);
      process.exit(1);
    });
}

module.exports = { resolveConfig, createAnthropicFetch, createGeminiFetch, buildServer, createShutdownHandler };
