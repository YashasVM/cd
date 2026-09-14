// End-to-end check for the browser-to-browser P2P flow: two headless
// pages share a file through the local Worker (PeerJS signaling +
// WebRTC data channel) and the receiver's bytes must match exactly.
// Runs each download tier: OPFS staging (default) and the RAM Blob
// fallback (OPFS disabled).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const port = await availablePort();
const baseUrl = process.env.CD_VERIFY_URL || `http://127.0.0.1:${port}`;
const work = await mkdtemp(join(tmpdir(), 'cd-verify-p2p-'));
const sourcePath = join(work, 'p2p solicitée.bin');
const source = Uint8Array.from({ length: 300 * 1024 }, (_, index) => (index * 31 + 17) % 256);
await writeFile(sourcePath, source);

let worker;
let browser;
try {
  if (!process.env.CD_VERIFY_URL) {
    const wranglerCli = fileURLToPath(import.meta.resolve('wrangler'));
    worker = spawn(process.execPath, [wranglerCli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'wrangler-state')], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    worker.stdout.resume();
    worker.stderr.resume();
    await waitForHealth(`${baseUrl}/api/health`, worker);
  }
  browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: true,
    args: ['--disable-dev-shm-usage']
  });
  for (const mode of ['opfs', 'blob', 'opfs-unavailable']) {
    await transferOnce(browser, work, baseUrl, sourcePath, source, mode);
    console.log(`verified P2P ${mode} tier: exact bytes, browser to browser`);
  }
  await browser.close();
  browser = null;
  await verifyCancellation(baseUrl);
} finally {
  await browser?.close();
  await stopChild(worker);
  await rm(work, { recursive: true, force: true });
}

async function verifyCancellation(baseUrl) {
  const chromiumPath = await findChromium();
  await new Promise((resolve, reject) => {
    const check = spawn(process.execPath, [fileURLToPath(new URL('./verify-cancel.mjs', import.meta.url))], {
      env: { ...process.env, CD_VERIFY_URL: baseUrl, CHROMIUM_PATH: chromiumPath },
      stdio: 'inherit'
    });
    check.once('error', reject);
    check.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cancellation verification exited with ${code}`)));
  });
}

async function transferOnce(browser, work, baseUrl, sourcePath, source, mode) {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript((tier) => {
      delete window.showSaveFilePicker;
      if (tier === 'blob') delete window.navigator.storage.getDirectory;
      if (tier === 'opfs-unavailable') {
        window.navigator.storage.getDirectory = async () => { throw new DOMException('Storage unavailable', 'NotAllowedError'); };
      }
    }, mode);
    const sender = await context.newPage();
    const receiver = await context.newPage();
    sender.setDefaultTimeout(30_000);
    receiver.setDefaultTimeout(120_000);
    // Keep browser failures actionable in CI. Playwright's event timeout only
    // says that no download arrived; page errors and the receiver's rendered
    // state identify whether the transfer failed before the save click.
    const pageErrors = [];
    receiver.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    receiver.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
    });
    await sender.goto(baseUrl);
    await sender.locator('#file-input').setInputFiles(sourcePath);
    await sender.locator('#sender-code-section:not(.hidden)').waitFor();
    const code = (await sender.locator('#share-code').textContent()).trim();
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    await receiver.goto(baseUrl);
    await receiver.locator('#receive-mode-btn').click();
    await receiver.locator('#code-input').fill(code);
    const downloadEvent = receiver.waitForEvent('download', { timeout: 120_000 });
    // The completion assertion can fail before the download event timeout;
    // mark this promise handled so its later rejection does not obscure the
    // useful assertion error in Node's unhandled-rejection handler.
    downloadEvent.catch(() => {});
    let download;
    try {
      await receiver.locator('#connect-btn').click();
      await receiver.locator('#receiver-complete:not(.hidden)').waitFor({ timeout: 120_000 });
      download = await downloadEvent;
    } catch (error) {
      const state = await receiver.locator('#app-state').textContent({ timeout: 1_000 }).catch(() => 'unavailable');
      const status = await receiver.locator('#receiver-error .error-message').textContent({ timeout: 1_000 }).catch(() => '');
      const details = [
        `mode=${mode}`,
        `app-state=${state?.trim() || 'empty'}`,
        status?.trim() && `receiver-error=${status.trim()}`,
        ...pageErrors
      ].filter(Boolean).join('; ');
      error.message = `${error.message} (${details})`;
      throw error;
    }
    const receivedPath = join(work, `p2p-${mode}-${await download.suggestedFilename()}`);
    await download.saveAs(receivedPath);
    assert.deepEqual(Buffer.from(await readFile(receivedPath)), Buffer.from(source));
  } finally {
    await context.close();
  }
}

async function findChromium() {
  const { access } = await import('node:fs/promises');
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chromium was not found; set CHROMIUM_PATH to run the browser transfer check');
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await killed;
  }
}

async function waitForHealth(url, child) {
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('wrangler stopped before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('wrangler did not become ready');
}
