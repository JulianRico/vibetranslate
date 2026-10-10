/**
 * echo-detector.js - Reconoce cuándo lo que oye el micrófono es el audio de la reunión saliendo por los parlantes
 *
 * Compara la forma del volumen (envolvente) de la frase del micrófono con la del audio de la reunión
 * en ese mismo instante, probando varios retrasos. Tu voz no sigue la envolvente de la reunión; el eco sí.
 */

const HOP = 320; // 20 ms a 16 kHz
const HOP_MS = 20;
const SCORE_LIMIT = 0.75; // medido con una sesión real: eco 0,83; voz propia 0,54-0,69 buscando sin restricción de tiempo
const MIN_DELAY_MS = -100;
const MAX_DELAY_MS = 500; // el micrófono oye la reunión algo después de que suene
const SILENCE_RMS = 0.004; // por debajo de esto la reunión no está sonando

function envelope(samples) {
  const out = [];
  for (let i = 0; i + HOP <= samples.length; i += HOP) {
    let sum = 0;
    for (let k = i; k < i + HOP; k++) sum += samples[k] * samples[k];
    out.push(Math.sqrt(sum / HOP));
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function createEchoDetector({ keepMs = 20000 } = {}) {
  let frames = []; // envolvente de la reunión, una entrada cada 20 ms
  let rest = new Float32Array(0);
  let lastFrameEndAt = 0; // hora (ms) en que termina la última entrada de `frames`

  return {
    /** Audio de la reunión tal como va llegando; `endAt` es la hora en que termina este trozo. */
    observeReference(samples, endAt) {
      const all = new Float32Array(rest.length + samples.length);
      all.set(rest);
      all.set(samples, rest.length);
      const whole = Math.floor(all.length / HOP) * HOP;
      const added = envelope(all.subarray(0, whole));
      rest = all.slice(whole);
      frames.push(...added);
      lastFrameEndAt = endAt - (rest.length / 16);
      const keep = Math.ceil(keepMs / HOP_MS);
      if (frames.length > keep) frames = frames.slice(frames.length - keep);
    },

    /** ¿La frase del micrófono que empezó en `startAt` es el audio de la reunión? */
    check(samples, startAt) {
      const mic = envelope(samples);
      if (mic.length < 10 || frames.length === 0) return { echo: false, score: 0 };
      const firstFrameAt = lastFrameEndAt - frames.length * HOP_MS;
      let best = -1;
      for (let delay = MIN_DELAY_MS; delay <= MAX_DELAY_MS; delay += HOP_MS) {
        const from = Math.round((startAt - delay - firstFrameAt) / HOP_MS);
        if (from < 0 || from + mic.length > frames.length) continue; // la reunión no cubre ese tramo
        const reference = frames.slice(from, from + mic.length);
        const level = Math.sqrt(reference.reduce((sum, v) => sum + v * v, 0) / reference.length);
        if (level < SILENCE_RMS) continue;
        best = Math.max(best, pearson(mic, reference));
      }
      return { echo: best >= SCORE_LIMIT, score: Math.max(best, 0) };
    }
  };
}

module.exports = { createEchoDetector };
