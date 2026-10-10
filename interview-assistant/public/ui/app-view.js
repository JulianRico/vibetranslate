import { h } from './dom.js';
import { createStatusBar } from './status-bar.js';
import { createTranscriptView } from './transcript-view.js';
import { createSuggestionView } from './suggestion-view.js';
import { createProfileForm } from './profile-form.js';
import { createContextDrawer } from './context-drawer.js';
import { createStallPhrases } from './stall-phrases.js';
import { createPreparedPanel } from './prepared-panel.js';

// Space belongs to these controls (typing, or activating the focused control from the keyboard).
const usesSpace = (el) => Boolean(el?.closest?.('input, textarea, select, button, summary, a, [role="tab"], [contenteditable="true"]'));

/** Builds the page and keeps it in sync with the store. The UI only calls use cases; it never talks to the network or to Chrome APIs. */
export function mountApp(root, { store, session, suggestions, contextActions, preparedActions }) {
  const profileForm = createProfileForm({ onSave: (profile) => contextActions.saveProfile(profile) });
  const preparedPanel = createPreparedPanel({ preparedActions });
  const drawer = createContextDrawer({ contextActions, profileForm, preparedPanel });
  const status = createStatusBar({ session, onOpenContext: () => drawer.toggle() });
  const transcript = createTranscriptView();
  const suggestion = createSuggestionView({ onRetry: () => suggestions.retry(), onAskAi: () => suggestions.askAi() });
  suggestion.el.append(createStallPhrases().el);
  status.bindProvider((provider) => store.update({ provider }));

  root.append(status.el, h('main', { class: 'columns' }, transcript.el, suggestion.el), drawer.el);

  const renderAll = (state) => {
    status.render(state);
    transcript.render(state);
    suggestion.render(state);
    drawer.render(state);
  };
  store.subscribe(renderAll);
  renderAll(store.getState());

  // A control used with the mouse must not keep the keyboard, or Space (= "I'm speaking") would hit it instead.
  document.addEventListener('click', (e) => e.target.closest?.('button, summary')?.blur());
  document.addEventListener('change', (e) => { if (e.target.matches?.('select, input[type="checkbox"]')) e.target.blur(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { drawer.close(); return; }
    if (e.code === 'Space' && !e.repeat && !e.ctrlKey && !e.metaKey && !usesSpace(e.target)) {
      e.preventDefault();
      session.toggleSpeaking();
    }
  });
}
