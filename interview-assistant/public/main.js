// Composition root of the browser app: the only place that knows the concrete adapters.
import { createStore, initialState } from './application/store.js';
import { createSession } from './application/session.js';
import { createRequestSuggestion } from './application/request-suggestion.js';
import { createContextActions } from './application/context-actions.js';
import { createPreparedActions } from './application/prepared-actions.js';
import { scheduler, clock } from './adapters/timers.js';
import { createWebSpeechRecognizer } from './adapters/web-speech-recognizer.js';
import { createChromeTranslator } from './adapters/chrome-translator.js';
import { createHttpClient, createHttpSuggestionGateway, createHttpContextGateway, createHttpPreparedGateway } from './adapters/http-gateways.js';
import { createNanoSuggestionGateway } from './adapters/nano-suggestion-gateway.js';
import { mountApp } from './ui/app-view.js';

// End-to-end tests replace speech and translator with fakes through this hook; normal use never defines it.
const overrides = globalThis.__IA_OVERRIDES__ ?? {};

const store = createStore(initialState());
const request = createHttpClient();
const contextGateway = createHttpContextGateway(request);
const speech = overrides.speech ?? createWebSpeechRecognizer({ scheduler });
const translator = overrides.translator ?? createChromeTranslator();

const suggestions = createRequestSuggestion({
  gateways: {
    cloud: createHttpSuggestionGateway(request),
    nano: createNanoSuggestionGateway({ translator, contextGateway }),
  },
  store,
  clock,
});
const session = createSession({ speech, translator, requestSuggestion: suggestions, store, scheduler, clock });
const contextActions = createContextActions({ gateway: contextGateway, store });
const preparedActions = createPreparedActions({ gateway: createHttpPreparedGateway(request), store });

mountApp(document.getElementById('app'), { store, session, suggestions, contextActions, preparedActions });
contextActions.init();
preparedActions.load();
