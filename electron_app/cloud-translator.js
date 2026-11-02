/**
 * cloud-translator.js - Traducción en la nube: un LLM de Groq y Google a la vez, y se queda con la mejor
 *
 * Medido con las frases de las sesiones de prueba (chrF, más es mejor): EN→ES gpt-oss-120b 78,1 · Google 74,9;
 * ES→EN 72,5 · 74,4, y en frases de reunión el LLM acierta modismos («you're breaking up», «on mute») que
 * Google traduce literal. Pero un LLM a veces devuelve la frase sin traducir o con restos («…Entonces,?>»):
 * por eso su respuesta se valida y Google, pedido en paralelo, cubre los fallos sin añadir espera.
 */

const NAMES = { en: 'English', es: 'Spanish' };
const LLM_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']; // si el primero llega a su límite, el segundo
const LLM_TIMEOUT_MS = 2500;
const GOOGLE_TIMEOUT_MS = 3500;
// Con Google ya respondido, cuánto más se espera al LLM. El subtítulo local ya está en pantalla, así que esperar
// no retrasa nada visible; el LLM de Groq suele tardar 300-700 ms pero a veces pasa de 1,2 s.
const HEDGE_GRACE_MS = 1000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 28; // la cuenta gratuita de Groq admite 30 peticiones por minuto y modelo

// Palabras muy frecuentes de cada idioma: bastan para distinguir inglés de español en una frase
const COMMON = {
  en: new Set(['the', 'and', 'is', 'are', 'to', 'of', 'you', 'we', 'it', 'that', 'this', 'what', 'in', 'for', 'with', 'be', 'have', 'will', 'so', 'not', 'on', 'can', 'do', 'i', 'my', 'your', 'our', 'they', 'was', 'were', 'just', 'going', 'how', 'if', 'or', 'but', 'about', 'there', "it's", "don't", "we're", "i'm", "let's"]),
  es: new Set(['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'para', 'con', 'no', 'se', 'lo', 'del', 'al', 'como', 'más', 'pero', 'su', 'sus', 'estamos', 'vamos', 'hay', 'ya', 'esto', 'esta', 'este', 'muy', 'qué', 'cómo', 'tu', 'te', 'mi', 'nos', 'le', 'les', 'son', 'está', 'si', 'sí', 'también', 'puedes', 'puede'])
};

function words(text) {
  return String(text).toLowerCase().match(/[\p{L}']+/gu) || [];
}

/** Puntuación de parecido a cada idioma (0 si no hay pistas). */
function languageScores(text) {
  const tokens = words(text);
  const score = { en: 0, es: 0 };
  for (const t of tokens) {
    if (COMMON.en.has(t)) score.en++;
    if (COMMON.es.has(t)) score.es++;
  }
  if (/[ñáéíóú¿¡]/i.test(text)) score.es += 2;
  return score;
}

/** Limpia lo que un LLM añade alrededor de la traducción. */
function cleanLlmOutput(raw) {
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/^\s*(translation|traducción|translated text)\s*:\s*/i, '')
    .trim();
  // Restos de etiquetas al final («Entonces,?>»)
  text = text.replace(/\s*[?]?>\s*$/, (m) => (m.includes('?') ? '?' : '')).trim();
  if (/^["«“].*["»”]$/s.test(text)) text = text.slice(1, -1).trim();
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/** ¿Parece una traducción de verdad, y no la frase sin traducir, una respuesta o una explicación? */
function isPlausibleTranslation(source, output, sourceLang, targetLang) {
  if (!output || !/[\p{L}\p{N}]/u.test(output)) return false;
  const norm = (s) => words(s).join(' ');
  const src = norm(source);
  const out = norm(output);
  if (src.split(' ').length >= 3 && src === out) return false; // devuelta sin traducir
  const ratio = output.length / Math.max(1, source.length);
  if (source.length >= 20 && (ratio < 0.4 || ratio > 2.5)) return false; // resumida, contestada o explicada
  const s = languageScores(output);
  const ownWords = s[sourceLang] || 0;
  const targetWords = s[targetLang] || 0;
  // Con pistas suficientes, la salida debe parecerse más al idioma de destino que al de origen
  return !(ownWords >= 2 && ownWords > targetWords * 2);
}

/**
 * @param {Array<{heard: string, term: string}>} hints Palabras corrientes que el reconocedor pudo poner en lugar de un
 *   término técnico («café» por Kafka): el LLM decide por el contexto.
 */
function systemPrompt(sl, tl, hints = []) {
  const spanish = tl === 'es' ? ' (neutral Latin American Spanish, informal "tú")' : '';
  // «video call»: sin esto «you're breaking up» salía como ruptura de pareja («te estás separando»)
  let prompt = `You translate live speech from an online work meeting (video call) between software developers, from ${NAMES[sl]} to ${NAMES[tl]}${spanish}. ` +
    'The input is an automatic speech transcript: it may be a sentence fragment or contain recognition errors. ';
  if (sl === 'es') {
    // Solo el español hablado trae términos ingleses escritos de oído («taimaut»). En inglés esta frase hacía que el
    // LLM viera términos donde no los había: «a bit garbled» salió como «garbled en Vite».
    prompt += 'English technical terms (Microsoft 365, SharePoint, Power Platform, Azure, .NET, web development) are often ' +
      'said inside Spanish speech and the recognizer may spell them phonetically: write them correctly, but never turn an ' +
      'ordinary word into a technical term. ';
  }
  prompt += 'Translate it faithfully and naturally, keep fragments as fragments, keep names and technical terms, ' +
    'never answer, explain or add anything. Output only the translation.';
  const useful = (hints || []).filter((h) => h && h.heard && h.term).slice(0, 5);
  if (useful.length > 0) {
    prompt += ' Possibly misheard technical terms in this sentence (use them only if they fit the context): ' +
      useful.map((h) => `"${h.heard}" may be ${h.term}`).join('; ') + '.';
  }
  return prompt;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function createCloudTranslator({ fetchImpl = fetch, now = Date.now, getGroqKey = () => '', logger = null } = {}) {
  const usage = new Map(); // modelo → marcas de tiempo de las peticiones del último minuto
  const pausedUntil = new Map(); // modelo → hasta cuándo no se usa (límite alcanzado)

  function available(model) {
    if ((pausedUntil.get(model) || 0) > now()) return false;
    const recent = (usage.get(model) || []).filter((t) => now() - t < RATE_WINDOW_MS);
    usage.set(model, recent);
    return recent.length < RATE_MAX;
  }

  async function google(text, sl, tl) {
    const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    const t = withTimeout(GOOGLE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: t.signal
      });
      if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
      const data = await res.json();
      const translated = data && Array.isArray(data[0]) ? data[0].map((c) => c[0]).filter(Boolean).join('').trim() : '';
      if (!translated) throw new Error('Respuesta vacía de Google Translate');
      return { translated, detected: (data && data[2]) || sl, engine: 'google' };
    } finally {
      t.done();
    }
  }

  async function llm(text, sl, tl, hints = []) {
    const key = (getGroqKey() || '').trim();
    if (key.length < 5) throw new Error('Sin clave de Groq');
    const model = LLM_MODELS.find(available);
    if (!model) throw new Error('Groq: límite de peticiones alcanzado');
    usage.get(model).push(now());
    const t = withTimeout(LLM_TIMEOUT_MS);
    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt(sl, tl, hints) }, { role: 'user', content: text }],
          temperature: 0.1,
          max_tokens: 400,
          reasoning_effort: 'low' // sin esto gpt-oss razona más y tarda el doble
        }),
        signal: t.signal
      });
      if (res.status === 429) {
        const wait = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        pausedUntil.set(model, now() + (Number.isFinite(wait) && wait > 0 ? wait * 1000 : RATE_WINDOW_MS));
        throw new Error(`Groq ${model}: límite alcanzado`);
      }
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const data = await res.json();
      const translated = cleanLlmOutput(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
      if (!isPlausibleTranslation(text, translated, sl, tl)) throw new Error(`Groq ${model}: respuesta descartada ("${translated.slice(0, 60)}")`);
      return { translated, detected: sl, engine: 'groq', model };
    } finally {
      t.done();
    }
  }

  /**
   * La mejor traducción disponible: el LLM si responde bien y a tiempo; si no, Google.
   * Rechaza solo si fallan los dos.
   */
  function translate(text, sl, tl, { hints = [] } = {}) {
    const started = now();
    const llmTry = llm(text, sl, tl, hints);
    const googleTry = google(text, sl, tl);
    const warn = (err) => { if (logger) logger(err.message); };

    return new Promise((resolve, reject) => {
      let settled = false;
      let googleResult = null;
      let llmFailed = false;
      let googleFailed = false;
      let graceTimer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve({ ...result, elapsedMs: now() - started });
      };

      llmTry.then(finish, (err) => {
        warn(err);
        llmFailed = true;
        if (googleResult) finish(googleResult);
        else if (googleFailed) reject(new Error('Fallaron el LLM y Google'));
      });
      googleTry.then((result) => {
        googleResult = result;
        if (llmFailed) finish(result);
        else graceTimer = setTimeout(() => finish(result), HEDGE_GRACE_MS);
      }, (err) => {
        warn(err);
        googleFailed = true;
        if (llmFailed) reject(new Error('Fallaron el LLM y Google'));
      });
    });
  }

  return { translate, google, llm };
}

module.exports = { createCloudTranslator, cleanLlmOutput, isPlausibleTranslation, languageScores, systemPrompt };
