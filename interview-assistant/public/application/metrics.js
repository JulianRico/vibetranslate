export const MAX_SAMPLES = 10;

/** Median of a list of numbers; null when the list is empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 156 → "156 ms"; 1451 → "1,5 s". */
export function formatDuration(ms) {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

/** Appends a sample, keeping only the latest MAX_SAMPLES (returns a new list). */
export const pushMetric = (list, value) => [...list, value].slice(-MAX_SAMPLES);

const part = (label, samples) => {
  if (samples.length === 0) return null;
  const last = formatDuration(samples.at(-1));
  return samples.length > 1 ? `${label} ${last} (mediana ${formatDuration(median(samples))})` : `${label} ${last}`;
};

/** One line for the status bar, e.g. "Traducción 156 ms · Sugerencia 1,4 s (mediana 1,6 s)"; empty when nothing was measured yet. */
export function describeMetrics({ translation, suggestion }) {
  return [part('Traducción', translation), part('Sugerencia', suggestion)].filter(Boolean).join(' · ');
}
