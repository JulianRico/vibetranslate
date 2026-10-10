import { ValidationError } from './errors.js';

export const SUGGESTION_LIMITS = Object.freeze({ MAX_POINTS: 4, MAX_ANSWER_WORDS: 60 });

const PLACEHOLDER = /\[[^\]\n]{0,80}\]/;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

function pair(p) {
  const en = clean(p?.en);
  const es = clean(p?.es);
  return en && es ? { en, es } : null;
}

/**
 * Validates and normalizes what the model returned.
 * @returns {{questionEs: string, intent: string, points: {en: string, es: string}[], answer: {en: string, es: string}}}
 * @throws {ValidationError} with a message that can be fed back to the model for a retry.
 */
export function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('La sugerencia no es un objeto JSON');
  const points = (Array.isArray(raw.points) ? raw.points : []).map(pair).filter(Boolean).slice(0, SUGGESTION_LIMITS.MAX_POINTS);
  if (points.length === 0) throw new ValidationError('La sugerencia no tiene puntos clave con "en" y "es"');
  const answer = pair(raw.answer);
  if (!answer) throw new ValidationError('La sugerencia no tiene respuesta con "en" y "es"');
  if (words(answer.en) > SUGGESTION_LIMITS.MAX_ANSWER_WORDS) {
    throw new ValidationError(`La respuesta en inglés tiene más de ${SUGGESTION_LIMITS.MAX_ANSWER_WORDS} palabras`);
  }
  const suggestion = { questionEs: clean(raw.questionEs), intent: clean(raw.intent), points, answer };
  const everyText = [suggestion.questionEs, ...points.flatMap((p) => [p.en, p.es]), answer.en, answer.es];
  if (everyText.some((t) => PLACEHOLDER.test(t))) throw new ValidationError('La sugerencia contiene marcadores [..] sin rellenar');
  return suggestion;
}
