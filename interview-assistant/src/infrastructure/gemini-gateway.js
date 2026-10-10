import { NotConfiguredError, UpstreamError } from '../domain/errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Parses JSON that may be wrapped in a ```json fence or surrounded by prose. Throws when nothing parses. */
export function parseJsonLoose(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[{[]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('no JSON found');
  }
}

/**
 * LlmGateway backed by the Gemini REST API (`generateContent`).
 * Errors are UpstreamError with Gemini's own message, with the API key masked out of every message.
 */
export function createGeminiGateway({
  apiKey, model = 'gemini-2.5-flash', fetchImpl = fetch, retries = 2, retryDelayMs = 800, timeoutMs = 110_000,
} = {}) {
  const configured = Boolean(apiKey);
  let thinkingSupported = true;
  const mask = (msg) => (configured ? String(msg).split(apiKey).join('***') : String(msg)).slice(0, 300);
  const fail = (msg) => new UpstreamError(mask(msg));

  /** POSTs one generateContent request (with retries) and returns the text and finish reason. */
  async function call(body, signal) {
    if (!configured) throw new NotConfiguredError('Falta GEMINI_API_KEY en el servidor');
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (err?.name === 'TimeoutError') throw fail('Gemini tardó demasiado en responder');
        if (err?.name === 'AbortError') throw err;
        throw fail(`Gemini no responde: ${err?.cause?.code || err?.message}`);
      }
      if (res.ok) {
        const data = await res.json();
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
        if (!text) throw fail(`Gemini no devolvió texto (${data?.promptFeedback?.blockReason || candidate?.finishReason || 'respuesta vacía'})`);
        return { text, finishReason: candidate?.finishReason };
      }
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* body was not JSON */ }
      if (res.status === 400 && /thinking/i.test(detail) && body.generationConfig?.thinkingConfig) {
        thinkingSupported = false; // this model rejects thinkingConfig: retry the same attempt without it
        delete body.generationConfig.thinkingConfig;
        attempt--;
        continue;
      }
      lastError = fail(`Gemini HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      if (!RETRYABLE.has(res.status)) throw lastError;
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
    }
    throw lastError;
  }

  const config = (extra) => ({ ...extra, ...(thinkingSupported ? { thinkingConfig: { thinkingBudget: 0 } } : {}) });

  return {
    model,
    isConfigured: () => configured,

    async generateJson({ system, prompt, temperature = 0.5, signal }) {
      const { text, finishReason } = await call({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: config({ responseMimeType: 'application/json', temperature, maxOutputTokens: 600 }),
      }, signal);
      try {
        return parseJsonLoose(text);
      } catch {
        throw Object.assign(
          fail(`Gemini devolvió JSON inválido${finishReason === 'MAX_TOKENS' ? ' (respuesta cortada: MAX_TOKENS)' : ''}`),
          { invalidOutput: true },
        );
      }
    },

    async extractText({ mimeType, data, instruction, signal }) {
      const { text } = await call({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: data.toString('base64') } }, { text: instruction }] }],
        generationConfig: config({ temperature: 0, maxOutputTokens: 20_000 }),
      }, signal);
      return text;
    },
  };
}
