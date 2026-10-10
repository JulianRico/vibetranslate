import { LIMITS, toSummary, updateItem } from '../../domain/context-item.js';
import { NotFoundError } from '../../domain/errors.js';

const notFound = (id) => new NotFoundError(`No existe el elemento de contexto ${id}`);

export function createListContext({ contextRepo }) {
  return async function listContext() {
    const items = await contextRepo.list();
    const activeChars = items.filter((i) => i.active).reduce((sum, i) => sum + i.chars, 0);
    return { items: items.map(toSummary), activeChars, maxActiveChars: LIMITS.MAX_ACTIVE_CHARS };
  };
}

/** Full item, including its text. */
export function createGetContextItem({ contextRepo }) {
  return async function getContextItem({ id }) {
    const item = await contextRepo.get(id);
    if (!item) throw notFound(id);
    return item;
  };
}

export function createUpdateContext({ contextRepo }) {
  return async function updateContext({ id, patch }) {
    const item = await contextRepo.get(id);
    if (!item) throw notFound(id);
    const next = updateItem(item, patch);
    await contextRepo.update(id, next);
    return toSummary(next);
  };
}

export function createDeleteContext({ contextRepo }) {
  return async function deleteContext({ id }) {
    if (!(await contextRepo.remove(id))) throw notFound(id);
  };
}
