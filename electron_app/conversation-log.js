/**
 * conversation-log.js - Historial de la conversación (lo que dices tú y lo que dice la reunión), para no perder el hilo
 */

const SPEAKERS = { outgoing: 'Tú', incoming: 'Reunión' };

function createConversationLog({ max = 500, clock = () => new Date().toLocaleTimeString() } = {}) {
  let items = [];
  let count = 0;

  return {
    /** Registra una frase traducida y devuelve la entrada; sin traducción no hay nada que mostrar y devuelve null. */
    add({ direction, from, to, original, translated }) {
      if (!translated || !String(translated).trim()) return null;
      const entry = {
        n: ++count,
        time: clock(),
        direction,
        speaker: SPEAKERS[direction] || SPEAKERS.incoming,
        from: String(from || '').toUpperCase(),
        to: String(to || '').toUpperCase(),
        original: String(original || '').trim(),
        translated: String(translated).trim()
      };
      items.push(entry);
      if (items.length > max) items = items.slice(items.length - max);
      return entry;
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
