# ADR — Ley de Integridad Cognitiva

**Estado:** Propuesto. Complementario a **ADR-Ley-de-Clausura-Cognitiva.md**, pero deliberadamente independiente — no es una sección de aquel documento ni una excepción suya. Nace de la misma auditoría conceptual, al intentar destruir un contraejemplo real (una corrección del experto que llega en la gramática equivocada) y descubrir que no pertenecía a la ley de clausura, sino a un invariante distinto del sistema. No define mecanismo, API ni estructura de datos.

**Contexto:** Auditando la Ley de Clausura apareció un caso que parecía romperla: si el experto dice, en DESTILAR, "lo que dije antes no estaba bien planteado" — refiriéndose a algo que DESTINO ya exportó como confirmado — esa corrección no encaja en ningún slot del contrato de DESTILAR, así que por la ley de clausura se disolvería. Pero esa información no estaba intentando *cruzar* la frontera como conocimiento nuevo — estaba cuestionando la validez de algo que ya la había cruzado hace tiempo y que seguía formando parte del estado compartido. Separar esa distinción — qué cruza (Clausura) de qué le pasa a lo que ya cruzó (esta ley) — se probó formalmente mediante dos contramodelos: un sistema que cumple Clausura y congela todo lo exportado para siempre (viola esta ley sin violar aquella), y un sistema que nunca filtra nada al cerrar pero mantiene todo corregible indefinidamente (viola Clausura sin violar esta ley). Ninguna de las dos leyes se deriva de la otra.

---

## 1. El problema que resuelve

Una vez que un valor de conocimiento cruzó la frontera de una gramática y pasó a formar parte del estado que las gramáticas siguientes ya reciben legítimamente (ver Clausura, Sección 2), ¿qué estatus tiene ese valor de ahí en adelante? Si se tratara como un hecho cerrado e inmutable, el sistema perdería la capacidad de corregirse a sí mismo cada vez que el experto — más adelante, en cualquier punto del arco — revela que algo confirmado antes no era exacto. Y si esa corrección solo se aceptara cuando ocurre dentro de la misma gramática que produjo el valor original, cualquier corrección tardía (la más común: el experto rara vez repara en un matiz equivocado en el mismo instante en que lo dice) quedaría, en la práctica, sin ningún mecanismo que la escuche.

## 2. El principio

**Todo conocimiento exportado permanece provisionalmente vigente — nunca definitivamente cerrado — mientras siga formando parte del estado cognitivo compartido. Solo el propio experto puede confirmarlo con más fuerza, refinarlo o contradecirlo explícitamente — nunca una nueva inferencia de Círculo — y puede hacerlo desde cualquier gramática posterior, no exclusivamente desde aquella que lo produjo.**

La razón por la que esto no rompe la frontera de Clausura: la contradicción no llega mirando hacia atrás, hacia el razonamiento descartado de una gramática ya cerrada. Llega mirando el presente — el valor exportado nunca dejó de estar ahí, visible, porque exportarlo (Clausura) fue precisamente lo que lo puso al alcance de todas las gramáticas siguientes. Esta ley no reabre nada retirado; solo reconoce que lo que sí sigue activo puede, legítimamente, dejar de sostenerse.

## 3. Consecuencias arquitectónicas

- La palabra "confirmado," en cualquier parte del sistema, no significa "verdadero para siempre" — significa "verdadero hasta que el propio experto diga lo contrario, en cualquier punto futuro de la conversación, sin importar cuántas gramáticas hayan pasado."
- El mecanismo que hoy pregunta "¿algo que ya creíamos quedó confirmado, resuelto o descartado por este mensaje?" no debería estar limitado, por defecto de implementación, a la gramática activa. Su propio propósito ya lo justifica para cualquier valor visible en el estado compartido, sea cual sea la gramática que lo produjo.
- Nunca es una nueva inferencia de Círculo la que invalida algo ya confirmado por el experto — esta ley no toca ni relaja la jerarquía de autoridad ya existente (experto por encima de inferido); la extiende en el tiempo, no la contradice.
- Corregir un valor exportado no reabre la gramática que lo produjo, ni viola la Ley de Clausura — la corrección se registra como un evento nuevo, en el presente, de la misma forma en que ya se versiona cualquier otra revisión reconocida; simplemente puede dispararse desde una gramática distinta de la original.
- El peso de evidencia necesario para aceptar una contradicción probablemente no debería ser uniforme — contradecir algo fundacional para todo el arco no debería aceptarse con la misma liviandad que contradecir un detalle menor. Esto se señala como pregunta abierta (Sección 6), no se resuelve en este documento.

## 4. Reglas ya existentes que esta ley explica — no inventa

Igual que con la Ley de Clausura, esto no es un mecanismo nuevo — es la generalización, declarada, de un instinto que el sistema ya tenía, aplicado con un alcance más estrecho del que su propia justificación permite:

- El mecanismo de reconciliación ya existe, ya opera por identidad de concepto individual (nunca en bloque), y ya distingue confirmar de rechazar. Esta ley es, casi literalmente, el reconocimiento de que ese mecanismo debería alcanzar más allá del límite artificial de "solo la gramática activa" — límite que nunca fue una decisión declarada, fue un default de implementación.
- El patrón ya existente de versionar una síntesis corregida — nunca se sobreescribe en silencio, la anterior queda superada y nace una nueva versión — ya es, en miniatura, "lo confirmado puede refinarse, nunca perderse sin dejar rastro." Esta ley generaliza ese mismo patrón, hoy encerrado dentro de una sola gramática, para que pueda dispararse a través de fronteras de gramática.
- La regla de que una autoridad "experto" solo puede degradarse por evidencia real, nunca por conveniencia ni por una síntesis propia de Círculo, ya gobierna cada concepto individual del grafo. Esta ley no crea una jerarquía nueva — extiende la misma en el tiempo y a través de gramáticas.
- El instinto, ya mencionado de forma dispersa en el sistema, de que nada se borra, solo se marca y se reemplaza con trazabilidad — esta ley es la versión consciente y declarada de esa misma intuición, aplicada específicamente al ciclo de vida de lo que ya fue exportado.

## 5. Lo que esta ley deliberadamente no cubre

- **Qué decide, en primer lugar, qué información llega a estar disponible para ser corregida.** Eso es exclusivamente la Ley de Clausura Cognitiva — esta ley nunca opina sobre qué cruza, solo sobre qué le pasa a lo que ya cruzó.
- **Cualquier mecanismo concreto de detección** (heurísticas, prompts, umbrales de confianza para decidir si algo dicho realmente contradice un valor exportado). Es diseño de implementación, deliberadamente fuera de este documento.
- **El registro histórico de lo que fue retirado del circuito cognitivo por la Ley de Clausura.** Esta ley habla exclusivamente de lo que sigue activo en el estado compartido — nunca de lo ya retirado, que pertenece al otro ADR.
- **Qué ocurre si dos gramáticas distintas, en momentos distintos, intentan corregir el mismo valor de formas incompatibles entre sí.** No se exploró.

## 6. Preguntas abiertas, fuera de alcance de este documento

- ¿Debería la exigencia de evidencia para aceptar una corrección escalar según cuán fundacional es el valor que se está corrigiendo (por ejemplo, la estrella de DESTINO frente a un detalle menor de una gramática posterior)?
- ¿Qué debería ocurrir ante correcciones concurrentes o mutuamente incompatibles sobre el mismo valor, originadas en gramáticas distintas?
- ¿Existe un punto en el arco — por ejemplo, una vez que la última gramática (DAR VIDA) ya cerró — donde la vigencia provisional deja de tener sentido, porque ya no queda ningún pensamiento futuro que proteger? ¿O el conocimiento exportado debería seguir siendo corregible incluso después de que el arco completo terminó?
