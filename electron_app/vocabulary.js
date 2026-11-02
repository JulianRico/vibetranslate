/**
 * vocabulary.js - Vocabulario propio del usuario: el texto del campo de la interfaz ↔ el glosario de la configuración
 *
 * Una entrada por línea: «cómo lo escribe el reconocedor = cómo debe quedar» («Andrews = Andrés»).
 */

function parseVocabulary(text) {
  const glossary = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const heard = line.slice(0, at).trim().toLowerCase();
    const written = line.slice(at + 1).trim();
    if (heard && written) glossary[heard] = written;
  }
  return glossary;
}

function formatVocabulary(glossary) {
  return Object.entries(glossary || {}).map(([heard, written]) => `${heard} = ${written}`).join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseVocabulary, formatVocabulary };
}
