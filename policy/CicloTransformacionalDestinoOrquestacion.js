'use strict';

/**
 * C3-vertical-1 — primer incremento vertical de integración entre el
 * protocolo conversacional (LISTO_PARA_SINTESIS → ESPERANDO_CONFIRMACION) y
 * el ciclo de vida de AfirmacionTransformacionalDestino.
 *
 * Responsabilidad exacta y única: la secuencia mecánica de creación,
 * persistencia, materialización y veredicto — NUNCA decide qué conceptos
 * representan inicio/mecanismo/resultado (eso es el compositor real, fuera
 * de alcance de este incremento) ni re-clasifica la respuesta del usuario
 * (eso ya lo hace ProgresoConversacionalPolicy.decidirProtocolo — este
 * módulo únicamente consume `clasificacion_respuesta`, nunca inventa una
 * segunda gramática).
 *
 * `entradaCompositor` debe llegar ya resuelta (conceptoIds ya atribuidos a
 * roles, formulación textual ya decidida) — este módulo no la deriva, no la
 * completa y no le agrega texto. Producir esa entrada con criterio real
 * (LLM gobernado, contrato cerrado) es el compositor futuro descrito en el
 * diseño previo — explícitamente NO construido aquí.
 *
 * Ambas funciones principales DEBEN invocarse dentro de
 * CognitiveUnitOfWork.ejecutar(...) — nunca fuera de una transacción (el
 * propio repositorio lo exige vía _exigirTransaccion). Ninguna de las dos
 * hace I/O externo, llama a un LLM ni conoce llmService — D1.7-B se evalúa
 * después, fuera de esta transacción, sobre la cabeza ya durable.
 */

const {
  crearPropuestaTransformacional,
  materializarPropuestaTransformacional,
} = require('../domain/AfirmacionTransformacionalDestinoDomain');
const {
  aplicarDecisionNormativaTransformacional,
} = require('../domain/DecisionNormativaTransformacional');
const {
  evaluarVeredictoTransformacionalDesdeProtocolo,
} = require('./VeredictoTransformacionalExplicitoPolicy');
const {
  proyectarSintesisAutorizada, registrarInterpretacionRechazada,
} = require('../state/ProyeccionSintesisInterpretativaDestino');

const CLASIFICACIONES_CON_VEREDICTO = new Set(['confirma', 'rechaza']);

/**
 * Paso 1 del ciclo: LISTO_PARA_SINTESIS → PROPUESTA persistida →
 * MATERIALIZADA_PENDIENTE. Debe ejecutarse dentro de la transacción del
 * turno, junto con turnoRepo.save(turno) y stateRepo.save(nuevoEstado) —
 * nunca antes ni después.
 *
 * C6-vertical-1 (sucesión normativa tras reformulación) — fotografía
 * normativa: si `entradaCompositor` NO trae ya las claves cabezaBaseId/
 * cabezaBaseRevision (ni siquiera como null — una reformulación las fija
 * explícitamente y nunca deben sobrescribirse), esta función consulta
 * repo.findHeadBySession UNA VEZ y las captura. Una reformulación (llamada
 * desde el bloque 'corrige' de aplicarVeredictoProtocoloDestino) siempre
 * las trae ya fijadas — nunca vuelve a consultar la cabeza.
 *
 * @param {object} params
 * @param {object} params.repo — afirmacionTransformacionalRepo de ESTA transacción
 * @param {string} params.sesionId
 * @param {string} params.turnoId — turno en el que se materializa (createTurno().turnoId)
 * @param {object} params.entradaCompositor — params completos para crearPropuestaTransformacional
 *   (id, version, constituyentes, modoObservabilidad, enlacesCausales, origen —
 *   nunca estado/autorizacion/invalidadaPor, la función los rechaza)
 * @returns {{ propuesta: object, pendiente: object }} — ambas fotografías congeladas
 */
function crearYMaterializarPropuestaDestino({
  repo, sesionId, turnoId, entradaCompositor,
} = {}) {
  if (!repo || typeof repo.save !== 'function' || typeof repo.commitMaterialization !== 'function') {
    throw new Error('CicloTransformacionalDestinoOrquestacion: repo inválido');
  }
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('CicloTransformacionalDestinoOrquestacion: sesionId es obligatorio');
  }
  if (typeof turnoId !== 'string' || !turnoId.trim()) {
    throw new Error('CicloTransformacionalDestinoOrquestacion: turnoId es obligatorio');
  }

  let entrada = entradaCompositor;
  const yaTraeFotografia = entradaCompositor
    && ('cabezaBaseId' in entradaCompositor || 'cabezaBaseRevision' in entradaCompositor);
  if (!yaTraeFotografia) {
    const cabezaActual = repo.findHeadBySession(sesionId);
    entrada = {
      ...entradaCompositor,
      cabezaBaseId: cabezaActual ? cabezaActual.afirmacion.id : null,
      cabezaBaseRevision: cabezaActual ? cabezaActual.revisionCabeza : null,
    };
  }

  const propuesta = crearPropuestaTransformacional(entrada);
  repo.save(propuesta, { sesionId });
  const pendiente = materializarPropuestaTransformacional({ propuesta, turnoId });
  repo.commitMaterialization({
    sesionId, fotografiaAnterior: propuesta, fotografiaResultante: pendiente,
  });
  return Object.freeze({ propuesta, pendiente });
}

/**
 * Paso 2 del ciclo: ESPERANDO_CONFIRMACION → veredicto, reutilizando
 * clasificacion_respuesta ya real. Debe ejecutarse dentro de la misma
 * transacción del turno que la clasifica.
 *
 * @param {object} params
 * @param {object} params.repo
 * @param {string} params.sesionId
 * @param {object} params.afirmacionPendiente — la MATERIALIZADA_PENDIENTE vigente
 * @param {string} params.turnoId — turno en el que se emite el veredicto
 * @param {string} params.clasificacionProtocolo — 'confirma'|'rechaza'|'corrige'|'ambiguo',
 *   EXACTAMENTE la salida ya real de ProgresoConversacionalPolicy.decidirProtocolo
 * @param {string} [params.correccionDetalle] — obligatorio si clasificacionProtocolo==='corrige';
 *   se cita literal, nunca se reformula
 * @param {object} [params.entradaCompositorReformulacion] — obligatorio si 'corrige':
 *   params para la propuesta B (nunca reemplazaAId — se le fuerza reformulaAId)
 * @param {object} params.grafoActual — KnowledgeGraph contexto 'vivo', para la
 *   proyección hacia sintesis_interpretativa (C4-vertical-1) — nunca se
 *   persiste aquí, solo se calcula; el llamador decide cuándo guardar
 *   grafoNuevo, en la misma transacción.
 * @param {string} params.gramatica
 * @param {string|null} [params.cabezaAnteriorConceptoId] — conceptoId de la
 *   proyección positiva de la cabeza autorizada anterior, si existía —
 *   NUNCA derivado de reformulaAId; solo relevante cuando clasificacionProtocolo==='confirma'.
 * @param {string} [params.mensajeUsuario]
 * @param {boolean} [params.proyectarSintesis=true] — circulomejora006_reporte02
 *   (auditoría de convergencia durable, clasificación B): por defecto true,
 *   preserva EXACTO el comportamiento histórico (LISTO_PARA_SINTESIS→
 *   ESPERANDO_CONFIRMACION sigue instalando su concepto sintesis_interpretativa
 *   tal cual siempre lo hizo). false ÚNICAMENTE para la convergencia
 *   Hipótesis→Afirmación (ConvergenciaTransformacionalDestinoOrquestacion):
 *   esa proyección de síntesis es semánticamente prematura ahí — instalaría,
 *   como efecto colateral de autorizar la Afirmación, un concepto de síntesis
 *   ANTES de que D1.7-B/D1 la autoricen (dos síntesis independientes podrían
 *   coexistir para la misma gramática). Con false: se separa la referencia
 *   durable de Afirmación (lo único que esta función instala) de la
 *   instalación de síntesis (diferida al bloque correspondiente, no
 *   implementado aquí) — grafoNuevo vuelve sin cambios (=== grafoActual),
 *   conceptoProyectadoId es null. Solo aplica al camino clasificacionProtocolo
 *   ==='confirma'; 'rechaza'/'corrige' nunca lo usan (nunca convergen).
 * @returns {{ resultado: string, afirmacion?: object, afirmacionRechazada?: object,
 *   nuevaPendiente?: object, grafoNuevo: object, conceptoProyectadoId?: string, conceptoRechazadoId?: string }}
 */
function aplicarVeredictoProtocoloDestino({
  repo, sesionId, afirmacionPendiente, turnoId, clasificacionProtocolo,
  correccionDetalle, entradaCompositorReformulacion,
  grafoActual, gramatica, cabezaAnteriorConceptoId = null, mensajeUsuario,
  proyectarSintesis = true,
} = {}) {
  if (!repo || typeof repo.commitVerdict !== 'function') {
    throw new Error('CicloTransformacionalDestinoOrquestacion: repo inválido');
  }
  if (typeof sesionId !== 'string' || !sesionId.trim()) {
    throw new Error('CicloTransformacionalDestinoOrquestacion: sesionId es obligatorio');
  }
  if (typeof turnoId !== 'string' || !turnoId.trim()) {
    throw new Error('CicloTransformacionalDestinoOrquestacion: turnoId es obligatorio');
  }
  if (!grafoActual || typeof grafoActual !== 'object') {
    throw new Error('CicloTransformacionalDestinoOrquestacion: grafoActual es obligatorio');
  }
  if (typeof gramatica !== 'string' || !gramatica.trim()) {
    throw new Error('CicloTransformacionalDestinoOrquestacion: gramatica es obligatoria');
  }

  if (clasificacionProtocolo === 'ambiguo') {
    return Object.freeze({ resultado: 'PENDIENTE_SIN_CAMBIO', afirmacion: afirmacionPendiente, grafoNuevo: grafoActual });
  }

  if (clasificacionProtocolo === 'confirma') {
    // C6-vertical-2 (preservación de identidad) — la fotografía normativa
    // capturada al nacer decide el camino: sin cabezaBaseId, instalación
    // inicial (sin cambios); con cabezaBaseId, la MISMA B sustituye a la
    // cabeza vigente (ver _confirmarComoSustitucionDeCabeza) — nunca se
    // acuña una identidad nueva para una confirmación preautorización.
    if (afirmacionPendiente.cabezaBaseId) {
      return Object.freeze(_confirmarComoSustitucionDeCabeza({
        repo, sesionId, afirmacionPendiente, turnoId,
        grafoActual, gramatica, mensajeUsuario, proyectarSintesis,
      }));
    }
    const { afirmacion: resultante } = _confirmarORechazar({
      repo, sesionId, afirmacionPendiente, turnoId, clasificacionProtocolo,
    });
    if (!proyectarSintesis) {
      // Ver docstring del parámetro — referencia durable únicamente, la
      // síntesis queda diferida.
      return Object.freeze({
        resultado: 'AUTORIZADA', afirmacion: resultante, grafoNuevo: grafoActual, conceptoProyectadoId: null,
      });
    }
    const { grafoNuevo, conceptoId, errores } = proyectarSintesisAutorizada({
      grafoActual, afirmacion: resultante, gramatica, cabezaAnteriorConceptoId, mensajeUsuario,
    });
    if (!grafoNuevo) {
      throw new Error(`CicloTransformacionalDestinoOrquestacion: PROYECCION_POSITIVA_FALLIDA (${errores.join('; ')})`);
    }
    return Object.freeze({
      resultado: 'AUTORIZADA', afirmacion: resultante, grafoNuevo, conceptoProyectadoId: conceptoId,
    });
  }

  if (clasificacionProtocolo === 'rechaza') {
    const { afirmacion: resultante, causa } = _confirmarORechazar({
      repo, sesionId, afirmacionPendiente, turnoId, clasificacionProtocolo,
    });
    const { grafoNuevo, conceptoId, errores } = registrarInterpretacionRechazada({
      grafoActual, gramatica, causa,
      textoRechazado: afirmacionPendiente.origen.formulacionPropuesta,
      porQueRechazado: null,
    });
    if (!grafoNuevo) {
      throw new Error(`CicloTransformacionalDestinoOrquestacion: PROYECCION_NEGATIVA_FALLIDA (${errores.join('; ')})`);
    }
    return Object.freeze({
      resultado: 'RECHAZADA', afirmacion: resultante, grafoNuevo, conceptoRechazadoId: conceptoId,
    });
  }

  if (clasificacionProtocolo === 'corrige') {
    if (typeof correccionDetalle !== 'string' || !correccionDetalle.trim()) {
      throw new Error('CicloTransformacionalDestinoOrquestacion: correccionDetalle es obligatorio para "corrige"');
    }
    if (!entradaCompositorReformulacion || typeof entradaCompositorReformulacion !== 'object') {
      throw new Error('CicloTransformacionalDestinoOrquestacion: entradaCompositorReformulacion es obligatorio para "corrige"');
    }
    // Corrección preautorización (instrucción 1 obligatoria): nunca autoriza
    // A ni B — A queda RECHAZADA por el mismo tipo durable que un rechazo
    // total (commitVerdict solo reconoce CONFIRMACION_EXPLICITA/
    // RECHAZO_EXPLICITO; nunca un tercer valor en TIPOS_AUTORIZACION). La
    // causa real (CORRECCION_PREAUTORIZACION, campo de primer nivel del
    // veredicto — nunca solo diagnosticoAtribucion.regla) es lo que la
    // proyección negativa usa para distinguir honestamente una corrección
    // de un rechazo total; el detalle se cita literal, nunca se reformula.
    const { afirmacion: afirmacionRechazada, causa } = _confirmarORechazar({
      repo, sesionId, afirmacionPendiente, turnoId,
      clasificacionProtocolo: 'corrige',
      textoEvidencia: correccionDetalle,
    });
    const { grafoNuevo, conceptoId, errores } = registrarInterpretacionRechazada({
      grafoActual, gramatica, causa,
      textoRechazado: afirmacionPendiente.origen.formulacionPropuesta,
      porQueRechazado: correccionDetalle,
    });
    if (!grafoNuevo) {
      throw new Error(`CicloTransformacionalDestinoOrquestacion: PROYECCION_NEGATIVA_FALLIDA (${errores.join('; ')})`);
    }
    const entradaB = { ...entradaCompositorReformulacion };
    delete entradaB.reemplazaAId;
    entradaB.reformulaAId = afirmacionRechazada.id;
    // C6-vertical-1 (sección 2, propagación obligatoria) — B hereda la
    // MISMA fotografía normativa de A, nunca vuelve a consultar
    // findHeadBySession: toda la cadena editorial (A → B → C → ...)
    // pertenece al mismo intento normativo iniciado contra la misma
    // fotografía original.
    entradaB.cabezaBaseId = afirmacionPendiente.cabezaBaseId;
    entradaB.cabezaBaseRevision = afirmacionPendiente.cabezaBaseRevision;
    const { pendiente: nuevaPendiente } = crearYMaterializarPropuestaDestino({
      repo, sesionId, turnoId, entradaCompositor: entradaB,
    });
    return Object.freeze({
      resultado: 'RECHAZADA_CON_REFORMULACION',
      afirmacionRechazada,
      nuevaPendiente,
      grafoNuevo,
      conceptoRechazadoId: conceptoId,
    });
  }

  throw new Error(`CicloTransformacionalDestinoOrquestacion: clasificacionProtocolo desconocida: ${clasificacionProtocolo}`);
}

function _confirmarORechazar({
  repo, sesionId, afirmacionPendiente, turnoId, clasificacionProtocolo, textoEvidencia,
}) {
  const turno = { turnoId, textoUsuario: textoEvidencia !== undefined ? textoEvidencia : `[clasificacion_respuesta:${clasificacionProtocolo}]` };
  const decision = evaluarVeredictoTransformacionalDesdeProtocolo({
    afirmacion: afirmacionPendiente, turno, clasificacionProtocolo,
  });
  if (decision.tipo !== 'DECISION_NORMATIVA') {
    throw new Error(`CicloTransformacionalDestinoOrquestacion: SIN_DECISION (${decision.diagnostico && decision.diagnostico.codigo})`);
  }
  const resultante = aplicarDecisionNormativaTransformacional({
    afirmacion: afirmacionPendiente, comando: decision.comando, capacidad: decision.capacidad,
  });
  repo.commitVerdict({
    sesionId,
    fotografiaAnterior: afirmacionPendiente,
    registroVeredicto: decision.registroVeredicto,
    fotografiaResultante: resultante,
    cabezaEsperadaId: null,
    revisionCabezaEsperada: 0,
  });
  return {
    resultado: resultante.estado === 'AUTORIZADA' ? 'AUTORIZADA' : 'RECHAZADA',
    afirmacion: resultante,
    causa: decision.registroVeredicto.causa,
  };
}

/**
 * C6-vertical-2 (preservación de identidad en sustitución preautorización
 * de cabeza) — confirmación de una propuesta B cuya fotografía normativa
 * (cabezaBaseId/cabezaBaseRevision) apunta a una cabeza ya autorizada H.
 *
 * Acto de dominio DISTINTO de una corrección post-autorización real: no hay
 * aquí ninguna presentación round-trip genuina de H, ninguna evaluación de
 * una respuesta del usuario SOBRE H — lo que el usuario confirmó fue B, y es
 * B (misma id, misma version, misma fotografía) quien pasa a AUTORIZADA y
 * sustituye a H como cabeza. commitSuccessor permanece reservado,
 * exclusivamente, para una corrección real que ocurre DESPUÉS de que una
 * afirmación ya está AUTORIZADA (round-trip genuino sobre la cabeza vigente,
 * ver test "Round-trip legítimo tras autorización").
 *
 * El CAS real ocurre en commitAuthorizationReplacingHead
 * (cabezaEsperadaId/revisionCabezaEsperada contra la fotografía capturada
 * al nacer B, nunca contra una relectura de la cabeza) — si la cabeza
 * cambió mientras tanto (otro proceso instaló H2), lanza
 * CAS_CABEZA_NO_COINCIDE y toda la transacción se revierte: B permanece
 * MATERIALIZADA_PENDIENTE, sin reemplazaAId persistido. Esta función nunca
 * relee la cabeza actual — no necesita el contenido de H, solo su id
 * (cabezaBaseId, ya capturado por B al nacer): dejar que el CAS del
 * repositorio sea la única fuente de verdad evita un doble camino de error.
 */
function _confirmarComoSustitucionDeCabeza({
  repo, sesionId, afirmacionPendiente, turnoId, grafoActual, gramatica, mensajeUsuario,
  proyectarSintesis = true,
}) {
  const cabezaEsperadaId = afirmacionPendiente.cabezaBaseId;
  const revisionCabezaEsperada = afirmacionPendiente.cabezaBaseRevision;

  const turno = { turnoId, textoUsuario: `[clasificacion_respuesta:confirma]` };
  const decision = evaluarVeredictoTransformacionalDesdeProtocolo({
    afirmacion: afirmacionPendiente, turno, clasificacionProtocolo: 'confirma',
  });
  if (decision.tipo !== 'DECISION_NORMATIVA') {
    throw new Error(`CicloTransformacionalDestinoOrquestacion: SIN_DECISION (${decision.diagnostico && decision.diagnostico.codigo})`);
  }
  // La MISMA B (mismo id, misma version) recibe reemplazaAId=cabezaEsperadaId
  // sobre su propia transición AUTORIZAR — nunca se crea una entidad nueva.
  const resultante = aplicarDecisionNormativaTransformacional({
    afirmacion: afirmacionPendiente, comando: decision.comando, capacidad: decision.capacidad,
    reemplazaAId: cabezaEsperadaId,
  });
  repo.commitAuthorizationReplacingHead({
    sesionId,
    fotografiaAnterior: afirmacionPendiente,
    registroVeredicto: decision.registroVeredicto,
    fotografiaResultante: resultante,
    cabezaEsperadaId,
    revisionCabezaEsperada,
  });

  if (!proyectarSintesis) {
    // Ver docstring de aplicarVeredictoProtocoloDestino (proyectarSintesis) —
    // referencia durable únicamente, la síntesis queda diferida.
    return {
      resultado: 'AUTORIZADA', afirmacion: resultante, grafoNuevo: grafoActual, conceptoProyectadoId: null,
    };
  }

  // Proyección: identifica H mediante afirmacionTransformacionalId real —
  // nunca mediante reformulaAId.
  const proyeccionH = (grafoActual.conceptos || []).find(c =>
    c.tipo === 'sintesis_interpretativa' && c.activo && c.afirmacionTransformacionalId === cabezaEsperadaId);
  const { grafoNuevo, conceptoId, errores } = proyectarSintesisAutorizada({
    grafoActual, afirmacion: resultante, gramatica,
    cabezaAnteriorConceptoId: proyeccionH ? proyeccionH.id : null, mensajeUsuario,
  });
  if (!grafoNuevo) {
    throw new Error(`CicloTransformacionalDestinoOrquestacion: PROYECCION_POSITIVA_FALLIDA (${errores.join('; ')})`);
  }

  return {
    resultado: 'AUTORIZADA', afirmacion: resultante, grafoNuevo, conceptoProyectadoId: conceptoId,
  };
}

/**
 * Invariante de núcleo (sección "Núcleo y envoltura"): comparación de
 * cadenas exacta — nunca equivalencia semántica ni LLM.
 */
function verificarNucleoExacto({ textoNucleoMostrado, afirmacion }) {
  return typeof textoNucleoMostrado === 'string'
    && !!afirmacion && !!afirmacion.origen
    && textoNucleoMostrado === afirmacion.origen.formulacionPropuesta;
}

module.exports = {
  crearYMaterializarPropuestaDestino,
  aplicarVeredictoProtocoloDestino,
  verificarNucleoExacto,
};
