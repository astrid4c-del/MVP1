'use strict';

/**
 * PIPELINE CONTRACTS
 * Formalización tipada de PIPELINE_CONTRATOS de circulo_v0.
 * Cada contrato declara: recibe, entrega, valida(), reconstruir(),
 * postcondicion(), eventosEmite[], mensajeUsuario.
 *
 * Ref: Blueprint Cap. 4; Contract.js; EPIC 02.
 * Origen: formaliza entrarEtapa() + PIPELINE_CONTRATOS de circulo_v0.
 *
 * PRESERVACIÓN: ningún prompt, modelo ni lógica de Inteligencia fue modificado.
 * Solo se formalizó la estructura de contrato existente.
 */

const { createContract, evaluateContract, verifyPostcondition } = require('../schemas/Contract');
const { validateGramaticaComplete } = require('../schemas/AgoraSlots');
const { validateInput, validateOutput } = require('./ContractDTOs');

// ── Helper: adapta DTO (devuelve boolean) para la interfaz valida() del contrato ──
// valida() solo necesita boolean; los errores detallados se obtienen con validateInput()
const dto = (etapa) => (state) => validateInput(etapa, state).valid;
const dtoPost = (etapa) => (state) => validateOutput(etapa, state).valid;

// ── Contratos de las 5 gramáticas ─────────────────────────────────────────────

const CONTRACT_DESTINO = createContract({
  id:          'c_destino',
  etapa:       'destino',
  descripcion: 'Gramática DESTINO: descubrir el conocimiento digno de transformarse',
  recibe:      'DTO: sesionId requerido — DESTINO siempre puede arrancar',
  entrega:     'DTO: slots conocimiento, antes, despues, evidencia completos',
  valida:      dto('destino'),
  postcondicion: dtoPost('destino'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved', 'slot.updated'],
  mensajeUsuario: null,
});

const CONTRACT_DESTILAR = createContract({
  id:          'c_destilar',
  etapa:       'destilar',
  descripcion: 'Gramática DESTILAR: extraer el saber tácito del experto',
  recibe:      'DTO: slots de DESTINO completos (conocimiento, antes, despues, evidencia)',
  entrega:     'DTO: slots obvio, errores, esencia completos',
  valida:      dto('destilar'),
  postcondicion: dtoPost('destilar'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved'],
  mensajeUsuario: 'Necesito que completemos el destino antes de destilar.',
});

const CONTRACT_TRADUCIR = createContract({
  id:          'c_traducir',
  etapa:       'traducir',
  descripcion: 'Gramática TRADUCIR: definir al aprendiz y calibrar el saber a él',
  recibe:      'DTO: slots de DESTINO y DESTILAR completos',
  entrega:     'DTO: slots relevancia, mundo_real, secuencia completos',
  valida:      dto('traducir'),
  postcondicion: dtoPost('traducir'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved'],
  mensajeUsuario: 'Déjame revisar lo que descubrimos antes de continuar.',
});

const CONTRACT_ASCENSO = createContract({
  id:          'c_ascenso',
  etapa:       'ascenso',
  descripcion: 'Gramática ASCENSO: diseñar el traspaso del criterio al aprendiz',
  recibe:      'DTO: slots de DESTINO, DESTILAR y TRADUCIR completos',
  entrega:     'DTO: slots ensayo, prueba_propia, escalon completos',
  valida:      dto('ascenso'),
  postcondicion: dtoPost('ascenso'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved'],
  mensajeUsuario: 'Necesito que completemos las etapas anteriores primero.',
});

const CONTRACT_DARVIDA = createContract({
  id:          'c_darvida',
  etapa:       'darvida',
  descripcion: 'Gramática DAR VIDA: instalar una voz interior permanente en el aprendiz',
  recibe:      'DTO: slots de las 4 gramáticas anteriores completos',
  entrega:     'DTO: slots voz, momento_solo, vida_propia completos',
  valida:      dto('darvida'),
  postcondicion: dtoPost('darvida'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved'],
  mensajeUsuario: 'Necesito que completemos el recorrido antes de dar vida.',
});

// ── Contratos del Motor de Inferencia y etapas downstream ─────────────────────

const CONTRACT_INFERENCIA = createContract({
  id:          'c_inferencia',
  etapa:       'inferencia',
  descripcion: 'Motor de Inferencia: deriva Avatar y Promesa desde los 16 slots',
  recibe:      'DTO: slots.destino completos (mínimo requerido para producir Avatar con anclaje)',
  entrega:     'DTO: avatarInferido con ≥1 campo anclado + promesaInferida con valor y evidencia',
  valida:      dto('inferencia'),
  reconstruir: (_state) => false,
  postcondicion: dtoPost('inferencia'),
  eventosEmite: ['intelligence.started', 'intelligence.completed'],
  mensajeUsuario: 'Dame un momento para poner en orden todo lo que descubrimos juntos…',
});

const CONTRACT_OPCIONES = createContract({
  id:          'c_opciones',
  etapa:       'opciones',
  descripcion: 'Presentar opciones de Avatar y Promesa al experto para que elija',
  recibe:      'DTO: avatarInferido objeto no nulo con al menos un campo anclado',
  entrega:     'DTO: avatarElegido y promesaElegida presentes',
  valida:      dto('opciones'),
  reconstruir: (_state) => false,
  postcondicion: dtoPost('opciones'),
  eventosEmite: ['gate.approved', 'decision.created'],
  mensajeUsuario: null,
});

const CONTRACT_ARQUITECTURA = createContract({
  id:          'c_arquitectura',
  etapa:       'arquitectura',
  descripcion: 'Diseñar la arquitectura de módulos del producto',
  recibe:      'DTO: avatarElegido y promesaElegida presentes',
  entrega:     'DTO: arquitecturaElegida.modulos array no vacío',
  valida:      dto('arquitectura'),
  reconstruir: (state) => {
    if (!state.avatarElegido  && state._avatarOpciones?.[0])  state.avatarElegido  = state._avatarOpciones[0];
    if (!state.promesaElegida && state._promesaOpciones?.[0]) state.promesaElegida = state._promesaOpciones[0];
    return !!(state.avatarElegido && state.promesaElegida);
  },
  postcondicion: dtoPost('arquitectura'),
  eventosEmite: ['intelligence.started', 'intelligence.completed', 'gate.approved', 'decision.created'],
  mensajeUsuario: 'Déjame ordenar el camino un momento…',
});

const CONTRACT_EVIDENCIA = createContract({
  id:          'c_evidencia',
  etapa:       'evidencia',
  descripcion: 'Definir qué evidencia demuestra el cambio de cada módulo',
  recibe:      'DTO: arquitecturaElegida.modulos array no vacío con campos requeridos validados',
  entrega:     'DTO: evidenciasModulos array no vacío',
  valida:      dto('evidencia'),
  reconstruir: (_state) => false,
  postcondicion: dtoPost('evidencia'),
  eventosEmite: ['intelligence.started', 'intelligence.completed'],
  mensajeUsuario: 'Déjame revisar el camino un momento…',
});

const CONTRACT_FORMA = createContract({
  id:          'c_forma',
  etapa:       'forma',
  descripcion: 'Decidir la coherencia global del producto y producir los 2 activos',
  recibe:      'DTO: evidenciasModulos array no vacío con campos requeridos validados',
  entrega:     'DTO: formaProducto con producto_estructura y blueprint_privado',
  valida:      dto('forma'),
  reconstruir: (state) => {
    if ((!state.evidenciasModulos || !state.evidenciasModulos.length) &&
        state.arquitecturaElegida?.modulos?.length > 0) {
      state.evidenciasModulos = state.arquitecturaElegida.modulos.map(m => ({
        modulo:    m.titulo,
        evidencia: m.cambio_observable || m.que_contiene || '',
        anclaje:   'reconstruido del módulo',
      }));
      return state.evidenciasModulos.length > 0;
    }
    return false;
  },
  postcondicion: dtoPost('forma'),
  eventosEmite: ['intelligence.started', 'intelligence.completed'],
  mensajeUsuario: 'Déjame darle forma a esto un momento…',
});

const CONTRACT_DESARROLLO = createContract({
  id:          'c_desarrollo',
  etapa:       'desarrollo',
  descripcion: 'Desarrollar el contenido real de cada módulo',
  recibe:      'DTO: formaProducto.producto_estructura.modulos array no vacío + blueprint_privado',
  entrega:     'DTO: desarrolloResultados array no vacío con titulo y experiencias/contenido',
  valida:      dto('desarrollo'),
  reconstruir: (_state) => false,
  postcondicion: dtoPost('desarrollo'),
  eventosEmite: ['intelligence.started', 'intelligence.completed'],
  mensajeUsuario: 'Déjame preparar el contenido un momento…',
});

const CONTRACT_BONUS = createContract({
  id:          'c_bonus',
  etapa:       'bonus',
  descripcion: 'Proponer el acompañante estratégico del producto (opcional)',
  recibe:      'DTO: avatarElegido presente',
  entrega:     'state.bonus (opcional — sin postcondición)',
  valida:      dto('bonus'),
  reconstruir: (_state) => false,
  postcondicion: null,
  eventosEmite: ['intelligence.started', 'intelligence.completed'],
  mensajeUsuario: null,
});

const CONTRACT_BLUEPRINT = createContract({
  id:          'c_blueprint',
  etapa:       'blueprint',
  descripcion: 'Render final de los 2 activos',
  recibe:      'DTO: formaProducto.blueprint_privado + desarrolloResultados array',
  entrega:     'render final — sin postcondición de estado',
  valida:      dto('blueprint'),
  reconstruir: (_state) => false,
  postcondicion: null,
  eventosEmite: ['pipeline.completed'],
  mensajeUsuario: 'Déjame reunir todo lo que construimos…',
});

// ── Registro de contratos ──────────────────────────────────────────────────────

const ALL_CONTRACTS = Object.freeze({
  destino:      CONTRACT_DESTINO,
  destilar:     CONTRACT_DESTILAR,
  traducir:     CONTRACT_TRADUCIR,
  ascenso:      CONTRACT_ASCENSO,
  darvida:      CONTRACT_DARVIDA,
  inferencia:   CONTRACT_INFERENCIA,
  opciones:     CONTRACT_OPCIONES,
  arquitectura: CONTRACT_ARQUITECTURA,
  evidencia:    CONTRACT_EVIDENCIA,
  forma:        CONTRACT_FORMA,
  desarrollo:   CONTRACT_DESARROLLO,
  bonus:        CONTRACT_BONUS,
  blueprint:    CONTRACT_BLUEPRINT,
});

const PIPELINE_ORDER = Object.freeze([
  'destino','destilar','traducir','ascenso','darvida',
  'inferencia','opciones','arquitectura','evidencia',
  'forma','desarrollo','bonus','blueprint',
]);

/**
 * Evalúa el contrato de una etapa contra un estado.
 * Ref: entrarEtapa() de circulo_v0.
 */
function enterStage(etapa, state) {
  const contract = ALL_CONTRACTS[etapa];
  if (!contract) return { ok: true, reconstruido: false, mensajeUsuario: null }; // etapa desconocida: no bloquear
  return evaluateContract(contract, state);
}

/**
 * Verifica la postcondición de una etapa.
 */
function verifyStage(etapa, state) {
  const contract = ALL_CONTRACTS[etapa];
  if (!contract) return { ok: true };
  return verifyPostcondition(contract, state);
}

module.exports = {
  ALL_CONTRACTS,
  PIPELINE_ORDER,
  enterStage,
  verifyStage,
  validateInput,   // DTO formal de entrada — errores estructurados
  validateOutput,  // DTO formal de salida — errores estructurados
  // Exportar contratos individuales para tests
  CONTRACT_DESTINO, CONTRACT_DESTILAR, CONTRACT_TRADUCIR,
  CONTRACT_ASCENSO, CONTRACT_DARVIDA, CONTRACT_INFERENCIA,
  CONTRACT_OPCIONES, CONTRACT_ARQUITECTURA, CONTRACT_EVIDENCIA,
  CONTRACT_FORMA, CONTRACT_DESARROLLO, CONTRACT_BONUS, CONTRACT_BLUEPRINT,
};
