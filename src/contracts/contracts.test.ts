import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from './index.ts';
test('domain errors retain machine-readable concurrency information', () => {
  const error = new DomainError('STALE_REVISION', '内容已更新，请重新检查', { revision: 2 });
  assert.equal(error.code, 'STALE_REVISION');
  assert.equal(error.name, 'DomainError');
  assert.deepEqual(error.details, { revision: 2 });
});

