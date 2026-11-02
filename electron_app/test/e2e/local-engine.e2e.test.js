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
// VIBE_ELECTRON_BIN permite probar la app con otro ejecutable de Electron sin reinstalar dependencias
const ELECTRON = process.env.VIBE_ELECTRON_BIN || require(path.join(APP_DIR, 'node_modules', 'electron'));

/** Silencio inicial (mientras carga el modelo) + frase + silencio final para que la detección de voz cierre. */
function micFile(dir, phraseId) {
  const speech = readWav(path.join(__dirname, '..', 'fixtures', 'audio', `${phraseId}.wav`));
  if (!speech.length) throw new Error(`audio vacío: ${phraseId}`);
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

/** Pide a la app que se cierre por las buenas y, si no lo hace en 4 s, la mata con sus hijos. */
function closeApp(child) {
  if (child.exitCode !== null) return;
  const fallback = setTimeout(() => killTree(child), 4000);
  // Tras un cierre ordenado se deja un margen: el auxiliar de volumen restaura y termina por sí mismo
  child.once('exit', () => { clearTimeout(fallback); setTimeout(() => killTree(child), 3000); });
  try { fs.writeFileSync(child.quitFile, 'quit'); } catch { killTree(child); }
}

/**
 * Reproduce varios WAV seguidos por la salida de audio predeterminada, desde UN solo programa
 * (como la app de la reunión, que no se abre de nuevo en cada frase).
 */
function playThroughSpeakers(...files) {
  const commands = files.map((file) => `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`).join('; ');
  spawnSync('powershell', ['-NoProfile', '-Command', commands]);
}

function runApp({ phraseId, sourceLang, targetLang, translationMode, settings = {}, when = null, expectSubtitles = 1, only = null, settleMs = 3000 }) {
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

  const quitFile = path.join(dir, 'quit');
  const env = { ...process.env, VIBE_MODELS_DIR: modelsDir, VIBE_SESSIONS_DIR: path.join(dir, 'sessions'), VIBE_E2E_QUIT_FILE: quitFile };
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
  child.quitFile = quitFile;

  return new Promise((resolve, reject) => {
    const subtitles = [];
    const logs = [];
    let buffer = '';
    let settle = null;

    const finish = (error) => {
      clearTimeout(deadline);
      clearTimeout(settle);
      closeApp(child);
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
        // Una línea ya mostrada se reescribe: llegó el resto de su frase o la traducción mejorada de la nube
        if (msg.type === 'subtitle' && msg.replace) {
          const shown = subtitles.find((sub) => sub.lineId === msg.lineId);
          if (shown) {
            shown.versions = [...(shown.versions || [shown.translatedText]), msg.translatedText];
            shown.versionAt = [...(shown.versionAt || [shown.at]), msg.at];
            shown.translatedText = msg.translatedText;
            if (msg.originalText) shown.originalText = msg.originalText;
            shown.replacedAfterMs = msg.at - shown.at;
            continue;
          }
        }
        if (msg.type === 'subtitle' && msg.isFinal && (!only || msg.direction === only)) {
          subtitles.push(msg);
          clearTimeout(settle);
          if (subtitles.length >= expectSubtitles) settle = setTimeout(() => finish(), settleMs); // esperar por si la frase llega en dos segmentos
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
  assert.ok(!logs.some((l) => l.includes('Mejorada en la nube')), 'en modo local nada sale del equipo');
  assert.ok(subtitles.every((s) => !s.versions), 'nadie reescribe la traducción local');
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

// Con red: la traducción local sale al instante y la nube (LLM de Groq o Google) reescribe la línea con su versión
const cloudSkip = skipReason || (process.env.VIBE_E2E_OFFLINE === '1' ? 'sin red (VIBE_E2E_OFFLINE=1)' : false);

for (const [lang, sourceLang, targetLang, key] of [['en', 'en-US', 'es', 'keywordsEs'], ['es', 'es-ES', 'en', 'keywordsEn']]) {
  test(`modo auto con un modismo (${lang}): el subtítulo local sale al instante y la nube lo mejora en la misma línea`, { skip: cloudSkip, timeout: 120000 }, async () => {
    const phrase = phrases.idioms[lang][0];
    const { subtitles, logs } = await runApp({ phraseId: phrase.id, sourceLang, targetLang, translationMode: 'auto', settleMs: 5000 });
    for (const s of subtitles) console.log(`  "${s.originalText}" ➔ ${(s.versions || [s.translatedText]).map((v) => `"${v}"`).join(' ➔ ')}${s.replacedAfterMs !== undefined ? ` (mejorada ${s.replacedAfterMs} ms después)` : ''}`);
    // La frase puede llegar en una o varias líneas (cada frase completa es la suya); la mejora no añade líneas
    assert.equal(new Set(subtitles.map((x) => x.lineId)).size, subtitles.length, 'cada línea aparece una sola vez');
    assert.ok(logs.some((l) => l.includes('Traducido en') && l.includes('[local]')), 'la primera versión es la local');
    // Cada línea pasa por la nube: o la mejora o confirma la local (depende de qué motor responda primero)
    const checked = logs.filter((l) => l.includes('Mejorada en la nube') || l.includes('coincide con la traducción local'));
    assert.ok(checked.length >= subtitles.length, 'la nube revisa todas las líneas (una línea unida, cada vez que crece)');
    const improved = subtitles.filter((x) => x.versions);
    for (const line of improved) {
      assert.notEqual(line.versions[0], line.versions[line.versions.length - 1]);
      // cada versión llega poco después de la anterior: la nube no hace esperar al subtítulo
      const gaps = line.versionAt.slice(1).map((t, i) => t - line.versionAt[i]);
      assert.ok(gaps.every((g) => g < 4000), `esperas entre versiones: ${gaps.join(', ')} ms`);
    }
    assert.ok(hasKeywords(joined(subtitles, 'translatedText'), phrase[key]), joined(subtitles, 'translatedText'));
  });
}

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
        playThroughSpeakers(path.join(audioDir, `${first.id}.wav`), path.join(audioDir, `${second.id}.wav`));
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

test('reunión con la traducción en voz alta: el original se atenúa, se sigue entendiendo y la app no se oye a sí misma', { skip: speakersSkip, timeout: 180000 }, async () => {
  const [first, second] = [phrases.en[2], phrases.en[3]];
  const audioDir = path.join(__dirname, '..', 'fixtures', 'audio');
  const { subtitles, logs } = await runApp({
    phraseId: null,
    sourceLang: 'es-ES',
    targetLang: 'en',
    translationMode: 'local',
    settings: { translateIncoming: true, incomingVoice: true, duckLevel: 0.05, spanishVoice: 'auto', spanishVolume: 60 },
    expectSubtitles: 2,
    only: 'incoming',
    settleMs: 9000, // margen para que suene la voz en español: si la app se oyera a sí misma aparecerían más frases
    when: {
      log: 'suena al 5 %',
      run: () => setTimeout(() => {
        playThroughSpeakers(path.join(audioDir, `${first.id}.wav`), path.join(audioDir, `${second.id}.wav`));
      }, 2500)
    }
  });
  for (const s of subtitles) console.log(`  ${s.originalText} ➔ "${s.translatedText}"`);
  if (!logs.some((l) => l.includes('sin el sonido de esta app'))) {
    assert.fail('esta versión de Electron no excluye el audio propio de la captura (hace falta Electron 44 o posterior)');
  }
  assert.equal(subtitles.length, 2, `la voz traducida no debe volver a entrar como frase nueva: ${subtitles.map((s) => s.translatedText).join(' / ')}`);
  assert.ok(hasKeywords(subtitles[0].translatedText, first.keywordsEs), subtitles[0].translatedText);
  assert.ok(hasKeywords(subtitles[1].translatedText, second.keywordsEs), subtitles[1].translatedText);
  assert.ok(logs.some((l) => l.startsWith('[TTS]') && l.includes('Voz en español')), 'la traducción debe leerse en voz alta');
});
