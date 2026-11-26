const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdaptiveJitterBuffer } = require('../adaptive-jitter-buffer');

test('AdaptiveJitterBuffer espera a alcanzar initialMs + partialMs antes de reproducir y aplica fade-in anti-click', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000, // 1 muestra = 1 ms para aritmética exacta
    initialMs: 80,
    partialMs: 10,
    maxBufferMs: 20,
    rampMs: 5
  });

  const out = new Float32Array(20);
  // Con 60 ms cargados (< 80 ms initial) aún no reproduce
  jb.push(new Float32Array(60).fill(0.8));
  assert.equal(jb.canPlay(), false);
  assert.equal(jb.pull(out), 0);
  assert.ok(out.every((v) => v === 0));

  // Al añadir 30 ms más (total 90 ms >= 80 ms), arranca pero espera los 10 ms de partialBuffer
  jb.push(new Float32Array(30).fill(0.8));
  const waitQuantum = new Float32Array(10);
  assert.equal(jb.pull(waitQuantum), 0); // consume el colchón parcial inicial

  // El siguiente pull ya reproduce con rampa de entrada creciente (sin salto brusco a 0.8)
  const playQuantum = new Float32Array(10);
  const written = jb.pull(playQuantum);
  assert.equal(written, 10);
  assert.ok(playQuantum[0] > 0 && playQuantum[0] < 0.8);
  assert.ok(playQuantum[0] < playQuantum[2]);
  assert.ok(Math.abs(playQuantum[4] - 0.8) < 1e-5);
});

test('AdaptiveJitterBuffer aumenta partialBuffer tras un underrun y hace fade-out suave', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 20,
    partialMs: 5,
    maxBufferMs: 40,
    incrementMs: 5,
    rampMs: 4
  });

  jb.push(new Float32Array(25).fill(1.0));
  jb.pull(new Float32Array(5)); // drena partialMs
  jb.pull(new Float32Array(15)); // quedan 10 muestras

  // Pedimos 20 muestras cuando solo quedan 10 -> underrun controlado
  const tail = new Float32Array(20);
  const n = jb.pull(tail);
  assert.equal(n, 10);
  assert.equal(tail[15], 0);
  assert.ok(tail[9] < tail[6], 'debe aplicar rampa decreciente antes de quedarse en silencio');

  const st = jb.stats();
  assert.equal(st.underruns, 1);
  assert.equal(st.partialBufferMs, 10); // subió de 5 ms a 10 ms
});

test('AdaptiveJitterBuffer descarta muestras antiguas si una ráfaga supera el límite máximo', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 40,
    partialMs: 10,
    maxBufferMs: 10,
    maxIncrementMs: 5,
    maxCapMs: 50
  });

  // Límite inicial = 40 + 10 + 10 = 60 muestras; empujamos 100 muestras
  const burst = new Float32Array(100);
  for (let i = 0; i < 100; i++) burst[i] = i + 1;
  jb.push(burst);

  const st = jb.stats();
  assert.equal(st.dropEvents, 1);
  assert.equal(st.bufferedSamples, 50); // recortado a initial (40) + partial (10)
  assert.equal(st.droppedSamples, 50);
  assert.equal(st.maxBufferMs, 15); // aumentó tolerancia +5 ms
});

test('AdaptiveJitterBuffer reset({ smooth: true }) drena una cola corta de fade-out en barge-in', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 20,
    partialMs: 2,
    maxBufferMs: 40,
    rampMs: 6
  });

  jb.push(new Float32Array(30).fill(0.9));
  jb.pull(new Float32Array(2)); // consume partial
  jb.pull(new Float32Array(5)); // reproduciendo activamente

  jb.reset({ smooth: true });
  assert.equal(jb.bufferedSamples(), 0);

  const fade = new Float32Array(10);
  const drained = jb.pull(fade);
  assert.equal(drained, 6);
  assert.ok(fade[0] > fade[3] && fade[3] > fade[5]);
  assert.equal(fade[6], 0);
});
