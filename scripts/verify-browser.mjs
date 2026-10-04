import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { chromium } from 'playwright-core';
import { availablePort, childExit, collect, findChromium, run, stopChild, waitForHealth, withTimeout } from './verify-helpers.mjs';

// The main page's Send tab: a numeric code that a browser Receive box,
// `cdx receive`, and a scanned QR code all accept. Runs against a local
// Worker. Set CHROMIUM_PATH if Chromium lives outside the common paths.
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

  async function startSend(paths) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(publicBase);
    await page.locator('.workbench:not([inert])').waitFor();
    await page.locator('#file-input').setInputFiles(paths);
    await page.locator('#sender-code-section:not(.hidden)').waitFor();
    const code = (await page.locator('#share-code').textContent()).trim();
    assert.match(code, /^\d{4,5}$/, `send code ${code} is not numeric`);
    assert.equal((await page.locator('#receive-command').textContent()).trim(), `cdx receive ${code}`);
    senderStatus = async () => `${await page.locator('#app-state').textContent()} / ${await page.locator('#sender-status').textContent()} / ${await page.locator('#sender-progress .progress-percent').textContent()}`;
    return { context, page, code };
  }

  let senderStatus = async () => '';
  async function receiveInBrowser(receiverBrowser, open) {
    const context = await receiverBrowser.newContext({ acceptDownloads: true });
    // Headless Chromium has no save dialog: use the in-memory download path.
    await context.addInitScript(() => { delete window.showSaveFilePicker; });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(publicBase);
    await page.locator('.workbench:not([inert])').waitFor();
    await page.locator('#receive-mode-btn').click();
    await open(page);
    await page.locator('#receiver-relay [data-relay="offer"]:not([hidden])').waitFor();
    await page.locator('[data-relay="accept"]').click();
    try {
      await page.locator('[data-relay="status"]').filter({ hasText: 'File verified and ready to download.' }).waitFor({ timeout: 60_000 });
    } catch (error) {
      throw new Error(`browser receive stalled: receiver status "${await page.locator('[data-relay="status"]').textContent()}"; sender status "${await senderStatus()}"`, { cause: error });
    }
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-relay="download"]').click();
    const download = await downloadEvent;
    const path = join(work, `browser-${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(path);
    assert.equal(new URL(page.url()).pathname, '/', 'receiving left the home page');
    await context.close();
    return { name: download.suggestedFilename(), bytes: await readFile(path) };
  }

  // 1. Browser -> browser by typing the code.
  {
    const { context, page, code } = await startSend([singlePath]);
    const received = await receiveInBrowser(browser, (receiver) => receiver.locator('#code-input').fill(code));
    assert.equal(received.name, 'holiday video.mp4');
    assert.equal(sha(received.bytes), sha(single));
    await page.locator('#sender-complete:not(.hidden)').waitFor();
    console.log(`verified browser->browser by typed code: ${received.bytes.length} exact bytes`);
    await context.close();
  }

  // 2. Browser -> cdx receive, several files as one zip.
  {
    const { context, page, code } = await startSend(batchPaths);
    const outDir = join(work, 'zip');
    await mkdir(outDir);
    const receiver = spawn(executable, ['receive', code, '--out', outDir, '--json'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = collect(receiver.stdout);
    const stderr = collect(receiver.stderr);
    assert.equal(await withTimeout(childExit(receiver), 60_000, 'cdx receive did not finish'), 0, await stderr);
    const { path } = JSON.parse(await stdout);
    assert.match(path, /cd-\d{8}-\d{6}\.zip$/);
    execFileSync('unzip', ['-q', path, '-d', join(outDir, 'unzipped')]);
    for (const [name, bytes] of batch) {
      assert.equal(sha(await readFile(join(outDir, 'unzipped', name))), sha(bytes), `${name} differs`);
    }
    await page.locator('#sender-complete:not(.hidden)').waitFor();
    console.log('verified browser->terminal: three files arrive as one exact zip');
    await context.close();
  }

  // 3. Browser -> browser by scanning the QR code with a (fake) camera.
  {
    const { context, page } = await startSend([singlePath]);
    await page.waitForFunction(() => {
      const canvas = document.getElementById('share-qr');
      return canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0;
    });
    const qr = await page.locator('#share-qr').evaluate((canvas) => {
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(data), width, height };
    });
    const decoded = jsQR(Uint8ClampedArray.from(qr.data), qr.width, qr.height);
    assert.match(decoded?.data ?? '', /\/s\/[A-Za-z0-9_-]{22}#v1\./, 'the on-screen QR does not hold the share link');

    const videoPath = join(work, 'qr.y4m');
    await writeFile(videoPath, qrVideo(decoded.data));
    const cameraBrowser = await launch([
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${videoPath}`
    ]);
    const received = await receiveInBrowser(cameraBrowser, async (receiver) => {
      await receiver.locator('#scan-qr-btn').click();
      await receiver.locator('#qr-reader:not(.hidden)').waitFor();
      const box = await receiver.locator('#qr-reader').boundingBox();
      const viewport = receiver.viewportSize();
      assert.ok(box.height <= viewport.height && box.width <= viewport.width, 'scanner does not fit the screen');
    });
    assert.equal(sha(received.bytes), sha(single));
    await page.locator('#sender-complete:not(.hidden)').waitFor();
    console.log('verified browser->browser by scanning the QR code with a camera');
    await context.close();
  }
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  await stopChild(worker);
  await rm(work, { recursive: true, force: true });
}

// qrVideo renders text as a QR code in a short Y4M clip for Chromium's fake
// camera: dark modules on a light field, centered.
function qrVideo(text) {
  const width = 640;
  const height = 480;
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const cell = Math.floor(360 / (modules.size + 8));
  const side = cell * (modules.size + 8);
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const luma = Buffer.alloc(width * height, 200);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const row = Math.floor(y / cell) - 4;
      const column = Math.floor(x / cell) - 4;
      const dark = row >= 0 && column >= 0 && row < modules.size && column < modules.size && modules.get(row, column);
      luma[(top + y) * width + left + x] = dark ? 16 : 235;
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]);
}
