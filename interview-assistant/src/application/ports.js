/**
 * Ports: the contracts the application layer needs from the outside world.
 * They are documentation (JSDoc typedefs); implementations live in `infrastructure/`.
 *
 * @typedef {object} ProfileRepository
 * @property {() => Promise<object>} load                      Current profile (never null).
 * @property {(profile: object) => Promise<object>} save       Persists and returns the profile.
 *
 * @typedef {object} ContextRepository
 * @property {() => Promise<object[]>} list
 * @property {(id: string) => Promise<object|null>} get
 * @property {(item: object) => Promise<object>} add
 * @property {(id: string, patch: object) => Promise<object|null>} update   null when the id does not exist.
 * @property {(id: string) => Promise<boolean>} remove                       false when the id does not exist.
 *
 * @typedef {object} LlmGateway
 * @property {() => boolean} isConfigured
 * @property {string} model
 * @property {(args: {system: string, prompt: string, temperature?: number, signal?: AbortSignal}) => Promise<object>} generateJson
 * @property {(args: {mimeType: string, data: Buffer, instruction: string, signal?: AbortSignal}) => Promise<string>} extractText
 *
 * @typedef {object} DocumentExtractor
 * @property {(format: string) => boolean} supports
 * @property {(args: {buffer: Buffer, filename: string, format: string, signal?: AbortSignal}) => Promise<{text: string, warnings?: string[]}>} extract
 *
 * @typedef {{ next: () => string }} IdGenerator
 * @typedef {{ now: () => string }} Clock          ISO-8601 timestamp.
 */
export {};
