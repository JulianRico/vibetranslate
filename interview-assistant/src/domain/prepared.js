import { ValidationError } from './errors.js';

export const PREPARED_LIMITS = Object.freeze({
  MAX_ITEMS: 60, QUESTION: 200, TRIGGERS: 12, TRIGGER: 60, ANSWER_WORDS: 60, POINTS: 4, TEXT: 600,
});

/** template: starter text shipped with the app (unreviewed) · empty: no answer yet · generated: from Gemini · edited: changed by the user. */
export const STATUSES = Object.freeze(['template', 'empty', 'generated', 'edited']);

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

export function normalizeQuestion(raw) {
  const question = clean(raw);
  if (!question) throw new ValidationError('La pregunta no puede estar vacía');
  if (question.length > PREPARED_LIMITS.QUESTION) throw new ValidationError(`La pregunta excede ${PREPARED_LIMITS.QUESTION} caracteres`);
  return question;
}

/** Trimmed, de-duplicated (case-insensitive) trigger phrases; at least one is required. */
export function normalizeTriggers(raw) {
  if (!Array.isArray(raw)) throw new ValidationError('Los triggers deben ser una lista de frases');
  const seen = new Set();
  const triggers = [];
  for (const entry of raw) {
    const trigger = clean(entry);
    if (!trigger) continue;
    if (trigger.length > PREPARED_LIMITS.TRIGGER) throw new ValidationError(`Un trigger excede ${PREPARED_LIMITS.TRIGGER} caracteres`);
    const key = trigger.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    triggers.push(trigger);
  }
  if (triggers.length === 0) throw new ValidationError('Hace falta al menos un trigger (una palabra o frase que identifique la pregunta)');
  if (triggers.length > PREPARED_LIMITS.TRIGGERS) throw new ValidationError(`Máximo ${PREPARED_LIMITS.TRIGGERS} triggers por pregunta`);
  return triggers;
}

function pair(raw) {
  const en = clean(raw?.en);
  const es = clean(raw?.es);
  if (!en || !es) return null;
  if (en.length > PREPARED_LIMITS.TEXT || es.length > PREPARED_LIMITS.TEXT) throw new ValidationError(`Cada texto admite hasta ${PREPARED_LIMITS.TEXT} caracteres`);
  return { en, es };
}

/** `null` (no answer) or `{ en, es }`; the English text may have at most ANSWER_WORDS words. */
export function normalizeAnswer(raw) {
  if (raw === null || raw === undefined) return null;
  const answer = pair(raw);
  if (!answer) throw new ValidationError('La respuesta necesita texto en inglés y en español');
  if (words(answer.en) > PREPARED_LIMITS.ANSWER_WORDS) throw new ValidationError(`La respuesta en inglés tiene más de ${PREPARED_LIMITS.ANSWER_WORDS} palabras`);
  return answer;
}

/** Up to POINTS pairs; pairs missing a language are dropped. */
export function normalizePoints(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError('Los puntos deben ser una lista');
  return raw.map(pair).filter(Boolean).slice(0, PREPARED_LIMITS.POINTS);
}

export function createPrepared({ id, question, triggers, now, answer = null, points = [], status }) {
  const normalizedAnswer = normalizeAnswer(answer);
  return {
    id,
    question: normalizeQuestion(question),
    triggers: normalizeTriggers(triggers),
    answer: normalizedAnswer,
    points: normalizePoints(points),
    status: status ?? (normalizedAnswer ? 'template' : 'empty'),
    generatedAt: null,
    updatedAt: now,
  };
}

/** Stores what Gemini produced (a validated Suggestion); question and triggers are untouched. */
export function applyGenerated(item, suggestion, now) {
  return { ...item, answer: suggestion.answer, points: suggestion.points, status: 'generated', generatedAt: now, updatedAt: now };
}

/**
 * Applies a user edit. Touching the answer or the points makes the item `edited`;
 * `answer: null` clears the answer (status `empty`, no points).
 */
export function applyEdit(item, patch, now) {
  const next = { ...item, updatedAt: now };
  if (patch.question !== undefined) next.question = normalizeQuestion(patch.question);
  if (patch.triggers !== undefined) next.triggers = normalizeTriggers(patch.triggers);
  if (patch.answer !== undefined) {
    next.answer = normalizeAnswer(patch.answer);
    next.status = next.answer ? 'edited' : 'empty';
    if (!next.answer) next.points = [];
  }
  if (patch.points !== undefined) {
    next.points = normalizePoints(patch.points);
    if (next.answer) next.status = 'edited';
  }
  return next;
}
