/**
 * sentence-joiner.js - Une los trozos de una misma frase que el detector de voz cortó en una pausa breve
 *
 * El detector corta tras 350 ms de silencio o a los ~4 s de voz, así que una frase larga llega en trozos
 * («Of course, we don't know what's going to.» + «happen in a year…»). Traducidos por separado pierden el
 * sentido; unidos, el traductor ve la frase entera. El subtítulo de la frase se reescribe con la traducción
 * completa; el primer trozo da nombre a la línea (`lineId`).
 */

const MAX_GAP_MS = 1500; // con más silencio entre trozos ya es otra frase
// Tras un punto, empezar en minúscula es una pista débil: Canary escribe en minúscula muchos comienzos de frase en
// español. En las sesiones de prueba las continuaciones reales llegaron con 0,5-0,7 s de pausa y una frase nueva con
// 1,35 s; el detector mide unos 250 ms menos que la pausa real.
const MAX_GAP_AFTER_PERIOD_MS = 800;
const MAX_PARTS = 4;
const MAX_WORDS = 60; // una frase más larga ya no aporta contexto y cuesta más traducirla

// Palabras que no cierran una frase: si el trozo acaba en una de ellas, el siguiente la continúa
const OPEN_ENDINGS = {
  en: ['a', 'an', 'the', 'of', 'to', 'and', 'or', 'but', 'because', 'than', 'if', 'my', 'your', 'our', 'their', 'its', 'every', 'each', 'into', 'going', 'gonna', 'very', 'such', 'whose'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'entre', 'hacia', 'desde', 'hasta', 'y', 'e', 'o', 'u', 'pero', 'que', 'porque', 'si', 'mi', 'tu', 'su', 'mis', 'tus', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'muy', 'cada']
};
const OPEN = Object.fromEntries(Object.entries(OPEN_ENDINGS).map(([lang, words]) => [lang, new Set(words)]));

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
const lastWord = (text) => (text.toLowerCase().match(/[\p{L}']+(?=[^\p{L}']*$)/u) || [''])[0];

/**
 * ¿El trozo nuevo sigue la frase anterior? 'strong' si la anterior no estaba cerrada, 'weak' si solo lo sugiere
 * la minúscula inicial, false si es otra frase.
 */
function continues(previous, next, lang) {
  const prev = previous.trim();
  // Sin punto final (coma, palabra suelta): la frase no había terminado
  if (!/[.!?…]["')\]»]*$/.test(prev)) return 'strong';
  // Punto puesto al cortar, detrás de una palabra que no puede cerrar una frase («going to.», «en esta.»)
  if (/[^.]\.$/.test(prev) && (OPEN[lang] || OPEN.en).has(lastWord(prev))) return 'strong';
  // Empieza en minúscula: el modelo de voz la oyó como continuación
  if (/^[¿¡"'(«]*\p{Ll}/u.test(next.trim())) return 'weak';
  return false;
}

/** Une dos trozos quitando el punto que el modelo pone al final de cada uno. */
function joinText(previous, next) {
  const prev = previous.trim().replace(/([^.])\.$/, '$1');
  return `${prev} ${next.trim()}`;
}

function createSentenceJoiner({ maxGapMs = MAX_GAP_MS, maxGapAfterPeriodMs = MAX_GAP_AFTER_PERIOD_MS, maxParts = MAX_PARTS, maxWords = MAX_WORDS } = {}) {
  const open = new Map(); // flujo → frase en curso { lineId, lang, text, parts }

  return {
    /**
     * Registra un trozo y dice qué hay que traducir para el subtítulo.
     * @param {{ stream: string, id: *, lang: string, text: string, gapMs?: number|null }} piece
     *   `gapMs`: silencio entre el final del trozo anterior del mismo flujo y el comienzo de este.
     * @returns {{ joined: boolean, lineId: *, text: string }} `text` es la frase completa hasta ahora.
     */
    add({ stream, id, lang, text, gapMs = null }) {
      const prev = open.get(stream);
      const fits = prev && prev.lang === lang && gapMs !== null && gapMs <= maxGapMs &&
        prev.parts < maxParts && wordCount(prev.text) + wordCount(text) <= maxWords;
      const link = fits ? continues(prev.text, text, lang) : false;
      if (link === 'strong' || (link === 'weak' && gapMs <= maxGapAfterPeriodMs)) {
        const merged = { lineId: prev.lineId, lang, text: joinText(prev.text, text), parts: prev.parts + 1 };
        open.set(stream, merged);
        return { joined: true, lineId: merged.lineId, text: merged.text };
      }
      open.set(stream, { lineId: id, lang, text: text.trim(), parts: 1 });
      return { joined: false, lineId: id, text: text.trim() };
    },
    /** Olvida la frase en curso (al parar o al cambiar de idioma): lo siguiente empieza línea nueva. */
    reset(stream) {
      if (stream === undefined) open.clear();
      else open.delete(stream);
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSentenceJoiner, continues, joinText, MAX_GAP_MS };
}
