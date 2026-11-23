'use strict';

/**
 * Plantilla mecánica compartida — la MISMA fuente para cualquier entidad de
 * 'destino' que necesite derivar una formulación causal desde una
 * estructura de 4 roles (inicio/mecanismo/resultado/observabilidad).
 *
 * Extraída de _ComposicionTransformacionalDestinoProcessLocal.js para que
 * _HipotesisTransformacionalDestinoProcessLocal.js la reutilice sin
 * duplicar la lógica — una sola plantilla, nunca dos copias que puedan
 * divergir. Pura, determinística, sin LLM, sin regex semántico.
 */

/**
 * Corrección puramente mecánica de mayúscula/puntuación al unir un
 * conector fijo con el texto real de un concepto — NUNCA semántica, nunca
 * sinónimos, nunca Realizador. El conector siempre termina en ":" y el
 * fragmento continúa como cláusula subordinada: si el fragmento empieza
 * con mayúscula, se minúsculiza SOLO esa primera letra para la
 * concatenación — el texto ORIGINAL almacenado nunca se toca.
 */
function minusculaInicial(texto) {
  if (!texto) return texto;
  return texto.charAt(0).toLowerCase() + texto.slice(1);
}

// circulomejora006_reporte03 — productividad de PresentacionTransformacionalEstructurada.
// Único vocabulario de conectores fijos de la plantilla — nunca duplicado en
// otro archivo. El orden de este array ES el orden causal de la formulación;
// tanto construirFormulacionDesdeEstructura como
// construirRenderEstructuradoDesdeEstructura (abajo) lo recorren igual, para
// que ambas funciones sean, por construcción, la MISMA fuente.
const CONECTORES_POR_ROL = Object.freeze([
  Object.freeze({ rol: 'inicio', conector: 'Partiendo de: ' }),
  Object.freeze({ rol: 'mecanismo', conector: 'Mediante: ' }),
  Object.freeze({ rol: 'resultado', conector: 'Se llega a: ' }),
  Object.freeze({ rol: 'observabilidad', conector: 'Esto se sabrá porque: ' }),
]);

// Versión del contrato de render por unidad — participa en la identidad
// congelada de HipotesisTransformacionalDestino (ver
// renderPorUnidad/versionContratoRender en el schema), nunca en la
// formulación textual: una futura plantilla con conectores o estructura
// distintos nunca colisiona en silencio con render capturado bajo esta
// versión.
const VERSION_CONTRATO_RENDER_ACTUAL = 1;

/**
 * Invariante obligatorio: estructura causal → formulación, siempre en esta
 * dirección. Plantilla mínima y estable — ninguna variación de redacción
 * conversacional. Pura: misma estructura siempre produce el mismo texto.
 *
 * Limitación conocida y documentada (nunca oculta): cuando el texto de
 * `inicio` ya empieza con un marcador temporal ("antes..."), el conector
 * fijo "Partiendo de:" puede sonar redundante. Corregir eso requeriría
 * decidir, por contenido, cuándo omitir el conector — eso ya sería juicio
 * sobre el texto (prohibido) — así que se deja así, documentado.
 *
 * circulomejora006_reporte03 (productividad de PresentacionTransformacionalEstructurada)
 * — esta función ahora es un envoltorio delgado sobre
 * construirRenderEstructuradoDesdeEstructura (misma plantilla, nunca una
 * segunda copia que pueda divergir): construye el render completo (texto +
 * unidades con offsets) y devuelve solo `.texto`, preservando exactamente
 * el contrato/firma que ya usan _ComposicionTransformacionalDestinoProcessLocal.js
 * y _HipotesisTransformacionalDestinoProcessLocal.js.
 *
 * @param {object} estructura — { inicio, mecanismo, resultado, observabilidad },
 *   cada uno { descripcionResumen }
 */
function construirFormulacionDesdeEstructura(estructura) {
  return construirRenderEstructuradoDesdeEstructura(estructura).texto;
}

/**
 * circulomejora006_reporte03 — misma plantilla que construirFormulacionDesdeEstructura,
 * pero conserva ADEMÁS, por rol, el texto exacto insertado y su offset
 * dentro del texto completo — calculado determinísticamente mientras se
 * construye la cadena (nunca por un parseo/regex posterior sobre el blob ya
 * ensamblado). Es la ÚNICA fuente legítima del "render por unidad" que
 * HipotesisTransformacionalDestino debe congelar en el momento de creación
 * — nunca se vuelve a invocar sobre datos releídos del grafo después.
 *
 * @param {object} estructura — { inicio, mecanismo, resultado, observabilidad },
 *   cada uno { descripcionResumen }
 * @returns {{ texto: string, unidades: Array<{rol:string, texto:string, offsetInicio:number, offsetFin:number}> }}
 */
function construirRenderEstructuradoDesdeEstructura(estructura) {
  let texto = '';
  const unidades = [];
  CONECTORES_POR_ROL.forEach(({ rol, conector }, indice) => {
    if (indice > 0) texto += ' ';
    const valorInsertado = minusculaInicial(estructura[rol].descripcionResumen);
    texto += conector;
    const offsetInicio = texto.length;
    texto += valorInsertado;
    const offsetFin = texto.length;
    texto += '.';
    unidades.push(Object.freeze({
      rol, texto: valorInsertado, offsetInicio, offsetFin,
    }));
  });
  return { texto, unidades: Object.freeze(unidades) };
}

/**
 * circulomejora006_reporte03 — reconstruye el texto completo EXCLUSIVAMENTE
 * a partir de un `renderPorUnidad` ya congelado (nunca del grafo, nunca de
 * un nuevo cálculo de descripcionResumen): usa los MISMOS conectores fijos
 * de CONECTORES_POR_ROL sobre `renderPorUnidad[rol].texto`. Sirve como
 * verificación de consistencia interna en el momento de crear la Hipótesis
 * (renderPorUnidad → esta función → debe coincidir byte a byte con
 * formulacionCongelada) — nunca como fuente alternativa de composición.
 *
 * @param {object} renderPorUnidad — { inicio, mecanismo, resultado, observabilidad },
 *   cada uno { texto }
 * @returns {string}
 */
function reconstruirTextoDesdeRenderPorUnidad(renderPorUnidad) {
  return CONECTORES_POR_ROL
    .map(({ rol, conector }) => `${conector}${renderPorUnidad[rol].texto}.`)
    .join(' ');
}

module.exports = {
  minusculaInicial,
  construirFormulacionDesdeEstructura,
  construirRenderEstructuradoDesdeEstructura,
  reconstruirTextoDesdeRenderPorUnidad,
  CONECTORES_POR_ROL,
  VERSION_CONTRATO_RENDER_ACTUAL,
};
