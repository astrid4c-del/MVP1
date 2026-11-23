# Contrato Arquitectónico — Gobernanza de Materialización Conversacional

**Estado:** Congelado. Cumple el criterio que se buscaba — deja de descubrir arquitectura y pasa a definir un contrato. No describe la implementación actual de Círculo: describe una propiedad que cualquier implementación futura (otras gramáticas, otro proveedor de LLM, otro pipeline) debería seguir respetando.

**Naturaleza de este documento:** no es un ADR (no narra un descubrimiento) ni el Behavioral Spec (no describe efecto humano por movimiento). Es el mecanismo que ambos presuponen. Cierra la fase de discusión abierta por el vertical slice del Motor de Movimientos Conversacionales — a partir de aquí, cualquier cambio relacionado es implementación dentro de este marco, nunca descubrimiento de un marco nuevo.

**Alcance:** aplica únicamente dentro del perímetro `protocolV2Enabled && knowledgeGraphEnabled`. El modo legacy y V2-sin-grafo quedan explícitamente fuera — no porque no lo necesiten en algún momento, sino porque hoy no forman parte de esta evolución.

**Errata (post-5616ae5, auditoría de cobertura de solo lectura sobre el resto del perímetro):** el §8 original afirmaba que "la edición dirigida de síntesis pasa a ser el materializador especializado que activa Delegar". Es incorrecto y se corrige ahí mismo, con esta nota, sin reabrir el resto del documento. La edición dirigida (`AgoraPrompts.buildProtocoloBloqueSintesisGrafo`) es una instrucción dentro de la MISMA llamada que produce `mensaje` en `LISTO_PARA_SINTESIS` — no un mecanismo separado que ya haya construido el texto bajo su propia autoridad antes de llegar a la Gobernanza. `LISTO_PARA_SINTESIS` corresponde a **Preservar**, no a Delegar. Esto no diluye la definición de Delegar (Contrato §6): Delegar sigue exigiendo que otro mecanismo ya haya materializado la respuesta y sea la autoridad sobre su forma final. Dentro del perímetro auditado hasta ahora, ningún camino real activa esa Garantía (`materializadorEspecializadoActivo`) — el catálogo contempla una capacidad todavía sin activador confirmado, no una capacidad incorrecta.

---

## 1. El mecanismo

```
Pipeline
   │  produce
   ▼
Garantías ────────────┐
                       ▼
                Gobernanza de Materialización
                (Garantías + Políticas)
                       │
                       ▼
          Estrategias admisibles (conjunto)
                       │
                       ▼
              Selección de una estrategia
                       │
                       ▼
                  Ejecución
                       │
                       ▼
                Respuesta final
```

Tres responsabilidades, cada una con un único dueño. Ninguna capa hace el trabajo de otra.

---

## 2. Responsabilidad del Pipeline

El pipeline (llamada al LLM, validación de contrato, reconciliación, construcción del grafo) hace exactamente lo que hace hoy — **y nada más**: produce **Garantías**, hechos descubiertos sobre este turno específico. Nunca decide cómo hablarle al usuario. Nunca conoce políticas. Nunca elige una estrategia. Si el pipeline determina que el turno no puede continuar en absoluto (`LLM_UNAVAILABLE`, `SINTESIS_INVALIDA`), eso ocurre **antes** de llegar a la Gobernanza — es una imposibilidad operacional, no una decisión conversacional, y queda fuera de este contrato.

Cuando el pipeline sí produce un turno viable, entrega sus Garantías a la Gobernanza. No le importa qué se haga con ellas.

---

## 3. Responsabilidad de la Gobernanza de Materialización

Recibe únicamente Garantías — nunca `protocoloEstado`, nunca la gramática activa, nunca el contenido crudo del LLM para inspeccionarlo ella misma. Su trabajo, en dos pasos separados y nunca fusionados:

1. **Determinar el conjunto de estrategias admisibles**, combinando las Garantías de este turno con las Políticas vigentes.
2. **Seleccionar una** estrategia de ese conjunto (puede haber más de una admisible; la selección entre ellas es una decisión de producto, no de seguridad).

Nunca valida contratos, nunca llama al LLM, nunca conoce el vocabulario de las 5 gramáticas. Solo combina Garantías con Políticas.

---

## 4. Qué es una Garantía

Un hecho que el pipeline descubrió sobre ESTE turno — nunca una decisión, nunca algo que alguien elige. La Gobernanza las recibe como realidad, no las discute ni las cuestiona.

Ejemplos ya identificados:
- `prosaValidada` — el contrato de este turno validó sin errores.
- `materializadorEspecializadoActivo` — existe, para este turno, un mecanismo que ya construyó el texto bajo sus propias reglas (p. ej. edición dirigida de síntesis).
- `debeSuprimirse` — este turno es redundante con lo que el sistema va a mostrar de inmediato después.

Una Garantía nueva se agrega cuando el pipeline aprende a detectar un hecho que antes no sabía detectar. Eso nunca cambia el mecanismo — solo enriquece lo que la Gobernanza tiene disponible para decidir.

---

## 5. Qué es una Política

Una decisión de producto, declarada de antemano — nunca deducible del turno. Describe qué está dispuesto a aceptar el producto, no qué pasó en este turno específico.

Dos categorías, y toda Política declarada debe indicar cuál es:

- **Global** — aplica a cualquier contexto, sin excepción (p. ej.: *nunca se confía en prosa que no pasó la validación de contrato*).
- **Contextual** — aplica solo a un tipo de turno específico, y coexiste con otras políticas contextuales sin competir entre sí (p. ej.: *nunca se confía en prosa libre para una reacción de rechazo, incluso si el contrato validó*).

Las Políticas se declaran en un solo lugar, legible, nunca repartidas implícitamente en condicionales sueltos del pipeline. Una Política nueva — o el cambio de una existente — es una conversación de producto, nunca una razón para tocar el mecanismo de los §1-§3.

---

## 6. Qué es una Estrategia

La forma concreta en que se materializa la respuesta, una vez decidida. El catálogo actual:

| Estrategia | Qué hace |
|---|---|
| **Transformar** | Reescribe respetando la intención (hoy: el Realizador Conversacional, parametrizado por movimiento/nivel). |
| **Preservar** | Muestra el texto del generador tal cual — la Gobernanza lo evaluó y lo vouchea, sin reescribirlo. |
| **Delegar** | Se aparta porque un materializador especializado ya construyó el texto — nunca lo evalúa como prosa libre. |
| **Determinista** | Construye desde señales estructuradas, nunca desde prosa libre no confiable. |
| **Suprimir** | No emite respuesta este turno. |

El catálogo crece cuando aparece una forma genuinamente nueva de materializar (compresión, streaming, respuesta multimodal) — nunca cuando aparece un estado o una gramática nueva. Un estado nuevo nunca es motivo, por sí solo, para agregar una estrategia.

**Regla central, no negociable:**

> Ninguna estrategia puede decidir su propia admisibilidad. La admisibilidad siempre es responsabilidad de la Gobernanza de Materialización.

Una estrategia nunca se ejecuta porque "se encontró ahí" en el código — se ejecuta porque la Gobernanza, combinando Garantías con Políticas, ya determinó que era admisible.

---

## 7. Invariantes del sistema

1. Dentro del perímetro (§Alcance), **toda** respuesta pasa por la Gobernanza de Materialización — no existe un camino de código que la salte. Si un turno no debe transformarse ni preservarse, la Gobernanza igual lo decide explícitamente (Delegar, Determinista o Suprimir) — nunca es una omisión.
2. La admisibilidad de una estrategia depende únicamente de Garantías + Políticas — nunca de qué protocoloEstado o gramática esté activa, consultados directamente.
3. Una nueva Garantía, una nueva Política o una nueva Estrategia nunca obligan a redibujar el diagrama de §1 — solo extienden alguno de los tres catálogos.
4. Selección entre estrategias admisibles es una decisión de producto; determinar CUÁLES son admisibles es una decisión de seguridad/garantías. Nunca se resuelven en el mismo paso.
5. El pipeline nunca conoce políticas. La Gobernanza nunca valida contratos ni llama al LLM. Cada capa tiene una sola responsabilidad — nunca dos.
6. **Las Garantías describen hechos. Las Políticas describen decisiones. Ninguna Política puede modificar una Garantía, y ninguna Garantía puede reemplazar una Política.** Esta frontera protege contra dos formas concretas de mezcla, ambas prohibidas:
   - Falsificar una Garantía para forzar un resultado — p. ej. `if (!prosaValidada) prosaValidada = true;`. Una Garantía nunca se ajusta para que convenga; si es falsa, la Gobernanza debe actuar en consecuencia, nunca cambiar el hecho.
   - Usar una Política para simular una Garantía — p. ej. `if (rechaza) prosaValidada = false;`. Una Política puede hacer que una estrategia deje de ser admisible (a través de `prosaLibreAceptadaPorPolitica` u otra Política declarada), pero nunca puede reescribir lo que el pipeline efectivamente descubrió.

---

## 8. Frontera con lo ya construido

Este contrato no reemplaza nada de Etapa 3 (grafo, autoridad, elegibilidad, memoria negativa) ni el ADR del Motor de Movimientos Conversacionales — los envuelve. El Realizador Conversacional pasa a ser, exactamente, la implementación de la estrategia **Transformar**; `reaccionRechazoControlada` pasa a ser la implementación de **Determinista** para el contexto `rechaza`; ~~la edición dirigida de síntesis pasa a ser el materializador especializado que activa **Delegar**~~ **corregido (ver Errata):** `LISTO_PARA_SINTESIS` (con o sin edición dirigida) corresponde a **Preservar** — su `mensaje` sigue siendo prosa validada de una única llamada, nunca el producto de un materializador separado. Ninguno de los tres cambia de comportamiento por este contrato — cambia únicamente el lugar del que dependen para saber que les corresponde ejecutarse.

---

Cuando aparezca una discusión nueva (por ejemplo, `ESPERANDO_CONFIRMACION/confirma`), la pregunta correcta ya no es de arquitectura. Es: *¿qué Política declaramos para este contexto?* La respuesta determina, por este mecanismo, qué estrategias quedan admisibles — sin tocar nada de lo que este documento define.
