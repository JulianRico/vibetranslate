/**
 * segmenter.js - Convierte tramas de audio en segmentos de voz con Silero VAD
 */

const WINDOW = 512;
const MAX_SPEECH_SECONDS = 4; // a partir de aquí Silero corta en la siguiente micropausa (en la práctica, trozos de 4-6 s)
const SPEECH_LOOKBACK = 8000; // la voz empezó algo antes de que el detector la confirme
const PRE_ROLL = 1600; // 100 ms previos al inicio detectado: con 150 ms o más el modelo empeora cuando hay ruido de fondo
const HISTORY = 16000 * 8; // cubre el segmento más largo (6 s) más su margen
// Una palabra corta seguida de pausa («Hi,», «Sí,», «Perdón,») no llega a los 400 ms de voz que pide el detector y la
// frase empezaba en la palabra siguiente. Un segundo detector, sensible a 100 ms, marca esas ráfagas; si preceden a
// la frase (con pausas de hasta 700 ms entre ellas) se le anteponen. En la entrevista de prueba recuperó la primera
// palabra en 7 de 18 turnos sin perder ninguna, también con ruido rosa a 10 y 5 dB.
const BURST_MAX_GAP = 16000 * 0.7;
const BURST_MAX_LOOKBACK = 16000 * 1.5;

/** Traduce el selector de sensibilidad del micrófono (umbral RMS antiguo) al umbral de probabilidad de Silero. */
function thresholdFromNoiseGate(value) {
  const gate = parseFloat(value);
  if (!Number.isFinite(gate)) return 0.5;
  if (gate <= 0.008) return 0.35;
  if (gate <= 0.016) return 0.5;
  if (gate <= 0.03) return 0.6;
  return 0.75;
}

function createSegmenter({ sherpa, modelPath, threshold = 0.5 }) {
  const makeVad = (minSpeechDuration, minSilenceDuration) => new sherpa.Vad({
    sileroVad: {
      model: modelPath,
      threshold,
      minSilenceDuration,
      minSpeechDuration,
      windowSize: WINDOW,
      maxSpeechDuration: MAX_SPEECH_SECONDS
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu'
  }, 30);
  const vad = makeVad(0.4, 0.35);
  const burstVad = makeVad(0.1, 0.1); // solo marca dónde hubo voz, por corta que sea
  let bursts = []; // [inicio, fin) de las ráfagas recientes

  let rest = new Float32Array(0);

  // Historial reciente para anteponer a cada segmento el audio previo a la detección:
  // Silero marca el inicio algo tarde y sin ese margen el modelo pierde la primera palabra.
  const history = new Float32Array(HISTORY);
  let fed = 0; // muestras entregadas al detector desde el inicio del flujo
  let previousEnd = 0;
  let speechStart = null; // dónde empezó la frase que se está diciendo ahora

  function remember(window) {
    history.copyWithin(0, window.length);
    history.set(window, HISTORY - window.length);
    fed += window.length;
  }

  /** Muestras del flujo en [from, to), si siguen en el historial. */
  function recall(from, to) {
    const oldest = fed - HISTORY;
    const start = Math.max(from, oldest, 0);
    if (start >= to) return new Float32Array(0);
    return history.slice(start - oldest, to - oldest);
  }

  function collectBursts() {
    while (!burstVad.isEmpty()) {
      const front = burstVad.front(false);
      bursts.push([front.start, front.start + front.samples.length]);
      burstVad.pop();
    }
    bursts = bursts.filter(([, end]) => end > fed - HISTORY);
  }

  /** Dónde empezó de verdad la frase que el detector da por empezada en `start`: incluye las ráfagas cortas previas. */
  function speechOnset(start) {
    let onset = start;
    for (let i = bursts.length - 1; i >= 0; i--) {
      const [from, to] = bursts[i];
      if (from >= onset) continue;
      if (to < onset - BURST_MAX_GAP || from < previousEnd || from < start - BURST_MAX_LOOKBACK) break;
      onset = from;
    }
    return onset;
  }

  function drain() {
    collectBursts();
    const segments = [];
    while (!vad.isEmpty()) {
      // false: Electron no admite búferes externos
      const front = vad.front(false);
      const speech = Float32Array.from(front.samples);
      const preRoll = recall(Math.max(speechOnset(front.start) - PRE_ROLL, previousEnd), front.start);
      const samples = new Float32Array(preRoll.length + speech.length);
      samples.set(preRoll);
      samples.set(speech, preRoll.length);
      previousEnd = front.start + speech.length;
      speechStart = null; // si se sigue hablando, la frase siguiente empieza donde terminó esta
      segments.push({ samples, start: front.start - preRoll.length });
      vad.pop();
    }
    return segments;
  }

  return {
    push(samples) {
      const all = new Float32Array(rest.length + samples.length);
      all.set(rest);
      all.set(samples, rest.length);
      let i = 0;
      for (; i + WINDOW <= all.length; i += WINDOW) {
        const window = all.slice(i, i + WINDOW);
        remember(window);
        burstVad.acceptWaveform(window);
        vad.acceptWaveform(window);
        if (!vad.isDetected()) speechStart = null;
        else if (speechStart === null) speechStart = Math.max(previousEnd, fed - SPEECH_LOOKBACK, 0);
      }
      rest = all.slice(i);
      return drain();
    },
    flush() {
      burstVad.flush();
      vad.flush();
      rest = new Float32Array(0);
      const segments = drain();
      speechStart = null;
      return segments;
    },
    /** Audio de la frase que aún se está diciendo (null si no se está hablando). */
    peek() {
      return speechStart === null ? null : recall(speechStart, fed);
    },
    /** Muestras entregadas al detector: sitúa `start` de un segmento en el tiempo. */
    position: () => fed,
    isSpeaking: () => vad.isDetected()
  };
}

module.exports = { createSegmenter, thresholdFromNoiseGate };
