'use strict';

/**
 * Política lingüística estrecha de C1-2.
 *
 * Atribuye únicamente confirmación o rechazo explícitos. La entrada debe
 * conservar integridad process-local, pero esta política no autentica el
 * origen del turno, la sesión, el conocimiento ni el repositorio.
 *
 * C3-vertical-1 — evaluarVeredictoTransformacionalDesdeProtocolo es la
 * entrada gemela para cuando la clasificación ya existe (producida por
 * ProgresoConversacionalPolicy.decidirProtocolo) — nunca re-clasifica el
 * texto con una segunda gramática de regex.
 */

const runtime = require('../domain/_AfirmacionTransformacionalDestinoProcessLocal');

module.exports = {
  CAUSAS_VEREDICTO: runtime.CAUSAS_VEREDICTO,
  evaluarVeredictoTransformacionalExplicito: runtime.evaluarVeredictoTransformacionalExplicito,
  evaluarVeredictoTransformacionalDesdeProtocolo: runtime.evaluarVeredictoTransformacionalDesdeProtocolo,
};
