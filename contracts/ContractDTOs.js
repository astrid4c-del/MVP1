'use strict';

/**
 * CONTRACT DTOs
 * Validación formal en runtime de entradas y salidas de cada etapa del pipeline.
 * Reemplaza los strings descriptivos de PipelineContracts por validadores ejecutables.
 *
 * Cada DTO define:
 *   validate(state) → { valid: boolean, errors: string[] }
 *
 * Los errores son estructurados: incluyen campo, etapa y descripción del problema.
 * Ref: EPIC 02 — "Cada Inteligencia expone: input, output, precondiciones, postcondiciones,
 *      errores, eventos emitidos. Nunca comunicación implícita."
 */

const { validateGramaticaComplete, SLOTS_BY_GRAMATICA } = require('../schemas/AgoraSlots');
const { validateExpertProfile }              = require('../schemas/ExpertProfile');
const { validateContextModel }               = require('../schemas/ContextModel');
const { validateTransformationArchitecture, validateModule, validateModuleEvidence } = require('../schemas/TransformationArchitecture');

// ── Error estructurado ────────────────────────────────────────────────────────

function dtoError(etapa, campo, msg) {
  return `[${etapa}] ${campo}: ${msg}`;
}

function dtoResult(errors) {
  return { valid: errors.length === 0, errors };
}

// ── DTOs de ENTRADA (precondiciones) ─────────────────────────────────────────

const INPUT_DTOS = {

  destino: (state) => {
    const errors = [];
    if (!state || typeof state !== 'object')
      errors.push(dtoError('destino', 'state', 'debe ser objeto'));
    if (!state.sesionId)
      errors.push(dtoError('destino', 'sesionId', 'requerido'));
    // DESTINO no requiere slots previos — siempre puede arrancar
    return dtoResult(errors);
  },

  destilar: (state) => {
    const errors = [];
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'destino');
    if (!complete)
      errors.push(dtoError('destilar', 'slots.destino', `slots incompletos: [${missing.join(', ')}]`));
    return dtoResult(errors);
  },

  traducir: (state) => {
    const errors = [];
    ['destino','destilar'].forEach(g => {
      const { complete, missing } = validateGramaticaComplete(state.slots || {}, g);
      if (!complete)
        errors.push(dtoError('traducir', `slots.${g}`, `slots incompletos: [${missing.join(', ')}]`));
    });
    return dtoResult(errors);
  },

  ascenso: (state) => {
    const errors = [];
    ['destino','destilar','traducir'].forEach(g => {
      const { complete, missing } = validateGramaticaComplete(state.slots || {}, g);
      if (!complete)
        errors.push(dtoError('ascenso', `slots.${g}`, `slots incompletos: [${missing.join(', ')}]`));
    });
    return dtoResult(errors);
  },

  darvida: (state) => {
    const errors = [];
    ['destino','destilar','traducir','ascenso'].forEach(g => {
      const { complete, missing } = validateGramaticaComplete(state.slots || {}, g);
      if (!complete)
        errors.push(dtoError('darvida', `slots.${g}`, `slots incompletos: [${missing.join(', ')}]`));
    });
    return dtoResult(errors);
  },

  inferencia: (state) => {
    const errors = [];
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'destino');
    if (!complete)
      errors.push(dtoError('inferencia', 'slots.destino', `mínimo requerido incompleto: [${missing.join(', ')}]`));
    return dtoResult(errors);
  },

  opciones: (state) => {
    const errors = [];
    if (!state.avatarInferido || typeof state.avatarInferido !== 'object')
      errors.push(dtoError('opciones', 'avatarInferido', 'debe ser objeto no nulo'));
    else if (Object.keys(state.avatarInferido).length === 0)
      errors.push(dtoError('opciones', 'avatarInferido', 'debe tener al menos un campo anclado'));
    return dtoResult(errors);
  },

  arquitectura: (state) => {
    const errors = [];
    if (!state.avatarElegido)
      errors.push(dtoError('arquitectura', 'avatarElegido', 'requerido — el experto debe haber elegido un avatar'));
    if (!state.promesaElegida)
      errors.push(dtoError('arquitectura', 'promesaElegida', 'requerido — el experto debe haber elegido una promesa'));
    return dtoResult(errors);
  },

  evidencia: (state) => {
    const errors = [];
    if (!state.arquitecturaElegida || typeof state.arquitecturaElegida !== 'object')
      errors.push(dtoError('evidencia', 'arquitecturaElegida', 'debe ser objeto no nulo'));
    else if (!Array.isArray(state.arquitecturaElegida.modulos) || state.arquitecturaElegida.modulos.length === 0)
      errors.push(dtoError('evidencia', 'arquitecturaElegida.modulos', 'debe ser array no vacío'));
    else {
      state.arquitecturaElegida.modulos.forEach((m, i) => {
        const { valid, errors: me } = validateModule(m, i + 1);
        if (!valid) me.forEach(e => errors.push(dtoError('evidencia', `arquitecturaElegida.modulos[${i}]`, e)));
      });
    }
    return dtoResult(errors);
  },

  forma: (state) => {
    const errors = [];
    if (!Array.isArray(state.evidenciasModulos))
      errors.push(dtoError('forma', 'evidenciasModulos', 'debe ser array'));
    else if (state.evidenciasModulos.length === 0)
      errors.push(dtoError('forma', 'evidenciasModulos', 'debe ser no vacío'));
    else {
      state.evidenciasModulos.forEach((ev, i) => {
        const { valid, errors: ee } = validateModuleEvidence(ev, i + 1);
        if (!valid) ee.forEach(e => errors.push(dtoError('forma', `evidenciasModulos[${i}]`, e)));
      });
    }
    return dtoResult(errors);
  },

  desarrollo: (state) => {
    const errors = [];
    const mods = state.formaProducto?.producto_estructura?.modulos;
    if (!Array.isArray(mods))
      errors.push(dtoError('desarrollo', 'formaProducto.producto_estructura.modulos', 'debe ser array'));
    else if (mods.length === 0)
      errors.push(dtoError('desarrollo', 'formaProducto.producto_estructura.modulos', 'debe ser no vacío'));
    if (!state.formaProducto?.blueprint_privado)
      errors.push(dtoError('desarrollo', 'formaProducto.blueprint_privado', 'requerido'));
    return dtoResult(errors);
  },

  bonus: (state) => {
    const errors = [];
    if (!state.avatarElegido)
      errors.push(dtoError('bonus', 'avatarElegido', 'requerido'));
    return dtoResult(errors);
  },

  blueprint: (state) => {
    const errors = [];
    if (!state.formaProducto?.blueprint_privado)
      errors.push(dtoError('blueprint', 'formaProducto.blueprint_privado', 'requerido'));
    if (!Array.isArray(state.desarrolloResultados))
      errors.push(dtoError('blueprint', 'desarrolloResultados', 'debe ser array'));
    return dtoResult(errors);
  },
};

// ── DTOs de SALIDA (postcondiciones) ─────────────────────────────────────────

const OUTPUT_DTOS = {

  destino: (state) => {
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'destino');
    return dtoResult(complete ? [] : [dtoError('destino', 'slots', `incompletos: [${missing.join(', ')}]`)]);
  },

  destilar: (state) => {
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'destilar');
    return dtoResult(complete ? [] : [dtoError('destilar', 'slots', `incompletos: [${missing.join(', ')}]`)]);
  },

  traducir: (state) => {
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'traducir');
    return dtoResult(complete ? [] : [dtoError('traducir', 'slots', `incompletos: [${missing.join(', ')}]`)]);
  },

  ascenso: (state) => {
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'ascenso');
    return dtoResult(complete ? [] : [dtoError('ascenso', 'slots', `incompletos: [${missing.join(', ')}]`)]);
  },

  darvida: (state) => {
    const { complete, missing } = validateGramaticaComplete(state.slots || {}, 'darvida');
    return dtoResult(complete ? [] : [dtoError('darvida', 'slots', `incompletos: [${missing.join(', ')}]`)]);
  },

  inferencia: (state) => {
    const errors = [];
    if (!state.avatarInferido || Object.keys(state.avatarInferido).length === 0)
      errors.push(dtoError('inferencia', 'avatarInferido', 'debe tener al menos un campo anclado'));
    if (!state.promesaInferida?.valor)
      errors.push(dtoError('inferencia', 'promesaInferida.valor', 'requerido'));
    if (!state.promesaInferida?.evidencia)
      errors.push(dtoError('inferencia', 'promesaInferida.evidencia', 'requerida'));
    return dtoResult(errors);
  },

  opciones: (state) => {
    const errors = [];
    if (!state.avatarElegido)
      errors.push(dtoError('opciones', 'avatarElegido', 'el experto debe haber elegido'));
    if (!state.promesaElegida)
      errors.push(dtoError('opciones', 'promesaElegida', 'el experto debe haber elegido'));
    return dtoResult(errors);
  },

  arquitectura: (state) => {
    const errors = [];
    if (!state.arquitecturaElegida?.modulos?.length)
      errors.push(dtoError('arquitectura', 'arquitecturaElegida.modulos', 'debe ser array no vacío'));
    return dtoResult(errors);
  },

  evidencia: (state) => {
    const errors = [];
    if (!Array.isArray(state.evidenciasModulos) || state.evidenciasModulos.length === 0)
      errors.push(dtoError('evidencia', 'evidenciasModulos', 'debe ser array no vacío'));
    return dtoResult(errors);
  },

  forma: (state) => {
    const errors = [];
    if (!state.formaProducto?.producto_estructura)
      errors.push(dtoError('forma', 'formaProducto.producto_estructura', 'requerido'));
    if (!state.formaProducto?.blueprint_privado)
      errors.push(dtoError('forma', 'formaProducto.blueprint_privado', 'requerido'));
    return dtoResult(errors);
  },

  desarrollo: (state) => {
    const errors = [];
    if (!Array.isArray(state.desarrolloResultados) || state.desarrolloResultados.length === 0)
      errors.push(dtoError('desarrollo', 'desarrolloResultados', 'debe ser array no vacío'));
    else {
      state.desarrolloResultados.forEach((r, i) => {
        if (!r.titulo) errors.push(dtoError('desarrollo', `desarrolloResultados[${i}].titulo`, 'requerido'));
        if (!Array.isArray(r.experiencias) && !r.contenido)
          errors.push(dtoError('desarrollo', `desarrolloResultados[${i}]`, 'debe tener experiencias o contenido'));
      });
    }
    return dtoResult(errors);
  },

  // bonus: salida opcional — sin postcondición de salida
  bonus: (_state) => dtoResult([]),

  // blueprint: render, no estado — sin postcondición de salida
  blueprint: (_state) => dtoResult([]),
};

/**
 * Valida la entrada de una etapa.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateInput(etapa, state) {
  const dto = INPUT_DTOS[etapa];
  if (!dto) return { valid: true, errors: [] }; // etapa desconocida: no bloquear
  return dto(state);
}

/**
 * Valida la salida de una etapa.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateOutput(etapa, state) {
  const dto = OUTPUT_DTOS[etapa];
  if (!dto) return { valid: true, errors: [] };
  return dto(state);
}

module.exports = {
  validateInput,
  validateOutput,
  INPUT_DTOS,
  OUTPUT_DTOS,
};
