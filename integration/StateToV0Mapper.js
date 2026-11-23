'use strict';

/**
 * STATE TO V0 MAPPER
 * Traduce el StateDTO completo del Motor Cognitivo al formato exacto
 * que esperan las variables y renders legacy de circulo_v0.html.
 *
 * Función pura: no muta el StateDTO, devuelve copias serializables,
 * no contiene lógica cognitiva ni decisiones nuevas.
 *
 * Ref: Task 6.5B3 — plan de eliminación de bypasses downstream.
 *
 * Variables de v0 que produce:
 *   inferredAvatar       — objeto con campos de valor/evidencia/confianza
 *   inferredPromesa      — { valor, evidencia }
 *   window.__seleccion   — { avatar: {label,texto}, promesa: {label,texto,porque} }
 *   window.__arqElegida  — { modulos: [{titulo, funcion_transformadora, cambio_observable, anclaje}] }
 *   window.__evidencias  — [{ modulo, evidencia, como_se_reconoce, anclaje }]
 *   window.__formaProducto — { producto_estructura, blueprint_privado }
 *   desarrolloResultados — [{ titulo, experiencias, ejercicio, materiales_pendientes }]
 *   window.__bonus       — { bonus_recomendado, bonus_alternativo }
 */

/**
 * Convierte el StateDTO del Motor al mapa de variables globales de v0.
 *
 * @param {object} stateDTO — StateDTO producido por ApiDTOs.stateDTO()
 * @returns {V0Globals} objeto con todas las variables esperadas por v0
 * @throws {Error} si stateDTO no es un objeto válido
 */
function mapStateToV0Globals(stateDTO) {
  if (!stateDTO || typeof stateDTO !== 'object' || Array.isArray(stateDTO))
    throw new Error('StateToV0Mapper: stateDTO debe ser un objeto no nulo');
  if (typeof stateDTO.sesionId !== 'string')
    throw new Error('StateToV0Mapper: stateDTO.sesionId es requerido');

  // ── inferredAvatar ────────────────────────────────────────────────────────
  // v0 usa: inferredAvatar.campo.valor / Object.keys(inferredAvatar).length > 0
  // Motor produce: { campo: { valor, evidencia, confianza } }
  const inferredAvatar = stateDTO.avatarInferido
    ? JSON.parse(JSON.stringify(stateDTO.avatarInferido))
    : null;

  // ── inferredPromesa ───────────────────────────────────────────────────────
  // v0 usa: inferredPromesa.valor / inferredPromesa para renderInferencePanel
  const inferredPromesa = stateDTO.promesaInferida
    ? JSON.parse(JSON.stringify(stateDTO.promesaInferida))
    : null;

  // ── window.__seleccion ────────────────────────────────────────────────────
  // v0 usa: window.__seleccion.avatar y .promesa (objetos con .label y .texto)
  // Formato esperado por elegirOpcion y runArquitectura:
  //   avatar:  { label: string, texto: string }
  //   promesa: { label: string, texto: string, porque: string }
  const seleccion = {
    avatar:  stateDTO.avatarElegido
      ? JSON.parse(JSON.stringify(stateDTO.avatarElegido))
      : null,
    promesa: stateDTO.promesaElegida
      ? JSON.parse(JSON.stringify(stateDTO.promesaElegida))
      : null,
  };

  // ── window.__arqElegida ───────────────────────────────────────────────────
  // v0 usa: window.__arqElegida.modulos (array con .titulo, etc.)
  const arqElegida = stateDTO.arquitecturaElegida
    ? JSON.parse(JSON.stringify(stateDTO.arquitecturaElegida))
    : null;

  // ── window.__evidencias ───────────────────────────────────────────────────
  // v0 usa: window.__evidencias[i].modulo, .evidencia, .como_se_reconoce, .anclaje
  // Fallback: si no hay evidencias pero sí arquitectura, reconstruir desde módulos
  // (misma lógica que PIPELINE_CONTRATOS.evidencia.reconstruir en v0)
  let evidencias = [];
  if (Array.isArray(stateDTO.evidenciasModulos) && stateDTO.evidenciasModulos.length > 0) {
    evidencias = JSON.parse(JSON.stringify(stateDTO.evidenciasModulos));
  } else if (arqElegida && Array.isArray(arqElegida.modulos) && arqElegida.modulos.length > 0) {
    evidencias = arqElegida.modulos.map(m => ({
      modulo:           m.titulo,
      evidencia:        m.cambio_observable || m.que_contiene || '',
      como_se_reconoce: '',
      anclaje:          'reconstruido del módulo',
    }));
  }

  // ── window.__formaProducto ────────────────────────────────────────────────
  // v0 usa: .producto_estructura.modulos y .blueprint_privado
  const formaProducto = stateDTO.formaProducto
    ? JSON.parse(JSON.stringify(stateDTO.formaProducto))
    : null;

  // ── desarrolloResultados ──────────────────────────────────────────────────
  // v0 usa: desarrolloResultados.map((r,i)=>{r.titulo, r.experiencias, r.ejercicio})
  const desarrolloResultados = Array.isArray(stateDTO.desarrolloResultados)
    ? JSON.parse(JSON.stringify(stateDTO.desarrolloResultados))
    : [];

  // ── window.__bonus ────────────────────────────────────────────────────────
  // v0 usa: window.__bonus.bonus_recomendado.nombre
  const bonus = stateDTO.bonus
    ? JSON.parse(JSON.stringify(stateDTO.bonus))
    : null;

  return Object.freeze({
    inferredAvatar,
    inferredPromesa,
    '__seleccion':        seleccion,
    '__arqElegida':       arqElegida,
    '__evidencias':       evidencias,
    '__formaProducto':    formaProducto,
    desarrolloResultados,
    '__bonus':            bonus,
  });
}

/**
 * Aplica los globals producidos por mapStateToV0Globals a un objeto scope (window en browser).
 * Helper para el artefacto de integración — no disponible en Node (no hay window).
 *
 * @param {object} scope — window o equivalente
 * @param {V0Globals} globals — resultado de mapStateToV0Globals
 */
function applyV0Globals(scope, globals) {
  if (!scope || typeof scope !== 'object')
    throw new Error('StateToV0Mapper.applyV0Globals: scope es requerido');
  if (!globals || typeof globals !== 'object')
    throw new Error('StateToV0Mapper.applyV0Globals: globals es requerido');

  // inferredAvatar e inferredPromesa son variables locales en v0 (no window.__), por lo que
  // el bridge debe asignarlas a window para que sean accesibles desde el scope global
  scope.inferredAvatar  = globals.inferredAvatar;
  scope.inferredPromesa = globals.inferredPromesa;
  scope.__seleccion     = globals['__seleccion'];
  scope.__arqElegida    = globals['__arqElegida'];
  scope.__evidencias    = globals['__evidencias'];
  scope.__formaProducto = globals['__formaProducto'];
  scope.desarrolloResultados = globals.desarrolloResultados;
  scope.__bonus         = globals['__bonus'];
}

module.exports = { mapStateToV0Globals, applyV0Globals };
