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
