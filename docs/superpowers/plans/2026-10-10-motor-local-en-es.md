# Motor local EN↔ES Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir a `electron_app` un motor de transcripción y traducción EN↔ES que corre en el equipo, sin red ni claves, y quitar el bloqueo que retrasa los subtítulos en todos los motores.

**Architecture:** El renderer sigue capturando audio a 16 kHz y envía tramas al proceso principal, que las reenvía a un proceso utilitario de Electron. Ese proceso segmenta con Silero VAD y transcribe con NeMo Canary (un solo modelo para EN y ES, que además traduce desde el audio). La traducción usa Google si hay red y Canary si no. La salida (traducir → subtítulo → voz) pasa por una cola ordenada para que el micrófono nunca espere a la voz sintetizada.

**Tech Stack:** Electron 31.7.7 (CommonJS, `nodeIntegration`), `sherpa-onnx-node` 1.13.8, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-10-motor-local-aislamiento-frances-design.md` (la sección 11 manda sobre las anteriores).

## Global Constraints

- Alcance: solo EN→ES y ES→EN. Nada de francés, verificación de hablante, filtro de ruido ni cambios en las claves de `main.js`.
- Electron se queda en `^31.7.7`. Única dependencia nueva: `sherpa-onnx-node` `1.13.8`. No añadir `@huggingface/transformers`.
- Todo el código nuevo es CommonJS (`require` / `module.exports`), como el resto de `electron_app`.
- Audio siempre `Float32Array` mono a 16 000 Hz.
- Toda llamada a `sherpa-onnx-node` que devuelva muestras pasa `false` en `enableExternalBuffer` (`vad.front(false)`). Electron lanza «External buffers are not allowed» si no.
- La detección de voz va siempre delante del modelo; los segmentos de menos de 6400 muestras (400 ms) se descartan.
- Los textos visibles van en español, con el tono de los existentes.
- Los modelos no se suben a git ni se empaquetan: viven en `userData/models` (o en `VIBE_MODELS_DIR`).
- Pruebas con `node --test`. Las que necesitan modelos se omiten con mensaje si faltan.
- En esta máquina la consola tiene `ELECTRON_RUN_AS_NODE=1`: para lanzar Electron hay que quitarla (`env -u ELECTRON_RUN_AS_NODE …`).
- Todos los comandos se ejecutan desde `electron_app/` salvo que se diga otra cosa.

## Review Focus

1. **Tos, clic o golpe de menos de 400 ms** → no debe aparecer ningún subtítulo (Canary inventa «sí» con audio tan corto). Prueba en Task 5 y Task 9.
2. **El usuario habla más rápido de lo que suena la voz sintetizada** → los subtítulos siguen en orden y sin retraso; la voz de las frases atrasadas se omite. Prueba en Task 2.
3. **Se corta la red en mitad de la sesión** → la frase siguiente se traduce en local, sin esperar 11 s de reintentos. Prueba en Task 7.
4. **La descarga del modelo se interrumpe o llega corrupta** → no queda un archivo a medias que se cargue después; el siguiente intento vuelve a descargar. Prueba en Task 3.
5. **El proceso utilitario muere durante la sesión** → se reinicia una vez y la sesión sigue; si vuelve a morir en 30 s, error visible y la canalización se detiene. Prueba en Task 6.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `electron_app/output-queue.js` (nuevo) | Cola ordenada de trabajos asíncronos con contador de atraso. |
| `electron_app/local-ai/languages.js` (nuevo) | Códigos de idioma y resolución del par origen/destino. |
| `electron_app/local-ai/model-store.js` (nuevo) | Lista de modelos, estado, descarga verificada. |
| `electron_app/local-ai/segmenter.js` (nuevo) | Tramas → segmentos de voz (Silero). |
| `electron_app/local-ai/transcriber.js` (nuevo) | Segmento → texto o traducción (Canary). |
| `electron_app/local-ai/engine.js` (nuevo) | Une segmentador y transcriptor; protocolo de mensajes. Sin Electron. |
| `electron_app/local-ai/worker.js` (nuevo) | Entrada del proceso utilitario: 15 líneas de pegamento. |
| `electron_app/local-ai/client.js` (nuevo) | Lado principal: lanza, reinicia y habla con el proceso. |
| `electron_app/local-ai/translate-route.js` (nuevo) | Decide nube o local para cada traducción. |
| `electron_app/main.js` (modificar) | Canales `LOCAL_AI_*`; campo `engine` en `TRANSLATE_TEXT`. |
| `electron_app/index.js`, `index.html` (modificar) | Cola de salida; opción «Motor local»; envío de tramas. |
| `electron_app/scripts/download-models.js`, `scripts/measure-latency.js` (nuevos) | Descarga para pruebas; informe de latencia. |
| `electron_app/test/**` (nuevo) | Pruebas, utilidades y audios. |

---

### Task 1: Arnés de pruebas y `languages.js`

**Files:**
- Create: `electron_app/local-ai/languages.js`
- Create: `electron_app/test/languages.test.js`
- Modify: `electron_app/package.json` (scripts y `build.files`)
- Modify: `.gitignore` (raíz)

**Interfaces:**
- Produces: `shortCode(value: string) → 'en' | 'es' | 'auto'`; `otherLanguage(code) → 'en' | 'es'`; `resolvePair(sourceLang, targetLang) → { source, target } | null` (`null` cuando el origen es automático o desconocido).

- [ ] **Step 1: Configurar `npm test`**

En `electron_app/package.json`, añadir a `"scripts"`:

```json
"test": "node --test \"test/*.test.js\"",
"test:e2e": "node --test \"test/e2e/*.test.js\"",
"models": "node scripts/download-models.js",
"fixtures": "powershell -NoProfile -ExecutionPolicy Bypass -File test/fixtures/generate-audio.ps1"
```

y en `"build"."files"` añadir estas entradas después de `"!*.md"`:

```json
"!test/**/*",
"!scripts/**/*",
"!.models/**/*"
```

En `.gitignore` (raíz), bajo `# Dependencies`, añadir la línea `electron_app/.models/`.

- [ ] **Step 2: Escribir la prueba que falla**

`electron_app/test/languages.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { shortCode, otherLanguage, resolvePair } = require('../local-ai/languages');

test('shortCode reduce las variantes regionales y trata lo desconocido como auto', () => {
  assert.equal(shortCode('es-ES'), 'es');
  assert.equal(shortCode('en-US'), 'en');
  assert.equal(shortCode('EN'), 'en');
  assert.equal(shortCode('auto'), 'auto');
  assert.equal(shortCode('fr-FR'), 'auto');
  assert.equal(shortCode(''), 'auto');
  assert.equal(shortCode(undefined), 'auto');
});

test('otherLanguage devuelve el otro idioma del par', () => {
  assert.equal(otherLanguage('es'), 'en');
  assert.equal(otherLanguage('en'), 'es');
});

test('resolvePair usa el destino indicado', () => {
  assert.deepEqual(resolvePair('es-ES', 'en'), { source: 'es', target: 'en' });
  assert.deepEqual(resolvePair('en-US', 'es'), { source: 'en', target: 'es' });
});

test('resolvePair con destino auto o igual al origen elige el otro idioma', () => {
  assert.deepEqual(resolvePair('es-ES', 'auto'), { source: 'es', target: 'en' });
  assert.deepEqual(resolvePair('en-US', 'en'), { source: 'en', target: 'es' });
});

test('resolvePair devuelve null si el origen es auto: el motor local necesita idioma fijo', () => {
  assert.equal(resolvePair('auto', 'en'), null);
  assert.equal(resolvePair(undefined, 'es'), null);
});
```

- [ ] **Step 3: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL con `Cannot find module '../local-ai/languages'`.

- [ ] **Step 4: Implementar**

`electron_app/local-ai/languages.js`:

```js
/**
 * languages.js - Idiomas que admite el motor local y resolución del par origen/destino
 */

const LANGUAGES = {
  en: { code: 'en', name: 'English', label: 'Inglés' },
  es: { code: 'es', name: 'Spanish', label: 'Español' }
};

function shortCode(value) {
  if (!value || typeof value !== 'string') return 'auto';
  const code = value.trim().substring(0, 2).toLowerCase();
  return LANGUAGES[code] ? code : 'auto';
}

function otherLanguage(code) {
  return code === 'es' ? 'en' : 'es';
}

function resolvePair(sourceLang, targetLang) {
  const source = shortCode(sourceLang);
  if (source === 'auto') return null;
  let target = shortCode(targetLang);
  if (target === 'auto' || target === source) target = otherLanguage(source);
  return { source, target };
}

module.exports = { LANGUAGES, shortCode, otherLanguage, resolvePair };
```

- [ ] **Step 5: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 5 pruebas, 0 fallos.

- [ ] **Step 6: Commit**

```bash
git add electron_app/package.json electron_app/local-ai/languages.js electron_app/test/languages.test.js .gitignore
git commit -m "feat(local-ai): registro de idiomas y arnes de pruebas"
```

---

### Task 2: Cola de salida (deja de bloquear el micrófono)

Hoy `isTranscribingBlock` sigue activo mientras se traduce y se sintetiza la voz, así que lo que el usuario dice en ese intervalo espera. Esta tarea saca traducción, subtítulo y voz a una cola ordenada, para los dos sentidos y todos los motores por bloques.

**Files:**
- Create: `electron_app/output-queue.js`
- Create: `electron_app/test/output-queue.test.js`
- Modify: `electron_app/index.js` (imports línea 8; bloque `1410-1454`; bloque `1703-1754`; funciones nuevas antes de `startIncomingAudioPipeline`, línea 1262)

**Interfaces:**
- Produces: `createOutputQueue({ onError }) → { push(job), size() }`. `job` recibe `{ backlog }` (trabajos que esperan detrás en el momento de ejecutarse) y puede ser asíncrono. `push` devuelve una promesa que se resuelve cuando ese trabajo termina y nunca rechaza.
- Produces (en `index.js`): `translateText({ text, sourceLang, targetLang, segmentId, pair })`, `deliverOutgoing({ recognizedText, sttElapsed, voiceDurationMs, userSpeechStart, backlog, segmentId })`, `deliverIncoming({ text, sttElapsed, voiceDurationMs, speechStartTime, backlog, segmentId })`. Task 8 las reutiliza.

- [ ] **Step 1: Escribir la prueba que falla**

`electron_app/test/output-queue.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputQueue } = require('../output-queue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ejecuta los trabajos en orden aunque el primero tarde más', async () => {
  const q = createOutputQueue();
  const seen = [];
  q.push(async () => { await sleep(30); seen.push('a'); });
  q.push(async () => { seen.push('b'); });
  await q.push(async () => { seen.push('c'); });
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('push no espera: quien encola sigue de inmediato', async () => {
  const q = createOutputQueue();
  let done = false;
  const p = q.push(async () => { await sleep(40); done = true; });
  assert.equal(done, false);
  assert.equal(q.size(), 1);
  await p;
  assert.equal(done, true);
  assert.equal(q.size(), 0);
});

test('un trabajo que falla no rompe la cola y avisa por onError', async () => {
  const errors = [];
  const q = createOutputQueue({ onError: (e) => errors.push(e.message) });
  const seen = [];
  q.push(async () => { throw new Error('boom'); });
  await q.push(async () => { seen.push('after'); });
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(seen, ['after']);
});

test('cada trabajo recibe cuántos esperan detrás, para poder omitir la voz atrasada', async () => {
  const q = createOutputQueue();
  const backlogs = [];
  q.push(async ({ backlog }) => { await sleep(20); backlogs.push(backlog); });
  q.push(async ({ backlog }) => { backlogs.push(backlog); });
  await q.push(async ({ backlog }) => { backlogs.push(backlog); });
  assert.deepEqual(backlogs, [2, 1, 0]);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL con `Cannot find module '../output-queue'`.

- [ ] **Step 3: Implementar la cola**

`electron_app/output-queue.js`:

```js
/**
 * output-queue.js - Cola ordenada para la salida (traducir ➔ subtítulo ➔ voz)
 * La captura de audio encola y sigue; nunca espera a que termine la voz sintetizada.
 */

function createOutputQueue({ onError = () => {} } = {}) {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    push(job) {
      pending++;
      tail = tail
        .then(() => job({ backlog: pending - 1 }))
        .catch(onError)
        .finally(() => { pending--; });
      return tail;
    },
    size: () => pending
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOutputQueue };
}
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 9 pruebas, 0 fallos.

- [ ] **Step 5: Usar la cola en `index.js`**

a) Tras la línea 8 (`const { floatTo16BitPCM, … } = require('./audio-utils');`) añadir:

```js
const { createOutputQueue } = require('./output-queue');
```

b) Justo antes del comentario `// ── Pipeline para Traducir la Voz del Receptor (Reunión ➔ Español) ──` (línea 1262) insertar:

```js
  // ── Cola de Salida: traducir ➔ subtítulo ➔ voz, sin bloquear la captura ──
  const outputQueue = createOutputQueue({
    onError: (err) => console.warn('[Output Queue] Error:', err)
  });
  const MAX_TTS_BACKLOG = 2;
  let localPair = null;

  async function translateText({ text, sourceLang, targetLang }) {
    return ipcRenderer.invoke('TRANSLATE_TEXT', { text, sourceLang, targetLang });
  }

  async function deliverOutgoing({ recognizedText, sttElapsed, voiceDurationMs, userSpeechStart, backlog = 0, segmentId = null }) {
    const transStart = Date.now();
    const translation = await translateText({
      text: recognizedText,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      segmentId,
      pair: localPair
    });
    const transElapsed = (translation && translation.elapsedMs) || (Date.now() - transStart);
    if (!translation || !translation.translated || !translation.translated.trim()) return;

    const translatedText = translation.translated.trim();
    const isTargetSpanish = (translation.targetLang === 'es');

    sessionTranslationHistory.push({
      time: new Date().toLocaleTimeString(),
      original: translation.original,
      translated: translatedText,
      from: isTargetSpanish ? 'EN' : 'ES',
      to: isTargetSpanish ? 'ES' : 'EN'
    });

    appendLog('TRANSLATE', `Traducido en ${transElapsed}ms (${isTargetSpanish ? 'Inglés ➔ Español' : 'Español ➔ Inglés'}): "${translatedText}"`, 'translate');
    previewTrans.textContent = `✨ ${translatedText}`;

    ipcRenderer.send('DISPLAY_SUBTITLE', {
      originalText: translation.original,
      translatedText: translatedText,
      direction: isTargetSpanish ? 'incoming' : 'outgoing',
      isFinal: true
    });

    let ttsElapsed = 0;
    if (backlog >= MAX_TTS_BACKLOG) {
      appendLog('TTS', `⏭️ Voz omitida (${backlog} frases en cola): se muestra solo el subtítulo.`, 'warn');
    } else if (isTargetSpanish) {
      const ttsRes = await speakSpanishToUser(translatedText);
      ttsElapsed = (ttsRes && ttsRes.elapsedMs) || 0;
    } else {
      const ttsRes = await playAudioToVirtualCableAndSpeakers(translatedText, 'en');
      ttsElapsed = (ttsRes && ttsRes.elapsedMs) || 0;
    }

    const totalPipelineMs = Date.now() - userSpeechStart;
    appendLog('LATENCIA', `⏱️ Total: ${(totalPipelineMs / 1000).toFixed(2)}s ➔ [Voz: ${voiceDurationMs}ms] [STT: ${sttElapsed}ms] [Trad: ${transElapsed}ms] [TTS: ${ttsElapsed}ms]`, 'control');
  }

  async function deliverIncoming({ text, sttElapsed, voiceDurationMs, speechStartTime, backlog = 0, segmentId = null }) {
    const transStart = Date.now();
    const translation = await translateText({
      text,
      sourceLang: 'en',
      targetLang: 'es',
      segmentId,
      pair: { source: 'en', target: 'es' }
    });
    const transElapsed = (translation && translation.elapsedMs) || (Date.now() - transStart);
    if (!translation || !translation.translated || !translation.translated.trim()) return;

    const translatedText = translation.translated.trim();

    // Si el audio capturado del receptor ya era español (ej. eco de los altavoces), descartar para evitar bucles
    if (translation.detectedLang === 'es' || text.toLowerCase() === translatedText.toLowerCase()) {
      appendLog('RECEPTOR', `🔇 Eco de altavoces filtrado: "${text}"`, 'warn');
      return;
    }

    appendLog('RECEPTOR', `✨ Traducido a Español en ${transElapsed}ms: "${translatedText}"`, 'translate');
    previewOrig.textContent = `👤 Receptor (Inglés): ${text}`;
    previewTrans.textContent = `✨ Español: ${translatedText}`;

    ipcRenderer.send('DISPLAY_SUBTITLE', {
      originalText: `Receptor: ${text}`,
      translatedText: translatedText,
      direction: 'incoming',
      isFinal: true
    });

    let ttsElapsed = 0;
    if (backlog >= MAX_TTS_BACKLOG) {
      appendLog('TTS', `⏭️ Voz omitida (${backlog} frases en cola): se muestra solo el subtítulo.`, 'warn');
    } else {
      const ttsRes = await speakSpanishToUser(translatedText);
      ttsElapsed = (ttsRes && ttsRes.elapsedMs) || 0;
    }

    const totalChainMs = Date.now() - speechStartTime;
    appendLog('LATENCIA', `⏱️ Total Receptor: ${(totalChainMs / 1000).toFixed(2)}s ➔ [Voz: ${voiceDurationMs}ms] [STT: ${sttElapsed}ms] [Trad: ${transElapsed}ms] [TTS: ${ttsElapsed}ms]`, 'control');
  }
```

c) En `startIncomingAudioPipeline`, sustituir el bloque que empieza en `if (!isWhisperHallucination(text)) {` y termina en su llave de cierre (líneas 1412–1453: el registro `RECEPTOR Inglés`, la llamada a `TRANSLATE_TEXT`, el filtro de eco, el subtítulo, `speakSpanishToUser` y el registro `LATENCIA`) por:

```js
              if (!isWhisperHallucination(text)) {
                const modelTag = (result && result.model) ? result.model : (engineType === 'gemini_35' ? 'Gemini 3.5' : 'Groq');
                appendLog('RECEPTOR', `Inglés (${modelTag}) en ${sttElapsed}ms: "${text}"`, 'audio');
                outputQueue.push((ctx) => deliverIncoming({
                  text, sttElapsed, voiceDurationMs, speechStartTime, backlog: ctx.backlog
                }));
              }
```

d) En `startUnifiedAudioPipeline`, sustituir el bloque que empieza en `if (!isWhisperHallucination(recognizedText)) {` y termina en su llave de cierre (líneas 1705–1753) por:

```js
                if (!isWhisperHallucination(recognizedText)) {
                  const modelTag = (result && result.model) ? result.model : (engine === 'gemini_35_transcribe' ? 'Gemini 3.5' : 'Groq');
                  appendLog('VOICE', `Reconocido (${modelTag}) en ${sttElapsed}ms: "${recognizedText}"`, 'audio');
                  previewOrig.textContent = `🎙️ ${recognizedText}`;
                  outputQueue.push((ctx) => deliverOutgoing({
                    recognizedText, sttElapsed, voiceDurationMs, userSpeechStart, backlog: ctx.backlog
                  }));
                }
```

Los dos `finally { isTranscribingBlock = false; }` / `isTranscribingIncoming = false;` se quedan como están: ahora se ejecutan en cuanto termina la transcripción.

- [ ] **Step 6: Verificar sintaxis y que no quedan llamadas antiguas**

Run: `node --check index.js && grep -c "outputQueue.push" index.js && grep -n "await speakSpanishToUser\|await playAudioToVirtualCableAndSpeakers(translatedText" index.js`
Expected: sin error de sintaxis; `2`; y las llamadas de voz listadas caen todas dentro de `deliverOutgoing` o `deliverIncoming` (ninguna dentro de un `onaudioprocess`).

- [ ] **Step 7: Commit**

```bash
git add electron_app/output-queue.js electron_app/test/output-queue.test.js electron_app/index.js
git commit -m "feat: cola de salida para no bloquear el microfono durante traduccion y voz"
```

---

### Task 3: Almacén de modelos

**Files:**
- Create: `electron_app/local-ai/model-store.js`
- Create: `electron_app/test/model-store.test.js`
- Create: `electron_app/scripts/download-models.js`

**Interfaces:**
- Produces: `MODEL_FILES` (lista `{ id, file, url, size, sha256 }` con ids `vad`, `encoder`, `decoder`, `tokens`); `createModelStore({ dir, files, fetchImpl }) → { paths(), status(), ensure(onProgress) }`.
  - `paths() → { vad, encoder, decoder, tokens }` (rutas absolutas).
  - `status() → { ready: boolean, missing: [{ id, file, size }], missingBytes: number }`. Un archivo cuenta como presente si existe con el tamaño exacto.
  - `ensure(onProgress) → Promise<void>`; `onProgress({ id, file, loaded, total, overallLoaded, overallTotal })`. Rechaza con `Error` si la descarga falla o no coincide tamaño o SHA-256, tras borrar el parcial.

- [ ] **Step 1: Escribir la prueba que falla**

`electron_app/test/model-store.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createModelStore, MODEL_FILES } = require('../local-ai/model-store');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-models-'));

function fixture() {
  const a = Buffer.from('aaaaaaaaaa');
  const b = Buffer.from('bbbbbbbbbbbbbbbbbbbb');
  const files = [
    { id: 'vad', file: 'a.onnx', url: 'https://example.test/a', size: a.length, sha256: sha(a) },
    { id: 'encoder', file: 'b.onnx', url: 'https://example.test/b', size: b.length, sha256: sha(b) }
  ];
  const bodies = { 'https://example.test/a': a, 'https://example.test/b': b };
  return { files, bodies };
}

function fakeFetch(bodies, { failUrl = null, breakUrl = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === failUrl) return { ok: false, status: 503, body: null };
    const data = bodies[url];
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield data.subarray(0, 5);
        if (url === breakUrl) throw new Error('socket hang up');
        yield data.subarray(5);
      })()
    };
  };
  return { impl, calls };
}

test('la lista real declara los cuatro archivos con tamaño y suma', () => {
  assert.deepEqual(MODEL_FILES.map((f) => f.id), ['vad', 'encoder', 'decoder', 'tokens']);
  for (const f of MODEL_FILES) {
    assert.match(f.url, /^https:\/\//);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 0);
  }
});

test('status informa lo que falta y ensure lo descarga con progreso', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const { impl } = fakeFetch(bodies);
  const store = createModelStore({ dir, files, fetchImpl: impl });

  assert.deepEqual(store.status(), {
    ready: false,
    missing: [{ id: 'vad', file: 'a.onnx', size: 10 }, { id: 'encoder', file: 'b.onnx', size: 20 }],
    missingBytes: 30
  });

  const progress = [];
  await store.ensure((p) => progress.push(p));

  assert.equal(store.status().ready, true);
  assert.equal(fs.readFileSync(store.paths().vad, 'utf8'), 'aaaaaaaaaa');
  const last = progress[progress.length - 1];
  assert.equal(last.overallLoaded, 30);
  assert.equal(last.overallTotal, 30);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.onnx']);
});

test('ensure no vuelve a descargar lo que ya está completo', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx'), bodies['https://example.test/a']);
  const { impl, calls } = fakeFetch(bodies);
  await createModelStore({ dir, files, fetchImpl: impl }).ensure();
  assert.deepEqual(calls, ['https://example.test/b']);
});

test('una suma incorrecta borra el parcial y deja el modelo como faltante', async () => {
  const { files, bodies } = fixture();
  files[0].sha256 = '0'.repeat(64);
  const dir = tmpDir();
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  await assert.rejects(store.ensure(), /a\.onnx/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(store.status().ready, false);
});

test('una descarga cortada a mitad no deja archivo y el reintento funciona', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const broken = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies, { breakUrl: 'https://example.test/a' }).impl });
  await assert.rejects(broken.ensure(), /socket hang up/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const retry = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  await retry.ensure();
  assert.equal(retry.status().ready, true);
});

test('un archivo truncado en disco cuenta como faltante', () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx'), 'aaa');
  fs.writeFileSync(path.join(dir, 'b.onnx'), bodies['https://example.test/b']);
  const status = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl }).status();
  assert.deepEqual(status.missing.map((m) => m.id), ['vad']);
});

test('una respuesta HTTP de error se informa con el archivo y el código', async () => {
  const { files, bodies } = fixture();
  const store = createModelStore({ dir: tmpDir(), files, fetchImpl: fakeFetch(bodies, { failUrl: 'https://example.test/a' }).impl });
  await assert.rejects(store.ensure(), /a\.onnx.*503/);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL con `Cannot find module '../local-ai/model-store'`.

- [ ] **Step 3: Implementar**

`electron_app/local-ai/model-store.js`:

```js
/**
 * model-store.js - Modelos del motor local: dónde están, cuáles faltan y descarga verificada
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const CANARY = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/resolve/main/';

const MODEL_FILES = [
  {
    id: 'vad',
    file: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
  },
  {
    id: 'encoder',
    file: 'canary-encoder.int8.onnx',
    url: CANARY + 'encoder.int8.onnx',
    size: 132678643,
    sha256: '7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f'
  },
  {
    id: 'decoder',
    file: 'canary-decoder.int8.onnx',
    url: CANARY + 'decoder.int8.onnx',
    size: 74437848,
    sha256: 'e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2'
  },
  {
    id: 'tokens',
    file: 'canary-tokens.txt',
    url: CANARY + 'tokens.txt',
    size: 53555,
    sha256: '2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77'
  }
];

function createModelStore({ dir, files = MODEL_FILES, fetchImpl = fetch }) {
  const fileFor = (f) => path.join(dir, f.file);

  function isPresent(f) {
    try {
      return fs.statSync(fileFor(f)).size === f.size;
    } catch {
      return false;
    }
  }

  function status() {
    const missing = files.filter((f) => !isPresent(f)).map((f) => ({ id: f.id, file: f.file, size: f.size }));
    return { ready: missing.length === 0, missing, missingBytes: missing.reduce((n, f) => n + f.size, 0) };
  }

  async function download(f, onChunk) {
    const target = fileFor(f);
    const part = target + '.part';
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let loaded = 0;
    try {
      const res = await fetchImpl(f.url);
      if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${f.file} (HTTP ${res.status})`);
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        loaded += buf.length;
        if (!out.write(buf)) await once(out, 'drain');
        onChunk(buf.length, loaded);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (loaded !== f.size || hash.digest('hex') !== f.sha256) {
        throw new Error(`Descarga corrupta de ${f.file}: no coincide el tamaño o la suma de verificación`);
      }
      fs.renameSync(part, target);
    } catch (err) {
      out.destroy();
      if (!out.closed) await once(out, 'close').catch(() => {});
      fs.rmSync(part, { force: true });
      throw err;
    }
  }

  async function ensure(onProgress = () => {}) {
    fs.mkdirSync(dir, { recursive: true });
    const todo = files.filter((f) => !isPresent(f));
    const overallTotal = todo.reduce((n, f) => n + f.size, 0);
    let overallLoaded = 0;
    for (const f of todo) {
      fs.rmSync(fileFor(f), { force: true });
      await download(f, (delta, loaded) => {
        overallLoaded += delta;
        onProgress({ id: f.id, file: f.file, loaded, total: f.size, overallLoaded, overallTotal });
      });
    }
  }

  function paths() {
    return Object.fromEntries(files.map((f) => [f.id, fileFor(f)]));
  }

  return { paths, status, ensure };
}

module.exports = { MODEL_FILES, createModelStore };
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 16 pruebas, 0 fallos.

- [ ] **Step 5: Script de descarga para desarrollo y pruebas**

`electron_app/scripts/download-models.js`:

```js
/**
 * download-models.js - Descarga los modelos del motor local a electron_app/.models (para pruebas)
 */

const path = require('path');
const { createModelStore } = require('../local-ai/model-store');

const dir = process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '.models');
const store = createModelStore({ dir });

(async () => {
  const before = store.status();
  if (before.ready) {
    console.log(`Modelos listos en ${dir}`);
    return;
  }
  console.log(`Descargando ${(before.missingBytes / 1e6).toFixed(0)} MB a ${dir}...`);
  let lastPct = -1;
  await store.ensure((p) => {
    const pct = Math.floor((p.overallLoaded / p.overallTotal) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      console.log(`  ${pct}% (${p.file})`);
    }
  });
  console.log('Modelos descargados y verificados.');
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 6: Descargar de verdad (verifica URLs, tamaños y sumas reales)**

Run: `npm run models`
Expected: termina con `Modelos descargados y verificados.` y `ls -la .models` muestra los cuatro archivos con los tamaños de `MODEL_FILES`. Si un archivo falla por suma, comparar con `sha256sum` del archivo descargado a mano desde su URL y detenerse a informar: no cambiar la suma sin entender la diferencia.

- [ ] **Step 7: Commit**

```bash
git add electron_app/local-ai/model-store.js electron_app/test/model-store.test.js electron_app/scripts/download-models.js
git commit -m "feat(local-ai): almacen de modelos con descarga verificada"
```

---

### Task 4: Audios de prueba y utilidades

**Files:**
- Create: `electron_app/test/fixtures/phrases.json`
- Create: `electron_app/test/fixtures/generate-audio.ps1`
- Create: `electron_app/test/fixtures/audio/*.wav` (generados y subidos a git)
- Create: `electron_app/test/support/wav.js`, `electron_app/test/support/text.js`, `electron_app/test/support/noise.js`
- Create: `electron_app/test/support.test.js`

**Interfaces:**
- Produces: `readWav(file) → Float32Array` (exige PCM 16 bit mono 16 kHz), `writeWav(file, samples)`; `normalizeText(s)`, `wordErrorRate(reference, hypothesis) → number`, `hasKeywords(text, keywords) → boolean`; `pinkNoise(length, seed) → Float32Array`, `mixAtSnr(speech, noise, snrDb) → Float32Array`, `rms(samples)`.
- Produces: `phrases.json` con `{ es: [{ id, text, keywordsEn }], en: [{ id, text, keywordsEs }] }`; audio en `test/fixtures/audio/<id>.wav`.

- [ ] **Step 1: Frases**

`electron_app/test/fixtures/phrases.json`:

```json
{
  "es": [
    { "id": "es1", "text": "¿Puedes enviarme el informe antes del viernes?", "keywordsEn": ["report", "friday"] },
    { "id": "es2", "text": "Buenos días a todos, gracias por unirse a la reunión de hoy.", "keywordsEn": ["morning", "meeting", "today"] },
    { "id": "es3", "text": "Necesitamos revisar el presupuesto trimestral.", "keywordsEn": ["budget"] },
    { "id": "es4", "text": "El cliente quiere una demostración la próxima semana.", "keywordsEn": ["week"] },
    { "id": "es5", "text": "Creo que deberíamos posponer el lanzamiento hasta el próximo mes.", "keywordsEn": ["month"] }
  ],
  "en": [
    { "id": "en1", "text": "Can you send me the report before Friday?", "keywordsEs": ["informe", "viernes"] },
    { "id": "en2", "text": "Good morning everyone, thank you for joining the meeting today.", "keywordsEs": ["reunión", "hoy"] },
    { "id": "en3", "text": "We need to review the quarterly budget.", "keywordsEs": ["presupuesto"] },
    { "id": "en4", "text": "The customer wants a demonstration next week.", "keywordsEs": ["cliente", "semana"] },
    { "id": "en5", "text": "I think we should postpone the launch until next month.", "keywordsEs": ["mes"] }
  ]
}
```

- [ ] **Step 2: Generador de audio (voces de Windows)**

`electron_app/test/fixtures/generate-audio.ps1`:

```powershell
# generate-audio.ps1 - Genera los WAV de prueba (16 kHz mono) con las voces de Windows
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'audio'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$voices = @{ es = 'Microsoft Sabina Desktop'; en = 'Microsoft Zira Desktop' }
$phrases = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'phrases.json') | ConvertFrom-Json

foreach ($lang in 'es', 'en') {
  foreach ($p in $phrases.$lang) {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voices[$lang])
    $synth.SetOutputToWaveFile((Join-Path $out "$($p.id).wav"), $format)
    $synth.Speak($p.text)
    $synth.Dispose()
    Write-Output "$($p.id).wav"
  }
}
```

Run: `npm run fixtures`
Expected: lista `es1.wav` … `en5.wav`; `ls test/fixtures/audio | wc -l` → `10`.

- [ ] **Step 3: Escribir la prueba de las utilidades (falla)**

`electron_app/test/support.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWav, writeWav } = require('./support/wav');
const { normalizeText, wordErrorRate, hasKeywords } = require('./support/text');
const { pinkNoise, mixAtSnr, rms } = require('./support/noise');

test('writeWav y readWav son inversos (con el error de 16 bits)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-wav-')), 't.wav');
  const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
  writeWav(file, samples);
  const back = readWav(file);
  assert.equal(back.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back[i] - samples[i]) < 1e-3);
});

test('readWav lee los audios generados: mono, 16 kHz, más de 1 s', () => {
  const samples = readWav(path.join(__dirname, 'fixtures', 'audio', 'es1.wav'));
  assert.ok(samples.length > 16000);
  assert.ok(rms(samples) > 0.01);
});

test('normalizeText quita mayúsculas, tildes y puntuación', () => {
  assert.equal(normalizeText('¿Puedes enviarme el INFORME, por favor?'), 'puedes enviarme el informe por favor');
  assert.equal(normalizeText('Reunión de hoy.'), 'reunion de hoy');
});

test('wordErrorRate cuenta sustituciones, inserciones y omisiones sobre la referencia', () => {
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno dos tres cuatro'), 0);
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno dos tres'), 0.25);
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno DOS, tres cinco'), 0.25);
  assert.equal(wordErrorRate('uno dos', ''), 1);
});

test('hasKeywords ignora tildes y mayúsculas y exige todas', () => {
  assert.equal(hasKeywords('La Reunion es hoy', ['reunión', 'hoy']), true);
  assert.equal(hasKeywords('La reunión es mañana', ['reunión', 'hoy']), false);
});

test('pinkNoise es determinista y mixAtSnr respeta la relación pedida', () => {
  assert.deepEqual(Array.from(pinkNoise(100, 7)), Array.from(pinkNoise(100, 7)));
  const speech = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 5));
  const noise = pinkNoise(16000, 1);
  const mixed = mixAtSnr(speech, noise, 10);
  const residual = mixed.map((v, i) => v - speech[i]);
  const snr = 20 * Math.log10(rms(speech) / rms(residual));
  assert.ok(Math.abs(snr - 10) < 0.2, `snr=${snr}`);
});
```

Run: `npm test`
Expected: FAIL con `Cannot find module './support/wav'`.

- [ ] **Step 4: Implementar las utilidades**

`electron_app/test/support/wav.js`:

```js
const fs = require('node:fs');

/** Lee un WAV PCM de 16 bits, mono, 16 kHz y devuelve muestras en [-1, 1]. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} no es un WAV`);
  }
  let offset = 12;
  let format = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
        throw new Error(`${file} debe ser PCM 16 bits mono 16 kHz`);
      }
      const count = Math.floor(Math.min(size, buf.length - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      return samples;
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file} no tiene bloque de datos`);
}

/** Escribe muestras en [-1, 1] como WAV PCM de 16 bits, mono, 16 kHz. */
function writeWav(file, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

module.exports = { readWav, writeWav };
```

`electron_app/test/support/text.js`:

```js
function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tasa de error de palabras: distancia de edición entre palabras dividida por las palabras de la referencia. */
function wordErrorRate(reference, hypothesis) {
  const ref = normalizeText(reference).split(' ').filter(Boolean);
  const hyp = normalizeText(hypothesis).split(' ').filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[hyp.length] / ref.length;
}

function hasKeywords(text, keywords) {
  const haystack = ` ${normalizeText(text)} `;
  return keywords.every((k) => haystack.includes(normalizeText(k)));
}

module.exports = { normalizeText, wordErrorRate, hasKeywords };
```

`electron_app/test/support/noise.js`:

```js
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
```

- [ ] **Step 5: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 22 pruebas, 0 fallos.

- [ ] **Step 6: Commit**

```bash
git add electron_app/test/fixtures electron_app/test/support electron_app/test/support.test.js
git commit -m "test: audios generados EN/ES y utilidades de WAV, texto y ruido"
```

---

### Task 5: Segmentador, transcriptor y motor

**Files:**
- Modify: `electron_app/package.json` (dependencia `sherpa-onnx-node`)
- Create: `electron_app/local-ai/segmenter.js`, `electron_app/local-ai/transcriber.js`, `electron_app/local-ai/engine.js`
- Create: `electron_app/test/engine.test.js` (unidad, con dobles)
- Create: `electron_app/test/support/models.js`
- Create: `electron_app/test/segmenter.integration.test.js` (con el modelo real)

**Interfaces:**
- Consumes: `createModelStore` (Task 3), `readWav`, `pinkNoise` (Task 4).
- Produces:
  - `thresholdFromNoiseGate(value) → number` y `createSegmenter({ sherpa, modelPath, threshold }) → { push(samples) → Segment[], flush() → Segment[], isSpeaking() → boolean }` con `Segment = { samples: Float32Array }`.
  - `createTranscriber({ sherpa, paths, numThreads }) → { transcribe(samples, lang) → { text, ms }, translate(samples, source, target) → { text, ms } }`.
  - `createEngine({ sherpa, paths, post, vadThreshold, makeSegmenter, makeTranscriber }) → { handle(msg) }`.
  - Mensajes de entrada de `handle`: `{ type: 'audio', stream, lang, samples }`, `{ type: 'flush', stream, lang }`, `{ type: 'translate', id, target }`, `{ type: 'reset' }`.
  - Mensajes de salida por `post`: `{ type: 'segment', id, stream, lang, text, durationMs, sttMs }`, `{ type: 'vad', stream, speaking }`, `{ type: 'translation', id, text, ms }` o `{ type: 'translation', id, error }`.
  - `test/support/models.js`: `modelsDir`, `store`, `modelsReady`, `skipReason`.

- [ ] **Step 1: Instalar la dependencia**

Run: `npm install sherpa-onnx-node@1.13.8 --save-exact`
Expected: `package.json` gana `"sherpa-onnx-node": "1.13.8"` en `dependencies` y existe `node_modules/sherpa-onnx-win-x64/`.

- [ ] **Step 2: Escribir la prueba de unidad del motor (falla)**

`electron_app/test/engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../local-ai/engine');
const { thresholdFromNoiseGate } = require('../local-ai/segmenter');

const seg = (ms) => ({ samples: new Float32Array(ms * 16) });

/** Motor con dobles: `queue` son los lotes de segmentos que devolverá cada push; `texts` lo que "oye" el modelo. */
function setup({ queue = [], texts = [], speaking = [] } = {}) {
  const posted = [];
  const calls = [];
  const engine = createEngine({
    sherpa: {},
    paths: {},
    post: (m) => posted.push(m),
    makeSegmenter: () => ({
      push: () => queue.shift() || [],
      flush: () => queue.shift() || [],
      isSpeaking: () => (speaking.length ? speaking.shift() : false)
    }),
    makeTranscriber: () => ({
      transcribe: (samples, lang) => { calls.push(['transcribe', samples.length, lang]); return { text: texts.shift() ?? '', ms: 5 }; },
      translate: (samples, source, target) => { calls.push(['translate', samples.length, source, target]); return { text: 'translated', ms: 7 }; }
    })
  });
  const audio = (stream = 'mic', lang = 'es') => engine.handle({ type: 'audio', stream, lang, samples: new Float32Array(2048) });
  return { engine, posted, calls, audio };
}

test('un segmento de voz se transcribe y se publica con su duración e identificador', () => {
  const t = setup({ queue: [[seg(1500)]], texts: ['Hola a todos.'] });
  t.audio('mic', 'es');
  assert.deepEqual(t.posted, [{ type: 'segment', id: 1, stream: 'mic', lang: 'es', text: 'Hola a todos.', durationMs: 1500, sttMs: 5 }]);
  assert.deepEqual(t.calls, [['transcribe', 24000, 'es']]);
});

test('un segmento de menos de 400 ms se descarta sin llamar al modelo (tos, clic)', () => {
  const t = setup({ queue: [[seg(399)]], texts: ['sí'] });
  t.audio();
  assert.deepEqual(t.posted, []);
  assert.deepEqual(t.calls, []);
});

test('el texto vacío o de solo signos no se publica', () => {
  const t = setup({ queue: [[seg(800), seg(800), seg(800)]], texts: ['', ' ... ', '¿?'] });
  t.audio();
  assert.deepEqual(t.posted, []);
});

test('frases cortas reales como «Gracias.» sí se publican', () => {
  const t = setup({ queue: [[seg(600)]], texts: ['Gracias.'] });
  t.audio();
  assert.equal(t.posted[0].text, 'Gracias.');
});

test('el cambio de estado de voz se avisa una sola vez por cambio', () => {
  const t = setup({ speaking: [true, true, false] });
  t.audio(); t.audio(); t.audio();
  assert.deepEqual(t.posted, [{ type: 'vad', stream: 'mic', speaking: true }, { type: 'vad', stream: 'mic', speaking: false }]);
});

test('micrófono y receptor tienen segmentadores independientes', () => {
  const t = setup({ queue: [[seg(900)], [seg(700)]], texts: ['uno', 'two'] });
  t.audio('mic', 'es');
  t.audio('incoming', 'en');
  assert.deepEqual(t.posted.map((m) => [m.stream, m.lang, m.text]), [['mic', 'es', 'uno'], ['incoming', 'en', 'two']]);
});

test('translate usa el audio guardado del segmento y su idioma de origen', () => {
  const t = setup({ queue: [[seg(1000)]], texts: ['Hola.'] });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'translate', id: 1, target: 'en' });
  assert.deepEqual(t.calls[1], ['translate', 16000, 'es', 'en']);
  assert.deepEqual(t.posted[1], { type: 'translation', id: 1, text: 'translated', ms: 7 });
});

test('translate de un segmento desconocido o ya caducado responde con error', () => {
  const batch = Array.from({ length: 9 }, () => seg(500));
  const t = setup({ queue: [batch], texts: batch.map((_, i) => `frase ${i}`) });
  t.audio();
  t.engine.handle({ type: 'translate', id: 1, target: 'en' });
  t.engine.handle({ type: 'translate', id: 99, target: 'en' });
  const answers = t.posted.filter((m) => m.type === 'translation');
  assert.deepEqual(answers, [
    { type: 'translation', id: 1, error: 'El audio de esa frase ya no está disponible' },
    { type: 'translation', id: 99, error: 'El audio de esa frase ya no está disponible' }
  ]);
  t.engine.handle({ type: 'translate', id: 9, target: 'en' });
  assert.equal(t.posted[t.posted.length - 1].text, 'translated');
});

test('flush publica lo que quedaba a medias', () => {
  const t = setup({ queue: [[], [seg(900)]], texts: ['última frase'] });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'flush', stream: 'mic', lang: 'es' });
  assert.equal(t.posted[0].text, 'última frase');
});

test('thresholdFromNoiseGate traduce el selector de sensibilidad al umbral de Silero', () => {
  assert.equal(thresholdFromNoiseGate('0.008'), 0.35);
  assert.equal(thresholdFromNoiseGate('0.016'), 0.5);
  assert.equal(thresholdFromNoiseGate('0.030'), 0.6);
  assert.equal(thresholdFromNoiseGate('0.055'), 0.75);
  assert.equal(thresholdFromNoiseGate(undefined), 0.5);
});
```

Run: `npm test`
Expected: FAIL con `Cannot find module '../local-ai/engine'`.

- [ ] **Step 3: Implementar segmentador**

`electron_app/local-ai/segmenter.js`:

```js
/**
 * segmenter.js - Convierte tramas de audio en segmentos de voz con Silero VAD
 */

const WINDOW = 512;

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
  const vad = new sherpa.Vad({
    sileroVad: {
      model: modelPath,
      threshold,
      minSilenceDuration: 0.35,
      minSpeechDuration: 0.4,
      windowSize: WINDOW,
      maxSpeechDuration: 6
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu'
  }, 30);

  let rest = new Float32Array(0);

  function drain() {
    const segments = [];
    while (!vad.isEmpty()) {
      // false: Electron no admite búferes externos
      segments.push({ samples: Float32Array.from(vad.front(false).samples) });
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
        vad.acceptWaveform(all.slice(i, i + WINDOW));
      }
      rest = all.slice(i);
      return drain();
    },
    flush() {
      vad.flush();
      rest = new Float32Array(0);
      return drain();
    },
    isSpeaking: () => vad.isDetected()
  };
}

module.exports = { createSegmenter, thresholdFromNoiseGate };
```

- [ ] **Step 4: Implementar transcriptor**

`electron_app/local-ai/transcriber.js`:

```js
/**
 * transcriber.js - Transcribe o traduce un segmento de voz con NeMo Canary (EN y ES en un solo modelo)
 */

function createTranscriber({ sherpa, paths, numThreads = 2 }) {
  const config = (source, target) => ({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      canary: { encoder: paths.encoder, decoder: paths.decoder, srcLang: source, tgtLang: target, usePnc: 1 },
      tokens: paths.tokens,
      numThreads,
      provider: 'cpu'
    }
  });

  const recognizer = new sherpa.OfflineRecognizer(config('en', 'en'));

  function decode(samples, source, target) {
    recognizer.setConfig(config(source, target)); // cambia de idioma sin recargar el modelo
    const stream = recognizer.createStream();
    const started = Date.now();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    return { text: (recognizer.getResult(stream).text || '').trim(), ms: Date.now() - started };
  }

  return {
    transcribe: (samples, lang) => decode(samples, lang, lang),
    translate: (samples, source, target) => decode(samples, source, target)
  };
}

module.exports = { createTranscriber };
```

- [ ] **Step 5: Implementar motor**

`electron_app/local-ai/engine.js`:

```js
/**
 * engine.js - Motor local: tramas ➔ segmentos de voz ➔ texto. No depende de Electron.
 */

const { createSegmenter } = require('./segmenter');
const { createTranscriber } = require('./transcriber');

const MIN_SEGMENT_SAMPLES = 6400; // 400 ms: por debajo el modelo inventa palabras
const KEEP_SEGMENTS = 8; // audio que se conserva para poder traducir en local después
const HAS_WORDS = /[\p{L}\p{N}]/u;

function createEngine({ sherpa, paths, post, vadThreshold = 0.5, makeSegmenter = createSegmenter, makeTranscriber = createTranscriber }) {
  const transcriber = makeTranscriber({ sherpa, paths });
  const streams = new Map();
  const kept = new Map();
  let nextId = 1;

  function streamFor(name) {
    if (!streams.has(name)) {
      streams.set(name, {
        segmenter: makeSegmenter({ sherpa, modelPath: paths.vad, threshold: vadThreshold }),
        speaking: false
      });
    }
    return streams.get(name);
  }

  function publish(stream, lang, segments) {
    for (const segment of segments) {
      if (segment.samples.length < MIN_SEGMENT_SAMPLES) continue;
      const { text, ms } = transcriber.transcribe(segment.samples, lang);
      if (!text || !HAS_WORDS.test(text)) continue;
      const id = nextId++;
      kept.set(id, { samples: segment.samples, lang });
      if (kept.size > KEEP_SEGMENTS) kept.delete(kept.keys().next().value);
      post({ type: 'segment', id, stream, lang, text, durationMs: Math.round(segment.samples.length / 16), sttMs: ms });
    }
  }

  return {
    handle(msg) {
      if (msg.type === 'audio') {
        const state = streamFor(msg.stream);
        const segments = state.segmenter.push(msg.samples);
        const speaking = state.segmenter.isSpeaking();
        if (speaking !== state.speaking) {
          state.speaking = speaking;
          post({ type: 'vad', stream: msg.stream, speaking });
        }
        publish(msg.stream, msg.lang, segments);
      } else if (msg.type === 'flush') {
        publish(msg.stream, msg.lang, streamFor(msg.stream).segmenter.flush());
      } else if (msg.type === 'translate') {
        const segment = kept.get(msg.id);
        if (!segment) {
          post({ type: 'translation', id: msg.id, error: 'El audio de esa frase ya no está disponible' });
          return;
        }
        const { text, ms } = transcriber.translate(segment.samples, segment.lang, msg.target);
        post({ type: 'translation', id: msg.id, text, ms });
      } else if (msg.type === 'reset') {
        streams.clear();
        kept.clear();
      }
    }
  };
}

module.exports = { createEngine, MIN_SEGMENT_SAMPLES };
```

- [ ] **Step 6: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 32 pruebas, 0 fallos.

- [ ] **Step 7: Prueba del segmentador con el modelo real**

`electron_app/test/support/models.js`:

```js
const path = require('node:path');
const { createModelStore } = require('../../local-ai/model-store');

const modelsDir = process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '..', '.models');
const store = createModelStore({ dir: modelsDir });
const modelsReady = store.status().ready;
const skipReason = modelsReady ? false : `faltan los modelos en ${modelsDir}: ejecuta "npm run models"`;

module.exports = { modelsDir, store, modelsReady, skipReason };
```

`electron_app/test/segmenter.integration.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const { pinkNoise } = require('./support/noise');
const { createSegmenter } = require('../local-ai/segmenter');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));

/** Envía el audio en tramas de 2048 muestras, como el renderer, y añade 1 s de silencio final. */
function run(samples) {
  const sherpa = require('sherpa-onnx-node');
  const segmenter = createSegmenter({ sherpa, modelPath: store.paths().vad });
  const padded = new Float32Array(samples.length + 16000);
  padded.set(samples);
  const segments = [];
  for (let i = 0; i < padded.length; i += 2048) segments.push(...segmenter.push(padded.slice(i, i + 2048)));
  segments.push(...segmenter.flush());
  return segments;
}

test('una frase produce al menos un segmento y cubre casi toda la voz', { skip: skipReason }, () => {
  const samples = audio('es1');
  const segments = run(samples);
  assert.ok(segments.length >= 1);
  const total = segments.reduce((n, s) => n + s.samples.length, 0);
  assert.ok(total > samples.length * 0.5, `solo ${total} de ${samples.length} muestras`);
});

test('cinco segundos de solo ruido no producen ningún segmento', { skip: skipReason }, () => {
  const noise = pinkNoise(80000, 3).map((v) => v * 4);
  assert.equal(run(noise).length, 0);
});

test('un golpe de 200 ms no produce ningún segmento', { skip: skipReason }, () => {
  const blip = new Float32Array(32000);
  blip.set(audio('es1').slice(8000, 11200), 8000);
  assert.equal(run(blip).length, 0);
});

test('habla larga y seguida se corta en segmentos de 7 s como máximo', { skip: skipReason }, () => {
  const parts = ['es2', 'es3', 'es4', 'es5'].map(audio);
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { joined.set(p, offset); offset += p.length; }
  const segments = run(joined);
  assert.ok(segments.length >= 2);
  for (const s of segments) assert.ok(s.samples.length <= 7 * 16000, `segmento de ${s.samples.length / 16000}s`);
});
```

Run: `npm test`
Expected: 36 pruebas, 0 fallos, 0 omitidas (los modelos se descargaron en Task 3).

- [ ] **Step 8: Commit**

```bash
git add electron_app/package.json electron_app/package-lock.json electron_app/local-ai/segmenter.js electron_app/local-ai/transcriber.js electron_app/local-ai/engine.js electron_app/test/engine.test.js electron_app/test/support/models.js electron_app/test/segmenter.integration.test.js
git commit -m "feat(local-ai): segmentador Silero, transcriptor Canary y motor"
```

---

### Task 6: Proceso utilitario y cliente

**Files:**
- Create: `electron_app/local-ai/worker.js`
- Create: `electron_app/local-ai/client.js`
- Create: `electron_app/test/client.test.js`

**Interfaces:**
- Consumes: `createEngine` (Task 5).
- Produces: `createLocalAiClient({ fork, workerPath, onEvent, now }) → { start(init) → Promise<{ loadMs }>, send(msg), translate(id, target) → Promise<{ text, ms }>, stop(), isRunning() }`.
  - `fork(workerPath)` devuelve un objeto con `on('message' | 'exit', fn)`, `postMessage(msg)` y `kill()` (la forma de `utilityProcess.fork`).
  - `init = { paths, vadThreshold }`.
  - `onEvent(msg)` recibe `segment`, `vad` y `error` (`{ type: 'error', stage, message, fatal }`). Las respuestas `ready` y `translation` no pasan por `onEvent`.

- [ ] **Step 1: Escribir la prueba que falla**

`electron_app/test/client.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalAiClient } = require('../local-ai/client');

function setup() {
  const children = [];
  const events = [];
  let clock = 1000;
  const fork = (workerPath) => {
    const child = new EventEmitter();
    child.workerPath = workerPath;
    child.sent = [];
    child.killed = false;
    child.postMessage = (m) => child.sent.push(m);
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const client = createLocalAiClient({ fork, workerPath: '/app/worker.js', onEvent: (e) => events.push(e), now: () => clock });
  const init = { paths: { vad: 'v' }, vadThreshold: 0.5 };
  // stop() y las caídas rechazan el start pendiente: se silencia aquí para las pruebas que no lo esperan
  const start = () => { const p = client.start(init); p.catch(() => {}); return p; };
  return { client, children, events, init, start, advance: (ms) => { clock += ms; } };
}

test('start lanza el proceso, envía init y se resuelve cuando el motor está listo', async () => {
  const t = setup();
  const started = t.start();
  assert.equal(t.children[0].workerPath, '/app/worker.js');
  assert.deepEqual(t.children[0].sent, [{ type: 'init', paths: { vad: 'v' }, vadThreshold: 0.5 }]);
  t.children[0].emit('message', { type: 'ready', loadMs: 1400 });
  assert.deepEqual(await started, { loadMs: 1400 });
  assert.equal(t.client.isRunning(), true);
});

test('start falla con el mensaje del motor si los modelos no cargan', async () => {
  const t = setup();
  const started = t.start();
  t.children[0].emit('message', { type: 'error', stage: 'init', message: 'modelo ilegible' });
  await assert.rejects(started, /modelo ilegible/);
});

test('los segmentos y avisos de voz llegan a onEvent; send reenvía al proceso', async () => {
  const t = setup();
  const started = t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  await started;
  t.client.send({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(4) });
  assert.equal(t.children[0].sent[1].type, 'audio');
  t.children[0].emit('message', { type: 'segment', id: 1, text: 'Hola.' });
  assert.deepEqual(t.events, [{ type: 'segment', id: 1, text: 'Hola.' }]);
});

test('translate se resuelve con la respuesta de su identificador o falla con su error', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  const ok = t.client.translate(3, 'en');
  const bad = t.client.translate(4, 'en');
  assert.deepEqual(t.children[0].sent.slice(1), [{ type: 'translate', id: 3, target: 'en' }, { type: 'translate', id: 4, target: 'en' }]);
  t.children[0].emit('message', { type: 'translation', id: 4, error: 'ya no está' });
  t.children[0].emit('message', { type: 'translation', id: 3, text: 'Hello.', ms: 400 });
  assert.deepEqual(await ok, { text: 'Hello.', ms: 400 });
  await assert.rejects(bad, /ya no está/);
  assert.deepEqual(t.events, []);
});

test('si el proceso muere se reinicia una vez con el mismo init y avisa sin ser fatal', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  const pending = t.client.translate(1, 'en');
  t.children[0].emit('exit', 1);
  await assert.rejects(pending, /se cerró/);
  assert.equal(t.children.length, 2);
  assert.deepEqual(t.children[1].sent, [{ type: 'init', paths: { vad: 'v' }, vadThreshold: 0.5 }]);
  assert.deepEqual(t.events, [{ type: 'error', stage: 'worker', fatal: false, message: 'El motor local se cerró y se está reiniciando.' }]);
  assert.equal(t.client.isRunning(), true);
});

test('una segunda caída en menos de 30 s es fatal y no se reinicia más', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('exit', 1);
  t.advance(10000);
  t.children[1].emit('exit', 1);
  assert.equal(t.children.length, 2);
  assert.equal(t.events[1].fatal, true);
  assert.match(t.events[1].message, /dos veces/);
  assert.equal(t.client.isRunning(), false);
});

test('una caída pasados 30 s se trata como la primera', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('exit', 1);
  t.advance(31000);
  t.children[1].emit('exit', 1);
  assert.equal(t.children.length, 3);
  assert.equal(t.events[1].fatal, false);
});

test('stop mata el proceso, no lo reinicia y send deja de hacer nada', async () => {
  const t = setup();
  t.start();
  t.client.stop();
  assert.equal(t.children[0].killed, true);
  t.children[0].emit('exit', 0);
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.events, []);
  t.client.send({ type: 'audio' });
  await assert.rejects(t.client.translate(1, 'en'), /detenido/);
});

test('start sobre un cliente en marcha reemplaza el proceso anterior', async () => {
  const t = setup();
  t.start();
  t.start();
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].killed, true);
  t.children[0].emit('exit', 0);
  assert.equal(t.children.length, 2);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL con `Cannot find module '../local-ai/client'`.

- [ ] **Step 3: Implementar el cliente**

`electron_app/local-ai/client.js`:

```js
/**
 * client.js - Lado del proceso principal: lanza el motor local, lo reinicia si muere y habla con él
 */

const RESTART_WINDOW_MS = 30000;

function createLocalAiClient({ fork, workerPath, onEvent, now = Date.now }) {
  let child = null;
  let initMsg = null;
  let lastCrashAt = -Infinity;
  let readyWaiters = [];
  const translations = new Map();

  function failPending(error) {
    for (const waiter of translations.values()) waiter.reject(error);
    translations.clear();
    for (const waiter of readyWaiters.splice(0)) waiter.reject(error);
  }

  function spawn() {
    const proc = fork(workerPath);
    child = proc;

    proc.on('message', (msg) => {
      if (proc !== child) return;
      if (msg.type === 'ready') {
        for (const waiter of readyWaiters.splice(0)) waiter.resolve({ loadMs: msg.loadMs });
      } else if (msg.type === 'translation') {
        const waiter = translations.get(msg.id);
        if (!waiter) return;
        translations.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve({ text: msg.text, ms: msg.ms });
      } else if (msg.type === 'error' && msg.stage === 'init') {
        for (const waiter of readyWaiters.splice(0)) waiter.reject(new Error(msg.message));
      } else {
        onEvent(msg);
      }
    });

    proc.on('exit', (code) => {
      if (proc !== child) return; // lo detuvimos nosotros o ya fue reemplazado
      child = null;
      const crashedAt = now();
      const again = crashedAt - lastCrashAt < RESTART_WINDOW_MS;
      lastCrashAt = crashedAt;
      if (again) {
        failPending(new Error('El motor local se cerró'));
        onEvent({ type: 'error', stage: 'worker', fatal: true, message: `El motor local falló dos veces seguidas (código ${code}). Cambia a un motor en la nube o reinicia la aplicación.` });
        return;
      }
      for (const waiter of translations.values()) waiter.reject(new Error('El motor local se cerró'));
      translations.clear();
      onEvent({ type: 'error', stage: 'worker', fatal: false, message: 'El motor local se cerró y se está reiniciando.' });
      spawn();
      child.postMessage(initMsg);
    });

    return proc;
  }

  function stop() {
    const proc = child;
    child = null;
    failPending(new Error('Motor local detenido'));
    if (proc) proc.kill();
  }

  return {
    start(init) {
      stop();
      initMsg = { type: 'init', ...init };
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        spawn().postMessage(initMsg);
      });
    },
    send(msg) {
      if (child) child.postMessage(msg);
    },
    translate(id, target) {
      return new Promise((resolve, reject) => {
        if (!child) return reject(new Error('Motor local detenido'));
        translations.set(id, { resolve, reject });
        child.postMessage({ type: 'translate', id, target });
      });
    },
    stop,
    isRunning: () => child !== null
  };
}

module.exports = { createLocalAiClient };
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 45 pruebas, 0 fallos.

- [ ] **Step 5: Punto de entrada del proceso utilitario**

`electron_app/local-ai/worker.js`:

```js
/**
 * worker.js - Proceso utilitario de Electron que ejecuta el motor local fuera de la interfaz
 */

const sherpa = require('sherpa-onnx-node');
const { createEngine } = require('./engine');

let engine = null;
const post = (msg) => process.parentPort.postMessage(msg);

process.parentPort.on('message', (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      const started = Date.now();
      engine = createEngine({ sherpa, paths: msg.paths, vadThreshold: msg.vadThreshold, post });
      post({ type: 'ready', loadMs: Date.now() - started });
      return;
    }
    if (!engine) throw new Error('El motor local no está inicializado');
    engine.handle(msg);
  } catch (err) {
    post({ type: 'error', stage: msg.type, message: err.message, fatal: false });
  }
});
```

Run: `node --check local-ai/worker.js`
Expected: sin salida (sintaxis correcta). Se ejercita de verdad en Task 10.

- [ ] **Step 6: Commit**

```bash
git add electron_app/local-ai/worker.js electron_app/local-ai/client.js electron_app/test/client.test.js
git commit -m "feat(local-ai): proceso utilitario y cliente con reinicio"
```

---

### Task 7: Enrutador de traducción y canales en `main.js`

**Files:**
- Create: `electron_app/local-ai/translate-route.js`
- Create: `electron_app/test/translate-route.test.js`
- Modify: `electron_app/main.js` (import de Electron línea 7; tras línea 42; los cuatro `return` de `TRANSLATE_TEXT` en 392, 396, 407, 418 y 424; `will-quit` línea 232; canales nuevos tras `TRANSCRIBE_GEMINI_35`)

**Interfaces:**
- Consumes: `createModelStore` (Task 3), `createLocalAiClient` (Task 6).
- Produces: `createTranslateRouter({ cloud, local, isOnline, getMode }) → translate({ text, sourceLang, targetLang, segmentId, pair })`.
  - `cloud({ text, sourceLang, targetLang })` → resultado de `TRANSLATE_TEXT`, ahora con `engine: 'google' | 'groq' | 'mymemory' | 'none'`.
  - `local({ id, target })` → `{ ok, translated, elapsedMs }` o `{ ok: false, error }`.
  - Devuelve `{ original, translated, detectedLang, targetLang, elapsedMs, engine }`; `engine: 'local'` cuando tradujo Canary.
- Produces (IPC): `LOCAL_AI_STATUS` (invoke) → `store.status()`; `LOCAL_AI_PREPARE` (invoke, `{ vadThreshold }`) → `{ ok, loadMs }` o `{ ok: false, error }`; `LOCAL_AI_AUDIO` (send, `{ stream, lang, samples }`); `LOCAL_AI_TRANSLATE` (invoke, `{ id, target }`) → `{ ok, translated, elapsedMs }` o `{ ok: false, error }`; `LOCAL_AI_STOP` (send); `LOCAL_AI_EVENT` (principal → renderer) con `type` `progress | segment | vad | error`.

- [ ] **Step 1: Escribir la prueba que falla**

`electron_app/test/translate-route.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranslateRouter } = require('../local-ai/translate-route');

const PAIR = { source: 'es', target: 'en' };
const REQUEST = { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en', segmentId: 7, pair: PAIR };
const CLOUD_OK = { original: 'Hola.', translated: 'Hello.', detectedLang: 'es', targetLang: 'en', elapsedMs: 120, engine: 'google' };
const CLOUD_FAILED = { original: 'Hola.', translated: 'Hola.', detectedLang: 'es', targetLang: 'en', elapsedMs: 11000, engine: 'none' };

function setup({ cloudResult = CLOUD_OK, localResult = { ok: true, translated: 'Hi.', elapsedMs: 410 }, online = true, mode = 'auto' } = {}) {
  const calls = [];
  const translate = createTranslateRouter({
    cloud: async (req) => { calls.push(['cloud', req]); return cloudResult; },
    local: async (req) => { calls.push(['local', req]); if (localResult instanceof Error) throw localResult; return localResult; },
    isOnline: () => online,
    getMode: () => mode
  });
  return { translate, calls };
}

test('con red y modo auto traduce en la nube y no toca el motor local', async () => {
  const t = setup();
  assert.deepEqual(await t.translate(REQUEST), CLOUD_OK);
  assert.deepEqual(t.calls, [['cloud', { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }]]);
});

test('sin red va directo al motor local, sin esperar a la nube', async () => {
  const t = setup({ online: false });
  assert.deepEqual(await t.translate(REQUEST), { original: 'Hola.', translated: 'Hi.', detectedLang: 'es', targetLang: 'en', elapsedMs: 410, engine: 'local' });
  assert.deepEqual(t.calls, [['local', { id: 7, target: 'en' }]]);
});

test('en modo local traduce siempre en local aunque haya red', async () => {
  const t = setup({ mode: 'local' });
  assert.equal((await t.translate(REQUEST)).engine, 'local');
  assert.equal(t.calls.length, 1);
});

test('si la nube falla en todos sus niveles, recurre al motor local', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED });
  assert.equal((await t.translate(REQUEST)).translated, 'Hi.');
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud', 'local']);
});

test('si el motor local falla estando sin red, se intenta la nube igualmente', async () => {
  const t = setup({ online: false, localResult: new Error('motor detenido') });
  assert.deepEqual(await t.translate(REQUEST), CLOUD_OK);
  assert.deepEqual(t.calls.map((c) => c[0]), ['local', 'cloud']);
});

test('una respuesta local vacía o con error no se da por buena', async () => {
  const empty = setup({ mode: 'local', localResult: { ok: true, translated: '  ' } });
  assert.equal((await empty.translate(REQUEST)).engine, 'google');
  const failed = setup({ mode: 'local', localResult: { ok: false, error: 'ya no está' } });
  assert.equal((await failed.translate(REQUEST)).engine, 'google');
});

test('si fallan la nube y el local devuelve el resultado de la nube (texto original)', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED, localResult: new Error('x') });
  assert.deepEqual(await t.translate(REQUEST), CLOUD_FAILED);
});

test('sin identificador de segmento (motores en la nube) solo existe la nube', async () => {
  const t = setup({ online: false, mode: 'local', cloudResult: CLOUD_FAILED });
  assert.deepEqual(await t.translate({ text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }), CLOUD_FAILED);
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud']);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL con `Cannot find module '../local-ai/translate-route'`.

- [ ] **Step 3: Implementar el enrutador**

`electron_app/local-ai/translate-route.js`:

```js
/**
 * translate-route.js - Decide dónde se traduce cada frase: nube (mejor calidad) o motor local (sin red)
 */

function createTranslateRouter({ cloud, local, isOnline = () => true, getMode = () => 'auto' }) {
  return async function translate({ text, sourceLang, targetLang, segmentId = null, pair = null }) {
    const canLocal = segmentId !== null && pair !== null;

    async function viaLocal() {
      const started = Date.now();
      const res = await local({ id: segmentId, target: pair.target });
      if (!res || !res.ok || !res.translated || !res.translated.trim()) {
        throw new Error((res && res.error) || 'Traducción local vacía');
      }
      return {
        original: text,
        translated: res.translated.trim(),
        detectedLang: pair.source,
        targetLang: pair.target,
        elapsedMs: res.elapsedMs || (Date.now() - started),
        engine: 'local'
      };
    }

    let localTried = false;
    if (canLocal && (getMode() === 'local' || !isOnline())) {
      localTried = true;
      try {
        return await viaLocal();
      } catch {
        // sigue con la nube
      }
    }

    const cloudResult = await cloud({ text, sourceLang, targetLang });
    if (cloudResult && cloudResult.engine === 'none' && canLocal && !localTried) {
      try {
        return await viaLocal();
      } catch {
        return cloudResult;
      }
    }
    return cloudResult;
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createTranslateRouter };
}
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npm test`
Expected: 53 pruebas, 0 fallos.

- [ ] **Step 5: `TRANSLATE_TEXT` informa qué motor tradujo**

En `electron_app/main.js`, dentro de `ipcMain.handle('TRANSLATE_TEXT', …)`, añadir el campo `engine` a cada `return` del manejador:

- Línea 392 (auto-traducción bidireccional) y línea 396 (Google): añadir `, engine: 'google'` antes de la llave de cierre del objeto.
- Línea 407 (Groq): añadir `, engine: 'groq'`.
- Línea 418 (MyMemory): añadir `, engine: 'mymemory'`.
- Línea 424 (el `return` final que devuelve el texto original): añadir `, engine: 'none'`.

Ejemplo del último:

```js
  return { original: correctedText, translated: correctedText, detectedLang: slParam, targetLang: tlParam, elapsedMs: elapsed, engine: 'none' };
```

- [ ] **Step 6: Canales del motor local en `main.js`**

a) Línea 7: añadir `utilityProcess` a la desestructuración de `require('electron')`:

```js
const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, desktopCapturer, session, dialog, utilityProcess } = require('electron');
```

b) Tras `const { FishAudioService } = require('./fish-audio-service');` (línea 15):

```js
const { createModelStore } = require('./local-ai/model-store');
const { createLocalAiClient } = require('./local-ai/client');
```

c) Tras `const settingsFilePath = path.join(userDataPath, 'settings.json');` (línea 42):

```js
// ── Motor Local (transcripción y traducción en el equipo, sin red) ──
const modelStore = createModelStore({
  dir: process.env.VIBE_MODELS_DIR || path.join(userDataPath, 'models')
});

const localAi = createLocalAiClient({
  fork: (workerPath) => utilityProcess.fork(workerPath, [], { serviceName: 'ViBeTranslate Motor Local' }),
  workerPath: path.join(__dirname, 'local-ai', 'worker.js'),
  onEvent: (msg) => {
    if (msg.type === 'error') defaultLogger.warn('LOCAL-AI', msg.message);
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('LOCAL_AI_EVENT', msg);
    }
  }
});
```

d) Justo antes del comentario `// ── Handlers IPC para Fish Audio AI (Clonación de Voz y TTS) ────────` (línea 597):

```js
// ── Handlers IPC para el Motor Local ────────────────────────────────
ipcMain.handle('LOCAL_AI_STATUS', async () => modelStore.status());

ipcMain.handle('LOCAL_AI_PREPARE', async (event, { vadThreshold = 0.5 } = {}) => {
  try {
    const pending = modelStore.status();
    if (!pending.ready) {
      defaultLogger.info('LOCAL-AI', `Descargando modelos (${(pending.missingBytes / 1e6).toFixed(0)} MB)...`);
      await modelStore.ensure((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('LOCAL_AI_EVENT', { type: 'progress', ...progress });
      });
    }
    const ready = await localAi.start({ paths: modelStore.paths(), vadThreshold });
    defaultLogger.success('LOCAL-AI', `Motor local listo en ${ready.loadMs}ms.`);
    return { ok: true, loadMs: ready.loadMs };
  } catch (err) {
    defaultLogger.error('LOCAL-AI', `No se pudo preparar el motor local: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('LOCAL_AI_AUDIO', (event, { stream, lang, samples }) => {
  localAi.send({ type: 'audio', stream, lang, samples });
});

ipcMain.handle('LOCAL_AI_TRANSLATE', async (event, { id, target }) => {
  try {
    const result = await localAi.translate(id, target);
    defaultLogger.success('TRANSLATE', `Traducción completada (Motor local) en ${result.ms}ms: "${result.text}"`);
    return { ok: true, translated: result.text, elapsedMs: result.ms };
  } catch (err) {
    defaultLogger.warn('TRANSLATE', `Aviso en traducción local: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('LOCAL_AI_STOP', () => {
  localAi.stop();
});
```

e) En `app.on('will-quit', …)` (línea 232), añadir `localAi.stop();` como primera instrucción del manejador.

- [ ] **Step 7: Verificar**

Run: `node --check main.js && npm test && grep -c "engine: '" main.js`
Expected: sin error de sintaxis; 53 pruebas, 0 fallos; `5`.

- [ ] **Step 8: Commit**

```bash
git add electron_app/local-ai/translate-route.js electron_app/test/translate-route.test.js electron_app/main.js
git commit -m "feat(local-ai): enrutador nube/local y canales IPC del motor local"
```

---

### Task 8: Integración en la interfaz

**Files:**
- Modify: `electron_app/index.html` (selector `#stt-engine`, línea 288; grupo nuevo tras su `</div>`, línea 294)
- Modify: `electron_app/index.js` (imports; referencias DOM; `updateEngineGroupsVisibility` 1027; `applySettingsToUI` 1034; `saveCurrentSettings` 1089; `startTranslationPipeline` 1174; `stopTranslationPipeline` 1223; `translateText` de Task 2; ambos `onaudioprocess`)

**Interfaces:**
- Consumes: `resolvePair` (Task 1), `thresholdFromNoiseGate` (Task 5), `createTranslateRouter` (Task 7), `deliverOutgoing` / `deliverIncoming` / `outputQueue` / `localPair` (Task 2), canales `LOCAL_AI_*` (Task 7).
- Produces: ajuste persistido `translationMode: 'auto' | 'local'`; valor `local` en `sttEngine`.

- [ ] **Step 1: Opción y panel en `index.html`**

a) Como **primera** opción de `<select id="stt-engine">`, antes de la de Gemini (que conserva su `selected`):

```html
            <option value="local">🔒 Motor Local (Sin conexión, privado, sin claves)</option>
```

b) Inmediatamente después del `</div>` que cierra ese `form-group` (línea 294):

```html
        <!-- Motor Local -->
        <div class="form-group" id="local-ai-group" style="display: none;">
          <label for="translation-mode">Traducción con el Motor Local</label>
          <select id="translation-mode">
            <option value="auto" selected>Nube si hay red, local si no (mejor calidad)</option>
            <option value="local">Siempre local (nada sale del equipo)</option>
          </select>
          <span class="link-aff-url" id="local-ai-status">Comprobando modelos...</span>
        </div>
```

- [ ] **Step 2: Imports y referencias en `index.js`**

a) Tras el `require('./output-queue')` añadido en Task 2:

```js
const { resolvePair } = require('./local-ai/languages');
const { thresholdFromNoiseGate } = require('./local-ai/segmenter');
const { createTranslateRouter } = require('./local-ai/translate-route');
```

`segmenter.js` solo usa `sherpa` cuando se llama a `createSegmenter`, así que cargarlo en el renderer no carga el módulo nativo.

b) Junto a `const noiseGateSelect = document.getElementById('noise-gate-select');` (línea 244):

```js
  const localAiGroup = document.getElementById('local-ai-group');
  const translationModeSelect = document.getElementById('translation-mode');
  const localAiStatus = document.getElementById('local-ai-status');
```

- [ ] **Step 3: Visibilidad, carga y guardado de ajustes**

a) En `updateEngineGroupsVisibility` (línea 1027), añadir al final del cuerpo:

```js
    if (localAiGroup) localAiGroup.style.display = (engine === 'local') ? 'flex' : 'none';
    if (engine === 'local') refreshLocalAiStatus();
```

b) Justo antes de `function updateEngineGroupsVisibility()`:

```js
  async function refreshLocalAiStatus() {
    if (!localAiStatus) return;
    try {
      const status = await ipcRenderer.invoke('LOCAL_AI_STATUS');
      localAiStatus.textContent = status.ready
        ? '✅ Modelos listos en este equipo.'
        : `Se descargarán ${(status.missingBytes / 1e6).toFixed(0)} MB la primera vez que lo actives.`;
    } catch (err) {
      localAiStatus.textContent = `No se pudo comprobar el motor local: ${err.message}`;
    }
  }
```

c) En `applySettingsToUI`, tras `sttEngineSelect.value = s.sttEngine || 'gemini_35_transcribe';`:

```js
    if (translationModeSelect) translationModeSelect.value = s.translationMode || 'auto';
```

d) En `saveCurrentSettings`, dentro de `newSettings`, tras `sttEngine: sttEngineSelect.value,`:

```js
      translationMode: translationModeSelect ? translationModeSelect.value : 'auto',
```

e) Buscar el `addEventListener('change', …)` de `sttEngineSelect` (`grep -n "sttEngineSelect.addEventListener" index.js`) y, justo debajo de ese bloque, añadir el guardado del nuevo selector con el mismo patrón:

```js
  if (translationModeSelect) {
    translationModeSelect.addEventListener('change', () => {
      saveCurrentSettings();
    });
  }
```

- [ ] **Step 4: `translateText` pasa por el enrutador**

Sustituir la función `translateText` añadida en Task 2 por:

```js
  const translateText = createTranslateRouter({
    cloud: (req) => ipcRenderer.invoke('TRANSLATE_TEXT', req),
    local: (req) => ipcRenderer.invoke('LOCAL_AI_TRANSLATE', req),
    isOnline: () => navigator.onLine,
    getMode: () => (translationModeSelect ? translationModeSelect.value : 'auto')
  });
```

Las llamadas de `deliverOutgoing` y `deliverIncoming` ya pasan `segmentId` y `pair`; con los motores en la nube `segmentId` es `null` y el enrutador solo usa la nube.

- [ ] **Step 5: Arranque y parada**

a) En `startTranslationPipeline`, añadir una rama tras el cierre de `else if (engine === 'whisper_groq') { … }`:

```js
    } else if (engine === 'local') {
      localPair = resolvePair(sourceLangSelect.value, targetLangSelect.value);
      if (!localPair) {
        appendLog('LOCAL-AI', '⚠️ El motor local necesita un idioma de origen fijo (Español o Inglés), no Auto.', 'warn');
        previewOrig.textContent = '⚠️ Elige Español o Inglés como idioma de origen.';
        previewTrans.textContent = 'El motor local no detecta el idioma automáticamente.';
        stopTranslationPipeline();
        return;
      }
      previewOrig.textContent = '⏳ Preparando el motor local...';
      const prepared = await ipcRenderer.invoke('LOCAL_AI_PREPARE', {
        vadThreshold: thresholdFromNoiseGate(noiseGateSelect.value)
      });
      if (!isPipelineRunning) return; // el usuario lo detuvo mientras cargaba
      if (!prepared.ok) {
        appendLog('LOCAL-AI', `No se pudo iniciar el motor local: ${prepared.error}`, 'error');
        previewOrig.textContent = '⚠️ No se pudo iniciar el motor local.';
        previewTrans.textContent = prepared.error;
        stopTranslationPipeline();
        return;
      }
      appendLog('LOCAL-AI', `🟢 Motor local listo en ${prepared.loadMs}ms (${localPair.source.toUpperCase()} ➔ ${localPair.target.toUpperCase()}).`, 'gemini');
      previewOrig.textContent = '🎙️ Escuchando tu voz (motor local)...';
      refreshLocalAiStatus();
      await startUnifiedAudioPipeline('local', null);
      await startIncomingAudioPipeline(null, 'local');
    }
```

b) En `stopTranslationPipeline`, tras `isPipelineRunning = false;`:

```js
    localPair = null;
    ipcRenderer.send('LOCAL_AI_STOP');
```

- [ ] **Step 6: Enviar las tramas al motor local**

a) En `startUnifiedAudioPipeline`, en el paso «4. Procesamiento según el motor seleccionado», añadir una rama al final de la cadena `if (engine === 'gemini_live') { … } else if (engine === 'whisper_groq' || engine === 'gemini_35_transcribe') { … }`:

```js
        } else if (engine === 'local' && localPair) {
          ipcRenderer.send('LOCAL_AI_AUDIO', {
            stream: 'mic',
            lang: localPair.source,
            samples: new Float32Array(inputData)
          });
        }
```

`new Float32Array(inputData)` copia la trama: el búfer del `ScriptProcessor` se reutiliza. El bloqueo de eco del paso 0 sigue aplicándose antes (no se envían tramas mientras suena la voz por el altavoz local).

b) En `startIncomingAudioPipeline`, justo después de `const inputData = e.inputBuffer.getChannelData(0);`:

```js
        if (engineType === 'local') {
          ipcRenderer.send('LOCAL_AI_AUDIO', {
            stream: 'incoming',
            lang: 'en',
            samples: new Float32Array(inputData)
          });
          return;
        }
```

- [ ] **Step 7: Recibir los eventos del motor**

Tras la definición de `deliverIncoming` (Task 2):

```js
  ipcRenderer.on('LOCAL_AI_EVENT', (event, msg) => {
    if (msg.type === 'progress') {
      const pct = Math.floor((msg.overallLoaded / msg.overallTotal) * 100);
      const text = `⏬ Descargando modelos del motor local: ${pct}%`;
      if (localAiStatus) localAiStatus.textContent = text;
      previewOrig.textContent = text;
      return;
    }
    if (msg.type === 'error') {
      appendLog('LOCAL-AI', msg.message, msg.fatal ? 'error' : 'warn');
      if (msg.fatal && isPipelineRunning) {
        previewOrig.textContent = `⚠️ ${msg.message}`;
        toggleActive.checked = false;
        isLiveToggleActive = false;
        updateStatusBadge(false);
        stopTranslationPipeline();
      }
      return;
    }
    if (!isPipelineRunning) return;

    if (msg.type === 'vad') {
      if (msg.stream === 'incoming') ipcRenderer.send('DISPLAY_SPEECH_STATE', { speaking: msg.speaking });
      return;
    }

    if (msg.type === 'segment') {
      const startedAt = Date.now() - msg.durationMs - msg.sttMs;
      if (msg.stream === 'mic') {
        appendLog('VOICE', `Reconocido (Motor local) en ${msg.sttMs}ms: "${msg.text}"`, 'audio');
        previewOrig.textContent = `🎙️ ${msg.text}`;
        outputQueue.push((ctx) => deliverOutgoing({
          recognizedText: msg.text, sttElapsed: msg.sttMs, voiceDurationMs: msg.durationMs,
          userSpeechStart: startedAt, backlog: ctx.backlog, segmentId: msg.id
        }));
      } else {
        appendLog('RECEPTOR', `Inglés (Motor local) en ${msg.sttMs}ms: "${msg.text}"`, 'audio');
        outputQueue.push((ctx) => deliverIncoming({
          text: msg.text, sttElapsed: msg.sttMs, voiceDurationMs: msg.durationMs,
          speechStartTime: startedAt, backlog: ctx.backlog, segmentId: msg.id
        }));
      }
    }
  });
```

- [ ] **Step 8: Verificar sintaxis y cableado**

Run: `node --check index.js && npm test && for c in STATUS PREPARE AUDIO TRANSLATE STOP EVENT; do echo "$c $(grep -c "LOCAL_AI_$c" index.js) $(grep -c "LOCAL_AI_$c" main.js)"; done`
Expected: sin error de sintaxis; 53 pruebas, 0 fallos; cada canal con al menos `1` en ambas columnas (`AUDIO` muestra `2` en `index.js`).

- [ ] **Step 9: Commit**

```bash
git add electron_app/index.html electron_app/index.js
git commit -m "feat: motor local seleccionable en la interfaz con traduccion nube/local"
```

---

### Task 9: Pruebas de precisión, ruido y traducción con el motor real

**Files:**
- Create: `electron_app/test/local-engine.integration.test.js`
- Create: `electron_app/scripts/measure-latency.js`

**Interfaces:**
- Consumes: `createEngine` (Task 5), utilidades y audios (Task 4), `test/support/models.js` (Task 5).

- [ ] **Step 1: Escribir las pruebas**

`electron_app/test/local-engine.integration.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const { wordErrorRate, hasKeywords } = require('./support/text');
const { pinkNoise, mixAtSnr } = require('./support/noise');
const { createEngine } = require('../local-ai/engine');
const phrases = require('./fixtures/phrases.json');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));

let shared = null;
/** Un solo motor para todo el archivo: cargar el modelo cuesta ~1,5 s. */
function engine() {
  if (!shared) {
    const posted = [];
    shared = { posted, engine: createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m) }) };
  }
  return shared;
}

/** Pasa un audio por el motor como lo haría el renderer y devuelve los segmentos publicados. */
function hear(samples, lang, stream) {
  const { engine: e, posted } = engine();
  const from = posted.length;
  const padded = new Float32Array(samples.length + 16000);
  padded.set(samples);
  for (let i = 0; i < padded.length; i += 2048) e.handle({ type: 'audio', stream, lang, samples: padded.slice(i, i + 2048) });
  e.handle({ type: 'flush', stream, lang });
  return posted.slice(from).filter((m) => m.type === 'segment');
}

const textOf = (segments) => segments.map((s) => s.text).join(' ');

function translate(segments, target) {
  const { engine: e, posted } = engine();
  return segments.map((s) => {
    e.handle({ type: 'translate', id: s.id, target });
    return posted[posted.length - 1].text;
  }).join(' ');
}

for (const lang of ['es', 'en']) {
  test(`transcribe las 5 frases en ${lang} con error de palabras medio ≤ 10 %`, { skip: skipReason }, () => {
    const rates = phrases[lang].map((p, i) => {
      const heard = textOf(hear(audio(p.id), lang, `clean-${lang}-${i}`));
      const rate = wordErrorRate(p.text, heard);
      console.log(`  ${p.id} WER=${rate.toFixed(2)} "${heard}"`);
      return rate;
    });
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    assert.ok(mean <= 0.10, `error medio ${mean.toFixed(3)}`);
  });

  test(`con ruido rosa a 10 dB el error medio en ${lang} es ≤ 20 %`, { skip: skipReason }, () => {
    const noise = pinkNoise(16000 * 12, 11);
    const rates = phrases[lang].map((p, i) => {
      const heard = textOf(hear(mixAtSnr(audio(p.id), noise, 10), lang, `noisy-${lang}-${i}`));
      const rate = wordErrorRate(p.text, heard);
      console.log(`  ${p.id} 10dB WER=${rate.toFixed(2)} "${heard}"`);
      return rate;
    });
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    assert.ok(mean <= 0.20, `error medio ${mean.toFixed(3)}`);
  });
}

test('traduce ES→EN en local: cada frase conserva sus palabras clave', { skip: skipReason }, () => {
  const misses = [];
  phrases.es.forEach((p, i) => {
    const translated = translate(hear(audio(p.id), 'es', `tr-es-${i}`), 'en');
    console.log(`  ${p.id} -> "${translated}"`);
    if (!hasKeywords(translated, p.keywordsEn)) misses.push(`${p.id}: "${translated}" sin ${p.keywordsEn}`);
  });
  assert.deepEqual(misses, []);
});

test('traduce EN→ES en local: cada frase conserva sus palabras clave', { skip: skipReason }, () => {
  const misses = [];
  phrases.en.forEach((p, i) => {
    const translated = translate(hear(audio(p.id), 'en', `tr-en-${i}`), 'es');
    console.log(`  ${p.id} -> "${translated}"`);
    if (!hasKeywords(translated, p.keywordsEs)) misses.push(`${p.id}: "${translated}" sin ${p.keywordsEs}`);
  });
  assert.deepEqual(misses, []);
});

test('solo ruido durante 5 s no publica ninguna frase', { skip: skipReason }, () => {
  assert.deepEqual(hear(pinkNoise(80000, 5).map((v) => v * 4), 'es', 'only-noise'), []);
});

test('un golpe de 200 ms no publica ninguna frase', { skip: skipReason }, () => {
  const blip = new Float32Array(32000);
  blip.set(audio('en1').slice(8000, 11200), 8000);
  assert.deepEqual(hear(blip, 'en', 'blip'), []);
});

test('habla seguida de 15 s se entiende entera aunque se corte en varios segmentos', { skip: skipReason }, () => {
  const ids = ['es2', 'es3', 'es4', 'es5'];
  const parts = ids.map(audio);
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { joined.set(p, offset); offset += p.length; }
  const heard = textOf(hear(joined, 'es', 'long'));
  const reference = ids.map((id) => phrases.es.find((p) => p.id === id).text).join(' ');
  const rate = wordErrorRate(reference, heard);
  console.log(`  largo WER=${rate.toFixed(2)} "${heard}"`);
  assert.ok(rate <= 0.15, `error ${rate.toFixed(3)}`);
});

test('micrófono en español y receptor en inglés a la vez no se mezclan', { skip: skipReason }, () => {
  const { engine: e, posted } = engine();
  const from = posted.length;
  const mic = audio('es3');
  const incoming = audio('en3');
  const length = Math.max(mic.length, incoming.length) + 16000;
  const pad = (a) => { const out = new Float32Array(length); out.set(a); return out; };
  const a = pad(mic);
  const b = pad(incoming);
  for (let i = 0; i < length; i += 2048) {
    e.handle({ type: 'audio', stream: 'mix-mic', lang: 'es', samples: a.slice(i, i + 2048) });
    e.handle({ type: 'audio', stream: 'mix-in', lang: 'en', samples: b.slice(i, i + 2048) });
  }
  e.handle({ type: 'flush', stream: 'mix-mic', lang: 'es' });
  e.handle({ type: 'flush', stream: 'mix-in', lang: 'en' });
  const segments = posted.slice(from).filter((m) => m.type === 'segment');
  const heardMic = textOf(segments.filter((s) => s.stream === 'mix-mic'));
  const heardIn = textOf(segments.filter((s) => s.stream === 'mix-in'));
  assert.ok(wordErrorRate(phrases.es[2].text, heardMic) <= 0.2, heardMic);
  assert.ok(wordErrorRate(phrases.en[2].text, heardIn) <= 0.2, heardIn);
});
```

- [ ] **Step 2: Ejecutar**

Run: `npm test`
Expected: 63 pruebas, 0 fallos, 0 omitidas. La salida muestra cada frase oída y su tasa de error.

Si alguna prueba de precisión, ruido o traducción falla: **no** aflojar el umbral ni cambiar las palabras clave para que pase. Anotar la frase, lo que oyó el modelo y la tasa, y decidir con esos datos (por ejemplo, una palabra clave que admite un sinónimo correcto se puede corregir en `phrases.json` explicándolo en el commit; un error real del modelo se informa al usuario con las cifras).

- [ ] **Step 3: Informe de latencia**

`electron_app/scripts/measure-latency.js`:

```js
/**
 * measure-latency.js - Mide el motor local sobre los audios de prueba y lo compara con la línea base en la nube
 */

const path = require('path');
const { createModelStore } = require('../local-ai/model-store');
const { createEngine } = require('../local-ai/engine');
const { readWav } = require('../test/support/wav');
const phrases = require('../test/fixtures/phrases.json');

const VAD_HANGOVER_MS = 350; // silencio que espera Silero antes de cerrar la frase
const BASELINE = { stt: [370, 890], translate: [100, 1234] }; // de logs/desktop_app.log (sección 3 del spec)

const store = createModelStore({ dir: process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '.models') });
if (!store.status().ready) {
  console.error('Faltan los modelos: ejecuta "npm run models".');
  process.exit(1);
}

const posted = [];
const loadStart = Date.now();
const engine = createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m) });
const loadMs = Date.now() - loadStart;

const rows = [];
for (const [lang, target] of [['es', 'en'], ['en', 'es']]) {
  phrases[lang].forEach((p, i) => {
    const samples = readWav(path.join(__dirname, '..', 'test', 'fixtures', 'audio', `${p.id}.wav`));
    const padded = new Float32Array(samples.length + 16000);
    padded.set(samples);
    const from = posted.length;
    const stream = `${lang}-${i}`;
    for (let k = 0; k < padded.length; k += 2048) engine.handle({ type: 'audio', stream, lang, samples: padded.slice(k, k + 2048) });
    engine.handle({ type: 'flush', stream, lang });
    const segments = posted.slice(from).filter((m) => m.type === 'segment');
    let translateMs = 0;
    for (const s of segments) {
      engine.handle({ type: 'translate', id: s.id, target });
      translateMs += posted[posted.length - 1].ms;
    }
    const sttMs = segments.reduce((n, s) => n + s.sttMs, 0);
    rows.push({ id: p.id, audioMs: Math.round(samples.length / 16), segments: segments.length, sttMs, translateMs });
  });
}

const avg = (key) => Math.round(rows.reduce((n, r) => n + r[key], 0) / rows.length);
console.log(`Carga del motor: ${loadMs} ms (una vez por sesión)`);
console.table(rows);
console.log(`Media por frase: transcripción ${avg('sttMs')} ms, traducción local ${avg('translateMs')} ms`);
console.log(`Fin de voz ➔ texto en pantalla (local): ~${VAD_HANGOVER_MS + avg('sttMs')} ms`);
console.log(`Fin de voz ➔ traducción local en pantalla: ~${VAD_HANGOVER_MS + avg('sttMs') + avg('translateMs')} ms`);
console.log(`Línea base en la nube: transcripción ${BASELINE.stt[0]}–${BASELINE.stt[1]} ms, traducción ${BASELINE.translate[0]}–${BASELINE.translate[1]} ms, más la espera del bloqueo que elimina la cola de salida.`);
```

Run: `node scripts/measure-latency.js`
Expected: una tabla de 10 filas y las cuatro líneas de resumen. No falla por umbral; las cifras van al informe final para el usuario.

- [ ] **Step 4: Commit**

```bash
git add electron_app/test/local-engine.integration.test.js electron_app/scripts/measure-latency.js
git commit -m "test: precision, ruido y traduccion del motor local con audios EN/ES"
```

---

### Task 10: Prueba de punta a punta con la aplicación real

Lanza la app Electron de verdad con un micrófono simulado por Chromium y comprueba el subtítulo final.

**Files:**
- Create: `electron_app/test/e2e/harness-main.js`
- Create: `electron_app/test/e2e/local-engine.e2e.test.js`

**Interfaces:**
- Consumes: la app completa (Tasks 1–8), `readWav` / `writeWav`, `phrases.json`, `test/support/models.js`.

- [ ] **Step 1: Arnés que arranca la app y publica los subtítulos**

`electron_app/test/e2e/harness-main.js`:

```js
/**
 * harness-main.js - Arranca la app real para pruebas: activa la traducción y publica cada subtítulo por stdout
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const emit = (payload) => console.log('E2E ' + JSON.stringify(payload));

ipcMain.on('DISPLAY_SUBTITLE', (event, payload) => emit({ ...payload, type: 'subtitle', at: Date.now() }));
ipcMain.on('LOG_CLIENT_EVENT', (event, payload) => emit({ ...payload, type: 'log' }));

require(path.join(__dirname, '..', '..', 'main.js'));

app.whenReady().then(() => {
  const timer = setInterval(() => {
    const control = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    if (!control || control.webContents.isLoading()) return;
    clearInterval(timer);
    // Dar tiempo a que el renderer cargue los ajustes guardados antes de activar
    setTimeout(() => {
      emit({ type: 'activating', at: Date.now() });
      control.webContents.executeJavaScript("document.getElementById('toggle-active').click()", true);
    }, 2000);
  }, 250);
});
```

- [ ] **Step 2: La prueba**

`electron_app/test/e2e/local-engine.e2e.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { modelsDir, skipReason } = require('../support/models');
const { readWav, writeWav } = require('../support/wav');
const { wordErrorRate, hasKeywords } = require('../support/text');
const phrases = require('../fixtures/phrases.json');

const APP_DIR = path.join(__dirname, '..', '..');
const ELECTRON = require(path.join(APP_DIR, 'node_modules', 'electron'));

/** Silencio inicial (mientras carga el modelo) + frase + silencio final para que la detección de voz cierre. */
function micFile(dir, phraseId) {
  const speech = readWav(path.join(__dirname, '..', 'fixtures', 'audio', `${phraseId}.wav`));
  const samples = new Float32Array(16000 * 6 + speech.length + 16000 * 4);
  samples.set(speech, 16000 * 6);
  const file = path.join(dir, 'mic.wav');
  writeWav(file, samples);
  return file;
}

function runApp({ phraseId, sourceLang, targetLang, translationMode }) {
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
    active: false
  }));

  const env = { ...process.env, VIBE_MODELS_DIR: modelsDir };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(ELECTRON, [
    `--user-data-dir=${dir}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${micFile(dir, phraseId)}%noloop`,
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
      child.kill();
      if (error) reject(error); else resolve({ subtitles, logs });
    };
    const deadline = setTimeout(() => finish(new Error(`sin subtítulo en 90 s. Registro:\n${logs.slice(-25).join('\n')}`)), 90000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('E2E ')) continue;
        const msg = JSON.parse(line.slice(4));
        if (msg.type === 'log') {
          logs.push(`[${msg.category}] ${msg.message}`);
          if (msg.message.includes('idioma de origen fijo')) return finish(new Error(msg.message));
        }
        if (msg.type === 'subtitle' && msg.isFinal) {
          subtitles.push(msg);
          clearTimeout(settle);
          settle = setTimeout(() => finish(), 3000); // esperar por si la frase llega en dos segmentos
        }
      }
    });
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
```

- [ ] **Step 3: Ejecutar**

Run: `npm run test:e2e`
Expected: 4 pruebas, 0 fallos. Cada una abre y cierra la app (unos 15–25 s por prueba).

Si una prueba agota el tiempo, el error incluye las últimas 25 líneas del registro de la app. Causas probables y cómo confirmarlas: (a) el interruptor no arrancó la canalización: buscar `Iniciando motor de traducción: LOCAL` en el registro; (b) el micrófono simulado no entrega audio: buscar `Micrófono capturado`; (c) el modelo tardó más que el silencio inicial de 6 s: buscar la hora de `Motor local listo` frente a `activating`. Corregir la causa real; no alargar tiempos a ciegas.

- [ ] **Step 4: Commit**

```bash
git add electron_app/test/e2e
git commit -m "test(e2e): la app real transcribe y traduce EN/ES con el motor local"
```

---

### Task 11: Empaquetado

**Files:**
- Modify: `electron_app/package.json` (`build.asarUnpack`)

- [ ] **Step 1: Sacar los binarios nativos del archivo asar**

En `electron_app/package.json`, dentro de `"build"`, tras el bloque `"files": [ … ],` añadir:

```json
"asarUnpack": [
  "node_modules/sherpa-onnx-node/**",
  "node_modules/sherpa-onnx-win-x64/**",
  "node_modules/sherpa-onnx-darwin-x64/**",
  "node_modules/sherpa-onnx-darwin-arm64/**",
  "local-ai/**"
],
```

`local-ai/**` va fuera del asar porque `utilityProcess.fork` carga `worker.js` y este `require('sherpa-onnx-node')`: ambos deben estar en disco real para que las DLL junto al `.node` se resuelvan.

- [ ] **Step 2: Construir sin instalador y comprobar el contenido**

Run: `npx electron-builder --win --dir && ls "dist/win-unpacked/resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64" && ls "dist/win-unpacked/resources/app.asar.unpacked/local-ai"`
Expected: la construcción termina sin error; el primer `ls` muestra `sherpa-onnx.node` y las DLL (`onnxruntime.dll`, `sherpa-onnx-c-api.dll`…); el segundo muestra `worker.js`, `engine.js` y el resto. Ningún archivo `.onnx` de modelo aparece en `dist/` (`find dist/win-unpacked -name "*.onnx" | wc -l` → `0`).

- [ ] **Step 3: Comprobar que el motor carga dentro del paquete**

Run:

```bash
VIBE_MODELS_DIR="$(pwd)/.models" ELECTRON_RUN_AS_NODE=1 "dist/win-unpacked/ViBeTranslate Pro Studio.exe" -e "
const path = require('path');
const base = path.join(process.resourcesPath, 'app.asar.unpacked');
const { createEngine } = require(path.join(base, 'local-ai', 'engine.js'));
const { createModelStore } = require(path.join(base, 'local-ai', 'model-store.js'));
const store = createModelStore({ dir: process.env.VIBE_MODELS_DIR });
const posted = [];
const engine = createEngine({ sherpa: require(path.join(base, 'node_modules', 'sherpa-onnx-node')), paths: store.paths(), post: (m) => posted.push(m) });
engine.handle({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048) });
console.log('PACKAGED_ENGINE_OK');
"
```

Expected: imprime `PACKAGED_ENGINE_OK`. (Aquí `ELECTRON_RUN_AS_NODE=1` es intencionado: usa el Node del ejecutable empaquetado para cargar el motor desde `app.asar.unpacked`.)

Si falla con «The specified module could not be found», las DLL no quedaron junto a `sherpa-onnx.node`: revisar el patrón de `asarUnpack`.

- [ ] **Step 4: Repetir todas las pruebas**

Run: `npm test && npm run test:e2e`
Expected: 63 y 4 pruebas, 0 fallos.

- [ ] **Step 5: Commit**

```bash
git add electron_app/package.json
git commit -m "build: desempaquetar los binarios del motor local en el instalador"
```

La construcción para macOS no se puede verificar desde Windows; queda anotada como pendiente en el informe final.
