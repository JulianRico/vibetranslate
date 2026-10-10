function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Ruido rosa determinista (filtro de Paul Kellet sobre un generador con semilla). */
function pinkNoise(length, seed = 1) {
  let state = seed >>> 0 || 1;
  const white = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < length; i++) {
    const w = white();
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.05;
  }
  return out;
}

/** Suma ruido a la voz con la relación señal/ruido pedida (en dB). */
function mixAtSnr(speech, noise, snrDb) {
  const gain = rms(speech) / (rms(noise) * Math.pow(10, snrDb / 20));
  const out = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) out[i] = speech[i] + gain * noise[i % noise.length];
  return out;
}

module.exports = { rms, pinkNoise, mixAtSnr };
