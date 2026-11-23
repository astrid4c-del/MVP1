'use strict';

/**
 * STRUCTURAL_REBIND_PRESERVES_OPPORTUNITY_MISSION_DIMENSION (C007, cocina_c0
 * turn 16).
 *
 * STRUCTURAL_REBIND MAY BIND IDENTITY BUT MUST NOT REWRITE ALREADY-DECLARED
 * MISSION SEMANTICS. SEMANTIC_UNKNOWN_IDENTITY != AUTHORITY_TO_REWRITE_
 * OPPORTUNITY_DIMENSION. One lifecycle fact, one authority:
 *   - frontier entry : describes an existing unresolved semantic unknown
 *                      truthfully (its OWN native dimension, and the
 *                      dimensions it affects in the certified projection);
 *   - opportunity    : the current mission need the Producer proposed (its
 *                      declared dimension is the Producer's, and Objective's
 *                      to arbitrate -- never the rebind's);
 *   - rebind         : tests whether the two refer to the same executable
 *                      need. It never manufactures sameness by rewriting
 *                      either side.
 *
 * Pure, grammar-agnostic: no dimension name is read here.
 */

const { dimensionDeProcedencia } = require('../state/GrafoProyeccion');

const textoNoVacio = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The unknown's own native mission dimension (a lifecycle fact), or null. */
function dimensionNativaDeDesconocido(desconocido) {
  return desconocido ? textoNoVacio(desconocido.dimension) : null;
}

/**
 * The dimensions an open unknown AFFECTS in the certified projection
 * (GrafoProyeccion.dimensionesConIncertidumbresRelevantes): the dimensions of
 * the governed concepts it is OVER. An open relevant unknown over a concept of
 * dimension D is, by that existing authority, the open obligation that keeps D
 * pending -- so it is a legitimate obligation for a need declared on D even
 * when its own native dimension is a different one.
 */
function dimensionesAfectadasPorDesconocido(desconocido, conceptos) {
  const lista = Array.isArray(conceptos) ? conceptos : [];
  const sobre = desconocido && Array.isArray(desconocido.sobreConceptos) ? desconocido.sobreConceptos : [];
  return [...new Set(sobre
    .map(id => lista.find(c => c && c.id === id))
    .filter(Boolean)
    .map(c => dimensionDeProcedencia(c.procedencia))
    .filter(Boolean))];
}

/**
 * Can an opportunity that declared `dimensionDeclarada` be bound to the
 * frontier entry `descriptor`? Equality with the unknown's native dimension, or
 * membership in the dimensions the unknown affects (the already-certified
 * relation above) -- nothing else: no sibling-dimension compatibility is
 * invented, and a grammar-level placeholder (`missionNeedRef`) is never read as
 * the unknown's dimension. An opportunity that declared no dimension, or an
 * unknown that carries no dimension information at all, has nothing to
 * contradict.
 */
function dimensionCoherenteConBinding(dimensionDeclarada, descriptor) {
  const declarada = textoNoVacio(dimensionDeclarada);
  if (!declarada || !descriptor) return true;
  const propias = new Set([
    textoNoVacio(descriptor.unknownDimension),
    ...(Array.isArray(descriptor.unknownDimensionesAfectadas) ? descriptor.unknownDimensionesAfectadas : []),
  ].filter(Boolean));
  return propias.size === 0 || propias.has(declarada);
}

/**
 * The dimension the rebound opportunity carries. A dimension the Producer
 * declared is never overwritten; only an opportunity that declared none
 * inherits the bound unknown's NATIVE dimension (legacy frontier bookkeeping,
 * `missionNeedRef`, only when the unknown carries none either).
 */
function dimensionTrasRebind(dimensionDeclarada, descriptor) {
  return textoNoVacio(dimensionDeclarada)
    || (descriptor && textoNoVacio(descriptor.unknownDimension))
    || (descriptor && textoNoVacio(descriptor.missionNeedRef))
    || null;
}

module.exports = {
  dimensionNativaDeDesconocido,
  dimensionesAfectadasPorDesconocido,
  dimensionCoherenteConBinding,
  dimensionTrasRebind,
};
