import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createListContext, createGetContextItem, createUpdateContext, createDeleteContext,
} from '../../src/application/use-cases/manage-context.js';
import { createContextItem } from '../../src/domain/context-item.js';
import { NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createMemoryContextRepository } from '../support/fakes.js';

const make = (id, over = {}) => createContextItem({ id, name: `${id}.txt`, kind: 'notes', source: 'text', text: 'hola mundo', now: 'T0', ...over });

function setup() {
  const contextRepo = createMemoryContextRepository([make('c_1'), { ...make('c_2'), active: false }]);
  return {
    contextRepo,
    list: createListContext({ contextRepo }),
    get: createGetContextItem({ contextRepo }),
    update: createUpdateContext({ contextRepo }),
    remove: createDeleteContext({ contextRepo }),
  };
}

test('list returns summaries and the active character count', async () => {
  const { list } = setup();
  const out = await list();
  assert.equal(out.items.length, 2);
  assert.equal('text' in out.items[0], false);
  assert.equal(out.activeChars, 10);
  assert.equal(out.maxActiveChars, 30000);
});

test('get returns the full item or NotFoundError', async () => {
  const { get } = setup();
  assert.equal((await get({ id: 'c_1' })).text, 'hola mundo');
  await assert.rejects(get({ id: 'nope' }), NotFoundError);
});

test('update applies the patch, persists it and returns a summary', async () => {
  const { update, contextRepo } = setup();
  const out = await update({ id: 'c_2', patch: { active: true, kind: 'job', text: 'nuevo texto' } });
  assert.equal(out.active, true);
  assert.equal(out.kind, 'job');
  assert.equal(out.chars, 11);
  assert.equal((await contextRepo.get('c_2')).text, 'nuevo texto');
});

test('update validates the patch and reports unknown ids', async () => {
  const { update } = setup();
  await assert.rejects(update({ id: 'c_1', patch: { kind: 'nope' } }), ValidationError);
  await assert.rejects(update({ id: 'zzz', patch: { active: true } }), NotFoundError);
});

test('delete removes the item or reports NotFoundError', async () => {
  const { remove, contextRepo } = setup();
  await remove({ id: 'c_1' });
  assert.equal(await contextRepo.get('c_1'), null);
  await assert.rejects(remove({ id: 'c_1' }), NotFoundError);
});
