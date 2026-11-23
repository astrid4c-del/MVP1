'use strict';

const runtime = require('./_BaseDefendibleDestinoViewProcessLocal');

// Fachada soportada: no expone la operación interna de registro.
module.exports = {
  prepararVistaEvaluacionBaseDefendibleDestino: runtime.prepararVista,
};
