import { h, clear } from './dom.js';

const KINDS = [['job', 'Oferta de trabajo'], ['notes', 'Notas'], ['stories', 'Historias (STAR)'], ['cv', 'CV'], ['transcript', 'Transcripción'], ['other', 'Otro']];
const SOURCE = { pdf: 'PDF', docx: 'DOCX', audio: 'Audio', text: 'Texto' };
const WARNING = { truncated: 'truncado', partial: 'parcial: no se leen cabeceras, pies ni imágenes' };
const ACCEPT = '.pdf,.docx,.mp3,.wav,.txt,.md';
const STAR_TEMPLATE = [
  'Situación: (dónde estabas y cuál era el contexto)',
  'Tarea: (qué tenías que lograr)',
  'Acción: (qué hiciste tú, paso a paso)',
  'Resultado: (qué pasó; con números si puedes)',
  '',
].join('\n');

const kindSelect = (id, value, { auto = false, onChange } = {}) => h('select', { id, 'aria-label': 'Tipo de documento', onChange },
  auto ? h('option', { value: '' }, 'Tipo: automático') : null,
  KINDS.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

/** Right-hand drawer with two tabs: profile and documents (upload, paste, list). */
export function createContextDrawer({ contextActions, profileForm, preparedPanel }) {
  const uploadKind = kindSelect('doc-kind', '', { auto: true });
  const fileInput = h('input', { id: 'file-input', type: 'file', accept: ACCEPT, multiple: true, hidden: true });
  const dropzone = h('div', { id: 'dropzone', class: 'dropzone' }, 'Arrastra aquí un archivo (PDF, DOCX, MP3, WAV, TXT o MD) o ',
    h('button', { id: 'pick-file', class: 'btn small', type: 'button', onClick: () => fileInput.click() }, 'elige uno'));
  const capabilityNote = h('p', { id: 'capability-note', class: 'warn', hidden: true });
  const busy = h('div', { id: 'upload-busy', class: 'banner info', hidden: true });
  const errorBox = h('div', { id: 'context-error', class: 'banner', role: 'alert', hidden: true });
  const pasteName = h('input', { id: 'paste-name', type: 'text', maxLength: 120, placeholder: 'Nombre (p. ej. Oferta Acme)' });
  const pasteText = h('textarea', { id: 'paste-text', rows: 4, placeholder: 'Pega aquí una oferta, notas o cualquier texto' });
  const pasteAdd = h('button', { id: 'paste-add', class: 'btn', type: 'button' }, 'Agregar texto');
  const pasteStar = h('button', { id: 'paste-star', class: 'btn small', type: 'button', title: 'Rellena el cuadro con Situación / Tarea / Acción / Resultado' }, 'Plantilla STAR');
  const list = h('ul', { id: 'doc-list', class: 'docs' });
  const usage = h('p', { id: 'usage', class: 'meta' });
  const bar = h('div', { class: 'bar' }, h('div', { class: 'fill' }));

  async function uploadAll(files) {
    for (const file of files) await contextActions.uploadFile(file, { kind: uploadKind.value || undefined });
  }
  fileInput.addEventListener('change', async () => { const files = [...fileInput.files]; fileInput.value = ''; await uploadAll(files); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', async (e) => { e.preventDefault(); dropzone.classList.remove('over'); await uploadAll([...e.dataTransfer.files]); });
  pasteStar.addEventListener('click', () => {
    pasteText.value = STAR_TEMPLATE;
    uploadKind.value = 'stories';
    pasteText.focus();
  });
  pasteAdd.addEventListener('click', async () => {
    const ok = await contextActions.addText({ name: pasteName.value.trim() || undefined, kind: uploadKind.value || undefined, text: pasteText.value });
    if (ok) { pasteName.value = ''; pasteText.value = ''; }
  });

  const docsPanel = h('div', { id: 'panel-docs', class: 'tab-panel' },
    capabilityNote,
    h('div', { class: 'row' }, uploadKind), dropzone, fileInput, busy, errorBox,
    h('h3', {}, 'Pegar texto'), pasteName, pasteText, h('div', { class: 'row' }, pasteAdd, pasteStar),
    h('h3', {}, 'Documentos'), list, usage, bar);
  const profilePanel = h('div', { id: 'panel-profile', class: 'tab-panel' }, profileForm.el);

  const tabProfile = h('button', { id: 'tab-profile', class: 'tab', type: 'button', role: 'tab' }, 'Perfil');
  const tabDocs = h('button', { id: 'tab-docs', class: 'tab', type: 'button', role: 'tab' }, 'Documentos');
  const tabPrepared = h('button', { id: 'tab-prepared', class: 'tab', type: 'button', role: 'tab' }, 'Preparadas');
  const tabs = { profile: [tabProfile, profilePanel], docs: [tabDocs, docsPanel], prepared: [tabPrepared, preparedPanel.el] };
  function selectTab(name) {
    for (const [key, [tab, panel]] of Object.entries(tabs)) {
      tab.classList.toggle('active', key === name);
      panel.hidden = key !== name;
    }
  }
  tabProfile.addEventListener('click', () => selectTab('profile'));
  tabDocs.addEventListener('click', () => selectTab('docs'));
  tabPrepared.addEventListener('click', () => selectTab('prepared'));
  selectTab('docs');

  const closeBtn = h('button', { id: 'drawer-close', class: 'btn ghost small', type: 'button', 'aria-label': 'Cerrar' }, '✕');
  const el = h('aside', { id: 'drawer', class: 'drawer', hidden: true, 'aria-label': 'Contexto' },
    h('div', { class: 'row between' }, h('h2', {}, 'Contexto'), closeBtn),
    h('div', { class: 'tabs', role: 'tablist' }, tabProfile, tabDocs, tabPrepared), docsPanel, profilePanel, preparedPanel.el);
  const drawer = {
    el,
    open() { el.hidden = false; },
    close() { el.hidden = true; },
    toggle() { el.hidden = !el.hidden; },
  };
  closeBtn.addEventListener('click', drawer.close);

  function itemRow(item) {
    const warnings = item.warnings.map((w) => h('span', { class: 'badge', title: WARNING[w] ?? w }, WARNING[w]?.split(':')[0] ?? w));
    return h('li', { class: 'doc', dataset: { id: item.id } },
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', class: 'doc-active', checked: item.active, onChange: (e) => contextActions.update(item.id, { active: e.target.checked }) }),
        h('span', { class: 'doc-name' }, item.name)),
      h('div', { class: 'doc-meta' },
        kindSelect(`kind-${item.id}`, item.kind, { onChange: (e) => contextActions.update(item.id, { kind: e.target.value }) }),
        h('span', {}, `${SOURCE[item.source] ?? item.source} · ${item.chars.toLocaleString('es')} caracteres`), warnings),
      h('details', {}, h('summary', {}, 'Vista previa'), h('pre', {}, item.preview)),
      h('button', {
        class: 'btn ghost small doc-delete', type: 'button',
        onClick: () => { if (window.confirm(`¿Borrar «${item.name}»?`)) contextActions.remove(item.id); },
      }, 'Borrar'));
  }

  let last = {};
  return {
    ...drawer,
    render(state) {
      profileForm.render(state);
      preparedPanel.render(state);
      const { context, config } = state;
      if (last.context === context && last.config === config) return;
      last = { context, config };

      const limited = config && !(config.capabilities.pdf && config.capabilities.audio);
      capabilityNote.hidden = !limited;
      capabilityNote.textContent = limited ? 'PDF y audio requieren GEMINI_API_KEY en el servidor; DOCX y texto funcionan sin ella.' : '';

      busy.hidden = !context.busy;
      clear(busy);
      if (context.busy) {
        busy.append(`Extrayendo «${context.busy.name}»… `, context.busy.slow ? 'Esto puede tardar (los PDF y audios los lee Gemini). ' : '',
          h('button', { id: 'upload-cancel', class: 'btn small', type: 'button', onClick: () => contextActions.cancelUpload() }, 'Cancelar'));
      }
      errorBox.hidden = !context.error;
      errorBox.textContent = context.error ?? '';

      clear(list);
      list.append(...context.items.map(itemRow));
      if (context.items.length === 0) list.append(h('li', { class: 'hint' }, 'Aún no hay documentos.'));
      usage.textContent = `Contexto activo: ${context.activeChars.toLocaleString('es')} / ${context.maxActiveChars.toLocaleString('es')} caracteres`;
      bar.firstChild.style.width = `${Math.min(100, (context.activeChars / context.maxActiveChars) * 100)}%`;
    },
  };
}
