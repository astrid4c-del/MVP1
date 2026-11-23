'use strict';

/**
 * circulomejora006_act10i — caso de uso productivo end-to-end para
 * VALIDANDO_RELACION_TRANSFORMACIONAL: la primera unidad que conecta, con
 * un generador real (LLMService o cualquier abstracción con el mismo
 * contrato `.call({system, userMsg, label, maxTokens})`), las piezas ya
 * construidas por incrementos previos — hasta ahora solo unidas por
 * coordinadores de prueba.
 *
 * Responsabilidad EXACTA — cinco pasos, cada uno delegado a la pieza que ya
 * lo resuelve, nunca reimplementado aquí:
 *   1. recuperar contexto autoritativo — CicloHipotesisTransformacionalDestinoOrquestacion.
 *      recuperarContextoAutoritativoRelacionTransformacionalDestino (2d7adbe).
 *   2. construir prompt — AgoraPrompts.buildGramaticaPromptV2 (b55d6c6,
 *      act10i extiende con componentes relacionales legibles).
 *   3. invocar el generador — inyectado (`generador.call(...)`), nunca
 *      acoplado a un proveedor concreto (mismo contrato que LLMService.call).
 *   4. validar y decidir — ProgresoConversacionalPolicy.validarContratoPorEstado
 *      + decidirProtocolo (ba4aaa5/act10f/act10g) — nunca un segundo parser
 *      ni una segunda clasificación local.
 *   5. aplicar el veredicto — CicloHipotesisTransformacionalDestinoOrquestacion.
 *      aplicarVeredictoRelacionTransformacionalDestino (ddb920a).
 *
 * Exclusivo de protocoloEstado==='VALIDANDO_RELACION_TRANSFORMACIONAL' — no
 * es un coordinador general del Writer: cualquier otro estado o gramática
 * queda fuera de esta unidad (lanza explícito, nunca intenta adivinar qué
 * hacer).
 *
 * No crea relaciones de grafo, no compone AfirmacionTransformacionalDestino,
 * no persiste, no repara la relación automáticamente — esas piezas siguen
 * sin construirse aquí (ver InteraccionCognitivaWriter.js, que materializa
 * en el grafo, dentro de su propia transacción, cualquier `conceptosNuevos`
 * que este caso de uso solo EXTRAE y devuelve crudo).
 *
 * DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera positiva) — cuando
 * Capa 1 declara "corrige"+concepto+"reemplazo_declarado":true pero no
 * produjo "conceptosNuevos", este caso de uso hace UN reintento focal,
 * acotado (nunca un bucle — ver buildProtocoloBloqueReemplazoConceptoRetry),
 * con un contrato mínimo que solo pide resolver esa ambigüedad puntual —
 * nunca reabre clasificacion_respuesta/ambito_correccion/dimension, ya
 * fijados por el primer intento.
 */

const {
  recuperarContextoAutoritativoRelacionTransformacionalDestino,
  aplicarVeredictoRelacionTransformacionalDestino,
} = require('../policy/CicloHipotesisTransformacionalDestinoOrquestacion');
const {
  decidirProtocolo, validarContratoPorEstado, PROTOCOLO_ESTADOS, EVENTOS,
} = require('../policy/ProgresoConversacionalPolicy');
const { buildGramaticaPromptV2, buildProtocoloBloqueReemplazoConceptoRetry } = require('../agora/AgoraPrompts');
const { createContratoIntervencion, normalizarTipoAccionUsuario } = require('../schemas/ContratoIntervencion');
const { materializarIntervencionVisible } = require('./MaterializacionIntervencionVisible');

// FRONTERA_INTERVENCION_VISIBLE_1 — antes este archivo leía parsed.mensaje
// (texto libre de Capa 1, aun tratándose de un contrato VEREDICTO_ESTRUCTURADO
// sin campo de prosa pedido) como autoridad visible directa — exactamente
// el mecanismo que produjo "Perfecto, entonces confirmamos la
// transformación." en la certificación FASE_46C real. Ahora ese texto solo
// viaja como materialCandidato: la frontera lo valida (política de
// superficie + coherencia con accionUsuario) antes de confiar en él.
function funcionParaVeredicto(clasificacion, tipoAccion) {
  if (clasificacion === 'rechaza' || clasificacion === 'corrige') return 'RECONOCER_CORREGIR';
  const porTipo = {
    responder_pregunta: 'PRECISAR', dar_ejemplo: 'PRECISAR', elegir_opcion: 'PRECISAR', confirmar: 'VALIDAR',
  };
  return porTipo[tipoAccion] || 'REFLEJAR';
}

const GRAMATICA_SOPORTADA = 'destino';
const LABEL_GENERADOR = 'destino_validando_relacion_transformacional';
const CLASIFICACIONES_CON_VEREDICTO = Object.freeze(['confirma', 'rechaza', 'corrige']);

// VALIDANDO_RELACION_TRANSFORMACIONAL solo se alcanza cuando la cobertura ya
// estaba completa (invariante de cierre, 9a47fa6/ba4aaa5) — la rama de
// decidirProtocolo para este estado no vuelve a leer suficiencia semántica;
// se pasa fija, nunca recalculada aquí (esta unidad no decide cobertura).
const RESULTADO_SUFICIENCIA_MINIMA = Object.freeze({
  suficienciaParaSintesis: true,
  razones: Object.freeze({
    dimensionesPendientesCobertura: Object.freeze([]),
    dimensionesConInterpretacionPendiente: Object.freeze([]),
    dimensionesElegiblesNoAtendidas: Object.freeze([]),
    reparacionesInterpretativasPendientes: Object.freeze([]),
  }),
});

/**
 * Proyección de PRESENTACIÓN (nunca de identidad): traduce
 * hipotesisComponentesRelacionales (conceptoIds) a contenido legible para
 * el prompt, consultando el grafo vigente SOLO para mostrar texto — nunca
 * para decidir dirección ni identidad (esas ya vienen fijadas por el
 * contexto autoritativo). No existe todavía un snapshot de contenido
 * congelado en la hipótesis (solo ids) — por eso esta función consulta
 * siempre el grafo; si en el futuro existiera un snapshot con contenido, la
 * preferencia sería usarlo primero (documentado, no implementado: no hay
 * snapshot que preferir hoy).
 */
function construirComponentesRelacionalesLegibles(hipotesisComponentesRelacionales, grafoActual) {
  const contenidoDe = (conceptoId) => {
    const concepto = (grafoActual.conceptos || []).find(c => c.id === conceptoId);
    // Defensivo: no debería alcanzarse — recuperarContextoAutoritativoRelacionTransformacionalDestino
    // ya verificó vigencia de todo concepto referenciado antes de devolver contexto.
    return concepto ? concepto.descripcion : conceptoId;
  };
  const proyectarLado = (ids) => Object.freeze(ids.map(conceptoId => Object.freeze({ conceptoId, contenido: contenidoDe(conceptoId) })));
  const resultado = {};
  Object.entries(hipotesisComponentesRelacionales).forEach(([nombre, componente]) => {
    resultado[nombre] = Object.freeze({
      desde: proyectarLado(componente.desdeConceptoIds),
      hacia: proyectarLado(componente.haciaConceptoIds),
    });
  });
  return Object.freeze(resultado);
}

function resultadoBloqueado(contexto) {
  const hipotesisEstado = contexto.resultado === 'HIPOTESIS_OBSOLETA'
    ? 'OBSOLETA'
    : ((contexto.diagnostico && contexto.diagnostico.estadoEmisionActual) || null);
  return Object.freeze({
    mensaje: null,
    protocoloEstadoSiguiente: PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL,
    evento: null,
    hipotesisEstado,
    ambitoCorreccion: null,
    componenteRelacional: null,
    causa: (contexto.diagnostico && contexto.diagnostico.codigo) || contexto.resultado,
  });
}

// S1-R-SCOPE1 (auditoría: la Hipótesis sucesora hip_1785896843304_9d34d942
// de a4r_confirmacion reutilizó, sin cambios, el mismo conceptoId de
// "resultado" que la reparación S1-R ABIERTA ya cuestionaba — el generador
// de sucesoras nunca sabía qué rol estaba bajo reparación). Modelo B (ver
// entrega): el concepto sigue siendo verdad histórica válida — nunca se
// invalida, nunca se borra, nunca se bloquea fuera de este rol — solo deja
// de ser un candidato admisible para el rol "resultado" MIENTRAS esta
// reparación permanezca ABIERTA. Nunca decide leyendo texto/frases: compara
// exclusivamente identidad de conceptoId contra el conjunto ya calculado
// por el llamador (derivado de los propios constituyentes durables de la
// Afirmación origen — ver InteraccionCognitivaWriter.js).
// `exclusion` — { campo: 'resultadoConceptoIds'|'observabilidadConceptoIds', ids: Set<conceptoId> } | null
// (ver InteraccionCognitivaWriter.exclusionesResultadoPorReparacion). El
// campo determina qué lado de qué componente relacional se compara —
// nunca se asume "siempre resultado".
function candidataUsaConceptoExcluidoEnResultado(hipotesisComponentesRelacionales, exclusion) {
  if (!exclusion || !exclusion.ids || exclusion.ids.size === 0) return false;
  // Claves públicas reales (ver CAMPO_INTERNO_A_COMPONENTE_PUBLICO en
  // CicloHipotesisTransformacionalDestinoOrquestacion.js): snake_case,
  // igual que el vocabulario de componente_relacional — nunca camelCase.
  const idsDelRolAfectado = exclusion.campo === 'observabilidadConceptoIds'
    ? hipotesisComponentesRelacionales.resultado_observabilidad.haciaConceptoIds
    : hipotesisComponentesRelacionales.mecanismo_resultado.haciaConceptoIds;
  return idsDelRolAfectado.some(id => exclusion.ids.has(id));
}

// Mensaje determinista (nunca generado por LLM, mismo criterio que
// textoDeterministaReparacion en MovimientoConversacionalPolicy.js): esta
// candidata jamás debió mostrarse como confirmable — no hay "prosa de Capa
// 1" que citar, porque el propio sistema ya sabe, sin necesidad de
// preguntarle a nadie, que viola el ámbito de una reparación ABIERTA.
function mensajeDeterministaCandidataIncompatible() {
  return 'Antes de seguir, necesito reconstruir esa parte con lo que me acabás de aclarar -- todavía no me diste suficiente para completarla.';
}

/**
 * Caso de uso productivo: procesa la respuesta del usuario a la
 * formulación exacta de HipotesisTransformacionalDestino ya mostrada.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual — KnowledgeGraph vigente
 * @param {object} params.cognitiveState — debe traer protocoloEstado==='VALIDANDO_RELACION_TRANSFORMACIONAL',
 *   protocoloHipotesisTransformacionalPendiente (proyección — solo aporta
 *   hipotesisId/version como clave, nunca autoridad) y, opcionalmente,
 *   protocoloIntentosAmbiguos.
 * @param {string} params.mensajeUsuario — texto real de este turno
 * @param {object} params.generador — cualquier objeto con
 *   `.call({system, userMsg, label, maxTokens}) => Promise<{parsed}>`
 *   (LLMService real en producción; stub en pruebas)
 * @param {string} params.turnoId — turno en el que se emite el veredicto
 *   (requerido por aplicarVeredictoRelacionTransformacionalDestino)
 * @returns {Promise<{ mensaje: string|null, protocoloEstadoSiguiente: string,
 *   evento: string|null, hipotesisEstado: string|null,
 *   ambitoCorreccion: string|null, componenteRelacional: string|null,
 *   causa: string|null }>}
 */
async function procesarRespuestaValidacionRelacionTransformacionalDestino({
  sesionId, grafoActual, cognitiveState, mensajeUsuario, generador, turnoId,
  // S1-R-SCOPE1 — Set<conceptoId> excluido del rol "resultado" por una
  // reparación S1-R ABIERTA sobre la Afirmación origen de esta sesión, o
  // null/vacío (default) si no hay ninguna. Calculado por el llamador
  // (InteraccionCognitivaWriter.js) desde los constituyentes durables de esa
  // Afirmación — nunca reconstruido aquí, nunca desde texto.
  exclusionesResultado = null,
} = {}) {
  if (!cognitiveState || cognitiveState.protocoloEstado !== PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL) {
    throw new Error(
      'ValidacionRelacionTransformacionalDestinoCasoDeUso: exclusivo de protocoloEstado==="VALIDANDO_RELACION_TRANSFORMACIONAL", '
      + `recibido: ${cognitiveState && cognitiveState.protocoloEstado}`,
    );
  }
  if (!generador || typeof generador.call !== 'function') {
    throw new Error('ValidacionRelacionTransformacionalDestinoCasoDeUso: generador inválido (falta .call)');
  }

  const hipotesisPendienteProyectada = cognitiveState.protocoloHipotesisTransformacionalPendiente;
  const intentosAmbiguosPrevios = cognitiveState.protocoloIntentosAmbiguos || 0;

  // 1. Recuperar contexto autoritativo — nunca reconstruido, nunca desde
  // CognitiveState/formulación/roles/estructura relacional del caller.
  const contexto = recuperarContextoAutoritativoRelacionTransformacionalDestino({
    sesionId, grafoActual, hipotesisPendienteProyectada,
  });
  if (contexto.resultado !== 'CONTEXTO_DISPONIBLE') {
    // Identidad no verificable, emisión ya consumida/sustituida, o hipótesis
    // recién obsoletada — en los tres casos, NUNCA se llega a construir un
    // prompt ni a invocar el generador.
    return resultadoBloqueado(contexto);
  }

  // S1-R-SCOPE1 (Fase 7 — "no mostrar al usuario una Hipótesis que el
  // sistema ya puede demostrar que viola su corrección"): verificado ANTES
  // de construir ningún prompt ni invocar el generador — no hay veredicto
  // del usuario que pueda legitimar una candidata que el propio ámbito de
  // reparación ya excluye. Nunca se le pregunta "¿confirmás?" sobre esto de
  // nuevo; se trata exactamente como "esta candidata dejó de estar
  // disponible", mismo criterio que EMISION_NO_DISPONIBLE de arriba, con su
  // propia causa observable.
  if (candidataUsaConceptoExcluidoEnResultado(contexto.contexto.hipotesisComponentesRelacionales, exclusionesResultado)) {
    // Mismo destino que un rechazo total (Sección 6 de decidirProtocolo):
    // EXPLORANDO, dirigido a reconstruir — pero el dominio de la Hipótesis
    // NUNCA transiciona a RECHAZADA (nadie emitió ese veredicto): sigue
    // CANDIDATA, simplemente pierde permiso de confirmación este turno.
    // `componenteRelacional` reutiliza EXACTAMENTE el mismo mecanismo de
    // exploración dirigida (protocoloObjetivoRelacionalDirigido, ver
    // InteraccionCognitivaWriter.js act10k) que ya gobierna la corrección
    // de ámbito "relacion" — nunca un movimiento nuevo. Se deriva del
    // mismo `campo` que ya decidió la exclusión, nunca hardcodeado.
    return Object.freeze({
      mensaje: mensajeDeterministaCandidataIncompatible(),
      protocoloEstadoSiguiente: PROTOCOLO_ESTADOS.EXPLORANDO,
      evento: EVENTOS.RELACION_TRANSFORMACIONAL_CANDIDATA_INCOMPATIBLE,
      hipotesisEstado: 'CANDIDATA',
      ambitoCorreccion: null,
      componenteRelacional: exclusionesResultado.campo === 'observabilidadConceptoIds'
        ? 'resultado_observabilidad' : 'mecanismo_resultado',
      causa: 'CANDIDATA_INCOMPATIBLE_CON_REPARACION',
      candidataIncompatibleConReparacion: true,
      // Identidad de la candidata que se está invalidando — NUNCA
      // `hipotesisAutoritativa` (ese campo implica que aplicarVeredictoRelacionTransformacionalDestino
      // corrió sobre el registro autoritativo; aquí nunca corre). El
      // llamador (Writer) los usa para registrarHipotesisSucesoraRechazada +
      // limpiarHipotesisSucesoraCandidata, mismo patrón ya existente para un
      // rechazo explícito de sucesora — nunca reimplementado aquí.
      hipotesisIdCandidataIncompatible: hipotesisPendienteProyectada.hipotesisId,
      hipotesisVersionCandidataIncompatible: hipotesisPendienteProyectada.version,
      rolesCandidataIncompatible: hipotesisPendienteProyectada.roles,
    });
  }

  // 2. Construir prompt — formulación exacta + componentes relacionales
  // legibles (nunca solo ids), ambos derivados del contexto autoritativo.
  const componentesLegibles = construirComponentesRelacionalesLegibles(
    contexto.contexto.hipotesisComponentesRelacionales, grafoActual,
  );
  const promptSistema = buildGramaticaPromptV2({
    gramatica: GRAMATICA_SOPORTADA, protocoloEstado: PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL,
    hipotesisFormulacionCongelada: contexto.contexto.hipotesisFormulacionCongelada,
    hipotesisComponentesRelacionalesLegibles: componentesLegibles,
    intentosAmbiguosPrevios,
  });

  // 3. Invocar el generador real mediante la abstracción existente — el
  // parseo del JSON ya lo resuelve `.call` (LLMService.call), nunca un
  // segundo parser local.
  const { parsed: parsedPrimerIntento, intentos: intentosPrimerIntento } = await generador.call({
    system: promptSistema, userMsg: mensajeUsuario, label: LABEL_GENERADOR,
    callProfile: 'VEREDICTO_ESTRUCTURADO', turnoId,
  });

  // 4. Validar ANTES de decidir — contrato inválido detiene el flujo aquí,
  // sin tocar la hipótesis ni el protocolo: nunca se infiere lo que falta,
  // nunca se corrige automáticamente una respuesta inválida.
  const contrato = validarContratoPorEstado({
    protocoloEstado: PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL, parsed: parsedPrimerIntento,
  });
  if (!contrato.valido) {
    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 — a diferencia del bloqueo de
    // arriba (contexto.resultado !== 'CONTEXTO_DISPONIBLE'), aquí SÍ se
    // invocó al generador con el mensaje real del usuario — errorCategory
    // (de LLMErrorTaxonomy, ver LLMService.call) preserva la causa técnica
    // real del último intento (p.ej. MODEL_RESPONSE_TRUNCATED) para que el
    // llamador pueda marcar la EntradaConversacional FALLIDO con una causa
    // preservada, nunca genérica.
    const ultimoIntento = (intentosPrimerIntento || [])[((intentosPrimerIntento || []).length) - 1] || null;
    return Object.freeze({
      mensaje: null,
      protocoloEstadoSiguiente: PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL,
      evento: null,
      hipotesisEstado: 'CANDIDATA',
      ambitoCorreccion: null,
      componenteRelacional: null,
      causa: 'CONTRATO_INVALIDO',
      errorCategory: ultimoIntento ? ultimoIntento.errorCategory : null,
    });
  }

  // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera positiva) —
  // "reemplazo_declarado":true sin "conceptosNuevos" es la única situación
  // que dispara el reintento focal: la clasificación (corrige/concepto/
  // dimension/correccion_detalle) ya quedó fija en `parsedPrimerIntento` y
  // NUNCA se reabre — el segundo intento solo puede aportar/confirmar
  // reemplazo_declarado y conceptosNuevos, fusionados sobre el resultado
  // original. Nunca un bucle: como máximo un intento adicional.
  let parsed = parsedPrimerIntento;
  let reemplazoDeclaradoSinMaterializar = false;
  const necesitaReintentoReemplazo = parsed.clasificacion_respuesta === 'corrige'
    && parsed.ambito_correccion === 'concepto' && parsed.reemplazo_declarado === true
    && (!Array.isArray(parsed.conceptosNuevos) || parsed.conceptosNuevos.length === 0);
  if (necesitaReintentoReemplazo) {
    const promptReintento = buildProtocoloBloqueReemplazoConceptoRetry({
      dimension: parsed.dimension, correccionDetalle: parsed.correccion_detalle,
    });
    const { parsed: parsedReintento } = await generador.call({
      system: promptReintento, userMsg: mensajeUsuario,
      label: `${LABEL_GENERADOR}_reemplazo_retry`, callProfile: 'VEREDICTO_ESTRUCTURADO', turnoId,
    });
    const reintentoValido = parsedReintento && typeof parsedReintento.reemplazo_declarado === 'boolean'
      && (parsedReintento.reemplazo_declarado === false
        || (Array.isArray(parsedReintento.conceptosNuevos) && parsedReintento.conceptosNuevos.length > 0));
    if (reintentoValido) {
      parsed = {
        ...parsed,
        reemplazo_declarado: parsedReintento.reemplazo_declarado,
        conceptosNuevos: parsedReintento.reemplazo_declarado ? parsedReintento.conceptosNuevos : [],
      };
    }
    // Ni el reintento resolvió la ambigüedad: `parsed` conserva
    // reemplazo_declarado=true con conceptosNuevos vacío tal cual —
    // "no aceptar que la parte positiva desaparezca silenciosamente" se
    // cumple abajo, marcando la causa observable, NUNCA reintentando de
    // nuevo ni bloqueando el turno.
    reemplazoDeclaradoSinMaterializar = parsed.reemplazo_declarado === true
      && (!Array.isArray(parsed.conceptosNuevos) || parsed.conceptosNuevos.length === 0);
  }

  const progreso = decidirProtocolo({
    protocoloEstadoActual: PROTOCOLO_ESTADOS.VALIDANDO_RELACION_TRANSFORMACIONAL,
    coberturaCompleta: true, slotsFaltantes: [], parsed,
    intentosAmbiguosPrevios,
    resultadoSuficiencia: RESULTADO_SUFICIENCIA_MINIMA,
    relacionTransformacionalRequerida: true,
    relacionTransformacionalEstado: 'CANDIDATA_DISPONIBLE',
  });

  // 5. Aplicar el veredicto sobre el objeto autoritativo original — SOLO
  // para confirma/rechaza/corrige; una clasificación ambigua nunca consume
  // la emisión (la candidata sigue pendiente para un intento posterior).
  const clasificacion = parsed && parsed.clasificacion_respuesta;
  let veredicto = null;
  if (CLASIFICACIONES_CON_VEREDICTO.includes(clasificacion)) {
    veredicto = aplicarVeredictoRelacionTransformacionalDestino({
      sesionId, hipotesisPendienteProyectada, clasificacionProtocolo: clasificacion,
      turnoId, textoUsuario: mensajeUsuario,
    });
  }

  // FRONTERA_INTERVENCION_VISIBLE_1 — construcción + materialización del
  // contrato en vez de componerMensajeFinal(parsed.mensaje, ...): parsed.mensaje
  // viaja como materialCandidato (la frontera decide si lo usa), nunca
  // como el texto final directo. progreso.nextUserAction ya representa la
  // acción de usuario ANTES de materializar (nunca se pega después).
  const tipoAccionVeredictoCrudo = (progreso.nextUserAction && progreso.nextUserAction.tipo) || null;
  const tipoAccionVeredicto = normalizarTipoAccionUsuario(tipoAccionVeredictoCrudo);
  const contratoVeredicto = createContratoIntervencion({
    funcion: funcionParaVeredicto(clasificacion, tipoAccionVeredicto),
    contenido: {
      tipo: 'veredicto_relacional',
      gainType: 'RESOLVER_VEREDICTO',
      resultado: clasificacion || 'ambiguo',
      ambitoCorreccion: (parsed && parsed.ambito_correccion) || null,
      componenteRelacional: (parsed && parsed.componente_relacional) || null,
      materialCandidato: (parsed && typeof parsed.mensaje === 'string') ? parsed.mensaje : null,
      preguntaSugerida: (progreso.nextUserAction && typeof progreso.nextUserAction.texto === 'string') ? progreso.nextUserAction.texto : null,
    },
    accionUsuario: { tipo: tipoAccionVeredicto, objetivo: (progreso.nextUserAction && progreso.nextUserAction.objetivo) || null },
    continuidad: {
      yaConfirmado: clasificacion === 'confirma' ? ['la relación transformacional que Círculo propuso'] : [],
    },
    criterioExito: 'el experto entiende qué pasó con la relación transformacional que evaluó y puede continuar',
  });
  const materializacionVeredicto = await materializarIntervencionVisible({
    contrato: contratoVeredicto, llmService: generador, turnoId, mensajeUsuario,
  });
  const mensajeVisible = materializacionVeredicto.mensajeCirculo;

  return Object.freeze({
    mensaje: mensajeVisible,
    protocoloEstadoSiguiente: progreso.protocoloEstadoSiguiente,
    evento: progreso.evento,
    hipotesisEstado: veredicto && veredicto.hipotesis ? veredicto.hipotesis.estado : 'CANDIDATA',
    ambitoCorreccion: (parsed && parsed.ambito_correccion) || null,
    componenteRelacional: (parsed && parsed.componente_relacional) || null,
    // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 — dimensión que Capa 1
    // declaró para 'corrige'+ambito_correccion='concepto' (antes/conocimiento/
    // despues/evidencia). Antes de este incremento se descartaba aquí mismo;
    // el llamador (Writer) la necesita para registrar, por rol, qué
    // conceptoId dejó de ser candidato admisible — ver
    // protocoloExclusionesHipotesisPorRol en CognitiveState.js. null salvo
    // 'corrige'+'concepto' con dimensión localizable (mismo criterio que
    // ambitoCorreccion/componenteRelacional, arriba).
    dimensionConcepto: (parsed && parsed.dimension) || null,
    // DESTINO_CORRECCION_SEMANTICA_DE_HIPOTESIS_1 (frontera positiva) —
    // conceptosNuevos CRUDOS (idTemporal/tipo/descripcion/autoridad/
    // procedencia — nunca materializados aquí, ver docstring de cabecera):
    // el llamador (Writer) los aplica al grafo, dentro de su propia
    // transacción, con aplicarDelta — igual gobernanza de autoridad
    // (autoridadGobernada) que cualquier otro conceptosNuevos del sistema.
    // [] salvo 'corrige'+'concepto' con reemplazo_declarado=true resuelto.
    conceptosNuevosReemplazo: (parsed && Array.isArray(parsed.conceptosNuevos)) ? parsed.conceptosNuevos : [],
    // true SOLO cuando Capa 1 declaró reemplazo_declarado=true y, incluso
    // tras el reintento focal, no produjo un concepto verificable — nunca
    // silencioso: el llamador debe dejarlo observable (ver estadoCorreccion
    // en CognitiveState.js).
    reemplazoDeclaradoSinMaterializar,
    causa: veredicto && veredicto.diagnostico ? veredicto.diagnostico.codigo : null,
    // circulomejora006_reporte01 (Paso 1 — convergencia Hipótesis→Afirmación)
    // — el objeto AUTORITATIVO exacto que aplicarVeredictoRelacionTransformacionalDestino
    // devolvió (nunca una proyección plana): fuente única, sin reconstrucción,
    // para que el llamador (Writer) pueda converger hacia
    // AfirmacionTransformacionalDestino cuando estado==='CONFIRMADA' — sin
    // obligarlo a re-derivar la proposición de ningún otro lado. Presente
    // para cualquier veredicto real (confirma/rechaza/corrige), null cuando
    // no hubo veredicto (ambiguo o contrato inválido).
    hipotesisAutoritativa: veredicto && veredicto.hipotesis ? veredicto.hipotesis : null,
  });
}

module.exports = {
  procesarRespuestaValidacionRelacionTransformacionalDestino,
};
