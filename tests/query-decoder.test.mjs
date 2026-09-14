import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Router query decoding finishes on an adversarial malformed UTF-8 run', () => {
  // A separate process bounds the historical CPU exhaustion and can always be killed.
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/query-decoder.cjs', import.meta.url))], {
    timeout: 3000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
