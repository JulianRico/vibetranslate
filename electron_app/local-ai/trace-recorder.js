/**
 * trace-recorder.js - Sesiones de prueba: guarda cada frase (audio, texto, traducción y tiempos) y genera un informe
 */

const fs = require('fs');
const path = require('path');
const { encodeWAV } = require('../audio-utils');

const STREAM_NAMES = { mic: 'Tu micrófono', incoming: 'Reunión (audio del equipo)' };

/** Resumen de una lista de tiempos en milisegundos. */
function stats(values) {
  if (values.length === 0) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return {
    n: sorted.length,
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]
  };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function sessionName(ms) {
  const d = new Date(ms);
  return `sesion-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function summarize(session, endedAt) {
  const segments = session.events.filter((e) => e.type === 'segment');
  const translations = session.events.filter((e) => e.type === 'translation');
  const refines = session.events.filter((e) => e.type === 'refine');
  const streams = {};
  for (const name of [...new Set([...segments, ...translations].map((e) => e.stream))]) {
    const heard = segments.filter((e) => e.stream === name);
    const done = translations.filter((e) => e.stream === name);
    const translated = done.filter((e) => e.translated && String(e.translated).trim());
    const audioMs = heard.reduce((n, e) => n + (e.durationMs || 0), 0);
    const sttMs = heard.reduce((n, e) => n + (e.sttMs || 0), 0);
    const engines = {};
    for (const e of translated) engines[e.engine] = (engines[e.engine] || 0) + 1;
    streams[name] = {
      phrases: heard.length,
      audioMs,
      stt: stats(heard.map((e) => e.sttMs || 0)),
      realTimeFactor: audioMs > 0 ? Math.round((sttMs / audioMs) * 100) / 100 : 0,
      translate: stats(translated.map((e) => e.translateMs || 0)),
      endToEnd: stats(translated.map((e) => e.endToEndMs || 0)),
      engines,
      untranslated: done.length - translated.length,
      joined: done.filter((e) => e.join).length,
      refined: refines.filter((e) => e.stream === name).length
    };
  }
  return {
    startedAt: new Date(session.startedAt).toISOString(),
    durationMs: endedAt - session.startedAt,
    meta: session.meta,
    streams,
    errors: session.events.filter((e) => e.type === 'error').length,
    echoesDropped: session.events.filter((e) => e.type === 'echo').length,
    flags: session.events.filter((e) => e.type === 'flag').map(({ segmentId, stream, text, note }) => ({ segmentId, stream, text, note })),
    audioFiles: session.audioCount
  };
}

function formatReport(session, summary) {
  const out = [];
  const clock = (t) => `${pad(Math.floor(t / 60000))}:${pad(Math.floor(t / 1000) % 60)}`;
  out.push(`# Sesión de prueba — ${new Date(session.startedAt).toLocaleString()}`, '');
  out.push(`Duración: ${clock(summary.durationMs)} min`);
  for (const [key, value] of Object.entries(summary.meta || {})) out.push(`${key}: ${value}`);
  out.push('', '## Resumen', '');

  for (const [name, s] of Object.entries(summary.streams)) {
    out.push(`### ${STREAM_NAMES[name] || name}`, '');
    out.push(`- Frases oídas: ${s.phrases} (${(s.audioMs / 1000).toFixed(1)} s de voz)`);
    out.push(`- Transcripción: media ${s.stt.avg} ms, mediana ${s.stt.p50} ms, percentil 95 ${s.stt.p95} ms, máximo ${s.stt.max} ms`);
    out.push(`- Tiempo de transcripción / duración de la voz: ${s.realTimeFactor} (por debajo de 1 va más rápido que el habla)`);
    out.push(`- Traducción: media ${s.translate.avg} ms, máximo ${s.translate.max} ms; motores: ${Object.entries(s.engines).map(([e, n]) => `${e} ×${n}`).join(', ') || 'ninguno'}`);
    out.push(`- Fin de la voz ➔ subtítulo en pantalla: media ${s.endToEnd.avg} ms, percentil 95 ${s.endToEnd.p95} ms, máximo ${s.endToEnd.max} ms`);
    if (s.joined > 0) out.push(`- Trozos unidos a la frase anterior: ${s.joined}`);
    if (s.refined > 0) out.push(`- Líneas mejoradas por la nube: ${s.refined}`);
    if (s.untranslated > 0) out.push(`- **Frases sin traducir: ${s.untranslated}**`);
    out.push('');
  }
  if (Object.keys(summary.streams).length === 0) out.push('No se oyó ninguna frase en esta sesión.', '');
  out.push(`Errores registrados: ${summary.errors}`, `Audios guardados: ${summary.audioFiles}`);
  out.push(`Frases del micrófono descartadas por ser eco de la reunión: ${summary.echoesDropped}`, '');

  const segments = session.events.filter((e) => e.type === 'segment');
  const translationFor = (id) => session.events.find((e) => e.type === 'translation' && e.segmentId === id);
  const refineFor = (id) => [...session.events].reverse().find((e) => e.type === 'refine' && e.segmentId === id);
  const audioFor = (id) => session.audioById.get(id) || '';

  const slow = segments.filter((e) => e.sttMs > e.durationMs);
  if (slow.length > 0) {
    out.push('## Frases transcritas más lento que el habla', '');
    for (const e of slow) out.push(`- [${clock(e.t)}] ${e.sttMs} ms para ${e.durationMs} ms de voz: «${e.text}» ${audioFor(e.id)}`);
    out.push('');
  }

  if (summary.flags.length > 0) {
    out.push('## Frases marcadas como problema', '');
    for (const f of summary.flags) {
      const tr = f.segmentId !== null ? translationFor(f.segmentId) : null;
      out.push(`- **${f.note || 'sin nota'}**`);
      if (f.text) out.push(`  - Oído: «${f.text}»`);
      if (tr) out.push(`  - Traducción: «${tr.translated || '(sin traducción)'}»`);
      if (f.segmentId !== null && audioFor(f.segmentId)) out.push(`  - Audio: ${audioFor(f.segmentId)}`);
    }
    out.push('');
  }

  const errors = session.events.filter((e) => e.type === 'error');
  if (errors.length > 0) {
    out.push('## Errores', '');
    for (const e of errors) out.push(`- [${clock(e.t)}] ${e.message}`);
    out.push('');
  }

  out.push('## Conversación', '');
  for (const e of segments) {
    const tr = translationFor(e.id);
    out.push(`**[${clock(e.t)}] ${STREAM_NAMES[e.stream] || e.stream}** — voz ${e.durationMs} ms, transcripción ${e.sttMs} ms${tr ? `, traducción ${tr.translateMs} ms (${tr.engine})` : ''}`);
    out.push(`- Oído: ${e.text}`);
    if (e.heard) out.push(`- Antes de corregir los términos técnicos: ${e.heard}`);
    out.push(`- Traducción: ${tr ? (tr.translated || `(sin traducción: ${tr.error || 'motivo desconocido'})`) : '(no llegó a traducirse)'}`);
    if (tr && tr.join) {
      out.push(`- Frase completa: ${tr.join.text}`);
      out.push(`- Traducción de la frase completa: ${tr.join.translated}`);
    }
    const better = refineFor(e.id);
    if (better) out.push(`- Mejorada en la nube (${better.engine}, ${better.translateMs} ms): ${better.translated}`);
    if (audioFor(e.id)) out.push(`- Audio: ${audioFor(e.id)}`);
    out.push('');
  }
  return out.join('\n');
}

function createTraceRecorder({ baseDir, now = Date.now }) {
  let session = null;

  function record(type, data = {}) {
    if (!session) return;
    const event = { t: now() - session.startedAt, type, ...data };
    session.events.push(event);
    // Con traducción directa el texto oído llega después: se une a su frase para el resumen y el informe
    if (type === 'segment-text') {
      const segment = session.events.find((e) => e.type === 'segment' && e.id === data.id);
      if (segment) {
        segment.text = data.text;
        segment.sttMs = data.sttMs;
      }
    }
    // Se escribe al momento: si la app se cierra a mitad, la traza queda en disco
    fs.appendFileSync(session.traceFile, JSON.stringify(event) + '\n', 'utf8');
  }

  function stop() {
    if (!session) return null;
    const ended = session;
    const endedAt = now();
    record('session-end');
    session = null;
    const summary = summarize(ended, endedAt);
    const report = formatReport(ended, summary);
    fs.writeFileSync(path.join(ended.dir, 'resumen.json'), JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(path.join(ended.dir, 'informe.md'), report, 'utf8');
    return { dir: ended.dir, summary, report };
  }

  return {
    isActive: () => session !== null,
    savesAudio: () => session !== null && session.saveAudio,

    start({ meta = {}, saveAudio = true } = {}) {
      stop();
      const startedAt = now();
      let dir = path.join(baseDir, sessionName(startedAt));
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(baseDir, `${sessionName(startedAt)}-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      session = { dir, startedAt, meta, saveAudio, events: [], audioCount: 0, audioById: new Map(), traceFile: path.join(dir, 'trace.jsonl') };
      record('session-start', { meta, saveAudio });
      return { dir };
    },

    record,

    /** Guarda el audio de una frase y devuelve su ruta relativa a la carpeta de la sesión. */
    saveAudio({ id, stream, samples }) {
      if (!session || !session.saveAudio) return null;
      const name = `audio/${pad(++session.audioCount, 3)}-${stream}-${id}.wav`;
      fs.mkdirSync(path.join(session.dir, 'audio'), { recursive: true });
      fs.writeFileSync(path.join(session.dir, name), Buffer.from(encodeWAV(samples, 16000)));
      session.audioById.set(id, name);
      return name;
    },

    /** El usuario marca como problema la última frase oída. */
    flag(note = '') {
      if (!session) return null;
      const last = [...session.events].reverse().find((e) => e.type === 'segment');
      const flagged = { segmentId: last ? last.id : null, stream: last ? last.stream : null, text: last ? last.text : '', note };
      record('flag', flagged);
      return flagged;
    },

    stop
  };
}

module.exports = { createTraceRecorder, stats };
