import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackCode, parsePendingFlow } from '../src/auth/protocol.ts';
const flow = { state: 'state-long-random-value', nonce: 'nonce-long-random-value', verifier: 'v'.repeat(43), redirectUri: 'https://app.example/oauth/callback', createdAt: 1000 };

test('only matching, fresh, unambiguous callbacks exchange a code', () => {
  assert.equal(callbackCode('https://app.example/oauth/callback?code=valid&state=state-long-random-value', flow, 2000), 'valid');
  for (const url of [
    'https://other.example/oauth/callback?code=valid&state=state-long-random-value',
    'https://app.example/other?code=valid&state=state-long-random-value',
    'https://app.example/oauth/callback?code=valid&state=wrong',
    'https://app.example/oauth/callback?code=valid&state=state-long-random-value&state=state-long-random-value',
    'https://app.example/oauth/callback?code=valid&code=other&state=state-long-random-value',
    'https://app.example/oauth/callback?code=valid&state=state-long-random-value#error=anything',
    'https://app.example/oauth/callback?error=access_denied&state=state-long-random-value',
  ]) assert.throws(() => callbackCode(url, flow, 2000));
  assert.throws(() => callbackCode('https://app.example/oauth/callback?code=valid&state=state-long-random-value', flow, 601001));
  assert.throws(() => callbackCode('https://app.example/oauth/callback?code=valid&state=state-long-random-value', flow, 999));
});

test('native callbacks must match the custom scheme host and path', () => {
  const native = { ...flow, redirectUri: 'larynx://oauth/callback' };
  assert.equal(callbackCode('larynx://oauth/callback?code=valid&state=state-long-random-value', native, 2000), 'valid');
  assert.throws(() => callbackCode('other://oauth/callback?code=valid&state=state-long-random-value', native, 2000));
  assert.throws(() => callbackCode('larynx://attacker/callback?code=valid&state=state-long-random-value', native, 2000));
});

test('pending flow rejects missing or malformed state before exchange', () => {
  assert.deepEqual(parsePendingFlow(JSON.stringify(flow)), flow);
  for (const value of [null, '{}', 'null', 'true', JSON.stringify({ ...flow, verifier: 'short' }), JSON.stringify({ ...flow, nonce: 1 })]) assert.throws(() => parsePendingFlow(value));
});


test('the authorization response must name the pinned issuer once', () => {
  const url = 'https://app.example/oauth/callback?code=valid&state=state-long-random-value';
  assert.equal(callbackCode(`${url}&iss=https%3A%2F%2Fapi.example%2Foidc`, flow, 2000, 'https://api.example/oidc'), 'valid');
  for (const suffix of ['', '&iss=https%3A%2F%2Fother.example%2Foidc', '&iss=https%3A%2F%2Fapi.example%2Foidc&iss=https%3A%2F%2Fapi.example%2Foidc']) {
    assert.throws(() => callbackCode(url + suffix, flow, 2000, 'https://api.example/oidc'));
  }
});
