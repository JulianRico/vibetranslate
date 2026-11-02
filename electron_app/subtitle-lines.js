/**
 * subtitle-lines.js - Líneas del subtítulo flotante: la frase actual y las anteriores, reescribibles por su id
 *
 * Una línea se reescribe cuando llega el resto de su frase (`grows`) o una traducción mejor de la nube.
 */

function createSubtitleLines({ history = 2 } = {}) {
  let current = null; // { id, icon, original, text, provisional }
  const previous = [];

  function push(line) {
    if (current && !current.provisional) {
      previous.push(current);
      while (previous.length > history) previous.shift();
    }
    current = line;
  }

  return {
    /**
     * Aplica un subtítulo. Con `replace` y un `lineId` conocido reescribe esa línea; si no, la muestra como nueva.
     * `grows`: la línea crece con el resto de su frase, que es lo que se estaba mostrando como provisional.
     */
    apply({ lineId = null, replace = false, grows = false, icon = '', original = '', text, provisional = false }) {
      if (replace && lineId !== null) {
        if (current && current.id === lineId) {
          current = { ...current, text, original: original || current.original, provisional: false };
          return;
        }
        const index = previous.findIndex((line) => line.id === lineId);
        if (index >= 0) {
          const line = { ...previous[index], text, original: original || previous[index].original };
          if (grows && current && current.provisional && index === previous.length - 1) {
            previous.splice(index, 1); // el provisional era esta misma frase: vuelve a ser la actual
            current = { ...line, provisional: false };
          } else {
            previous[index] = line;
          }
          return;
        }
      }
      push({ id: lineId, icon, original, text, provisional: !!provisional });
    },
    current: () => current,
    history: () => previous.slice()
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSubtitleLines };
}
