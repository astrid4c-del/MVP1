# ADR — El ciclo cognitivo de una conversación de descubrimiento

**Estado:** Implementado y validado con E2E real contra Gemini. Cerrado como Etapa 3 ("Ciclo Cognitivo de Descubrimiento") — ver **MASTER_ROADMAP.md** para la tabla de 8 Incrementos y **CURRENT_STATE.md** para el estado vigente del repositorio. El hallazgo que origina este documento (elevación semántica prematura, ver auditoría previa sobre la conversación de "quinielas") dejó de ser una capacidad faltante: el ciclo elegibilidad → reconocimiento → rechazo, con retroceso real al lenguaje del experto, gobierna hoy tanto conceptos individuales como la síntesis completa de una gramática (`sintesis_interpretativa`) y la reacción visible ante un rechazo. Sección 8 (preguntas abiertas al cierre de este documento) queda resuelta más abajo.

**Contexto:** Una auditoría en vivo, sobre una conversación real del piloto interno, encontró que Círculo interpreta antes de comprender, abstrae antes de validar, y eleva antes de descubrir — y que, una vez que eleva, no tiene ningún mecanismo que lo devuelva al lenguaje del usuario, ni siquiera cuando el usuario rechaza esa elevación explícitamente, dos veces seguidas. Ese hallazgo localizó DÓNDE ocurre (Capa 1, al decidir `observacion`) y QUÉ instrucciones lo incentivan (LEY 3, la ausencia de un gatillo de rechazo, un guardrail de llaneza que rige el campo equivocado). Este documento respondió primero cuál es el modelo correcto del ciclo — y una segunda vuelta encontró que ese primer modelo, aunque definía bien cuándo Círculo puede *proponer* una abstracción, todavía no definía cuándo esa abstracción es *correcta* — dos preguntas distintas, resueltas aquí ambas.

---

## 1. Los estados cognitivos de Círculo

La lista propuesta (Exploración, Comprensión, Validación, Abstracción, Síntesis) está casi bien, pero mezcla dos cosas que deben separarse: **un mecanismo** (Validación) con **un estado resultante** (Comprensión). Comprensión no es una etapa que ocurre después de Validación — es lo que existe *si* algo sobrevive la validación. Tratarlas como dos casilleros sucesivos en una lista es exactamente el error actual: Círculo hoy trata "formulé una interpretación" (o "propuse una abstracción") como si ya fuera "comprendí", sin que medie ningún contacto real con el experto.

El modelo correcto tiene los mismos seis estados, pero como un ciclo con retroalimentación — y, crucialmente, la retroalimentación no termina en Abstracción: pasa a través de ella.

```
Exploración → Interpretación → Validación → [retrocede si falla] → Comprensión
                                                                          │
                                                                          ▼
                                                                    Abstracción (elegible)
                                                                          │
                                                                          ▼
                                                                     Validación ←──┐
                                                                          │        │ [retrocede si falla]
                                                                          ▼        │
                                                            Reconocimiento del experto
                                                                          │
                                                                          ▼
                                                                    Comprensión → Síntesis
```

**Una abstracción nunca nace comprendida.** Pasa por el mismo proceso de validación que cualquier interpretación cruda — Validación no es un peaje que se paga una sola vez al principio del ciclo, es el mismo mecanismo que se vuelve a atravesar cada vez que Círculo produce algo nuevo, sea una lectura simple o una síntesis de alto nivel. Esto es lo que el modelo original todavía no decía: trataba Abstracción y Síntesis como estados casi terminales, alimentando hacia adelante sin volver a exponerse al experto de la misma forma que una interpretación cruda.

Lo que le faltaba a la lista propuesta no era un estado nuevo — era el **arco de retroceso**, aplicado consistentemente en los dos niveles del ciclo (el de interpretación individual, y el de abstracción). Sin ese arco en ambos niveles, cualquier lista de estados sigue siendo, en la práctica, una tubería de un solo sentido — y ese es precisamente el defecto observado.

---

## 2. Elegibilidad y Reconocimiento — dos criterios distintos, no uno

La pregunta "¿cuándo tiene Círculo derecho a abstraer?" en realidad son dos preguntas distintas, y el modelo debe responderlas por separado:

- **Elegibilidad** — ¿tiene Círculo evidencia suficiente para *proponer* esta abstracción sin estar inventando? Es un criterio sobre los insumos. Lo evita es la invención.
- **Reconocimiento** — de todas las abstracciones que la evidencia habría hecho elegibles, ¿fue *esta* la que el experto reconoció como una representación fiel de su propio conocimiento? Es un criterio sobre el resultado. Lo que evita es el desvío.

La distinción importa porque la misma evidencia puede sostener varias abstracciones distintas, y no todas producen la misma experiencia. Con la misma evidencia del turno 4 de "quinielas" (solo los goles editables, columnas de validación), habría sido igual de *elegible* decir "diseñaste un sistema con un solo punto de fallo controlado" que "diseñaste una arquitectura de confianza distribuida" — ambas conectan datos reales, ninguna inventa de la nada. Pero solo una (o quizás ninguna de las dos) sería la que el experto reconocería como "sí, eso es exactamente lo que hago". La evidencia filtra la invención; no elige, entre lo no-inventado, lo correcto.

**El propósito de una abstracción no es sonar más inteligente, más universal ni más elegante. Es aumentar la comprensión del experto sobre su propio conocimiento.** Una abstracción correcta no impresiona — revela. Su prueba de éxito no es la elegancia de la frase, es que el experto reconozca en ella algo sobre sí mismo que antes tenía disperso. Esto es lo que el modelo, antes de esta revisión, dejaba implícito y no debía: el objetivo del proceso entero es el reconocimiento, no la elevación — la elevación es, en el mejor de los casos, un medio; en el peor (el observado), un fin que se persigue por sí solo.

### El criterio de elegibilidad (sin cambios respecto a la primera versión)

**Círculo puede *proponer* una abstracción cuando, y solo cuando, pudiera señalar hacia atrás en la conversación y decir "esto lo dijiste tú" sobre al menos dos cosas concretas y distintas que la abstracción está uniendo — nunca sobre cero, nunca sobre una sola.**

Es un criterio de dominio, no de contenido: no depende de qué tema sea, depende de cuántos puntos concretos y confirmados existen para conectar. Aplicado a la evidencia: en el turno 1 ("Quinielas", una palabra) el conteo es cero — cero elegibilidad, y aun así Círculo abstrajo. Recién en el turno 4 el conteo cruza el umbral — ahí sí habría elegibilidad, siempre que la abstracción conectara esos datos y no otros inventados.

### El criterio de reconocimiento

**Una abstracción es correcta cuando el experto, ante ella, se comporta como alguien frente a algo propio — no cuando lo dice con esas palabras exactas.** No puede reducirse a una confirmación verbal explícita ("sí") — eso sería frágil y, peor, entrenaría a Círculo a perseguir la palabra "sí" en vez de perseguir la representación fiel. El reconocimiento es un criterio epistemológico, no léxico, y se manifiesta de varias formas observables, cualquiera de ellas suficiente:

- el experto **confirma** la abstracción explícitamente;
- el experto **la desarrolla** — añade matices, la extiende, la profundiza;
- el experto **la usa espontáneamente** como base para seguir hablando, sin que se le haya preguntado si la acepta;
- el experto **deja de corregirla** en un momento donde, de haber estado equivocada, tendría motivo evidente para hacerlo (por ejemplo, mientras da un ejemplo concreto que la abstracción supuestamente organiza).

Las cuatro son formas del mismo fenómeno subyacente: la abstracción sobrevivió el contacto con el experto y quedó integrada a cómo él mismo sigue hablando de lo suyo — no fue solo tolerada, fue habitada.

---

## 3. Qué evidencia debe existir antes de proponer (elegibilidad)

Tres condiciones, todas necesarias — pero, como quedó dicho arriba, no suficientes por sí solas para que la abstracción sea correcta, solo para que sea elegible:

- **Cantidad:** al menos dos elementos concretos distintos.
- **Calidad:** esos elementos deben tener autoridad `experto` — afirmados de forma directa o inequívoca por el experto — nunca `inferido`. Una abstracción construida sobre interpretaciones propias de Círculo, todavía no confirmadas, es especulación apilada sobre especulación, no descubrimiento.
- **Ausencia de contradicción vigente:** ninguno de esos elementos puede estar actualmente en estado de rechazo sin haber sido reemplazado por una versión corregida por el propio experto.

Esto ya es, casi textualmente, el mismo criterio de `autoridad`/`procedencia` que el grafo de conocimiento ya aplica a los conceptos — el hallazgo real de esta auditoría es que ese criterio existe para lo que se **guarda**, pero no (todavía) para lo que se **dice**, ni (hasta esta revisión) para decidir si lo dicho fue lo correcto.

---

## 4. Qué significa "comprender" — definición operacional

Comprender no es un estado interno de Círculo ("creo que entendí"). Es relacional, y aplica **al mismo nivel a interpretaciones crudas y a abstracciones** — no son dos definiciones distintas, es la misma definición, aplicada recursivamente cada vez que Círculo produce algo nuevo y se lo devuelve al experto:

**Algo pasa a estado "comprendido" cuando sobrevive un round-trip completo con el experto sin corrección** — Círculo lo formula (aunque sea implícitamente, dentro de una pregunta o un reflejo), el experto responde, y esa respuesta manifiesta reconocimiento en cualquiera de sus formas (confirma, desarrolla, la usa espontáneamente, o deja de corregirla teniendo motivo). Si en cambio el experto la corrige, la rechaza, o la ignora reformulando distinto, eso que se propuso **nunca se promueve** — queda archivado como intento fallido, disponible para aprender de él, pero inválido como base de nada posterior.

Es análogo a un ACK en un protocolo de red, con un matiz importante: no es un ACK de un solo bit (sí/no) — es un ACK que se lee de la forma natural en que la conversación continúa, no de una pregunta de confirmación forzada en cada turno. El emisor no decide unilateralmente que el mensaje llegó; lo sabe porque el receptor lo confirmó, de una de varias formas posibles. Círculo no puede decidir unilateralmente que comprendió, ni que abstrajo bien — solo lo sabe porque el experto, en la forma en que siguió hablando, se lo mostró.

---

## 5. Qué debe ocurrir cuando el usuario rechaza una interpretación o una abstracción

Hoy: nada — el turno siguiente eleva de nuevo, muchas veces más lejos. El comportamiento correcto tiene tres partes, y aplica igual sin importar si lo rechazado fue una interpretación cruda o una abstracción ya elegible:

1. **Lo rechazado pierde autoridad inmediatamente.** El sistema ya tiene el mecanismo para esto en el grafo (`marcarObsoletos`) — el rechazo debe activarlo, no solo quedar como texto conversacional sin efecto sobre el estado.
2. **El turno inmediatamente siguiente a un rechazo tiene prohibido introducir una abstracción nueva.** Debe retroceder a Interpretación o Exploración, usando el vocabulario literal que el experto acaba de usar para corregir — nunca una abstracción distinta a la rechazada, aunque suene mejor.
3. **El rechazo debe subir el umbral, no solo reiniciarlo.** Un solo rechazo pide retroceder una vez. Dos rechazos consecutivos sobre la misma dimensión son una señal más fuerte: Círculo está buscando el patrón equivocado, no solo la palabra equivocada — el criterio de elegibilidad para volver a intentar abstraer en esa dimensión debe volverse más exigente (más datos concretos, no los mismos dos de antes reformulados), no quedarse igual.

Este último punto es el que la evidencia (quinielas, dos rechazos seguidos, sin ningún cambio de comportamiento) muestra más claramente ausente hoy. Y, dado el punto 2 de esta revisión, "rechazo" ya no significa solo un "no" explícito — significa también la ausencia sostenida de cualquiera de las cuatro señales de reconocimiento cuando había motivo para esperarlas.

---

## 6. La evolución del lenguaje durante la conversación

La progresión propuesta (usuario → compartido → conceptual → estratégico) captura una intuición real, pero tal como está planteada — una escalera de un solo sentido, ligada al avance de turnos — puede terminar re-autorizando el mismo defecto a otro nivel: si "lenguaje estratégico" es la meta garantizada del final de la conversación, nada impide llegar ahí sin haber ganado el derecho, igual que hoy. Dos correcciones:

**Debe ser una progresión ganada por evidencia y reconocimiento, no por tiempo — y debe poder retroceder.** No es una escalera que sube sola con cada turno; es un trinquete que solo avanza cuando la elegibilidad lo autoriza *y* el reconocimiento lo confirma (los dos criterios del punto 2), y que un rechazo (punto 5) puede hacer retroceder.

**Las etapas en sí deberían nombrarse por su función epistémica, no por su registro:**

1. **Lenguaje del experto** — lo dicho literalmente. La única fuente de autoridad real.
2. **Lenguaje reflejado** — Círculo devuelve lo mismo, reorganizado, sin vocabulario nuevo (Ley 4 en su forma más pura). Esto es Comprensión en acto, todavía sin invención.
3. **Lenguaje conectado** — Círculo empieza a unir dos o más piezas ya confirmadas, todavía cerca del vocabulario del experto, mostrando relación sin bautizarla todavía. Este es el umbral mínimo de elegibilidad del punto 2.
4. **Lenguaje nombrado** — Círculo le da un nombre propio a un patrón — la estrella, la transformación. Pero, igual que en el punto 1, este nombre nace *propuesto*, no confirmado: se vuelve estable recién cuando el experto lo reconoce (punto 2); mientras tanto sigue siendo una hipótesis, aunque suene terminada. Este es el reencuadre real de la Ley 3, reservado para cuando ya hay algo que reencuadrar.

"Estratégico" no es universal — la estrella de una panadera no necesita sonar a consultoría para ser una estrella real; necesita sonar a ella. Lo que sí es universal es la distancia progresiva respecto al dato crudo, ganada paso a paso y confirmada por quien la vive, nunca asumida.

---

## 7. El modelo arquitectónico mínimo — generalizable a las 5 gramáticas

Sin tocar prompts ni escribir código: el modelo se apoya enteramente en primitivas que **ya existen** y que **ya son transversales** a las 5 gramáticas (D-037: `observacion`/Realizador no conocen la gramática de origen; el grafo con `autoridad`/`procedencia` tampoco es específico de ninguna). No hace falta un mecanismo nuevo por gramática — hace falta que un mecanismo ya universal alcance tres lugares donde hoy no llega:

- **Una decisión de "elegibilidad" derivable del grafo existente** — cuántos conceptos `autoridad:"experto"` sostienen la dimensión en juego, y si alguno fue rechazado sin reemplazo — sin ningún dato nuevo que guardar, solo una lectura distinta de lo que el grafo ya tiene.
- **Una señal de reconocimiento, más amplia que una señal de confirmación/rechazo binaria.** El sistema ya sabe detectar confirmación/rechazo de una síntesis cerrada (D-033/D-040); lo que falta es que ese mismo tipo de lectura, aplicada a una abstracción intermedia dentro de EXPLORANDO (no solo al cierre de una gramática completa), reconozca también sus formas indirectas — que el experto la haya desarrollado, usado espontáneamente, o simplemente no corregido teniendo motivo — no solo un "sí" o un "no" explícitos. Sigue sin ser un dato nuevo que guardar: es una lectura más rica del mismo turno del experto que el sistema ya recibe completo.
- **Que esa doble decisión (elegibilidad al proponer, reconocimiento al turno siguiente) viaje junto con `observacion` hacia el Realizador.** Hoy el Realizador recibe `observacion` a ciegas, sin saber si esa observación tiene derecho ganado a ser una abstracción nueva, si debe sonar todavía como propuesta tentativa, o si ya fue reconocida y puede sonar asentada. No necesita ver el mensaje del experto ni el grafo completo (eso rompería el aislamiento que D-036 demostró necesario) — necesita una sola señal adicional, ya calculada por Capa 1: en qué punto del ciclo (punto 1) está lo que va a decir este turno.

Ninguna pieza de esto exige lógica específica de gramática, ni tocar `protocoloEstado`, ni reabrir el rediseño de los tres modelos (Conocimiento/Conversación/Proceso) — encaja dentro de él sin extenderlo: la elegibilidad vive enteramente en Conocimiento (se deriva del grafo), el reconocimiento vive en Conversación (es del intercambio pendiente, no del contenido). No es una sexta gramática ni un cuarto dominio — es una regla que combina dos dominios ya existentes, exactamente el tipo de regla que ese ADR ya reservó para la Política, nunca para el prompt.

---

## Preguntas abiertas

- El umbral exacto de elegibilidad ("al menos dos elementos") es un mínimo defendible por diseño, no un número medido — vale la pena observarlo contra más conversaciones reales antes de fijarlo con más precisión.
- No se definió aquí el mecanismo concreto de detección de reconocimiento (¿una clasificación derivada por turno? ¿una heurística sobre si el experto retomó el vocabulario propuesto?) — eso es diseño de implementación, deliberadamente fuera de este documento.
- Cómo se traduce "en qué punto del ciclo está lo que va a decir este turno" en una señal concreta que el Realizador consuma tampoco se resolvió aquí — es la primera pregunta de implementación cuando este modelo se autorice.

---

## Estado de implementación (cierre — Etapa 3)

- **Umbral de elegibilidad:** sigue siendo el mínimo de diseño (`UMBRAL_ELEGIBILIDAD_BASE = 2`, `GrafoProyeccion.js`), nunca medido contra uso real. Sigue abierto, sin cambios respecto a lo dicho arriba.
- **Detección de reconocimiento:** resuelto para el nivel de síntesis — clasificación explícita `confirma`/`corrige`/`rechaza`/`ambiguo` por turno (`ProgresoConversacionalPolicy.decidirProtocolo`), con `aplicarDeltaReconciliacion.inferenciasConfirmadas`/`inferenciasRechazadas` como el mecanismo real de promoción/invalidación. Las cuatro formas indirectas de reconocimiento descritas en la Sección 2 (desarrollar, usar espontáneamente, dejar de corregir) no se implementaron como detección separada dentro de `EXPLORANDO` — quedan, todavía, como el juicio implícito del propio generador al clasificar, no como una señal estructural propia. Sigue siendo trabajo de implementación futuro si se decide cerrar esa brecha.
- **Señal de nivel de lenguaje hacia el Realizador:** resuelto — `GrafoProyeccion.calcularNivelLenguaje` (reflejado/propuesta/reconocida) viaja al Realizador Conversacional. Con la restauración de D-037 (Etapa 3, Incremento 8), el Realizador quedó exclusivo de `EXPLORANDO`+grafo — la señal nunca llega a `LISTO_PARA_SINTESIS` ni `ESPERANDO_CONFIRMACION`, donde la reacción visible es, respectivamente, el `mensaje` directo de Capa 1 y (ante un rechazo) una composición determinista (`reaccionRechazoControlada`), nunca una segunda pasada generativa.
- **Capacidad no contemplada en el análisis original, añadida durante la implementación:** la síntesis completa de una gramática (Sección 6, "lenguaje nombrado") resultó ser el mismo tipo de objeto que una abstracción intermedia — se modeló como concepto `sintesis_interpretativa` del grafo, con el mismo ciclo elegibilidad/reconocimiento/rechazo, más una memoria negativa local y acumulativa por gramática (`sintesisRechazadasDeGramatica`) que reinyecta cada interpretación ya rechazada — con su razón real — en la regeneración siguiente. No estaba previsto en este documento; ver **MASTER_ROADMAP.md**, Etapa 3, Incrementos 5-8.
