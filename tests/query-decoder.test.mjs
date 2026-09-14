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

// These are Router's bundled React Navigation helpers, which consume query-string.
// No mock decoder or network service is used; the callback routes are test fixtures.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const queryString = routerRequire('query-string');
const queryRequire = createRequire(routerRequire.resolve('query-string'));
const decode = queryRequire('decode-uri-component');
const { getStateFromPath } = routerRequire('./build/react-navigation/core/getStateFromPath');
const { getPathFromState } = routerRequire('./build/react-navigation/core/getPathFromState');

for (const [input, expected] of [
  ['%E4%BD%A0%E5%A5%BD%20%F0%9F%98%80', '你好 😀'],
  ['%2B', '+'], ['%2525', '%25'], ['%00', '\0'],
  ['%C3%A5%80%C3%A5', 'å%80å'], ['%C2', '\uFFFD'],
  ['%FE%FF', '\uFFFD\uFFFD'], ['%F0%9F%98', '%F0%9F%98'],
  ['%ED%A0%80', '%ED%A0%80'], ['%F4%90%80%80', '%F4%90%80%80'],
  ['%C0%AF', '%C0%AF'], ['%G0%C3%A5', '%G0å'],
  ['%84%D7%25%88%90', '%84%D7%%88%90'],
]) {
  test(`CommonJS decoder preserves expected decoding for ${input}`, () => {
    assert.equal(typeof decode, 'function');
    assert.equal(decode(input), expected);
  });
}

test('query-string keeps form encoding, duplicates, empty and bare values', () => {
  assert.deepEqual({ ...queryString.parse('name=Hello+world&code=a%2Bb&scope=openid&scope=events&empty=&flag') }, {
    name: 'Hello world', code: 'a+b', scope: ['openid', 'events'], empty: '', flag: null,
  });
});

const options = { screens: { callback: 'oauth/callback', invite: 'invite/:token' } };
for (const [path, routeName, params] of [
  ['/oauth/callback?code=abc%2B123%2Fxyz&state=state%2525&scope=openid&scope=events', 'callback',
    { code: 'abc+123/xyz', state: 'state%25', scope: ['openid', 'events'] }],
  ['/invite/token_123?name=Jos%C3%A9+%F0%9F%98%80&next=%2Fevents%3Fid%3D42', 'invite',
    { token: 'token_123', name: 'José 😀', next: '/events?id=42' }],
  ['/oauth/callback?error=access_denied&error_description=User+cancelled', 'callback',
    { error: 'access_denied', error_description: 'User cancelled' }],
]) {
  test(`bundled navigation parser handles ${routeName} parameters`, () => {
    const state = getStateFromPath(path, options);
    assert.equal(state.routes[0].name, routeName);
    assert.deepEqual({ ...state.routes[0].params }, params);
  });
}

test('bundled navigation serializes and reparses scalar callback parameters once', () => {
  const original = { code: 'a+b/c=', state: 'percent%25', next: '/events?id=42' };
  const path = getPathFromState({ routes: [{ name: 'callback', params: original }] }, options);
  assert.deepEqual({ ...getStateFromPath(path, options).routes[0].params }, original);
});
