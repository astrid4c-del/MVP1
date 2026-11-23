'use strict';

/**
 * circulomejora006_act10c/d — orquestación del cierre relacional de DESTINO.
 *
 * Responsabilidad exacta: la secuencia mecánica entre el grafo ya
 * reconocido (conceptos vigentes/autorizados) y el lifecycle process-local
 * de HipotesisTransformacionalDestino (HipotesisTransformacionalDestinoPolicy)
 * — nunca decide protocolo (eso es ProgresoConversacionalPolicy.decidirProtocolo,
 * que consume el `estado` que este módulo calcula, nunca al revés), nunca
 * compone AfirmacionTransformacionalDestino, nunca conecta el compositor, el
 * Writer, persistencia ni Realizador. Mismo patrón y misma frontera que
 * CicloTransformacionalDestinoOrquestacion.js — no lo reemplaza ni compite
 * con él.
 *
 * ── Identidad entre turnos: registro autoritativo, nunca re-acuñación ──────
 * (corrección posterior a c8df67c — auditoría confirmó que la re-acuñación
 * determinística permitía CONFIRMAR una hipótesis cuyo id el sistema jamás
 * emitió: todos los datos necesarios para reconstruirla — ids de concepto
 * vigentes, dimensión, formulación — son públicos o determinísticos, así
 * que "reconstruye igual" nunca demuestra "fue realmente mostrada".
 * Equivalencia estructural ≠ continuidad de identidad.)
 *
 * `emisionesLegitimas` es la única autoridad: un Map process-local, interno,
 * NUNCA exportado, que solo se puebla como consecuencia de una ejecución
 * real y exitosa de `proponerRelacionTransformacionalDestino` (nunca por una
 * operación pública de "registrar"). Clave: {sesionId, hipotesisId, version}
 * — mismo patrón que `claveMemoriaNegativa` del dominio. Valor: el objeto
 * legítimo EXACTO devuelto por la policy (el mismo que vive en el WeakSet de
 * legitimidad del dominio, `hipotesisLegitimas`) + `estadoEmision`.
 *
 * CognitiveState (ver CognitiveState.protocoloHipotesisTransformacionalPendiente)
 * sigue siendo, exclusivamente, una PROYECCIÓN de datos planos — observabilidad
 * y continuidad conversacional, nunca autoridad. Alterar esa proyección (o
 * fabricar una desde cero con ids/roles/formulación reales y públicos) no
 * crea ninguna entidad legítima: aplicar un veredicto SIEMPRE resuelve la
 * identidad contra `emisionesLegitimas` por {sesionId, hipotesisId, version}
 * — nunca reconstruyendo, nunca confiando en los demás campos de la
 * proyección. Si la clave no está registrada (nunca se propuso, o el
 * proceso se reinició desde entonces — este módulo no puede ni debe intentar
 * distinguir ambos casos, ver docstring de aplicarVeredictoRelacionTransformacionalDestino),
 * el veredicto falla explícito: `IDENTIDAD_DE_EMISION_NO_VERIFICABLE`. Nunca
 * hay fallback a re-acuñación.
 *
 * La memoria negativa (huellasRechazadas, ya aislada por {sesionId,
 * gramática, huella}) sigue viviendo dentro del propio dominio process-local
 * — este módulo no la duplica; solo añade la capa de AUTORIDAD DE EMISIÓN
 * que faltaba, una preocupación distinta ("¿esto fue realmente propuesto?"
 * vs. "¿esta estructura ya fue rechazada?").
 */

const crypto = require('crypto');
const {
  conceptosDeGramatica, dimensionDeProcedencia,
} = require('../state/GrafoProyeccion');
const {
  crearHipotesisTransformacionalDestino, confirmarHipotesisTransformacionalDestino,
  rechazarHipotesisTransformacionalDestino, obsoletarHipotesisPorCambioDeConcepto,
  relacionProduceAutorizadaParaResultado,
} = require('./HipotesisTransformacionalDestinoPolicy');

const GRAMATICA_SOPORTADA = 'destino';

// circulomejora006_act10h — únicos dos componentes relacionales que el
// generador puede recibir como contexto (mismo vocabulario público que
// ProgresoConversacionalPolicy.COMPONENTES_RELACIONALES, deliberadamente
// duplicado — no importado de ahí: ese módulo no conoce la estructura
// interna de la hipótesis, y viceversa). Nunca 'inicio_mecanismo' — no
// existe en HipotesisTransformacionalDestino.estructuraRelacional. Iterar
// sobre ESTAS claves (nunca sobre Object.keys(hip.estructuraRelacional))
// es lo que impide que un futuro campo interno inesperado se filtre al
// contexto sin pasar por esta correspondencia explícita.
const CAMPO_INTERNO_A_COMPONENTE_PUBLICO = Object.freeze({
  mecanismoResultado: 'mecanismo_resultado',
  resultadoObservabilidad: 'resultado_observabilidad',
});

// Correspondencia de dimensiones a roles candidatos. No concede autoridad:
// MECANISMO requiere una propuesta contextual gobernada.
const DIMENSION_A_CAMPO_ROL = Object.freeze({
  antes: 'inicioConceptoIds',
  conocimiento: 'mecanismoConceptoIds',
  despues: 'resultadoConceptoIds',
  evidencia: 'observabilidadConceptoIds',
});

function destinosProduceAutorizadosPara(grafoActual, origenIds) {
  return [...new Set((grafoActual.relaciones || [])
    .filter(r => r && r.tipo === 'produce')
    .map(r => r.destino))]
    .filter(id => relacionProduceAutorizadaParaResultado(grafoActual, origenIds, id));
}

// Diagnóstico process-local de la MISMA evaluación de roles. Recibe las
// referencias acumuladas por el constructor; nunca vuelve a recorrer el KG
// con reglas paralelas.
function diagnosticoEstructuralDeReferencias({ grafoActual, roles, campoFallido }) {
  const referenciasDisponibles = Object.fromEntries(
    Object.entries(roles).map(([campo, ids]) => [campo, [...ids]]),
  );
  const mecanismoIds = referenciasDisponibles.mecanismoConceptoIds || [];
  const resultadoIds = referenciasDisponibles.resultadoConceptoIds || [];
  return {
    tipo: campoFallido
      ? `${campoFallido.replace('ConceptoIds', '').toUpperCase()}_NO_CUBIERTO`
      : 'CADENA_TRANSFORMACIONAL_NO_CONSTRUIBLE',
    rolAfectado: campoFallido || null,
    referenciasDisponibles,
    referenciasSinConexion: [],
  };
}

/**
 * Valida propuestas process-local de rol emitidas por la interpretación
 * DESTINO. La elección semántica pertenece al LLM; esta frontera solo
 * comprueba referencias, vigencia, procedencia y literalidad del turno
 * actual. Nunca muta KG.
 */
function validarPropuestasRolesTransformacionales(grafoActual, propuestas = [], idTemporalAReal = {}, mensajeUsuario = '') {
  const roles = {};
  const errores = [];
  if (!grafoActual || !Array.isArray(grafoActual.conceptos)) {
    return { valido: false, roles, errores: ['rolesTransformacionales: grafo actual inexistente'] };
  }
  (Array.isArray(propuestas) ? propuestas : []).forEach((p, i) => {
    if (!p || p.rol !== 'MECANISMO') { errores.push(`rolesTransformacionales[${i}]: rol no permitido`); return; }
    const id = Object.prototype.hasOwnProperty.call(idTemporalAReal, p.conceptoId)
      ? idTemporalAReal[p.conceptoId] : p.conceptoId;
    const concepto = (grafoActual.conceptos || []).find(c => c.id === id);
    if (!concepto || concepto.activo !== true || concepto.autoridad !== 'experto') {
      errores.push(`rolesTransformacionales[${i}]: referencia '${p.conceptoId}' no es un concepto experto activo`); return;
    }
    const dimension = dimensionDeProcedencia(concepto.procedencia);
    if (!dimension || !Object.prototype.hasOwnProperty.call(DIMENSION_A_CAMPO_ROL, dimension)
      || concepto.rechazado === true || concepto.obsoleto === true) {
      errores.push(`rolesTransformacionales[${i}]: referencia '${p.conceptoId}' no tiene procedencia DESTINO vigente`); return;
    }
    if (!contenidoEsExtractivoLocal(p.evidenciaTextual, mensajeUsuario)) {
      errores.push(`rolesTransformacionales[${i}]: evidenciaTextual no es literal del turno`); return;
    }
    if (!roles.mecanismoConceptoIds) roles.mecanismoConceptoIds = [];
    if (!roles.mecanismoConceptoIds.includes(id)) roles.mecanismoConceptoIds.push(id);
  });
  return { valido: errores.length === 0, roles, errores };
}

function revalidarComposicionTransformacionalPendiente(grafoActual, pendiente, fuentesPrimarias = null) {
  if (!pendiente || pendiente.gramatica !== 'destino' || !Array.isArray(pendiente.referencias)) return { valido: false, roles: {}, errores: ['composición pendiente ausente'] };
  const roles = { mecanismoConceptoIds: [] };
  const errores = [];
  pendiente.referencias.forEach(r => {
    const c = (grafoActual && grafoActual.conceptos || []).find(x => x.id === r.conceptoId);
    const dimension = c && dimensionDeProcedencia(c.procedencia);
    if (!c || c.activo !== true || c.autoridad !== 'experto' || c.rechazado === true || c.obsoleto === true
      || !dimension || !Object.prototype.hasOwnProperty.call(DIMENSION_A_CAMPO_ROL, dimension)) {
      errores.push(`rol pendiente inválido: ${r.conceptoId}`); return;
    }
    if (Array.isArray(fuentesPrimarias)) {
      const fuente = fuentesPrimarias.find(f => f && f.turnoId === r.turnoOrigenId);
      if (!fuente || typeof fuente.mensaje !== 'string' || !contenidoEsExtractivoLocal(r.evidenciaTextual, fuente.mensaje)) {
        errores.push(`rol pendiente sin provenance literal válida: ${r.conceptoId}`); return;
      }
    }
    if (!roles.mecanismoConceptoIds.includes(c.id)) roles.mecanismoConceptoIds.push(c.id);
  });
  return {
    valido: errores.length === 0 && roles.mecanismoConceptoIds.length > 0,
    roles,
    autoridadesContextualesPorRol: { mecanismoConceptoIds: [...roles.mecanismoConceptoIds] },
    errores,
  };
}

function contenidoEsExtractivoLocal(texto, mensaje) {
  if (typeof texto !== 'string' || !texto.trim() || typeof mensaje !== 'string') return false;
  const normaliza = s => s.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return normaliza(mensaje).includes(normaliza(texto));
}

// La autorización contextual solo abre un conjunto de referencias que el
// compositor puede considerar. No es todavía la selección de una candidata.
// La selección se obtiene por componentes conectadas del grafo bipartito
// MECANISMO↔RESULTADO; no hay ranking ni criterio de cardinalidad.
function seleccionarMecanismosContextuales(grafoActual, autorizados, resultadosCandidatos) {
  const ids = [...new Set(autorizados || [])];
  const resultadosElegibles = new Set(resultadosCandidatos || []);
  const mecanismosAResultados = new Map();
  const resultadosAMecanismos = new Map();
  ids.forEach(origen => {
    (grafoActual.relaciones || [])
      .filter(r => r && r.activo !== false && r.tipo === 'produce' && r.origen === origen)
      .map(r => r.destino)
      .filter(destino => relacionProduceAutorizadaParaResultado(grafoActual, [origen], destino))
      .forEach(destino => {
        resultadosElegibles.add(destino);
        if (!mecanismosAResultados.has(origen)) mecanismosAResultados.set(origen, new Set());
        mecanismosAResultados.get(origen).add(destino);
        if (!resultadosAMecanismos.has(destino)) resultadosAMecanismos.set(destino, new Set());
        resultadosAMecanismos.get(destino).add(origen);
      });
  });
  if (mecanismosAResultados.size === 0) {
    return { valido: false, codigo: 'MECANISMO_SIN_CONEXION_A_RESULTADO', mecanismos: [], resultados: [] };
  }
  const visitadosM = new Set();
  const visitadosR = new Set();
  const componentes = [];
  for (const inicio of ids) {
    if (!mecanismosAResultados.has(inicio) || visitadosM.has(inicio)) continue;
    const mecanismos = new Set();
    const resultados = new Set();
    const cola = [{ tipo: 'mecanismo', id: inicio }];
    while (cola.length > 0) {
      const nodo = cola.shift();
      if (nodo.tipo === 'mecanismo') {
        if (visitadosM.has(nodo.id)) continue;
        visitadosM.add(nodo.id); mecanismos.add(nodo.id);
        (mecanismosAResultados.get(nodo.id) || []).forEach(id => cola.push({ tipo: 'resultado', id }));
      } else {
        if (visitadosR.has(nodo.id)) continue;
        visitadosR.add(nodo.id); resultados.add(nodo.id);
        (resultadosAMecanismos.get(nodo.id) || []).forEach(id => cola.push({ tipo: 'mecanismo', id }));
      }
    }
    componentes.push({ mecanismos: [...mecanismos], resultados: [...resultados] });
  }
  if (componentes.length !== 1) {
    return { valido: false, codigo: 'SELECCION_COMPOSICIONAL_AMBIGUA', mecanismos: [], resultados: [] };
  }
  const componente = componentes[0];
  return { valido: true, codigo: null, mecanismos: componente.mecanismos, resultados: componente.resultados };
}

// ── Registro autoritativo de emisiones (frontera process-local privada) ────
// Nunca exportado. La única forma de poblarlo es una ejecución real y
// exitosa de proponerRelacionTransformacionalDestino, más abajo — no existe
// ninguna función pública "registrarEmision(...)" que acepte una entidad
// arbitraria.
const emisionesLegitimas = new Map();
// Índice auxiliar: qué clave es la emisión PENDIENTE vigente de cada sesión
// — a lo sumo una a la vez (invariante del protocolo: una sola candidata
// mostrada por sesión). Permite, al proponer una nueva, invalidar
// estructuralmente la anterior (sustitución) en vez de dejarla "viva" para
// que una respuesta tardía la confirme.
const emisionPendientePorSesion = new Map();

const ESTADOS_EMISION = Object.freeze(['PENDIENTE', 'CONFIRMADA', 'RECHAZADA', 'SUSTITUIDA', 'OBSOLETA']);

function claveEmision(sesionId, hipotesisId, version) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ sesionId, hipotesisId, version }))
    .digest('hex');
}

// circulomejora006_act10l — mismo criterio que Turno.generateTurnoId: el
// llamador (el Writer) nunca inventa la hipótesis, pero SÍ decide su
// identificador opaco antes de proponerla — proponerRelacionTransformacionalDestino
// exige hipotesisId como parámetro por diseño desde su primera versión (ver
// docstring de esa función), nunca lo generaba internamente. Un simple
// identificador opaco, nunca parte de la entidad (roles/estructura/
// formulación siguen siendo exclusivas de HipotesisTransformacionalDestinoPolicy).
function generateHipotesisId() {
  return `hip_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function congelarProfundo(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(congelarProfundo);
  return Object.freeze(value);
}

/**
 * Registra una emisión PENDIENTE — SOLO se llama internamente, inmediatamente
 * después de que crearHipotesisTransformacionalDestino devolvió
 * CANDIDATA_VALIDA (ver proponerRelacionTransformacionalDestino). Sustituye
 * (marca SUSTITUIDA) cualquier emisión PENDIENTE previa de la misma sesión —
 * nunca deja dos candidatas simultáneamente confirmables.
 */
function _registrarEmisionPendiente(sesionId, hipotesis) {
  const clave = claveEmision(sesionId, hipotesis.id, hipotesis.version);
  if (emisionesLegitimas.has(clave)) {
    // Reutilizar {sesionId, id, version} para una emisión NUEVA sería un
    // error de llamador (mismo criterio que ids duplicados en el resto del
    // sistema) — nunca se sobrescribe en silencio una entrada existente.
    throw new Error(
      `CicloHipotesisTransformacionalDestinoOrquestacion: EMISION_YA_REGISTRADA (${sesionId}/${hipotesis.id}/${hipotesis.version})`,
    );
  }
  const claveAnterior = emisionPendientePorSesion.get(sesionId);
  if (claveAnterior) {
    const anterior = emisionesLegitimas.get(claveAnterior);
    if (anterior && anterior.estadoEmision === 'PENDIENTE') {
      emisionesLegitimas.set(claveAnterior, { ...anterior, estadoEmision: 'SUSTITUIDA' });
    }
  }
  emisionesLegitimas.set(clave, { hipotesis, estadoEmision: 'PENDIENTE', sesionId });
  emisionPendientePorSesion.set(sesionId, clave);
}

/** Única forma de leer el registro — nunca se expone directamente. */
function _buscarEmision(sesionId, hipotesisId, version) {
  return emisionesLegitimas.get(claveEmision(sesionId, hipotesisId, version)) || null;
}

/**
 * COMPATIBILIDAD_HISTORICA (REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS)
 * — recuperación de mejor esfuerzo, exclusivamente para sesiones cuya
 * entrada de exclusión se persistió ANTES de que `rolesOriginales` existiera
 * (deserializeState las completa con los 4 campos vacíos — ver
 * CognitiveState.js). Consulta ÚNICAMENTE `emisionesLegitimas` — la misma
 * autoridad process-local que ya gobierna cualquier otra resolución de
 * identidad de Hipótesis en este módulo — por la identidad exacta
 * {sesionId, hipotesisId, version} que la propia corrección ya registró.
 * Determinístico (misma identidad → mismo resultado dentro del mismo
 * proceso), nunca fabrica nada: si el registro no reconoce esa identidad
 * (nunca se propuso así en ESTE proceso, o el proceso se reinició desde
 * entonces — el caso más común, dado que `emisionesLegitimas` nunca
 * sobrevive un reinicio), devuelve `null` explícito — el llamador (Writer)
 * nunca hereda a partir de un `null` (mismo criterio que cualquier otro
 * campoRol sin referencias heredables: cae a la reconstrucción normal
 * contra el grafo vigente, nunca bloquea el resto de la Hipótesis).
 * @returns {object|null} los cuatro roles (`HIPOTESIS_PENDIENTE_CAMPOS_ROL`),
 *   o null si la identidad no es recuperable en este proceso.
 */
function recuperarRolesOriginalesPorIdentidad(sesionId, hipotesisId, version) {
  const entrada = _buscarEmision(sesionId, hipotesisId, version);
  if (!entrada || !entrada.hipotesis || !entrada.hipotesis.roles) return null;
  return Object.fromEntries(
    Object.entries(DIMENSION_A_CAMPO_ROL).map(([, campo]) => [campo, [...(entrada.hipotesis.roles[campo] || [])]]),
  );
}

/**
 * Selección de referencias por rol — únicamente conceptos vigentes
 * (activo && autoridad==='experto') y autorizados de 'destino', mismo
 * criterio de vigencia que el resto del sistema. Nunca lee texto, nunca
 * decide causalidad — solo agrupa por dimensión de procedencia.
 *
 * S1-R-SCOPE1 — `exclusionesPorRol` (Modelo B: concepto válido, uso
 * relacional inválido — ver auditoría S1-R-SCOPE1 Fase 1/2): mapa opcional
 * `{ campoRol: Set<conceptoId> }`, `{}`/`undefined` (default) reproduce el
 * comportamiento anterior byte a byte. Un conceptoId excluido para SU
 * campoRol nunca se retira del grafo ni de otros roles/dimensiones — sigue
 * siendo verdad histórica vigente, solo deja de ser candidato para volver a
 * ocupar el rol que una reparación S1-R ABIERTA ya cuestionó. Si excluir d
 * deja una dimensión sin ningún concepto restante, esa dimensión se trata
 * exactamente como "sin anclaje experto" (mismo `return null` de siempre)
 * — nunca se fabrica un candidato ni se ignora la exclusión.
 *
 * REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS — `referenciasHeredablesPorRol`
 * (opcional, default `{}`/`null` reproduce el comportamiento anterior byte
 * a byte): mapa `{ campoRol: conceptoId[] }` — referencias EXACTAS de la
 * Hipótesis original para roles que una corrección focal NUNCA cuestionó
 * (ver InteraccionCognitivaWriter.js, rolesOriginales/referenciasHeredablesPorRol).
 * Para cada campoRol presente aquí, esta función usa esas referencias TAL
 * CUAL — nunca recalcula contra "todo concepto experto activo de la
 * dimensión" — EXCEPTO cuando alguna de ellas ya no es vigente (inactiva,
 * rechazada, o de otra dimensión/gramática): en ese caso cae, para ESE
 * campoRol únicamente, al mismo recálculo de siempre (nunca se fabrica un
 * reemplazo, nunca se hereda a ciegas una referencia inválida). El
 * llamador nunca debe incluir aquí el campoRol que la propia corrección
 * está reconstruyendo — si lo hace igual, esta función no lo sabe ni lo
 * distingue: simplemente lo heredaría también, así que es responsabilidad
 * exclusiva del llamador excluirlo (ver nota completa en el Writer).
 * @returns {{roles: object|null, diagnosticoEstructural: object|null}}
 * roles completos, o diagnóstico si a alguna dimensión le
 *   falta anclaje experto (defensivo: no debería ocurrir si el llamador ya
 *   verificó suficiencia semántica/coberturaCompleta antes de invocar esto)
 *   o si la exclusión deja una dimensión sin ningún concepto admisible.
 */
function construirReferenciasPorRolDestino(grafoActual, exclusionesPorRol = null, referenciasHeredablesPorRol = null, rolesContextualesPorRol = null) {
  const roles = {};
  const autoridadesContextualesPorRol = {};
  let autorizacionesMecanismo = null;
  for (const [dimension, campoRol] of Object.entries(DIMENSION_A_CAMPO_ROL)) {
    const heredables = referenciasHeredablesPorRol && referenciasHeredablesPorRol[campoRol];
    if (Array.isArray(heredables) && heredables.length > 0) {
      const todasVigentes = heredables.every(id => {
        const concepto = (grafoActual.conceptos || []).find(c => c.id === id);
        return !!concepto && concepto.activo === true && concepto.autoridad === 'experto'
          && dimensionDeProcedencia(concepto.procedencia) === dimension;
      });
      if (todasVigentes) {
        roles[campoRol] = [...heredables];
        continue;
      }
      // Alguna referencia heredable ya no es vigente — nunca se hereda a
      // ciegas ni se descarta el rol en silencio: cae al mismo recálculo
      // de siempre, exactamente como si no hubiera nada que heredar aquí.
    }
    const excluidos = exclusionesPorRol && exclusionesPorRol[campoRol];
    const contextuales = rolesContextualesPorRol && rolesContextualesPorRol[campoRol];
    if (Array.isArray(contextuales) && contextuales.length > 0) {
      const idsContextuales = contextuales.filter(id => {
        const c = (grafoActual.conceptos || []).find(x => x.id === id);
        return !!c && c.activo === true && c.autoridad === 'experto'
          && (!excluidos || !excluidos.has(id));
      });
      if (idsContextuales.length > 0) {
        autoridadesContextualesPorRol[campoRol] = [...new Set(idsContextuales)];
        if (campoRol === 'mecanismoConceptoIds') {
          autorizacionesMecanismo = [...new Set(idsContextuales)];
          roles[campoRol] = [...new Set(idsContextuales)];
          continue;
        }
        roles[campoRol] = [...new Set(idsContextuales)];
        continue;
      }
    }
    // La dimensión solo ofrece candidatos; nunca concede por sí misma el
    // rol MECANISMO. Ese rol debe llegar mediante una propuesta contextual
    // gobernada o una referencia heredada de una hipótesis válida.
    if (campoRol === 'mecanismoConceptoIds') {
      if (autorizacionesMecanismo && autorizacionesMecanismo.length > 0) continue;
      return {
        roles: null,
        diagnosticoEstructural: diagnosticoEstructuralDeReferencias({
          grafoActual, roles, campoFallido: campoRol,
        }),
      };
    }
    const conceptos = conceptosDeGramatica(grafoActual, GRAMATICA_SOPORTADA)
      .filter(c => dimensionDeProcedencia(c.procedencia) === dimension && c.autoridad === 'experto' && c.activo === true)
      .filter(c => !excluidos || !excluidos.has(c.id));
    const ids = conceptos.map(c => c.id);
    if (campoRol === 'resultadoConceptoIds' || campoRol === 'observabilidadConceptoIds') {
      // Una relación produce autorizada demuestra participación contextual
      // del destino en la candidata. Para RESULTADO conserva la autoridad
      // histórica; para OBSERVABILIDAD permite reutilizar la misma
      // manifestación experta sin duplicarla ni exigir que haya nacido en
      // slot:evidencia.
      // Un destino `produce` fuera de la dimensión despues puede ser un
      // RESULTADO contextual cuando no existe ningún resultado nativo. Si
      // ya hay candidatos nativos, no desplaza esa selección ni fusiona una
      // cadena de observabilidad ajena en el resultado.
      if (ids.length === 0) {
        destinosProduceAutorizadosPara(grafoActual, roles.mecanismoConceptoIds || autorizacionesMecanismo)
          .filter(id => !excluidos || !excluidos.has(id))
          .forEach(id => { if (!ids.includes(id)) ids.push(id); });
      }
    }
    if (ids.length === 0) {
      return {
        roles: null,
        diagnosticoEstructural: diagnosticoEstructuralDeReferencias({
          grafoActual, roles, campoFallido: campoRol,
        }),
      };
    }
    roles[campoRol] = ids;
  }
  if (Array.isArray(autorizacionesMecanismo) && autorizacionesMecanismo.length > 0
    && destinosProduceAutorizadosPara(grafoActual, autorizacionesMecanismo).length > 0) {
    const seleccion = seleccionarMecanismosContextuales(
      grafoActual,
      autorizacionesMecanismo,
      roles.resultadoConceptoIds || [],
    );
    if (!seleccion.valido) {
      return {
        roles: null,
        diagnosticoEstructural: {
          tipo: seleccion.codigo,
          rolAfectado: 'mecanismoConceptoIds',
          referenciasDisponibles: Object.fromEntries(
            Object.entries(roles).map(([campo, ids]) => [campo, [...ids]]),
          ),
          referenciasSinConexion: [...autorizacionesMecanismo],
        },
      };
    }
    roles.mecanismoConceptoIds = seleccion.mecanismos;
    roles.resultadoConceptoIds = seleccion.resultados;
    const observabilidadContextual = destinosProduceAutorizadosPara(grafoActual, seleccion.mecanismos);
    const observabilidadActual = roles.observabilidadConceptoIds || [];
    observabilidadContextual.forEach(id => {
      if (!observabilidadActual.includes(id)) observabilidadActual.push(id);
    });
    roles.observabilidadConceptoIds = observabilidadActual;
  }
  // La cobertura semántica del mecanismo se concede por el rol contextual
  // ya gobernado (concepto experto, vigente y con evidencia literal). Una
  // relación PRODUCE explícita sigue enriqueciéndolo y, si existe, se usa
  // para la selección topológica histórica; su ausencia no revoca el rol.
  const mecanismos = roles.mecanismoConceptoIds || [];
  if (mecanismos.length === 0) {
    return {
      roles: null,
      diagnosticoEstructural: diagnosticoEstructuralDeReferencias({
        grafoActual, roles, campoFallido: 'mecanismoConceptoIds',
      }),
    };
  }
  return { roles, autoridadesContextualesPorRol, diagnosticoEstructural: null };
}

/** Réplica de solo-lectura de esVigente/causaDeNoVigencia (dominio, privadas
 * y no exportadas) — nunca invoca ninguna transición protegida del
 * lifecycle; solo lee grafoActual.conceptos para las ids de una hipótesis
 * ya registrada como CONFIRMADA (siempre resueltas desde el registro, nunca
 * desde la proyección del llamador — ver evaluarEstadoRelacionTransformacionalDestino). */
function conceptosNoVigentesDe(grafoActual, roles) {
  const causantes = [];
  Object.entries(roles).forEach(([campo, ids]) => {
    ids.forEach(conceptoId => {
      const concepto = (grafoActual.conceptos || []).find(c => c.id === conceptoId);
      const vigente = !!concepto && concepto.activo === true && concepto.autoridad === 'experto';
      if (vigente) return;
      let causa = 'CONCEPTO_INEXISTENTE';
      if (concepto) {
        if (concepto.rechazado === true) causa = 'RECHAZADO';
        else if (concepto.activo === false) causa = 'OBSOLETO';
        else causa = 'PENDIENTE_RECONOCIMIENTO';
      }
      causantes.push({ campo, conceptoId, causa });
    });
  });
  return causantes;
}

/**
 * Proyección plana para CognitiveState.protocoloHipotesisTransformacionalPendiente
 * — nunca el objeto legítimo, nunca una fuente de autoridad. Sirve
 * ÚNICAMENTE para: (a) identificar la emisión pendiente (hipotesisId/
 * version/sesionId, usados como CLAVE de búsqueda, nunca como dato
 * reconstructivo), (b) mostrar/auditar la formulación y la estructura
 * relacional ya emitidas, (c) continuar el protocolo (estado), (d)
 * P0-A2 — servir de ÚNICA fuente durable desde la que
 * reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable puede reconstruir
 * la identidad autoritativa tras un reinicio de proceso (ver InteraccionCognitivaWriter.js,
 * bloque de reinstalación ANTES de delegar a
 * ValidacionRelacionTransformacionalDestinoCasoDeUso) — `roles` y
 * `turnoPresentacionId` son exactamente los dos datos que esa función exige
 * para reproducir, deterministamente, la MISMA Hipótesis vía
 * crearHipotesisTransformacionalDestino, nunca una segunda vía de
 * construcción. `roles`/`estructuraRelacional`/`versionContratoRelacional`
 * siguen siendo, además, auditoría legible; ninguna función de este módulo
 * los usa para decidir un veredicto — la vigencia de una CONFIRMADA y la
 * autoridad de cualquier veredicto se verifican contra el objeto REGISTRADO
 * en `emisionesLegitimas` (reinstalado o no), nunca contra esta copia
 * directamente (ver docstring de cabecera).
 */
function proyectarHipotesisParaEstado(hipotesis) {
  return congelarProfundo({
    hipotesisId: hipotesis.id,
    version: hipotesis.version,
    estado: hipotesis.estado,
    roles: Object.fromEntries(Object.entries(hipotesis.roles).map(([campo, ids]) => [campo, [...ids]])),
    versionContratoRelacional: hipotesis.versionContratoRelacional,
    estructuraRelacional: Object.fromEntries(Object.entries(hipotesis.estructuraRelacional).map(([campo, componente]) => [campo, {
      tipo: componente.tipo,
      desdeConceptoIds: [...componente.desdeConceptoIds],
      haciaConceptoIds: [...componente.haciaConceptoIds],
    }])),
    formulacionCongelada: hipotesis.formulacionCongelada,
    sesionId: hipotesis.snapshotBase.sesionId,
    gramatica: hipotesis.snapshotBase.gramatica,
    // P0-A2 — mismo dato que ya persiste durablemente el camino S1-R
    // (afirmacionTransformacionalRepo.registrarHipotesisSucesoraCandidata,
    // columna hipotesisSucesoraTurnoPresentacionId) para su propia
    // reinstalación; aquí viaja dentro de la MISMA proyección ya durable
    // (CognitiveState), sin entidad ni tabla nueva.
    turnoPresentacionId: hipotesis.turnoPresentacionId,
    ...(hipotesis.reformulaAId !== undefined ? { reformulaAId: hipotesis.reformulaAId } : {}),
  });
}

/**
 * Propone una candidata nueva a partir del grafo ya reconocido — se invoca
 * cuando no hay ninguna hipótesis pendiente vigente que mostrar todavía
 * (primera vez que la cobertura se completa, o tras una corrección/rechazo
 * ya resuelto por el llamador). Único punto donde `emisionesLegitimas` se
 * puebla.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual
 * @param {string} params.hipotesisId — nunca inventado aquí; el llamador lo
 *   decide (mismo criterio que turnoId/id en el resto del sistema).
 * @param {string} params.turnoPresentacionId — circulomejora006_reporte03: el
 *   turno REAL en el que esta formulación se muestra al usuario (nunca el de
 *   una confirmación/convergencia posterior) — el llamador (Writer) lo
 *   decide ANTES de proponer, nunca se recupera después por coincidencia de
 *   texto. Se propaga tal cual a crearHipotesisTransformacionalDestino.
 * @param {string} [params.reformulaAId] — genealogía editorial explícita,
 *   nunca auto-derivada (mismo contrato que el dominio).
 * @returns {{ estado: string, hipotesis?: object, diagnostico?: object }}
 *   estado: 'CANDIDATA_DISPONIBLE' | 'BLOQUEADA_SIN_SENAL_NUEVA' |
 *   'SIN_COBERTURA' | 'BASE_HEREDABLE_NO_RECUPERABLE' | 'ERROR_INESPERADO'.
 */
function proponerRelacionTransformacionalDestino({
  sesionId, grafoActual, hipotesisId, reformulaAId, turnoPresentacionId,
  // S1-R-SCOPE1 — ver docstring de construirReferenciasPorRolDestino.
  // `null` (default) reproduce el comportamiento anterior byte a byte.
  exclusionesPorRol = null,
  // REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS — ver docstring de
  // construirReferenciasPorRolDestino. `null` (default) reproduce el
  // comportamiento anterior byte a byte.
  referenciasHeredablesPorRol = null,
  // HERENCIA_FOCAL_NO_DEMOSTRABLE_NO_PUEDE_DEGRADAR_A_RECALCULO_SILENCIOSO
  // — Set<campoRol> cuya base heredable era REQUERIDA (una corrección focal
  // vigente cubre OTRO rol de la misma Hipótesis) pero no pudo demostrarse
  // — ni persistida, ni recuperable por identidad exacta (ver
  // InteraccionCognitivaWriter.js). Falla cerrado ANTES de tocar
  // construirReferenciasPorRolDestino: nunca reconstruye esos roles contra
  // el grafo por aproximación — eso sería exactamente la degradación
  // silenciosa que este incremento prohíbe. `null`/vacío (default)
  // reproduce el comportamiento anterior byte a byte.
  camposConBaseHeredableNoRecuperable = null,
  rolesContextualesPorRol = null,
  autoridadesContextualesPorRol = null,
} = {}) {
  if (camposConBaseHeredableNoRecuperable && camposConBaseHeredableNoRecuperable.size > 0) {
    return {
      estado: 'BASE_HEREDABLE_NO_RECUPERABLE',
      diagnostico: { codigo: 'BASE_HEREDABLE_NO_RECUPERABLE', campos: [...camposConBaseHeredableNoRecuperable] },
    };
  }
  const evaluacionRoles = construirReferenciasPorRolDestino(grafoActual, exclusionesPorRol, referenciasHeredablesPorRol, rolesContextualesPorRol);
  const roles = evaluacionRoles.roles;
  if (!roles) {
    return {
      estado: 'SIN_COBERTURA',
      diagnosticoEstructural: evaluacionRoles.diagnosticoEstructural,
    };
  }

  const resultado = crearHipotesisTransformacionalDestino({
    id: hipotesisId, sesionId, gramatica: GRAMATICA_SOPORTADA, grafoActual, roles, turnoPresentacionId,
    autoridadesContextualesPorRol: autoridadesContextualesPorRol || evaluacionRoles.autoridadesContextualesPorRol,
    ...(reformulaAId !== undefined ? { reformulaAId } : {}),
  });
  if (resultado.resultado === 'CANDIDATA_VALIDA') {
    // 1. creada mediante la policy legítima (arriba) — 2. se conserva el
    // objeto EXACTO devuelto (nunca una copia) — 3. se registra bajo la
    // identidad compuesta — 4. queda marcada PENDIENTE.
    _registrarEmisionPendiente(sesionId, resultado.hipotesis);
    return { estado: 'CANDIDATA_DISPONIBLE', hipotesis: resultado.hipotesis };
  }
  // "Nueva señal estructural" (contrato heredado de fda7ffb): mientras
  // ninguna referencia por rol cambie, la memoria negativa process-local
  // bloquea la reconstrucción exacta de una hipótesis ya rechazada — nunca
  // vuelve a proponerse sola.
  if (resultado.diagnostico && resultado.diagnostico.codigo === 'REPRODUCE_HIPOTESIS_RECHAZADA') {
    return { estado: 'BLOQUEADA_SIN_SENAL_NUEVA', diagnostico: resultado.diagnostico };
  }
  // Cualquier otro código (REFERENCIA_NO_VIGENTE, ROL_INCOMPATIBLE_CON_DIMENSION)
  // no debería alcanzarse nunca por construcción — construirReferenciasPorRolDestino
  // ya solo selecciona conceptos vigentes de la dimensión correcta. Se
  // reporta explícito, nunca se fuerza a un resultado conocido.
  return { estado: 'ERROR_INESPERADO', diagnostico: resultado.diagnostico };
}

/**
 * Evalúa, al cierre de un turno, el estado de la relación transformacional
 * de la sesión — punto de entrada único para el llamador (Writer futuro o
 * pruebas): decide entre verificar vigencia de una CONFIRMADA ya existente
 * o proponer una candidata nueva. La vigencia de una CONFIRMADA se resuelve
 * SIEMPRE contra el registro autoritativo (nunca contra
 * hipotesisPendiente.roles, que es solo la proyección del llamador) — si el
 * registro no reconoce esa identidad (nunca se emitió así, o el proceso se
 * reinició desde que se confirmó), se reporta explícito, nunca se asume
 * vigencia ni se reconstruye.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual
 * @param {object|null} params.hipotesisPendiente — proyección plana ya
 *   persistida en CognitiveState.protocoloHipotesisTransformacionalPendiente,
 *   o null si no hay ninguna.
 * @param {string} [params.hipotesisId] — solo se usa si hace falta proponer
 *   una candidata nueva (hipotesisPendiente ausente, o no CONFIRMADA).
 * @param {string} [params.turnoPresentacionId] — solo se usa (y es
 *   obligatorio en ese caso) cuando hace falta proponer una candidata nueva
 *   — ver proponerRelacionTransformacionalDestino. Ignorado cuando ya existe
 *   una CONFIRMADA vigente (esa rama nunca propone nada nuevo).
 * @returns {{ estado: string, hipotesis?: object, hipotesisProyectada?: object, diagnostico?: object }}
 *   estado adicional respecto a proponerRelacionTransformacionalDestino:
 *   'CONFIRMADA_VIGENTE' | 'CONFIRMADA_OBSOLETA' | 'CONFIRMADA_NO_VERIFICABLE'.
 */
function evaluarEstadoRelacionTransformacionalDestino({
  sesionId, grafoActual, hipotesisPendiente = null, hipotesisId, turnoPresentacionId,
  // S1-R-SCOPE1 — ver docstring de construirReferenciasPorRolDestino. Solo
  // tiene efecto en la rama que propone una candidata nueva (más abajo) —
  // la rama CONFIRMADA_VIGENTE/CONFIRMADA_OBSOLETA nunca la consulta.
  exclusionesPorRol = null,
  // REPROPUESTA_FOCAL_RECALCULA_ROLES_NO_AFECTADOS — idem, solo tiene
  // efecto en la rama que propone una candidata nueva.
  referenciasHeredablesPorRol = null,
  // HERENCIA_FOCAL_NO_DEMOSTRABLE_NO_PUEDE_DEGRADAR_A_RECALCULO_SILENCIOSO
  // — idem, solo tiene efecto en la rama que propone una candidata nueva.
  camposConBaseHeredableNoRecuperable = null,
  rolesContextualesPorRol = null,
  autoridadesContextualesPorRol = null,
} = {}) {
  if (hipotesisPendiente && hipotesisPendiente.estado === 'CONFIRMADA') {
    const entrada = _buscarEmision(sesionId, hipotesisPendiente.hipotesisId, hipotesisPendiente.version);
    if (!entrada || entrada.estadoEmision !== 'CONFIRMADA') {
      // Nunca se reconstruye: sin autoridad verificable (registro vacío tras
      // reinicio, o estado inconsistente), se trata como "no vigente" — el
      // llamador podrá volver a proponer una candidata fresca desde
      // EXPLORANDO, nunca reafirmar esta identidad a ciegas.
      return {
        estado: 'CONFIRMADA_NO_VERIFICABLE',
        diagnostico: { codigo: 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE' },
      };
    }
    const hipotesisReal = entrada.hipotesis;
    const conceptosCausantes = conceptosNoVigentesDe(grafoActual, hipotesisReal.roles);
    if (conceptosCausantes.length === 0) {
      return { estado: 'CONFIRMADA_VIGENTE', hipotesisProyectada: hipotesisPendiente };
    }
    // Obsolescencia real (sección 8/9 de c8df67c): se marca en el registro
    // (eviction mínima — ver cabecera) y se proyecta como dato, sin invocar
    // ninguna transición protegida (nunca fabrica un veredicto).
    const clave = claveEmision(sesionId, hipotesisReal.id, hipotesisReal.version);
    emisionesLegitimas.set(clave, { ...entrada, estadoEmision: 'OBSOLETA' });
    return {
      estado: 'CONFIRMADA_OBSOLETA',
      hipotesisProyectada: congelarProfundo({
        ...hipotesisPendiente,
        estado: 'OBSOLETA',
        obsolescencia: { causa: 'CONCEPTO_NO_VIGENTE', conceptosCausantes },
      }),
    };
  }
  return proponerRelacionTransformacionalDestino({
    sesionId, grafoActual, hipotesisId, turnoPresentacionId, exclusionesPorRol, referenciasHeredablesPorRol,
    camposConBaseHeredableNoRecuperable, rolesContextualesPorRol, autoridadesContextualesPorRol,
  });
}

/**
 * Aplica el veredicto del usuario (confirma/rechaza/corrige — EXACTAMENTE la
 * clasificación ya real de ProgresoConversacionalPolicy.decidirProtocolo,
 * nunca una segunda clasificación paralela) sobre la emisión pendiente
 * EXACTA que fue mostrada — resuelta SIEMPRE contra `emisionesLegitimas`
 * por {sesionId, hipotesisId, version}, nunca reconstruida.
 *
 * De `hipotesisPendienteProyectada` solo se leen `hipotesisId`/`version` —
 * son la CLAVE de búsqueda, nunca datos reconstructivos. Cualquier otro
 * campo (roles, formulacionCongelada, estado, reformulaAId) puede haber sido
 * alterado por el llamador sin que eso importe: la entidad que recibe el
 * veredicto es siempre la registrada, jamás una derivada de esos campos.
 *
 * Si la clave no está en el registro, este módulo NO PUEDE (ni debe) distinguir
 * "nunca se propuso así" de "se propuso en una instancia de proceso anterior,
 * ya reiniciada" — ambos son, estructuralmente, el mismo hecho observable
 * (una búsqueda sin resultado) y se reportan con el mismo código,
 * `IDENTIDAD_DE_EMISION_NO_VERIFICABLE`. Fingir una distinción inventaría
 * información que el proceso no tiene. Nunca hay fallback a re-acuñación.
 *
 * 'corrige' se trata igual que 'rechaza' a nivel de dominio (única
 * transición disponible desde CANDIDATA es RECHAZADA — no existe un tercer
 * estado "CORREGIDA"; mismo criterio que
 * CicloTransformacionalDestinoOrquestacion._confirmarORechazar para
 * clasificacionProtocolo==='corrige' sobre AfirmacionTransformacionalDestino),
 * citando el texto de la corrección literal como motivo del rechazo — nunca
 * reformulado.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.hipotesisPendienteProyectada — debe traer
 *   hipotesisId/version (los únicos campos consultados).
 * @param {'confirma'|'rechaza'|'corrige'} params.clasificacionProtocolo
 * @param {string} params.turnoId — turno en el que el usuario emite el veredicto
 * @param {string} params.textoUsuario — citado literal como evidenciaAtribucion/motivo
 * @returns {{ resultado: string, hipotesis?: object, diagnostico?: object }}
 *   resultado: 'CONFIRMADA' | 'RECHAZADA' |
 *   'IDENTIDAD_DE_EMISION_NO_VERIFICABLE' | 'EMISION_NO_DISPONIBLE'.
 */
function aplicarVeredictoRelacionTransformacionalDestino({
  sesionId, hipotesisPendienteProyectada, clasificacionProtocolo, turnoId, textoUsuario,
} = {}) {
  if (!hipotesisPendienteProyectada || typeof hipotesisPendienteProyectada.hipotesisId !== 'string') {
    throw new Error('CicloHipotesisTransformacionalDestinoOrquestacion: hipotesisPendienteProyectada inválida (falta hipotesisId)');
  }
  if (!['confirma', 'rechaza', 'corrige'].includes(clasificacionProtocolo)) {
    throw new Error(`CicloHipotesisTransformacionalDestinoOrquestacion: clasificacionProtocolo inválida: ${clasificacionProtocolo}`);
  }
  const { hipotesisId, version } = hipotesisPendienteProyectada;

  // 1-2. tomar sesionId+hipotesisId+version, buscar la emisión original.
  const entrada = _buscarEmision(sesionId, hipotesisId, version);
  if (!entrada) {
    // 3. IDENTIDAD_DE_EMISION_NO_VERIFICABLE — cubre tanto "nunca se
    // propuso" como "se propuso antes de un reinicio del proceso" (ver
    // docstring: indistinguibles por construcción).
    return {
      resultado: 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE',
      diagnostico: { codigo: 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE', sesionId, hipotesisId, version },
    };
  }
  if (entrada.estadoEmision !== 'PENDIENTE') {
    // 4. sustituida/consumida/obsoleta — fallo explícito, causa estructurada,
    // nunca una segunda transición sobre la misma emisión.
    return {
      resultado: 'EMISION_NO_DISPONIBLE',
      diagnostico: { codigo: `EMISION_YA_${entrada.estadoEmision}`, estadoEmisionActual: entrada.estadoEmision },
    };
  }

  // 5-6. la referencia pendiente ya coincidió por construcción (es la MISMA
  // clave con la que se recuperó `entrada`) — se aplica la transición sobre
  // el objeto ORIGINAL, nunca sobre uno derivado. 7. Nunca se vuelve a
  // llamar crearHipotesisTransformacionalDestino.
  const clave = claveEmision(sesionId, hipotesisId, version);
  if (clasificacionProtocolo === 'confirma') {
    const confirmada = confirmarHipotesisTransformacionalDestino({
      hipotesis: entrada.hipotesis, turnoId, textoUsuario,
    });
    emisionesLegitimas.set(clave, { ...entrada, hipotesis: confirmada, estadoEmision: 'CONFIRMADA' });
    return { resultado: 'CONFIRMADA', hipotesis: confirmada };
  }
  // 'rechaza' y 'corrige': misma transición de dominio, mismo motivo citado
  // literal (ver docstring).
  const rechazada = rechazarHipotesisTransformacionalDestino({
    hipotesis: entrada.hipotesis, turnoId, textoUsuario,
  });
  emisionesLegitimas.set(clave, { ...entrada, hipotesis: rechazada, estadoEmision: 'RECHAZADA' });
  if (emisionPendientePorSesion.get(sesionId) === clave) emisionPendientePorSesion.delete(sesionId);
  return { resultado: 'RECHAZADA', hipotesis: rechazada };
}

/**
 * circulomejora006_act10h — recupera el contexto autoritativo de
 * clasificación que el generador necesita durante
 * VALIDANDO_RELACION_TRANSFORMACIONAL: punto de entrada único para el
 * llamador (Writer futuro o pruebas) que separa "recuperar contexto
 * autoritativo" (esta función) de "clasificar" (el prompt/LLM, fuera de
 * aquí), "validar y enrutar" (ProgresoConversacionalPolicy, fuera de aquí)
 * y "confirmar o rechazar la emisión" (aplicarVeredictoRelacionTransformacionalDestino,
 * fuera de aquí) — cuatro responsabilidades que este incremento nunca
 * mezcla.
 *
 * Fuente ÚNICA: `emisionesLegitimas`, resuelta por {sesionId, hipotesisId,
 * version} — igual que aplicarVeredictoRelacionTransformacionalDestino.
 * `hipotesisPendienteProyectada` solo aporta la CLAVE de búsqueda; ningún
 * otro campo suyo (formulacionCongelada, roles, estructuraRelacional) se
 * lee jamás aquí — el contexto devuelto se deriva EXCLUSIVAMENTE del objeto
 * autoritativo registrado, nunca de la proyección del llamador. Nunca se
 * llama a crearHipotesisTransformacionalDestino ni a ninguna otra función
 * de re-acuñación.
 *
 * Antes de devolver contexto, verifica vigencia de los conceptos
 * referenciados (mismo criterio que evaluarEstadoRelacionTransformacionalDestino
 * para una CONFIRMADA, aplicado aquí a una CANDIDATA todavía sin veredicto):
 * si alguno dejó de ser vigente, la hipótesis se marca OBSOLETA en el
 * registro (mismo mecanismo ya existente,
 * obsoletarHipotesisPorCambioDeConcepto) y esta función retorna sin
 * contexto — nunca continúa hacia un contexto de clasificación construido
 * sobre una hipótesis inválida.
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual
 * @param {object} params.hipotesisPendienteProyectada — debe traer
 *   hipotesisId/version (los únicos campos consultados).
 * @returns {{ resultado: string, contexto?: object, diagnostico?: object }}
 *   resultado: 'CONTEXTO_DISPONIBLE' | 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE' |
 *   'EMISION_NO_DISPONIBLE' | 'HIPOTESIS_OBSOLETA'.
 *   contexto (solo si CONTEXTO_DISPONIBLE): { hipotesisFormulacionCongelada,
 *   hipotesisComponentesRelacionales: { mecanismo_resultado: {desdeConceptoIds,
 *   haciaConceptoIds}, resultado_observabilidad: {desdeConceptoIds,
 *   haciaConceptoIds} } } — objeto plano congelado, sin métodos, sin
 *   ninguna referencia que permita reconstruir ni reautorizar la hipótesis.
 */
function recuperarContextoAutoritativoRelacionTransformacionalDestino({
  sesionId, grafoActual, hipotesisPendienteProyectada,
} = {}) {
  if (!hipotesisPendienteProyectada || typeof hipotesisPendienteProyectada.hipotesisId !== 'string') {
    throw new Error('CicloHipotesisTransformacionalDestinoOrquestacion: hipotesisPendienteProyectada inválida (falta hipotesisId)');
  }
  const { hipotesisId, version } = hipotesisPendienteProyectada;

  const entrada = _buscarEmision(sesionId, hipotesisId, version);
  if (!entrada) {
    return {
      resultado: 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE',
      diagnostico: { codigo: 'IDENTIDAD_DE_EMISION_NO_VERIFICABLE', sesionId, hipotesisId, version },
    };
  }
  if (entrada.estadoEmision !== 'PENDIENTE') {
    return {
      resultado: 'EMISION_NO_DISPONIBLE',
      diagnostico: { codigo: `EMISION_YA_${entrada.estadoEmision}`, estadoEmisionActual: entrada.estadoEmision },
    };
  }

  const hip = entrada.hipotesis;
  const conceptosCausantes = conceptosNoVigentesDe(grafoActual, hip.roles);
  if (conceptosCausantes.length > 0) {
    // No continúa validando una hipótesis inválida: la obsoleta mediante el
    // mecanismo ya existente (nunca fabrica un veredicto) y detiene el flujo
    // aquí — el llamador nunca llega a construir un prompt ni a invocar el
    // generador sobre esta identidad.
    const obsoleta = obsoletarHipotesisPorCambioDeConcepto({ hipotesis: hip, grafoActual });
    const clave = claveEmision(sesionId, hipotesisId, version);
    emisionesLegitimas.set(clave, { ...entrada, hipotesis: obsoleta, estadoEmision: 'OBSOLETA' });
    return {
      resultado: 'HIPOTESIS_OBSOLETA',
      diagnostico: { codigo: 'CONCEPTO_NO_VIGENTE', conceptosCausantes },
    };
  }

  const hipotesisComponentesRelacionales = {};
  Object.entries(CAMPO_INTERNO_A_COMPONENTE_PUBLICO).forEach(([campoInterno, nombrePublico]) => {
    const componente = hip.estructuraRelacional[campoInterno];
    hipotesisComponentesRelacionales[nombrePublico] = Object.freeze({
      desdeConceptoIds: Object.freeze([...componente.desdeConceptoIds]),
      haciaConceptoIds: Object.freeze([...componente.haciaConceptoIds]),
    });
  });

  return {
    resultado: 'CONTEXTO_DISPONIBLE',
    contexto: Object.freeze({
      hipotesisFormulacionCongelada: hip.formulacionCongelada,
      hipotesisComponentesRelacionales: Object.freeze(hipotesisComponentesRelacionales),
    }),
  };
}

/**
 * circulomejora006_reporte02 (incremento correctivo — idempotencia y
 * recuperación durable) — lectura pura de `emisionesLegitimas`, EXCLUSIVA
 * para el camino de recuperación del Writer tras `EMISION_YA_CONFIRMADA`:
 * ¿la emisión {sesionId, hipotesisId, version} sigue disponible
 * process-localmente y en estado CONFIRMADA? Nunca escribe, nunca transiciona
 * nada, nunca crea un segundo registro — reutiliza `_buscarEmision`, la
 * única función de lectura ya existente sobre el Map. Devuelve el objeto
 * Hipótesis AUTORITATIVO exacto (el mismo que aplicarVeredictoRelacionTransformacionalDestino
 * ya devolvía al confirmar) o null si la clave no está CONFIRMADA (nunca
 * registrada así, ya reinicializada, o en cualquier otro estadoEmision) —
 * en ese caso el llamador no tiene forma de completar la convergencia
 * (límite documentado: proceso reiniciado tras CONFIRMADA y antes de que la
 * convergencia durable completara — ver entrega, nunca se fabrica
 * reconstrucción).
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.hipotesisPendienteProyectada — debe traer
 *   hipotesisId/version (los únicos campos consultados, misma convención
 *   que el resto de este módulo).
 * @returns {object|null} la Hipótesis autoritativa si estadoEmision==='CONFIRMADA', si no null.
 */
function recuperarHipotesisConfirmadaPendienteDeConvergencia({
  sesionId, hipotesisPendienteProyectada,
} = {}) {
  if (!hipotesisPendienteProyectada || typeof hipotesisPendienteProyectada.hipotesisId !== 'string') {
    throw new Error('CicloHipotesisTransformacionalDestinoOrquestacion: hipotesisPendienteProyectada inválida (falta hipotesisId)');
  }
  const { hipotesisId, version } = hipotesisPendienteProyectada;
  const entrada = _buscarEmision(sesionId, hipotesisId, version);
  if (!entrada || entrada.estadoEmision !== 'CONFIRMADA') return null;
  return entrada.hipotesis;
}

/**
 * S1_R_INCREMENTO_3 — recuperación durable de una Hipótesis sucesora CANDIDATA
 * cuyo registro process-local (`emisionesLegitimas`) se perdió (reinicio del
 * proceso — ver auditoría previa: ninguna Hipótesis CANDIDATA sobrevive un
 * reinicio hoy, `emisionesLegitimas`/`hipotesisLegitimas` son ambos
 * process-local). Este módulo nunca lee ni escribe ningún repositorio —
 * `roles`/`turnoPresentacionId` llegan ya resueltos por el llamador (el
 * Writer), exactamente igual que cualquier otro parámetro de este archivo.
 * Nunca guarda ni lee un snapshot completo: `roles` (lo único durable que el
 * llamador persiste aparte) + el MISMO `crearHipotesisTransformacionalDestino`
 * ya existente reproducen, deterministamente, la MISMA formulacionCongelada/
 * estructuraRelacional/snapshotBase que la instancia original — nunca una
 * segunda vía de construcción. Si la emisión YA está disponible este mismo
 * proceso (no hubo reinicio, o esta función ya corrió antes en este mismo
 * proceso), es un no-op — nunca re-registra ni sustituye la PENDIENTE vigente.
 *
 * No aplica ningún veredicto, no resuelve nada — únicamente reinstala la
 * identidad autoritativa para que aplicarVeredictoRelacionTransformacionalDestino/
 * recuperarContextoAutoritativoRelacionTransformacionalDestino puedan
 * resolverla normalmente, sin cambios en ninguno de los dos.
 *
 * @returns {{ estado: 'YA_DISPONIBLE'|'REINSTALADA'|'REINSTALACION_FALLIDA', hipotesis?: object, diagnostico?: object }}
 */
function reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable({
  sesionId, grafoActual, hipotesisId, version, roles, turnoPresentacionId,
} = {}) {
  const yaDisponible = _buscarEmision(sesionId, hipotesisId, version);
  if (yaDisponible) return { estado: 'YA_DISPONIBLE', hipotesis: yaDisponible.hipotesis };
  // P0-A2 (hallazgo durante la extensión al arranque normal de DESTINO,
  // fuera del caso S1-R original) — crearHipotesisTransformacionalDestino
  // LANZA (nunca devuelve diagnóstico) ante una referencia que no existe en
  // absoluto en grafoActual.conceptos ("corrupción de contrato" por diseño,
  // Invariante 1 vs. 2 en _HipotesisTransformacionalDestinoProcessLocal.js
  // — distinto de REFERENCIA_NO_VIGENTE, que sí es un diagnóstico normal).
  // roles/turnoPresentacionId llegan aquí desde datos YA durables (nunca
  // fabricados en esta función), así que en operación normal esa excepción
  // no debería alcanzarse -- pero dejarla escapar convertiría una
  // reinstalación fallida en un HTTP 500 (exactamente la clase de fallo que
  // P0-A1/60a41c4 ya eliminó para el resto de este ciclo). Se captura y se
  // reporta como la MISMA forma REINSTALACION_FALLIDA que ya usa el
  // resultado diagnóstico normal -- nunca se reintenta, nunca se registra
  // una emisión parcial.
  let resultado;
  try {
    resultado = crearHipotesisTransformacionalDestino({
      id: hipotesisId, version, sesionId, gramatica: GRAMATICA_SOPORTADA, grafoActual, roles, turnoPresentacionId,
    });
  } catch (e) {
    return { estado: 'REINSTALACION_FALLIDA', diagnostico: { codigo: 'RECONSTRUCCION_INVALIDA', mensaje: e.message } };
  }
  if (resultado.resultado !== 'CANDIDATA_VALIDA') {
    return { estado: 'REINSTALACION_FALLIDA', diagnostico: resultado.diagnostico };
  }
  _registrarEmisionPendiente(sesionId, resultado.hipotesis);
  return { estado: 'REINSTALADA', hipotesis: resultado.hipotesis };
}

/**
 * S1_R_INCREMENTO_3 — reconstruye, de forma determinista y puramente
 * process-local (nunca escribe nada durable), la memoria negativa
 * (`huellasRechazadas`, privada del dominio) a partir de entradas ya
 * persistidas durablemente — reproduce la MISMA secuencia real
 * crear→rechazar (mismas funciones ya existentes, `crearHipotesisTransformacionalDestino`
 * + `rechazarHipotesisTransformacionalDestino`) que originalmente produjo
 * cada huella — nunca una comparación de texto, nunca una segunda regla de
 * equivalencia. El objeto Hipótesis resultante se descarta: esta función
 * solo importa por su efecto colateral en `huellasRechazadas` (dominio
 * privado). Idempotente y segura de llamar en cada turno — si una entrada
 * ya no es reconstruible (p. ej. una referencia dejó de estar vigente, caso
 * fuera de alcance de este incremento — ver invariantes), esa entrada
 * simplemente no se re-siembra (fail-closed débil: la protección
 * `REPRODUCE_HIPOTESIS_RECHAZADA` puede faltar para ESA huella puntual, pero
 * nunca se fabrica una prohibición falsa ni se aborta el turno completo por
 * esto).
 *
 * @param {object} params
 * @param {string} params.sesionId
 * @param {object} params.grafoActual
 * @param {{roles:object, turnoId:string, textoUsuario:string}[]} params.entradas
 */
function sembrarMemoriaNegativaDesdeRegistroDurable({ sesionId, grafoActual, entradas = [] } = {}) {
  entradas.forEach((entrada, indice) => {
    try {
      // Construcción EFÍMERA, exclusiva de siembra: id sintético, nunca
      // persistido ni registrado en emisionesLegitimas — el único propósito
      // es reproducir, vía rechazarHipotesisTransformacionalDestino más
      // abajo, la misma huella que la instancia original dejó en
      // huellasRechazadas (dominio privado).
      const resultado = crearHipotesisTransformacionalDestino({
        id: `siembra_memoria_negativa_${indice}_${crypto.randomBytes(4).toString('hex')}`,
        version: 1, sesionId, gramatica: GRAMATICA_SOPORTADA, grafoActual,
        roles: entrada.roles, turnoPresentacionId: entrada.turnoId,
      });
      if (resultado.resultado !== 'CANDIDATA_VALIDA') return; // ya bloqueada, o no reconstruible — no-op.
      rechazarHipotesisTransformacionalDestino({
        hipotesis: resultado.hipotesis, turnoId: entrada.turnoId,
        textoUsuario: entrada.textoUsuario || 'Restricción registrada previamente.',
      });
    } catch {
      // No reconstruible (p. ej. referencia ya no vigente) — se omite esta
      // huella puntual, nunca se aborta la siembra completa ni el turno.
    }
  });
}

module.exports = {
  ESTADOS_EMISION,
  construirReferenciasPorRolDestino,
  proyectarHipotesisParaEstado,
  proponerRelacionTransformacionalDestino,
  evaluarEstadoRelacionTransformacionalDestino,
  aplicarVeredictoRelacionTransformacionalDestino,
  recuperarContextoAutoritativoRelacionTransformacionalDestino,
  recuperarHipotesisConfirmadaPendienteDeConvergencia,
  generateHipotesisId,
  reinstalarHipotesisSucesoraPendienteDesdeRegistroDurable,
  sembrarMemoriaNegativaDesdeRegistroDurable,
  recuperarRolesOriginalesPorIdentidad,
};

Object.defineProperty(module.exports, 'validarPropuestasRolesTransformacionales', {
  value: validarPropuestasRolesTransformacionales,
  enumerable: false,
});
Object.defineProperty(module.exports, 'revalidarComposicionTransformacionalPendiente', {
  value: revalidarComposicionTransformacionalPendiente,
  enumerable: false,
});
