const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

// Resolve from Router so the test exercises its dependency, including nested installs.
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const queryString = routerRequire('query-string');
const input = '%EA'.repeat(1024);
const parsed = queryString.parse(`state=${input}&code=valid%2Bcode&scope=openid&scope=events`);
assert.equal(parsed.state, input);
assert.equal(parsed.code, 'valid+code');
assert.deepEqual(parsed.scope, ['openid', 'events']);

const { getStateFromPath } = routerRequire('./build/react-navigation/core/getStateFromPath');
for (const hostile of [input, '%80'.repeat(8192), '%F0%80%80%80'.repeat(2048)]) {
  const state = getStateFromPath(`/oauth/callback?state=${hostile}&code=valid%2Bcode`, {
    screens: { callback: 'oauth/callback' },
  });
  assert.equal(state.routes[0].params.state, hostile);
  assert.equal(state.routes[0].params.code, 'valid+code');
}
