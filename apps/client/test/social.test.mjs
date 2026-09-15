import assert from 'node:assert/strict';
import test from 'node:test';
import { addSource, operationKey, sourceFingerprint } from '../src/social/editor.ts';

const id = '01995061-6100-7000-8000-000000000001';
test('audience editor normalizes codes and retains exclusions alongside inclusions', () => {
  const included = addSource([], 'USER', ` ${id.toUpperCase()} `, 'INCLUDE');
  assert.deepEqual(included, [{ type: 'USER', id, operation: 'INCLUDE' }]);
  assert.equal(addSource(included, 'USER', id, 'INCLUDE'), included);
  const excluded = addSource(included, 'USER', id, 'EXCLUDE');
  assert.equal(excluded.length, 2);
  assert.notEqual(sourceFingerprint(included), sourceFingerprint(excluded));
  assert.equal(sourceFingerprint(excluded), sourceFingerprint([...excluded].reverse()));
  assert.throws(() => addSource([], 'USER', 'incomplete code', 'INCLUDE'), /complete contact/);
});

test('creation keys encode time as UUIDv7 while preserving independent random bits', () => {
  const random = new Uint8Array(16).fill(255);
  const value = operationKey(0x019950616100, random);
  assert.equal(value, '01995061-6100-7fff-bfff-ffffffffffff');
  assert.equal(random[6], 255);
  assert.notEqual(value, operationKey(0x019950616100, new Uint8Array(16)));
  assert.throws(() => operationKey(-1, random));
  assert.throws(() => operationKey(Date.now(), new Uint8Array(15)));
});
