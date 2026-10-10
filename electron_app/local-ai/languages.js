/**
 * languages.js - Idiomas que admite el motor local y resolución del par origen/destino
 */

const LANGUAGES = {
  en: { code: 'en', name: 'English', label: 'Inglés' },
  es: { code: 'es', name: 'Spanish', label: 'Español' }
};

function shortCode(value) {
  if (!value || typeof value !== 'string') return 'auto';
  const code = value.trim().substring(0, 2).toLowerCase();
  return LANGUAGES[code] ? code : 'auto';
}

function otherLanguage(code) {
  return code === 'es' ? 'en' : 'es';
}

function resolvePair(sourceLang, targetLang) {
  const source = shortCode(sourceLang);
  if (source === 'auto') return null;
  let target = shortCode(targetLang);
  if (target === 'auto' || target === source) target = otherLanguage(source);
  return { source, target };
}

module.exports = { LANGUAGES, shortCode, otherLanguage, resolvePair };
