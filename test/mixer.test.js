/**
 * mixer.test.js - Banco de pruebas de audio-mixer.js
 *
 * Ejecuta el mixer real dentro de un contexto VM con implementaciones
 * simuladas de WebRTC y Web Audio, y verifica las invariantes que hacen
 * que el PARTICIPANTE REMOTO reciba audio.
 *
 * IMPORTANTE: cada entorno construye SUS PROPIAS clases simuladas. El mixer
 * parchea prototipos (RTCPeerConnection.prototype.addTrack, etc.); si las
 * clases se compartieran entre pruebas, los mixers de pruebas anteriores
 * quedarían encadenados y contaminarían los resultados.
 *
 * Uso:  node test/mixer.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const MIXER_SRC = fs.readFileSync(path.join(__dirname, '..', 'audio-mixer.js'), 'utf8');

let trackSeq = 0;

// ════════════════════════════════════════════════════════════════════
// Entorno aislado: WebRTC + Web Audio simulados
// ════════════════════════════════════════════════════════════════════

function createEnvironment() {

  class FakeTrack {
    constructor(kind, label) {
      this.kind = kind;
      this.label = label || 'fake';
      this.id = 'track-' + (++trackSeq);
      this.readyState = 'live';
      this.enabled = true;
      this.muted = false;
    }
    clone() { return new FakeTrack(this.kind, this.label); }
    stop() { this.readyState = 'ended'; }
  }

  class FakeMediaStream {
    constructor(tracks = []) { this._tracks = tracks.slice(); }
    addTrack(t) { this._tracks.push(t); }
    getTracks() { return this._tracks.slice(); }
    getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
  }

  class FakeAudioNode {
    constructor(ctx, type) { this.ctx = ctx; this.type = type; this._out = []; }
    connect(node) { this._out.push(node); return node; }
    disconnect() { this._out = []; }
  }

  class FakeGainNode extends FakeAudioNode {
    constructor(ctx) {
      super(ctx, 'gain');
      const self = this;
      this.gain = { value: 1, setValueAtTime(v) { self.gain.value = v; } };
    }
  }

  class FakeBufferSource extends FakeAudioNode {
    constructor(ctx) { super(ctx, 'bufferSource'); this.buffer = null; }
    start(when) { this.ctx._starts.push({ when, osc: false }); }
    stop() {}
  }

  class FakeOscillator extends FakeAudioNode {
    constructor(ctx) {
      super(ctx, 'oscillator');
      this.frequency = { value: 0 };
      this.type = 'sine';
    }
    start(when) { this.ctx._starts.push({ when, osc: true }); }
    stop() {}
  }

  const contexts = [];

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this._time = 0;
      this._starts = [];
      this.destination = new FakeAudioNode(this, 'destination');
      contexts.push(this);
    }
    get currentTime() { return this._time; }
    createMediaStreamDestination() {
      const node = new FakeAudioNode(this, 'mediaStreamDestination');
      node.stream = new FakeMediaStream([new FakeTrack('audio', 'mixer-dest')]);
      return node;
    }
    createGain() { return new FakeGainNode(this); }
    createAnalyser() {
      const n = new FakeAudioNode(this, 'analyser');
      n.fftSize = 512;
      n.frequencyBinCount = 256;
      n.getByteFrequencyData = (arr) => arr.fill(0);
      return n;
    }
    createMediaStreamSource(stream) {
      if (!stream || stream.getAudioTracks().length === 0) {
        throw new Error('createMediaStreamSource: stream sin pistas de audio');
      }
      const n = new FakeAudioNode(this, 'mediaStreamSource');
      n.stream = stream;
      return n;
    }
    createBufferSource() { return new FakeBufferSource(this); }
    createOscillator() { return new FakeOscillator(this); }
    // 1000 bytes = 1 segundo de audio simulado
    decodeAudioData(arrayBuffer) {
      return Promise.resolve({ duration: arrayBuffer.byteLength / 1000 });
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  class FakeRTCRtpSender {
    constructor(track) { this._track = track; }
    replaceTrack(track) { this._track = track; return Promise.resolve(); }
  }
  Object.defineProperty(FakeRTCRtpSender.prototype, 'track', {
    get() { return this._track; },
    configurable: true
  });

  class FakeRTCPeerConnection {
    constructor() {
      this._senders = [];
      this.connectionState = 'connected';
      this.signalingState = 'stable';
    }
    addTrack(track) {
      const s = new FakeRTCRtpSender(track);
      this._senders.push(s);
      return s;
    }
    addTransceiver(trackOrKind) {
      const track = typeof trackOrKind === 'string' ? null : trackOrKind;
      const s = new FakeRTCRtpSender(track);
      this._senders.push(s);
      return { sender: s, receiver: {}, direction: 'sendrecv' };
    }
    getSenders() { return this._senders.slice(); }
  }

  const listeners = { message: [] };
  const posted = [];
  const intervals = [];
  const micTracksEntregados = [];

  const win = {
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    postMessage(data) {
      posted.push(data);
      // Reentrega a los oyentes, igual que el bucle de eventos del navegador
      for (const fn of listeners.message.slice()) fn({ source: win, data });
    }
  };

  const sandbox = {
    window: win,
    console: { log() {}, warn() {}, error() {} },
    MediaStream: FakeMediaStream,
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCRtpSender: FakeRTCRtpSender,
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          const tracks = [];
          if (constraints && constraints.audio) {
            const t = new FakeTrack('audio', 'microfono-fisico');
            micTracksEntregados.push(t);
            tracks.push(t);
          }
          if (constraints && constraints.video) tracks.push(new FakeTrack('video', 'camara'));
          return new FakeMediaStream(tracks);
        }
      }
    },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    setTimeout,
    Promise, Array, Object, Math, Error, Set, Map, Uint8Array, ArrayBuffer
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return {
    sandbox,
    posted,
    FakeTrack,
    micTracksEntregados,
    load() { vm.runInContext(MIXER_SRC, sandbox); },
    gum(constraints) { return sandbox.navigator.mediaDevices.getUserMedia(constraints); },
    newPeerConnection() { return new sandbox.RTCPeerConnection(); },
    // Dispara el watchdog manualmente (setInterval está simulado)
    tickWatchdog() { intervals.forEach(fn => fn()); },
    send(data) {
      for (const fn of listeners.message.slice()) fn({ source: win, data });
    },
    audioContext() {
      assert.ok(contexts.length, 'el mixer nunca creó un AudioContext');
      return contexts[contexts.length - 1];
    },
    statuses() {
      return posted.filter(m => m.type === 'MT_MIXER_STATUS_UPDATE').map(m => m.status);
    },
    lastReport() {
      const r = posted.filter(m => m.type === 'MT_MIXER_DIAG_RESULT').pop();
      assert.ok(r, 'no se recibió MT_MIXER_DIAG_RESULT');
      return r.report;
    },
    async diag() {
      this.send({ type: 'MT_MIXER_DIAG' });
      await flush();
      return this.lastReport();
    }
  };
}

const flush = () => new Promise(r => setTimeout(r, 5));

// ════════════════════════════════════════════════════════════════════
// Pruebas
// ════════════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('una segunda carga del script no instala un segundo mixer', async () => {
  const env = createEnvironment();
  env.load();
  const gumTrasPrimera = env.sandbox.navigator.mediaDevices.getUserMedia;

  env.load(); // segunda inyección (el bug de la doble instancia)

  assert.strictEqual(
    env.sandbox.navigator.mediaDevices.getUserMedia,
    gumTrasPrimera,
    'la segunda carga volvió a parchear getUserMedia: hay dos mixers anidados'
  );
});

test('getUserMedia entrega un clone, nunca el track base del mixer', async () => {
  const env = createEnvironment();
  env.load();

  const s1 = await env.gum({ audio: true });
  const s2 = await env.gum({ audio: true });

  const t1 = s1.getAudioTracks()[0];
  const t2 = s2.getAudioTracks()[0];

  assert.ok(t1, 'la primera llamada no devolvió pista de audio');
  assert.notStrictEqual(t1, t2, 'se entregó el MISMO objeto track en dos llamadas');
  assert.strictEqual(t1.readyState, 'live');
  assert.strictEqual(t2.readyState, 'live');
});

test('REGRESIÓN: que Meet detenga el stream de la sala de espera no deja mudo al receptor', async () => {
  const env = createEnvironment();
  env.load();

  // Sala de espera: Meet pide el micrófono...
  const salaDeEspera = await env.gum({ audio: true, video: true });
  // ...y al entrar a la llamada detiene TODO ese stream.
  salaDeEspera.getTracks().forEach(t => t.stop());

  // Meet vuelve a pedir el micrófono ya dentro de la reunión.
  const enLlamada = await env.gum({ audio: true });
  const track = enLlamada.getAudioTracks()[0];

  assert.ok(track, 'la segunda llamada no devolvió pista de audio');
  assert.strictEqual(
    track.readyState,
    'live',
    'el track entregado tras el stop() está muerto: el receptor no oiría NADA en toda la llamada'
  );
});

test('el vídeo de la cámara pasa intacto al stream virtual', async () => {
  const env = createEnvironment();
  env.load();

  const stream = await env.gum({ audio: true, video: true });
  assert.strictEqual(stream.getVideoTracks().length, 1, 'se perdió la pista de vídeo');
  assert.strictEqual(stream.getAudioTracks().length, 1);
});

test('addTrack coloca el mixer en el sender, no el micrófono crudo', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const micCrudo = new env.FakeTrack('audio', 'micro-crudo');
  const sender = pc.addTrack(micCrudo);

  assert.notStrictEqual(sender._track, micCrudo, 'el sender lleva el micrófono crudo: el TTS no llega al receptor');
  assert.strictEqual(sender._track.kind, 'audio');
  assert.strictEqual(sender._track.readyState, 'live');
});

test('addTransceiver con un track de audio también recibe el mixer', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const micCrudo = new env.FakeTrack('audio', 'micro-crudo');
  const { sender } = pc.addTransceiver(micCrudo);

  assert.notStrictEqual(sender._track, micCrudo, 'addTransceiver dejó pasar el micrófono crudo');
  assert.strictEqual(sender._track.readyState, 'live');
});

test('replaceTrack de la página no expulsa al mixer del camino WebRTC', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const sender = pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));

  // Meet cambia de dispositivo / reconecta y reinstala su micrófono
  const otroMicrofono = new env.FakeTrack('audio', 'otro-microfono');
  await sender.replaceTrack(otroMicrofono);

  assert.notStrictEqual(sender._track, otroMicrofono, 'Meet sacó el mixer del sender con replaceTrack');
  assert.strictEqual(sender._track.kind, 'audio');
  assert.strictEqual(sender._track.readyState, 'live');
});

test('replaceTrack(null) se respeta: silenciar de verdad sigue funcionando', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const sender = pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));

  await sender.replaceTrack(null);
  assert.strictEqual(sender._track, null, 'el mixer impidió que la página silenciara el sender');
});

test('el watchdog re-afirma el mixer si algo lo saca del sender', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const sender = pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));

  // Alguien esquiva el parche y escribe el track directamente
  const intruso = new env.FakeTrack('audio', 'intruso');
  sender._track = intruso;

  env.tickWatchdog();
  await flush();

  assert.notStrictEqual(sender._track, intruso, 'el watchdog no recuperó el sender');
  assert.strictEqual(sender._track.readyState, 'live');
});

test('el watchdog reconstruye el mixer si su track base muere', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const sender = pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));

  const antes = await env.diag();
  // Matar el track base del mixer
  env.audioContext();
  sender._track.stop();

  env.tickWatchdog();
  await flush();

  const despues = await env.diag();
  assert.strictEqual(despues.mixerTrack.readyState, 'live', 'el mixer quedó con un track muerto');
  assert.ok(despues.contadores.watchdogReasserts >= 1 || despues.contadores.mixerRebuilds > antes.contadores.mixerRebuilds,
    'el watchdog no reaccionó al track muerto');
});

test('los fragmentos TTS se agendan en secuencia, sin solaparse', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  // 2000 bytes = 2s, 3000 bytes = 3s, 1500 bytes = 1.5s
  const buffers = [new ArrayBuffer(2000), new ArrayBuffer(3000), new ArrayBuffer(1500)];
  env.send({ type: 'MT_PLAY_TTS_INTO_CALL', audioDataList: buffers });
  await flush();

  const starts = env.audioContext()._starts.filter(s => !s.osc).map(s => s.when);
  assert.strictEqual(starts.length, 3, 'se esperaban 3 fragmentos agendados, hubo ' + starts.length);

  const hueco1 = starts[1] - starts[0];
  const hueco2 = starts[2] - starts[1];

  assert.ok(hueco1 >= 2.0,
    'el 2º fragmento arranca ' + hueco1.toFixed(2) + 's tras el 1º, que dura 2s: se solapan');
  assert.ok(hueco2 >= 3.0,
    'el 3º fragmento arranca ' + hueco2.toFixed(2) + 's tras el 2º, que dura 3s: se solapan');
});

test('un ArrayBuffer suelto (formato antiguo) también se reproduce', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  env.send({ type: 'MT_PLAY_TTS_INTO_CALL', audioData: new ArrayBuffer(1000) });
  await flush();

  assert.strictEqual(env.audioContext()._starts.filter(s => !s.osc).length, 1);
});

test('el tono de prueba se inyecta en el canal TTS', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  env.send({ type: 'MT_MIXER_SELFTEST' });
  await flush();

  assert.ok(env.audioContext()._starts.some(s => s.osc), 'no se agendó ningún oscilador');
  assert.ok(env.statuses().includes('SELFTEST_TONE'), 'no se notificó SELFTEST_TONE');
});

test('el diagnóstico reporta el mixer conectado a los senders de audio', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));

  const r = await env.diag();
  assert.strictEqual(r.sendersDeAudio, 1);
  assert.strictEqual(r.sendersConNuestroMixer, 1, 'el diagnóstico no ve nuestro mixer en el sender');
  assert.strictEqual(r.sendersHabilitados, 1);
  assert.strictEqual(r.meetMuteado, false);
  assert.ok(r.mixerTrack && r.mixerTrack.readyState === 'live');
});

test('el diagnóstico detecta que Meet tiene el micrófono muteado', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const pc = env.newPeerConnection();
  const sender = pc.addTrack(new env.FakeTrack('audio', 'micro-crudo'));
  sender._track.enabled = false; // Meet mutea con track.enabled = false

  const r = await env.diag();
  assert.strictEqual(r.meetMuteado, true, 'no se detectó el mute de Meet, que deja mudo al receptor');
});

test('MT_SET_MIC_MUTE lleva la ganancia del micrófono a 0.0 sin tocar el canal TTS', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  env.send({ type: 'MT_SET_MIC_MUTE', muted: true });
  let r = await env.diag();
  assert.strictEqual(r.micGain, 0.0, 'la voz en español sigue viajando al receptor');
  assert.ok(r.ttsGain > 0, 'el canal TTS quedó silenciado junto con el micrófono');

  env.send({ type: 'MT_SET_MIC_MUTE', muted: false });
  r = await env.diag();
  assert.strictEqual(r.micGain, 1.0, 'no se restauró la voz directa');
});

test('el micrófono físico queda conectado al mixer', async () => {
  const env = createEnvironment();
  env.load();
  await env.gum({ audio: true });

  const r = await env.diag();
  assert.strictEqual(r.microfonoFisico, 'microfono-fisico', 'el micrófono real no llegó al mixer');
});

// ════════════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════════════

module.exports = { createEnvironment, flush };

if (require.main === module) {
  (async () => {
    let passed = 0;
    const failures = [];

    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log('  [32m✓[0m ' + name);
        passed++;
      } catch (err) {
        console.log('  [31m✗[0m ' + name);
        console.log('      ' + err.message);
        failures.push(name);
      }
    }

    console.log('\n' + passed + '/' + tests.length + ' pruebas superadas');
    if (failures.length) {
      console.log('[31mFallaron:[0m ' + failures.join(', '));
      process.exit(1);
    }
  })();
}
