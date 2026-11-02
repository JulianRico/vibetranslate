/**
 * translate-route.js - Decide dónde se traduce cada frase: nube (mejor calidad) o motor local (sin red)
 */

const CLOUD_COOLDOWN_MS = 30000;

function createTranslateRouter({ cloud, local, isOnline = () => true, getMode = () => 'auto', now = Date.now }) {
  let cloudDownUntil = 0;

  return async function translate({ text, sourceLang, targetLang, segmentId = null, pair = null }) {
    // Motores en la nube: no hay audio local que traducir, se usa la cadena de la nube tal cual
    if (segmentId === null || pair === null) return cloud({ text, sourceLang, targetLang });

    const started = now();

    async function viaLocal() {
      const res = await local({ text, source: pair.source, target: pair.target, segmentId });
      if (!res || !res.ok || !res.translated || !res.translated.trim()) {
        throw new Error((res && res.error) || 'Traducción local vacía');
      }
      return {
        original: text,
        translated: res.translated.trim(),
        detectedLang: pair.source,
        targetLang: pair.target,
        elapsedMs: res.elapsedMs || (now() - started),
        engine: 'local'
      };
    }

    // Sin traducción: nunca se devuelve el texto original como si lo fuera
    const failed = (error) => ({
      original: text,
      translated: '',
      detectedLang: pair.source,
      targetLang: pair.target,
      elapsedMs: now() - started,
      engine: 'none',
      error
    });

    const localOnly = getMode() === 'local';
    let localError = null;

    if (localOnly || !isOnline() || now() < cloudDownUntil) {
      try {
        return await viaLocal();
      } catch (err) {
        if (localOnly) return failed(err.message); // "siempre local": el texto no sale del equipo
        localError = err;
      }
    }

    // La nube pide a la vez un LLM y Google y responde con el primero válido: no hay niveles lentos que evitar
    const cloudResult = await cloud({ text, sourceLang, targetLang });
    if (cloudResult && cloudResult.engine !== 'none') return cloudResult;

    // La nube no responde aunque el equipo diga tener red: las siguientes frases van directas al local
    cloudDownUntil = now() + CLOUD_COOLDOWN_MS;
    if (localError) return failed(localError.message);
    try {
      return await viaLocal();
    } catch (err) {
      return failed(err.message);
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createTranslateRouter };
}
