'use strict';

/**
 * ORCHESTRATOR SERVICE
 * Coordina la ejecución del pipeline cognitivo.
 * No produce razonamiento. No interpreta conocimiento.
 * Su responsabilidad: administrar la colaboración entre Inteligencias
 * aplicando Contratos, Gates y Políticas en cada paso.
 *
 * Ref: Engineering Blueprint Cap. 5; Implementation Specification EPIC 07.
 * "El Policy Engine decide. El Orquestador ejecuta."
 *
 * Convierte la cadena de callbacks de circulo_v0 en un plan de ejecución
 * con estado, recuperación y reintentos configurables.
 */

const { enterStage, verifyStage, validateInput, validateOutput, PIPELINE_ORDER } = require('../contracts/PipelineContracts');
const { GatePolicy,  GATE_OUTCOMES }  = require('../policy/GatePolicy');
const { HITLPolicy,  HITL_STATUS }    = require('../policy/HITLPolicy');
const { BudgetPolicy }                = require('../policy/BudgetPolicy');
const { PromotionPolicy, PROMOTION_STATUS } = require('../policy/PromotionPolicy');
const { createEvent }                 = require('../schemas/Event');
const { SLOTS_BY_GRAMATICA }          = require('../schemas/AgoraSlots');

// ── Tipos de resultado del Orquestador ────────────────────────────────────────

const STAGE_RESULT = Object.freeze({
  COMPLETED:   'completed',    // etapa completada exitosamente
  HITL_PAUSED: 'hitl_paused', // esperando confirmación del experto
  GATE_FAILED: 'gate_failed', // gate de calidad rechazó el resultado
  CONTRACT_FAILED: 'contract_failed', // contrato de entrada no cumplido
  BUDGET_EXHAUSTED: 'budget_exhausted',
  ERROR:       'error',
  SKIPPED:     'skipped',     // etapa opcional omitida (ej: bonus)
});

class OrchestratorService {
  /**
   * @param {object} eventBus     — { emit(event) }
   * @param {object} stateService — CognitiveStateService
   * @param {object} budgetPolicy — BudgetPolicy (instancia por sesión)
   */
  constructor(eventBus, stateService, budgetPolicy = null) {
    if (!eventBus || typeof eventBus.emit !== 'function')
      throw new Error('OrchestratorService: eventBus debe implementar { emit }');
    if (!stateService)
      throw new Error('OrchestratorService: stateService es requerido');

    this._bus     = eventBus;
    this._svc     = stateService;
    this._budget  = budgetPolicy || new BudgetPolicy();
    this._plan    = [];       // etapas planificadas
    this._log     = [];       // historial de ejecución auditable
  }

  // ── Plan de ejecución ───────────────────────────────────────────────────────

  /**
   * Construye el plan de ejecución a partir del orden del pipeline.
   * El plan puede reanudarse desde cualquier punto.
   */
  buildPlan(desde = null) {
    const inicio = desde ? PIPELINE_ORDER.indexOf(desde) : 0;
    this._plan   = PIPELINE_ORDER.slice(inicio >= 0 ? inicio : 0);
    return this;
  }

  /**
   * Construye un plan parcial con solo las etapas indicadas.
   * Útil para reanudar módulos faltantes (replica el botón "Reanudar" del E2E).
   */
  buildPartialPlan(etapas) {
    if (!Array.isArray(etapas) || etapas.length === 0)
      throw new Error('OrchestratorService.buildPartialPlan: etapas debe ser array no vacío');
    this._plan = etapas;
    return this;
  }

  // ── Ejecución de etapa ──────────────────────────────────────────────────────

  /**
   * Intenta ejecutar una etapa del pipeline.
   * Aplica en orden: BudgetPolicy → Contrato (entrada) → HITL → Gate → Inteligencia → Gate (salida).
   *
   * @param {string}   etapa
   * @param {object}   state     — CognitiveState mutable
   * @param {Function} executor  — async (state, etapa, maxTokens) → resultado | null
   *                              La Inteligencia real. El Orquestador no sabe lo que hace dentro.
   * @returns {object} StageExecution { etapa, result, detalles, duration }
   */
  async executeStage(etapa, state, executor) {
    const t0 = Date.now();
    const correlationId = `${etapa}_${Date.now()}`;

    this._emit('intelligence.started', state, { etapa, correlationId });

    // 1. Presupuesto
    const budget = this._budget.requestBudget(etapa);
    if (!budget.allowed) {
      return this._stageResult(etapa, STAGE_RESULT.BUDGET_EXHAUSTED, budget.razon, t0, correlationId);
    }

    // 2. Contrato de entrada (DTO formal)
    const inputValidation = validateInput(etapa, state);
    if (!inputValidation.valid) {
      return this._stageResult(etapa, STAGE_RESULT.CONTRACT_FAILED,
        `Contrato de entrada incumplido: ${inputValidation.errors.join('; ')}`, t0, correlationId);
    }

    // 3. HITL PRE-EXECUTOR — solo bloquea si ya hubo una ejecución previa y el humano
    //    debe confirmar externamente (p.ej. segunda pasada tras UI de selección).
    //    Etapas que resuelven el HITL internamente (Modelo Agora) siempre ejecutan primero.
    const hitlPre = HITLPolicy.evaluate(state, etapa);
    if (hitlPre.required && hitlPre.status === HITL_STATUS.PENDING) {
      // Solo pausar si ya existe un resultado previo del executor (re-run tras pausa)
      // En primera pasada, dejar que el executor intente resolver internamente.
      const yaEjecutado = this._log.some(l => l.etapa === etapa);
      if (yaEjecutado) {
        this._log.push({ etapa, result: STAGE_RESULT.HITL_PAUSED, t: Date.now() });
        this._emit('intelligence.completed', state, { etapa, correlationId, result: STAGE_RESULT.HITL_PAUSED });
        return this._stageResult(etapa, STAGE_RESULT.HITL_PAUSED,
          hitlPre.razon, t0, correlationId, { hitl: hitlPre });
      }
    }

    // 4. Ejecutar la Inteligencia
    let ejecutado = null;
    try {
      ejecutado = await executor(state, etapa, budget.tokensApproved);
    } catch (e) {
      this._budget.recordFailure(etapa);
      return this._stageResult(etapa, STAGE_RESULT.ERROR, `Error en executor: ${e.message}`, t0, correlationId);
    }

    // 5. Registrar uso si el executor devolvió metadata de tokens
    if (ejecutado && ejecutado._usage) {
      this._budget.recordUsage(etapa, ejecutado._usage);
    } else {
      this._budget.recordUsage(etapa, null);
    }

    // 5b. HITL POST-EXECUTOR — verificar si el executor resolvió el HITL
    //     Si sigue pendiente después del executor, pausar para intervención humana.
    const hitlPost = HITLPolicy.evaluate(state, etapa);
    if (hitlPost.required && hitlPost.status === HITL_STATUS.PENDING) {
      this._log.push({ etapa, result: STAGE_RESULT.HITL_PAUSED, t: Date.now() });
      this._emit('intelligence.completed', state, { etapa, correlationId, result: STAGE_RESULT.HITL_PAUSED });
      return this._stageResult(etapa, STAGE_RESULT.HITL_PAUSED,
        hitlPost.razon, t0, correlationId, { hitl: hitlPost });
    }

    // 6. Gate de postcondición (DTO formal de salida)
    const outputValidation = validateOutput(etapa, state);
    if (!outputValidation.valid) {
      this._emit('gate.rejected', state, {
        etapa, correlationId, errors: outputValidation.errors,
        ...this._gateSlotsInfo(etapa, state),
      });
      return this._stageResult(etapa, STAGE_RESULT.GATE_FAILED,
        `Gate de salida fallido: ${outputValidation.errors.join('; ')}`, t0, correlationId);
    }

    // 7. Promotion gate: solo commit si PromotionPolicy lo autoriza (P-01)
    // El DTO ya aprobó en el paso 6; pasamos ese resultado a PromotionPolicy para que
    // evalúe también _error y cualquier condición adicional de consistencia del estado.
    const outputGate = { outcome: GATE_OUTCOMES.APPROVED, bloqueante: false, razon: 'DTO válido', detalles: [] };
    const promotion  = PromotionPolicy.evaluatePromotion(etapa, state, outputGate);
    if (promotion.status === PROMOTION_STATUS.REJECTED) {
      this._emit('gate.rejected', state, { etapa, correlationId, razon: promotion.razon });
      return this._stageResult(etapa, STAGE_RESULT.GATE_FAILED,
        'PromotionPolicy rechazó la promoción: ' + promotion.razon, t0, correlationId);
    }

    this._svc.setStage(state, etapa);
    this._svc.commit(state, `Etapa completada: ${etapa}`);

    this._emit('gate.approved',           state, { etapa, correlationId, ...this._gateSlotsInfo(etapa, state) });
    this._emit('intelligence.completed',  state, { etapa, correlationId, result: STAGE_RESULT.COMPLETED });

    const duration = Date.now() - t0;
    this._log.push({ etapa, result: STAGE_RESULT.COMPLETED, duration, t: Date.now() });

    return { etapa, result: STAGE_RESULT.COMPLETED, razon: 'OK', duration, correlationId };
  }

  /**
   * Ejecuta el plan completo.
   * Se detiene en HITL_PAUSED, GATE_FAILED (bloqueante) o BUDGET_EXHAUSTED.
   * Etapas opcionales que fallan (bonus) se registran como SKIPPED.
   *
   * @param {object}   state
   * @param {Function} executorFn — async (state, etapa, maxTokens) → cualquier cosa
   * @returns {object[]} historial de StageExecution
   */
  async run(state, executorFn) {
    if (!this._plan || this._plan.length === 0)
      throw new Error('OrchestratorService: plan vacío — llama a buildPlan() primero');

    const history = [];

    for (const etapa of this._plan) {
      // Etapas opcionales: bonus puede fallar sin detener el pipeline
      const esOpcional = etapa === 'bonus';

      const exec = await this.executeStage(etapa, state, executorFn);
      history.push(exec);

      if (exec.result === STAGE_RESULT.COMPLETED || exec.result === STAGE_RESULT.SKIPPED) continue;
      if (exec.result === STAGE_RESULT.HITL_PAUSED) break;        // esperar respuesta del experto
      if (exec.result === STAGE_RESULT.BUDGET_EXHAUSTED) break;
      if (exec.result === STAGE_RESULT.CONTRACT_FAILED && esOpcional) { history[history.length-1].result = STAGE_RESULT.SKIPPED; continue; }
      if (exec.result === STAGE_RESULT.GATE_FAILED && esOpcional)     { history[history.length-1].result = STAGE_RESULT.SKIPPED; continue; }
      if (exec.result === STAGE_RESULT.ERROR && esOpcional)           { history[history.length-1].result = STAGE_RESULT.SKIPPED; continue; }
      break; // cualquier fallo bloqueante detiene el pipeline
    }

    this._emit('pipeline.completed', state, {
      etapasEjecutadas: history.length,
      ultimoResultado:  history[history.length-1]?.result,
    });

    return history;
  }

  /**
   * Reanuda el plan desde la primera etapa con resultado no-COMPLETED.
   * Replica el botón "Reanudar solo módulos faltantes" del E2E.
   */
  resume(history, state, executorFn) {
    const pendientes = this._plan.filter(etapa => {
      const prev = history.find(h => h.etapa === etapa);
      return !prev || prev.result !== STAGE_RESULT.COMPLETED;
    });
    this._plan = pendientes;
    return this.run(state, executorFn);
  }

  // ── Auditoría ───────────────────────────────────────────────────────────────

  get executionLog()    { return [...this._log]; }
  get budgetSnapshot()  { return this._budget.snapshot(); }
  get currentPlan()     { return [...this._plan]; }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _stageResult(etapa, result, razon, t0, correlationId, extra = {}) {
    const duration = Date.now() - t0;
    this._log.push({ etapa, result, razon, duration, t: Date.now() });
    this._emit('intelligence.completed', null, { etapa, correlationId, result, razon });
    return { etapa, result, razon, duration, correlationId, ...extra };
  }

  _emit(tipo, state, payload = {}) {
    try {
      this._bus.emit(createEvent({
        tipo,
        sesionId:  state?.sesionId || 'orchestrator',
        versionId: state?.versionId || null,
        payload,
      }));
    } catch { /* eventos nunca bloquean el pipeline */ }
  }

  /**
   * Observabilidad del Gate 'gramatica_completa' (única forma de gate que evalúa
   * slots): qué slots esperaba la etapa y cuáles llegaron con evidencia real.
   * Solo lectura de state.slots — no participa en la decisión del Gate, que ya
   * tomó validateOutput/GatePolicy antes de llamar a este helper.
   */
  _gateSlotsInfo(etapa, state) {
    const esperados = SLOTS_BY_GRAMATICA[etapa];
    if (!esperados) return {};
    const slots = state?.slots || {};
    const encontrados = esperados.filter(k => slots[k] !== null && slots[k] !== undefined && slots[k] !== '');
    return { esperados, encontrados };
  }
}

module.exports = { OrchestratorService, STAGE_RESULT };
