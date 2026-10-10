import { ValidationError } from './errors.js';

export const LIMITS = Object.freeze({
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024,
  MAX_ITEM_CHARS: 60_000,
  MAX_ITEMS: 20,
  MAX_ACTIVE_CHARS: 30_000,
  MAX_NAME_CHARS: 120,
  PREVIEW_CHARS: 300,
});

/** Tag chosen by the user; it changes how the coach uses the item. */
export const KINDS = Object.freeze(['job', 'notes', 'stories', 'cv', 'transcript', 'other']);
export const SOURCES = Object.freeze(['pdf', 'docx', 'audio', 'text']);

export function defaultKind(source) {
  return source === 'audio' ? 'transcript' : 'other';
}

export function assertKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new ValidationError(`Tipo de contexto inválido: ${kind}. Usa uno de: ${KINDS.join(', ')}`);
  }
  return kind;
}

/** File names are display text only: strip any path, control characters and markup-ish characters. */
export function sanitizeName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>"|?*]/g, '').replace(/\s+/g, ' ').trim();
  return [...(cleaned || 'Sin nombre')].slice(0, LIMITS.MAX_NAME_CHARS).join('');
}

/** Normalizes extracted text and truncates it to MAX_ITEM_CHARS (adding the `truncated` warning). */
export function normalizeText(raw) {
  let text = String(raw ?? '')
    .normalize('NFC')
    .replace(/^﻿/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const warnings = [];
  if (text.length > LIMITS.MAX_ITEM_CHARS) {
    text = text.slice(0, LIMITS.MAX_ITEM_CHARS);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
    warnings.push('truncated');
  }
  return { text, warnings };
}

export function createContextItem({ id, name, kind, source, text, warnings = [], now }) {
  if (!SOURCES.includes(source)) throw new ValidationError(`Origen inválido: ${source}`);
  assertKind(kind);
  if (!text) throw new ValidationError('No se encontró texto en el archivo');
  return {
    id, name: sanitizeName(name), kind, source, text, chars: text.length,
    active: true, createdAt: now, warnings: [...warnings],
  };
}

/** Returns a new item with the patch applied (name, kind, active, text). */
export function updateItem(item, patch = {}) {
  const next = { ...item };
  if (patch.name !== undefined) next.name = sanitizeName(patch.name);
  if (patch.kind !== undefined) next.kind = assertKind(patch.kind);
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new ValidationError('active debe ser verdadero o falso');
    next.active = patch.active;
  }
  if (patch.text !== undefined) {
    const { text, warnings } = normalizeText(patch.text);
    if (!text) throw new ValidationError('El texto no puede quedar vacío');
    next.text = text;
    next.chars = text.length;
    next.warnings = [...item.warnings.filter((w) => w !== 'truncated'), ...warnings];
  }
  return next;
}

/** Item without its full text, plus a short preview (what list endpoints return). */
export function toSummary(item) {
  const { text, ...rest } = item;
  const preview = text.length > LIMITS.PREVIEW_CHARS ? `${text.slice(0, LIMITS.PREVIEW_CHARS)}…` : text;
  return { ...rest, preview };
}
