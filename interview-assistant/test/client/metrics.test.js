import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, formatDuration, pushMetric, describeMetrics, MAX_SAMPLES } from '../../public/application/metrics.js';

test('median of odd, even and empty lists', () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([42]), 42);
  assert.equal(median([]), null);
});

test('durations under a second are shown in ms, longer ones in seconds with a decimal comma', () => {
  assert.equal(formatDuration(156), '156 ms');
  assert.equal(formatDuration(155.6), '156 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1,0 s');
  assert.equal(formatDuration(1451), '1,5 s');
  assert.equal(formatDuration(12_340), '12,3 s');
});

test('pushMetric keeps only the latest MAX_SAMPLES values and does not mutate the input', () => {
  const start = Array.from({ length: MAX_SAMPLES }, (_, i) => i);
  const next = pushMetric(start, 99);
  assert.equal(next.length, MAX_SAMPLES);
  assert.equal(next.at(-1), 99);
  assert.equal(next[0], 1);
  assert.equal(start.length, MAX_SAMPLES);
  assert.equal(start.at(-1), MAX_SAMPLES - 1);
  assert.equal(MAX_SAMPLES, 10);
});

test('describeMetrics shows the last value and, once there are several samples, their median', () => {
  assert.equal(describeMetrics({ translation: [], suggestion: [] }), '');
  assert.equal(describeMetrics({ translation: [156], suggestion: [] }), 'Traducción 156 ms');
  assert.equal(
    describeMetrics({ translation: [156], suggestion: [1400] }),
    'Traducción 156 ms · Sugerencia 1,4 s',
  );
  assert.equal(
    describeMetrics({ translation: [100, 300, 200, 150], suggestion: [1400, 1800, 1200] }),
    'Traducción 150 ms (mediana 175 ms) · Sugerencia 1,2 s (mediana 1,4 s)',
  );
});
