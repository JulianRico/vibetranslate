/**
 * speaker-names.js - Cómo se llama cada voz de la reunión: «Persona N», el nombre con que se presentó
 * («I'm Sarah Mitchell») o el que escribas tú, que siempre manda.
 */

// Palabras con mayúscula que siguen a «I'm» / «This is» sin ser un nombre («I'm Senior Backend Engineer»)
const NOT_NAMES = new Set([
  'senior', 'junior', 'lead', 'principal', 'staff', 'head', 'chief', 'director', 'manager', 'engineer', 'developer',
  'product', 'engineering', 'sorry', 'happy', 'glad', 'excited', 'sure', 'not', 'just', 'here', 'the', 'a', 'an',
  'sharepoint', 'microsoft', 'azure', 'teams', 'google', 'zoom', 'okay', 'ok', 'fine', 'good', 'great', 'really', 'also',
  'going', 'looking', 'currently', 'now', 'still', 'interested', 'responsible', 'part', 'on', 'in', 'from', 'with'
]);

// La entrada puede ir en mayúscula al empezar la frase; el nombre, siempre con mayúscula
const INTRO = /(?:\bI['’]m|\bI am|\b[Mm]y name is|\b[Tt]his is|\b[Ii]t['’]s)\s+([A-Z][a-z]+)(?![A-Za-z])/g;

/** El nombre de pila de una presentación en inglés, o null. */
function nameFromIntroduction(text) {
  for (const m of String(text || '').matchAll(INTRO)) {
    const name = m[1];
    if (name.length >= 2 && !NOT_NAMES.has(name.toLowerCase())) return name;
  }
  return null;
}

function createSpeakerNames() {
  let typed = new Map(); // id → nombre escrito por el usuario
  let heard = new Map(); // id → nombre con que se presentó
  return {
    label(id) {
      return typed.get(id) || heard.get(id) || `Persona ${id}`;
    },
    /** Nombre oído en una presentación: solo si nadie lo ha nombrado antes. */
    suggest(id, name) {
      if (!typed.has(id) && !heard.has(id) && name) heard.set(id, name);
    },
    /** Nombre escrito por el usuario; vacío vuelve a «Persona N». */
    rename(id, name) {
      const clean = String(name || '').trim();
      if (clean) typed.set(id, clean);
      else { typed.delete(id); heard.delete(id); }
    },
    reset() {
      typed = new Map();
      heard = new Map();
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nameFromIntroduction, createSpeakerNames };
}
