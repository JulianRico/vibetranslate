/**
 * Tiny element builder. Text is always inserted as text nodes (never as HTML), so nothing coming from
 * the interviewer, a document or a model can inject markup.
 * Props: `class`, `dataset`, `onClick`-style handlers, DOM properties (value, disabled, type…) or attributes.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const clear = (el) => el.replaceChildren();

/** One non-empty trimmed line per entry. */
export const lines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);
