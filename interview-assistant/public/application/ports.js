/**
 * Ports of the browser app: what the application layer needs from the outside world.
 * Documentation only (JSDoc typedefs); implementations live in `adapters/`.
 *
 * Component status shown in the status bar: { status: 'idle'|'downloading'|'ready'|'working'|'unavailable'|'error', detail?: string, fatal?: boolean }
 * (`fatal` means the component cannot continue, e.g. the microphone was blocked.)
 *
 * @typedef {{ status: string, detail?: string, fatal?: boolean }} ComponentState
 *
 * @typedef {object} SpeechRecognizerPort
 * @property {() => Promise<void>} ensureReady          Installs/checks the speech pack; rejects when speech cannot be used.
 * @property {() => void} start
 * @property {() => void} stop
 * @property {(cb: (text: string) => void) => void} onPartial   Provisional text.
 * @property {(cb: (text: string) => void) => void} onFinal     Finished phrase.
 * @property {(cb: (state: ComponentState) => void) => void} onState
 *
 * @typedef {object} TranslatorPort
 * @property {() => Promise<void>} ensureReady
 * @property {(text: string) => Promise<string>} translate      English → Spanish.
 * @property {(cb: (state: ComponentState) => void) => void} onState
 *
 * @typedef {object} Suggestion
 * @property {string} questionEs
 * @property {string} intent
 * @property {{ en: string, es: string }[]} points
 * @property {{ en: string, es: string } | null} answer          null for the Gemini Nano provider (key points only).
 *
 * @typedef {object} SuggestionGatewayPort
 * @property {(payload: { turns: string[], history: { interviewer: string, suggestedAnswer?: string }[] }, opts?: { signal?: AbortSignal }) =>
 *   Promise<{ suggestion: Suggestion, usedContext: { id: string, name: string }[], omittedContext: { id: string, name: string }[] }>} suggest
 *
 * @typedef {object} ContextGatewayPort
 * @property {() => Promise<object>} config
 * @property {() => Promise<{ items: object[], activeChars: number, maxActiveChars: number }>} list
 * @property {(file: Blob & { name: string }, opts: { kind?: string }, req?: { signal?: AbortSignal }) => Promise<object>} uploadFile
 * @property {(body: { name?: string, kind?: string, text: string }) => Promise<object>} addText
 * @property {(id: string, patch: object) => Promise<object>} update
 * @property {(id: string) => Promise<void>} remove
 * @property {() => Promise<object>} getProfile
 * @property {(profile: object) => Promise<object>} saveProfile
 * @property {(opts: { mode: 'cloud'|'nano', maxChars: number }) => Promise<{ systemPrompt: string, usedContext: object[], omittedContext: object[] }>} coachSystemPrompt
 *
 * @typedef {{ after: (ms: number, fn: () => void) => (() => void) }} SchedulerPort   Returns a cancel function.
 */
export {};
