import { LIMITS } from '../../domain/context-item.js';
import { select, describeSelection } from '../../domain/context-budget.js';
import { buildSystemPrompt, buildUserPrompt } from '../../domain/coach-prompt.js';
import { normalizeSuggestion } from '../../domain/suggestion.js';
import { NotConfiguredError, UpstreamError, ValidationError } from '../../domain/errors.js';

const MAX_TEXT_CHARS = 600;
const MAX_TURNS = 3;
const MAX_HISTORY = 4;

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${label} debe ser texto no vacío`);
  if (value.length > MAX_TEXT_CHARS) throw new ValidationError(`${label} excede ${MAX_TEXT_CHARS} caracteres`);
  return value.trim();
}

function validateInput({ turns, history }) {
  if (!Array.isArray(turns) || turns.length < 1 || turns.length > MAX_TURNS) {
    throw new ValidationError(`turns debe tener de 1 a ${MAX_TURNS} frases`);
  }
  const hist = history === undefined ? [] : history;
  if (!Array.isArray(hist) || hist.length > MAX_HISTORY) throw new ValidationError(`history admite hasta ${MAX_HISTORY} entradas`);
  return {
    turns: turns.map((t) => text(t, 'Cada frase')),
    history: hist.map((h) => ({
      interviewer: text(h?.interviewer, 'history.interviewer'),
      ...(h?.suggestedAnswer ? { suggestedAnswer: text(h.suggestedAnswer, 'history.suggestedAnswer') } : {}),
    })),
  };
}

/**
 * Asks the LLM for a suggestion and validates it; one retry (telling the model what was wrong) if the output is invalid.
 * @param {{llm: import('../ports.js').LlmGateway, profileRepo: import('../ports.js').ProfileRepository, contextRepo: import('../ports.js').ContextRepository}} deps
 */
export function createSuggestAnswer({ llm, profileRepo, contextRepo }) {
  return async function suggestAnswer({ turns, history, signal }) {
    const input = validateInput({ turns, history });
    if (!llm.isConfigured()) throw new NotConfiguredError('Sin clave de Gemini: define GEMINI_API_KEY en el servidor');

    const [profile, items] = await Promise.all([profileRepo.load(), contextRepo.list()]);
    const selection = select(items, LIMITS.MAX_ACTIVE_CHARS);
    const system = buildSystemPrompt({ profile, included: selection.included, mode: 'cloud' });
    const prompt = buildUserPrompt(input);

    let suggestion;
    let lastProblem = '';
    for (let attempt = 0; attempt < 2 && !suggestion; attempt++) {
      const retryNote = attempt === 0 ? '' : `\n\nYour previous reply was rejected: ${lastProblem}. Reply again with valid JSON that follows the rules.`;
      try {
        const raw = await llm.generateJson({ system, prompt: prompt + retryNote, temperature: 0.5, signal });
        suggestion = normalizeSuggestion(raw);
      } catch (err) {
        if (!(err instanceof ValidationError) && !err?.invalidOutput) throw err;
        lastProblem = err.message;
      }
    }
    if (!suggestion) throw new UpstreamError(`El modelo devolvió una sugerencia inválida: ${lastProblem}`);
    return { suggestion, ...describeSelection(selection) };
  };
}
