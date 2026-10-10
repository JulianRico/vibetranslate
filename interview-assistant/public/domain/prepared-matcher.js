/** Minimum score for a "strong" match, and how far ahead of the runner-up the best one must be. */
export const MIN_SCORE = 2;
export const MIN_MARGIN = 2;

const ALIASES = [[/\.net\b/g, 'dotnet'], [/c#/g, 'csharp'], [/ci\/cd/g, 'cicd'], [/\ba\.i\./g, 'ai']];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'you', 'your', 'do', 'does', 'did', 'are', 'is', 'am', 'be',
  'been', 'tell', 'me', 'my', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'would', 'could', 'can', 'will', 'should', 'have', 'has',
  'had', 'it', 'this', 'that', 'these', 'those', 'at', 'as', 'by', 'from', 'into', 'than', 'then', 'there', 'here', 'our', 'us', 'we', 'they',
  'them', 'their', 'say', 'give', 'describe', 'explain', 'talk', 'please', 'any', 'some', 'more', 'most', 'much', 'very',
]);

/** Lowercase words, with .NET, C#, CI/CD and A.I. spelled as single words. */
function words(text) {
  let t = String(text ?? '').toLowerCase();
  for (const [pattern, replacement] of ALIASES) t = t.replace(pattern, replacement);
  return t.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Simple plural removal ("strengths" → "strength", "weakness" stays). Applied to both sides, so it only has to be consistent. */
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The words of a text as the matcher compares them. */
export function normalize(text) {
  return words(text).map(stem);
}

/** Positions of the text covered by one occurrence of the needle (empty when it does not occur as a contiguous run of words). */
function occurrence(tokens, needle) {
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    if (needle.every((w, j) => tokens[i + j] === w)) return needle.map((_, j) => i + j);
  }
  return [];
}

/** The words of the text that the triggers found as a contiguous run cover: overlapping triggers do not add up twice. */
function coverage(tokens, triggers) {
  const covered = new Set();
  for (const trigger of triggers) {
    const needle = normalize(trigger);
    if (needle.length > 0) for (const position of occurrence(tokens, needle)) covered.add(position);
  }
  return covered;
}

/**
 * The prepared question the interviewer's turn clearly refers to, or null.
 * Only items with an answer take part. A match is strong when the best score (words of the turn its triggers cover)
 * is at least MIN_SCORE and beats the runner-up by at least MIN_MARGIN (a tie or a close call means "not sure": use the AI).
 * A turn that also holds a different question — another item with at least MIN_SCORE words of its own, outside the words
 * the best one covers — is a double question: not sure either.
 */
export function findPrepared(turnText, items) {
  const tokens = normalize(turnText);
  if (tokens.length === 0) return null;
  const ranked = items
    .filter((item) => item.answer && item.status !== 'empty')
    .map((item) => { const covered = coverage(tokens, item.triggers); return { item, covered, score: covered.size }; })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best || best.score < MIN_SCORE) return null;
  if (second && best.score - second.score < MIN_MARGIN) return null;
  const another = ranked.slice(1).some((entry) => [...entry.covered].filter((p) => !best.covered.has(p)).length >= MIN_SCORE);
  return another ? null : best.item;
}

/** Suggested triggers for a new question: its content words as written (no filler words, at least 3 letters), without repeats, at most 8. Matching normalizes triggers, so plurals still match. */
export function deriveTriggers(question) {
  const out = [];
  for (const raw of words(question)) {
    if (STOPWORDS.has(raw) || (raw.length < 3 && raw !== 'ai')) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out.slice(0, 8);
}
