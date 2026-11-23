# CIRCULOMEJORA007 — Reporte 03

## Estado

DESTINO_COBERTURA_RELACIONAL_MECANISMO = CLOSED.

DESTILAR structural slice = CLOSED.

GEMINI_REAL_DESTILAR_1 = READY.

## Causa y decisión

La evidencia humana preservada como una proposición experta con rol contextual `MECANISMO` ya contiene derecho cognitivo suficiente para reconocer el mecanismo. La relación gráfica `PRODUCE` no es requisito obligatorio de cobertura: permanece como topología opcional/enriquecimiento cuando existe legítimamente.

La frontera quedó separada así:

`Capa 1 propone → gobernanza valida el rol → mecanismoConceptoIds representa cobertura semántica`.

No se fabrican relaciones ni se deriva causalidad adicional desde el rol.

## Evidencia

- Owner estructural: PASS.
- Regresiones focales, `node --check` y `git diff --check`: PASS.
- Gemini real (`gemini-3.5-flash-lite`): la proposición literal fue preservada como conocimiento experto y se propuso `MECANISMO` con evidencia literal; el concepto mecanístico quedó cubierto sin depender de `PRODUCE`.
- La sesión real dejó como diagnóstico posterior `RESULTADO_NO_CUBIERTO`, no `MECANISMO_NO_CUBIERTO`.

## Experimentos descartados

Se retiraron los caminos de observador relacional focal, propuestas relacionales atómicas y prompt-tuning orientado a descomposición/`PRODUCE`. El contrato canónico vigente vuelve a ser únicamente `rolesTransformacionales` para esta capacidad.

`PRODUCE` histórico legítimo sigue soportado; su ausencia no revoca autoridad semántica.
