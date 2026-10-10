const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { modelsDir, skipReason } = require('../support/models');
const { readWav, writeWav } = require('../support/wav');
const { wordErrorRate, hasKeywords } = require('../support/text');
const { pinkNoise } = require('../support/noise');
const phrases = require('../fixtures/phrases.json');

const APP_DIR = path.join(__dirname, '..', '..');
const ELECTRON = require(path.join(APP_DIR, 'node_modules', 'electron'));

/** Silencio inicial (mientras carga el modelo) + frase + silencio final para que la detección de voz cierre. */
function micFile(dir, phraseId) {
  const speech = readWav(path.join(__dirname, '..', 'fixtures', 'audio', `${phraseId}.wav`));
  // Ruido de sala muy bajo en vez de silencio digital: un micrófono real nunca entrega ceros exactos
  const samples = pinkNoise(16000 * 6 + speech.length + 16000 * 4, 21).map((v) => v * 0.02);
  for (let i = 0; i < speech.length; i++) samples[16000 * 6 + i] += speech[i];
  const file = path.join(dir, 'mic.wav');
  writeWav(file, samples);
  return file;
}

/** Cierra la app y sus procesos hijos: en Windows child.kill() deja huérfanos a los renderers. */
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}

/** Reproduce un WAV por la salida de audio predeterminada del equipo, como lo haría la app de la reunión. */
function playThroughSpeakers(file) {
  spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`]);
}

function runApp({ phraseId, sourceLang, targetLang, translationMode, settings = {}, when = null, expectSubtitles = 1, only = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-e2e-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    sttEngine: 'local',
    translationMode,
    sourceLang,
    targetLang,
    ttsEngine: 'webspeech',
    spanishVoice: 'auto',
    translateIncoming: false,
    localMonitor: false,
    showOverlay: false,
    active: false,
    ...settings
  }));

  const env = { ...process.env, VIBE_MODELS_DIR: modelsDir };
  delete env.ELECTRON_RUN_AS_NODE;

  // Con micrófono simulado Chromium simula TODA la captura, también el audio del sistema:
  // el escenario de la reunión (phraseId null) usa los dispositivos reales.
  const fakeMic = phraseId
    ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile(dir, phraseId)}%noloop`]
    : [];
  const child = spawn(ELECTRON, [
    `--user-data-dir=${dir}`,
    ...fakeMic,
    '--use-fake-ui-for-media-stream',
    path.join(__dirname, 'harness-main.js')
  ], { cwd: APP_DIR, env });

  return new Promise((resolve, reject) => {
    const subtitles = [];
    const logs = [];
    let buffer = '';
    let settle = null;

    const finish = (error) => {
      clearTimeout(deadline);
      clearTimeout(settle);
      killTree(child);
      if (error) reject(error); else resolve({ subtitles, logs });
    };
    const deadline = setTimeout(() => finish(new Error(`sin subtítulo en 90 s. Registro:\n${logs.slice(-25).join('\n')}`)), 90000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (process.env.VIBE_E2E_DEBUG) process.stdout.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('E2E ')) continue;
        const msg = JSON.parse(line.slice(4));
        if (msg.type === 'log') {
          logs.push(`[${msg.category}] ${msg.message}`);
          if (when && !when.fired && msg.message.includes(when.log)) {
            when.fired = true;
            when.run();
          }
          if (msg.message.includes('idioma de origen fijo')) return finish(new Error(msg.message));
        }
        // Con traducción directa el texto oído llega después, como actualización de un subtítulo ya mostrado
        if (msg.type === 'subtitle' && msg.update) {
          const shown = subtitles.find((sub) => sub.segmentId === msg.segmentId);
          if (shown) shown.originalText = msg.originalText;
          continue;
        }
        if (msg.type === 'subtitle' && msg.isFinal && (!only || msg.direction === only)) {
          subtitles.push(msg);
          clearTimeout(settle);
          if (subtitles.length >= expectSubtitles) settle = setTimeout(() => finish(), 3000); // esperar por si la frase llega en dos segmentos
        }
      }
    });
    // Se consume stderr para que la tubería no se llene; con VIBE_E2E_DEBUG=1 además se muestra
    child.stderr.on('data', (chunk) => { if (process.env.VIBE_E2E_DEBUG) process.stderr.write(chunk); });
    child.on('exit', (code) => { if (process.env.VIBE_E2E_DEBUG) console.log(`  [app] salió con código ${code}`); });
    child.on('error', finish);
  });
}

const joined = (subtitles, field) => subtitles.map((s) => s[field]).join(' ');

test('ES→EN con traducción local: la app muestra el subtítulo traducido sin usar la nube', { skip: skipReason, timeout: 120000 }, async () => {
  const phrase = phrases.es[0];
  const { subtitles, logs } = await runApp({ phraseId: phrase.id, sourceLang: 'es-ES', targetLang: 'en', translationMode: 'local' });
  const original = joined(subtitles, 'originalText');
  const translated = joined(subtitles, 'translatedText');
  console.log(`  oído: "${original}" ➔ "${translated}"`);
  assert.ok(wordErrorRate(phrase.text, original) <= 0.2, original);
  assert.ok(hasKeywords(translated, phrase.keywordsEn), translated);
  assert.ok(logs.some((l) => l.includes('Motor local listo')), 'el motor local no arrancó');
  assert.ok(logs.some((l) => l.includes('Traducido en') && l.includes('[local]')), 'la traducción no la hizo el motor local');
  assert.ok(!logs.some((l) => l.includes('Traducido en') && !l.includes('[local]')), 'alguna frase se tradujo fuera del equipo');
});

test('EN→ES con traducción local', { skip: skipReason, timeout: 120000 }, async () => {
  const phrase = phrases.en[0];
  const { subtitles } = await runApp({ phraseId: phrase.id, sourceLang: 'en-US', targetLang: 'es', translationMode: 'local' });
  const original = joined(subtitles, 'originalText');
  const translated = joined(subtitles, 'translatedText');
  console.log(`  oído: "${original}" ➔ "${translated}"`);
  assert.ok(wordErrorRate(phrase.text, original) <= 0.2, original);
  assert.ok(hasKeywords(translated, phrase.keywordsEs), translated);
});

test('ES→EN en modo auto: transcribe en local y traduce con el mejor motor disponible', { skip: skipReason, timeout: 120000 }, async () => {
  const phrase = phrases.es[2];
  const { subtitles } = await runApp({ phraseId: phrase.id, sourceLang: 'es-ES', targetLang: 'en', translationMode: 'auto' });
  const translated = joined(subtitles, 'translatedText');
  console.log(`  ➔ "${translated}"`);
  assert.ok(hasKeywords(translated, phrase.keywordsEn), translated);
});

test('con origen Auto el motor local no arranca y lo explica', { skip: skipReason, timeout: 120000 }, async () => {
  await assert.rejects(
    runApp({ phraseId: 'es1', sourceLang: 'auto', targetLang: 'en', translationMode: 'local' }),
    /idioma de origen fijo/
  );
});

// Esta prueba SUENA: reproduce dos frases en inglés por los altavoces o auriculares del equipo para simular la reunión.
const speakersSkip = skipReason || (process.platform !== 'win32' ? 'solo Windows' : false)
  || (process.env.VIBE_E2E_SPEAKERS === '1' ? false : 'reproduce audio por los altavoces: actívala con VIBE_E2E_SPEAKERS=1');

test('reunión con varias intervenciones seguidas: se subtitulan todas, en orden y sin voz', { skip: speakersSkip, timeout: 150000 }, async () => {
  const [first, second] = [phrases.en[2], phrases.en[3]];
  const audioDir = path.join(__dirname, '..', 'fixtures', 'audio');
  const { subtitles, logs } = await runApp({
    phraseId: null,
    sourceLang: 'es-ES',
    targetLang: 'en',
    translationMode: 'local',
    settings: { translateIncoming: true, incomingVoice: false },
    expectSubtitles: 2,
    only: 'incoming', // el micrófono real puede oír la sala: aquí solo cuenta lo que llega de la reunión
    when: {
      log: 'Traducción bidireccional del receptor',
      run: () => setTimeout(() => {
        playThroughSpeakers(path.join(audioDir, `${first.id}.wav`));
        playThroughSpeakers(path.join(audioDir, `${second.id}.wav`));
      }, 1500)
    }
  });
  for (const s of subtitles) console.log(`  ${s.originalText} ➔ "${s.translatedText}"`);
  assert.equal(subtitles.length, 2, 'deben llegar las dos intervenciones');
  assert.ok(subtitles.every((s) => s.direction === 'incoming'));
  assert.ok(hasKeywords(subtitles[0].translatedText, first.keywordsEs), subtitles[0].translatedText);
  assert.ok(hasKeywords(subtitles[1].translatedText, second.keywordsEs), subtitles[1].translatedText);
  assert.ok(wordErrorRate(first.text, subtitles[0].originalText.replace('Receptor: ', '')) <= 0.2, subtitles[0].originalText);
  assert.ok(!logs.some((l) => l.startsWith('[TTS]')), 'en modo solo subtítulos no debe sonar ninguna voz');
});
