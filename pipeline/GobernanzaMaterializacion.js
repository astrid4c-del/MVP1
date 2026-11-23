'use strict';

/**
 * GOBERNANZA DE MATERIALIZACIÓN — implementación real del Contrato
 * Arquitectónico (Project OS,
 * CONTRATO-Gobernanza-Materializacion-Conversacional.md).
 *
 * Historia de este archivo, relevante para entender su forma actual:
 *   1. Primer flujo gobernado: EXPLORANDO + grafo (commit 5616ae5) — casos
 *      #6/#7 (agotar reintentos de contrato / observación ausente) como
 *      validación. Esa primera versión codificaba la selección como una
 *      prioridad ÚNICA y UNIVERSAL (Transformar > Preservar > Determinista)
 *      aplicada a cualquier contexto, y una única Garantía agregada
 *      (`prosaValidada`) para decidir admisibilidad.
 *   2. Auditoría de cobertura (solo lectura) sobre el resto del perímetro
 *      V2+grafo detectó que esa prioridad universal era, en realidad, la
 *      Política de selección de UN SOLO contexto (EXPLORANDO_GRAFO) — nunca
 *      una ley de la Gobernanza. Se corrige (commit 23b766f): selección
 *      declarada por contexto (POLITICAS_SELECCION), y se migran
 *      ESPERANDO_CONFIRMACION/rechaza (→ Determinista) y LISTO_PARA_SINTESIS
 *      (→ Preservar) — los dos únicos caminos que esa auditoría dejó listos
 *      sin decisión de producto nueva.
 *   3. Auditoría de tipado semántico sobre `prosaValidada`: comparar sus
 *      tres asignaciones reales (EXPLORANDO_GRAFO, ESPERANDO_CONFIRMACION_
 *      RECHAZA, LISTO_PARA_SINTESIS) mostró que el nombre ocultaba fuerzas
 *      semánticas distintas — no un solo hecho, sino hasta tres fusionados
 *      según el contexto (validez de "mensaje", validez del resto del
 *      contrato de campos del estado, y resultado de la evaluación de
 *      elegibilidad del grafo). Este archivo reemplaza `prosaValidada` por
 *      esas tres Garantías atómicas — ver más abajo — y mueve la exigencia
 *      de grafo-aprobado de EXPLORANDO_GRAFO a su propia Política
 *      contextual, en vez de una precondición universal de Transformar/
 *      Preservar.
 *
 * Vocabulario tal cual el Contrato lo define — nunca reinterpretado:
 *   Garantía   — hecho que el pipeline descubrió sobre ESTE turno.
 *   Política   — decisión de producto, declarada, nunca deducida.
 *   Estrategia — forma concreta de materializar, una vez decidida.
 * La Gobernanza combina Garantías + Políticas de ADMISIBILIDAD → determina
 * el conjunto de Estrategias admisibles → aplica la Política de SELECCIÓN
 * del contexto → una Estrategia. Admisibilidad y selección son pasos
 * distintos (Invariante 4) — ninguna Política modifica una Garantía, y
 * ninguna Garantía reemplaza una Política (Invariante 6).
 */

const ESTRATEGIAS = Object.freeze({
  TRANSFORMAR: 'TRANSFORMAR',
  PRESERVAR: 'PRESERVAR',
  DETERMINISTA: 'DETERMINISTA',
  DELEGAR: 'DELEGAR',
  SUPRIMIR: 'SUPRIMIR',
});

/**
 * Contextos declarados — cada uno con su propia Política de selección (ver
 * POLITICAS_SELECCION). Un contexto nuevo se agrega únicamente cuando hay
 * una decisión de producto ya tomada para él; nunca por adelantado.
 */
const CONTEXTOS = Object.freeze({
  EXPLORANDO_GRAFO: 'EXPLORANDO_GRAFO',
  ESPERANDO_CONFIRMACION_RECHAZA: 'ESPERANDO_CONFIRMACION_RECHAZA',
  LISTO_PARA_SINTESIS: 'LISTO_PARA_SINTESIS',
});

/**
 * Resultado de la evaluación de elegibilidad de grafo para ESTE turno —
 * nunca un booleano. NO_APLICA y APROBADA son hechos distintos: el primero
 * dice "el mecanismo no corrió"; el segundo dice "corrió y no encontró
 * violaciones". Tratarlos igual falsificaría una Garantía (Contrato,
 * Invariante 6) cada vez que el mecanismo genuinamente no se ejecutó.
 */
const EVALUACION_GRAFO = Object.freeze({
  NO_APLICA: 'NO_APLICA',
  APROBADA: 'APROBADA',
  RECHAZADA: 'RECHAZADA',
});

/**
 * Precondiciones INTRÍNSECAS de cada Estrategia — qué necesita, de forma
 * puramente estructural/técnica, para poder ejecutarse en absoluto. Esto
 * no es una Política (no es una decisión de producto sobre qué confiar):
 * es lo que el propio mecanismo requiere como insumo, igual que el
 * Contrato §6 lo describe. La decisión de CONFIAR en ese insumo (p. ej.
 * "el contrato de campos también debe haber validado") es, en cambio,
 * responsabilidad de POLITICAS_ADMISIBILIDAD — nunca de esta función.
 */
function precondicionesCumplidas(estrategia, garantias) {
  switch (estrategia) {
    case ESTRATEGIAS.TRANSFORMAR:
      // Transformar (hoy: el Realizador) consume "observacion" — nunca
      // "mensaje" (ver buildRealizadorTurnoConversacional: no recibe ese
      // campo). Su necesidad técnica intrínseca es, exactamente,
      // observacionDisponible. La exigencia de que el resto del turno
      // también sea confiable es una Política (global, más abajo) — no
      // una precondición de la Estrategia misma.
      return garantias.observacionDisponible === true;
    case ESTRATEGIAS.PRESERVAR:
      // Preservar solo necesita, técnicamente, un "mensaje" que mostrar.
      return garantias.mensajeValidado === true;
    case ESTRATEGIAS.DETERMINISTA:
      // Nunca depende de prosa — es la única Estrategia que siempre
      // puede ejecutarse, por diseño (red de seguridad última).
      return true;
    case ESTRATEGIAS.DELEGAR:
      // Errata (auditoría de cobertura post-5616ae5): NINGÚN camino
      // conocido hoy, dentro del perímetro auditado, produce esta
      // Garantía en `true`. La "edición dirigida" de LISTO_PARA_SINTESIS
      // NO la activa — ver CONTRATO §8 (errata): es una instrucción de
      // prompt dentro de la MISMA llamada que produce `mensaje`, nunca un
      // mecanismo separado que ya haya construido el texto bajo su propia
      // autoridad. Delegar sigue en el catálogo como capacidad genuina
      // (Contrato §6) — sin activador real todavía.
      return garantias.materializadorEspecializadoActivo === true;
    case ESTRATEGIAS.SUPRIMIR:
      return garantias.debeSuprimirse === true;
    default:
      return false;
  }
}

/**
 * Catálogo de Políticas de ADMISIBILIDAD — declaradas explícitamente, con
 * su alcance (global vs. contextual, ver Contrato §5). Cada una puede
 * EXCLUIR una Estrategia que ya cumplió sus precondiciones; ninguna puede
 * tocar una Garantía. Nunca deciden CUÁL se ejecuta entre las admisibles
 * — eso es POLITICAS_SELECCION, más abajo.
 */
const POLITICAS_ADMISIBILIDAD = Object.freeze([
  {
    id: 'nunca-confiar-en-prosa-no-validada',
    alcance: 'global',
    // "Prosa" (mensaje u observación) solo se confía cuando el resto del
    // contrato de campos de ESTE estado también validó — un turno que
    // coló campos de otro estado, o falló su propia estructura, es
    // evidencia de que ninguna de las dos prosas de ese turno es
    // confiable, aunque alguna luzca presente. mensajeValidado se exige
    // acá (no en la precondición de Transformar) porque es una cuestión
    // de CONFIANZA en el turno completo, no de qué insumo técnico
    // requiere el Realizador.
    excluye: (estrategia, garantias) =>
      !(garantias.mensajeValidado && garantias.contratoDeCamposValidado) &&
      (estrategia === ESTRATEGIAS.TRANSFORMAR || estrategia === ESTRATEGIAS.PRESERVAR),
  },
  {
    id: 'explorando-grafo-exige-evaluacion-grafo-aprobada',
    alcance: `contextual:${CONTEXTOS.EXPLORANDO_GRAFO}`,
    // Exclusiva de EXPLORANDO_GRAFO: ahí la evaluación de grafo SIEMPRE
    // corre (aplicarDelta se invoca sin condición cuando el contrato de
    // campos validó), así que NO_APLICA nunca ocurre legítimamente en
    // este contexto — exigir === APROBADA (nunca solo "!== RECHAZADA")
    // es correcto acá y no excluye ningún turno real. Otros contextos
    // (p. ej. rechaza, donde NO_APLICA es un resultado legítimo y
    // frecuente) NO llevan esta Política — usan la global únicamente.
    excluye: (estrategia, garantias, contexto) =>
      contexto === CONTEXTOS.EXPLORANDO_GRAFO &&
      garantias.evaluacionGrafo !== EVALUACION_GRAFO.APROBADA &&
      (estrategia === ESTRATEGIAS.TRANSFORMAR || estrategia === ESTRATEGIAS.PRESERVAR),
  },
  {
    id: 'rechazo-nunca-acepta-prosa-libre',
    alcance: `contextual:${CONTEXTOS.ESPERANDO_CONFIRMACION_RECHAZA}`,
    // Ciclo Cognitivo de Descubrimiento (ADR) — un rechazo total no es
    // espacio para que Círculo demuestre comprensión con una
    // reinterpretación propia, aunque el contrato haya validado. Excluye
    // Transformar y Preservar incondicionalmente en este contexto — nunca
    // depende de las Garantías (a diferencia de las dos Políticas de
    // arriba). evaluacionGrafo aquí puede ser NO_APLICA (rechazo sin
    // evidencia nueva) o APROBADA/RECHAZADA (rechazo con conceptosNuevos)
    // — no importa cuál: esta Política ya excluye antes de que eso se
    // consulte.
    excluye: (estrategia, garantias, contexto) =>
      contexto === CONTEXTOS.ESPERANDO_CONFIRMACION_RECHAZA &&
      (estrategia === ESTRATEGIAS.TRANSFORMAR || estrategia === ESTRATEGIAS.PRESERVAR),
  },
]);

/** @returns {string[]} las Estrategias admisibles para estas Garantías en este contexto. */
function estrategiasAdmisibles(garantias, contexto) {
  return Object.values(ESTRATEGIAS).filter(estrategia => {
    if (!precondicionesCumplidas(estrategia, garantias)) return false;
    return !POLITICAS_ADMISIBILIDAD.some(p => p.excluye(estrategia, garantias, contexto));
  });
}

/**
 * Políticas de SELECCIÓN — una lista de prioridad DECLARADA POR CONTEXTO,
 * nunca una prioridad universal del catálogo (esa era la reserva
 * arquitectónica encontrada en la auditoría de cobertura: universalizar
 * la preferencia de EXPLORANDO_GRAFO habría acoplado contextos que deben
 * poder decidir distinto). Cada entrada es, en sí misma, la Política de
 * selección de ese contexto — legible en un solo lugar, nunca repartida
 * en condicionales sueltos.
 *
 * Solo existen entradas para contextos con una decisión de producto ya
 * tomada. Un contexto sin entrada aquí no tiene Política de selección
 * declarada — seleccionarEstrategia() lo trata como tal (null), nunca
 * como "aplícale la de otro contexto".
 */
const POLITICAS_SELECCION = Object.freeze({
  // D-037: preferir el Realizador (Transformar) siempre que sea admisible;
  // Preservar es la degradación segura si Transformar falla en tiempo de
  // ejecución o su precondición no se cumple; Determinista es el piso
  // cuando ni siquiera la prosa es confiable.
  [CONTEXTOS.EXPLORANDO_GRAFO]: [
    ESTRATEGIAS.SUPRIMIR, ESTRATEGIAS.DELEGAR,
    ESTRATEGIAS.TRANSFORMAR, ESTRATEGIAS.PRESERVAR, ESTRATEGIAS.DETERMINISTA,
  ],
  // La Política de admisibilidad de este contexto ya excluyó Transformar
  // y Preservar sin condición — Determinista es, en la práctica, la única
  // admisible. Se declara la lista completa de todos modos, nunca un
  // atajo de "si no hay más remedio", para que quede igual de legible que
  // el resto del catálogo.
  [CONTEXTOS.ESPERANDO_CONFIRMACION_RECHAZA]: [ESTRATEGIAS.DETERMINISTA],
  // LISTO_PARA_SINTESIS nunca produce observacionDisponible (ese campo no
  // existe en su contrato) — Transformar es estructuralmente inadmisible
  // aquí, nunca por Política. Preservar es la selección: la síntesis ya
  // validada de Capa 1 (con o sin "edición dirigida" de prompt) se
  // muestra tal cual.
  [CONTEXTOS.LISTO_PARA_SINTESIS]: [ESTRATEGIAS.PRESERVAR, ESTRATEGIAS.DETERMINISTA],
});

/**
 * Selección entre admisibles — decisión de producto, separada de
 * admisibilidad (Invariante 4). Sin Política de selección declarada para
 * el contexto, no hay default: se devuelve null en vez de asumir una
 * prioridad de otro contexto o una universal — eso es, precisamente, lo
 * que esta corrección existe para prevenir.
 */
function seleccionarEstrategia(admisibles, contexto) {
  const prioridad = POLITICAS_SELECCION[contexto];
  if (!prioridad) return null;
  return prioridad.find(e => admisibles.includes(e)) || null;
}

/**
 * circulomejora006 — Compatibilidad movimiento↔estrategia (Especificación
 * §3, corregida en la ronda final). NUNCA decide ni cambia `seleccionada`
 * — las Garantías conservan precedencia absoluta (el movimiento no puede
 * evadirlas); esto solo TRAZA si la estrategia que Garantías+Políticas ya
 * eligieron es compatible con lo que el movimiento pedía. Cada movimiento
 * exploratorio exige Transformar; REPARAR_TRAS_RECHAZO tolera además
 * Determinista, porque la construcción determinista existente (next_
 * user_action únicamente, sin prosa) ya cumple, por diseño, el mismo
 * requisito de "nunca abstraer, nunca confiar en prosa libre" que la
 * reparación exige — no hace falta una construcción determinista nueva.
 * Preservar nunca es compatible con ningún movimiento de este catálogo:
 * mostrar el "mensaje" de Capa 1 tal cual es, precisamente, lo que un
 * movimiento decidido explícitamente busca evitar.
 */
const MATRIZ_COMPATIBILIDAD_MOVIMIENTO_ESTRATEGIA = Object.freeze({
  // El fallback determinista de Movimiento ya es un HOW válido y
  // autosuficiente para pedir contexto/ejemplo cuando Transformar no está
  // disponible; la matriz debe reflejar esa capacidad existente.
  PEDIR_CONTEXTO: Object.freeze([ESTRATEGIAS.TRANSFORMAR, ESTRATEGIAS.DETERMINISTA]),
  PEDIR_EJEMPLO: Object.freeze([ESTRATEGIAS.TRANSFORMAR, ESTRATEGIAS.DETERMINISTA]),
  REFLEJAR_Y_PROFUNDIZAR: Object.freeze([ESTRATEGIAS.TRANSFORMAR]),
  PROPONER_INTERPRETACION: Object.freeze([ESTRATEGIAS.TRANSFORMAR]),
  REPARAR_TRAS_RECHAZO: Object.freeze([ESTRATEGIAS.TRANSFORMAR, ESTRATEGIAS.DETERMINISTA]),
  // P1-B — mismo tratamiento que REPARAR_TRAS_RECHAZO: su fallback
  // determinista (MovimientoConversacionalPolicy.fallbackMovimientoTrasFalloRealizador)
  // "nunca abstrae, nunca confía en prosa libre" (pide, literalmente, el
  // mismo veredicto cerrado que el Realizador habría pedido) — cumple, por
  // diseño, el mismo requisito que exige tolerar Determinista.
  SOLICITAR_VEREDICTO_INTERPRETACION: Object.freeze([ESTRATEGIAS.TRANSFORMAR, ESTRATEGIAS.DETERMINISTA]),
});

/**
 * @returns {boolean} true si no hay movimiento que verificar (otros
 *   contextos, u otras gramáticas, nunca pasan `contratoMovimiento`), o si
 *   el movimiento declarado tolera la estrategia ya seleccionada.
 */
function compatibleMovimientoEstrategia(movimiento, estrategiaSeleccionada) {
  if (!movimiento) return true;
  const permitidas = MATRIZ_COMPATIBILIDAD_MOVIMIENTO_ESTRATEGIA[movimiento];
  if (!permitidas) return true; // movimiento fuera de este catálogo — defensivo, nunca bloquea
  return permitidas.includes(estrategiaSeleccionada);
}

/**
 * Punto único de entrada — combina §admisibilidad y §selección para un
 * contexto declarado. Con un contexto SIN Política de selección (p. ej.
 * confirma/corrige/ambiguo — deliberadamente no migrados todavía),
 * `seleccionada` vuelve null: el llamador no debe tratar eso como
 * autorización para inventar un comportamiento — significa, literalmente,
 * "este contexto no está gobernado todavía".
 *
 * @param {object} garantias
 * @param {boolean} garantias.mensajeValidado — "mensaje" es un string no
 *   vacío. Único hecho entre "ausente" y "válido" para este campo — no
 *   existe un estado intermedio en este código.
 * @param {boolean} garantias.contratoDeCamposValidado — las restricciones
 *   estructurales ADICIONALES del contrato propio de este contexto (más
 *   allá de "mensaje") se cumplieron — nunca incluye elegibilidad de
 *   grafo. En un contexto sin restricciones adicionales relevantes
 *   (LISTO_PARA_SINTESIS), el llamador debe pasar `true` explícitamente y
 *   documentar por qué no hay nada más que exigir — nunca inferirlo de
 *   ignorar errores arbitrarios.
 * @param {string} garantias.evaluacionGrafo — uno de EVALUACION_GRAFO.
 *   NO_APLICA cuando el turno no produjo/require un delta a evaluar (o el
 *   mecanismo de evaluación no existe en este contexto); APROBADA/
 *   RECHAZADA cuando sí se evaluó.
 * @param {boolean} garantias.observacionDisponible
 * @param {boolean} garantias.materializadorEspecializadoActivo
 * @param {boolean} garantias.debeSuprimirse
 * @param {string} contexto — uno de CONTEXTOS.
 * @param {object} [contratoMovimiento] — circulomejora006, opcional. Cuando
 *   se provee, su `.movimiento` se verifica contra la estrategia ya
 *   seleccionada (MATRIZ_COMPATIBILIDAD_MOVIMIENTO_ESTRATEGIA) — nunca la
 *   cambia. Ausente (null/undefined) en cualquier contexto/gramática que
 *   no decide movimiento — comportamiento idéntico al de antes de este
 *   incremento.
 * @returns {{ admisibles: string[], seleccionada: string|null, movimientoCompatible: boolean }}
 */
function decidirMaterializacion(garantias, contexto, contratoMovimiento = null) {
  const admisibles = estrategiasAdmisibles(garantias, contexto);
  const seleccionada = seleccionarEstrategia(admisibles, contexto);
  const movimientoCompatible = compatibleMovimientoEstrategia(
    contratoMovimiento ? contratoMovimiento.movimiento : null, seleccionada,
  );
  const permitidas = contratoMovimiento
    ? MATRIZ_COMPATIBILIDAD_MOVIMIENTO_ESTRATEGIA[contratoMovimiento.movimiento]
    : null;
  const alternativasCompatibles = contratoMovimiento && !movimientoCompatible
    ? (permitidas || []).filter(estrategia => admisibles.includes(estrategia))
    : [];
  // La matriz declara compatibilidad, no preferencia. Si un estado
  // alcanzable ofrece dos HOW compatibles, elegir por posición sería una
  // decisión accidental; se hace visible para que el owner defina la regla.
  if (alternativasCompatibles.length > 1) {
    throw new Error(`ESTRATEGIA_EFECTIVA_AMBIGUA:${contratoMovimiento.movimiento}:${alternativasCompatibles.join(',')}`);
  }
  const estrategiaEfectiva = contratoMovimiento && !movimientoCompatible
    ? (alternativasCompatibles[0] || null)
    : seleccionada;
  return {
    admisibles,
    seleccionada,
    movimientoCompatible,
    estrategiaEfectiva,
    razonSustitucion: estrategiaEfectiva !== seleccionada
      ? 'ESTRATEGIA_INCOMPATIBLE_REEMPLAZADA_POR_COMPATIBLE' : null,
  };
}

/**
 * F1 — selección efectiva después de que TRANSFORMAR ya fue seleccionado
 * y el Realizador falló en tiempo de ejecución. El descriptor viene de
 * MovimientoConversacionalPolicy: Gobernanza decide estrategia, nunca texto.
 */
function decidirFallbackTrasFalloTransformar({ fallbackMovimiento, mensajeValidado }) {
  if (
    fallbackMovimiento
    && fallbackMovimiento.modo === ESTRATEGIAS.DETERMINISTA
    && typeof fallbackMovimiento.texto === 'string'
    && fallbackMovimiento.texto.trim()
  ) {
    return {
      estrategiaEfectiva: ESTRATEGIAS.DETERMINISTA,
      fallbackAplicado: true,
      salidaVisibleSegura: true,
      movimientoEjecutado: true,
    };
  }

  if (
    fallbackMovimiento
    && (fallbackMovimiento.modo === ESTRATEGIAS.PRESERVAR || fallbackMovimiento.modo === 'NO_DETERMINABLE')
    && mensajeValidado === true
  ) {
    return {
      estrategiaEfectiva: ESTRATEGIAS.PRESERVAR,
      fallbackAplicado: true,
      salidaVisibleSegura: true,
      movimientoEjecutado: false,
    };
  }

  return {
    estrategiaEfectiva: null,
    fallbackAplicado: false,
    salidaVisibleSegura: false,
    movimientoEjecutado: false,
  };
}

module.exports = {
  ESTRATEGIAS,
  CONTEXTOS,
  EVALUACION_GRAFO,
  estrategiasAdmisibles,
  seleccionarEstrategia,
  decidirMaterializacion,
  compatibleMovimientoEstrategia,
  decidirFallbackTrasFalloTransformar,
};
