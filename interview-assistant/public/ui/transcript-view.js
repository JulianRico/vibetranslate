import { h } from './dom.js';

/** Left column: what the interviewer said (English + Spanish) and the provisional phrase in grey. */
export function createTranscriptView() {
  const empty = h('p', { class: 'hint' });
  const partial = h('p', { class: 'partial', id: 'partial', hidden: true });
  const list = h('div', { id: 'transcript', class: 'scroll', 'aria-live': 'off' }, empty, partial);
  const rows = new Map(); // line id → { row, es }
  const el = h('section', { class: 'panel' }, h('h2', {}, 'Entrevistador'), list);

  function esNode(es) {
    if (es === null) return { text: 'traduciendo…', cls: 'es pending' };
    if (es === false) return { text: 'sin traducción', cls: 'es missing' };
    return { text: es, cls: 'es' };
  }

  return {
    el,
    render(state) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      empty.hidden = state.lines.length > 0 || Boolean(state.partial);
      empty.textContent = state.session === 'listening' || state.session === 'speaking'
        ? 'Escuchando… lo que diga el entrevistador aparecerá aquí.'
        : 'Pulsa Iniciar para activar el micrófono.';

      const present = new Set(state.lines.map((l) => l.id));
      for (const [id, { row }] of rows) if (!present.has(id)) { row.remove(); rows.delete(id); }
      for (const line of state.lines) {
        let entry = rows.get(line.id);
        if (!entry) {
          const es = h('p', {});
          entry = { row: h('div', { class: 'line', dataset: { id: line.id } }, h('p', { class: 'en' }, line.en), es), es };
          rows.set(line.id, entry);
          list.insertBefore(entry.row, partial);
        }
        const { text, cls } = esNode(line.es);
        entry.es.className = cls;
        entry.es.textContent = text;
      }
      partial.hidden = !state.partial;
      partial.textContent = state.partial;
      if (nearBottom) list.scrollTop = list.scrollHeight;
    },
  };
}
