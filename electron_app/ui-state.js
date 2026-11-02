/**
 * ui-state.js - Lo que dice la pantalla principal: los idiomas, el cronómetro y si todo está listo para la reunión
 */

const { shortCode, otherLanguage } = require('./local-ai/languages');

const NAMES = { es: 'español', en: 'inglés' };

/** «Hablas en español y la reunión te oye en inglés.» */
function directionText(sourceLang, targetLang) {
  const source = shortCode(sourceLang);
  if (source === 'auto') return 'Detecta si hablas en español o en inglés y traduce cada frase al otro idioma.';
  let target = shortCode(targetLang);
  if (target === 'auto' || target === source) target = otherLanguage(source);
  return `Hablas en ${NAMES[source]} y la reunión te oye en ${NAMES[target]}.`;
}

/** Tiempo traduciendo: «1:05», «1:02:03». */
function formatElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

const CLOUD_KEYS = {
  gemini_35_transcribe: { key: 'geminiKey', name: 'Gemini' },
  gemini_live: { key: 'geminiKey', name: 'Gemini' },
  whisper_groq: { key: 'groqKey', name: 'Groq' }
};

function engineCheck({ engine, sourceLang, groqKey, geminiKey, local }) {
  const keys = { groqKey, geminiKey };
  const cloud = CLOUD_KEYS[engine];
  if (cloud) {
    if (String(keys[cloud.key] || '').trim().length >= 5) return { state: 'ok' };
    return {
      state: 'error',
      text: `Falta la clave de ${cloud.name} para reconocer la voz.`,
      action: { id: 'open-engine', label: 'Poner la clave' }
    };
  }
  if (engine === 'local') {
    if (shortCode(sourceLang) === 'auto') {
      return {
        state: 'error',
        text: 'El motor local necesita saber en qué idioma hablas: elige español o inglés.',
        action: { id: 'open-languages', label: 'Elegir idioma' }
      };
    }
    if (local && !local.ready) {
      return {
        state: 'warn',
        text: `Al empezar se descargarán ${Math.round((local.missingBytes || 0) / 1e6)} MB del motor local, solo la primera vez.`,
        action: null
      };
    }
  }
  return { state: 'ok' };
}

/**
 * Las tres comprobaciones de la pantalla principal y el aviso más importante (un error antes que una advertencia,
 * y entre iguales el micrófono, luego el cable y luego el motor).
 */
function readiness({ micCount, hasVirtualCable, engine, sourceLang, groqKey, geminiKey, local }) {
  const found = [
    {
      id: 'mic',
      label: 'Micrófono',
      ...(micCount > 0
        ? { state: 'ok' }
        : { state: 'error', text: 'No hay ningún micrófono conectado.', action: { id: 'open-audio', label: 'Elegir micrófono' } })
    },
    {
      id: 'cable',
      label: 'Cable virtual',
      ...(hasVirtualCable
        ? { state: 'ok' }
        : {
          state: 'error',
          text: 'Falta el cable virtual: sin él, la reunión no oye tu traducción. Los subtítulos sí funcionan.',
          action: { id: 'install-cable', label: 'Instalar VB-CABLE' }
        })
    },
    { id: 'engine', label: 'Motor', ...engineCheck({ engine, sourceLang, groqKey, geminiKey, local }) }
  ];
  const worst = found.find((c) => c.state === 'error') || found.find((c) => c.state === 'warn');
  return {
    checks: found.map(({ id, label, state }) => ({ id, label, state })),
    notice: worst ? { state: worst.state, text: worst.text, action: worst.action || null } : null
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { directionText, formatElapsed, readiness };
}
