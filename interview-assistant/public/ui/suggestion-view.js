import { h, clear } from './dom.js';

const profileIsEmpty = (p) => !p || (!p.name && !p.headline && !p.summary && p.skills.length === 0 && p.experience.length === 0 && !p.notes);

function pair(cls, en, es) {
  return h('div', { class: cls }, h('p', { class: 'en' }, en), h('p', { class: 'es' }, es));
}

/** Right column: what we can say (question, key points, suggested answer) and the context it used. */
export function createSuggestionView({ onRetry, onAskAi }) {
  const body = h('div', { id: 'suggestion', class: 'scroll', 'aria-live': 'polite' });
  const el = h('section', { class: 'panel' }, h('h2', {}, 'Qué podemos decir'), body);
  let lastDeps = [];

  return {
    el,
    render(state) {
      const deps = [state.suggestion, state.profile, state.context.items];
      if (deps.every((d, i) => d === lastDeps[i])) return; // keeps the text selectable while partials stream in
      lastDeps = deps;
      clear(body);
      const { suggestion } = state;
      const noData = profileIsEmpty(state.profile) && state.context.items.filter((i) => i.active).length === 0;
      if (suggestion.state === 'idle') {
        body.append(h('p', { class: 'hint' }, 'Cuando el entrevistador termine una pregunta, aquí verás los puntos clave y una respuesta sugerida.'));
      } else if (suggestion.state === 'thinking') {
        body.append(h('p', { class: 'question' }, suggestion.turnText), h('p', { class: 'hint pending' }, 'pensando…'));
      } else if (suggestion.state === 'error') {
        body.append(
          h('p', { class: 'error-text' }, suggestion.message),
          h('button', { id: 'btn-retry', class: 'btn', type: 'button', onClick: onRetry }, 'Reintentar'),
        );
      } else {
        const s = suggestion.suggestion;
        const prepared = suggestion.source === 'prepared';
        if (prepared) {
          const label = suggestion.preparedStatus === 'template' ? 'Preparada · plantilla sin revisar' : 'Preparada';
          body.append(h('div', { class: 'prepared-row' },
            h('p', { id: 'prepared-badge', class: 'badge-prepared' }, `${label}: ${s.intent}`),
            h('button', { id: 'btn-ask-ai', class: 'btn small', type: 'button', onClick: onAskAi }, 'Pedir a la IA'),
          ));
        }
        if (s.questionEs) body.append(h('p', { class: 'question' }, s.questionEs));
        if (s.intent && !prepared) body.append(h('p', { class: 'intent' }, s.intent));
        body.append(h('h3', {}, 'Puntos clave'), h('ul', { class: 'points' }, s.points.map((p) => h('li', {}, pair('point', p.en, p.es)))));
        if (s.answer) body.append(h('h3', {}, 'Respuesta'), pair('answer', s.answer.en, s.answer.es));
        else body.append(h('p', { class: 'hint' }, 'Gemini Nano solo da puntos clave. Para una respuesta completa usa Gemini (nube).'));
        if (suggestion.usedContext.length) {
          body.append(h('p', { class: 'meta' }, `Usó: ${suggestion.usedContext.map((c) => c.name).join(', ')}`));
        }
        if (suggestion.omittedContext.length) {
          body.append(h('p', { class: 'warn' }, `No caben en el prompt: ${suggestion.omittedContext.map((c) => c.name).join(', ')}`));
        }
      }
      if (noData && suggestion.state !== 'error' && suggestion.source !== 'prepared') {
        body.append(h('p', { class: 'warn' }, 'Aún no has cargado tu perfil ni documentos: las sugerencias serán genéricas. Abre «Contexto».'));
      }
    },
  };
}
