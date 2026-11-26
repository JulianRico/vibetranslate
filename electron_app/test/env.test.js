const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv, loadEnv, envSettings, applyEnvFallbacks } = require('../env');
const { FishAudioService } = require('../fish-audio-service');
const GeminiLiveClient = require('../gemini-live-client');

const APP_DIR = path.join(__dirname, '..');

test('parseEnv lee claves, comillas, export y comentarios en línea', () => {
  const parsed = parseEnv([
    '# Comentario inicial',
    '',
    'GEMINI_API_KEY=AIzaDummy123 # clave de prueba',
    'export GROQ_API_KEY="gsk_quoted # conserva almohadilla"',
    "FISH_API_KEY='single_quoted_val'",
    'VOXCPM_PORT=8765'
  ].join('\r\n'));

  assert.deepEqual(parsed, {
    GEMINI_API_KEY: 'AIzaDummy123',
    GROQ_API_KEY: 'gsk_quoted # conserva almohadilla',
    FISH_API_KEY: 'single_quoted_val',
    VOXCPM_PORT: '8765'
  });
});

test('loadEnv carga desde disco sin pisar variables ya presentes en el entorno', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-env-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'GEMINI_API_KEY=from_file\nGROQ_API_KEY=groq_from_file\n', 'utf8');

  const env = { GEMINI_API_KEY: 'already_set', GROQ_API_KEY: '' };
  const res = loadEnv({ filePath: envFile, env });
  assert.equal(res.loaded, true);
  assert.equal(env.GEMINI_API_KEY, 'already_set');
  assert.equal(env.GROQ_API_KEY, 'groq_from_file');

  const ignored = loadEnv({ filePath: envFile, env: { VIBE_IGNORE_DOTENV: '1' } });
  assert.equal(ignored.loaded, false);
});

test('applyEnvFallbacks rellena claves vacías en settings sin sobrescribir las del usuario', () => {
  const env = {
    GEMINI_API_KEY: 'env_gemini',
    GROQ_API_KEY: 'env_groq',
    FISH_API_KEY: 'env_fish',
    FISH_VOICE_MODEL_ID: 'env_voice_123',
    FISH_MODEL: 's2.1-pro',
    HUGGINGFACE_API_KEY: 'hf_dummy_env_token',
    PERSONAPLEX_HOST: '127.0.0.1',
    PERSONAPLEX_PORT: '8998',
    PERSONAPLEX_VOICE: 'NATF2'
  };
  const saved = {
    geminiApiKey: '',
    groqApiKey: 'user_custom_groq',
    fishApiKey: '',
    fishVoiceModelId: 'default',
    fishModel: ''
  };
  const merged = applyEnvFallbacks(saved, env);
  assert.equal(merged.geminiApiKey, 'env_gemini');
  assert.equal(merged.groqApiKey, 'user_custom_groq');
  assert.equal(merged.fishApiKey, 'env_fish');
  assert.equal(merged.fishVoiceModelId, 'env_voice_123');
  assert.equal(merged.fishModel, 's2.1-pro');
  assert.equal(merged.huggingfaceApiKey, 'hf_dummy_env_token');
  assert.equal(merged.personaplexHost, '127.0.0.1');
  assert.equal(merged.personaplexPort, 8998);
  assert.equal(merged.personaplexVoice, 'NATF2');
  assert.equal(envSettings(env).voxcpmPort, 0);
});

test('.env.example contiene todas las variables requeridas con valores ficticios seguros y sincronizados con .env', () => {
  const examplePath = path.join(APP_DIR, '.env.example');
  assert.ok(fs.existsSync(examplePath), 'falta .env.example');
  const exampleVars = parseEnv(fs.readFileSync(examplePath, 'utf8'));

  const requiredKeys = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'FISH_API_KEY',
    'FISH_VOICE_MODEL_ID',
    'FISH_MODEL',
    'VOXCPM_HOST',
    'VOXCPM_PORT'
  ];
  for (const key of requiredKeys) {
    assert.ok(key in exampleVars && exampleVars[key].length > 0, `falta ${key} en .env.example`);
  }

  // Verificar que .env.example solo contiene valores ficticios y nunca claves reales
  assert.match(exampleVars.GEMINI_API_KEY, /dummy/i);
  assert.match(exampleVars.GROQ_API_KEY, /dummy/i);
  assert.equal(exampleVars.FISH_API_KEY, '00000000000000000000000000000000');
  assert.equal(exampleVars.FISH_VOICE_MODEL_ID, 'default');

  const dotEnvPath = path.join(APP_DIR, '.env');
  if (fs.existsSync(dotEnvPath)) {
    const realVars = parseEnv(fs.readFileSync(dotEnvPath, 'utf8'));
    for (const key of requiredKeys) {
      assert.ok(key in realVars && realVars[key].length > 0, `falta ${key} en .env`);
    }
    for (const secretKey of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'FISH_API_KEY']) {
      assert.notEqual(realVars[secretKey], exampleVars[secretKey], `${secretKey} en .env sigue siendo el valor ficticio`);
    }
  }
});

test('package.json excluye .env del instalador y ningún archivo de código contiene claves quemadas', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('!.env'), 'package.json debe excluir .env del empaquetado');
  assert.ok(pkg.build.files.includes('!.env.*'), 'package.json debe excluir .env.* del empaquetado');

  const codeFiles = fs.readdirSync(APP_DIR)
    .filter((f) => (f.endsWith('.js') || f.endsWith('.html')) && f !== 'package-lock.json');

  const realSecretPattern = /(?:AQ\.Ab8[0-9A-Za-z_-]{15,}|gsk_(?!dummy)[0-9A-Za-z_-]{20,}|AIzaSy(?!Dummy)[0-9A-Za-z_-]{20,}|hf_(?!dummy)[0-9A-Za-z]{20,}|(?:fishVoiceModelId|reference_id)\s*:\s*['"][0-9a-f]{32}['"]|userPrimaryVoiceId\s*=\s*['"][0-9a-f]{32}['"])/;
  for (const file of codeFiles) {
    const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
    assert.ok(!realSecretPattern.test(src), `se encontró una clave o ID personal quemado en ${file}`);
  }
});

test('FishAudioService devuelve un objeto completo también al recuperar de caché y consulta modelos propios con self=true', async () => {
  const origFetch = global.fetch;
  const calledUrls = [];
  let ttsCalls = 0;
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    if (String(url).includes('/v1/tts')) {
      ttsCalls++;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
    return { ok: true, json: async () => ({ total: 1, items: [{ _id: 'v1', title: 'Mi Voz' }] }) };
  };

  try {
    const svc = new FishAudioService({ apiKey: 'test_key', model: 's2.1-pro-free' });
    const first = await svc.synthesizeTTS({ text: 'Hello world' });
    const second = await svc.synthesizeTTS({ text: 'Hello world' });
    assert.equal(ttsCalls, 1, 'la segunda síntesis idéntica debe salir de caché');
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(second.cached, true);
    assert.ok(Buffer.isBuffer(second.audioBuffer) && second.audioBuffer.byteLength === 4);

    await svc.listVoiceModels({ selfOnly: true, pageSize: 10 });
    assert.ok(calledUrls.some((u) => u.includes('self=true') && !u.includes('self_only=true')), 'debe usar self=true');
  } finally {
    global.fetch = origFetch;
  }
});

test('GeminiLiveClient genera handshakes válidos en ambos modos y cierra sin errores antes de conectar', () => {
  const sent = [];
  const transcribeClient = new GeminiLiveClient({ apiKey: 'dummy_key_12345', mode: 'transcribe_live' });
  transcribeClient.ws = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) };
  transcribeClient.sendSetupHandshake();
  assert.equal(sent[0].setup.generationConfig.mediaResolution, undefined, 'mediaResolution causa error 1007 en transcribe_live');

  const translateEsClient = new GeminiLiveClient({
    apiKey: 'dummy_key_12345',
    mode: 'translate_audio',
    sourceLang: 'en-US',
    targetLang: 'es'
  });
  translateEsClient.ws = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) };
  translateEsClient.sendSetupHandshake();
  const promptEs = sent[1].setup.systemInstruction.parts[0].text;
  assert.match(promptEs, /Latin American Spanish/);
  assert.match(promptEs, /clear native Spanish/);

  // Cerrar un WebSocket en estado CONNECTING (0) usa terminate() en lugar de close() para no disparar excepción en ws
  let terminated = false;
  translateEsClient.ws = {
    readyState: 0,
    removeAllListeners() {},
    on() {},
    terminate() { terminated = true; },
    close() { throw new Error('no debe llamarse close() en CONNECTING'); }
  };
  translateEsClient.disconnect();
  assert.equal(terminated, true);
});
