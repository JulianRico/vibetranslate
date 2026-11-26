/**
 * env.js - Carga sin dependencias de variables de entorno desde .env
 *
 * Lee pares CLAVE=VALOR ignorando comentarios y líneas vacías. Nunca pisa variables ya
 * definidas en process.env (para que las pruebas y la línea de comandos tengan prioridad).
 */

const fs = require('fs');
const path = require('path');

/** Extrae un objeto { CLAVE: valor } a partir del contenido de un archivo .env. */
function parseEnv(content) {
  const result = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = cleaned.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = cleaned.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Comentario al final de una línea sin comillas: CLAVE=valor # comentario
      const commentAt = value.search(/\s+#/);
      if (commentAt >= 0) value = value.slice(0, commentAt).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Carga un archivo .env en `targetEnv` (por defecto `process.env`).
 * Con `VIBE_IGNORE_DOTENV=1` no lee el disco (útil en pruebas aisladas).
 */
function loadEnv({ filePath = path.join(__dirname, '.env'), env = process.env, override = false } = {}) {
  if (env.VIBE_IGNORE_DOTENV === '1') return { loaded: false, parsed: {} };
  if (!filePath || !fs.existsSync(filePath)) return { loaded: false, parsed: {} };

  const parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (override || env[key] === undefined || env[key] === '') {
      env[key] = value;
    }
  }
  // Exponer también HF_TOKEN estándar si el usuario configuró HUGGINGFACE_API_KEY en .env,
  // para que librerías oficiales de Hugging Face y subprocesos Python lo reconozcan automáticamente.
  if (env.HUGGINGFACE_API_KEY && !env.HF_TOKEN) {
    env.HF_TOKEN = env.HUGGINGFACE_API_KEY;
  }
  return { loaded: true, parsed };
}

/** Valores de configuración aportados por las variables de entorno. */
function envSettings(env = process.env) {
  return {
    geminiApiKey: String(env.GEMINI_API_KEY || '').trim(),
    groqApiKey: String(env.GROQ_API_KEY || '').trim(),
    fishApiKey: String(env.FISH_API_KEY || '').trim(),
    fishVoiceModelId: String(env.FISH_VOICE_MODEL_ID || '').trim(),
    fishModel: String(env.FISH_MODEL || '').trim(),
    huggingfaceApiKey: String(env.HUGGINGFACE_API_KEY || env.HF_TOKEN || '').trim(),
    voxcpmHost: String(env.VOXCPM_HOST || '').trim(),
    voxcpmPort: Number(env.VOXCPM_PORT) || 0,
    personaplexHost: String(env.PERSONAPLEX_HOST || '').trim(),
    personaplexPort: Number(env.PERSONAPLEX_PORT) || 0,
    personaplexVoice: String(env.PERSONAPLEX_VOICE || '').trim(),
    // Configuración opcional para Haru-4B Full-Duplex (puerto 8999 por defecto para convivir con PersonaPlex 8998)
    haruHost: String(env.HARU_HOST || '').trim(),
    haruPort: Number(env.HARU_PORT) || 0,
    haruLang: String(env.HARU_LANG || '').trim(),
    haruVoiceRef: String(env.HARU_VOICE_REF || '').trim()
  };
}

/** Rellena en `settings` las claves vacías usando los respaldos de `.env`. */
function applyEnvFallbacks(settings, env = process.env) {
  const fromEnv = envSettings(env);
  const merged = { ...settings };
  if (!merged.geminiApiKey && fromEnv.geminiApiKey) merged.geminiApiKey = fromEnv.geminiApiKey;
  if (!merged.groqApiKey && fromEnv.groqApiKey) merged.groqApiKey = fromEnv.groqApiKey;
  if (!merged.fishApiKey && fromEnv.fishApiKey) merged.fishApiKey = fromEnv.fishApiKey;
  if ((!merged.fishVoiceModelId || merged.fishVoiceModelId === 'default') && fromEnv.fishVoiceModelId) {
    merged.fishVoiceModelId = fromEnv.fishVoiceModelId;
  }
  if (!merged.fishModel && fromEnv.fishModel) merged.fishModel = fromEnv.fishModel;
  if (!merged.huggingfaceApiKey && fromEnv.huggingfaceApiKey) merged.huggingfaceApiKey = fromEnv.huggingfaceApiKey;
  if (!merged.personaplexHost && fromEnv.personaplexHost) merged.personaplexHost = fromEnv.personaplexHost;
  if (!merged.personaplexPort && fromEnv.personaplexPort) merged.personaplexPort = fromEnv.personaplexPort;
  if (!merged.personaplexVoice && fromEnv.personaplexVoice) merged.personaplexVoice = fromEnv.personaplexVoice;
  if (!merged.haruHost && fromEnv.haruHost) merged.haruHost = fromEnv.haruHost;
  if (!merged.haruPort && fromEnv.haruPort) merged.haruPort = fromEnv.haruPort;
  if (!merged.haruLang && fromEnv.haruLang) merged.haruLang = fromEnv.haruLang;
  if (!merged.haruVoiceRef && fromEnv.haruVoiceRef) merged.haruVoiceRef = fromEnv.haruVoiceRef;
  return merged;
}

module.exports = { parseEnv, loadEnv, envSettings, applyEnvFallbacks };
