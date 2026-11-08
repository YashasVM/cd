import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import { chromium } from 'playwright-core';
import { availablePort, childExit, collect, findChromium, run, stopChild, waitForHealth, withTimeout } from './verify-helpers.mjs';

// Product sharing behavior against a local Worker and a real CLI receiver.
const port = await availablePort();
const publicBase = `http://127.0.0.1:${port}`;
const childEnv = { ...process.env, CD_RELAY_URL: `ws://127.0.0.1:${port}/ws/v1`, CD_PUBLIC_URL: publicBase };
const work = await mkdtemp(join(tmpdir(), 'cd-verify-browser-'));
const executable = join(work, 'cdx');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pattern = (length, seed) => Buffer.from(Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256));

const single = pattern(3 * 1024 * 1024 + 77, 5);
const singlePath = join(work, 'holiday video.mp4');
await writeFile(singlePath, single);
const batch = [['a.txt', Buffer.from('first')], ['b.bin', pattern(600_000, 9)], ['empty.dat', Buffer.alloc(0)]];
const batchPaths = [];
for (const [name, bytes] of batch) {
  const path = join(work, name);
  await writeFile(path, bytes);
  batchPaths.push(path);
}

let worker;
const browsers = [];
try {
  await run('go', ['build', '-buildvcs=false', '-trimpath', '-o', executable, './cmd/cdx']);
  const wranglerCli = fileURLToPath(import.meta.resolve('wrangler'));
  worker = spawn(process.execPath, [wranglerCli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'wrangler-state')], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(`${publicBase}/api/health`, worker);
  const executablePath = await findChromium();
  const launch = async (args = []) => {
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage', ...args] });
    browsers.push(browser);
    return browser;
  };
  const browser = await launch();

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const requests = [];
  const frames = [];
  page.on('websocket', socket => socket.on('framesent', event => { if (typeof event.payload === 'string') frames.push(event.payload); }));
  page.on('request', request => { if (request.method() === 'POST') requests.push({ url: request.url(), body: request.postData() ?? '' }); });
  await page.goto(`${publicBase}/send`);
  await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles([singlePath, batchPaths[0]]);
  assert.equal(await page.getByLabel('Sharing method').inputValue(), 'private');
  await page.locator('.selection-panel summary').click();
  await page.getByRole('button', { name: 'Remove a.txt', exact: true }).click();
  assert.equal(await page.locator('.selection-panel li').count(), 1);
  assert.equal(requests.length, 0, 'selection must not start a transfer');
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
  }
  await page.locator('.selection-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.getElementById('share-qr');
    return canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0;
  });
  const qr = await page.locator('#share-qr').evaluate(canvas => {
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data), width, height };
  });
  const link = jsQR(Uint8ClampedArray.from(qr.data), qr.width, qr.height)?.data;
  assert.ok(link?.startsWith(`${publicBase}/s/`), 'QR contains full receive URL');
  assert.match(link, /#v1\./);
  assert.ok(!requests.some(request => request.url.endsWith('/api/codes')), 'private transfer requested numeric code');
  assert.ok(![...requests.map(request => request.body), ...frames].some(body => body.includes('shareKey')), 'private transfer disclosed shareKey');
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['replacement'], 'replacement.txt'));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  });
  const outDir = join(work, 'private-received');
  await mkdir(outDir);
  const receiver = spawn(executable, ['receive', link, '--out', outDir, '--json'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = collect(receiver.stdout);
  const stderr = collect(receiver.stderr);
  assert.equal(await withTimeout(childExit(receiver), 60_000, 'private receive stalled'), 0, await stderr);
  const result = JSON.parse(await stdout);
  assert.equal(sha(await readFile(result.path)), sha(single), 'active paste replaced original bytes');
  await page.locator('#sender-complete:not(.hidden)').waitFor();
  const retryPage = await context.newPage();
  retryPage.setDefaultTimeout(30_000);
  await retryPage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__uxFailureTriggered = false;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (!String(url).includes('/ws/v1/')) return;
        this.addEventListener('message', event => {
          if (!window.__uxFailureTriggered && typeof event.data === 'string' && JSON.parse(event.data).type === 'accepted') {
            window.__uxFailureTriggered = true;
            queueMicrotask(() => this.close(4000, 'induced failure'));
          }
        });
      }
    };
  });
  await retryPage.goto(publicBase);
  await retryPage.locator('.workbench:not([inert])').waitFor();
  await retryPage.locator('#file-input').setInputFiles(singlePath);
  await retryPage.getByLabel('Sharing method').selectOption('code');
  await retryPage.locator('.selection-panel').getByRole('button', { name: 'Send', exact: true }).click();
  try { await retryPage.locator('#sender-retry-btn').waitFor({ state: 'visible' }); }
  catch (error) { throw new Error(`Retry did not appear. Fail triggered=${await retryPage.evaluate(() => window.__uxFailureTriggered)}; state=${await retryPage.locator('#app-state').textContent()}; error=${await retryPage.locator('#sender-error').textContent()}; status=${await retryPage.locator('#sender-status').textContent()}`, { cause: error }); }
  await retryPage.locator('#sender-retry-btn').click();
  await retryPage.locator('#sender-code-section:not(.hidden)').waitFor();
  assert.match(await retryPage.locator('body').textContent(), /holiday video/);
  const cancelPage = await context.newPage();
  await cancelPage.goto(publicBase);
  await cancelPage.locator('.workbench:not([inert])').waitFor();
  await cancelPage.locator('#file-input').setInputFiles(singlePath);
  await cancelPage.getByLabel('Keep progress if interrupted').check();
  await cancelPage.locator('#start-send-btn').click();
  await cancelPage.locator('#receive-command').filter({ hasText: '#v2.' }).waitFor();
  await cancelPage.locator('#sender-cancel-btn').click();
  await cancelPage.waitForFunction(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('cd-resume-v2');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const keys = db.transaction('secrets').objectStore('secrets').getAllKeys();
      keys.onsuccess = () => { db.close(); resolve(!keys.result.some(key => String(key).startsWith('sender:'))); };
    };
  }));
  assert.equal(await cancelPage.locator('#app-state').textContent(), 'ready');
  await context.close();
  console.log('verified private /send selection, QR, privacy, mobile layout and exact CLI bytes');
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  await stopChild(worker);
  await rm(work, { recursive: true, force: true });
}

