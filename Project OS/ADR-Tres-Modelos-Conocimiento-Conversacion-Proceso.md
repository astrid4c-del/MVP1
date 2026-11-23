# ADR — Círculo: Conocimiento, Conversación y Proceso como los tres modelos que sostienen la Política Conversacional

**Estado:** Aceptado como patrón arquitectónico, provisional. No implementado. Bloquea el próximo rediseño, no el Alpha (ver D-040 en DECISIONS.md — el Alpha se resolvió con dos invariantes mínimos, deliberadamente sin adoptar este ADR).

**Contexto:** Investigación iniciada tras un hallazgo en vivo, verificado contra el backend público del Alpha: un turno de DESTINO en `EXPLORANDO` con el grafo ya sin dimensiones pendientes (resueltas por reconciliación) recibió un contrato que le pedía elegir una pregunta de una lista vacía — estructuralmente irrespondible. La corrección puntual (D-040) resolvió el síntoma. Esta investigación preguntó por la causa raíz: por qué `protocoloEstado`, un solo campo, pudo llegar a representar una contradicción así.

---

## Alcance de este ADR

Este documento registra el modelo conceptual construido enteramente por razonamiento sobre el código real de Círculo — sin escribir una línea nueva — sometido a un intento explícito de refutación antes de aceptarlo. No es la arquitectura definitiva: es la base sobre la que se diseñará el próximo rediseño, una vez autorizado. Si la implementación revela que algún supuesto de acá no sobrevive contacto con datos reales, esa evidencia tiene prioridad sobre este documento.

---

## 1. Problema original

`protocoloEstado` (`EXPLORANDO` / `LISTO_PARA_SINTESIS` / `ESPERANDO_CONFIRMACION`) es un único campo persistido que gobierna qué contrato se le construye al generador en cada turno. La investigación partió de una pregunta concreta: ¿por qué pudo quedar desincronizado del grafo, al punto de pedir algo imposible?

Encontrado en la auditoría: la reconciliación (fase que corre antes de construcción) puede completar la cobertura de una gramática por sí sola, sin que construcción intervenga. `protocoloEstado`, sin embargo, solo se actualiza *después* de un turno completo — nunca en el momento exacto en que el grafo cambia. El campo no estaba mal diseñado por descuido: estaba haciendo dos trabajos distintos a la vez (reflejar cobertura de conocimiento, y reflejar negociación pendiente sobre una síntesis) bajo un solo nombre, y esos dos trabajos pueden desincronizarse entre sí porque responden a fuentes de verdad distintas.

---

## 2. Descubrimientos descartados

| Concepto | Por qué se descartó o se absorbió |
|---|---|
| **Mover la transición de estado a antes del turno, sin tocar `protocoloEstado` como campo persistido** | Resolvía el síntoma puntual, pero mantenía dos autoridades separadas capaces de decidir la misma cosa (`decidirProtocolo` post-turno, y un chequeo defensivo pre-turno) — el mismo patrón de autoridad duplicada que este proyecto ya eliminó una vez (Incremento 4, single authority selection point). Descartado como solución arquitectónica final; sobrevive como la corrección puntual de D-040, explícitamente marcada como parche de Alpha, no como rediseño. |
| **"Ritmo conversacional" como un cuarto dominio propio** | Propuesto al notar que el presupuesto de turnos ("[Turno N]") no es Conocimiento ni Conversación. Absorbido: es un atributo del dominio Proceso ("turnos, presupuestos, reintentos, eventos, idempotencia"), no una categoría nueva — todo el resto de las señales de ritmo/reintento/idempotencia ya encontradas en el código (`intentosContrato`, reintentos de transporte de `LLMService`, `BudgetPolicy`, el outbox del pipeline downstream) caen en el mismo dominio sin forzar nada. |
| **`protocoloEstado` completamente eliminado, sin ningún reemplazo con nombre** | Propuesta más radical: "Grafo → Política → Contrato, sin estados en absoluto". Refutada parcialmente: es correcta para el eje EXPLORANDO/LISTO_PARA_SINTESIS (pura proyección del grafo), pero `ESPERANDO_CONFIRMACION` codifica información que el grafo no puede contener por diseño — el texto exacto ya propuesto, y cuántas veces la respuesta del experto fue ambigua. Eliminar el nombre sin resolver dónde vive esa información no la elimina, la esconde. |
| **La síntesis confirmada como posible segunda fuente de verdad** | Sospecha levantada al notar que el grafo y un texto de síntesis "congelado" podrían divergir con el tiempo. Descartada tras auditar el código: `protocoloSintesisVigente` se pone en `null` explícitamente en el mismo commit que registra un avance real ("ningún residuo del ciclo de cierre anterior"), y `ComprensionIntelligence` (primera etapa del pipeline downstream) lee `slots` — bajo el grafo activo, una proyección pura de este, nunca el texto de síntesis. No hay duplicación real hoy. |
| **Autoridad/procedencia por concepto como posible fuga hacia Proceso** | La marca "experto"/"inferido" en cada concepto describe *cómo se llegó* a una creencia — podría confundirse con metadata de ejecución. Se mantiene dentro de Conocimiento: describe la confiabilidad de la realidad tal como hoy se la entiende, no la mecánica del motor. Un modelo de Conocimiento que no distinguiera esto describiría mal la realidad del experto. |

---

## 3. Decisiones arquitectónicas aceptadas

**D-T1. Círculo se sostiene sobre tres dominios de información, ortogonales por diseño: Conocimiento, Conversación y Proceso.**
- **Conocimiento** describe la realidad descubierta del experto — hoy, el grafo de conceptos e incertidumbres, con autoridad y procedencia.
- **Conversación** describe el intercambio pendiente o en curso con el experto — hoy, principalmente la síntesis propuesta sin confirmar y el conteo de respuestas ambiguas sobre ella.
- **Proceso** describe el estado operativo del motor — turnos, presupuestos, reintentos de contrato, reintentos de transporte, eventos, idempotencia del pipeline downstream.

Prueba de pertenencia validada durante la auditoría, reutilizable para cualquier dato nuevo: *¿este dato existiría igual si cambiara el contenido conocido, el interlocutor humano, o el motor mismo?* Lo que sobrevive a cambiar el motor pero no al contenido es Conocimiento. Lo que sobrevive a cambiar el motor pero no al interlocutor es Conversación. Lo que sobrevive a los dos anteriores es Proceso.

**D-T2. El patrón se repite por objeto de negociación — no son tres campos únicos que cubren todo Círculo de una vez.** El pipeline downstream (auditor, opciones, arquitectura, forma, territorio, desarrollo, bonus) exhibe la misma partición aplicada a un objeto distinto: algo-ya-decidido-hasta-ahora sobre el producto, en negociación con etapas de checkpoint y reintentos propios. La partición en tres es el patrón general; el grafo de conceptos es su instancia actual para "comprensión", no su única instancia posible.

**D-T3. `protocoloEstado`, como campo único con tres valores posibles, deja de ser la abstracción correcta.** Se reemplaza por dos cosas independientes:
- El eje EXPLORANDO/LISTO_PARA_SINTESIS no se persiste — se deriva del grafo en cada turno (misma disciplina que ya rige `slots`: nunca un blanco de escritura, siempre una proyección).
- El eje de confirmación pasa a ser la presencia o ausencia de un registro de propuesta pendiente, propio del modelo de Conversación — no un valor de enum compartido con el eje anterior.

**D-T4. Ninguna regla que combine dos dominios puede vivir escondida dentro de uno de ellos, ni como instrucción implícita en el prompt — vive en la Política, explícita.** Ejemplo validado: "las correcciones no cuentan para el presupuesto de turnos" combina Proceso (conteo crudo) con Conversación (clasificación del turno). La combinación es responsabilidad de la Política; ninguno de los dos modelos por separado debe "saber" del otro.

**D-T5. Invariantes que deben cumplirse para que esto no vuelva a mezclarse:**
1. Un campo persistido nunca es la respuesta conjunta de dos modelos distintos.
2. Nada se persiste si se puede derivar de otro modelo.
3. Cada modelo se valida sin necesitar leer los otros dos.
4. Las reglas que combinan modelos viven en la Política, nunca dentro de un modelo ni del prompt.
5. Ninguna decisión determinista vive como texto libre interpretado por el LLM.
6. Todo dato nuevo se clasifica con la prueba de D-T1 antes de decidir dónde vive — nunca por conveniencia del momento.

---

## 4. Responsabilidades

| Dominio | Qué gobierna | Qué NO le pertenece |
|---|---|---|
| **Conocimiento** | Conceptos, incertidumbres, autoridad, procedencia — la realidad del experto tal como hoy se entiende. | Cuántas veces se pidió aclaración; el texto exacto de una propuesta en negociación; turnos, reintentos, presupuestos. |
| **Conversación** | La síntesis propuesta sin confirmar; el conteo de respuestas ambiguas sobre ella; la corrección pendiente. | Cualquier hecho sobre el dominio del experto (eso ya lo sostiene el grafo); reintentos de transporte o de contrato. |
| **Proceso** | Turnos, presupuestos, reintentos (contrato y transporte), eventos, idempotencia del pipeline downstream, versionado optimista del estado. | Cualquier cosa que dependa de qué dijo el experto o de qué se le propuso — eso pertenece a los otros dos. |
| **Política Conversacional** | Combinar los tres dominios para decidir qué contrato construir. Nunca es, ella misma, uno de los tres modelos. | Generar contenido, elegir palabras, elegir MOVIMIENTO — eso sigue siendo juicio delegado a la Capa Cognitiva y al Realizador, fuera del alcance de este ADR. |

---

## 5. Preguntas abiertas

- No se diseñó todavía la forma concreta del "registro de propuesta pendiente" que reemplazaría a `ESPERANDO_CONFIRMACION` — solo se estableció que debe existir y qué información debe cargar.
- No se verificó si el patrón de D-T2 (Conocimiento/Conversación/Proceso aplicado también al pipeline downstream) aporta valor real si se implementa, o si es una observación válida pero sin consecuencia práctica inmediata.
- No se determinó si una sexta gramática con una forma de conocimiento estructuralmente distinta (múltiples expertos, datos numéricos) exigiría solo que el modelo de Conocimiento crezca, o si además tensiona la partición en tres — la hipótesis actual es que no, pero no está probada contra un caso real.
- Todo este ADR descansa en la auditoría del código actual y en un único incidente real (el turno de DESTINO en el Alpha). No hay todavía una segunda corrida, con el rediseño implementado, que lo confirme.

---

## 6. Criterio para salir de la etapa conceptual

El razonamiento disponible ya se agotó: se auditó el código real (no se infirió el diseño), se sometió la hipótesis a un intento propio de refutación por dominio y por pregunta, y esa refutación encontró y resolvió los puntos de tensión reales (ritmo, síntesis confirmada, autoridad/procedencia) sin necesitar un cuarto dominio. Las preguntas que quedan abiertas son empíricas — dependen de implementar el rediseño y observarlo, no de seguir razonando sobre el mismo código. La siguiente fuente legítima de conocimiento es la implementación misma, autorizada aparte de este documento.
