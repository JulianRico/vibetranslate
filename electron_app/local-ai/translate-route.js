/**
 * translate-route.js - Decide dónde se traduce cada frase: nube (mejor calidad) o motor local (sin red)
 */

function createTranslateRouter({ cloud, local, isOnline = () => true, getMode = () => 'auto' }) {
  return async function translate({ text, sourceLang, targetLang, segmentId = null, pair = null }) {
    const canLocal = segmentId !== null && pair !== null;

    async function viaLocal() {
      const started = Date.now();
      const res = await local({ id: segmentId, target: pair.target });
      if (!res || !res.ok || !res.translated || !res.translated.trim()) {
        throw new Error((res && res.error) || 'Traducción local vacía');
      }
      return {
        original: text,
        translated: res.translated.trim(),
        detectedLang: pair.source,
        targetLang: pair.target,
        elapsedMs: res.elapsedMs || (Date.now() - started),
        engine: 'local'
      };
    }

    let localTried = false;
    if (canLocal && (getMode() === 'local' || !isOnline())) {
      localTried = true;
      try {
        return await viaLocal();
      } catch {
        // sigue con la nube
      }
    }

    const cloudResult = await cloud({ text, sourceLang, targetLang });
    if (cloudResult && cloudResult.engine === 'none' && canLocal && !localTried) {
      try {
        return await viaLocal();
      } catch {
        return cloudResult;
      }
    }
    return cloudResult;
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createTranslateRouter };
}
