import { h } from './dom.js';
import { STALL_PHRASES } from '../domain/stall-phrases.js';

/**
 * Fixed strip of compact chips with phrases to buy time. The English line is shown; its Spanish translation is the
 * tooltip (a full two-line list took a third of the column and pushed the suggestion out of view). Static: never changes.
 */
export function createStallPhrases() {
  const chips = STALL_PHRASES.map((p) => h('li', { class: 'stall-phrase', title: p.es, tabIndex: 0 }, p.en));
  return { el: h('section', { id: 'stall-phrases', class: 'stall', 'aria-label': 'Frases para ganar tiempo' }, h('h3', {}, 'Para ganar tiempo (pasa el ratón para ver la traducción)'), h('ul', {}, chips)) };
}
