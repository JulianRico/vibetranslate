/**
 * speaker-tracker.js - Quién habla en el audio de la reunión: agrupa las huellas de voz de cada frase en personas
 *
 * Cada frase trae una huella (un vector del modelo de voz). Si se parece lo bastante a una persona ya oída, es ella;
 * si no, es una persona nueva. Las frases cortas heredan la persona anterior porque con tan poco audio la huella no
 * es fiable, y el número de personas tiene un tope para que el ruido no invente gente.
 */

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function normalized(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

/**
 * @param {{ threshold?: number, minSec?: number, maxSpeakers?: number }} options
 *   threshold: similitud mínima para ser la misma persona; minSec: frases más cortas heredan la persona anterior.
 */
function createSpeakerTracker({ threshold = 0.5, minSec = 1.5, maxSpeakers = 8 } = {}) {
  let speakers = []; // { id, centroid (normalizado), count }
  let last = null;

  function remember(speaker, embedding) {
    // Media de las huellas de esa persona: se afina con cada frase
    const v = normalized(embedding);
    const c = speaker.centroid;
    for (let i = 0; i < c.length; i++) c[i] = (c[i] * speaker.count + v[i]) / (speaker.count + 1);
    speaker.centroid = normalized(c);
    speaker.count++;
  }

  function create(embedding) {
    const s = { id: speakers.length + 1, centroid: normalized(embedding), count: 1 };
    speakers.push(s);
    return s;
  }

  return {
    /** @returns {{ id: number|null, isNew: boolean, similarity: number|null, inherited: boolean }} */
    assign(embedding, durationSec) {
      if (!embedding) return { id: last ? last.id : null, isNew: false, similarity: null, inherited: !!last };
      let best = null;
      let bestSim = -1;
      for (const s of speakers) {
        const sim = cosine(embedding, s.centroid);
        if (sim > bestSim) { bestSim = sim; best = s; }
      }
      // Frase corta: va a la voz conocida más parecida, sin abrir personas nuevas ni retocar su huella media
      // (en la prueba de panel daba 100 % frente al 96 % de heredar la persona anterior)
      if (durationSec < minSec && best) {
        last = best;
        return { id: best.id, isNew: false, similarity: bestSim, inherited: false };
      }
      if (best && (bestSim >= threshold || speakers.length >= maxSpeakers)) {
        remember(best, embedding);
        last = best;
        return { id: best.id, isNew: false, similarity: bestSim, inherited: false };
      }
      last = create(embedding);
      return { id: last.id, isNew: true, similarity: best ? bestSim : null, inherited: false };
    },
    count: () => speakers.length,
    reset() {
      speakers = [];
      last = null;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSpeakerTracker, cosine };
}
