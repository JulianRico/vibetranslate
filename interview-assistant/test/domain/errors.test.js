import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError, ValidationError, NotFoundError, PayloadTooLargeError,
  UnsupportedFormatError, NotConfiguredError, UpstreamError, ForbiddenError,
} from '../../src/domain/errors.js';

const CASES = [
  [ValidationError, 'VALIDATION'],
  [NotFoundError, 'NOT_FOUND'],
  [PayloadTooLargeError, 'PAYLOAD_TOO_LARGE'],
  [UnsupportedFormatError, 'UNSUPPORTED_FORMAT'],
  [NotConfiguredError, 'NOT_CONFIGURED'],
  [UpstreamError, 'UPSTREAM'],
  [ForbiddenError, 'FORBIDDEN'],
];

for (const [Cls, code] of CASES) {
  test(`${Cls.name} carries code ${code} and is a DomainError`, () => {
    const err = new Cls('boom');
    assert.equal(err.code, code);
    assert.equal(err.message, 'boom');
    assert.equal(err.name, Cls.name);
    assert.ok(err instanceof DomainError);
    assert.ok(err instanceof Error);
  });
}
