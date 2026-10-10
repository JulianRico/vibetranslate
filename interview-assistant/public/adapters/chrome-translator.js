/** TranslatorPort backed by Chrome's built-in Translator API (desktop, Chrome 138+). `win` is injectable for tests. */
export function createChromeTranslator({ win = globalThis, source = 'en', target = 'es' } = {}) {
  let translator = null;
  let stateCb = () => {};
  let current = { status: 'idle', detail: '' };

  const setState = (status, detail = '') => {
    current = { status, detail };
    stateCb(current);
  };

  return {
    /** Needs user activation the first time (the model may have to download): call it from a click. */
    async ensureReady() {
      if (translator) return;
      if (!('Translator' in win)) {
        setState('unavailable', 'Este Chrome no trae la API de traducción');
        throw new Error('Este Chrome no trae la API de traducción.');
      }
      const pair = { sourceLanguage: source, targetLanguage: target };
      const availability = await win.Translator.availability(pair);
      if (availability === 'unavailable') {
        setState('unavailable', 'Par de idiomas no disponible');
        throw new Error('El par de idiomas inglés → español no está disponible.');
      }
      setState(availability === 'available' ? 'ready' : 'downloading', availability === 'available' ? '' : 'descargando');
      try {
        translator = await win.Translator.create({
          ...pair,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => setState('downloading', `${Math.round(e.loaded * 100)} %`));
          },
        });
      } catch (err) {
        setState('error', err.message);
        throw err;
      }
      setState('ready');
    },

    async translate(text) {
      if (!translator) throw new Error('El traductor no está listo');
      return translator.translate(text);
    },

    onState: (cb) => { stateCb = cb; cb(current); },
  };
}
