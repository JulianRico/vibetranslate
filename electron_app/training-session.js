/**
 * training-session.js - Piezas del espacio de práctica que no dependen de la pantalla: juntar la respuesta del usuario,
 * decidir cuándo terminó de hablar, trocear la voz del entrevistador y escribir el informe.
 */

const SILENCE_MS = 3000; // callarse este tiempo termina la respuesta (modo «pausa»)
const SETTLE_MS = 1200; // y la traducción tiene que llevar este tiempo sin cambiar (la nube mejora las líneas)

/** Las líneas de la respuesta actual, en orden de aparición, con la última traducción de cada una. */
function createAnswerCollector() {
  let lines = new Map();
  let lastAt = 0;
  return {
    add({ lineId, original, translated, at = Date.now() }) {
      lines.set(lineId, { original: String(original || '').trim(), translated: String(translated || '').trim() });
      lastAt = at;
    },
    has: (lineId) => lines.has(lineId),
    get() {
      const all = [...lines.values()];
      return {
        spanish: all.map((l) => l.original).filter(Boolean).join(' '),
        english: all.map((l) => l.translated).filter(Boolean).join(' '),
        count: all.length,
        lastAt
      };
    },
    reset() {
      lines = new Map();
      lastAt = 0;
    }
  };
}

/** ¿Terminó de responder? Con «pausa», tras unos segundos de silencio y con la traducción ya quieta. */
function answerReady({ mode, now, lastVoiceAt, lastLineAt, count, silenceMs = SILENCE_MS, settleMs = SETTLE_MS }) {
  if (mode !== 'pause' || count === 0) return false;
  return now - lastVoiceAt >= silenceMs && now - lastLineAt >= settleMs;
}

/** Trozos de como mucho `max` caracteres, cortando por frases (y por comas si una frase es muy larga). */
function ttsChunks(text, max = 190) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  const chunks = [];
  let current = '';
  const pushPiece = (piece) => {
    const p = piece.trim();
    if (!p) return;
    if (!current) current = p;
    else if (current.length + 1 + p.length <= max) current = `${current} ${p}`;
    else { chunks.push(current); current = p; }
  };
  for (const sentence of sentences) {
    if (sentence.trim().length <= max) { pushPiece(sentence); continue; }
    // frase larga: por comas y, si hace falta, por palabras
    for (const part of sentence.split(/(?<=,)\s+/)) {
      if (part.length <= max) { pushPiece(part); continue; }
      for (const word of part.split(' ')) pushPiece(word);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatScore(n) {
  return String(Math.round(Number(n) * 10) / 10).replace('.', ',');
}

const RECOMMENDATION = { hire: 'Contratar', maybe: 'Dudoso', 'no hire': 'No contratar' };

/** El informe que se guarda: nota, valoración y la entrevista completa, en español con el inglés original. */
function formatReport({ date = new Date(), setup, history, evaluation }) {
  const L = [];
  L.push('ViBeTranslate: práctica de entrevista', '');
  L.push(`Fecha: ${date.toLocaleString()}`, `Puesto: ${setup.role}`, '');
  if (evaluation) {
    L.push(`Nota: ${formatScore(evaluation.overall)} / 10 (${RECOMMENDATION[evaluation.recommendation] || evaluation.recommendation})`);
    L.push(`${evaluation.verdict.es}`, `(${evaluation.verdict.en})`, '');
    for (const c of evaluation.categories) L.push(`- ${c.name.es}: ${formatScore(c.score)} / 10. ${c.note.es}`);
    const section = (title, items) => {
      if (!items.length) return;
      L.push('', title);
      for (const i of items) L.push(`- ${i.es}`);
    };
    section('Lo mejor', evaluation.strengths);
    section('Para mejorar', evaluation.improvements);
    section('Lo que no llegó bien por la traducción', evaluation.translationIssues);
    L.push('');
  }
  L.push('--- La entrevista ---', '');
  for (const h of history) {
    if (h.role === 'interviewer') {
      L.push(`Entrevistador: ${h.text}`);
      if (h.translated) L.push(`  (${h.translated})`);
    } else {
      L.push(`Tú: ${h.original || ''}`);
      L.push(`  Lo que recibió: ${h.text || '(no se oyó nada)'}`);
    }
    L.push('');
  }
  return L.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createAnswerCollector, answerReady, ttsChunks, formatScore, formatReport, SILENCE_MS, SETTLE_MS };
}
