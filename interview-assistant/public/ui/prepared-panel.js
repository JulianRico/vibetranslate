import { h, lines } from './dom.js';
import { deriveTriggers } from '../domain/prepared-matcher.js';

const STATUS_LABEL = { template: 'plantilla sin revisar', empty: 'sin respuesta', generated: 'generada', edited: 'editada' };

const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);

const pairsToText = (pairs) => pairs.map((p) => `${p.en} | ${p.es}`).join('\n');

/** "english | español" per line → [{ en, es }]; lines without both parts are ignored. */
function textToPairs(text) {
  return String(text).split('\n')
    .map((line) => line.split('|'))
    .filter((parts) => parts.length >= 2)
    .map(([en, ...rest]) => ({ en: en.trim(), es: rest.join('|').trim() }))
    .filter((pair) => pair.en && pair.es);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** «Preparadas» tab: the bank of typical questions with their ready answers, to review, edit, generate with AI, add and delete. */
export function createPreparedPanel({ preparedActions }) {
  const summary = h('p', { id: 'prepared-summary', class: 'warn', hidden: true });
  const bulkBtn = h('button', { id: 'prepared-generate-all', class: 'btn', type: 'button', onClick: () => preparedActions.generateMissing() }, 'Personalizar con IA');
  const cancelBtn = h('button', { id: 'prepared-cancel', class: 'btn small', type: 'button', hidden: true, onClick: () => preparedActions.cancelGeneration() }, 'Cancelar');
  const progress = h('span', { id: 'prepared-progress', class: 'meta' });
  const errorBox = h('div', { id: 'prepared-error', class: 'banner', role: 'alert', hidden: true });

  const newQuestion = h('input', { id: 'prepared-new-question', type: 'text', maxLength: 200, placeholder: 'Pregunta en inglés (p. ej. Tell me about Kubernetes)' });
  const newTriggers = h('textarea', { id: 'prepared-new-triggers', rows: 3, placeholder: 'Palabras o frases clave, una por línea (se proponen solas)' });
  const addBtn = h('button', { id: 'prepared-add', class: 'btn', type: 'button' }, 'Agregar pregunta');
  let triggersTouched = false;
  newTriggers.addEventListener('input', () => { triggersTouched = true; });
  newQuestion.addEventListener('input', () => {
    if (!triggersTouched) newTriggers.value = deriveTriggers(newQuestion.value).join('\n');
  });
  addBtn.addEventListener('click', async () => {
    const ok = await preparedActions.add({ question: newQuestion.value, triggers: lines(newTriggers.value) });
    if (ok) { newQuestion.value = ''; newTriggers.value = ''; triggersTouched = false; }
  });

  const list = h('ul', { id: 'prepared-list', class: 'prepared' });
  const openIds = new Set(); // keeps the editors open while the list is rebuilt

  const drafts = new Map(); // id → text typed in the editor and not saved yet; survives the list being rebuilt
  const generateButtons = new Map(); // id → its "Generar con IA" button, updated in place when the busy state changes

  function row(item) {
    const draft = drafts.get(item.id) ?? {};
    const keep = (key, control) => {
      control.addEventListener('input', () => drafts.set(item.id, { ...drafts.get(item.id), [key]: control.value }));
      return control;
    };
    const question = keep('question', h('input', { type: 'text', class: 'pr-question', maxLength: 200, value: draft.question ?? item.question }));
    const triggers = keep('triggers', h('textarea', { class: 'pr-triggers', rows: 3, value: draft.triggers ?? item.triggers.join('\n') }));
    const en = keep('en', h('textarea', { class: 'pr-en', rows: 3, value: draft.en ?? item.answer?.en ?? '' }));
    const es = keep('es', h('textarea', { class: 'pr-es', rows: 3, value: draft.es ?? item.answer?.es ?? '' }));
    const points = keep('points', h('textarea', { class: 'pr-points', rows: 3, placeholder: 'Un punto por línea: inglés | español', value: draft.points ?? pairsToText(item.points) }));

    const save = () => {
      const patch = { question: question.value, triggers: lines(triggers.value) };
      const answerChanged = en.value.trim() !== (item.answer?.en ?? '') || es.value.trim() !== (item.answer?.es ?? '');
      if (answerChanged) patch.answer = en.value.trim() || es.value.trim() ? { en: en.value, es: es.value } : null;
      if (points.value.trim() !== pairsToText(item.points).trim()) patch.points = textToPairs(points.value);
      return preparedActions.update(item.id, patch);
    };
    const saveAndForget = async () => { if (await save()) drafts.delete(item.id); };
    const generate = async () => {
      if (item.status === 'edited' && !window.confirm('Esta respuesta la editaste tú. ¿Reemplazarla con una nueva generada por la IA?')) return;
      if (await preparedActions.generate(item.id, { force: item.status === 'edited' })) drafts.delete(item.id);
    };
    const generateBtn = h('button', { class: 'btn small pr-generate', type: 'button', onClick: generate }, 'Generar con IA');
    generateButtons.set(item.id, generateBtn);

    const details = h('details', { class: 'prepared-item', dataset: { id: item.id }, open: openIds.has(item.id) },
      h('summary', {},
        h('span', { class: 'pr-title' }, item.question),
        h('span', { class: `chip pr-status pr-${item.status}` }, STATUS_LABEL[item.status] ?? item.status)),
      h('div', { class: 'form' },
        field('Pregunta', question),
        field('Palabras o frases clave (una por línea)', triggers),
        field('Respuesta en inglés', en),
        field('Respuesta en español', es),
        field('Puntos clave', points),
        item.generatedAt ? h('p', { class: 'meta' }, `Generada el ${when(item.generatedAt)}`) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small pr-save', type: 'button', onClick: saveAndForget }, 'Guardar'),
          generateBtn,
          h('button', {
            class: 'btn ghost small pr-delete', type: 'button',
            onClick: () => { if (window.confirm(`¿Borrar «${item.question}»?`)) { drafts.delete(item.id); preparedActions.remove(item.id); } },
          }, 'Borrar'))));
    details.addEventListener('toggle', () => { if (details.open) openIds.add(item.id); else openIds.delete(item.id); });
    return h('li', {}, details);
  }

  /** Only the buttons change when a generation starts or ends: the editors (and what is typed in them) stay as they are. */
  function applyBusy(busy) {
    for (const [id, button] of generateButtons) {
      button.disabled = Boolean(busy);
      button.textContent = busy === id ? 'Generando…' : 'Generar con IA';
    }
  }

  let last = {};
  return {
    el: h('div', { id: 'panel-prepared', class: 'tab-panel' },
      h('p', { class: 'meta' }, 'Respuestas listas para las preguntas típicas: cuando el entrevistador pregunta algo parecido, aparecen al instante, sin esperar a la IA.'),
      summary,
      h('div', { class: 'row' }, bulkBtn, cancelBtn, progress),
      errorBox,
      h('h3', {}, 'Agregar pregunta'), newQuestion, newTriggers, addBtn,
      h('h3', {}, 'Preguntas'), list),
    render(state) {
      const p = state.prepared;
      const templates = p.items.filter((i) => i.status === 'template').length;
      summary.hidden = templates === 0;
      summary.textContent = `${templates} ${templates === 1 ? 'respuesta sigue siendo una plantilla sin revisar' : 'respuestas siguen siendo plantillas sin revisar'}: léelas, edítalas o usa «Personalizar con IA».`;
      const pending = p.items.filter((i) => i.status === 'template' || i.status === 'empty').length;
      const noKey = Boolean(state.config) && !state.config.ai;
      bulkBtn.disabled = Boolean(p.busy) || pending === 0 || noKey;
      bulkBtn.title = noKey ? 'Requiere GEMINI_API_KEY en el servidor' : '';
      cancelBtn.hidden = p.busy !== 'all';
      progress.textContent = p.progress ? `Generando ${p.progress.done} de ${p.progress.total}…` : '';
      errorBox.hidden = !p.error;
      errorBox.textContent = p.error ?? '';

      if (last.items !== p.items) {
        last = { items: p.items };
        generateButtons.clear();
        list.replaceChildren(...p.items.map((item) => row(item)));
        if (p.items.length === 0) list.append(h('li', { class: 'hint' }, 'Aún no hay preguntas preparadas.'));
      }
      applyBusy(p.busy);
    },
  };
}
