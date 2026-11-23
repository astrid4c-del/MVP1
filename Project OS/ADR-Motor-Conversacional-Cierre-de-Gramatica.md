# ADR — Motor Conversacional de Círculo: Cierre de Gramática

**Estado:** Aceptado (nivel conceptual). Pendiente de validación empírica.

**Contexto:** Investigación iniciada tras la primera validación manual post-Etapa 1.

---

## Alcance de este ADR

Este documento registra el mejor modelo conceptual disponible hoy, construido enteramente a partir de razonamiento sobre un único incidente real y la auditoría del prompt existente. No es una verdad definitiva sobre cómo debe funcionar el motor conversacional de Círculo — es el punto de partida para la implementación. Si la evidencia obtenida al implementar, instrumentar y observar conversaciones reales revela una explicación más simple, o contradice alguna de las decisiones aceptadas en la sección 3, esa evidencia tiene prioridad sobre este documento. Este ADR se revisa, no se defiende.

---

## 1. Problema original

**Comportamiento observado:** Durante la primera validación manual con Gemini (`gemini-3.1-flash-lite`), DESTINO completó visualmente sus 4 campos (Estrella, Antes, Después, Evidencia), pero la conversación continuó durante decenas de turnos sin transicionar a DESTILAR. El estado visual permaneció fijo en "Estado 1 · DESTINO".

**Evidencia real:** Se consultó directamente la base de datos SQLite de esa sesión real (no una reconstrucción). Resultado: 1 sesión, 33 turnos, 33/33 `gate.rejected`, 0 `gate.approved`.

- Turnos 1–3: rechazados por `Gramática destino incompleta` (slots todavía faltantes) — comportamiento esperado.
- Turnos 4–33 (30 turnos consecutivos): rechazados exclusivamente por `Gramática destino con evidencia completa, pendiente de confirmación del experto` — los 4 slots ya estaban completos; la única condición sin cumplir era que `destino_completo` nunca llegó en `true` en el JSON del LLM.

Auditoría posterior de `AgoraPrompts.js` confirmó la causa: no existe en el prompt ninguna definición de cierre basada en el contenido de la conversación — solo un presupuesto de turnos suave ("~6-7 intercambios"), y ese único freno está activamente contradicho por instrucciones adyacentes ("nunca sientas presión de tiempo", "nunca cortes a alguien pensando en voz alta", "cada respuesta devuelve más claridad").

Como acción de instrumentación (no de corrección), se agregó a `GatePolicy.js` el registro del valor crudo de `proponiendo_cierre` y `{gramatica}_completo` en cada rechazo, para dar visibilidad completa a la próxima corrida real.

---

## 2. Descubrimientos descartados

| Concepto | Por qué se descartó o absorbió |
|---|---|
| **Estabilidad de slots** | Propuesto como proxy de saturación. Descartado como concepto de producto: `SlotSynthesisPolicy` reemplaza un slot con cualquier aporte no vacío ("último gana"), por lo que puede registrar "cambio" ante una simple repetición con otras palabras, y puede registrar "estabilidad" mientras el descubrimiento real sigue en curso si el modelo no reescribe el slot. Sobrevive únicamente como posible mecanismo de medición de implementación, no como concepto arquitectónico. |
| **Catastro vs. estrella** | Vocabulario propio de DESTINO (material bruto vs. resultado distilado), ya presente en el prompt original. Válido a nivel de diseño interno de DESTINO, pero derivable de transformación + saturación a nivel del modelo general — excluido del modelo mínimo por no aportar poder explicativo adicional a ese nivel. |
| **Verificación (como fase separada)** | Propuesta como paso de fidelidad entre "descubrimiento suficiente" y "pedir confirmación". Absorbida por reconocimiento: no se puede reconocer algo incorrecto — todo lo que verificación exigía ya está contenido, con un estándar más alto, en la definición de reconocimiento. |
| **Reconocimiento como estado del sistema** | Versión inicial: una Policy debía detectar si el reconocimiento ocurrió. Generó una contradicción real con "el modelo describe, el sistema decide" — evaluar reconocimiento es un juicio semántico sobre lenguaje natural, y una Policy (función determinista sobre estado estructurado) no puede hacerlo. Resuelto reasignando reconocimiento exclusivamente al experto: el sistema nunca lo evalúa; solo lee la respuesta del experto a una propuesta de síntesis específica. |
| **Modo como estado persistente** | Arquitectura propuesta: un campo de modo en `CognitiveState`, decidido por una Policy nueva, con su propio evento de transición. Descartada al aplicar la hipótesis de "decisiones, no estados": `IDENTITY` ya contiene un mecanismo de elección de acción por turno (los seis MOVIMIENTOS). "Modo" no necesita existir como entidad separada — se disuelve en un sesgo, informado por trayectoria, sobre una elección que el sistema ya hace en cada turno. |
| **Saturación como evento discreto** | Downgradeado de "umbral que dispara una transición de modo, evaluado por una Policy dedicada" a "una señal continua más, entre las que informan la elección de la mejor acción siguiente en cada turno". El concepto sobrevive; su estatus arquitectónico como evento con maquinaria propia, no. |

---

## 3. Decisiones arquitectónicas aceptadas

**D-1. Transformación es el principio raíz, sin modificación.** Heredado del documento original de Astrid. Explica por qué existe DESTINO y por qué existe Círculo. No fue cuestionado en ningún punto de la investigación — todo lo demás se evaluó en función de si lo servía o no.

**D-2. Dentro de la capa conversacional (turno a turno, dentro de una gramática), el motor se modela como una secuencia de decisiones de acción, no como un conjunto de estados cognitivos nombrados y persistidos.** Esto aplica exclusivamente a esa capa. La capa estructural — progresión entre gramáticas, cierre, disparo de downstream — sigue siendo, correctamente, una máquina de estados (ver D-4). Decisiones y estados no compiten por todo Círculo; cada uno gobierna una capa distinta. D-2 sobrevive porque una sola pregunta bien informada ("cuál es la mejor acción siguiente, dada la trayectoria") explica, dentro de la capa conversacional, el mismo comportamiento que antes requería cuatro conceptos con maquinaria propia (saturación-evento, modo-estado, verificación, reconocimiento-a-detectar). Evidencia: el propio prompt ya contiene el mecanismo de elección (los MOVIMIENTOS) sin que nosotros lo hayamos inventado — la corrección consiste en informarlo mejor, no en construir uno nuevo.

**D-3. Reconocimiento pertenece exclusivamente al experto; el sistema nunca lo evalúa.** Sobrevive a la falsación explícita del turno anterior a esta redistribución. Evidencia: elimina la única contradicción estructural encontrada entre "el sistema decide" y la naturaleza semántica del reconocimiento, sin requerir ningún mecanismo nuevo — el sistema solo necesita leer la respuesta del experto a una propuesta acotada, tarea que ya es descripción, no decisión.

**D-4. El cierre de una gramática debe seguir siendo un evento discreto, binario y auditable — no una deriva continua de buenas decisiones.** Sobrevive porque el resto de la arquitectura de Círculo, ya construida durante Etapa 1, lo exige estructuralmente: `GatePolicy`, la persistencia del Turno, y el disparo del downstream exactamente una vez dependen de que exista un momento preciso de "cerrado / no cerrado". Este es el único punto donde "estado" sigue siendo la abstracción correcta, y no por preferencia nuestra, sino porque ya está en producción y otros componentes dependen de él.

**D-5. El patrón (necesidad de un sesgo hacia el cierre informado por trayectoria) es general a las cinco gramáticas, no específico de DESTINO.** Evidencia doble: (a) el mecanismo hoy defectuoso —presupuesto de turnos socavado, protocolo de cierre en dos pasos— vive en código compartido (`IDENTITY`, la construcción genérica del JSON de cierre en `buildGramaticaPrompt`), idéntico para las cinco; (b) las cinco misiones, en su propio texto, exhiben la misma forma de material bruto → resultado singular, y tres de las cinco nombran explícitamente un anti-patrón para el fallo de no converger.

**D-6. "El modelo describe, el sistema decide" se mantiene como principio rector, con su alcance ahora precisado.** El sistema decide únicamente: (a) qué sesgo aplicar a la elección de acción del turno, a partir de señales observables de trayectoria; (b) el cierre mecánico de la gramática, combinando slots completos y el flag ya reportado — exactamente lo que `GatePolicy` ya hace hoy. El sistema nunca interpreta significado.

---

## 4. Responsabilidades

| Actor | Responsabilidad |
|---|---|
| **El sistema (Policy/mecanismo de decisión)** | Sesgar la elección de la próxima acción conversacional según señales observables de trayectoria. Ejecutar el cierre mecánico de la gramática combinando slots completos + flag confirmado. Nunca interpreta lenguaje natural. |
| **El LLM** | Genera el contenido de cada turno, incluida la síntesis propuesta cuando corresponda. Reporta, como parte de su rol descriptivo, si la respuesta del experto a una propuesta específica constituye confirmación — nunca autoevalúa si su propia comprensión general es suficiente. |
| **El experto** | Es el único que reconoce (o no) una síntesis propuesta como verdadera. Su respuesta, en sus propias palabras, es la única fuente legítima de esa información — nadie más puede sustituirla. |
| **Arquitectura ya existente, sin cambios, reconfirmada** | `GatePolicy` (cierre de gramática — ya combina slots-completos y flag confirmado, patrón que se mantiene intacto). `SlotSynthesisPolicy` (síntesis de valores de slot). `InteraccionCognitivaWriter` (única autoridad de escritura de un turno — cualquier mecanismo nuevo de decisión de acción pasa por acá, no crea una segunda autoridad). Turno / Event Log (auditoría). Los MOVIMIENTOS de `IDENTITY` (mecanismo de elección de acción por turno, candidato ya existente para recibir el sesgo de trayectoria). |

---

## 5. Preguntas abiertas

- No existe hoy una señal computable y confiable de "trayectoria estancada". La más obvia (igualdad de valores de slots) está probadamente rota.
- Nunca se verificó, contra una corrida real, que sesgar la elección de acción hacia el cierre efectivamente produzca reconocimiento en el experto, con ningún modelo. Todo el razonamiento se hizo sobre el prompt, no sobre comportamiento observado bajo la corrección propuesta.
- No está resuelto si el patrón (necesidad de converger tras explorar) es una propiedad necesaria del producto o una consecuencia del método conversacional actual (exploración abierta seguida de compresión) — un método de elicitación distinto podría no necesitarlo.
- No está definido qué distingue, cuando el experto no confirma una síntesis propuesta, si corresponde revisar la síntesis o volver a explorar — ambos casos requieren un juicio que no quedó especificado.
- TRADUCIR puede necesitar más de un ciclo de convergencia dentro de la misma gramática (definir al alumno, luego calibrar) — no se resolvió si la unidad correcta de análisis es "una gramática completa" o algo más granular.
- Acotar la pregunta que el modelo responde (de "¿estoy listo?" a "¿el experto confirmó esta propuesta específica?") reduce, pero no prueba eliminado, el sesgo hacia seguir explorando indefinidamente.
- Toda la teoría descansa en un único incidente real: una sesión, un modelo (Gemini), una gramática (DESTINO). No hay una segunda corrida que la confirme.

---

## 6. Criterio para salir de la etapa conceptual

El único incidente real disponible ya fue explotado por completo: se extrajo su traza completa de la base de datos, se auditó el prompt línea por línea contra esa traza, se sometió la teoría resultante a un intento propio de falsificación, y esa falsificación encontró exactamente una contradicción estructural — que quedó resuelta reasignando reconocimiento al experto. No quedan preguntas que el razonamiento, por sí solo, pueda seguir resolviendo: las siete preguntas abiertas de la sección anterior no son ambigüedades conceptuales — son preguntas empíricas que ninguna auditoría adicional del mismo prompt, sobre el mismo trace, puede contestar. Seguir razonando desde acá sin datos nuevos es exactamente el riesgo de sobrearquitectura que la propia falsificación ya señaló. La siguiente fuente legítima de conocimiento es correr el sistema corregido contra conversaciones reales y observar qué pasa — no otra ronda de teoría.
