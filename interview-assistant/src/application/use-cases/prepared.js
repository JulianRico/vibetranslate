import { PREPARED_LIMITS, createPrepared, applyEdit, applyGenerated } from '../../domain/prepared.js';
import { seedPrepared } from '../../domain/default-prepared.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';

const notFound = (id) => new NotFoundError(`No existe la pregunta preparada ${id}`);

/**
 * All prepared questions. The first time (the repository has no data yet) it is seeded with the starter bank,
 * so every use case starts from the same list; an existing but empty list is respected.
 */
async function loadAll(preparedRepo, clock) {
  const existing = await preparedRepo.list();
  if (existing !== null) return existing;
  const seeded = seedPrepared(clock.now());
  await preparedRepo.replaceAll(seeded);
  return seeded;
}

export function createListPrepared({ preparedRepo, clock }) {
  return async function listPrepared() {
    return { items: await loadAll(preparedRepo, clock) };
  };
}

export function createAddPrepared({ preparedRepo, ids, clock }) {
  return async function addPrepared({ question, triggers }) {
    const items = await loadAll(preparedRepo, clock);
    if (items.length >= PREPARED_LIMITS.MAX_ITEMS) {
      throw new ValidationError(`Máximo ${PREPARED_LIMITS.MAX_ITEMS} preguntas preparadas; borra alguna primero`);
    }
    const item = createPrepared({ id: ids.next(), question, triggers, now: clock.now() });
    await preparedRepo.add(item);
    return item;
  };
}

export function createUpdatePrepared({ preparedRepo, clock }) {
  return async function updatePrepared({ id, patch }) {
    await loadAll(preparedRepo, clock);
    const item = await preparedRepo.get(id);
    if (!item) throw notFound(id);
    const next = applyEdit(item, patch ?? {}, clock.now());
    await preparedRepo.update(id, next);
    return next;
  };
}

export function createDeletePrepared({ preparedRepo, clock }) {
  return async function deletePrepared({ id }) {
    await loadAll(preparedRepo, clock);
    if (!(await preparedRepo.remove(id))) throw notFound(id);
  };
}

/**
 * Generates the answer with the coach (`suggestAnswer`: same profile, documents and rules as a live suggestion).
 * An answer the user edited is protected: regenerating it needs `force`; and an edit or delete that lands while the
 * coach is still answering is never overwritten by the late answer.
 * A failure from the coach propagates and leaves the item untouched.
 */
export function createGeneratePrepared({ preparedRepo, suggestAnswer, clock }) {
  return async function generatePrepared({ id, force = false, signal }) {
    await loadAll(preparedRepo, clock);
    const item = await preparedRepo.get(id);
    if (!item) throw notFound(id);
    if (item.status === 'edited' && !force) {
      throw new ValidationError('Esta respuesta la editaste tú: confirma para regenerarla y perder tus cambios');
    }
    const { suggestion } = await suggestAnswer({ turns: [item.question], signal });
    // The AI can take a while: whatever the user saved or deleted meanwhile wins over the late answer.
    const current = await preparedRepo.get(id);
    if (!current) throw notFound(id);
    if (JSON.stringify(current) !== JSON.stringify(item)) {
      throw new ValidationError('La pregunta cambió mientras se generaba la respuesta; no se tocó. Vuelve a intentarlo si quieres.');
    }
    const next = applyGenerated(current, suggestion, clock.now());
    await preparedRepo.update(id, next);
    return next;
  };
}
