# circulomejora007 — checkpoint 01

## Estado

El objetivo de 007 es dotar a Círculo de dirección conversacional humana
común a las cinco gramáticas. DESTINO queda certificado con Gemini real:

- T1: CLOSED.
- T2: CLOSED.
- T3: CLOSED.

007 no se declara completo: el siguiente roadmap es DESTILAR.

## Capacidades ganadas

- **Afirmación directa:** la evidencia literal del experto se conserva antes
  de interpretar; una inferencia puede coexistir, pero no sustituirla.
- **Oportunidad tipada:** Capa 1 propone anclajes autorizados y una operación
  cognitiva común (`ABRIR_COMO`, `PEDIR_EJEMPLO`); el rationale libre no
  concede autoridad.
- **Autoridad:** propuesta no equivale a autoridad; inferencia no equivale a
  conocimiento experto; concordancia dimensional no otorga autoridad.
- **Bloqueo:** `NO_PUEDE_RESPONDER` se trata como bloqueo de acceso y cambia la
  vía de intervención; no es conocimiento de dominio.
- **Realización:** Movimiento decide WHAT, Contrato lo congela, Writer lo
  transporta y Realizador expresa HOW. `historialVisibleReciente` solo sirve
  para continuidad lingüística.
- **Confirmación:** una inferencia puede promoverse con confirmación experta
  válida; una señal `NO_PUEDE_RESPONDER` no puede promoverla en ese turno.

## Auditoría focal de DESTILAR

DESTILAR atraviesa la misma ruta productiva de `InteraccionCognitivaWriter`,
`GrafoConocimientoPolicy`, `ObjetivoConversacionalPolicy`,
`MovimientoConversacionalPolicy`, contratos de intervención, persistencia de
turnos y Realizador. La rama conversacional tipada y el selector especializado
de movimiento son actualmente DESTINO-specific.

### Reutilización

| Capacidad | Clasificación | Nota |
|---|---|---|
| preservación de afirmación directa | COMMON_CORE | extracción y gobernanza del grafo |
| autoridad experto/inferido | COMMON_CORE | autoridad epistémica común |
| historialVisibleReciente | COMMON_CORE | contexto HOW |
| oportunidad tipada | DESTILAR_ADAPTER_REQUIRED | misma forma, anclajes/operaciones propias |
| `ABRIR_COMO` | COMMON_CORE | operación común; requiere selección semántica de misión |
| `PEDIR_EJEMPLO` | COMMON_CORE | operación de acceso, no semántica DESTINO |
| `NO_PUEDE_RESPONDER` | COMMON_CORE | señal conversacional |
| `BLOQUEO_FORMA_DE_ACCESO` | COMMON_CORE | adaptación de acceso |
| relación respuesta dirigida | COMMON_CORE | continuidad y reparación |
| ContratoIntervencion | COMMON_CORE | transporte WHAT/HOW |
| materialAfirmable | COMMON_CORE | solo autoridad experta |
| rationale no autoritativo | COMMON_CORE | explicación no presentable |
| confirmación/rechazo de inferencias | COMMON_CORE | reconciliación epistémica |
| propósito global | COMMON_CORE | contexto estable del producto |
| misión de gramática | DESTILAR_ADAPTER_REQUIRED | semántica propia de esencial/tácito/transferible |

### Acoplamientos actuales

La rama tipada de oportunidades, `decidirMovimientoDestino`, dimensiones
`antes/despues/evidencia/conocimiento`, permisos de abstracción de DESTINO y
el framing de descubrir la transformación están condicionados explícitamente
por `gramaticaActiva === 'destino'`. No deben copiarse a DESTILAR.

## Slice nativo propuesto (sin implementación)

Primer incremento: demostrar que una contribución autorizada de DESTILAR se
ancla a su misión de identificar lo esencial/tácito del saber y se convierte
en una única intervención contratada, usando la infraestructura común de
autoridad, continuidad, bloqueo, contrato y realización.

El adapter de misión de DESTILAR debe seleccionar su propio foco semántico
(esencialidad, decisión, distinción o transferibilidad) sin importar las
dimensiones ni la ontología de DESTINO.

### Condición de salida

Antes de implementar, el owner focal debe demostrar: misión DESTILAR
explícita; material experto preservado; foco propio seleccionado upstream;
Movimiento ejecutable; Contrato con WHAT cerrado; Realizador HOW-only;
historial reciente separado de autoridad; y una intervención visible que no
use labels ni semántica de DESTINO.

## Riesgo y recomendación

El riesgo principal es extender condicionales de DESTINO al común y terminar
con una segunda ontología de slots. Reutilizar los owners comunes y añadir
solo el adapter semántico de DESTILAR cuando la condición de salida esté
definida. No implementar DESTILAR en este checkpoint.
