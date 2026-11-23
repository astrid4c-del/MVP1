'use strict';

/**
 * MOCK FIXTURES — smoke test local determinístico del pipeline completo
 * Datos estáticos, uno por etapa/prompt del Modelo Agora. Cada fixture es el
 * mínimo JSON válido que el executor/Inteligencia correspondiente necesita
 * para satisfacer su contrato (entrada/salida) y sus gates — no reproduce
 * razonamiento ni contenido real, son valores fijos de relleno.
 *
 * Aislado deliberadamente en su propio archivo, separado del dispatcher
 * (MockAnthropicFetch.js) y del bootstrap (bin/start-server.js).
 *
 * Las 5 gramáticas (destino..darvida) usan fixtures CONVERSACIONALES: en vez
 * de un único payload que resuelve la etapa en el primer turno, cada una
 * define una secuencia de turnos (`turns`) — información parcial primero,
 * luego una propuesta de cierre (`proponiendo_cierre:true`), y solo en el
 * turno siguiente el completeFlag en true. El dispatcher (MockAnthropicFetch.js)
 * avanza por esta secuencia contando cuántas veces se invocó cada marcador.
 *
 * Limitación conocida (no corregida aquí): gramaticaExecutor no envía el texto
 * real del usuario en cada llamada al LLM (usa un userMsg fijo de "continúa la
 * conversación"), así que ni el mock ni una llamada real a Anthropic con el
 * código actual pueden decidir por CONTENIDO si el primer mensaje ya trae toda
 * la información. La progresión aquí es por número de turno, no por contenido.
 *
 * Ref: NEXT_TASK.md — corrección del flujo conversacional — fixtures
 *      conversacionales del modo mock.
 */

// ── Las 5 gramáticas: DESTINO → DESTILAR → TRADUCIR → ASCENSO → DAR VIDA ──────
// Cada turno llena progresivamente los slots de esa gramática (ver AgoraSlots.js
// / SLOTS_BY_GRAMATICA). El último turno del arreglo se reutiliza para
// cualquier turno adicional más allá de los definidos.

const GRAMATICA_FIXTURES = {
  destino: {
    marker: 'destino_completo',
    turns: [
      {
        mensaje: 'Entiendo. Ayudas a pequeños negocios a tomar mejores decisiones financieras. ¿Qué cambia concretamente en ellos después de aprender contigo?',
        entendido: {
          conocimiento: 'Organizar y entender el flujo de caja de un negocio pequeño',
        },
        proponiendo_cierre: false,
        destino_completo: false,
      },
      {
        mensaje: 'Entonces: hoy deciden a ojo sin ver el flujo real; después de esto van a mirar la caja antes de gastar, y lo notarás porque detectan un mes con caja negativa aunque hubo ventas. ¿Así es como lo ves?',
        entendido: {
          antes: 'No distinguen entre lo que entra y la ganancia real',
          despues: 'Deciden mirando el flujo de caja, no por intuición',
          evidencia: 'Detectan un mes con caja negativa aunque hubo ventas',
        },
        proponiendo_cierre: true,
        destino_completo: false,
      },
      {
        mensaje: 'Perfecto, avancemos.',
        entendido: {},
        proponiendo_cierre: false,
        destino_completo: true,
      },
    ],
  },
  destilar: {
    marker: 'destilar_completo',
    turns: [
      {
        mensaje: 'Ya veo lo que para ti es evidente. ¿Dónde se equivoca típicamente la gente que recién empieza?',
        entendido: {
          obvio: 'Que el saldo de la cuenta no es lo mismo que la ganancia',
        },
        proponiendo_cierre: false,
        destilar_completo: false,
      },
      {
        mensaje: 'Entonces: lo obvio para ti es que saldo no es ganancia, el error típico es confundir lo que entra con la ganancia real, y tu secuencia mental es mirar, comparar y decidir. ¿Es así?',
        entendido: {
          errores: 'Confunden el dinero que entra con la ganancia real',
          esencia: 'Mirar, comparar, decidir',
        },
        proponiendo_cierre: true,
        destilar_completo: false,
      },
      {
        mensaje: 'Perfecto, sigamos.',
        entendido: {},
        proponiendo_cierre: false,
        destilar_completo: true,
      },
    ],
  },
  traducir: {
    marker: 'traducir_completo',
    turns: [
      {
        mensaje: 'Entiendo a quién le sirve esto. ¿Puedes describir un momento concreto donde ese dolor se hace evidente?',
        entendido: {
          relevancia: 'Cree que necesita un contador para todo',
        },
        proponiendo_cierre: false,
        traducir_completo: false,
      },
      {
        mensaje: 'Entonces: cree que necesita un contador para todo, el momento doloroso es recibir el estado de cuenta a última hora sin saber leerlo, y el camino es vocabulario, preguntas guía y práctica. ¿Así es?',
        entendido: {
          mundo_real: 'Recibe el estado de cuenta a última hora y no sabe leerlo',
          secuencia: 'Vocabulario, preguntas guía, práctica',
        },
        proponiendo_cierre: true,
        traducir_completo: false,
      },
      {
        mensaje: 'Perfecto, sigamos.',
        entendido: {},
        proponiendo_cierre: false,
        traducir_completo: true,
      },
    ],
  },
  ascenso: {
    marker: 'ascenso_completo',
    turns: [
      {
        mensaje: 'Ya veo el primer ensayo sin costo. ¿Cuál es el momento donde ya no puede des-ver lo que aprendió?',
        entendido: {
          ensayo: 'Revisa un caso ficticio antes de aplicarlo en uno real',
        },
        proponiendo_cierre: false,
        ascenso_completo: false,
      },
      {
        mensaje: 'Entonces: ensaya con un caso ficticio, la experiencia irreversible es encontrar solo un error que antes no veía, y sube de guiado a acompañado a solo. ¿Es así?',
        entendido: {
          prueba_propia: 'Encuentra solo un error que antes no veía',
          escalon: 'Guiado, acompañado, solo',
        },
        proponiendo_cierre: true,
        ascenso_completo: false,
      },
      {
        mensaje: 'Perfecto, sigamos.',
        entendido: {},
        proponiendo_cierre: false,
        ascenso_completo: true,
      },
    ],
  },
  darvida: {
    marker: 'darvida_completo',
    turns: [
      {
        mensaje: 'Esa es la pregunta que quieres instalar. ¿Cuándo se activa esa voz cuando ya no estás tú presente?',
        entendido: {
          voz: '¿Esto es un gasto o una inversión?',
        },
        proponiendo_cierre: false,
        darvida_completo: false,
      },
      {
        mensaje: 'Entonces: la voz interior pregunta si es gasto o inversión, se activa al recibir un documento nuevo estando a solas, y sabrás que ya se instaló cuando lo haga sin pensarlo. ¿Así es?',
        entendido: {
          momento_solo: 'Al recibir un documento financiero nuevo, a solas',
          vida_propia: 'Aplica el criterio sin recordar de dónde salió',
        },
        proponiendo_cierre: true,
        darvida_completo: false,
      },
      {
        mensaje: 'Perfecto. Aquí está lo que construimos juntos.',
        entendido: {},
        proponiendo_cierre: false,
        darvida_completo: true,
      },
    ],
  },
};

// ── Auditor de fidelidad factual (usado dentro de "opciones") ────────────────
// Siempre aprueba: no hay afirmaciones sin cobertura en los hechos permitidos.
// No es conversacional: el auditor no sostiene un diálogo con el experto.

const AUDITOR_FIXTURE = {
  marker: 'auditor de afirmaciones factuales',
  payload: {
    afirmaciones_no_cubiertas: [],
    valida: true,
  },
};

// ── Motor de Inferencia (avatar + promesa) ───────────────────────────────────
// Etapa de razonamiento interno de una sola pasada (no conversacional en v0).

const INFERENCIA_FIXTURE = {
  marker: 'Motor de Inferencia de Círculo',
  payload: {
    avatar: {
      situacion_actual: {
        valor: 'Persona que decide sin apoyo financiero formal',
        evidencia: 'slot:antes',
        confianza: 'alta',
      },
    },
    promesa: {
      valor: 'Decidir con criterio propio en minutos',
      evidencia: 'slot:despues',
    },
    pregunta_pendiente: null,
    mensaje_usuario: 'Ya tengo un primer retrato de a quién ayudas y qué le ofreces.',
  },
};

// ── Presentación de opciones (avatar/promesa) ────────────────────────────────

const OPCIONES_FIXTURE = {
  marker: 'módulo de presentación de Círculo',
  payload: {
    mensaje_usuario: 'Escuchándote, apareció un patrón claro de a quién ayudas y qué le ofreces.',
    avatar_opciones: [
      { label: 'Recomendada', texto: 'Trabajas con quien decide sin apoyo financiero formal.' },
      { label: 'Opción B',    texto: 'Alternativa B de avatar.' },
      { label: 'Opción C',    texto: 'Alternativa C de avatar.' },
    ],
    promesa_opciones: [
      { label: 'Recomendada', texto: 'Decides con criterio propio.', porque: 'slot:despues' },
      { label: 'Opción B',    texto: 'Alternativa B de promesa.',    porque: 'slot:despues' },
      { label: 'Opción C',    texto: 'Alternativa C de promesa.',    porque: 'slot:despues' },
    ],
  },
};

// ── Arquitectura (una sola candidata: evita pausa HITL por bifurcación) ──────
// Vocabulario deliberadamente distinto al de "errores" (destilar) para no
// disparar el gate de anti-patrón del primer módulo.

const ARQUITECTURA_FIXTURE = {
  marker: 'módulo de Arquitectura de Círculo',
  payload: {
    mensaje_usuario: 'Así quedaría organizado el camino.',
    existe_segunda_estrategia_legitima: false,
    arquitecturas: [
      {
        label: 'Recomendada',
        resumen: 'Camino único de tres módulos',
        criterio_diferenciador: null,
        justificacion_unica: 'No existe una segunda estrategia legítima anclada en la evidencia',
        modulos: [
          { titulo: 'Módulo 1', funcion_transformadora: 'Distinguir activo de pasivo',
            cambio_observable: 'Clasifica correctamente una cuenta', anclaje: 'secuencia' },
          { titulo: 'Módulo 2', funcion_transformadora: 'Calcular liquidez disponible',
            cambio_observable: 'Calcula meses de cobertura', anclaje: 'esencia' },
          { titulo: 'Módulo 3', funcion_transformadora: 'Decidir con criterio propio',
            cambio_observable: 'Resuelve un caso ficticio sin ayuda', anclaje: 'prueba_propia' },
        ],
      },
    ],
  },
};

// ── Evidencia por módulo ──────────────────────────────────────────────────────

const EVIDENCIA_FIXTURE = {
  marker: 'módulo de Evidencia de Círculo',
  payload: {
    mensaje_usuario: 'Así se vería el cambio en cada módulo.',
    evidencias: [
      { modulo: 'Módulo 1', evidencia: 'Clasifica correctamente una cuenta', como_se_reconoce: 'Sin errores en 3 intentos', anclaje: 'secuencia' },
      { modulo: 'Módulo 2', evidencia: 'Calcula meses de cobertura', como_se_reconoce: 'El número coincide con el esperado', anclaje: 'esencia' },
      { modulo: 'Módulo 3', evidencia: 'Resuelve un caso ficticio sin ayuda', como_se_reconoce: 'Lo hace sin consultar', anclaje: 'prueba_propia' },
    ],
  },
};

// ── Forma del producto (dos activos) ─────────────────────────────────────────

const FORMA_FIXTURE = {
  marker: 'módulo final de Círculo',
  payload: {
    mensaje_usuario: 'Esto es lo que construimos juntos.',
    forma_unica: true,
    forma_recomendada: { nombre: 'Workbook con práctica guiada', por_que: 'Coherente con las evidencias definidas' },
    forma_alternativa: null,
    producto_estructura: {
      nombre_provisional: 'Finanzas con criterio propio',
      forma: 'Workbook con práctica guiada',
      modulos: [
        { titulo: 'Módulo 1', medio_recomendado: 'texto',    que_contiene: 'Explicación breve' },
        { titulo: 'Módulo 2', medio_recomendado: 'ejercicio', que_contiene: 'Cálculo guiado' },
        { titulo: 'Módulo 3', medio_recomendado: 'ejercicio', que_contiene: 'Caso ficticio' },
      ],
    },
    blueprint_privado: {
      avatar: 'Avatar elegido',
      promesa: 'Promesa elegida',
      por_que_este_camino: 'Único camino causal anclado en la evidencia',
      evidencias_clave: 'Las 3 evidencias definidas',
      medios: 'Texto y ejercicios',
      nota_reutilizacion: 'Reutilizable en emails y lanzamientos',
    },
  },
};

// ── Desarrollo de módulo (misma fixture reutilizada por módulo) ──────────────

const DESARROLLO_FIXTURE = {
  marker: 'módulo de Desarrollo de Círculo',
  payload: {
    titulo: 'Desarrollo del módulo',
    experiencias: [
      { tipo: 'ejemplo', para_que: 'Acerca al alumno a la evidencia', contenido: 'Contenido de ejemplo' },
    ],
    ejercicio: { consigna: 'Resuelve el caso propuesto', que_demuestra: 'La evidencia del módulo' },
    materiales_pendientes: [],
  },
};

// ── Bonus (opcional) ──────────────────────────────────────────────────────────

const BONUS_FIXTURE = {
  marker: 'módulo de Bonus de Círculo',
  payload: {
    mensaje_usuario: 'Y para acompañarlo, esto te ayudaría a ir más rápido.',
    bonus_recomendado: { tipo: 'Plantilla', nombre: 'Checklist de liquidez', que_resuelve: 'Acelera la revisión mensual', por_que: 'Ancla en la evidencia del módulo 2' },
    bonus_alternativo: null,
  },
};

// ── Registro de fixtures, en el orden en que conviene comprobarlos ───────────
// (los marcadores son mutuamente excluyentes: cada prompt solo contiene uno)

const ALL_FIXTURES = [
  GRAMATICA_FIXTURES.destino,
  GRAMATICA_FIXTURES.destilar,
  GRAMATICA_FIXTURES.traducir,
  GRAMATICA_FIXTURES.ascenso,
  GRAMATICA_FIXTURES.darvida,
  AUDITOR_FIXTURE,
  INFERENCIA_FIXTURE,
  OPCIONES_FIXTURE,
  ARQUITECTURA_FIXTURE,
  EVIDENCIA_FIXTURE,
  FORMA_FIXTURE,
  DESARROLLO_FIXTURE,
  BONUS_FIXTURE,
];

// Fixture de respaldo: se usa solo si ningún marcador coincide (prompt no
// reconocido). Mantiene el fetch determinístico sin lanzar ni bloquear.
const FALLBACK_PAYLOAD = Object.freeze({
  entendido: {},
  mensaje: 'No reconozco esta etapa todavía; continuemos con lo que ya tenemos.',
  mensaje_usuario: 'No reconozco esta etapa todavía; continuemos con lo que ya tenemos.',
});

module.exports = {
  ALL_FIXTURES,
  FALLBACK_PAYLOAD,
  GRAMATICA_FIXTURES,
  AUDITOR_FIXTURE,
  INFERENCIA_FIXTURE,
  OPCIONES_FIXTURE,
  ARQUITECTURA_FIXTURE,
  EVIDENCIA_FIXTURE,
  FORMA_FIXTURE,
  DESARROLLO_FIXTURE,
  BONUS_FIXTURE,
};
