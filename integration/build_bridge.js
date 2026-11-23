#!/usr/bin/env node
'use strict';
/**
 * build_bridge.js
 * Genera /home/claude/work/circulo_v0_bridge.html a partir de circulo_v0.html.
 * Ref: Task 6.2B2 (callAI override) + Task 6.5B4 (downstream override).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const API_BASE_URL = process.argv[2] || 'http://localhost:3000';
const SRC      = path.join(__dirname, '../../../../circulo_v0.html');
// Dos superficies, un solo motor (ver "Generación de los artefactos" al
// final del archivo): DEST_RAW es el laboratorio conversacional puro
// (BRIDGE_SCRIPT solo); DEST_APP es el Experience Shell (BRIDGE_SCRIPT +
// EXPERIENCE_SHELL_SCRIPT). Ambos se construyen desde la MISMA función,
// nunca dos copias de la lógica de ensamblado que puedan divergir.
const DEST_RAW = path.join(__dirname, '../../../../circulo_v0_bridge_raw.html');
const DEST_APP = path.join(__dirname, '../../../../circulo_v0_bridge.html');

const BRIDGE_SCRIPT = `
<!-- ═══════════════════════════════════════════════════════════════════════════
     CÍRCULO BRIDGE — Tasks 6.2B2 + 6.5B4
     Integración completa: callAI + downstream → Motor Cognitivo
     No modifica circulo_v0.html (archivo baseline).
     Generado por build_bridge.js
     ══════════════════════════════════════════════════════════════════════════ -->
<script>
(function() {
  'use strict';

  const API_BASE = ${JSON.stringify(API_BASE_URL)};

  // ── Ciclo de vida de la Sesión Cognitiva (frontend) ──────────────────────
  // Todo el estado que el BRIDGE mismo posee (no circulo_v0.html) vive en un
  // único objeto reemplazable, en vez de variables sueltas — "nueva sesión"
  // es "reemplazar este objeto", no "recordar qué resetear". Ver
  // initializeSession()/destroySession() más abajo para el ciclo completo.
  let bridgeSession = {
    id: 'ses_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    downstreamInProgress: false, // guard anti-doble ejecución de esperarYRenderizarDownstream
    restaurada: false, // true si hidratarSesionAlCargar() restauró una sesión existente (ver kickoff más abajo)
    // Incremento 4 (corrección "eliminar turno de reacción redundante"):
    // ver callAIReplacement y el decorador de addMsg más abajo. true durante
    // la única ventana síncrona entre "callAIReplacement devolvió una
    // respuesta con completed:true" y "sendMsg() llama addMsg('circ', ...)
    // con esa misma respuesta" — nunca sobrevive más allá de esa llamada.
    suprimirProximoMensajeCirc: false,
  };
  window.__CIRCULO_SESSION_ID = bridgeSession.id;

  // ── Puntero de sesión (Incremento 7b) ─────────────────────────────────────
  // localStorage guarda ÚNICAMENTE el sessionId — un puntero opaco, nunca
  // memoria cognitiva. El contenido real (estado vigente, transcript) se
  // relee siempre del backend vía /session/:id/hydration; localStorage nunca
  // se convierte en un segundo almacenamiento canónico. Envuelto en
  // try/catch porque localStorage puede lanzar en navegación privada.
  const SESSION_STORAGE_KEY = 'circulo_session_id';
  function leerSessionIdGuardado() {
    try { return localStorage.getItem(SESSION_STORAGE_KEY); } catch (e) { return null; }
  }
  function guardarSessionId(id) {
    try { localStorage.setItem(SESSION_STORAGE_KEY, id); } catch (e) { /* navegación privada u otro bloqueo — no fatal */ }
  }
  function olvidarSessionIdGuardado() {
    try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* no fatal */ }
  }

  // ── Los 16 slots canónicos ────────────────────────────────────────────────
  const ALL_SLOTS = [
    'conocimiento','antes','despues','evidencia',
    'obvio','errores','esencia',
    'relevancia','mundo_real','secuencia',
    'ensayo','prueba_propia','escalon',
    'voz','momento_solo','vida_propia',
  ];

  const STATUS_LABELS = {
    completed:      '¡Listo! Hemos avanzado.',
    paused_hitl:    'Tomemos un momento para revisar esto juntos.',
    stopped_gate:   'Necesito un poco más de información para continuar.',
    stopped_budget: 'Hemos alcanzado el límite de esta sesión.',
    stopped_error:  'Sigo pensando… cuéntame un poco más.',
  };

  function buildEntendido(slots) {
    if (!slots || typeof slots !== 'object')
      return Object.fromEntries(ALL_SLOTS.map(k => [k, null]));
    return Object.fromEntries(
      ALL_SLOTS.map(k => [k, (slots[k] !== undefined && slots[k] !== '') ? slots[k] : null])
    );
  }

  async function apiRequest(method, path, body) {
    try {
      const res = await fetch(API_BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: e.message } };
    }
  }

  // ── StateToV0Mapper inline ────────────────────────────────────────────────
  // Replica la lógica de StateToV0Mapper.js para el contexto browser.
  function mapStateToV0Globals(dto) {
    if (!dto) return null;
    const arqElegida = dto.arquitecturaElegida ? JSON.parse(JSON.stringify(dto.arquitecturaElegida)) : null;
    // __evidencias: desde evidenciasModulos o fallback desde módulos de arq
    let evidencias = [];
    if (Array.isArray(dto.evidenciasModulos) && dto.evidenciasModulos.length > 0) {
      evidencias = JSON.parse(JSON.stringify(dto.evidenciasModulos));
    } else if (arqElegida && Array.isArray(arqElegida.modulos)) {
      evidencias = arqElegida.modulos.map(m => ({
        modulo: m.titulo, evidencia: m.cambio_observable || m.que_contiene || '',
        como_se_reconoce: '', anclaje: 'reconstruido del módulo',
      }));
    }
    return {
      inferredAvatar:      dto.avatarInferido ? JSON.parse(JSON.stringify(dto.avatarInferido)) : null,
      inferredPromesa:     dto.promesaInferida ? JSON.parse(JSON.stringify(dto.promesaInferida)) : null,
      __seleccion:         { avatar: dto.avatarElegido ? JSON.parse(JSON.stringify(dto.avatarElegido)) : null, promesa: dto.promesaElegida ? JSON.parse(JSON.stringify(dto.promesaElegida)) : null },
      __arqElegida:        arqElegida,
      __evidencias:        evidencias,
      __formaProducto:     dto.formaProducto ? JSON.parse(JSON.stringify(dto.formaProducto)) : null,
      desarrolloResultados:Array.isArray(dto.desarrolloResultados) ? JSON.parse(JSON.stringify(dto.desarrolloResultados)) : [],
      __bonus:             dto.bonus ? JSON.parse(JSON.stringify(dto.bonus)) : null,
    };
  }

  function applyV0Globals(g) {
    if (!g) return;
    window.inferredAvatar      = g.inferredAvatar;
    window.inferredPromesa     = g.inferredPromesa;
    window.__seleccion         = g.__seleccion;
    window.__arqElegida        = g.__arqElegida;
    window.__evidencias        = g.__evidencias;
    window.__formaProducto     = g.__formaProducto;
    window.desarrolloResultados = g.desarrolloResultados;
    window.__bonus             = g.__bonus;
  }

  // ── Sincronización de currentStateIdx con el backend (Incremento 7c, corrección) ──
  // currentStateIdx sigue existiendo en el baseline (no se puede eliminar sin
  // tocar circulo_v0.html) y ese baseline sigue incrementándolo dentro de
  // onStateComplete original — pero esta función lo reduce a una PROYECCIÓN
  // visual: cada vez que se llama, SOBREESCRIBE currentStateIdx con lo que
  // el backend reporta como gramaticaActiva en ESE momento, sin importar qué
  // valor tenía antes ni qué incremento local haya ocurrido mientras tanto.
  // Nunca calcula el índice por su cuenta (ni +1 ni ningún otro criterio) —
  // solo traduce gramaticaActiva → posición en STATE_ORDER.
  async function sincronizarCurrentStateIdxDesdeBackend() {
    const sessionId = window.__CIRCULO_SESSION_ID;
    const r = await apiRequest('GET', '/session/' + sessionId);
    if (!r.ok || !r.session) return; // sesión aún no existe (antes del primer turno real) — nada que sincronizar todavía
    const idx = STATE_ORDER.indexOf(r.session.gramaticaActiva);
    currentStateIdx = idx >= 0 ? idx : STATE_ORDER.length - 1; // gramaticaActiva null → las 5 ya cerraron
  }

  // ── callAIReplacement: un turno de una de las 5 gramáticas → /grammar-turn ──
  // No invoca /pipeline: el downstream (Incremento 7d) ya no lo dispara el
  // cliente en ningún punto — ver esperarYRenderizarDownstream más abajo.
  //
  // Incremento 8 (retiro de compatibilidad muerta): el body ya NO incluye
  // etapa ni understood — el backend nunca los usó para decidir nada
  // (state.gramaticaActiva es la única autoridad) y mantenerlos en el
  // artefacto real era compatibilidad que sobrevivía sin ningún efecto. Se
  // añade turnoClienteId en su lugar: una clave de idempotencia real,
  // generada una vez por turno, que InteraccionCognitivaWriter usa para
  // colapsar reenvíos del mismo turno en una sola ejecución del LLM.
  async function callAIReplacement(sys, messages) {
    // Antes de construir la solicitud: nunca confiar en un currentStateIdx
    // que pudo haber quedado adelantado por el incremento local del legacy.
    await sincronizarCurrentStateIdxDesdeBackend();

    const sessionId = window.__CIRCULO_SESSION_ID;
    const turnoClienteId = 'turno_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const mensajeUsuario = (Array.isArray(messages) && messages.length > 0)
      ? String(messages[messages.length - 1].content || '')
      : '';

    const response = await apiRequest('POST', '/grammar-turn', {
      sessionId, turnoClienteId, mensajeUsuario,
    });

    if (!response.ok)
      return { mensaje: response.error?.message || STATUS_LABELS.stopped_error, entendido: buildEntendido(null) };

    const result = response.data;

    // DURABILIDAD_ENTRADA_CONVERSACIONAL_1 §12 — result.procesamientoCompletado
    // === false (HTTP 200, result.mensaje === null) significa que el mensaje
    // del usuario quedó admitido y durable, pero el procesamiento cognitivo
    // no produjo respuesta — nunca "silencio" ni un mensaje vacío tratado
    // como respuesta cognitiva real. Mismo texto genérico que ya usa el
    // caso \`!response.ok\` de arriba (STATUS_LABELS.stopped_error) — sin
    // copy nuevo, solo evitar la falsa respuesta.
    if (result.procesamientoCompletado === false) {
      return { mensaje: STATUS_LABELS.stopped_error, entendido: buildEntendido(result.entendido) };
    }

    // Deliberadamente NO se resincroniza currentStateIdx aquí. callAIReplacement
    // es un adaptador de transporte: su trabajo termina en devolver result
    // traducido al contrato que sendMsg() espera. sendMsg() (circulo_v0.html,
    // intocable) lee currentStateIdx justo después de este await para decidir
    // qué completeFlag corresponde a ESTA respuesta — si esta función adelantara
    // currentStateIdx a la gramática nueva antes de devolver el control, sendMsg
    // preguntaría por el flag de la gramática nueva sobre una respuesta que solo
    // trae el flag de la gramática vieja, y la condición nunca sería true (bug
    // real observado: la validación manual post-corrección de IDENTITY cerró
    // DESTINO y DESTILAR en el backend, pero el header se quedó en "Estado 1 ·
    // Destino" las dos veces). currentStateIdx solo debe avanzar donde
    // corresponde: dentro de onStateComplete(), después de que sendMsg ya
    // interpretó esta respuesta con el estado que tenía al recibirla.

    // Incremento 4 (corrección "eliminar turno de reacción redundante"):
    // completed:true significa que ESTA respuesta es control de transición,
    // no contenido conversacional — el único mensaje visible de la
    // gramática siguiente (o el estado terminal de DAR VIDA) lo produce
    // exclusivamente onStateComplete()/kickoffState() (baseline, sin
    // cambios), un paso después. Se arma la señal AQUÍ, en el adaptador de
    // transporte, porque es el único lugar que ya conoce result.completed
    // sin tener que volver a interpretarlo — el decorador de addMsg
    // (definido más abajo) es quien la consume, exactamente una vez.
    if (result.completed === true) {
      bridgeSession.suprimirProximoMensajeCirc = true;
    }

    return {
      mensaje: result.mensaje,
      entendido: buildEntendido(result.entendido),
      proponiendo_cierre: !!result.proponiendo_cierre,
      [result.completeFlag]: result.completed === true,
    };
  }

  // ── kickoffState bridge: bienvenida estática de sesión nueva ──────────────
  // kickoffState() (baseline, intocable) SIEMPRE llama a callAI() para
  // generar el primer mensaje — incluido el de DESTINO, el primero que ve
  // cualquier usuario nuevo. Eso significaba, hasta ahora, que ese saludo
  // pasaba por /grammar-turn con un mensajeExperto sintético
  // ("[Inicio del estado...]"), generando un Turno real ANTES del primer
  // input genuino del usuario — la UI dependía incorrectamente del motor
  // cognitivo solo para mostrar un saludo fijo. Se corrige aquí, no en
  // circulo_v0.html ni en el prompt de kickoff: se intercepta kickoffState()
  // exclusivamente para el primer estado (currentStateIdx===0) de una
  // sesión genuinamente nueva (nunca restaurada) y se muestra el texto
  // aprobado directamente — cero llamada a callAI, cero POST /grammar-turn,
  // cero Turno, cero costo de LLM. Los kickoffs de las demás 4 gramáticas
  // (currentStateIdx>0) siguen exactamente igual: SÍ deben reflejar
  // comprensión real acumulada, así que siguen pasando por el motor.
  const BIENVENIDA_ESTATICA = 'Hola, soy Círculo. Tienes un conocimiento valioso, cuéntame. ¿Qué es eso que sabes hacer y otros quieren aprender?';
  let bienvenidaEstaticaMostrada = false;
  const _legacyKickoffState = window.kickoffState;
  window.kickoffState = async function () {
    if (currentStateIdx === 0 && !bridgeSession.restaurada && !bienvenidaEstaticaMostrada) {
      bienvenidaEstaticaMostrada = true;
      addMsg('circ', BIENVENIDA_ESTATICA);
      if (typeof sendBtn !== 'undefined' && sendBtn) sendBtn.disabled = false;
      if (typeof inpEl !== 'undefined' && inpEl) inpEl.focus();
      return;
    }
    if (typeof _legacyKickoffState === 'function') return _legacyKickoffState.apply(this, arguments);
  };

  // ── esperarYRenderizarDownstream (Incremento 7d) ──────────────────────────
  // El bridge YA NO decide que DAR VIDA terminó y YA NO ordena un
  // POST /pipeline que arranque el downstream — esa decisión y esa solicitud ahora
  // son responsabilidad exclusiva del backend (InteraccionCognitivaWriter +
  // PipelineDownstreamRunner), disparadas atómicamente con la confirmación
  // del último Turno de DAR VIDA, exactamente una vez por sesión. Esta
  // función SOLO espera (consultando pipelineStatus vía GET /session/:id,
  // sin escribir nada) y renderiza — nunca solicita, nunca reintenta desde
  // el cliente. Se llama tanto al vivo (tras confirmar DAR VIDA) como al
  // restaurar una sesión cuyo downstream ya estaba en curso o completado
  // (ver hidratarSesionAlCargar) — en ambos casos el comportamiento es
  // idéntico: consultar hasta que se resuelva.
  const DOWNSTREAM_POLL_MS = 1200;
  const DOWNSTREAM_POLL_MAX_INTENTOS = 150; // ~3 minutos de espera máxima

  async function esperarYRenderizarDownstream() {
    if (bridgeSession.downstreamInProgress) {
      console.warn('[Círculo Bridge] esperarYRenderizarDownstream llamado de nuevo mientras ya está en curso — ignorado');
      return;
    }
    bridgeSession.downstreamInProgress = true;

    const sessionId = window.__CIRCULO_SESSION_ID;

    if (typeof window.pipelineStage === 'function') window.pipelineStage(62, 'Procesando tu conocimiento…');
    if (typeof window.showTyping    === 'function') window.showTyping();

    let status = null, intentos = 0;
    while (intentos < DOWNSTREAM_POLL_MAX_INTENTOS) {
      const r = await apiRequest('GET', '/session/' + sessionId);
      if (r.ok && r.session) status = r.session.pipelineStatus;
      if (status === 'completado' || status === 'fallido') break;
      intentos++;
      await new Promise(function(resolve) { setTimeout(resolve, DOWNSTREAM_POLL_MS); });
    }

    if (typeof window.hideTyping === 'function') window.hideTyping();

    if (status !== 'completado') {
      if (typeof window.addMsg === 'function') window.addMsg('circ', STATUS_LABELS.stopped_error);
      bridgeSession.downstreamInProgress = false;
      return;
    }

    // pipelineStatus:'completado' — traer el DTO completo (avatar,
    // arquitectura, forma, etc.) que la lectura mínima de /session/:id
    // (Incremento 5, deliberadamente acotada a lo canónico) no expone.
    // Sigue siendo lectura pura, nunca una solicitud de trabajo nuevo.
    const response = await apiRequest('GET', '/state/' + sessionId);
    if (!response.ok || !response.data) {
      if (typeof window.addMsg === 'function') window.addMsg('circ', STATUS_LABELS.stopped_error);
      bridgeSession.downstreamInProgress = false;
      return;
    }

    // Actualizar checkpoints
    window.__CIRCULO_PIPELINE_CHECKPOINT = response.data.pipelineCheckpoint || null;
    window.__CIRCULO_AGORA_CHECKPOINT    = response.data.agoraCheckpoint    || null;

    const dto = response.data;
    const g = mapStateToV0Globals(dto);
    applyV0Globals(g);

    // Render de inferencia (avatar + promesa)
    if (typeof window.renderInferencePanel === 'function' && g.inferredAvatar)
      window.renderInferencePanel(g.inferredAvatar, g.inferredPromesa);

    // Render de arquitectura (envolver en candidatas para renderArquitecturas)
    if (g.__arqElegida && typeof window.renderArquitecturas === 'function') {
      const candidatas = [{
        label: 'Recomendada ⭐',
        resumen: '',
        criterio_diferenciador: null,
        justificacion_unica: 'El Motor determinó que no existía una segunda estrategia pedagógica legítima.',
        modulos: g.__arqElegida.modulos || [],
      }];
      window.renderArquitecturas(candidatas);
      if (typeof window.pipelineStage === 'function') window.pipelineStage(72, 'Arquitectura lista');
    }

    // Render de evidencias
    if (g.__evidencias && g.__evidencias.length > 0 && typeof window.renderEvidencia === 'function') {
      window.renderEvidencia(g.__evidencias);
      if (typeof window.pipelineStage === 'function') window.pipelineStage(80, 'Evidencias definidas');
    }

    // Render de forma
    if (g.__formaProducto && typeof window.renderFormaResumen === 'function') {
      window.renderFormaResumen(g.__formaProducto);
      if (typeof window.pipelineStage === 'function') window.pipelineStage(86, 'Forma del producto');
    }

    // Render de desarrollo (módulo a módulo)
    if (g.desarrolloResultados && g.desarrolloResultados.length > 0 && typeof window.renderModuloDesarrollado === 'function') {
      g.desarrolloResultados.forEach((r, i) => window.renderModuloDesarrollado(r, i));
      if (typeof window.pipelineStage === 'function') window.pipelineStage(94, 'Módulos desarrollados');
    }

    // Render de bonus
    if (g.__bonus && typeof window.renderBonus === 'function') {
      window.renderBonus(g.__bonus);
      if (typeof window.pipelineStage === 'function') window.pipelineStage(96, 'Bonus listo');
    }

    // Render final del blueprint (función real en v0: runBlueprintFinal)
    if (typeof window.runBlueprintFinal === 'function') {
      window.runBlueprintFinal();
    } else if (typeof window.addMsg === 'function') {
      window.addMsg('circ', 'Tu producto está listo. Es tuyo.');
    }

    if (typeof window.pipelineStage === 'function') window.pipelineStage(100, 'Completado ✦');
    bridgeSession.downstreamInProgress = false;
  }

  // ── Revelado progresivo — exclusivamente visual (mejora de producto,
  // posterior a Etapa 3) ──────────────────────────────────────────────────
  // Objetivo: que un mensaje NUEVO de Círculo se sienta escrito, no
  // despachado de una vez, sin tocar backend/pipeline/prompts/contratos ni
  // el contenido del mensaje — el texto final es siempre, byte a byte, el
  // mismo que _legacyAddMsg ya renderizó de forma síncrona e inmediata (ver
  // decorador más abajo): esta capa solo reduce y vuelve a completar el
  // textContent de la burbuja ya creada, nunca cambia qué se guarda, qué
  // se envía, ni el order de los mensajes.
  //
  // hidratandoHistorial: true únicamente durante el replay de
  // hidratarSesionAlCargar() — nunca se anima el historial, solo mensajes
  // genuinamente nuevos (incluida la bienvenida de una sesión REALMENTE
  // nueva, que si debe animarse).
  let hidratandoHistorial = false;
  // revealActivo: como mucho una animación en curso a la vez — la próxima
  // (mensaje nuevo, o un reset de conversación) siempre cancela la anterior
  // de forma limpia (el bubble anterior queda con su propio texto completo,
  // nunca a mitad de camino).
  let revealActivo = null;

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false; // entorno sin matchMedia (tests, navegadores viejos): nunca bloquea la animación por esto
    }
  }

  // "pequeñas unidades de palabras" — cada fragmento es una racha de
  // no-espacios más su espacio final. Nunca letra por letra.
  function tokenizarParaRevelado(texto) {
    return texto.match(/\\S+\\s*/g) || (texto ? [texto] : []);
  }

  // Segundo ajuste tras prueba visual real (primer feedback: "muy rápido";
  // segundo feedback, ya con el ritmo más lento: "sigue viéndose extraño").
  // El problema no era la velocidad — era el MECANISMO: reemplazar
  // textContent de golpe, palabra por palabra, no tiene ninguna transición;
  // cada palabra "aparece" de un salto seco, sin importar cuánto se
  // espacien los pasos. Es exactamente lo que se ve mecánico. La forma
  // real en que ChatGPT/Claude y el resto revelan texto no generado en
  // vivo (reveal simulado, no streaming real) es: cada fragmento entra con
  // una transición CSS breve (fundido + leve desplazamiento), y el
  // INTERVALO entre que empieza a aparecer una palabra y la siguiente es
  // más corto que la duración de esa transición — así varias palabras
  // están fundiéndose a la vez, en cascada, en vez de una fila de saltos
  // discretos. Un cursor parpadeante en la punta (el mismo recurso visual
  // que cualquier UI de "escribiendo…") refuerza la sensación sin agregar
  // ningún timer nuevo — es puro CSS.
  let revelarEstilosInyectados = false;
  function asegurarEstilosRevelado() {
    if (revelarEstilosInyectados) return;
    revelarEstilosInyectados = true;
    try {
      var style = document.createElement('style');
      style.textContent = [
        '.circulo-reveal-word{display:inline-block;opacity:0;transform:translateY(3px);',
        'animation:circuloRevealWord 300ms ease-out forwards;}',
        '@keyframes circuloRevealWord{to{opacity:1;transform:translateY(0);}}',
        '.circulo-reveal-cursor{display:inline-block;width:2px;height:1em;margin-left:1px;',
        'background:currentColor;opacity:.55;vertical-align:text-bottom;',
        'animation:circuloRevealBlink 900ms step-end infinite;}',
        '@keyframes circuloRevealBlink{50%{opacity:0;}}',
        '@media (prefers-reduced-motion:reduce){',
        '.circulo-reveal-word{animation:none;opacity:1;transform:none;}',
        '.circulo-reveal-cursor{display:none;}}',
      ].join('');
      document.head.appendChild(style);
    } catch (e) {
      // Puramente cosmético — sin esta hoja de estilo, las palabras igual
      // se revelan (solo sin fundido), nunca se pierde contenido por esto.
    }
  }

  // Ritmo: ahora es el INTERVALO entre que empieza a revelarse un fragmento
  // y el siguiente — nunca la duración visible de cada uno (esa la fija el
  // CSS, arriba, siempre igual). Sigue siendo función del largo del
  // mensaje y de su puntuación, nunca una cadencia constante por carácter,
  // y sigue escalándose proporcionalmente si el total excedería el máximo
  // razonable — "aceleración automática para respuestas largas", sin
  // truncar el mensaje ni saltar fragmentos.
  // Tercer ajuste tras prueba visual real (feedback: "aún se siente muy
  // rápido") — de nuevo, solo estos números, mismo mecanismo.
  const REVEAL_MAX_TOTAL_MS      = 5200; // "límite máximo razonable de duración"
  const REVEAL_BASE_STAGGER_MS   = 72;
  const REVEAL_COMMA_EXTRA_MS    = 130;  // pausa ligeramente mayor en coma/punto y coma/dos puntos
  const REVEAL_SENTENCE_EXTRA_MS = 290;  // pausa mayor en punto/cierre de oración
  const REVEAL_MIN_STAGGER_MS    = 24;

  function calcularRitmo(fragmentos) {
    const delays = fragmentos.map(function(frag) {
      if (/[.!?…]\\s*$/.test(frag)) return REVEAL_BASE_STAGGER_MS + REVEAL_SENTENCE_EXTRA_MS;
      if (/[,;:]\\s*$/.test(frag))  return REVEAL_BASE_STAGGER_MS + REVEAL_COMMA_EXTRA_MS;
      return REVEAL_BASE_STAGGER_MS;
    });
    const total = delays.reduce(function(a, b) { return a + b; }, 0);
    if (total <= REVEAL_MAX_TOTAL_MS || total === 0) return delays;
    const factor = REVEAL_MAX_TOTAL_MS / total;
    return delays.map(function(d) { return Math.max(REVEAL_MIN_STAGGER_MS, Math.round(d * factor)); });
  }

  // Recomendación de producto (prueba visual real): animar el mensaje
  // ENTERO obliga al usuario a esperar todo ese tiempo para leerlo completo
  // — innecesario, porque el efecto de "está escribiendo" ya se percibe
  // con solo el primer tramo. Solo se revela por fragmentos el primer
  // ~30% de las palabras; el resto aparece de inmediato, sin fundido
  // propio (un fundido para "el resto" se veía como un efecto aparte y
  // feo — se probó y se descartó) — el usuario nunca espera el mensaje
  // completo.
  const REVEAL_FRACCION_ANIMADA = 0.3;

  // Revela texto dentro de bubbleEl (ya en el DOM, ya con su nodo .who
  // hermano — ver intentarAnimarUltimoMensajeCirc). Cada fragmento del
  // tramo animado entra como su propio <span> con la transición CSS de
  // arriba — nunca cambia el TEXTO, solo cómo se presenta mientras se
  // revela. Un cursor parpadeante marca la punta de escritura y
  // desaparece al terminar. Primer fragmento siempre síncrono — nunca hay
  // un instante en blanco perceptible antes de empezar. Termina SIEMPRE
  // colapsado a bubbleEl.textContent === texto exacto, en texto plano (sin
  // spans residuales) — tanto en el camino normal como en cancelación.
  function revelarProgresivamente(bubbleEl, texto) {
    if (revealActivo) revealActivo.cancelar();
    const fragmentos = tokenizarParaRevelado(texto);
    if (fragmentos.length === 0) { bubbleEl.textContent = texto; return; }
    asegurarEstilosRevelado();
    bubbleEl.textContent = ''; // limpia el shell antes de construir por fragmentos
    const cursor = document.createElement('span');
    cursor.className = 'circulo-reveal-cursor';
    bubbleEl.appendChild(cursor);
    const limiteAnimado = Math.max(1, Math.min(fragmentos.length, Math.ceil(fragmentos.length * REVEAL_FRACCION_ANIMADA)));
    const delays = calcularRitmo(fragmentos.slice(0, limiteAnimado));
    const estado = { timer: null, terminado: false };
    estado.cancelar = function() {
      if (estado.terminado) return;
      estado.terminado = true;
      if (estado.timer) clearTimeout(estado.timer);
      bubbleEl.textContent = texto; // colapso limpio a texto plano exacto
      if (revealActivo === estado) revealActivo = null;
    };
    revealActivo = estado;
    let idx = 0;
    function insertarFragmentoComoSpan(fragmento, refNode) {
      // El espacio/salto de línea final del fragmento va COMO NODO DE TEXTO
      // aparte, nunca dentro del span: un span inline-block colapsa/recorta
      // el espacio en blanco pegado a su propio borde (hallazgo de la
      // prueba visual — las palabras se pegaban entre sí sin espacio). Un
      // nodo de texto plano, hermano del span, nunca sufre ese recorte.
      const separador = fragmento.match(/\\s*$/)[0];
      const palabra = separador ? fragmento.slice(0, -separador.length) : fragmento;
      const span = document.createElement('span');
      span.className = 'circulo-reveal-word';
      span.textContent = palabra;
      bubbleEl.insertBefore(span, refNode);
      if (separador) bubbleEl.insertBefore(document.createTextNode(separador), refNode);
    }
    function paso() {
      if (estado.terminado) return;
      insertarFragmentoComoSpan(fragmentos[idx], cursor);
      if (typeof msgsEl !== 'undefined' && msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
      idx++;
      if (idx < limiteAnimado) {
        estado.timer = setTimeout(paso, delays[idx - 1]);
      } else {
        // Tramo animado terminado (recomendación de producto: solo ~30% se
        // revela por fragmentos) — el resto aparece de inmediato, sin
        // ningún fundido propio ni espera adicional (un fundido para "el
        // resto" se veía como un efecto aparte y feo — se descarta).
        estado.terminado = true;
        bubbleEl.textContent = texto; // identidad byte a byte garantizada; sin spans residuales
        if (revealActivo === estado) revealActivo = null;
      }
    }
    paso();
  }

  // Intenta animar el ÚLTIMO mensaje 'circ' que _legacyAddMsg ya renderizó
  // por completo, de forma síncrona, un instante antes. Deliberadamente
  // defensivo: cualquier entorno sin las capacidades de DOM necesarias
  // (por ejemplo los stubs mínimos de la suite de tests existente) deja el
  // mensaje exactamente como _legacyAddMsg ya lo dejó — nunca se pierde ni
  // se corrompe contenido por un problema puramente visual, y nunca se
  // duplica el mensaje.
  function intentarAnimarUltimoMensajeCirc(textoCompleto) {
    try {
      if (hidratandoHistorial) return;
      if (prefersReducedMotion()) return;
      if (typeof msgsEl === 'undefined' || !msgsEl) return;
      const nodoMsg = msgsEl.lastElementChild;
      if (!nodoMsg || typeof nodoMsg.querySelector !== 'function') return;
      const bubbleEl = nodoMsg.querySelector('.bubble');
      if (!bubbleEl) return;
      revelarProgresivamente(bubbleEl, textoCompleto);
    } catch (e) {
      // Puramente visual — cualquier fallo aquí nunca debe afectar el
      // contenido ya renderizado por _legacyAddMsg.
    }
  }

  // ── addMsg bridge: captura el mensaje de apertura (Incremento 7b, corrección) ──
  // kickoffState() (baseline, intocable) llama a addMsg('circ', ...) para
  // mostrar el primer mensaje de cada gramática. El backend no puede
  // observarlo por sí mismo — Círculo habla primero, no hay mensajeExperto
  // real, así que nunca pasa por /grammar-turn ni genera un Turno. Mismo
  // patrón "decorador, no reemplazo" que onStateComplete/elegirOpcion:
  // addMsg ORIGINAL sigue renderizando exactamente igual; esto solo AGREGA
  // el reporte, una vez, del primer mensaje 'circ' de una sesión NUEVA
  // (nunca de una restaurada — bridgeSession.restaurada ya se puso en true
  // ANTES de re-renderizar el kickoff restaurado, así que no se duplica).
  // Se reporta vía /trace — la misma vía de observabilidad pura que ya
  // existía — como 'conversacion.iniciada', nunca como un Turno ni mezclado
  // en el transcript.
  let kickoffYaCapturado = false;
  const _legacyAddMsg = window.addMsg;
  window.addMsg = function(who, text) {
    // Incremento 4 (corrección "eliminar turno de reacción redundante"):
    // consume la señal de callAIReplacement exactamente una vez, en la
    // primera llamada 'circ' que sigue — que es, siempre, la propia
    // respuesta de confirmación que sendMsg() está a punto de renderizar
    // (addMsg('circ', reply.mensaje), inmediatamente después del await a
    // callAI, sin ningún otro addMsg('circ', ...) posible en medio). No se
    // renderiza y no se reporta como kickoff: el mensaje real de la
    // gramática siguiente (o el estado terminal de DAR VIDA) lo produce,
    // un paso después, onStateComplete()/kickoffState() — sin cambios.
    if (who === 'circ' && bridgeSession.suprimirProximoMensajeCirc) {
      bridgeSession.suprimirProximoMensajeCirc = false;
      return;
    }
    if (typeof _legacyAddMsg === 'function') _legacyAddMsg(who, text);
    if (who === 'circ') intentarAnimarUltimoMensajeCirc(text);
    if (who === 'circ' && !kickoffYaCapturado && !bridgeSession.restaurada) {
      kickoffYaCapturado = true;
      apiRequest('POST', '/trace', {
        sessionId: window.__CIRCULO_SESSION_ID,
        evento: 'conversacion.iniciada',
        datos: { gramatica: STATE_ORDER[currentStateIdx], mensaje: text },
      }).catch(() => {});
    }
  };

  // ── elegirOpcion bridge: reanuda el Motor tras pausa HITL ─────────────────
  // Solo intercepta si hay pausa HITL pendiente; en caso contrario delega al legacy.
  const _legacyElegirOpcion = window.elegirOpcion;
  window.elegirOpcion = function(tipo, idx) {
    if (!window.__CIRCULO_BRIDGE_ACTIVE || !window.__CIRCULO_AGORA_CHECKPOINT) {
      if (typeof _legacyElegirOpcion === 'function') _legacyElegirOpcion(tipo, idx);
      return;
    }
    // Hay una pausa HITL — registrar la elección y reanudar el Motor
    if (!window.__seleccion) window.__seleccion = {};
    if (tipo === 'avatar') window.__seleccion.avatar = (window.__avatarOps || [])[idx];
    if (tipo === 'promesa') window.__seleccion.promesa = (window.__promesaOps || [])[idx];
    // Si ambas elecciones están hechas, reanudar
    if (window.__seleccion.avatar && window.__seleccion.promesa) {
      (async () => {
        const response = await apiRequest('POST', '/pipeline', {
          sessionId: window.__CIRCULO_SESSION_ID, resume: true,
        });
        // Después de reanudar, activar downstream
        if (response.ok && response.data.status === 'completed') {
          const g = mapStateToV0Globals(response.data.state);
          applyV0Globals(g);
          if (typeof window.renderInferencePanel === 'function' && g.inferredAvatar)
            window.renderInferencePanel(g.inferredAvatar, g.inferredPromesa);
          window.__CIRCULO_AGORA_CHECKPOINT = null;
        }
      })();
    }
  };

  // ── ningunaRepresenta bridge ───────────────────────────────────────────────
  window.ningunaRepresenta = function() {
    if (!window.__CIRCULO_BRIDGE_ACTIVE) {
      // Usar legacy
      return;
    }
    // Indicar al usuario sin invocar el flujo legacy de presentarOpciones
    if (typeof window.addMsg === 'function')
      window.addMsg('circ', 'Entendido. Dame un momento para reconsiderar el enfoque con todo lo que me contaste…');
    // El downstream sigue 'ejecutando'/pausado del lado del backend (HITL) —
    // esto solo vuelve a esperar su resolución, nunca solicita uno nuevo.
    bridgeSession.downstreamInProgress = false;
    setTimeout(esperarYRenderizarDownstream, 1200);
  };

  // ── onStateComplete: decorador, no reemplazo ──────────────────────────────
  // onStateComplete original de v0 es la ÚNICA función que contiene
  // "currentStateIdx++" (transición entre las 5 gramáticas) — sigue
  // ejecutándose sin cambios para DESTINO/DESTILAR/TRADUCIR/ASCENSO, como
  // bookkeeping puramente visual: por diseño (Incremento 7c), su entrada
  // (reply[completeFlag] y el "entendido" que alimenta hasFullEvidence) sale
  // siempre 1:1 de lo que /grammar-turn devolvió del estado canónico, así
  // que nunca puede producir un veredicto distinto al del Gate del backend
  // — no decide nada que el backend no haya decidido ya. Sustituirlo
  // incondicionalmente por esperarYRenderizarDownstream (pensada solo para
  // el downstream) congelaba currentStateIdx en 0: cada gramática completada
  // esperaba downstream en vez de avanzar la UI. Solo al completar DAR VIDA
  // (última gramática) se entra a esperar el downstream real.
  const _legacyOnStateComplete = window.onStateComplete;
  function onStateCompleteDecorated() {
    // Observabilidad pura (Objetivo: sistema observable, no corrección de
    // comportamiento): registra la decisión de transición en el mismo
    // timeline de eventos del backend. Fire-and-forget — no se espera (sin
    // await) y cualquier fallo se descarta con .catch(), para que esta línea
    // no pueda alterar ni retrasar la rama real que se ejecuta a continuación.
    apiRequest('POST', '/trace', {
      sessionId: bridgeSession.id,
      evento: 'gramatica.transicion',
      datos: {
        currentStateIdxAntes: currentStateIdx,
        gramaticaActual: STATE_ORDER[currentStateIdx],
        esUltimaGramatica: currentStateIdx === STATE_ORDER.length - 1,
        rama: (currentStateIdx < STATE_ORDER.length - 1) ? 'avanza_siguiente_gramatica' : 'entra_downstream_final',
      },
    }).catch(() => {});

    if (currentStateIdx < STATE_ORDER.length - 1) {
      if (typeof _legacyOnStateComplete === 'function') _legacyOnStateComplete();
      // El legacy incrementa currentStateIdx dentro de SU PROPIO setTimeout
      // (1700ms, ver comentario "decorador, no reemplazo" arriba). Se
      // reafirma la proyección real del backend DESPUÉS de esa ventana, para
      // que ningún incremento local sobreviva como fuente de verdad más
      // allá de ella — currentStateIdx nunca queda, ni temporalmente,
      // definido solo por el +1 local.
      setTimeout(() => { sincronizarCurrentStateIdxDesdeBackend(); }, 1900);
      return;
    }
    esperarYRenderizarDownstream();
  }

  // ── Nueva Sesión Cognitiva: ciclo de vida explícito del frontend ─────────
  // Objetivo: crear un producto digital nuevo sin refrescar el navegador, y
  // que el usuario quede exactamente en el mismo estado que si acabara de
  // abrir Círculo por primera vez.
  //
  // Límite de diseño explícito (no un descuido): el estado conversacional
  // real — currentStateIdx, understood, history, finished, userTurns,
  // pendingInferenceQuestion, awaitingOptionSelection, desarrolloResultados,
  // desarrolloIdx, pipelineProgress, inferredAvatar/inferredPromesa — vive en
  // variables let DENTRO de circulo_v0.html, un archivo que este proyecto
  // no modifica. No existe una API de JavaScript para enumerar el scope
  // léxico de otro <script> tag, así que no hay forma de "envolver" esas
  // variables en un objeto propiedad del bridge sin tocar ese archivo. Esta
  // función es la única, centralizada, documentada lista de qué resetear —
  // la alternativa (repetir un reset parcial en cada lugar que lo necesite)
  // es exactamente el tipo de bug que causó la autopsia del Smoke Test #2,
  // ahora del lado del frontend. Cualquier estado conversacional nuevo que
  // se agregue a circulo_v0.html en el futuro debe añadirse aquí también.
  //
  // El estado que SÍ es propiedad del bridge (bridgeSession y los globals
  // window.* que el propio bridge escribe vía applyV0Globals) no tiene ese
  // límite: se reinicia reemplazando el objeto completo, no campo por campo.

  /**
   * Cierra la Sesión Cognitiva actual del frontend. No hay recursos que
   * liberar del lado del cliente (no hay sockets ni polling abiertos) — solo
   * deja una marca de observabilidad en el mismo timeline de eventos del
   * backend. Fire-and-forget, igual que el resto de los beacons de /trace.
   */
  function destroySession() {
    if (!bridgeSession.id) return; // nada que destruir (no debería ocurrir)
    apiRequest('POST', '/trace', {
      sessionId: bridgeSession.id,
      evento: 'session.destroyed',
      datos: {},
    }).catch(() => {});
  }

  /**
   * Único punto de entrada para "empezar de cero": cierra la sesión anterior,
   * crea una Sesión Cognitiva nueva (nuevo sessionId — el backend le
   * provisionará automáticamente un CognitiveState, un OrchestratorService y
   * un LLMService propios y aislados la primera vez que la toque, ver
   * CognitiveSessionRegistry en el backend), reinicia todo el estado
   * temporal del frontend, y arranca la conversación desde cero — ya con el
   * bridge activo, así que el primer turno pasa correctamente por
   * /grammar-turn.
   */
  function initializeSession() {
    destroySession();

    bridgeSession = {
      id: 'ses_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      downstreamInProgress: false,
      restaurada: false,
      suprimirProximoMensajeCirc: false,
    };
    kickoffYaCapturado = false; // esta sesión nueva tiene su propio kickoff por capturar
    bienvenidaEstaticaMostrada = false; // "Iniciar de nuevo" también es una conversación nueva
    window.__CIRCULO_SESSION_ID          = bridgeSession.id;
    guardarSessionId(bridgeSession.id); // Incremento 7b: sobrevive a un refresh futuro
    window.__CIRCULO_PIPELINE_CHECKPOINT = null;
    window.__CIRCULO_AGORA_CHECKPOINT    = null;
    window.__seleccion          = null;
    window.__arqElegida         = null;
    window.__evidencias         = null;
    window.__avatarOps          = null;
    window.__promesaOps         = null;
    window.__arquitecturas      = null;
    window.__formaProducto      = null;
    window.__bonus              = null;
    window.desarrolloResultados = null;
    window.inferredAvatar       = null;
    window.inferredPromesa      = null;

    // Estado conversacional de v0 — ver nota de límite de diseño arriba.
    currentStateIdx = 0;
    userTurns = 0;
    finished = false;
    history = [];
    understood = {
      conocimiento:null, antes:null, despues:null, evidencia:null,
      obvio:null, errores:null, esencia:null,
      relevancia:null, mundo_real:null, secuencia:null,
      ensayo:null, prueba_propia:null, escalon:null,
      voz:null, momento_solo:null, vida_propia:null,
    };
    pipelineProgress = 0;
    inferredAvatar = null;
    inferredPromesa = null;
    awaitingOptionSelection = false;
    pendingInferenceQuestion = false;
    desarrolloResultados = [];
    desarrolloIdx = 0;

    // Reset visual: reutiliza funciones REALES de v0, no reimplementa DOM.
    // Revelado progresivo: la conversación cambia por completo — cualquier
    // animación en curso termina limpia (su propio texto completo) antes
    // de que su nodo desaparezca con el reset.
    if (revealActivo) revealActivo.cancelar();
    if (typeof msgsEl !== 'undefined' && msgsEl) msgsEl.innerHTML = '';
    const banner = document.getElementById('doneBanner');
    if (banner) banner.classList.remove('show');
    if (typeof updateTurnBadge === 'function') updateTurnBadge();
    if (typeof setStateUI === 'function') setStateUI();
    // Bugfix (preexistente, revelado al conectar Construcción al Experience
    // Shell): understood ya se reinició arriba, pero nadie volvía a proyectar
    // ese reset sobre el panel — los .ui-value/.filled seguían mostrando el
    // contenido de la sesión anterior hasta el primer dato nuevo real.
    // hidratarSesionAlCargar() ya resuelve exactamente este mismo caso
    // (proyectar un estado vacío) con updatePanel([]) — se reutiliza esa
    // misma llamada aquí, en vez de una segunda estrategia de limpieza.
    if (typeof updatePanel === 'function') updatePanel([]);

    apiRequest('POST', '/trace', {
      sessionId: bridgeSession.id,
      evento: 'session.created',
      datos: {},
    }).catch(() => {});

    if (typeof kickoffState === 'function') kickoffState();
  }

  /**
   * Restaura una sesión existente al cargar/recargar la página (Incremento
   * 7b) — reconstruye currentStateIdx, understood y el transcript visible
   * EXCLUSIVAMENTE desde GET /session/:id/hydration (SessionHydrator, ver
   * backend). Nunca deduce la gramática contando pantallas ni reconstruye
   * slots leyendo mensajes: ambos vienen tal cual del estado canónico.
   *
   * Límite de diseño estructural (no un descuido): circulo_v0.html dispara
   * kickoffState() de forma incondicional y SÍNCRONA al final de su propio
   * <script> — antes de que ESTE <script> (el bridge) llegue a ejecutarse.
   * No hay forma de interceptar esa llamada sin modificar circulo_v0.html
   * (fuera de alcance). Cuando había una sesión que restaurar, esa llamada
   * inicial ya disparó un fetch directo a Anthropic que esta función no
   * puede cancelar — solo puede garantizar que, en cuanto la hidratación
   * responda, el DOM y el estado conversacional queden en el valor
   * correcto, descartando lo que ese kickoff perdido haya escrito mientras
   * tanto. El mensaje de apertura de una sesión NUEVA nunca se ve afectado.
   */
  async function hidratarSesionAlCargar() {
    const storedId = leerSessionIdGuardado();
    if (!storedId) {
      // Sin puntero guardado: comportamiento explícito ya existente (sesión
      // nueva, kickoff normal, ya en curso). Solo falta guardar el puntero
      // de ESTA sesión para que un refresh futuro sí la encuentre.
      guardarSessionId(bridgeSession.id);
      return;
    }

    // Hay un puntero guardado: ESTA NO ES una sesión nueva, sin importar si
    // la hidratación termina en éxito o en fallo — así que kickoffState()
    // (ya disparado, ver nota de límite de diseño) NO debe poder registrar
    // un kickoff duplicado para una sesión que ya tenía el suyo. Se
    // restablece a false más abajo únicamente en la rama SESSION_NOT_FOUND,
    // que sí es, de verdad, una sesión nueva.
    kickoffYaCapturado = true;

    bridgeSession.id = storedId;
    window.__CIRCULO_SESSION_ID = storedId;

    const response = await apiRequest('GET', '/session/' + storedId + '/hydration');

    if (!response.ok) {
      if (response.error && response.error.code === 'SESSION_NOT_FOUND') {
        // El puntero guardado ya no corresponde a ninguna sesión real —
        // comportamiento explícito ya existente: arrancar una sesión nueva.
        olvidarSessionIdGuardado();
        bridgeSession.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        window.__CIRCULO_SESSION_ID = bridgeSession.id;
        guardarSessionId(bridgeSession.id);
        kickoffYaCapturado = false; // esta SÍ es una sesión nueva de verdad — su kickoff se captura normalmente
        return; // kickoffState() (ya en curso) sigue su camino normal
      }
      // Fallo técnico (red, servidor caído, etc.): nunca se borra memoria
      // local ni se crea otra sesión en silencio. kickoffYaCapturado se
      // queda en true — este mensaje de error no es un kickoff.
      console.warn('[Círculo Bridge] Fallo al hidratar sesión existente:', response.error);
      if (typeof window.addMsg === 'function')
        window.addMsg('circ', 'No pude recuperar tu conversación anterior. Puedes recargar para reintentar, o usar "Iniciar de nuevo" para empezar otra.');
      return;
    }

    // Éxito: la sesión existía de verdad — restaurar por completo,
    // descartando cualquier cosa que kickoffState() haya escrito mientras
    // tanto (ver nota de límite de diseño arriba). restaurada:true ANTES de
    // re-renderizar nada — señal adicional (además de kickoffYaCapturado,
    // ya true desde el principio de esta rama) de que ningún addMsg de aquí
    // en más debe reportarse como kickoff nuevo.
    bridgeSession.restaurada = true;

    const estadoVigente = response.session.estadoVigente;
    const transcript    = response.session.transcript || [];
    const kickoff        = response.session.kickoff || null;

    const idx = STATE_ORDER.indexOf(estadoVigente.gramaticaActiva);
    currentStateIdx = idx >= 0 ? idx : STATE_ORDER.length - 1; // gramaticaActiva null → las 5 ya cerraron
    understood = Object.assign({}, understood, estadoVigente.slots);
    finished  = estadoVigente.gramaticaActiva === null;
    userTurns = 0;
    history   = [];

    if (revealActivo) revealActivo.cancelar();
    if (typeof msgsEl !== 'undefined' && msgsEl) msgsEl.innerHTML = '';
    // Revelado progresivo: esto es HISTORIAL, no un mensaje nuevo — todo lo
    // que addMsg('circ', ...) renderice dentro de este bloque debe aparecer
    // completo, nunca animado. Se restablece a false apenas termina el
    // replay, nunca sobrevive más allá de este bloque.
    hidratandoHistorial = true;
    // El mensaje de apertura, si se capturó, va PRIMERO — es cronológicamente
    // anterior a cualquier Turno. Nunca se mezcla con el transcript (que
    // sigue viniendo solo de Turnos): es un campo aparte, renderizado aparte.
    if (kickoff && typeof addMsg === 'function') {
      addMsg('circ', kickoff.mensaje);
    }
    transcript.forEach(function(turno) {
      if (typeof addMsg === 'function') {
        addMsg('user', turno.mensajeExperto);
        addMsg('circ', turno.mensajeCirculo);
      }
      history.push({ role: 'user', content: turno.mensajeExperto });
      history.push({ role: 'assistant', content: turno.mensajeCirculo });
    });
    hidratandoHistorial = false;

    if (typeof updatePanel === 'function') updatePanel([]);
    if (typeof setStateUI === 'function') setStateUI();
    if (typeof updateTurnBadge === 'function') updateTurnBadge();
    if (typeof hideTyping === 'function') hideTyping();
    if (sendBtn) sendBtn.disabled = finished;

    if (estadoVigente.pipelineStatus === 'pending' || estadoVigente.pipelineStatus === 'ejecutando'
      || estadoVigente.pipelineStatus === 'completado') {
      esperarYRenderizarDownstream();
    }
  }

  /**
   * Botón "Iniciar de nuevo": inyectado por JS (no modifica circulo_v0.html).
   * Flotante, no interfiere con el layout existente.
   */
  function injectNuevaSesionButton() {
    const btn = document.createElement('button');
    btn.textContent = 'Iniciar de nuevo';
    btn.setAttribute('type', 'button');
    btn.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
      'padding:10px 16px', 'border-radius:8px', 'border:none',
      'background:#1f1f1f', 'color:#fff', 'font-size:14px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';');
    btn.addEventListener('click', () => initializeSession());
    document.body.appendChild(btn);
  }

  // ── Activar overrides ─────────────────────────────────────────────────────
  window.callAI         = callAIReplacement;
  window.onStateComplete = onStateCompleteDecorated;
  window.__CIRCULO_BRIDGE_ACTIVE = true;
  window.__CIRCULO_INICIAR_DE_NUEVO = initializeSession; // expuesto para depuración/tests
  window.__CIRCULO_HIDRATAR_AL_CARGAR = hidratarSesionAlCargar; // expuesto para tests (Incremento 7b)

  injectNuevaSesionButton();

  console.info('[Círculo Bridge] Activo — callAI + downstream interceptados. SessionId:', bridgeSession.id, '| API:', API_BASE);

  // Incremento 7b: intenta restaurar una sesión existente en cuanto el
  // bridge termina de cargar. Fire-and-forget deliberado — no bloquea el
  // resto de la carga de la página. La promesa queda expuesta (no para uso
  // en producción, sino para que un test pueda esperar a que esta ÚNICA
  // invocación automática termine, sin tener que disparar una segunda).
  window.__CIRCULO_HIDRATACION_INICIAL = hidratarSesionAlCargar();

  // Corrección de orden de arranque: el baseline (inmutable) termina su
  // propio <script> con una llamada SÍNCRONA e incondicional a
  // kickoffState() — eso ocurre mientras este <script> (el del bridge)
  // todavía ni empezó a parsearse, así que esa primera llamada usaba la
  // función callAI original del baseline (fetch directo a Anthropic) en
  // vez de callAIReplacement. build_bridge.js reemplaza esa invocación en
  // el artefacto generado por una asignación diferida
  // (window.__CIRCULO_KICKOFF_DIFERIDO = kickoffState — ver más abajo, no
  // se ejecuta ahí).
  //
  // Corrección D-041 (hallazgo del primer E2E público): esta llamada
  // diferida NO debe invocar window.__CIRCULO_KICKOFF_DIFERIDO() —esa
  // variable guarda la referencia CRUDA a la función original, capturada
  // por circulo_v0.html antes de que este bridge existiera, así que
  // llamarla directamente evita por completo la intercepción de la
  // bienvenida estática (D-034) instalada arriba en window.kickoffState.
  // callAI sí quedaba bien interceptado con la llamada cruda (por eso el
  // bug no se veía como un fetch directo a Anthropic, sino como un
  // POST /grammar-turn real de todos modos) — pero el saludo estático
  // nunca llegaba a evaluarse. Invocar window.kickoffState() en su lugar
  // pasa por el wrapper ya instalado arriba: bienvenida estática para una
  // sesión nueva, o el comportamiento original (vía _legacyKickoffState)
  // para cualquier otro caso — exactamente el mismo camino que ya usa
  // "Iniciar de nuevo", sin duplicar lógica.
  // Misma razón que window.__CIRCULO_HIDRATACION_INICIAL arriba: se expone
  // la promesa únicamente para que un test pueda esperar a que esta ÚNICA
  // invocación diferida termine, sin disparar una segunda.
  if (typeof window.__CIRCULO_KICKOFF_DIFERIDO === 'function') {
    window.__CIRCULO_KICKOFF_INICIAL = window.kickoffState();
  }

})();
</script>
`;

// ── Experience Shell v1 (ver Project OS/ADR-Experience-Shell-v1.md) ────────────
// Capa de presentación puramente visual sobre el Círculo ya validado (D-041).
// No toca circulo_v0.html, el motor, el pipeline ni las gramáticas — no lee ni
// escribe ningún estado del bridge, no llama a fetch, no decora ninguna función
// del baseline todavía. Commit estructural: cuatro áreas vacías, navegación
// funcional, encabezado persistente, responsive básico. Reversible: retirar
// este bloque completo (constante + su inserción en el ensamblado del
// artefacto, más abajo) devuelve el Alpha a su presentación original sin
// ningún otro cambio, en cualquier momento.
const EXPERIENCE_SHELL_SCRIPT = `
<!-- ═══════════════════════════════════════════════════════════════════════════
     CÍRCULO EXPERIENCE SHELL v1 — capa de presentación (ADR-Experience-Shell-v1)
     Proyecta el Círculo existente; no lo reemplaza. Ver ADR para las 7
     decisiones que gobiernan este bloque. Generado por build_bridge.js.
     ══════════════════════════════════════════════════════════════════════════ -->
<style>
  /* La UI original de circulo_v0.html sigue existiendo e intacta — solo se
     oculta visualmente (D-ES5 del ADR: nunca se le miente sobre su DOM). */
  body > .shell { display: none !important; }

  /* 100vh en navegadores móviles (Safari/Chrome iOS y Android) incluye el
     espacio de la barra de direcciones aunque no esté siendo mostrado en ese
     instante — el shell terminaba más alto que el viewport real y visible,
     empujando el navbar inferior (en flujo normal, no fijo) fuera de vista.
     100dvh usa la altura visible dinámica real; 100vh queda como fallback
     para navegadores sin soporte, sin efecto donde dvh sí existe. */
  .ces-root{ position:fixed; inset:0; z-index:2; display:flex; flex-direction:column; height:100vh; height:100dvh; background:var(--bg); color:var(--ink); font-family:'Space Grotesk',sans-serif; }
  .ces-header{ display:flex; align-items:center; justify-content:space-between; padding:14px 22px; border-bottom:1px solid var(--line); flex-shrink:0; }
  .ces-brand{ font-family:'Fraunces',serif; font-weight:600; font-size:16px; }
  .ces-project{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); font-weight:600; }

  .ces-body{ flex:1; min-height:0; display:flex; }
  .ces-nav{ display:flex; flex-direction:column; gap:2px; padding:14px 10px; border-right:1px solid var(--line); flex-shrink:0; width:180px; }
  .ces-tab{ text-align:left; background:none; border:none; color:var(--ink-dim); font-family:'Space Grotesk',sans-serif; font-size:13.5px; font-weight:500; padding:10px 12px; border-radius:10px; cursor:pointer; transition:all .2s ease; }
  .ces-tab:hover{ background:var(--panel); color:var(--ink); }
  .ces-tab.active{ background:var(--grad); color:#0c1320; font-weight:600; }

  .ces-panels{ flex:1; min-width:0; overflow-y:auto; position:relative; }
  .ces-panel{ display:none; padding:28px; box-sizing:border-box; min-height:100%; }
  .ces-panel.active{ display:block; }
  .ces-placeholder{ color:var(--ink-faint); font-size:13px; }

  /* Conversación: #msgs y .compose (originales, reubicados — ver D-ES5 del
     ADR) necesitan que su panel sea una columna flex de altura completa, sin
     el padding/scroll genérico de .ces-panel — son ellos quienes ya traen su
     propio padding y su propio overflow-y, tal como en circulo_v0.html. */
  .ces-panel[data-panel="conversacion"]{ padding:0; display:none; flex-direction:column; height:100%; overflow:hidden; }
  .ces-panel[data-panel="conversacion"].active{ display:flex; }

  /* Construcción: los 5 <div class="panel-section"> originales (y sus
     .under-item internos) se reubican tal cual — su propio CSS ya definido
     en circulo_v0.html sigue aplicando sin cambios. Solo se envuelve cada
     uno con un encabezado nuevo (nombre de la gramática + estado) para dar
     la jerarquía mínima que pidió el producto, sin tocar updatePanel() ni
     inventar contenido: el estado se deriva en vivo de currentStateIdx, el
     resto es exactamente lo que el motor ya entendió. */
  .ces-construccion-titulo{ font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-faint); font-weight:600; margin-bottom:18px; }
  .ces-construccion-grupo{ margin-bottom:24px; }
  .ces-construccion-grupo-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
  .ces-construccion-grupo-nombre{ font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--purple); font-weight:600; }
  .ces-construccion-grupo-estado{ font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; font-weight:600; padding:3px 9px; border-radius:100px; border:1px solid var(--line); color:var(--ink-faint); }
  .ces-construccion-grupo-estado.ces-progreso{ color:var(--cyan); border-color:rgba(51,209,253,.4); }
  .ces-construccion-grupo-estado.ces-completado{ color:var(--ok); border-color:rgba(74,222,128,.35); }
  #doneBanner.show{ margin-bottom:22px; }

  /* "Iniciar de nuevo" — iteración de UX móvil: deja de flotar sobre el
     contenido (el botón original, con position:fixed inline, vivía suelto
     sobre cualquier pantalla) y pasa a ser un control real del header —
     mismo nodo, nunca una copia (ver script de montaje más abajo, que
     limpia su estilo inline y lo reubica). Etiqueta visible conservada tal
     cual ("Iniciar de nuevo"), nunca un ícono ambiguo. min-height 44px:
     área táctil mínima recomendada, no una aproximación. */
  .ces-header-restart{
    display:inline-flex; align-items:center; justify-content:center;
    background:none; border:1px solid var(--line); border-radius:8px;
    color:var(--ink-dim); font-family:'Space Grotesk',sans-serif;
    font-size:12.5px; font-weight:600; padding:8px 14px; min-height:44px;
    box-sizing:border-box; cursor:pointer; transition:all .2s ease; flex-shrink:0;
  }
  .ces-header-restart:hover{ background:var(--panel); color:var(--ink); }

  /* #msgs es, desde D-ES5, el único contenedor que de verdad necesita
     scroll dentro de Conversación — overscroll-behavior:contain evita que
     su scroll "encadene" al documento exterior (que nunca debe moverse
     mientras se conversa) y reduce el rebote que se sentía inestable. Suma
     pura, nunca reemplaza el overflow-y:auto ya definido en circulo_v0.html. */
  #msgs{ overscroll-behavior: contain; }

  @media (max-width:800px){
    .ces-body{ flex-direction:column; }
    /* sticky + fondo propio: con la altura ya corregida (100dvh) el navbar
       queda al final del flujo de todos modos, pero sticky lo blinda contra
       cualquier desbordamiento futuro del contenido — nunca se desplaza
       fuera de vista ni queda debajo del contenido. env(safe-area-inset-bottom)
       respeta el home indicator de iOS. */
    .ces-nav{ flex-direction:row; width:auto; order:2; flex-shrink:0; border-right:none; border-top:1px solid var(--line); padding:8px 8px calc(8px + env(safe-area-inset-bottom)); justify-content:space-around; position:sticky; bottom:0; background:var(--bg); z-index:1; }
    .ces-tab{ text-align:center; flex:1; }
    .ces-panels{ order:1; overflow-y:auto; }

    /* Estados de presentación derivados de señales reales (ver script de
       montaje) — nunca una lista creciente de casos especiales. Las tres
       reglas de abajo son la ÚNICA consecuencia visual de esos dos
       estados; toda la lógica de CUÁNDO se activan vive en JS, una sola
       vez, nunca repetida por regla. */

    /* Header compacto mientras se conversa: la etiqueta de proyecto no
       aporta nada en el momento de escribir — se retira, nunca se encoge
       a algo ilegible. El control de reinicio permanece siempre visible. */
    html.ces-conversation-active .ces-project{ display:none; }

    /* El teclado y una barra de navegación inferior nunca deben competir
       por la misma franja de pantalla — mientras el teclado está visible,
       el navbar se retira por completo (nunca se encoge ni se solapa). */
    html.ces-keyboard-visible .ces-nav{ display:none; }

    /* Mientras se conversa, el scroll pertenece EXCLUSIVAMENTE a #msgs —
       .ces-panels (el contenedor compartido de las 4 pestañas) nunca debe
       convertirse en un segundo scroll simultáneo. Las otras 3 pestañas
       conservan su overflow-y:auto normal, sin cambios. */
    html.ces-conversation-active .ces-panels{ overflow:hidden; }
  }
</style>
<div class="ces-root" id="cesRoot">
  <div class="ces-header">
    <div class="ces-brand">Círculo</div>
    <div class="ces-project" id="cesProjectLabel">Proyecto</div>
  </div>
  <div class="ces-body">
    <nav class="ces-nav" id="cesNav">
      <button class="ces-tab" data-tab="inicio" type="button">Inicio</button>
      <button class="ces-tab active" data-tab="conversacion" type="button">Conversación</button>
      <button class="ces-tab" data-tab="construccion" type="button">Construcción</button>
      <button class="ces-tab" data-tab="producto" type="button">Producto</button>
    </nav>
    <main class="ces-panels" id="cesPanels">
      <section class="ces-panel" data-panel="inicio"><div class="ces-placeholder">Inicio — pendiente de diseño (ver ADR-Experience-Shell-v1).</div></section>
      <section class="ces-panel active" data-panel="conversacion"></section>
      <section class="ces-panel" data-panel="construccion"></section>
      <section class="ces-panel" data-panel="producto"><div class="ces-placeholder">Producto — sin conectar todavía.</div></section>
    </main>
  </div>
</div>
<script>
(function(){
  'use strict';

  // ── Iteración de UX móvil — estado de presentación derivado de señales
  // reales, nunca una lista creciente de casos especiales (ver Project OS).
  // Dos clases en <html>: ces-conversation-active y ces-keyboard-visible.
  // Toda la presentación (header compacto, navbar oculto, scroll exclusivo
  // de #msgs — ver <style> arriba) se deriva de estas dos, en un solo
  // lugar cada una. Nunca toca addMsg, hidratación, revelado progresivo,
  // ni ninguna lógica de gramáticas — es puramente presentación. ──
  var htmlEl = document.documentElement;
  function setConversationActive(v) { htmlEl.classList.toggle('ces-conversation-active', v); }
  function setKeyboardVisible(v) {
    if (htmlEl.classList.contains('ces-keyboard-visible') === v) return;
    htmlEl.classList.toggle('ces-keyboard-visible', v);
    // Al cambiar el teclado (abrir O cerrar) el alto disponible cambió — el
    // mensaje más reciente debe seguir siendo el último visible, tanto si
    // el teclado acaba de tapar espacio como si acaba de liberarlo.
    var msgsEl2 = document.getElementById('msgs');
    if (msgsEl2) msgsEl2.scrollTop = msgsEl2.scrollHeight;
  }

  // Navegación pura: sin estado propio más allá de conversation-active, sin
  // fetch, sin leer ni decorar ninguna función del baseline/bridge
  // (D-ES3/D-ES4 del ADR). Cambiar de pestaña solo alterna qué <section> es
  // visible y sincroniza ces-conversation-active.
  var tabs = document.querySelectorAll('#cesNav .ces-tab');
  var panels = document.querySelectorAll('#cesPanels .ces-panel');
  tabs.forEach(function(tab){
    tab.addEventListener('click', function(){
      tabs.forEach(function(t){ t.classList.remove('active'); });
      panels.forEach(function(p){ p.classList.remove('active'); });
      tab.classList.add('active');
      var target = document.querySelector('#cesPanels .ces-panel[data-panel="' + tab.getAttribute('data-tab') + '"]');
      if (target) target.classList.add('active');
      setConversationActive(tab.getAttribute('data-tab') === 'conversacion');
    });
  });
  // Estado inicial: Conversación ya nace activa en el markup (ver arriba).
  setConversationActive(true);

  // ── Detección de teclado: el foco es la señal INMEDIATA y optimista
  // (respuesta instantánea al tocar el campo); window.visualViewport, si
  // existe, es la fuente de verdad real y manda apenas mide algo — nunca
  // al revés. Sin visualViewport, foco/blur queda como única señal
  // disponible. Tolera: teclado abierto; teclado cerrado con el input
  // todavía enfocado (lo resuelve la medición real, no el blur); scroll
  // con el teclado abierto (también se escucha 'scroll' de vv, que Safari
  // a veces dispara en vez de 'resize'); barras de Safari y orientación
  // (recalibran la referencia de reposo cada vez que NO hay teclado, en
  // vez de acumular casos especiales); dispositivos sin visualViewport
  // (fallback a foco/blur puro); teclado externo (no achica el viewport
  // real — la siguiente medición real lo corrige solo, aunque puede haber
  // un instante brevísimo de falso positivo tras el foco). ──
  var vv = window.visualViewport || null;
  var alturaReposo = vv ? vv.height : window.innerHeight;
  var UMBRAL_TECLADO_PX = 120; // una barra de Safari cambia menos que esto; un teclado real, mucho más
  function medirViewportReal() {
    if (!vv) return;
    var reduccion = alturaReposo - vv.height;
    if (reduccion > UMBRAL_TECLADO_PX) {
      setKeyboardVisible(true);
    } else {
      setKeyboardVisible(false);
      alturaReposo = vv.height; // sin teclado: ESTA es la nueva referencia de reposo — absorbe orientación/barras de Safari
    }
  }
  if (vv) {
    vv.addEventListener('resize', medirViewportReal);
    vv.addEventListener('scroll', medirViewportReal);
  }
  var composeInputEl = document.getElementById('inp');
  if (composeInputEl) {
    composeInputEl.addEventListener('focus', function(){ setKeyboardVisible(true); });
    composeInputEl.addEventListener('blur', function(){
      // Con visualViewport disponible, blur NUNCA decide por sí solo — si
      // el teclado de verdad cerró, la próxima medición real lo confirma
      // (incluso si el usuario lo cerró sin perder el foco, por gesto del
      // sistema). Sin la API, es la única señal que queda: se confía tal cual.
      if (!vv) setKeyboardVisible(false);
    });
  }

  // ── "Iniciar de nuevo": reubicación real al header (nunca una copia —
  // mismo nodo que injectNuevaSesionButton() ya creó, nunca se toca esa
  // función) + confirmación, que antes no existía para una acción
  // destructiva sin deshacer. El listener de confirmación se registra en
  // document, fase de captura: así corre ANTES que el listener original
  // del botón (que sigue intacto, en fase de burbuja) y puede bloquearlo
  // con stopPropagation — sin necesitar tocar ni conocer ese listener. ──
  var restartBtn = Array.prototype.find.call(document.body.children, function(el){
    return el.tagName === 'BUTTON' && el.textContent.trim() === 'Iniciar de nuevo';
  });
  if (restartBtn) {
    restartBtn.removeAttribute('style'); // limpia el position:fixed inline original — ahora vive en el header
    restartBtn.className = 'ces-header-restart';
    restartBtn.setAttribute('aria-label', 'Iniciar de nuevo — se perderá la conversación actual');
    var cesHeaderEl = document.querySelector('.ces-header');
    if (cesHeaderEl) cesHeaderEl.appendChild(restartBtn);
    document.addEventListener('click', function(ev){
      if (ev.target !== restartBtn) return;
      if (!window.confirm('¿Iniciar una conversación nueva? Se perderá el progreso actual.')) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, true);
  }

  // ── Conversación (D-ES5, revisión) ────────────────────────────────────
  // Reubicación PERMANENTE del contenedor original — nunca una copia
  // derivada. #msgs y .compose dejan de vivir dentro de .shell (oculto) y
  // pasan a ser, físicamente, el panel de Conversación. Como siguen siendo
  // los mismos elementos reales de siempre, esto preserva sin ningún caso
  // especial el saludo síncrono de DESTINO (D-041), la hidratación
  // (incluido su innerHTML='' + rerender), el scroll y el indicador de
  // escritura — todos ya asumían que #msgs es un elemento real y
  // persistente, y eso sigue siendo cierto. Se ejecuta una sola vez, al
  // montar el shell — nunca en cada mensaje.
  var conversacionPanel = document.querySelector('#cesPanels [data-panel="conversacion"]');
  var legacyMsgs = document.getElementById('msgs');
  var legacyCompose = document.querySelector('.shell .compose');
  if (conversacionPanel && legacyMsgs && legacyCompose) {
    conversacionPanel.appendChild(legacyMsgs);
    conversacionPanel.appendChild(legacyCompose);
  }

  // Mientras el panel de Conversación está oculto (display:none), el
  // navegador no calcula su layout — un scrollTop asignado en ese momento
  // (p.ej. por un mensaje recibido con otra pestaña activa) puede no
  // reflejarse. Al volver a esta pestaña, se reafirma el scroll al final.
  var conversacionTab = document.querySelector('#cesNav .ces-tab[data-tab="conversacion"]');
  if (conversacionTab) {
    conversacionTab.addEventListener('click', function(){
      if (legacyMsgs) legacyMsgs.scrollTop = legacyMsgs.scrollHeight;
    });
  }

  // ── Construcción ────────────────────────────────────────────────────
  // Misma estrategia que Construcción usa desde siempre en el ADR: los 5
  // <div class="panel-section" id="panel-<gramatica>"> ya eran contenedores
  // propios, separados de #msgs desde el baseline — se reubican tal cual,
  // una sola vez. updatePanel() sigue siendo la única fuente que escribe
  // sus valores (nunca se lee/reconstruye "understood" aquí); esto solo
  // envuelve cada sección con un encabezado (nombre + estado) para dar
  // jerarquía, sin inventar ningún dato: el estado se deriva en vivo de
  // currentStateIdx (variable real del baseline), nunca de una copia.
  var construccionPanel = document.querySelector('#cesPanels [data-panel="construccion"]');
  var legacyPanel = document.querySelector('.shell .panel');
  var legacyDoneBanner = document.getElementById('doneBanner');
  var NOMBRES_GRAMATICA = { destino:'Destino', destilar:'Destilar', traducir:'Traducir', ascenso:'Ascenso', darvida:'Dar Vida' };

  if (construccionPanel && legacyPanel) {
    var secciones = Array.prototype.slice.call(legacyPanel.querySelectorAll('.panel-section'));

    if (legacyDoneBanner) construccionPanel.appendChild(legacyDoneBanner);

    var titulo = document.createElement('div');
    titulo.className = 'ces-construccion-titulo';
    // Texto reutilizado tal cual de circulo_v0.html (.panel-title) — no se
    // redacta copy nueva para esta capa de presentación.
    titulo.textContent = 'Lo que estamos descubriendo';
    construccionPanel.appendChild(titulo);

    secciones.forEach(function(section){
      var gramaticaId = section.id.replace('panel-', '');
      var grupo = document.createElement('div');
      grupo.className = 'ces-construccion-grupo';

      var head = document.createElement('div');
      head.className = 'ces-construccion-grupo-head';
      var nombre = document.createElement('span');
      nombre.className = 'ces-construccion-grupo-nombre';
      nombre.textContent = NOMBRES_GRAMATICA[gramaticaId] || gramaticaId;
      var estado = document.createElement('span');
      estado.className = 'ces-construccion-grupo-estado';
      estado.setAttribute('data-gramatica', gramaticaId);
      head.appendChild(nombre);
      head.appendChild(estado);

      grupo.appendChild(head);
      grupo.appendChild(section); // reubica la sección real, nunca la clona
      construccionPanel.appendChild(grupo);
    });
  }

  // Deriva Completado/En progreso/Pendiente de currentStateIdx (variable
  // real y viva del baseline, ver STATE_ORDER en circulo_v0.html) — nunca
  // de un estado propio del shell. Se recalcula, nunca se guarda.
  function actualizarEstadosConstruccion(){
    if (typeof currentStateIdx === 'undefined' || typeof STATE_ORDER === 'undefined') return;
    var tags = construccionPanel ? construccionPanel.querySelectorAll('.ces-construccion-grupo-estado') : [];
    tags.forEach(function(tag){
      var idx = STATE_ORDER.indexOf(tag.getAttribute('data-gramatica'));
      tag.classList.remove('ces-progreso', 'ces-completado');
      if (idx < currentStateIdx) { tag.textContent = 'Completado'; tag.classList.add('ces-completado'); }
      else if (idx === currentStateIdx) { tag.textContent = 'En progreso'; tag.classList.add('ces-progreso'); }
      else { tag.textContent = 'Pendiente'; }
    });
  }
  actualizarEstadosConstruccion();

  // setStateUI() (baseline, intocada) ya corre cada vez que la gramática
  // activa cambia visualmente — kickoff, transición, hidratación,
  // "Iniciar de nuevo". Se decora (nunca se reemplaza, mismo patrón que
  // addMsg/onStateComplete/kickoffState en el bridge) para refrescar los
  // estados de Construcción en el mismo momento, sin un segundo mecanismo
  // de detección de cambios.
  if (typeof window.setStateUI === 'function') {
    var _setStateUIPreShell = window.setStateUI;
    window.setStateUI = function(){
      _setStateUIPreShell.apply(this, arguments);
      actualizarEstadosConstruccion();
    };
  }
})();
</script>
<!-- ═══ FIN CÍRCULO EXPERIENCE SHELL v1 ═══ -->
`;

// ── Generación del artefacto ───────────────────────────────────────────────────

const baseline = fs.readFileSync(SRC, 'utf8');

if (!baseline.includes('</body>')) {
  console.error('ERROR: circulo_v0.html no contiene </body>');
  process.exit(1);
}

// Corrección de orden de arranque (ver nota en BRIDGE_SCRIPT más arriba):
// el baseline termina su <script> con una llamada síncrona e incondicional
// a kickoffState(), que se ejecuta antes de que el <script> del bridge
// exista en el documento. Se reemplaza ÚNICAMENTE esa invocación —nunca
// circulo_v0.html en disco, solo el texto en memoria que se escribe como
// artefacto— por una asignación diferida a window.__CIRCULO_KICKOFF_DIFERIDO,
// que el propio bridge invoca una vez que termina de instalar sus overrides.
// setStateUI() y el resto del baseline quedan intactos. No es una segunda
// definición de kickoffState — es la misma función, invocada más tarde.
const KICKOFF_AUTOSTART_ORIGINAL = 'setStateUI();\nkickoffState();\n</script>';
const KICKOFF_AUTOSTART_DIFERIDO = 'setStateUI();\nwindow.__CIRCULO_KICKOFF_DIFERIDO = kickoffState;\n</script>';

if (baseline.split(KICKOFF_AUTOSTART_ORIGINAL).length - 1 !== 1) {
  console.error('ERROR: no se encontró (o se encontró más de una vez) el autoarranque esperado de kickoffState() en circulo_v0.html — build_bridge.js no puede diferirlo de forma segura.');
  process.exit(1);
}

const baselineConKickoffDiferido = baseline.replace(KICKOFF_AUTOSTART_ORIGINAL, KICKOFF_AUTOSTART_DIFERIDO);

/**
 * Construye y escribe un artefacto a partir del MISMO baseline (con el
 * kickoff ya diferido) — nunca una segunda copia de esta lógica. `scripts`
 * es el bloque (o la concatenación de bloques) que se inyecta antes de
 * </body>. La única diferencia entre el laboratorio y el Shell es QUÉ
 * scripts se pasan aquí — nunca una reimplementación paralela del bridge,
 * de /grammar-turn, de la hidratación, de addMsg, del revelado progresivo
 * ni de ninguna lógica conversacional: todo eso vive exclusivamente en
 * BRIDGE_SCRIPT, compartido por ambos artefactos sin excepción.
 */
function construirArtefacto(destPath, scripts) {
  const output = baselineConKickoffDiferido.replace('</body>', scripts + '\n</body>');
  fs.writeFileSync(destPath, output, 'utf8');
  return output;
}

const outputRaw = construirArtefacto(DEST_RAW, BRIDGE_SCRIPT);
const outputApp = construirArtefacto(DEST_APP, BRIDGE_SCRIPT + '\n' + EXPERIENCE_SHELL_SCRIPT);

const baselineHash = crypto.createHash('md5').update(baseline).digest('hex');
const rawHash = crypto.createHash('md5').update(outputRaw).digest('hex');
const appHash = crypto.createHash('md5').update(outputApp).digest('hex');

console.log('✓ Artefactos generados (un solo motor, dos superficies):');
console.log('  Laboratorio (raw):', DEST_RAW);
console.log('    MD5:', rawHash, '|', outputRaw.length - baseline.length, 'bytes añadidos sobre el baseline');
console.log('  Experience Shell (app):', DEST_APP);
console.log('    MD5:', appHash, '|', outputApp.length - baseline.length, 'bytes añadidos sobre el baseline');
console.log('  Baseline MD5:  ', baselineHash);
console.log('  API base URL:  ', API_BASE_URL);

const currentBaseline = fs.readFileSync(SRC, 'utf8');
if (crypto.createHash('md5').update(currentBaseline).digest('hex') !== baselineHash) {
  console.error('ERROR: circulo_v0.html fue modificado durante la generación');
  process.exit(1);
}
console.log('✓ circulo_v0.html intacto (MD5 verificado)');
