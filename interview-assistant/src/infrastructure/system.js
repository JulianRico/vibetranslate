import { randomUUID } from 'node:crypto';

/** IdGenerator: short unique ids like `c_3f9a1b2c` (the prefix tells what they identify: `c_` context, `p_` prepared). */
export function createIdGenerator(prefix = 'c_') {
  return { next: () => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8)}` };
}

/** Clock: ISO-8601 timestamps. */
export function createClock() {
  return { now: () => new Date().toISOString() };
}
