import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, describeSelection } from '../../src/domain/context-budget.js';

const item = (id, kind, len, over = {}) => ({ id, kind, text: 'x'.repeat(len), active: true, createdAt: '2026-10-01T10:00:00Z', ...over });

test('ignores inactive items', () => {
  const { included, omitted } = select([item('a', 'job', 100, { active: false }), item('b', 'cv', 100)], 1000);
  assert.deepEqual(included.map((i) => i.item.id), ['b']);
  assert.deepEqual(omitted, []);
});

test('orders by kind priority: job, notes, cv, transcript, other', () => {
  const items = [item('o', 'other', 10), item('t', 'transcript', 10), item('c', 'cv', 10), item('n', 'notes', 10), item('j', 'job', 10)];
  assert.deepEqual(select(items, 1000).included.map((i) => i.item.id), ['j', 'n', 'c', 't', 'o']);
});

test('within a kind, the newest comes first', () => {
  const items = [item('old', 'notes', 10, { createdAt: '2026-09-01T00:00:00Z' }), item('new', 'notes', 10, { createdAt: '2026-10-01T00:00:00Z' })];
  assert.deepEqual(select(items, 1000).included.map((i) => i.item.id), ['new', 'old']);
});

test('cuts only the first item that overflows, if enough room remains; the rest is omitted', () => {
  const items = [item('j', 'job', 4000), item('n', 'notes', 4000), item('c', 'cv', 4000)];
  const { included, omitted } = select(items, 6000);
  assert.deepEqual(included.map((i) => [i.item.id, i.text.length, i.truncated]), [['j', 4000, false], ['n', 2000, true]]);
  assert.deepEqual(omitted.map((i) => i.id), ['c']);
});

test('does not cut when fewer than 1500 characters remain', () => {
  const items = [item('j', 'job', 4000), item('n', 'notes', 4000)];
  const { included, omitted } = select(items, 5000);
  assert.deepEqual(included.map((i) => i.item.id), ['j']);
  assert.deepEqual(omitted.map((i) => i.id), ['n']);
});

test('a first item larger than the whole budget is cut to the budget', () => {
  const { included } = select([item('j', 'job', 50000)], 30000);
  assert.equal(included[0].text.length, 30000);
  assert.equal(included[0].truncated, true);
});

test('empty input gives empty output', () => {
  assert.deepEqual(select([], 1000), { included: [], omitted: [] });
});

test('describeSelection reports ids and names of used and omitted items', () => {
  const sel = select([item('j', 'job', 4000, { name: 'Oferta' }), item('c', 'cv', 4000, { name: 'CV' })], 4000);
  assert.deepEqual(describeSelection(sel), {
    usedContext: [{ id: 'j', name: 'Oferta' }],
    omittedContext: [{ id: 'c', name: 'CV' }],
  });
});

test('STAR stories rank right after notes and before the CV', () => {
  const items = [item('o', 'other', 10), item('t', 'transcript', 10), item('c', 'cv', 10), item('s', 'stories', 10), item('n', 'notes', 10), item('j', 'job', 10)];
  assert.deepEqual(select(items, 1000).included.map((i) => i.item.id), ['j', 'n', 's', 'c', 't', 'o']);
});
