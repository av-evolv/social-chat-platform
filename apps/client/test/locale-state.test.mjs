import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/i18n/state.ts', import.meta.url), 'utf8');
const compiled = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: new URL('..', import.meta.url).pathname },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'native-platform-fixtures', setup(builder) {
    builder.onResolve({ filter: /^(react-native|expo-secure-store|expo-localization)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: {
      'react-native': "export const Platform={OS:'ios'}; export const AppState={addEventListener:(_,listener)=>{globalThis.__fixture.onAppState=listener;return {remove(){}}}};",
      'expo-secure-store': 'export const getItemAsync=(key)=>globalThis.__fixture.read(key); export const setItemAsync=(key,value)=>globalThis.__fixture.write(key,value);',
      'expo-localization': 'export const getLocales=()=>globalThis.__fixture.tags.map(languageTag=>({languageTag}));',
    }[args.path], loader: 'js' }));
  } }],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function state(overrides = {}) {
  const fixture = { tags: ['en-US'], read: async () => null, write: async () => {}, ...overrides };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, __fixture: fixture, Intl, console, setTimeout, clearTimeout });
  return { api: module.exports, fixture };
}

test('a delayed saved preference cannot replace an explicit language selection', async () => {
  const read = deferred();
  const writes = [];
  const { api } = state({ read: () => read.promise, write: async (key, value) => { writes.push([key, value]); } });
  const initializing = api.initializeLocale();
  await api.setLocale('fr');
  read.resolve('en');
  await initializing;
  assert.equal(api.getLocale(), 'fr');
  assert.deepEqual(writes, [['larynx.locale', 'fr']]);
});

test('foregrounding during the initial SecureStore read still restores the saved preference', async () => {
  const read = deferred();
  const { api, fixture } = state({ read: () => read.promise });
  const initializing = api.initializeLocale();
  fixture.onAppState('active');
  read.resolve('fr');
  await initializing;
  assert.equal(api.getLocale(), 'fr');
});

test('a late account response cannot overwrite a newer explicit choice', async () => {
  const { api } = state();
  await api.initializeLocale();
  const requestedAt = api.getLocaleVersion();
  await api.setLocale('fr');
  await api.applyAccountLocale('en', requestedAt);
  assert.equal(api.getLocale(), 'fr');
  await api.applyAccountLocale('en', api.getLocaleVersion());
  assert.equal(api.getLocale(), 'en');
  await api.applyAccountLocale(null, api.getLocaleVersion());
  assert.equal(api.getLocale(), 'en');
});

test('failed native storage keeps the current choice and does not poison future saves', async () => {
  let failed = false;
  const writes = [];
  const { api } = state({
    read: async () => { throw new Error('SecureStore unavailable'); },
    write: async (_key, value) => { if (!failed) { failed = true; throw new Error('Write denied'); } writes.push(value); },
    tags: ['fr-FR'],
  });
  await api.initializeLocale();
  assert.equal(api.getLocale(), 'fr');
  await assert.rejects(api.setLocale('en'), /Write denied/);
  assert.equal(api.getLocale(), 'en');
  await api.setLocale('fr');
  assert.deepEqual(writes, ['fr']);
});

test('queued preference writes preserve the final user choice despite storage latency', async () => {
  const first = deferred();
  const started = deferred();
  const writes = [];
  const { api } = state({ write: async (_key, value) => {
    writes.push(value);
    if (writes.length === 1) { started.resolve(); await first.promise; }
  } });
  await api.initializeLocale();
  const french = api.setLocale('fr');
  const english = api.setLocale('en');
  await started.promise;
  assert.deepEqual(writes, ['fr']);
  assert.equal(api.getLocale(), 'en');
  first.resolve();
  await Promise.all([french, english]);
  assert.deepEqual(writes, ['fr', 'en']);
});

test('native system language changes apply only before a saved or explicit preference', async () => {
  const { api, fixture } = state({ tags: ['de-DE', 'en-GB'] });
  await api.initializeLocale();
  assert.equal(api.getLocale(), 'en');
  fixture.tags = ['fr-CA'];
  fixture.onAppState('active');
  assert.equal(api.getLocale(), 'fr');
  await api.setLocale('en');
  fixture.onAppState('active');
  assert.equal(api.getLocale(), 'en');
});
