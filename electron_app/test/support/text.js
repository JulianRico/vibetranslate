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
