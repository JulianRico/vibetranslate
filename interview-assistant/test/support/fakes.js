import { emptyProfile } from '../../src/domain/profile.js';

export function createMemoryContextRepository(initial = []) {
  let items = initial.map((i) => ({ ...i }));
  return {
    async list() { return items.map((i) => ({ ...i })); },
    async get(id) { const found = items.find((i) => i.id === id); return found ? { ...found } : null; },
    async add(item) { items.push({ ...item }); return item; },
    async update(id, patch) {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return null;
      items[idx] = { ...items[idx], ...patch };
      return { ...items[idx] };
    },
    async remove(id) {
      const before = items.length;
      items = items.filter((i) => i.id !== id);
      return items.length < before;
    },
  };
}

export function createMemoryProfileRepository(initial = emptyProfile()) {
  let profile = initial;
  return {
    async load() { return profile; },
    async save(next) { profile = next; return profile; },
  };
}

/**
 * Fake LlmGateway. `json` may be a value, an Error, a function(args), or an array of those (consumed in order,
 * the last one repeats). `text` is a string, an Error or a function(args).
 */
export function createFakeLlm({ configured = true, model = 'fake-model', json = {}, text = 'texto extraído' } = {}) {
  const calls = { generateJson: [], extractText: [] };
  const queue = Array.isArray(json) ? [...json] : [json];
  const resolve = (v, args) => { const out = typeof v === 'function' ? v(args) : v; if (out instanceof Error) throw out; return out; };
  return {
    calls,
    model,
    isConfigured: () => configured,
    async generateJson(args) {
      calls.generateJson.push(args);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return resolve(next, args);
    },
    async extractText(args) {
      calls.extractText.push(args);
      return resolve(text, args);
    },
  };
}

export const sequentialIds = (prefix = 'c_') => { let n = 0; return { next: () => `${prefix}${++n}` }; };
export const fixedClock = (iso = '2026-10-01T12:00:00.000Z') => ({ now: () => iso });

/** Fake DocumentExtractor for the given formats; records the calls it receives. */
export function fakeExtractor({ formats, result = { text: 'texto extraído' } }) {
  const calls = [];
  return {
    calls,
    supports: (format) => formats.includes(format),
    async extract(args) {
      calls.push(args);
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(args) : result;
    },
  };
}

/** In-memory PreparedRepository. `initial = null` means "no data yet" (the first list seeds the starter bank). */
export function createMemoryPreparedRepository(initial = null) {
  let items = initial === null ? null : initial.map((i) => ({ ...i }));
  const calls = { replaceAll: 0 };
  return {
    calls,
    async list() { return items === null ? null : items.map((i) => ({ ...i })); },
    async replaceAll(next) { calls.replaceAll++; items = next.map((i) => ({ ...i })); },
    async get(id) { const found = (items ?? []).find((i) => i.id === id); return found ? { ...found } : null; },
    async add(item) { items = [...(items ?? []), { ...item }]; return item; },
    async update(id, item) {
      const idx = (items ?? []).findIndex((i) => i.id === id);
      if (idx < 0) return null;
      items[idx] = { ...item };
      return { ...item };
    },
    async remove(id) {
      const before = (items ?? []).length;
      items = (items ?? []).filter((i) => i.id !== id);
      return items.length < before;
    },
  };
}
