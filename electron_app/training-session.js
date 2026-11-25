/**
 * training-session.js - Piezas del espacio de práctica que no dependen de la pantalla: juntar la respuesta del usuario,
 * decidir cuándo terminó de hablar, trocear la voz del interlocutor y escribir los informes (libreto + evaluación).
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

const RECOMMENDATION = {
  hire: 'Contratar',
  maybe: 'Dudoso',
  'no hire': 'No contratar',
  ready: 'Listo para equipo internacional',
  almost: 'Casi listo · afinar detalles',
  needs_practice: 'Requiere más práctica'
};

/** Exporta el libreto generado con IA para estudiarlo antes o después de practicar. */
function formatPlaybookReport({ date = new Date(), setup = {}, playbook }) {
  const isMeeting = setup.mode === 'meeting';
  const L = [];
  L.push(`ViBeTranslate: libreto de práctica (${isMeeting ? 'Reunión internacional' : 'Entrevista'})`, '');
  L.push(`Fecha: ${date.toLocaleString()}`);
  if (setup.sector) L.push(`Sector: ${setup.sector}`);
  if (setup.topic) L.push(`Tema: ${setup.topic}`);
  if (setup.role) L.push(`Rol / Puesto: ${setup.role}`);
  L.push('');

  if (playbook) {
    if (playbook.scenarioTitle && playbook.scenarioTitle.es) {
      L.push(`Escenario: ${playbook.scenarioTitle.es}`);
      if (playbook.scenarioTitle.en && playbook.scenarioTitle.en !== playbook.scenarioTitle.es) {
        L.push(`  (${playbook.scenarioTitle.en})`);
      }
    }
    if (playbook.interlocutor && playbook.interlocutor.name) {
      const p = playbook.interlocutor;
      L.push(`Interlocutor: ${p.name} — ${p.role}${p.location ? ` (${p.location})` : ''}`);
      if (p.style) L.push(`Estilo: ${p.style}`);
    }
    if (playbook.brief && playbook.brief.es) {
      L.push('', `Contexto: ${playbook.brief.es}`);
      if (playbook.brief.en) L.push(`  (${playbook.brief.en})`);
    }
    if (playbook.culturalTip && playbook.culturalTip.es) {
      L.push('', `Clave intercultural: ${playbook.culturalTip.es}`);
    }

    L.push('', '--- Guion de preguntas y cómo responder ---', '');
    for (const [idx, turn] of (playbook.turns || []).entries()) {
      L.push(`${idx + 1}. ${turn.question.en}`);
      if (turn.question.es) L.push(`   (${turn.question.es})`);
      if (turn.intent) L.push(`   Qué evalúa: ${turn.intent}`);
      if (turn.howToAnswer) L.push(`   Cómo responder: ${turn.howToAnswer}`);
      if (turn.sampleAnswer && turn.sampleAnswer.en) {
        L.push(`   Respuesta modelo (EN): ${turn.sampleAnswer.en}`);
        if (turn.sampleAnswer.es) L.push(`   Respuesta modelo (ES): ${turn.sampleAnswer.es}`);
      }
      if (Array.isArray(turn.keyPhrases) && turn.keyPhrases.length) {
        L.push(`   Frases clave: ${turn.keyPhrases.map((p) => `"${p.en}" (${p.es})`).join(' · ')}`);
      }
      if (Array.isArray(turn.evalCriteria) && turn.evalCriteria.length) {
        L.push(`   Criterios: ${turn.evalCriteria.join(' · ')}`);
      }
      L.push('');
    }

    if (Array.isArray(playbook.vocabulary) && playbook.vocabulary.length) {
      L.push('--- Glosario clave del sector ---', '');
      for (const v of playbook.vocabulary) {
        L.push(`- ${v.term}${v.es ? ` (${v.es})` : ''}${v.usage ? `: ${v.usage}` : ''}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

/** El informe que se guarda: nota, valoración, revisión turno por turno y la sesión completa en ambos idiomas. */
function formatReport({ date = new Date(), setup = {}, history = [], evaluation, playbook = null }) {
  const isMeeting = setup.mode === 'meeting';
  const counterpartLabel = (playbook && playbook.interlocutor && playbook.interlocutor.name)
    ? playbook.interlocutor.name
    : (isMeeting ? 'Interlocutor' : 'Entrevistador');
  const L = [];
  L.push(isMeeting ? 'ViBeTranslate: práctica de reunión internacional' : 'ViBeTranslate: práctica de entrevista', '');
  L.push(`Fecha: ${date.toLocaleString()}`);
  if (setup.sector) L.push(`Sector: ${setup.sector}`);
  if (setup.topic) L.push(`Tema: ${setup.topic}`);
  L.push(`Puesto: ${setup.role || ''}`, '');

  if (evaluation) {
    L.push(`Nota: ${formatScore(evaluation.overall)} / 10 (${RECOMMENDATION[evaluation.recommendation] || evaluation.recommendation})`);
    L.push(`${evaluation.verdict.es}`, `(${evaluation.verdict.en})`, '');
    for (const c of evaluation.categories) L.push(`- ${c.name.es}: ${formatScore(c.score)} / 10. ${c.note.es}`);
    const section = (title, items) => {
      if (!Array.isArray(items) || !items.length) return;
      L.push('', title);
      for (const i of items) L.push(`- ${i.es}`);
    };
    section('Lo mejor', evaluation.strengths);
    section('Para mejorar', evaluation.improvements);
    section('Lo que no llegó bien por la traducción', evaluation.translationIssues);
    section('Plan de acción para equipos internacionales', evaluation.nextSteps);

    if (Array.isArray(evaluation.turnFeedback) && evaluation.turnFeedback.length) {
      L.push('', '--- Revisión turno por turno ---', '');
      for (const [idx, tf] of evaluation.turnFeedback.entries()) {
        L.push(`Turno ${idx + 1} (${formatScore(tf.score)} / 10): ${tf.question}`);
        if (tf.strength && tf.strength.es) L.push(`  Bien: ${tf.strength.es}`);
        if (tf.improvement && tf.improvement.es) L.push(`  Mejorar: ${tf.improvement.es}`);
        if (tf.betterAnswer && tf.betterAnswer.en) {
          L.push(`  Respuesta recomendada (EN): ${tf.betterAnswer.en}`);
          if (tf.betterAnswer.es) L.push(`  (ES): ${tf.betterAnswer.es}`);
        }
        L.push('');
      }
    }
    L.push('');
  }

  L.push(isMeeting ? '--- La reunión ---' : '--- La entrevista ---', '');
  for (const h of history) {
    if (h.role === 'interviewer') {
      L.push(`${counterpartLabel}: ${h.text}`);
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
  module.exports = {
    createAnswerCollector,
    answerReady,
    ttsChunks,
    formatScore,
    formatReport,
    formatPlaybookReport,
    RECOMMENDATION,
    SILENCE_MS,
    SETTLE_MS
  };
}
