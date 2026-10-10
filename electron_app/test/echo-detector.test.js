const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEchoDetector } = require('../local-ai/echo-detector');
const { readWav } = require('./support/wav');
const { pinkNoise } = require('./support/noise');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));
const T0 = 1_000_000; // instante (ms) en que empieza a sonar la reunión

/** Entrega el audio de la reunión en tramas de 2048 muestras con su hora, como hace la interfaz. */
function playMeeting(detector, samples, startAt = T0) {
  for (let i = 0; i < samples.length; i += 2048) {
    const chunk = samples.slice(i, i + 2048);
    detector.observeReference(chunk, startAt + ((i + chunk.length) / 16));
  }
}

/** Lo que oiría el micrófono: el audio de la reunión atenuado, con retraso y algo de ruido de sala. */
function bleed(reference, fromSample, length, { gain = 0.08, noiseSeed = 5 } = {}) {
  const noise = pinkNoise(length, noiseSeed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = gain * reference[fromSample + i] + 0.05 * noise[i]; // eco unos 14 dB por encima del ruido de sala
  return out;
}

test('lo que entra al micrófono desde los parlantes se reconoce como eco, aunque llegue débil y con retraso', () => {
  const meeting = audio('en2');
  const detector = createEchoDetector();
  playMeeting(detector, meeting);
  for (const delayMs of [0, 120, 300]) {
    const from = 16000; // el micrófono capta 1,2 s de lo que sonó a partir del segundo 1
    const heard = bleed(meeting, from, 19200);
    const result = detector.check(heard, T0 + 1000 + delayMs);
    assert.equal(result.echo, true, `retraso ${delayMs} ms: puntuación ${result.score.toFixed(2)}`);
  }
});

test('tu voz mientras suena la reunión no es eco', () => {
  const detector = createEchoDetector();
  playMeeting(detector, audio('en2'));
  for (const id of ['es1', 'es3', 'es5']) {
    const mine = audio(id).slice(4000, 4000 + 19200);
    const result = detector.check(mine, T0 + 1000);
    assert.equal(result.echo, false, `${id}: puntuación ${result.score.toFixed(2)}`);
  }
});

test('si la reunión está en silencio no puede haber eco', () => {
  const detector = createEchoDetector();
  playMeeting(detector, pinkNoise(16000 * 4, 9).map((v) => v * 0.002));
  const result = detector.check(audio('es1').slice(4000, 4000 + 19200), T0 + 1000);
  assert.equal(result.echo, false);
});

test('sin audio de la reunión en ese momento (aún no llegó o ya caducó) no se descarta nada', () => {
  const meeting = audio('en2');
  const fresh = createEchoDetector();
  assert.equal(fresh.check(bleed(meeting, 16000, 19200), T0 + 1000).echo, false);

  const old = createEchoDetector({ keepMs: 3000 });
  playMeeting(old, meeting);
  playMeeting(old, pinkNoise(16000 * 6, 4).map((v) => v * 0.002), T0 + meeting.length / 16);
  assert.equal(old.check(bleed(meeting, 16000, 19200), T0 + 1000).echo, false);
});

test('una frase tuya larga que solo coincide un momento con la reunión no se descarta', () => {
  const meeting = audio('en2');
  const detector = createEchoDetector();
  playMeeting(detector, meeting);
  const mine = audio('es2'); // ~4 s de tu voz
  const withBleed = new Float32Array(mine.length);
  for (let i = 0; i < mine.length; i++) withBleed[i] = mine[i] + 0.05 * (meeting[i] || 0);
  assert.equal(detector.check(withBleed, T0).echo, false);
});
