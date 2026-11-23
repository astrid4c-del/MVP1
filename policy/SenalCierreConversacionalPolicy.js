'use strict';

/**
 * SEÑAL CONVERSACIONAL DE CIERRE (P1-A, circulomejora006).
 *
 * Observa una conducta del experto SOBRE LA CONVERSACIÓN MISMA — pide
 * avanzar, o declara que ya no tiene más que aportar — nunca conocimiento
 * de su dominio. Deliberadamente separada de GrafoConocimientoPolicy: esto
 * no es un concepto, no tiene autoridad experto/inferido, no entra al
 * grafo. P1-A solo REPRESENTA y CONSERVA la señal — no decide nada con
 * ella (eso es autoridad futura de P1-B, ver auditoría P1-D).
 *
 * Catálogo cerrado, deliberadamente pequeño (solo lo que A4 demostró con
 * evidencia real — ver auditoría P1-D). Reutilizable, en principio, por
 * cualquier gramática (la conducta de pedir avanzar no es específica de
 * DESTINO) — pero P1-A solo la integra y prueba en DESTINO; este módulo no
 * conoce gramáticas ni protocolos, solo clasifica.
 */

const TIPOS_SENAL_CIERRE = Object.freeze(['SOLICITA_AVANZAR', 'DECLARA_EXPLORACION_AGOTADA']);

const CAUSAS_DESCARTE = Object.freeze({
  ITEM_MAL_FORMADO: 'ITEM_MAL_FORMADO',
  TIPO_FUERA_DE_CATALOGO: 'TIPO_FUERA_DE_CATALOGO',
  EVIDENCIA_NO_LITERAL: 'EVIDENCIA_NO_LITERAL',
});

function normalizarParaComparar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Literal, no sustantivo: a diferencia de GrafoConocimientoPolicy.
 * contenidoEsExtractivo (que exige un mínimo de palabras porque respalda
 * conocimiento de dominio), una señal de cierre suele ser una frase corta
 * ("¿podemos avanzar?") — el único requisito real es que el fragmento
 * exista, literalmente (salvo mayúsculas/acentos/espacios), en el mensaje
 * de ESTE turno. Nunca vuelve a interpretar el mensaje: solo verifica
 * trazabilidad.
 */
function esFragmentoLiteral(evidenciaTextual, mensajeUsuario) {
  if (!evidenciaTextual || typeof evidenciaTextual !== 'string') return false;
  if (!mensajeUsuario || typeof mensajeUsuario !== 'string') return false;
  const normalizado = normalizarParaComparar(evidenciaTextual);
  if (!normalizado) return false;
  return normalizarParaComparar(mensajeUsuario).includes(normalizado);
}

/**
 * Clasifica el bloque crudo `observacionesConversacionales` declarado por
 * Capa 1 contra el mensaje real de este turno. Nunca lanza: un ítem
 * inválido se descarta con su causa, sin invalidar los demás ni el resto
 * del contrato del turno (Ley de Degradación aplicada a este bloque,
 * nunca de rechazo — mismo principio que autoridadGobernada, pero un
 * contrato deliberadamente distinto: aquí no hay degradación a un tipo
 * más débil, solo aceptación o descarte).
 * @returns {{ aceptadas: Array<{tipo:string, evidenciaTextual:string}>, descartadas: Array<{tipoDeclarado, evidenciaDeclarada, causaDescarte}> }}
 */
function clasificarSenalesCierreConversacional(observacionesConversacionales, mensajeUsuario) {
  const aceptadas = [];
  const descartadas = [];
  const lista = Array.isArray(observacionesConversacionales) ? observacionesConversacionales : [];

  for (const item of lista) {
    if (!item || typeof item !== 'object') {
      descartadas.push({ tipoDeclarado: null, evidenciaDeclarada: null, causaDescarte: CAUSAS_DESCARTE.ITEM_MAL_FORMADO });
      continue;
    }
    const tipoDeclarado = item.tipo;
    const evidenciaDeclarada = typeof item.evidenciaTextual === 'string' ? item.evidenciaTextual : null;
    if (!TIPOS_SENAL_CIERRE.includes(tipoDeclarado)) {
      descartadas.push({ tipoDeclarado: tipoDeclarado ?? null, evidenciaDeclarada, causaDescarte: CAUSAS_DESCARTE.TIPO_FUERA_DE_CATALOGO });
      continue;
    }
    if (!esFragmentoLiteral(evidenciaDeclarada, mensajeUsuario)) {
      descartadas.push({ tipoDeclarado, evidenciaDeclarada, causaDescarte: CAUSAS_DESCARTE.EVIDENCIA_NO_LITERAL });
      continue;
    }
    aceptadas.push({ tipo: tipoDeclarado, evidenciaTextual: evidenciaDeclarada });
  }

  return { aceptadas, descartadas };
}

module.exports = {
  TIPOS_SENAL_CIERRE,
  CAUSAS_DESCARTE,
  esFragmentoLiteral,
  clasificarSenalesCierreConversacional,
};
