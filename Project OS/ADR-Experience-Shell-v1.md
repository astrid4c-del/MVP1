# ADR — Experience Shell v1: una capa de presentación que proyecta el Círculo existente, no lo reemplaza

**Estado:** Aceptado. Implementación autorizada, en curso sobre la rama `experience-shell-v1`.

**Contexto:** El Alpha, validado en producción tras D-041 (tag `alpha-2026-07-20-d041`), presenta a Círculo como un chat de una sola pantalla: conversación, panel de comprensión y — al completar el pipeline — el producto final, todo mezclado en un mismo flujo. Motivado por una conversación de diseño externa (filosofía de producto "Memoria Evolutiva" / "Canvas Vivo"), se decidió que la primera prioridad no es rediseñar el motor ni construir el sistema multi-proyecto, sino darle al Círculo que ya existe una forma de producto legible: cuatro áreas (Inicio, Conversación, Construcción, Producto) sobre un único proyecto.

---

## Decisiones

**D-ES1. El Experience Shell proyecta el Círculo existente; no lo reemplaza.** No es una reconstrucción del frontend ni un nuevo producto — es una capa de presentación sobre el mismo Alpha ya validado. Todo lo que el usuario podía hacer antes, lo sigue pudiendo hacer exactamente igual; el shell solo cambia cómo se organiza visualmente lo que ya ocurre.

**D-ES2. `circulo_v0.html`, el motor cognitivo, el pipeline downstream y las 5 gramáticas permanecen intactos.** Ninguna corrección de D-041 ni ningún invariante anterior (D-033, D-040) se toca. `circulo_v0.html` sigue siendo el baseline congelado, verificado por MD5 en cada build, exactamente como antes de este ADR.

**D-ES3. No se duplica estado.** El shell no mantiene su propia copia de sesión, gramática activa, slots ni progreso. Toda la información que muestra proviene de leer lo que el baseline y el bridge ya calculan (`currentStateIdx`, `understood`, los eventos de render) — nunca de un segundo cálculo paralelo. Si el shell necesitara un dato que hoy no existe en ningún lado, eso es una señal para pedir autorización explícita antes de inventar una fuente nueva, no para duplicar silenciosamente.

**D-ES4. Conversación y Producto se separan por la función que origina cada render, nunca por análisis posterior del contenido.** Auditoría previa a este ADR confirmó que las 7 funciones de render del baseline (`addMsg` y las 6 de la Fase 2: `renderArquitecturas`, `renderEvidencia`, `renderFormaResumen`, `renderModuloDesarrollado`, `renderBonus`, `runBlueprintFinal`) escriben todas sobre el mismo `#msgs`, sin ninguna marca de tipo en los datos. La única señal confiable de "esto es conversación" vs. "esto es producto" es cuál función lo generó — nunca se intentará inferirlo inspeccionando el HTML o el texto ya renderizado.

**D-ES5. Los nodos se trasladan, no se clonan — pero la estrategia concreta depende de la relación de cada sección con su fuente, no es un único mecanismo repetido tres veces.** La implementación de Conversación reveló que decorar `addMsg` (interceptar cada llamada y mover el nodo recién escrito) es frágil: el saludo estático de DESTINO (D-041) escribe de forma síncrona dentro de `kickoffState()`, antes de que el `<script>` del shell llegue a ejecutarse, y `hidratarSesionAlCargar()` limpia `#msgs` con `innerHTML=''` y vuelve a renderizar el transcript completo sin que el shell tenga forma de interceptar ese punto a tiempo — un decorador que decide moverse nodo por nodo simplemente llega tarde en ambos casos. Se corrige adoptando tres estrategias distintas, cada una la más simple y robusta para su caso:
- **Conversación: reubicación permanente del contenedor original.** `#msgs` y `.compose` (el input y el botón de enviar) se reparentan una única vez, al montar el shell, hacia el panel de Conversación — dejan de vivir dentro de `.shell` (oculto) y pasan a ser, físicamente, el contenedor visible. No es una copia derivada: es la misma fuente de verdad de siempre, solo que vive en otro lugar del DOM. Esto preserva automáticamente, sin ningún caso especial, el saludo síncrono, la hidratación, la limpieza con `innerHTML=''` y su rerender, el scroll, el indicador de escritura y cualquier comportamiento futuro que siga operando sobre `#msgs` — porque todos ellos ya asumían que `#msgs` es un elemento real y persistente, y eso sigue siendo cierto.
- **Construcción: reubicación o proyección de los paneles ya existentes, sin duplicar estado.** `#panel-destino/destilar/traducir/ascenso/darvida` ya son contenedores propios, separados de `#msgs` desde el baseline — se reubican (o se proyecta su contenido) hacia el panel de Construcción; no requieren ningún decorador porque nunca compartieron contenedor con nada más.
- **Producto: decorar las 6 funciones de render y trasladar (nunca clonar) los nodos que producen.** Este es el único caso que sí requiere el mecanismo de decorador descrito originalmente, porque es el único caso real de colisión: las 6 funciones de la Fase 2 seguirán escribiendo en `#msgs` — que para entonces ya vive dentro del panel de Conversación — así que su salida debe interceptarse y moverse activamente hacia el panel de Producto, exactamente como se describía antes para todos los casos. Se decide por punto de render (D-ES4), nunca por contenido.

En resumen: Conversación es propiedad del contenedor original; Construcción reubica paneles ya separados; Producto es el único que se resuelve por clasificación activa en el punto de render.

**D-ES6. Esta solución es reversible y no se declara frontend definitivo.** El Experience Shell es una capa demostrable, pensada para mostrarse pronto, no la arquitectura final de Círculo (esa sigue siendo materia del ADR de Memoria Evolutiva/Canvas Vivo/multi-proyecto, todavía sin autorizar). Puede descartarse o reconstruirse sin tocar el motor, precisamente porque nunca se mezcla con él.

**D-ES7. Puntos de referencia explícitos.** El Alpha protegido — el Círculo tal como se validó en producción tras D-041 — queda fijado permanentemente en el tag `alpha-2026-07-20-d041` sobre `main`. Todo el trabajo de este ADR vive exclusivamente en la rama `experience-shell-v1`, sin tocar `main` hasta que se decida explícitamente promoverlo.

**D-ES8. Producto representa un activo existente — nunca trabajo en progreso.** Decisión editorial y arquitectónica a la vez, resuelta antes de implementar Producto (a diferencia de Conversación y Construcción, cuya forma se descubrió construyendo). El principio que la gobierna: *el usuario nunca navega hacia una promesa, solo hacia un activo existente.*

- El pipeline downstream ya produce el activo de forma atómica hoy — `esperarYRenderizarDownstream()` no arma nada pieza por pieza; espera a `pipelineStatus === 'completado'` y entonces trae el DTO completo (arquitectura, evidencias, forma, módulos, bonus) en una sola lectura (`GET /state/:id`). Esta decisión no le pide nada nuevo al backend, solo deja de esconder que ya es así.
- Mientras el pipeline corre, Conversación conserva el control completo de la experiencia — nunca Producto. El usuario ve la última respuesta de Círculo en DAR VIDA y, a continuación, un indicador de espera *dentro de Conversación* con lenguaje que nunca describe al sistema procesando, sino al conocimiento tomando forma (copy provisional, pendiente de pase final: "Organizando todo lo que descubrimos…" o "Dándole forma a todo lo que construimos…" — nunca "Procesando" ni nombres de etapas técnicas). Reutiliza el mecanismo de espera que ya existe (`pipelineStage`/indicador de escritura); lo único que cambia es el texto.
- Solo cuando el activo existe de verdad (pipeline en `completado`) aparece el evento de cierre del proyecto: *"✓ Conversación completada — Tu conocimiento ya tomó forma — [Ver producto]"*. No es un mensaje más de Círculo ni una burbuja de chat — es un evento de cambio de estado del proyecto, con peso visual propio (mismo espíritu que un PR mergeado en GitHub o una página publicada en Notion), no otra respuesta conversacional.
- Producto, una vez que se accede, nace en un único estado posible: `READY`. Nunca implementa spinners, polling, reintentos, activo parcial ni pipeline fallido — esos estados, si existen, se resuelven y se comunican enteramente desde Conversación, antes de habilitar el acceso. Esto es lo que D-ES3 (no duplicar estado) exige aquí: Producto no necesita su propia máquina de estados del pipeline, porque nunca se le permite observarlo a medio camino.
- La revelación progresiva (explorar arquitectura, evidencias, módulos, forma, bonus según el usuario baja en la pantalla) ocurre **sobre el activo ya completo**, nunca sobre su construcción. *La revelación es progresiva. La existencia del activo no.*
- Este principio no es exclusivo de Círculo — se documenta aquí como el criterio general para cualquier producto futuro de AgoraBites que transforme conversación en un activo: primero existe el resultado; después se decide cómo se revela.

**Corolario:** La navegación nunca expone estados imposibles. Cada pestaña representa únicamente información que ya existe en el modelo de dominio. No es exclusivo de Producto — regirá igual cualquier pestaña futura (Publicación, Compartir, Exportar...): el usuario solo puede entrar a un estado que ya es real.

---

## Alcance y estado de la implementación

Secuencia acordada: shell estructural → Conversación → Construcción → Producto → Inicio → diseño visual integrado. Se autoriza y se detiene para revisión después de cada sección — nunca se avanza a la siguiente sin confirmación explícita.

- **Shell estructural**: hecho. Cuatro áreas, navegación funcional, encabezado persistente, responsive básico, cero conexión con renders reales.
- **Conversación**: hecho y validado en producción — reubicación permanente de `#msgs`/`.compose` (D-ES5).
- **Construcción**: hecho y validado en producción — reubicación de los `panel-section` reales, jerarquía mínima (nombre de gramática + Completado/En progreso/Pendiente), sin inventar contenido.
- **Producto**: diseño editorial y arquitectónico cerrado (D-ES8) — implementación todavía no autorizada.
- **Inicio**: sin diseñar — ver Preguntas abiertas.

## Preguntas abiertas

- Qué constituye un "descubrimiento" mostrable en Inicio no está resuelto. El último slot actualizado no equivale necesariamente a un hallazgo importante — usar esa heurística introduciría una interpretación falsa. Inicio queda sin diseñar hasta que exista una fuente confiable para ese dato (posiblemente una señal nueva y explícita del motor, no una heurística sobre datos existentes).
- La taxonomía de tipos de producto digital (curso, membresía, playbook, mentoría...) sigue sin definirse — no bloquea Producto en su forma actual (D-ES8 ya resuelve cómo se revela, sea lo que sea que el pipeline produzca hoy), pero sí bloqueará cualquier evolución de esa pestaña más allá de proyectar el resultado tal cual.
- El copy exacto del indicador de espera en Conversación ("Organizando todo lo que descubrimos…" vs. "Dándole forma a todo lo que construimos…", u otra variante) queda abierto a un pase final de redacción — D-ES8 fija el principio (nunca lenguaje de sistema/procesamiento), no la frase definitiva.
