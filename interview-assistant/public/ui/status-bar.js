import { h } from './dom.js';
import { isActive } from '../domain/session-state.js';
import { describeMetrics } from '../application/metrics.js';

const LABEL = {
  idle: 'sin iniciar', downloading: 'descargando', ready: 'listo', working: 'activo', unavailable: 'no disponible', error: 'error',
};
const WORKING_LABEL = { speech: 'escuchando', translator: 'activo', suggestions: 'pensando' };
const NAMES = { speech: 'Escucha', translator: 'Traducción', suggestions: 'Sugerencias' };

/** Top bar: title, three status chips, session controls, provider switch and the context button. */
export function createStatusBar({ session, onOpenContext }) {
  const chips = Object.fromEntries(Object.keys(NAMES).map((key) => [key, h('span', { class: 'chip', id: `status-${key}` })]));
  const startBtn = h('button', { id: 'btn-start', class: 'btn primary', type: 'button' }, 'Iniciar');
  const speakBtn = h('button', { id: 'btn-speak', class: 'btn', type: 'button' }, '🎙 Estoy hablando (Espacio)');
  const clearBtn = h('button', { id: 'btn-clear', class: 'btn ghost', type: 'button' }, 'Limpiar');
  const provider = h('select', { id: 'provider', 'aria-label': 'Proveedor de sugerencias' },
    h('option', { value: 'cloud' }, 'Sugerencias: Gemini (nube)'),
    h('option', { value: 'nano' }, 'Sugerencias: Gemini Nano (lento)'));
  const contextBtn = h('button', { id: 'btn-context', class: 'btn', type: 'button' }, 'Contexto');
  const error = h('div', { id: 'error-banner', class: 'banner', role: 'alert', hidden: true });
  const metrics = h('p', { id: 'metrics', class: 'meta metrics', title: 'Traducción: tiempo por frase. Sugerencia: desde que el turno se cierra hasta que llega la respuesta.', hidden: true });

  let state = null;
  let lastDeps = [];
  startBtn.addEventListener('click', (e) => {
    e.currentTarget.blur(); // Space must toggle "speaking", not re-press this button
    if (isActive(state.session)) session.stop(); else session.start();
  });
  speakBtn.addEventListener('click', (e) => { e.currentTarget.blur(); session.toggleSpeaking(); });
  clearBtn.addEventListener('click', (e) => { e.currentTarget.blur(); session.clear(); });
  contextBtn.addEventListener('click', onOpenContext);

  const el = h('header', { class: 'topbar' },
    h('div', { class: 'row' },
      h('h1', {}, 'Interview Assistant'),
      h('div', { class: 'chips' }, chips.speech, chips.translator, chips.suggestions),
      contextBtn),
    h('div', { class: 'row controls' }, startBtn, speakBtn, clearBtn, provider, metrics),
    error);

  return {
    el,
    bindProvider(onChange) { provider.addEventListener('change', () => onChange(provider.value)); },
    render(next) {
      state = next;
      const deps = [next.statuses, next.session, next.provider, next.error, next.context.items, next.metrics];
      if (deps.every((d, i) => d === lastDeps[i])) return; // partial transcripts re-render the page many times a second
      lastDeps = deps;
      for (const [key, chip] of Object.entries(chips)) {
        const { status, detail } = next.statuses[key];
        const label = status === 'working' ? WORKING_LABEL[key] : LABEL[status] ?? status;
        chip.className = `chip chip-${status}`;
        chip.title = detail || '';
        chip.replaceChildren(h('span', { class: 'dot' }), `${NAMES[key]}: ${label}${status === 'downloading' && detail ? ` ${detail}` : ''}`);
      }
      const active = isActive(next.session);
      startBtn.textContent = active ? 'Detener' : 'Iniciar';
      startBtn.classList.toggle('danger', active);
      startBtn.disabled = next.session === 'starting';
      speakBtn.disabled = !(next.session === 'listening' || next.session === 'speaking');
      speakBtn.textContent = next.session === 'speaking' ? '▶ Seguir escuchando (Espacio)' : '🎙 Estoy hablando (Espacio)';
      speakBtn.classList.toggle('speaking', next.session === 'speaking');
      provider.value = next.provider;
      const activeItems = next.context.items.filter((i) => i.active).length;
      contextBtn.textContent = activeItems ? `Contexto (${activeItems})` : 'Contexto';
      const line = describeMetrics(next.metrics);
      metrics.hidden = !line;
      metrics.textContent = line;
      error.hidden = !next.error;
      error.textContent = next.error;
    },
  };
}
