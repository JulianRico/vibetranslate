const PRIORITY = { job: 1, notes: 2, stories: 3, cv: 4, transcript: 5, other: 6 };
const MIN_PARTIAL_CHARS = 1500;

/**
 * Picks which active context items fit in `maxChars`, by kind priority (job, notes, stories, cv, transcript, other),
 * newest first within a kind. At most one item is cut to fit, and only if at least MIN_PARTIAL_CHARS remain.
 * @returns {{included: {item: object, text: string, truncated: boolean}[], omitted: object[]}}
 */
export function select(items, maxChars) {
  const active = items
    .filter((item) => item.active)
    .sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const included = [];
  const omitted = [];
  let left = maxChars;
  let cutOne = false;
  for (const item of active) {
    if (item.text.length <= left) {
      included.push({ item, text: item.text, truncated: false });
      left -= item.text.length;
    } else if (!cutOne && left >= MIN_PARTIAL_CHARS) {
      included.push({ item, text: item.text.slice(0, left), truncated: true });
      left = 0;
      cutOne = true;
    } else {
      omitted.push(item);
    }
  }
  return { included, omitted };
}

/** The `{id, name}` lists the API reports for a selection. */
export function describeSelection({ included, omitted }) {
  return {
    usedContext: included.map(({ item }) => ({ id: item.id, name: item.name })),
    omittedContext: omitted.map((item) => ({ id: item.id, name: item.name })),
  };
}
