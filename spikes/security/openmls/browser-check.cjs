// Uses the repository's existing Playwright dependency; no server or Docker changes.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('playwright');
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/pkg/larynx_security_spike.js', ['pkg/larynx_security_spike.js', 'text/javascript']],
  ['/pkg/larynx_security_spike_bg.wasm', ['pkg/larynx_security_spike_bg.wasm', 'application/wasm']],
]);
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => /^(PASS|FAIL):/.test(document.querySelector('#result').textContent));
    const result = await page.locator('#result').textContent();
    assert.match(result, /^PASS:/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'Chromium', version: browser.version(), result, errors }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
