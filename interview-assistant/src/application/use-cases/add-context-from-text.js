import {
  LIMITS, assertKind, defaultKind, normalizeText, createContextItem, sanitizeName, toSummary,
} from '../../domain/context-item.js';
import { ValidationError } from '../../domain/errors.js';

/** Stores pasted text as a context item. */
export function createAddContextFromText({ contextRepo, ids, clock }) {
  return async function addContextFromText({ name, kind, text }) {
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('El texto está vacío');
    if ((await contextRepo.list()).length >= LIMITS.MAX_ITEMS) {
      throw new ValidationError(`Máximo ${LIMITS.MAX_ITEMS} elementos de contexto; borra alguno primero`);
    }
    const chosenKind = kind === undefined || kind === null || kind === '' ? defaultKind('text') : assertKind(kind);
    const normalized = normalizeText(text);
    const item = createContextItem({
      id: ids.next(), name: sanitizeName(name || 'Texto pegado'), kind: chosenKind, source: 'text',
      text: normalized.text, warnings: normalized.warnings, now: clock.now(),
    });
    await contextRepo.add(item);
    return toSummary(item);
  };
}
