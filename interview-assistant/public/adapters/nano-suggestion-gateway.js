const MAX_POINTS = 3;
const NANO_CONTEXT_CHARS = 3000;

/** "- a\n* b\n1. c" → ['a', 'b', 'c'] (at most 3). */
export function parseBullets(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_POINTS);
}

/**
 * SuggestionGatewayPort backed by Gemini Nano (Prompt API, on device). It is slow on low-end machines
 * (measured 6–19 s on the target laptop), so it only returns key points, translated with the Translator.
 * The system prompt comes from the server so it is built in one place. `win` is injectable for tests.
 */
export function createNanoSuggestionGateway({ translator, contextGateway, win = globalThis }) {
  let base = null; // session created once per system prompt, cloned for every request
  let basePrompt = '';

  async function baseSession(systemPrompt, signal) {
    if (base && basePrompt === systemPrompt) return base;
    base?.destroy?.();
    base = await win.LanguageModel.create({
      signal,
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      initialPrompts: [{ role: 'system', content: systemPrompt }],
    });
    basePrompt = systemPrompt;
    return base;
  }

  return {
    async suggest({ turns }, { signal } = {}) {
      if (!('LanguageModel' in win)) throw new Error('Gemini Nano no está disponible en este Chrome.');
      const { systemPrompt, usedContext, omittedContext } = await contextGateway.coachSystemPrompt({ mode: 'nano', maxChars: NANO_CONTEXT_CHARS });
      const session = await (await baseSession(systemPrompt, signal)).clone({ signal });
      let text;
      try {
        text = await session.prompt(turns.join(' '), { signal });
      } finally {
        session.destroy?.();
      }
      const points = [];
      for (const en of parseBullets(text)) {
        let es = '';
        try { es = await translator.translate(en); } catch { /* the English point is still useful */ }
        points.push({ en, es });
      }
      if (points.length === 0) throw new Error('Gemini Nano no devolvió puntos clave.');
      return { suggestion: { questionEs: '', intent: '', points, answer: null }, usedContext, omittedContext };
    },
  };
}
