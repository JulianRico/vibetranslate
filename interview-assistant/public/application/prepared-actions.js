// Statuses worth regenerating in bulk: the starter templates and questions with no answer yet. Edited and generated answers are left alone.
const BULK_STATUSES = new Set(['template', 'empty']);

const messageOf = (err) => err?.message || 'Error desconocido';

/** Prepared answers: load, edit and generate (one at a time, or all the pending ones with progress and cancel). */
export function createPreparedActions({ gateway, store }) {
  let bulk = null; // AbortController of the bulk generation in progress
  const set = (patch) => store.update((s) => ({ ...s, prepared: { ...s.prepared, ...patch } }));

  async function load() {
    try {
      const { items } = await gateway.list();
      set({ items, error: null });
    } catch (err) {
      set({ error: messageOf(err) });
    }
  }

  async function mutate(fn) {
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      set({ error: messageOf(err) });
      return false;
    }
  }

  return {
    load,
    add: ({ question, triggers }) => mutate(() => gateway.add({ question, triggers })),
    update: (id, patch) => mutate(() => gateway.update(id, patch)),
    remove: (id) => mutate(() => gateway.remove(id)),

    /** Generates one answer. `force` is needed to replace an answer the user edited (the UI asks for confirmation first). */
    async generate(id, { force = false } = {}) {
      set({ busy: id, error: null });
      try {
        await gateway.generate(id, { force });
        await load();
        return true;
      } catch (err) {
        set({ error: messageOf(err) });
        return false;
      } finally {
        set({ busy: null });
      }
    },

    /** Generates every template/empty answer, one after another. A failure is counted and the rest continue, except "no Gemini key", which stops at once. */
    async generateMissing() {
      const ids = store.getState().prepared.items.filter((i) => BULK_STATUSES.has(i.status)).map((i) => i.id);
      if (ids.length === 0) return { done: 0, failed: 0 };
      bulk?.abort();
      const mine = new AbortController();
      bulk = mine;
      set({ busy: 'all', progress: { done: 0, total: ids.length }, error: null });
      let done = 0;
      let failed = 0;
      let firstError = null;
      for (const id of ids) {
        if (mine.signal.aborted) break;
        try {
          await gateway.generate(id, { signal: mine.signal });
        } catch (err) {
          if (err?.name === 'AbortError') break;
          failed++;
          firstError ??= err;
          if (err?.status === 503) break;
        }
        done++;
        set({ progress: { done, total: ids.length } });
      }
      if (bulk === mine) bulk = null;
      set({ busy: null, progress: null });
      await load();
      if (failed > 0) set({ error: `${failed} no se pudieron generar: ${messageOf(firstError)}` });
      return { done, failed };
    },

    cancelGeneration() {
      bulk?.abort();
    },
  };
}
