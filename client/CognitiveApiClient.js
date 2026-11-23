'use strict';

/**
 * COGNITIVE API CLIENT
 * Cliente HTTP para CognitivoApiServer.
 * Sin lógica cognitiva. Sin contratos, gates ni policies.
 * Solo transporte + DTOs de la API.
 *
 * Inyectable: acepta un fetchImpl para tests deterministas sin red real.
 * En producción se pasa el fetch global del navegador o node-fetch.
 *
 * Ref: Roadmap Fase 5 — tarea 5.3.
 */

class CognitiveApiClient {
  /**
   * @param {string}   baseUrl    — URL base del CognitivoApiServer (ej: 'http://localhost:3000')
   * @param {Function} fetchImpl  — implementación de fetch (inyectable para tests)
   */
  constructor(baseUrl, fetchImpl) {
    if (!baseUrl || typeof baseUrl !== 'string')
      throw new Error('CognitiveApiClient: baseUrl es requerido');
    if (!fetchImpl || typeof fetchImpl !== 'function')
      throw new Error('CognitiveApiClient: fetchImpl es requerido (inyectar fetch real o mock)');

    this._base  = baseUrl.replace(/\/$/, '');
    this._fetch = fetchImpl;
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * GET /state/:sessionId
   * @returns {Promise<ApiResponse<StateDTO>>}
   */
  async getState(sessionId) {
    return this._request('GET', `/state/${encodeURIComponent(sessionId)}`);
  }

  /**
   * POST /pipeline
   * @param {string}  sessionId
   * @param {object}  [input]             — { expertoId?, resume?, contextualInputs? }
   * @returns {Promise<ApiResponse<PipelineResultDTO>>}
   */
  async runPipeline(sessionId, input = {}) {
    return this._request('POST', '/pipeline', { sessionId, ...input });
  }

  /**
   * GET /events/:sessionId
   * @returns {Promise<ApiResponse<{ sesionId, total, eventos }>>}
   */
  async getEvents(sessionId) {
    return this._request('GET', `/events/${encodeURIComponent(sessionId)}`);
  }

  /**
   * GET /audit/:sessionId
   * @returns {Promise<ApiResponse<AuditDTO>>}
   */
  async getAudit(sessionId) {
    return this._request('GET', `/audit/${encodeURIComponent(sessionId)}`);
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  async _request(method, path, body = null) {
    const url  = `${this._base}${path}`;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    let res;
    try {
      res = await this._fetch(url, opts);
    } catch (e) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: e.message } };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: { code: 'PARSE_ERROR', message: 'Respuesta no es JSON válido' } };
    }

    // La API siempre devuelve { ok, data } o { ok, error }
    return data;
  }
}

module.exports = { CognitiveApiClient };
