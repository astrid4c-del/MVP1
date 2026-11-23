'use strict';

/**
 * LLM SERVICE
 * Único punto de acceso a modelos de lenguaje para todo el sistema.
 * Formaliza y extrae callAPI() del harness E2E (circulo_e2e.html).
 *
 * PRESERVACIÓN COMPLETA de la lógica del E2E:
 *   - Validación pre-vuelo del prompt (validarPrompt → preflightCheck)
 *   - Observabilidad: httpStatus, httpOk, responseBody, apiErrorType,
 *     apiErrorMessage, stopReason, usage, clasificacion
 *   - Clasificación de respuesta (clasificarRespuesta → classifyResponse)
 *   - Distinción entre: JSON válido / truncado / anómalo / HTTP error
 *   - Reintentos configurables (no hardcoded a 2)
 *   - respuestaCruda=null cuando respuesta anómala (no string vacío)
 *
 * Ref: Gap Analysis D-03 (unificar callAI + callAPI → LLMService);
 *      Implementation Specification EPIC 06 (BudgetPolicy integrado);
 *      test_observabilidad.js (5 escenarios validados en Sprint 1).
 *
 * SIMULABLE: el fetch real se inyecta en el constructor. En tests se
 * pasa un fetchMock. En producción se pasa el fetch global del navegador
 * o node-fetch.
 *
 * PROVEEDOR INTERCAMBIABLE: la construcción del request y el parseo de la
 * respuesta se delegan a config.provider (ver src/llm/providers/). Por
 * defecto usa AnthropicProvider, preservando exactamente el comportamiento
 * anterior a la introducción de esta indirección. El resto de esta clase
 * (reintentos, preflight, parseo del JSON embebido, observabilidad,
 * BudgetPolicy) es común a cualquier proveedor y no se duplica.
 */

const { createEvent }        = require('../schemas/Event');
const AnthropicProvider       = require('./providers/AnthropicProvider');
const { ERROR_CATEGORIES }    = require('./LLMErrorTaxonomy');
const { resolveProfile, resolveOutputBudget } = require('./CallProfiles');
// C007 CONVERSATIONAL ENGINE STABILIZATION -- DETERMINISTIC REPLAY CAPTURE
// (Human Canary observability gap correction, opt-in). Same identity
// functions the C007 test replay harness uses -- single source, see
// src/observability/ReplayFingerprints.js's own docstring.
const { sha256Hex, computeSchemaFingerprint, computeEngineBuildFingerprint } = require('../observability/ReplayFingerprints');

// ── Marcadores de prompt corrupto (migrados del validarPrompt del E2E) ────────

const PROMPT_CORRUPTION_MARKERS = Object.freeze([
  'SLOTS_PLACEHOLDER', 'AVATAR_PLACEHOLDER', 'PROMESA_PLACEHOLDER',
  'MODULOS_PLACEHOLDER', 'EVIDENCIAS_PLACEHOLDER', 'MODULO_PH',
  'EVIDENCIA_PH', 'AVATAR_PH', 'PROMESA_PH', 'VOZ_PH',
  'AV', 'PR', 'FR', 'EV', 'VZ',  // placeholders de BONUS_IDENTITY
]);

// ── Clasificación de respuesta (migrada de clasificarRespuesta del E2E) ───────

function classifyResponse(txt, clean) {
  if (!txt || !txt.trim()) return 'vacía';
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a < 0) return 'sin JSON (texto libre)';
  const desbalance = (txt.match(/\{/g)||[]).length !== (txt.match(/\}/g)||[]).length;
  const teniaFences = /```/.test(txt);
  const teniaTextoAlrededor = (a > 0) || (b < clean.length - 1);
  if (a >= 0 && b <= a) return 'JSON truncado (sin cierre)' + (teniaFences ? ' (en fences)' : '');
  if (a >= 0 && b > a) {
    try {
      JSON.parse(clean.slice(a, b + 1));
      return 'JSON válido' + (teniaFences ? ' (en fences)' : '') + (teniaTextoAlrededor ? ' (con texto alrededor)' : '');
    } catch {
      return (desbalance ? 'JSON truncado/incompleto' : 'JSON sintácticamente inválido') + (teniaFences ? ' (en fences)' : '');
    }
  }
  return 'estructura no reconocida';
}

// ── Resultado de una llamada LLM ──────────────────────────────────────────────

function llmAttempt(intento) { return Object.freeze({ ...intento }); }

// ── LLMService ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_MAX_RETRIES = 2;

// DETERMINISTIC REPLAY CAPTURE (OBSERVABILITY_O1 correction) -- process-
// lifetime, shared across every LLMService instance, keyed by turnoId
// (never by executor/instance). See LLMService constructor docstring for
// the full rationale and LLMService.clearReplayCaptureContext for cleanup.
const _captureContextByTurnoId = new Map();

class LLMService {
  /**
   * @param {object}   config
   * @param {Function} config.fetch        — fetch implementation (inyectable para tests)
   * @param {object}   [config.provider]   — adaptador { buildRequest, parseResponse, DEFAULT_MODEL, DEFAULT_API_URL }.
   *                                         Por defecto: AnthropicProvider (comportamiento sin cambios).
   * @param {string}   [config.apiUrl]     — sobrescribe la URL por defecto del proveedor
   * @param {string}   [config.model]
   * @param {object}   [config.eventBus]   — { emit(event) } para observabilidad
   * @param {string}   [config.sesionId]   — para correlacionar eventos
   */
  constructor(config = {}) {
    if (!config.fetch || typeof config.fetch !== 'function')
      throw new Error('LLMService: config.fetch es requerido (inyectar fetch real o mock)');

    this._fetch    = config.fetch;
    this._provider = config.provider || AnthropicProvider;
    this._apiUrl   = config.apiUrl  || null; // null = usar la URL por defecto del proveedor
    this._model    = config.model   || this._provider.DEFAULT_MODEL;
    this._eventBus = config.eventBus || null;
    this._sesionId = config.sesionId || 'llm';

    // Contadores de sesión (equivalen a callCount, httpRequests, reintentos del E2E)
    this._callCount      = 0;
    this._httpRequests   = 0;
    this._reintentos     = 0;
    this._abortedPreflight = 0;
    this._rawResults     = {};  // { label: { raw, parsed, intentos } }

    // DETERMINISTIC REPLAY CAPTURE (opt-in, off by default -- config.replayCaptureEnabled
    // is undefined/false for every existing caller that predates this
    // increment, so behavior/persistence stay byte-for-byte unchanged
    // unless a caller explicitly opts in).
    //
    // OBSERVABILITY_O1 correction (Human Canary A, post-bootstrap capture)
    // -- ordinal/occurrence were originally kept on `this` (per-INSTANCE),
    // silently resetting whenever ProducerExecutionCoordinator/fallback
    // escalation constructs a NEW LLMService for a different executor/
    // provider/model mid-turn (demonstrated: primary gemini-3.1-flash-lite
    // and fallback gemini-3.5-flash-lite each restarted their own ordinal
    // at 1 and each label's occurrence at 1, within the SAME real turn).
    // Per the corrected contract, ordinal/occurrence belong to the TURN
    // CAPTURE CONTEXT, never to whichever executor instance happens to
    // handle a given call -- `turnoId` is the one identity every executor
    // instance already receives identically for the same turn (primary and
    // fallback alike), so it is the correct, already-available key. A
    // process-lifetime Map keyed by turnoId (never by instance) is shared
    // across every LLMService instance in this process; entries are
    // reclaimed via clearReplayCaptureContext(turnoId), called by
    // InteraccionCognitivaWriter._capturarTerminalReplaySiCorresponde at
    // turn end, so this never grows unbounded across a long-running server.
    // Calls with no turnoId (turnoId=null -- e.g. the auditor, outside any
    // user turn) fall back to a private, per-instance context: there is no
    // turn to share across executors for those, and this preserves the
    // pre-correction behavior exactly for that case.
    this._replayCaptureEnabled = !!config.replayCaptureEnabled;
    this._capturePrivateContext = { ordinal: 0, occurrenceByLabel: {} };
  }

  /** DETERMINISTIC REPLAY CAPTURE (OBSERVABILITY_O1) -- see constructor docstring. */
  _obtenerContextoCaptura(turnoId) {
    if (!turnoId) return this._capturePrivateContext;
    let ctx = _captureContextByTurnoId.get(turnoId);
    if (!ctx) {
      ctx = { ordinal: 0, occurrenceByLabel: {} };
      _captureContextByTurnoId.set(turnoId, ctx);
    }
    return ctx;
  }

  // ── Validación pre-vuelo ────────────────────────────────────────────────────

  /**
   * Replica validarPrompt() del E2E.
   * Detecta placeholders no sustituidos en el prompt antes de gastar la llamada.
   */
  preflightCheck(systemPrompt, label) {
    const marcadores = PROMPT_CORRUPTION_MARKERS.filter(m =>
      systemPrompt && systemPrompt.includes(`"${m}"`)
    );
    return { ok: marcadores.length === 0, marcadores };
  }

  // ── Llamada principal ───────────────────────────────────────────────────────

  /**
   * Llama al LLM con observabilidad completa.
   * Replica callAPI() del E2E con las siguientes mejoras:
   *   - fetch inyectable
   *   - reintentos configurables
   *   - BudgetPolicy integrado (opcional)
   *   - eventos emitidos al bus
   *
   * @param {object}  params
   * @param {string}  params.system       — system prompt
   * @param {string}  params.userMsg      — mensaje del usuario
   * @param {string}  params.label        — etiqueta para auditoría (ej: 'inferencia')
   * @param {string}  [params.callProfile] — LLM_CALL_PROFILE_GOVERNANCE_1:
   *   nombre de un perfil de CallProfiles.js (p.ej. 'VEREDICTO_ESTRUCTURADO').
   *   Cuando se provee, gobierna el presupuesto de salida Y la política de
   *   thinking que cada Provider traduzca — el llamador nunca calcula
   *   maxTokens ni conoce thinkingConfig/modelos concretos (Test L). Un
   *   nombre desconocido lanza (nunca un fallback silencioso a
   *   DEFAULT_MAX_TOKENS). Mutuamente excluyente con `maxTokens`: si se
   *   provee `callProfile`, `maxTokens` se ignora — el camino sin perfil
   *   (los 11 call-sites legacy de AgoraStages/Intelligence, fuera de
   *   alcance de este incremento) sigue funcionando exactamente igual.
   * @param {number}  [params.itemCount]  — LLM_CALL_PROFILE_GOVERNANCE_1:
   *   tamaño del lote, solo relevante junto a un `callProfile` cuya
   *   escalaPorItem>0 (p.ej. adjudicación semántica por lote). Ignorado
   *   sin `callProfile`.
   * @param {number}  [params.maxTokens]  — tokens máximos (camino legacy,
   *   sin callProfile — ver arriba).
   * @param {number}  [params.maxRetries] — número de reintentos
   * @param {object}  [params.budgetPolicy] — BudgetPolicy para registrar uso
   * @param {string}  [params.responseMimeType] — MIME type for optional native
   *   structured output (forwarded to providers that support it).
   * @param {object}  [params.responseSchema] — optional native provider schema.
   * @param {string|null} [params.turnoId] — DURABILIDAD_ENTRADA_CONVERSACIONAL_1
   *   §6: identidad interna reservada en admisión, para correlacionar cada
   *   evento llm.* (called/attempt/succeeded/failed) con la intervención del
   *   usuario que los originó. `null` (default) preserva el comportamiento
   *   anterior — eventos técnicos sin vínculo (p.ej. el auditor, llamadas
   *   fuera del ciclo de un turno de usuario).
   * @returns {Promise<{ parsed: object|null, intentos: object[], aborted: boolean, errorCategory: (string|null) }>}
   *   errorCategory — DURABILIDAD_ENTRADA_CONVERSACIONAL_1 (corrección
   *   TERMINACION_CONOCIDA_SIN_TURNO): la categoría de LLMErrorTaxonomy del
   *   último intento cuando `parsed` es null (ya se calculaba para el evento
   *   `llm.failed`; ahora también se expone al llamador para que pueda
   *   marcar la terminación conocida con su causa real, en vez de un
   *   `null` genérico). `null` cuando `parsed` es un objeto (éxito) o
   *   cuando el preflight rechazó el prompt antes de cualquier intento.
   */
  /**
   * @param {number} [params.timeoutMs] — C007 human canary v9, FIDELITY_
   *   LATENCY_CONTAINMENT. Execution deadline for a SINGLE attempt's
   *   transport call, never a cognitive timeout. Undefined (default)
   *   reproduces every prior call site byte for byte — no caller pays for
   *   this unless it opts in explicitly (today: only Fidelity's own call
   *   site, via a named execution-policy constant, never Producer/Realizer/
   *   reconciliación). On expiry, THIS attempt aborts via AbortController
   *   and is classified errorCategory=PROVIDER_TIMEOUT (SLOW_EXECUTOR, not
   *   UNBOUNDED_USER_WAIT) — the retry loop then treats it exactly like any
   *   other transport failure it already knows how to escalate/retry.
   */
  /**
   * @param {object|'NONE'} [params.replaySchema] — DETERMINISTIC REPLAY
   *   CAPTURE, observability-only. NEVER forwarded to any provider request
   *   (see below -- only `responseSchema` reaches GeminiProvider's
   *   generationConfig; adding a schema there would enable native
   *   structured-output enforcement and genuinely change what the model
   *   produces, which this capture correction must never do). Lets a call
   *   site whose real, known contract schema exists but isn't threaded
   *   into `responseSchema` for the actual request (e.g. a legacy-mode
   *   call still validated by hand against CAPA1_COGNITIVE_RESPONSE_SCHEMA)
   *   still report the TRUE schema identity to replay capture. Pass the
   *   literal string 'NONE' for a call whose contract genuinely lives in
   *   prompt prose, never a JSON-schema object (e.g. realizador-
   *   conversacional) -- distinct from omitting this param, which never
   *   silently becomes a bare `null`: see _emitReplayCaptureExternalOutput.
   */
  async call({ system, userMsg, label, callProfile = null, itemCount = 0, maxTokens, maxRetries,
    budgetPolicy, responseMimeType, responseSchema, replaySchema, turnoId = null, timeoutMs = null } = {}) {
    // LLM_CALL_PROFILE_GOVERNANCE_1 — callProfile gobierna el presupuesto
    // de salida cuando se provee (nombre inválido lanza, ver
    // CallProfiles.resolveProfile — nunca un fallback silencioso);
    // maxTokens queda para el camino legacy sin perfil, sin cambios.
    const profile = callProfile ? resolveProfile(callProfile) : null;
    const tokens  = profile ? resolveOutputBudget(callProfile, { itemCount }) : (maxTokens || DEFAULT_MAX_TOKENS);
    const maxTries = maxRetries || DEFAULT_MAX_RETRIES;
    const providerName = this._provider.PROVIDER_NAME || null;

    // 1. Validación pre-vuelo
    const preflight = this.preflightCheck(system, label);
    if (!preflight.ok) {
      this._abortedPreflight++;
      const resultado = { raw: null, parsed: null, intentos: [], aborted: true, preflightFail: preflight.marcadores };
      this._rawResults[label] = resultado;
      this._emit('llm.failed', {
        label, razon: 'PROMPT_CORRUPTO', marcadores: preflight.marcadores,
        callProfile: callProfile || null, provider: providerName,
        modeloConfigurado: this._model, maxOutputEfectivo: tokens,
      }, turnoId);
      return { parsed: null, intentos: [], aborted: true };
    }

    this._callCount++;
    const intentos = [];
    let attempt = 0;

    while (attempt < maxTries) {
      const registro = {
        intento:       attempt + 1,
        promptEnviado: system,
        respuestaCruda: null,
        bloqueParseado: null,
        errorParseo:    null,
        clasificacion:  null,
        // GEMINI_PROVIDER_ESTABILIDAD_1 — clave de LLMErrorTaxonomy.ERROR_CATEGORIES,
        // o null mientras la llamada sigue en curso / si termina en éxito
        // pleno. Nunca inferido por heurística léxica sobre `clasificacion`
        // (texto libre para humanos) -- siempre delegado a
        // this._provider.classifyError o, cuando el proveedor no puede
        // saberlo (JSON inválido con llamada por lo demás exitosa), a
        // STRUCTURED_RESPONSE_INVALID aquí mismo.
        errorCategory:  null,
        parsed:         null,
        httpStatus:     null,
        httpOk:         null,
        responseBody:   null,
        apiErrorType:   null,
        apiErrorMessage:null,
        stopReason:     null,
        usage:          null,
        // LLM_CALL_PROFILE_GOVERNANCE_1 (Fase 8 — observabilidad): fijos
        // para todos los intentos de ESTA llamada (no dependen de la
        // respuesta), completados aquí para que estén presentes incluso
        // si el intento falla antes de llegar a parseResponse.
        callProfile:        callProfile || null,
        provider:           providerName,
        modeloConfigurado:  this._model,
        modeloEfectivo:     null, // completado tras parseResponse, si el provider lo reporta
        maxOutputEfectivo:  tokens,
        thinkingPolicyAplicada: null, // completado tras buildRequest
      };

      try {
        this._httpRequests++;

        const { url, body, thinkingPolicyAplicada } = this._provider.buildRequest({
          system, userMsg, model: this._model, maxTokens: tokens, callProfile: profile,
          responseMimeType, responseSchema,
        });
        registro.thinkingPolicyAplicada = thinkingPolicyAplicada || null;
        this._emit('llm.called', {
          label, attempt: attempt + 1, maxTokens: tokens, model: this._model,
          callProfile: callProfile || null, provider: providerName,
          modeloConfigurado: this._model, maxOutputEfectivo: tokens,
          thinkingPolicyAplicada: registro.thinkingPolicyAplicada,
        }, turnoId);

        // C007 human canary v9 — FIDELITY_LATENCY_CONTAINMENT. `timeoutMs`
        // is opt-in per call; when absent this is byte-for-byte the
        // previous fetch invocation (no AbortController, no signal).
        let deadlineTimer = null;
        let abortController = null;
        const fetchOptions = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
        if (timeoutMs) {
          abortController = new AbortController();
          fetchOptions.signal = abortController.signal;
          deadlineTimer = setTimeout(() => abortController.abort(), timeoutMs);
        }
        let res;
        try {
          res = await this._fetch(this._apiUrl || url, fetchOptions);
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }

        const httpStatus = res.status;
        const httpOk     = res.ok;
        const data       = await res.json();
        const parsedResp = this._provider.parseResponse(data);

        registro.httpStatus      = httpStatus;
        registro.httpOk          = httpOk;
        registro.responseBody    = data;
        registro.apiErrorType    = parsedResp.errorType;
        registro.apiErrorMessage = parsedResp.errorMessage;
        registro.stopReason      = parsedResp.stopReason;
        registro.usage           = parsedResp.usage;
        registro.modeloEfectivo  = parsedResp.modelVersion || null;

        const clasificarError = () => (typeof this._provider.classifyError === 'function'
          ? this._provider.classifyError({ httpStatus, errorType: parsedResp.errorType, stopReason: parsedResp.stopReason })
          : null);

        // HTTP error o error de API
        if (!httpOk || parsedResp.error) {
          const errType = parsedResp.errorType    || 'unknown_error';
          const errMsg  = parsedResp.errorMessage || '(sin mensaje)';
          registro.clasificacion  = `HTTP ${httpStatus} · ${errType}`;
          registro.errorCategory  = clasificarError() || ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
          registro.respuestaCruda = null;
          intentos.push(llmAttempt(registro));
          this._emitAttempt(label, system, userMsg, registro, turnoId);
          this._rawResults[label] = { raw: null, parsed: null, intentos };
          this._reintentos++;
          if (budgetPolicy) budgetPolicy.recordFailure(label);
          attempt++;
          continue;
        }

        // Respuesta sin contenido (anómala)
        const txt = parsedResp.text;
        if (!txt) {
          registro.respuestaCruda = null;
          registro.clasificacion  = `HTTP ${httpStatus} OK · respuesta anómala (sin content, sin error) · stop_reason=${registro.stopReason} · usage=${JSON.stringify(registro.usage)}`;
          registro.errorCategory  = clasificarError() || ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
          intentos.push(llmAttempt(registro));
          this._emitAttempt(label, system, userMsg, registro, turnoId);
          this._rawResults[label] = { raw: null, parsed: null, intentos };
          this._reintentos++;
          if (budgetPolicy) budgetPolicy.recordFailure(label);
          attempt++;
          continue;
        }

        // Parseo del JSON
        registro.respuestaCruda = txt;
        const clean = txt.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
        const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
        registro.bloqueParseado = (a >= 0 && b > a) ? clean.slice(a, b + 1) : null;
        registro.clasificacion  = classifyResponse(txt, clean);

        let parsed = null;
        if (a >= 0 && b > a) {
          try { parsed = JSON.parse(clean.slice(a, b + 1)); }
          catch (e) { registro.errorParseo = e.message; }
        }
        registro.parsed = parsed;
        // Truncamiento (p.ej. MAX_TOKENS) tiene precedencia sobre "JSON
        // inválido" cuando ambos podrían aplicar -- es la causa raíz más
        // precisa y accionable (el modelo funcionó, el presupuesto no
        // alcanzó) -- STRUCTURED_RESPONSE_INVALID solo cuando el proveedor
        // no reporta ninguna causa propia y aun así no tenemos JSON válido.
        registro.errorCategory = clasificarError() || (parsed ? null : ERROR_CATEGORIES.STRUCTURED_RESPONSE_INVALID);
        intentos.push(llmAttempt(registro));
        this._emitAttempt(label, system, userMsg, registro, turnoId);
        this._rawResults[label] = { raw: txt, parsed, intentos };

        if (budgetPolicy) budgetPolicy.recordUsage(label, registro.usage, attempt > 0);

        if (!parsed) {
          this._reintentos++;
          attempt++;
          continue;
        }

        this._emit('llm.succeeded', {
          label, clasificacion: registro.clasificacion, usage: registro.usage, model: this._model,
          callProfile: callProfile || null, provider: providerName,
          modeloConfigurado: this._model, modeloEfectivo: registro.modeloEfectivo,
          maxOutputEfectivo: tokens, thinkingPolicyAplicada: registro.thinkingPolicyAplicada,
          finishReason: registro.stopReason, errorCategory: registro.errorCategory,
        }, turnoId);
        // DETERMINISTIC REPLAY CAPTURE -- immediately after parsing/schema
        // validation (this exact `if (parsed)` branch), before returning
        // control to the caller (downstream semantic acceptance/rejection
        // happens entirely AFTER this point, in InteraccionCognitivaWriter.js)
        // -- generic across every label, never special-cased.
        if (this._replayCaptureEnabled) {
          this._emitReplayCaptureExternalOutput({
            label, parsed, callProfile: callProfile || null, provider: providerName,
            model: registro.modeloEfectivo || this._model, responseSchema, replaySchema,
          }, turnoId);
        }
        return { parsed, intentos, aborted: false };

      } catch (e) {
        // C007 human canary v9 — FIDELITY_LATENCY_CONTAINMENT. AbortError is
        // exclusively our own deadline firing (timeoutMs) via
        // abortController.abort() above — never the provider's own doing —
        // so it gets its own category, distinct from a genuine transport
        // failure the provider reported.
        const esTimeoutPropio = e && e.name === 'AbortError';
        registro.errorParseo   = esTimeoutPropio ? 'timeout: deadline de ejecución excedido' : 'red: ' + e.message;
        registro.clasificacion = esTimeoutPropio ? `timeout tras ${timeoutMs}ms` : 'error de red';
        registro.errorCategory = esTimeoutPropio
          ? ERROR_CATEGORIES.PROVIDER_TIMEOUT
          : ERROR_CATEGORIES.PROVIDER_TRANSPORT_ERROR;
        intentos.push(llmAttempt(registro));
        this._emitAttempt(label, system, userMsg, registro, turnoId);
        this._rawResults[label] = { raw: null, parsed: null, intentos };
        this._reintentos++;
        if (budgetPolicy) budgetPolicy.recordFailure(label);
        attempt++;
      }
    }

    // GEMINI_PROVIDER_ESTABILIDAD_1 — última categoría observada entre los
    // intentos agotados: permite distinguir, sin abrir intentos[], "el
    // modelo no funciona" (MODEL_UNAVAILABLE/AUTH_CONFIGURATION_ERROR/
    // QUOTA_OR_RATE_LIMIT/PROVIDER_TRANSPORT_ERROR) de "el contenido
    // cognitivo falló" (STRUCTURED_RESPONSE_INVALID/MODEL_RESPONSE_TRUNCATED)
    // -- nunca un "Gate de salida fallido" genérico como única explicación.
    const ultimoIntento = intentos[intentos.length - 1] || null;
    const errorCategoryFinal = ultimoIntento ? ultimoIntento.errorCategory : null;
    this._emit('llm.failed', {
      label, razon: 'MAX_RETRIES', intentos: intentos.length, model: this._model,
      errorCategory: errorCategoryFinal,
      callProfile: callProfile || null, provider: providerName,
      modeloConfigurado: this._model,
      modeloEfectivo: ultimoIntento ? ultimoIntento.modeloEfectivo : null,
      maxOutputEfectivo: tokens,
      thinkingPolicyAplicada: ultimoIntento ? ultimoIntento.thinkingPolicyAplicada : null,
      finishReason: ultimoIntento ? ultimoIntento.stopReason : null,
    }, turnoId);
    return { parsed: null, intentos, aborted: false, errorCategory: errorCategoryFinal };
  }

  // ── Auditor (replica callAuditor del E2E) ────────────────────────────────────

  /**
   * Llamada al modelo auditor (temperatura 0, sin reintentos).
   * @param {string} systemPrompt
   * @param {string} [model] — puede ser diferente al modelo principal
   */
  async callAuditor(systemPrompt, model = null) {
    this._httpRequests++;
    try {
      const { url, body } = this._provider.buildRequest({
        system: systemPrompt, userMsg: 'Audita ahora.',
        model: model || this._model, maxTokens: 600, temperature: 0,
      });
      const res = await this._fetch(this._apiUrl || url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const httpStatus = res.status;
      const httpOk     = res.ok;
      const data       = await res.json();
      const parsedResp = this._provider.parseResponse(data);

      if (!httpOk || parsedResp.error) {
        const errType = parsedResp.errorType || 'unknown_error';
        this._emit('llm.failed', { label: 'auditor', razon: `HTTP ${httpStatus} · ${errType}` });
        return null;
      }

      const txt = parsedResp.text;
      if (!txt) {
        this._emit('llm.failed', { label: 'auditor', razon: 'respuesta anómala' });
        return null;
      }

      // Parseo ligero — el auditor devuelve JSON simple
      const clean = txt.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try { return JSON.parse(clean.slice(a, b + 1)); } catch { return null; }
      }
      return null;
    } catch (e) {
      this._emit('llm.failed', { label: 'auditor', razon: 'error de red: ' + e.message });
      return null;
    }
  }

  // ── Observabilidad pública ───────────────────────────────────────────────────

  get rawResults()         { return { ...this._rawResults }; }
  get callCount()          { return this._callCount; }
  get httpRequests()       { return this._httpRequests; }
  get reintentos()         { return this._reintentos; }
  get abortedPreflight()   { return this._abortedPreflight; }

  getIntentosForLabel(label) {
    return this._rawResults[label]?.intentos || [];
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §6 — turnoId (null por defecto)
  // correlaciona este evento técnico con la intervención del usuario que lo
  // originó (ver Event.createEvent, que ya soportaba este campo desde el
  // Incremento 2 sin que ningún emisor lo usara todavía).
  _emit(tipo, payload = {}, turnoId = null) {
    if (!this._eventBus) return;
    try {
      this._eventBus.emit(createEvent({
        tipo, sesionId: this._sesionId, turnoId, payload,
      }));
    } catch { /* eventos nunca bloquean */ }
  }

  /**
   * DETERMINISTIC REPLAY CAPTURE -- one 'replay_capture.external_output'
   * event per successfully parsed external semantic call, generic across
   * every label. ORDINAL is global across this instance's whole call
   * sequence (one instance per session/turn-sequence); OCCURRENCE is
   * per-label, in call order -- the SAME (label, occurrence) identity
   * deterministicReplay.js's patchRecordedOutputs already matches against,
   * never re-derived differently here. Same _emit() defensive-swallow
   * pattern as every other observability emission in this class --
   * capture NEVER blocks or alters the cognitive outcome (Section 9).
   *
   * SCHEMA IDENTITY (correction -- a bare `schemaFingerprint: null` can
   * mean either "this call is genuinely schema-less" or "a real schema
   * exists but wasn't threaded here" -- indistinguishable, and the second
   * one is an observability failure this capture must never silently
   * produce). Exactly three, explicit, mutually exclusive states:
   *   - `responseSchema` present (the REAL param the actual request used,
   *     e.g. a repair/contract call) -> schemaMode 'KNOWN_REQUEST_SCHEMA',
   *     fingerprinted from THAT exact object -- never null.
   *   - no `responseSchema`, but the call site passed `replaySchema` (an
   *     observability-only reference to the real schema that governs this
   *     call by hand-validation, e.g. legacy-mode 'destino' against
   *     CAPA1_COGNITIVE_RESPONSE_SCHEMA) -> schemaMode 'KNOWN_REFERENCE_SCHEMA',
   *     fingerprinted from that reference -- never null. The literal
   *     string 'NONE' means the call site has explicitly asserted no
   *     schema object governs it anywhere (contract lives in prompt prose)
   *     -> schemaMode 'NONE', schemaFingerprint null (the ONLY legitimate
   *     way to reach a null fingerprint).
   *   - neither provided (a call site this correction hasn't threaded yet)
   *     -> schemaMode 'UNTHREADED_CALL_SITE', schemaFingerprint null, but
   *     NEVER confused with 'NONE' -- an honestly-labeled known gap, not a
   *     fabricated "no schema exists" claim.
   */
  _emitReplayCaptureExternalOutput({ label, parsed, callProfile, provider, model, responseSchema, replaySchema }, turnoId) {
    // OBSERVABILITY_O1 -- shared TURN capture context (see constructor
    // docstring), never per-instance: identical across primary and any
    // fallback executor handling the SAME turnoId.
    const ctx = this._obtenerContextoCaptura(turnoId);
    ctx.ordinal += 1;
    ctx.occurrenceByLabel[label] = (ctx.occurrenceByLabel[label] || 0) + 1;
    const parsedJson = JSON.stringify(parsed);
    let schemaMode;
    let schemaFingerprint;
    if (responseSchema !== undefined) {
      schemaMode = 'KNOWN_REQUEST_SCHEMA';
      schemaFingerprint = computeSchemaFingerprint(responseSchema);
    } else if (replaySchema === 'NONE') {
      schemaMode = 'NONE';
      schemaFingerprint = null;
    } else if (replaySchema !== undefined) {
      schemaMode = 'KNOWN_REFERENCE_SCHEMA';
      schemaFingerprint = computeSchemaFingerprint(replaySchema);
    } else {
      schemaMode = 'UNTHREADED_CALL_SITE';
      schemaFingerprint = null;
    }
    this._emit('replay_capture.external_output', {
      ordinal: ctx.ordinal,
      label,
      occurrence: ctx.occurrenceByLabel[label],
      callProfile: callProfile || null,
      provider: provider || null,
      model: model || null,
      schemaMode,
      schemaFingerprint,
      engineBuildFingerprint: computeEngineBuildFingerprint(),
      parsedOutput: parsed,
      parsedOutputSha256: sha256Hex(parsedJson),
    }, turnoId);
  }

  /**
   * Observabilidad de un intento de llamada al LLM: prompt completo enviado,
   * respuesta cruda del proveedor y resultado del extractor de slots — todo lo
   * que ya se calcula en `registro` para el reintento/clasificación, ahora
   * también persistido como evento (además de en memoria vía _rawResults).
   * No participa en ninguna decisión: es un registro adicional, no un dato leído.
   */
  _emitAttempt(label, system, userMsg, registro, turnoId = null) {
    this._emit('llm.attempt', {
      label,
      model:            this._model,
      attempt:          registro.intento,
      promptSystem:     system,
      promptUserMsg:    userMsg,
      httpStatus:       registro.httpStatus,
      responseBody:     registro.responseBody,
      respuestaCruda:   registro.respuestaCruda,
      bloqueParseado:   registro.bloqueParseado,
      parsed:           registro.parsed,
      clasificacion:    registro.clasificacion,
      errorCategory:    registro.errorCategory,
      apiErrorType:     registro.apiErrorType,
      apiErrorMessage:  registro.apiErrorMessage,
      stopReason:       registro.stopReason,
      usage:            registro.usage,
      // LLM_CALL_PROFILE_GOVERNANCE_1 (Fase 8) — "¿por qué esta llamada
      // tenía este presupuesto?" debe responderse desde ESTE evento sin
      // buscar un literal disperso en un caso de uso.
      callProfile:            registro.callProfile,
      provider:               registro.provider,
      modeloConfigurado:      registro.modeloConfigurado,
      modeloEfectivo:         registro.modeloEfectivo,
      maxOutputEfectivo:      registro.maxOutputEfectivo,
      thinkingPolicyAplicada: registro.thinkingPolicyAplicada,
      finishReason:           registro.stopReason,
    }, turnoId);
  }

  // GEMINI_PROVIDER_ESTABILIDAD_1 — modelo efectivo de ESTA instancia
  // (config.model si se pasó explícito, si no el DEFAULT_MODEL del
  // proveedor activo) -- getter público para que /health y cualquier
  // observabilidad externa lo lean sin depender de los eventos llm.*.
  get model() { return this._model; }

  static get DEFAULT_MODEL()      { return AnthropicProvider.DEFAULT_MODEL; }
  static get PROMPT_MARKERS()     { return PROMPT_CORRUPTION_MARKERS; }
  static classifyResponse         = classifyResponse;

  /**
   * DETERMINISTIC REPLAY CAPTURE (OBSERVABILITY_O1) -- releases the shared
   * turn capture context for turnoId, so _captureContextByTurnoId never
   * grows unbounded across a long-running server process. Called once by
   * InteraccionCognitivaWriter._capturarTerminalReplaySiCorresponde, at the
   * same point (and only the same point) authority_trace.turno/
   * replay_capture.terminal are emitted for a turn -- after that, no
   * executor for this turnoId can legitimately call again. No-op (never
   * throws) when no context exists (capture disabled, or turnoId null).
   */
  static clearReplayCaptureContext(turnoId) {
    if (turnoId) _captureContextByTurnoId.delete(turnoId);
  }
}

module.exports = {
  LLMService, classifyResponse, PROMPT_CORRUPTION_MARKERS, ERROR_CATEGORIES,
};
