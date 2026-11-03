/**
 * conversation-log.js - Historial de la conversación (lo que dices tú y lo que dice la reunión), para no perder el hilo
 */

const SPEAKERS = { outgoing: 'Tú', incoming: 'Reunión' };

function createConversationLog({ max = 500, clock = () => new Date().toLocaleTimeString() } = {}) {
  let items = [];
  let count = 0;

  return {
    /** Registra una frase traducida y devuelve la entrada; sin traducción no hay nada que mostrar y devuelve null. */
    add({ direction, from, to, original, translated, speakerId = null, speaker = null }) {
      if (!translated || !String(translated).trim()) return null;
      const entry = {
        n: ++count,
        time: clock(),
        direction,
        ...(speakerId !== null ? { speakerId } : {}),
        speaker: speaker || SPEAKERS[direction] || SPEAKERS.incoming,
        from: String(from || '').toUpperCase(),
        to: String(to || '').toUpperCase(),
        original: String(original || '').trim(),
        translated: String(translated).trim()
      };
      items.push(entry);
      if (items.length > max) items = items.slice(items.length - max);
      return entry;
    },
    /** Completa el texto original de una frase cuya traducción llegó primero. */
    setOriginal(n, original) {
      const entry = items.find((e) => e.n === n);
      if (!entry) return false;
      entry.original = String(original || '').trim();
      return true;
    },
    /** Reescribe una frase: llegó el resto de la frase o una traducción mejor. */
    update(n, { original, translated } = {}) {
      const entry = items.find((e) => e.n === n);
      if (!entry) return false;
      if (original !== undefined) entry.original = String(original || '').trim();
      if (translated !== undefined && String(translated).trim()) entry.translated = String(translated).trim();
      return true;
    },
    /** El nombre de una voz de la reunión cambió: sus frases lo llevan también en la exportación. */
    renameSpeaker(speakerId, name) {
      for (const e of items) if (e.speakerId === speakerId) e.speaker = name;
    },
    entries: () => items.slice(),
    tail: (n) => items.slice(-n),
    size: () => items.length,
    clear() {
      items = [];
      count = 0;
    },
    toText() {
      return items
        .map((e) => `[${e.time}] ${e.speaker} [${e.from} ➔ ${e.to}]\n  Original:   ${e.original}\n  Traducción: ${e.translated}`)
        .join('\n\n');
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createConversationLog };
}
