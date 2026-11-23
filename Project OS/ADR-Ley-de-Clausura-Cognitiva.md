# ADR — Ley de Clausura Cognitiva

**Estado:** Propuesto. Nace de una auditoría puramente conceptual — sin cambios de código — posterior a la corrección de una carrera temporal en `evaluacionInterpretacion` (circulomejora006). No define mecanismo, API ni estructura de datos: es una ley arquitectónica que cualquier implementación futura debe respetar, nunca un plan de implementación.

**Contexto:** La auditoría que origina este documento empezó buscando dónde debía vivir una oportunidad de interpretación que se vuelve elegible justo cuando una gramática termina su cobertura. Esa pregunta llevó a otra más profunda: qué es realmente una síntesis, qué es un concepto, y finalmente, qué información necesita sobrevivir de una gramática a la siguiente para que Círculo piense como un único sistema y no como cinco módulos independientes. Rastreando el arco completo DESTINO → DESTILAR → TRADUCIR → ASCENSO → DAR VIDA contra sus propias misiones (no contra el código), apareció un patrón: cada gramática produce mucho más razonamiento del que entrega, y lo que entrega no se decide por lo que "parece importante" sino por lo que la misión de la gramática receptora ya declaró necesitar. Esa observación, generalizada, es la ley que sigue.

---

## 1. El problema que resuelve

Una gramática, mientras está en curso, necesita poder razonar con toda la riqueza que la conversación produzca: hipótesis que se prueban y se descartan, conexiones que ayudan a triangular una conclusión, incertidumbres que se abren y se cierran. Nada de eso debería estar restringido mientras la gramática sigue pensando.

El problema aparece en la frontera: si todo ese razonamiento interno se llevara, tal cual, hacia las gramáticas siguientes, dos cosas se rompen a la vez. Primero, el volumen de contexto que cada gramática nueva tiene que cargar crece sin límite con cada gramática que se cierra. Segundo — y más importante — cada gramática quedaría obligada a saber distinguir, dentro de un volumen creciente, qué parte de ese razonamiento ajeno todavía importa y cuál ya fue superada, descartada o vuelta irrelevante. Ninguna gramática debería tener que hacer arqueología sobre el proceso de otra para poder empezar a pensar.

## 2. El principio

**Una gramática puede utilizar cualquier cantidad de razonamiento interno para cumplir su misión. Al cerrarse, solo puede exportar aquello que forma parte del contrato explícito que esa misión ya declara — nunca más. Todo lo demás abandona el circuito cognitivo activo hacia las gramáticas siguientes.**

Dos precisiones que forman parte de la ley, no son notas al margen:

- **El contrato no se diseña en el momento del cierre.** Ya existe, de antemano, en la definición de la misión de la gramática — es exactamente el conjunto de cosas que esa misión dice que necesita producir. Cerrar no es negociar qué se exporta; es comprobar que el contrato ya declarado quedó satisfecho.
- **El retiro del circuito cognitivo ocurre en el instante exacto del cierre, y aplica únicamente hacia las gramáticas que vienen después.** Mientras una gramática sigue abierta, absolutamente todo lo que produjo — confirmado, rechazado, a medio resolver — sigue teniendo un rol activo en su propio razonamiento (una hipótesis rechazada, por ejemplo, sigue operando como memoria negativa dentro de esa misma gramática). El corte no es una propiedad continua del contenido; es una propiedad de un instante.

## 3. Consecuencias arquitectónicas

- El tamaño de lo que cualquier gramática necesita leer de las anteriores queda acotado por el número de elementos que su propia misión declara necesitar — nunca por la longitud de la conversación que la precedió.
- Ninguna gramática necesita conocer, ni anticipar, las necesidades de las gramáticas que vendrán después de ella. La responsabilidad de decidir qué exportar es enteramente local a la misión de quien cierra — nunca se le pide a una gramática que piense por la que sigue.
- Cerrar es, precisamente, el acto de forzar cada elemento del contrato a resolverse en un único valor — nunca se permite que algo cruce la frontera en un estado ambiguo o a medio confirmar.
- Se acepta, de forma deliberada, perder contenido cuya relevancia para una gramática futura no era anticipable en el momento del cierre. No es un defecto a corregir con un mecanismo de recuperación — es el costo explícito de que la frontera sea real. (Ver Sección 5, Pregunta Abierta 1, para el límite de esta aceptación.)
- No existe, ni debería construirse, una vía por la cual una gramática posterior consulte directamente el razonamiento interno — descartado o no — de una gramática ya cerrada, para alimentar su propio pensamiento activo. Si una gramática futura necesita algo que no fue exportado, la única vía legítima es que su propia conversación, en su propio presente y bajo su propia autoridad, se lo vuelva a pedir al experto.

## 4. Reglas ya existentes que esta ley explica — no inventa

Este principio no introduce un mecanismo nuevo. Es la generalización, declarada y consciente, de comportamientos que el sistema ya tenía dispersos:

- El contexto que una gramática recibe de las anteriores ya se limita, hoy, a lo que quedó confirmado — nunca al proceso completo que lo produjo, y ya viene particionado explícitamente de las hipótesis todavía pendientes. Eso ya es esta ley, aplicada en un solo punto del sistema sin haber sido nombrada como principio general.
- Cada misión de gramática ya define, de antemano, un conjunto fijo y nombrado de lo que espera producir. Ese conjunto ya ES el contrato — nunca hubo que inventarlo, solo reconocerlo como la frontera real.
- La memoria negativa de síntesis rechazadas de una gramática ya es, hoy, estrictamente local a esa gramática — nunca se exporta hacia otra. Es un caso particular, ya en producción, de "esto participó activamente en el razonamiento pero nunca cruza la frontera."
- La corrección de la carrera temporal en `evaluacionInterpretacion` que motivó esta auditoría es, en retrospectiva, la misma ley aplicada a una frontera más pequeña: entre un turno y el siguiente, dentro de una misma gramática, en vez de entre una gramática y la próxima. El principio ("nada cruza sin haber sido genuinamente ofrecido y resuelto bajo el contrato correspondiente") es idéntico a otra escala.

## 5. Lo que esta ley deliberadamente no cubre

- **Qué le pasa a un valor ya exportado, con el tiempo.** Si ese valor puede confirmarse con más fuerza, refinarse o ser contradicho por el experto — y quién tiene autoridad para eso — es el dominio exclusivo de la Ley de Integridad Cognitiva (ADR separado). Se demostró, mediante contramodelos, que ninguna de las dos leyes se deriva de la otra: rigen ejes distintos (un instante vs. una duración).
- **El mecanismo concreto por el cual una gramática detecta que está lista para cerrar.** Eso ya lo gobierna el protocolo de cierre existente; esta ley no lo redefine — solo restringe qué cruza en el momento en que ese mecanismo, sea cual sea, decide cerrar.
- **El diseño de cualquier registro histórico o de auditoría** sobre lo que queda retirado del circuito cognitivo. Que algo se retire de la cognición activa no implica que deba destruirse — pero la forma concreta de esa retención (qué se indexa, cómo se consulta, quién puede leerlo) es una decisión de producto posterior, fuera del alcance de esta ley.
- **Cualquier mecanismo de mitigación para la pérdida de contenido con relevancia emergente.** Se consideró explícitamente (un "recordatorio" no epistémico que empuje a una gramática futura a volver a preguntar) y se descartó, por ahora, por falta de evidencia real de que la pérdida ocurra con frecuencia o gravedad suficiente para justificarlo.

## 6. Preguntas abiertas, fuera de alcance de este documento

- ¿Existe algún tipo de contenido cuya pérdida por relevancia emergente sea, en la práctica, inaceptable con la frecuencia suficiente como para justificar algún tipo de mitigación? Se decidió esperar evidencia real de uso antes de diseñar nada.
- El contrato de una gramática hoy se expresa como una lista fija de slots de texto libre. ¿Debería, en algún momento, poder declarar tipos más ricos de contenido (por ejemplo, conexiones tipadas entre elementos, no solo texto)? No se exploró — pertenece al modelo del concepto y su composición, no a la frontera de cierre en sí misma.
- ¿Puede una gramática declarar un contrato condicional (exportar un elemento solo si cierto criterio interno se cumplió, en vez de un conjunto fijo de slots) sin romper la garantía de que el contrato "ya existe en la misión, nunca se diseña al cerrar"? No se exploró.
