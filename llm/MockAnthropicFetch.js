'use strict';

/**
 * MOCK ANTHROPIC FETCH — smoke test local determinístico
 * Reemplazo de `fetch` compatible con LLMService, para usar únicamente cuando
 * CIRCULO_LLM_MODE=mock. Nunca toca la red: siempre responde en memoria, con
 * la forma exacta de una respuesta de la API de Anthropic (content[].text con
 * JSON embebido).
 *
 * No contiene lógica cognitiva: no razona sobre el prompt ni genera contenido.
 * Su única decisión es mecánica — qué fixture estático (ver mockFixtures.js)
 * corresponde al prompt recibido, detectando un marcador de texto único que
 * cada prompt de AgoraPrompts.js ya contiene (p.ej. "destino_completo" o
 * "Motor de Inferencia de Círculo"). Los prompts, las Inteligencias, las
 * Policies, el Orchestrator y los Contratos no se tocan ni se reimplementan
 * aquí — solo se les da una respuesta de LLM válida y determinística.
 *
 * Las 5 gramáticas usan fixtures conversacionales (varios turnos: información
 * parcial → propuesta de cierre → confirmado). El fetch cuenta, por marcador,
 * cuántas veces se llamó esa gramática en la vida de ESTA instancia de fetch
 * (= una corrida del servidor) y avanza por esa secuencia. No es un conteo por
 * sesión: para el smoke test local (un solo experto, un solo navegador) es
 * suficiente; no pretende aislar sesiones concurrentes.
 *
 * Ref: NEXT_TASK.md — corrección del flujo conversacional — fixtures
 *      conversacionales del modo mock.
 */

const { ALL_FIXTURES, FALLBACK_PAYLOAD } = require('./mockFixtures');

/** Extrae el system prompt del cuerpo de la request, sin asumir su contenido. */
function extractSystemPrompt(options) {
  try {
    const body = JSON.parse((options && options.body) || '{}');
    return typeof body.system === 'string' ? body.system : '';
  } catch {
    return '';
  }
}

/**
 * Elige el payload para el prompt recibido. Si el fixture es conversacional
 * (`turns`), avanza al siguiente turno de esa gramática cada vez que se
 * invoca; el último turno del arreglo se reutiliza indefinidamente.
 */
function selectPayload(systemPrompt, turnCounters) {
  const found = ALL_FIXTURES.find(f => systemPrompt.includes(f.marker));
  if (!found) return FALLBACK_PAYLOAD;

  if (Array.isArray(found.turns)) {
    const seen = (turnCounters[found.marker] || 0) + 1;
    turnCounters[found.marker] = seen;
    const idx = Math.min(seen, found.turns.length) - 1;
    return found.turns[idx];
  }

  return found.payload;
}

function mockResponseBody(systemPrompt, turnCounters) {
  const payload = selectPayload(systemPrompt, turnCounters);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * Crea el reemplazo de fetch determinístico. No hace ninguna llamada de red:
 * responde en memoria de forma síncrona (envuelta en una Promise, como fetch real).
 * Cada llamada a esta factory arranca sus propios contadores de turno en cero
 * (una instancia de fetch = una conversación nueva).
 * @returns {(url: string, options?: object) => Promise<{ok:boolean,status:number,json:Function}>}
 */
function createMockAnthropicFetch() {
  const turnCounters = {}; // { [marker]: vecesInvocado }
  return function mockAnthropicFetch(_url, options) {
    const systemPrompt = extractSystemPrompt(options);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => mockResponseBody(systemPrompt, turnCounters),
    });
  };
}

module.exports = { createMockAnthropicFetch };
