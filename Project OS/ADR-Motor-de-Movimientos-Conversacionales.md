# ADR — Motor de Movimientos Conversacionales

**Estado:** Propuesto. No implementado. Traduce a arquitectura el comportamiento ya congelado en **BEHAVIORAL-SPEC-Movimientos-Conversacionales.md** — este documento no vuelve a discutir propósito, efecto humano ni principios de producto; los da por resueltos y solo pregunta cómo se calculan y se conectan.

**Contexto:** El Behavioral Spec definió QUÉ debe lograr cada movimiento (REFLEJAR, EXPLORAR, CONECTAR, HIPÓTESIS, DESAFIAR, PENSAR EN VOZ ALTA, RESUMIR, POTENCIAR) y dejó 4 preguntas explícitamente para este ADR. Este documento responde la primera y la segunda — qué recibe el motor y qué restringe cada movimiento — y define la forma de la decisión que produce. Las preguntas 3 y 4 (Observación, adaptación del turno siguiente) quedan fuera de alcance a propósito: son ADR 2 y ADR 3, documentos separados, nunca resueltos por inferencia aquí.

**Lema de este ADR:** *La arquitectura optimiza efectos conversacionales. El lenguaje es únicamente el medio para producirlos.* Todo lo que sigue — Economía Conversacional, Invisibilidad, la separación movimiento/redacción, el Realizador — gira alrededor de esta única idea.

**Nota de disciplina, antes de leer lo que sigue:** este documento distingue explícitamente **principios permanentes** (no se revisan sin abrir una discusión aparte) de **decisiones de implementación** (propuestas iniciales, sujetas a validación mediante evaluación conversacional real antes de consolidarse como contrato). El §5 en particular es una hipótesis de trabajo, no un contrato cerrado — se marca así a propósito.

---

## 0. Contrato de compatibilidad con la arquitectura cognitiva existente

Toda evolución de esta arquitectura debe ser **compatible con la arquitectura cognitiva existente** — nunca reemplazarla, nunca competir con ella. No estamos rediseñando Círculo, ni las gramáticas, ni el propósito de DESTINO, DESTILAR, TRADUCIR, ASCENSO o DAR VIDA: cada una sigue siendo válida, intacta, fuera de discusión. La pregunta nunca es "¿cómo debería funcionar el nuevo Círculo?" — es "¿cómo debería comportarse mejor el mismo Círculo?".

La compatibilidad tiene tres dimensiones, y las tres deben cumplirse siempre:

- **Compatibilidad funcional.** La gramática sigue cumpliendo exactamente el mismo propósito que hoy.
- **Compatibilidad cognitiva.** No cambia el modelo mental de Círculo — sigue siendo comprender, inferir, validar, desarrollar (el ciclo de Etapa 3, intacto).
- **Compatibilidad conversacional.** Esta capa solo mejora la forma en que ocurre esa comprensión — nunca la reemplaza.

**Las gramáticas responden el qué. El Motor de Movimientos Conversacionales mejora el cómo.**

Prueba de conformidad — cualquier decisión de este ADR (y de ADR 2 y ADR 3, cuando existan) debe pasarla antes de aceptarse:

1. Si cambia el propósito de una gramática, es la arquitectura equivocada.
2. Si obliga a reescribir la lógica propia de una gramática, probablemente estamos acoplando donde no debemos.
3. Si una gramática puede seguir haciendo exactamente el mismo trabajo, pero con conversaciones más naturales, más precisas y más económicas, vamos por el camino correcto.

Esta capa acompaña al ciclo cognitivo — nunca lo reemplaza. Si en algún punto de la implementación esta frontera deja de sentirse clara, es señal de que la arquitectura empezó a absorber responsabilidades que legítimamente pertenecen a las gramáticas, y hay que detenerse antes de seguir.

---

## 1. Alcance

Este motor decide **qué movimiento intentar este turno** — nunca cómo redactarlo. La redacción sigue siendo, exactamente como hoy, responsabilidad de Capa 1 (contenido) y del Realizador Conversacional (D-036/037, registro final). Este documento no toca:

- el grafo de conocimiento ni su gobernanza de autoridad (Etapa 3, intacta);
- el Realizador Conversacional ni su alcance (EXPLORANDO + grafo, D-037 restaurado);
- los contratos por `protocoloEstado` (`ProgresoConversacionalPolicy`);
- ninguna gramática ni su misión.

Es una capa nueva, previa a la construcción del prompt de EXPLORANDO — análoga a `elegibilidadPorDimension` y `contextoGrafoAnteriores`, que ya se calculan hoy antes de invocar al LLM.

---

## 2. Principios arquitectónicos (permanentes — no decisiones de implementación)

**El movimiento es una decisión, no un estado.** No pertenece a la conversación ni a la sesión — pertenece al turno. Se recalcula por completo en cada turno, a partir del estado actual del grafo; nunca se persiste como un atributo de la conversación (nunca debería existir algo como `conversation.movement`). Esto mantiene el motor adaptable: un cambio real en el grafo entre un turno y el siguiente puede cambiar el movimiento disponible de inmediato, sin arrastrar ningún estado previo.

**Movimiento ≠ Gramática.** Las 5 gramáticas nunca determinan el movimiento — como mucho lo influyen a través de qué dimensiones tienen pendientes. Se prohíbe explícitamente cualquier mapeo fijo del tipo "DESTINO → EXPLORAR, TRADUCIR → CONECTAR, ASCENSO → POTENCIAR". El movimiento depende únicamente del estado conversacional (distancia, ver §5) — el mismo cálculo debe poder producir cualquier movimiento en cualquier gramática, si el estado lo justifica.

---

## 3. Compromiso arquitectónico central

Hoy `movimiento` es un campo que el LLM elige libremente dentro del contrato (`"movimiento": "REFLEJAR | CONECTAR | HIPOTESIS | DESAFIAR | PENSAR_EN_VOZ_ALTA | RESUMIR"`). Este ADR propone retirar esa libertad: **el motor decide el movimiento de forma determinística, antes de la llamada al LLM** — el mismo principio que ya rige `next_user_action` (`decidirProtocolo`) y `elegibleParaAbstraer` (nunca se confía en que el LLM elija bien; se calcula y se impone).

Esto es consistente con Economía Conversacional e Imperceptibilidad del Behavioral Spec: si el LLM elige el movimiento, cada turno arriesga reinventar el criterio; si el motor lo decide, el criterio es el mismo siempre, y la conversación deja de depender de que el modelo "se acuerde" de portarse bien.

---

## 4. Entrada

El cálculo recibe únicamente lo que el motor ya tiene, sin ningún dato nuevo que persistir:

- `grafo` (`state.knowledgeGraph`) — conceptos, autoridad, procedencia; ya existe.
- `gramaticaActiva` — ya existe. (Ver §2 — influye, nunca determina.)
- `protocoloEstado` — ya existe (`EXPLORANDO`/`LISTO_PARA_SINTESIS`/`ESPERANDO_CONFIRMACION`).
- `dimensionesPendientes(grafo, gramatica)` — ya existe (`GrafoProyeccion`).
- `elegibleParaAbstraer(grafo, dimension)` / `umbralElegibilidad` — ya existen.
- Reconocimiento acumulado de esta gramática — derivable de conceptos con `autoridad:'experto'` cuyo origen fue `inferenciasConfirmadas` (hoy no se distingue de un experto declarado directo por procedencia — ver §7, riesgo abierto).

Nada de esto es un dato nuevo. Es la misma información que `elegibilidadPorDimension` y `calcularNivelLenguaje` ya leen hoy, reorganizada para una pregunta distinta. Se recalcula por completo en cada turno — nunca se guarda entre turnos (§2).

---

## 5. Restricciones — señal conversacional propuesta (hipótesis de implementación, no contrato)

El Behavioral Spec dejó como pregunta abierta cómo combinar evidencia y reconocimiento en una sola señal. Este ADR no la da por resuelta — la propone como primera hipótesis de trabajo, explícitamente sujeta a validación antes de consolidarse:

> Existe una señal conversacional derivada del estado epistemológico actual, cuya responsabilidad es restringir los movimientos disponibles. La implementación inicial propone representarla mediante cuatro niveles ordinales, derivados de `elegibleParaAbstraer` (evidencia) y de si ya ocurrió reconocimiento en esta gramática. Esta representación queda sujeta a validación mediante evaluación conversacional real antes de consolidarse como contrato permanente — no se congela con este ADR.

Tabla de la implementación inicial propuesta (no un contrato cerrado):

| Nivel propuesto | Condición (derivada, nunca almacenada) | Movimientos disponibles |
|---|---|---|
| **MÁXIMA** | Ninguna dimensión pendiente tiene evidencia `experto` todavía | EXPLORAR, REFLEJAR |
| **ALTA** | 1+ dimensión tiene evidencia, pero ninguna alcanza `elegibleParaAbstraer` | REFLEJAR, CONECTAR (solo sobre lo ya confirmado) |
| **MEDIA** | 1+ dimensión alcanza `elegibleParaAbstraer`, sin reconocimiento logrado todavía en esta gramática | + HIPÓTESIS (nivel de lenguaje `propuesta`) |
| **MÍNIMA** | Reconocimiento logrado (`inferenciasConfirmadas`) en 1+ dimensión de esta gramática | + PENSAR EN VOZ ALTA; + RESUMIR si `coberturaCompleta` |

Si la validación conversacional muestra que 4 niveles ordinales no capturan bien el comportamiento deseado, se ajusta esta tabla sin que eso implique revisar §1-§4 ni §6-§8 — es exactamente lo que separar principios de implementación debería lograr.

**Punto abierto, marcado explícitamente en vez de resuelto por conveniencia:** DESAFIAR no encaja limpio en esta escala — el Behavioral Spec sugiere que necesita algo de base para generar tensión real, pero podría no requerir reconocimiento pleno (una contradicción entre dos evidencias `experto` ya alcanza para desafiar, sin que nada se haya reconocido todavía). Se propone tentativamente en **MEDIA o superior**, condicionado a que exista una contradicción detectable entre 2+ conceptos `experto` de la misma dimensión — pero esto exige revisar si tal detección ya existe en algún lado del motor o es una capacidad nueva. No se resuelve aquí.

---

## 6. Decisión — forma de la salida

El cálculo produce un objeto interno, nunca visible al usuario, consumido por el constructor del prompt (`buildProtocoloBloqueExplorandoGrafo` o equivalente):

```json
{
  "movimiento": "REFLEJAR",
  "motivo": "distancia alta — sin evidencia experta en ninguna dimensión pendiente",
  "objetivo": "reducir distancia",
  "nivelLenguaje": "reflejado"
}
```

- `movimiento` — determinístico, calculado por este motor, ya no un campo libre del contrato del LLM. Vale solo para ESTE turno (§2) — nunca se reutiliza en el turno siguiente sin recalcularse.
- `nivelLenguaje` — reutiliza tal cual `calcularNivelLenguaje` (reflejado/propuesta/reconocida); no se inventa un cuarto valor.
- `motivo` — texto interno de auditoría (mismo espíritu que `razones` en `avanzaReal`), nunca se le muestra al experto.
- `objetivo` — el "propósito" de la ficha correspondiente en el Behavioral Spec, pasado como contexto a Capa 1 para que redacte CON ese propósito, sin tener que inferirlo ni improvisar uno propio.

El contrato de EXPLORANDO deja de pedir `"movimiento"` como elección — lo recibe como un hecho del sistema (mismo patrón textual que ya usa "PROTOCOLO DE ESTE TURNO — hecho del sistema, el estado no lo decides tú"). Capa 1 conserva la libertad de redactar bien dentro de ese movimiento — nunca la libertad de elegir cuál, y nunca la de decidir cuánto redactar: eso lo gobierna Economía Conversacional (Behavioral Spec), no este ADR.

---

## 7. Relación con lo ya construido — nunca duplicar

- **Elegibilidad, autoridad, memoria negativa, síntesis interpretativa (Etapa 3):** sin cambios. Este motor LEE sus resultados, nunca los recalcula ni los reemplaza.
- **`calcularNivelLenguaje`:** se reutiliza exactamente, no se bifurca. Este ADR lo consume como una de las dos entradas de la señal de §5, nunca lo redefine.
- **Realizador Conversacional (D-036/037):** sin cambios de alcance (EXPLORANDO + grafo, ya restaurado). Sigue recibiendo `observacion` + `nivel` — este ADR solo cambia CÓMO se calcula `nivel` antes de esa llamada (ahora se deriva de `movimiento`/§5 en vez de calcularse por separado), no agrega una tercera llamada.
- **Riesgo abierto identificado en §4:** hoy no existe una forma de distinguir, dentro de `autoridad:'experto'`, un concepto que llegó ahí por afirmación directa del experto de uno que llegó por `inferenciasConfirmadas` (reconocimiento). Para que la fila MÍNIMA de la tabla de §5 sea calculable con precisión, puede hacer falta una marca de auditoría adicional (mismo espíritu que `autoridadDegradada`/`origenAbstraccion`, ya existentes) — o puede alcanzar con lo que ya hay. Se deja como la primera pregunta de implementación, no se asume la respuesta aquí.

---

## 8. Explícitamente fuera de alcance de este ADR

- **ADR 2 — Observación:** cómo sabe el motor si el movimiento logró su propósito (las señales ya definidas por movimiento en el Behavioral Spec, más la pregunta abierta de una quinta forma de reconocimiento para "el movimiento no aterrizó" — silencio, cambio de tema).
- **ADR 3 — Adaptación:** cómo cambia la decisión del turno siguiente en función de esa observación.
- La ficha de POTENCIAR y EXPLORAR como movimientos formalmente distintos vs. variantes de HIPÓTESIS/REFLEJAR — sigue abierto, ahora como pregunta de implementación (¿el contrato necesita 8 valores de `movimiento` o 6?), no de comportamiento.

---

## Preguntas abiertas para la implementación

- ¿La tabla de §5 debería vivir en `GrafoProyeccion.js` (junto a `calcularNivelLenguaje`, del que depende) o en un módulo nuevo, p. ej. `MovimientoConversacionalPolicy.js`, análogo a `ProgresoConversacionalPolicy.js`?
- ¿DESAFIAR necesita detección de contradicción entre conceptos `experto` — y si es así, existe ya en algún lado del motor?
- ¿Hace falta distinguir experto-por-afirmación de experto-por-reconocimiento para calcular la fila MÍNIMA, o alguna proyección ya existente lo resuelve indirectamente?
- ¿EXPLORAR y POTENCIAR entran al enum `movimiento` como valores nuevos, o EXPLORAR se funde con REFLEJAR y POTENCIAR con HIPÓTESIS/PENSAR_EN_VOZ_ALTA en distancia MÍNIMA?
- ¿Cómo se valida, con evaluación conversacional real (no un caso aislado), si la tabla de 4 niveles del §5 captura bien el comportamiento deseado antes de consolidarla?

Ninguna de estas cinco se resuelve por inferencia — cada una requiere su propia autorización explícita antes de escribir código.
