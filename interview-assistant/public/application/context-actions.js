const AI_FORMATS = [
  { test: /\.pdf$/i, capability: 'pdf', label: 'Los PDF' },
  { test: /\.(mp3|wav)$/i, capability: 'audio', label: 'Los audios' },
];
const MB = 1024 * 1024;

const messageOf = (err) => err?.message || 'Error desconocido';

/** Returns a problem description, or null when the file can be sent. Uses the limits and capabilities from /api/config. */
function checkFile(file, config) {
  if (!config) return null;
  if (file.size > config.limits.maxUploadBytes) {
    return `El archivo pesa ${(file.size / MB).toFixed(1)} MB y el máximo es ${Math.round(config.limits.maxUploadBytes / MB)} MB. `
      + 'Caben unos 12 minutos de MP3 o unos 6 de WAV 16 kHz mono; comprime el audio a MP3 si es más largo.';
  }
  const ai = AI_FORMATS.find((f) => f.test.test(file.name));
  if (ai && !config.capabilities[ai.capability]) return `${ai.label} requieren GEMINI_API_KEY en el servidor.`;
  return null;
}

/** Context library and profile: loads, uploads (cancellable) and edits through the ContextGatewayPort. */
export function createContextActions({ gateway, store }) {
  let upload = null; // AbortController of the upload in progress
  const setContext = (patch) => store.update((s) => ({ ...s, context: { ...s.context, ...patch } }));

  async function loadConfig() {
    const config = await gateway.config();
    store.update({ config });
  }

  async function refresh() {
    try {
      const { items, activeChars, maxActiveChars } = await gateway.list();
      setContext({ items, activeChars, maxActiveChars, error: null });
    } catch (err) {
      setContext({ error: messageOf(err) });
    }
  }

  async function loadProfile() {
    const profile = await gateway.getProfile();
    store.update({ profile });
  }

  async function mutate(fn) {
    try {
      await fn();
      await refresh();
      return true;
    } catch (err) {
      setContext({ error: messageOf(err) });
      return false;
    }
  }

  return {
    /** Loads config, context list and profile; a failure in one does not stop the others. */
    init: () => Promise.allSettled([loadConfig(), refresh(), loadProfile()]),
    refresh,

    async uploadFile(file, { kind } = {}) {
      const problem = checkFile(file, store.getState().config);
      if (problem) { setContext({ error: problem }); return false; }
      upload?.abort();
      upload = new AbortController();
      const mine = upload;
      setContext({ busy: { name: file.name, slow: /\.(mp3|wav|pdf)$/i.test(file.name) }, error: null });
      try {
        await gateway.uploadFile(file, { kind }, { signal: mine.signal });
        await refresh();
        return true;
      } catch (err) {
        if (err?.name !== 'AbortError') setContext({ error: messageOf(err) });
        return false;
      } finally {
        if (upload === mine) upload = null;
        setContext({ busy: null });
      }
    },

    cancelUpload() {
      upload?.abort();
    },

    addText: (body) => mutate(() => gateway.addText(body)),
    update: (id, patch) => mutate(() => gateway.update(id, patch)),
    remove: (id) => mutate(() => gateway.remove(id)),

    /** Saves the profile; errors propagate so the form can show them next to the Save button. */
    async saveProfile(profile) {
      const saved = await gateway.saveProfile(profile);
      store.update({ profile: saved });
      return saved;
    },
  };
}
