const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdaptiveJitterBuffer, wsolaCompress } = require('../adaptive-jitter-buffer');

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

test('AdaptiveJitterBuffer descarta muestras antiguas si una ráfaga inicial supera el límite máximo', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 40,
    partialMs: 10,
    maxBufferMs: 10,
    maxIncrementMs: 5,
    maxCapMs: 50
  });

  // Límite inicial = 40 + 10 + 10 = 60 muestras; empujamos 100 muestras antes de reproducir
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

test('wsolaCompress acorta una onda periódica un 15 % conservando continuidad de bordes y sin clics ni NaN', () => {
  const sr = 24000;
  const srcLen = 3200; // 133.3 ms @ 24 kHz (un frame de Haru-4B)
  const src = new Float32Array(srcLen);
  const freq = 200; // voz humana fundamental 200 Hz (periodo = 120 muestras)
  for (let i = 0; i < srcLen; i++) {
    src[i] = 0.7 * Math.sin((2 * Math.PI * freq * i) / sr);
  }

  const compressed = wsolaCompress(src, 0.15, 240, 60);
  assert.equal(compressed.length, Math.round(srcLen * 0.85));
  assert.ok(compressed.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.85));
  // El inicio y el final coinciden exactamente con el bloque original para empalmar sin clic
  assert.ok(Math.abs(compressed[0] - src[0]) < 1e-6);
  assert.ok(Math.abs(compressed[compressed.length - 1] - src[src.length - 1]) < 1e-6);
});

test('AdaptiveJitterBuffer aplica compresión WSOLA suave en vez de hard-drop cuando crece la cola en reproducción activa', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 40,
    partialMs: 10,
    maxBufferMs: 20,
    catchupDeadbandMs: 10,
    catchupWinMs: 10,
    catchupTolMs: 3,
    minQueueWindowMs: 20,
    wsolaHeadroomMs: 180
  });

  const makeWave = (len) => {
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) arr[i] = 0.6 * Math.sin((2 * Math.PI * i) / 10);
    return arr;
  };

  // Arrancar reproducción normal y sostener cola elevada (> 90 ms) durante dos sub-ventanas de 20 ms
  jb.push(makeWave(60));
  jb.pull(new Float32Array(10)); // drena partial
  jb.pull(new Float32Array(10)); // activa reproducción (quedan 50 ms)
  jb.push(makeWave(90)); // sube cola a 140 ms
  jb.pull(new Float32Array(20)); // cierra sub-ventana 1 (quedan 120 ms)
  jb.pull(new Float32Array(20)); // cierra sub-ventana 2 con minQueuePrev = 120 ms (> target 50 + deadband 10)
  jb.pull(new Float32Array(5));  // minQueueCur = 100 ms -> recentMinQueue() = 100 ms

  // El siguiente bloque entrante debe acortarse mediante WSOLA sin disparar ningún hard-drop
  jb.push(makeWave(80));
  const st = jb.stats();
  assert.equal(st.dropEvents, 0, 'WSOLA debe absorber el exceso sin descartar muestras de golpe');
  assert.ok(st.wsolaEvents >= 1, 'debe haberse activado al menos una compresión WSOLA');
  assert.ok(st.compressedSamples > 0);
});

test('AdaptiveJitterBuffer reduce automáticamente partialBufferMs tras shrinkAfterSec de red estable', () => {
  const jb = createAdaptiveJitterBuffer({
    sampleRate: 1000,
    initialMs: 20,
    partialMs: 5,
    incrementMs: 5,
    maxBufferMs: 80,
    shrinkAfterSec: 0.1 // 100 muestras limpias en test para comprobar recuperación rápida
  });

  // Provocar 1 underrun pidiendo 30 muestras cuando solo hay 25 -> partialBuffer sube de 5 ms a 10 ms
  jb.push(new Float32Array(25).fill(0.5));
  jb.pull(new Float32Array(5)); // drena partial
  jb.pull(new Float32Array(30)); // solo hay 25 < 30 -> underrun -> partialBufferMs pasa a 10 ms
  assert.equal(jb.stats().partialBufferMs, 10);

  // Ahora alimentar 150 ms continuos y reproducirlos sin cortes (> 100 ms shrinkAfterSec)
  jb.push(new Float32Array(150).fill(0.5));
  jb.pull(new Float32Array(10)); // drena partial (10 ms)
  for (let i = 0; i < 6; i++) {
    jb.pull(new Float32Array(20)); // 120 ms reproducidos limpiamente
  }

  const st = jb.stats();
  assert.equal(st.partialBufferMs, 5, 'tras estabilidad continua debe devolver los 5 ms extra');
  assert.ok(st.shrinkEvents >= 1);
});
