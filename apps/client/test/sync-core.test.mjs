import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncPage } from '../src/sync/protocol.ts';
import { applySyncPage, emptySyncCache } from '../src/sync/cache.ts';
import { createSyncController } from '../src/sync/controller.ts';
const id = '019946ab-1111-7111-8111-111111111111';
const circle = (revision = '1') => ({ type: 'circle', id, revision, data: { id, revision, createdAt: '2026-09-16T00:00:00.000Z', role: 'OWNER', state: 'ACTIVE' } });
const page = (cursor, resources = [], hasMore = false, mode = 'snapshot') => ({ mode, resources, cursor, hasMore });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) { for (let i = 0; i < 100; i++) { if (condition()) return; await sleep(5); } assert.fail('Condition did not become true'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('snapshot staging is hidden and final cursor installs atomically', () => {
  const initial = emptySyncCache();
  const staged = applySyncPage(initial, parseSyncPage(page('a', [circle()], true)), undefined);
  assert.equal(initial.cursor, undefined); assert.equal(staged.visible.size, 0);
  const result = applySyncPage(staged, parseSyncPage(page('b')), 'a');
  assert.equal(result.visible.size, 1); assert.equal(result.cursor, 'b'); assert.equal(result.staging, undefined);
  assert.throws(() => applySyncPage(result, parseSyncPage(page('c', [], false, 'delta')), 'wrong'));
});
test('delta revisions use arbitrary precision and copied data cannot mutate inputs', () => {
  const input = page('a', [circle('9007199254740993')]);
  let state = applySyncPage(emptySyncCache(), parseSyncPage(input), undefined);
  input.resources[0].data.role = 'MEMBER';
  state = applySyncPage(state, parseSyncPage(page('b', [circle('9007199254740992')], false, 'delta')), 'a');
  assert.equal([...state.visible.values()][0].revision, '9007199254740993'); assert.equal([...state.visible.values()][0].data.role, 'OWNER');
  state = applySyncPage(state, parseSyncPage(page('c', [], true, 'delta')), 'b'); assert.equal(state.cursor, 'c');
});
test('malformed metadata, excessive pages and unsafe LEFT fields fail closed', () => {
  for (const value of [page('a', [{ ...circle(), revision: '01' }]), page('a', [circle(), ...Array(100).fill(circle())]), page('a', [{ ...circle(), data: { ...circle().data, state: 'UNKNOWN' } }]), page('a', [{ type: 'conversation', id, revision: '1', data: { id, revision: '1', createdAt: circle().data.createdAt, memberState: 'LEFT', sendGate: 'CLOSED', role: 'OWNER' } }])]) assert.throws(() => parseSyncPage(value));
});
test('ignored abort never overlaps requests or installs stale data after resume', async () => {
  const old = deferred(), newer = deferred(); let calls = 0, concurrent = 0, maximum = 0; const views = [];
  const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { maximum = Math.max(maximum, ++concurrent); const result = await (++calls === 1 ? old.promise : newer.promise); concurrent--; return result; }, onChange: view => views.push(view) });
  controller.start(); await until(() => calls === 1); controller.pause(); controller.resume(); await sleep(10); assert.equal(calls, 1);
  old.resolve(page('old', [circle()])); await until(() => calls === 2); assert.equal(views.at(-1).circles.length, 0); assert.equal(maximum, 1);
  controller.stop(); newer.resolve(page('new', [circle()])); await sleep(10); assert.equal(views.at(-1).circles.length, 0);
});
test('reset clears published state immediately and replaces with final snapshot', async () => {
  const resetPage = deferred(), waiting = deferred(); let calls = 0; const views = [];
  const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { calls++; if (calls === 1) return page('a', [circle()]); if (calls === 2) throw { status: 409, code: 'sync_reset_required' }; if (calls === 3) return resetPage.promise; return waiting.promise; }, onChange: view => views.push(view) });
  controller.start(); await until(() => calls === 3); assert.equal(views.at(-1).circles.length, 0); assert.ok(views.some(v => v.circles.length === 1));
  resetPage.resolve(page('b')); await until(() => views.at(-1).phase === 'live'); assert.equal(views.at(-1).circles.length, 0); controller.stop(); waiting.resolve(page('c', [], false, 'delta'));
});
test('repeated reset errors terminate rather than loop', async () => {
  let calls = 0; const views = []; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { calls++; throw { status: 409, code: 'sync_reset_required' }; }, onChange: v => views.push(v) });
  controller.start(); await until(() => views.at(-1).phase === 'error'); assert.equal(calls, 4); controller.stop();
});
test('retry re-verifies identity; malformed pages terminate', async () => {
  let calls = 0, verifies = 0; const views = []; const controller = createSyncController({ verify: async () => { verifies++; return 'session'; }, fetchPage: async () => { if (++calls === 1) throw { status: 503, code: 'unavailable' }; return { invalid: true }; }, retryDelay: () => 1, onChange: v => views.push(v) });
  controller.start(); await until(() => views.at(-1).phase === 'error'); assert.equal(verifies, 2); assert.ok(views.some(v => v.phase === 'retrying')); assert.equal(views.at(-1).errorCode, 'sync_invalid_response'); controller.stop();
});
test('refresh coalesces completion promises and pause rejects pending refresh', async () => {
  const pending = deferred(); let calls = 0; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { calls++; return pending.promise; }, onChange: () => {} });
  controller.start(); await until(() => calls === 1); const a = controller.refresh(), b = controller.refresh(); assert.equal(a, b);
  const rejected = assert.rejects(a, /sync_paused/); controller.pause(); await rejected; pending.resolve(page('old')); controller.stop();
});
test('empty filtered pages follow their cursor and refresh waits for final snapshot', async () => {
  const outstanding = deferred(), finish = deferred(); const calls = [], views = [];
  const controller = createSyncController({ verify: async () => 'session', fetchPage: async (after, wait) => { calls.push({ after, wait }); if (calls.length === 1) return outstanding.promise; if (calls.length === 2) return page('staged', [circle()], true); if (calls.length === 3) return finish.promise; return new Promise(() => {}); }, onChange: v => views.push(v) });
  controller.start(); await until(() => calls.length === 1); const refreshed = controller.refresh(); let settled = false; refreshed.then(() => { settled = true; });
  outstanding.resolve(page('old', [circle()])); await until(() => calls.length === 3);
  assert.equal(calls[1].after, undefined); assert.equal(calls[2].after, 'staged'); assert.equal(settled, false); assert.equal(views.at(-1).circles.length, 0);
  finish.resolve(page('done')); await refreshed; assert.equal(views.at(-1).circles.length, 1); controller.stop();
});
test('authorization failure terminates with cleared metadata and no retry', async () => {
  let calls = 0; const views = []; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { if (++calls === 1) return page('a', [circle()]); throw { status: 403, code: 'insufficient_scope' }; }, onChange: v => views.push(v) });
  controller.start(); await until(() => views.at(-1).phase === 'error'); assert.equal(calls, 2); assert.equal(views.at(-1).circles.length, 0); assert.equal(views.at(-1).errorCode, 'insufficient_scope'); controller.stop();
});
test('a replacement snapshot removes resources absent from the new set', () => {
  const previous = applySyncPage(emptySyncCache(), parseSyncPage(page('a', [circle()])), undefined);
  const replacement = applySyncPage(emptySyncCache(), parseSyncPage(page('b')), undefined);
  assert.equal(previous.visible.size, 1); assert.equal(replacement.visible.size, 0);
});
test('explicit refresh recovers from terminal error without an automatic error loop', async () => {
  let calls = 0; const views = []; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { if (++calls === 1) throw { status: 403, code: 'insufficient_scope' }; if (calls === 2) return page('recovered'); return new Promise(() => {}); }, onChange: v => views.push(v) });
  controller.start(); await until(() => views.at(-1).phase === 'error'); assert.equal(calls, 1); await controller.refresh(); assert.equal(views.at(-1).phase, 'live'); controller.stop();
});
test('successful snapshots reset the consecutive recovery budget across ordinary membership changes', async () => {
  let calls = 0; const views = []; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { calls++; if (calls > 11) return new Promise(() => {}); if (calls % 2 === 0) throw { status: 409, code: 'sync_reset_required' }; return page(`snapshot-${calls}`, [circle(String(calls))]); }, onChange: v => views.push(v) });
  controller.start(); await until(() => calls === 12); assert.equal(views.at(-1).phase, 'live'); assert.equal(views.at(-1).circles[0].revision, '11'); assert.equal(views.some(v => v.phase === 'error'), false); controller.stop();
});
test('valid zero crypto epoch is accepted but encrypted content is discarded', () => {
  const encrypted = { type: 'message', id, revision: '1', data: { id, revision: '1', conversationId: id, authorId: id, authorDeviceId: id, senderDeviceId: id, deleted: false, generation: '1', cryptoEpoch: '0', envelopeVersion: 1, createdAt: circle().data.createdAt, updatedAt: circle().data.createdAt, ciphertext: 'YQ==' } };
  const parsed = parseSyncPage(page('a', [encrypted])); assert.equal(parsed.resources[0].data, null);
});
test('delta additions cannot exceed the total visible cache byte budget', () => {
  let state = applySyncPage(emptySyncCache(), parseSyncPage(page('start')), undefined);
  const members = Array.from({ length: 900 }, () => ({ participantId: id, role: 'MEMBER', state: 'ACTIVE' }));
  assert.throws(() => {
    for (let i = 1; i < 100; i++) {
      const nextId = `019946ab-1111-7111-8111-${String(i).padStart(12, '0')}`;
      const value = circle(); value.id = nextId; value.data.id = nextId; value.data.members = members;
      state = applySyncPage(state, parseSyncPage(page(`delta-${i}`, [value], false, 'delta')), state.cursor);
    }
  }, /capacity exceeded/);
});
test('reset epoch survives batching that exposes only final live views', async () => {
  let calls = 0; const complete = []; const controller = createSyncController({ verify: async () => 'session', fetchPage: async () => { calls++; if (calls === 1) return page('initial', [circle()]); if (calls === 2) throw { status: 409, code: 'sync_reset_required' }; if (calls === 3) return page('replacement', [circle()]); return new Promise(() => {}); }, onChange: v => { if (v.phase === 'live') complete.push(v); } });
  controller.start(); await until(() => complete.length === 2);
  assert.deepEqual(complete[0].circles, complete[1].circles); assert.ok(complete[1].epoch > complete[0].epoch);
  controller.stop();
});
