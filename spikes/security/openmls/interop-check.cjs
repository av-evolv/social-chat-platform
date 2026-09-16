// Isolated host↔Chromium WASM fixture. No credentials, persistence or production adapter.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { chromium } = require('playwright');
const TIMEOUT = 15_000;
const MAX_LINE = 2 * 65536 + 128;
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/pkg/larynx_security_spike.js', ['pkg/larynx_security_spike.js', 'text/javascript']],
  ['/pkg/larynx_security_spike_bg.wasm', ['pkg/larynx_security_spike_bg.wasm', 'application/wasm']],
]);
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout`)), TIMEOUT);
  })]).finally(() => clearTimeout(timer));
}
class NativePeer {
  constructor() {
    this.child = spawn(process.env.MLS_FIXTURE_BIN || resolve(__dirname, 'target/debug/interop-peer'), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.pending = null;
    this.failure = null;
    this.stderrBytes = 0;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_LINE) return this.fail(new Error('native output limit'));
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.pending || this.buffer.length) return this.fail(new Error('unexpected native output'));
      const pending = this.pending;
      this.pending = null;
      if (/^ERR [a-zA-Z0-9_:-]+$/.test(line)) pending.reject(new Error(line));
      else if (/^OK(?: (?:[0-9a-f]*|true|false))?$/.test(line)) pending.resolve(line.slice(3));
      else this.fail(new Error('invalid native response'), pending);
    });
    this.child.stderr.on('data', chunk => {
      // Do not print fixture diagnostics that could accidentally contain private state.
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 8192) this.fail(new Error('native stderr limit'));
    });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.closed = new Promise(resolveClose => this.child.on('close', () => {
      this.fail(new Error('native fixture exited'));
      resolveClose();
    }));
  }
  fail(error, pending = this.pending) {
    this.failure = error;
    this.pending = null;
    pending?.reject(error);
    this.child.kill('SIGKILL');
  }
  async call(method, hex) {
    if (this.failure) throw this.failure;
    assert.equal(this.pending, null, 'native commands must be serialized');
    const line = `${method}${hex === undefined ? '' : ` ${hex}`}\n`;
    assert.ok(line.length <= MAX_LINE, 'native input limit');
    try {
      const response = await bounded(new Promise((resolveReply, reject) => {
        this.pending = { resolve: resolveReply, reject };
        this.child.stdin.write(line);
      }), `native ${method}`);
      return response === 'true' ? true : response === 'false' ? false : response;
    } catch (error) {
      if (!/^ERR /.test(error.message)) this.fail(error);
      throw error;
    }
  }
  async close() {
    this.child.kill('SIGKILL');
    await bounded(this.closed, 'native cleanup');
  }
}
async function rejectsCode(action, code, label) {
  await assert.rejects(action, error => {
    const actual = String(error?.message ?? error).replace(/^ERR /, '');
    assert.equal(actual, code, label);
    return true;
  }, label);
}
const hex = text => Buffer.from(text).toString('hex');
async function exercise(page, nativeCreates) {
  const native = new NativePeer();
  const wasm = { call: (method, value) => bounded(page.evaluate(({ method, value }) =>
    {
      try { return { value: window.fixture.call('browser-fixture', method, value) }; }
      catch (error) { return { error: String(error?.message ?? error) }; }
    }, { method, value }).then(result => {
      if (result.error) throw new Error(result.error);
      return result.value;
    }), `browser ${method}`) };
  const [creator, joiner] = nativeCreates ? [native, wasm] : [wasm, native];
  const direction = nativeCreates ? 'native→WASM' : 'WASM→native';
  try {
    await bounded(page.evaluate(() => window.fixture.create('browser-fixture')), 'browser fixture creation');
    await creator.call('create_group');
    const old = await creator.call('send', hex('before admission'));
    const keyPackage = await joiner.call('key_package');
    const welcome = await creator.call('add_member', keyPackage);
    await joiner.call('join', welcome);
    assert.equal(await creator.call('authenticator'), await joiner.call('authenticator'));
    await rejectsCode(() => joiner.call('receive', old), 'receive_failed', `${direction}: pre-admission history`);
    for (const [sender, receiver] of [[creator, joiner], [joiner, creator]]) {
      await rejectsCode(() => receiver.call('receive', ''), 'invalid_frame_size', 'empty frame');
      await rejectsCode(() => receiver.call('receive', keyPackage), 'unexpected_message_type', 'unexpected MLS variant');
      const malformed = await sender.call('send', hex('malformed fixture'));
      await rejectsCode(() => receiver.call('receive', malformed.slice(0, -2)), 'invalid_frame', 'truncated frame');
      const trailing = await sender.call('send', hex('trailing fixture'));
      await rejectsCode(() => receiver.call('receive', `${trailing}00`), 'invalid_frame', 'trailing bytes');
      const tampered = Buffer.from(await sender.call('send', hex('tamper fixture')), 'hex');
      tampered[tampered.length - 1] ^= 1;
      await rejectsCode(() => receiver.call('receive', tampered.toString('hex')), 'receive_failed', 'tampered frame');
      // A fresh generation follows failures: never roll back or retry receive ratchets.
      const payload = hex(`${direction}: cross-runtime plaintext ✓`);
      const message = await sender.call('send', payload);
      assert.equal(await receiver.call('receive', message), payload);
      await rejectsCode(() => receiver.call('receive', message), 'receive_failed', 'replay');
      await rejectsCode(() => sender.call('send', '61'.repeat(1025)), 'invalid_plaintext_size', 'oversized application');
    }
    const commit = await creator.call('remove_peer');
    await rejectsCode(() => joiner.call('receive', commit), 'unexpected_message_type', 'commit on application path');
    const beforeCommit = await creator.call('send', hex('new epoch before applying removal'));
    await rejectsCode(() => joiner.call('receive', beforeCommit), 'receive_failed', 'removed peer lacks new epoch before commit');
    assert.equal(await joiner.call('active'), true);
    await joiner.call('apply_commit', commit);
    assert.equal(await joiner.call('active'), false);
    await rejectsCode(() => joiner.call('send', hex('removed send')), 'send_failed', 'removed member send');
    const after = await creator.call('send', hex('after removal'));
    await rejectsCode(() => joiner.call('receive', after), 'receive_failed', 'removed member decrypt');
    assert.equal(await joiner.call('active'), false, 'removed fixture remains responsive');
    assert.equal(await creator.call('active'), true, 'creator remains responsive');
    console.log(`${direction}: wire exchange, epoch, admission, malformed frames, replay, tamper and removal PASS`);
  } finally {
    try { await native.close(); } finally {
      await bounded(page.evaluate(() => window.fixture.dispose()), 'browser fixture cleanup');
    }
  }
}
(async () => {
  const server = createServer(async (request, response) => {
    const file = files.get(request.url);
    if (!file) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', file[1]);
      response.end(await readFile(join(__dirname, file[0])));
    } catch { response.writeHead(500).end(); }
  });
  let browser;
  try {
    await bounded(new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    }), 'fixture server');
    browser = await chromium.launch({ headless: true, timeout: TIMEOUT });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => /^(READY|FAIL:)/.test(document.querySelector('#fixture-status').textContent));
    assert.equal(await page.locator('#fixture-status').textContent(), 'READY');
    await exercise(page, true);
    await exercise(page, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'Chromium', version: browser.version(), result: 'PASS: host↔Chromium WASM wire interoperability' }));
  } finally {
    try {
      if (browser) await bounded(browser.close(), 'browser cleanup');
    } finally {
      server.closeAllConnections();
      await bounded(new Promise(resolveClose => server.close(resolveClose)), 'server cleanup');
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
