import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { chromium } from 'playwright-core';
import { buildCLI, startWorker, cliEnv, findChromium, childExit, collect, stopChild, withTimeout } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-browser-devices-'));
let worker, browser, receiver, socket, heartbeat;
try {
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const bytes = randomBytes(700_123);
  const source = join(work, 'phone photo.bin');
  await writeFile(source, bytes);
  await page.goto(worker.publicBase);
  await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('[data-pair]').click();
  await page.locator('[data-device-qr]:not([hidden])').waitFor();
  const pixels = await page.locator('[data-device-qr] canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) }));
  const code = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
  assert.ok(code?.startsWith('cdpair://v1#'));
  const pair = JSON.parse(Buffer.from(code.split('#')[1], 'base64url'));
  const derive = purpose => Buffer.from(hkdfSync('sha256', Buffer.from(pair.secret, 'base64url'), Buffer.from(pair.pairId, 'base64url'), `cd-device-v1 ${purpose}`, 32));
  const seal = value => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derive('receiver messages'), nonce);
    cipher.setAAD(Buffer.from(`cd-device-v1 receiver ${pair.pairId}`));
    return Buffer.concat([nonce, cipher.update(JSON.stringify({ version: 1, messageId: randomBytes(16).toString('base64url'), expiresAt: Date.now() + 60000, ...value })), cipher.final(), cipher.getAuthTag()]);
  };
  const open = data => {
    const frame = Buffer.from(data);
    const decipher = createDecipheriv('aes-256-gcm', derive('sender messages'), frame.subarray(0, 12));
    decipher.setAAD(Buffer.from(`cd-device-v1 sender ${pair.pairId}`));
    decipher.setAuthTag(frame.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]));
  };
  let receivedOffer;
  const offer = new Promise(resolve => { receivedOffer = resolve; });
  const connect = async () => {
    socket = new WebSocket(pair.relayUrl); socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        const value = JSON.parse(event.data);
        if (['accepted', 'peer-joined'].includes(value.type)) socket.send(seal({ type: 'paired', name: 'Test Pixel' }));
      } else receivedOffer(open(event.data));
    });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.send(JSON.stringify({ type: 'join', protocol: 'cd-device-v1', role: 'receiver', token: derive('receiver join').toString('base64url') }));
  };
  await connect();
  heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', protocol: 'cd-device-v1' })); }, 20_000);
  await page.getByText('Test Pixel · saved in this browser', { exact: true }).waitFor();
  await page.locator('#start-send-btn').click();
  const offered = await withTimeout(offer, 30_000, 'Browser did not offer to the trusted phone');
  assert.equal(offered.type, 'offer');
  assert.equal(offered.filename, 'phone photo.bin');
  assert.equal(offered.wholeSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(offered.size, String(bytes.length));
  const destination = join(work, 'received.bin');
  receiver = spawn(executable, ['receive', '--resume', offered.url, '--out', destination], { env: cliEnv(worker), stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collect(receiver.stderr);
  assert.equal(await childExit(receiver, 60_000), 0, await stderr);
  assert.deepEqual(await readFile(destination), bytes);
  socket.send(seal({ type: 'received', transferId: offered.transferId }));
  await page.locator('#sender-complete:not(.hidden)').waitFor();
  assert.match(await page.locator('#sender-complete-message').textContent(), /Delivered to Test Pixel/);
  await page.reload();
  await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(source);
  await page.getByText('Test Pixel · saved in this browser', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified browser QR pairing approval, authenticated phone offer, resumable browser-to-CLI bytes, confirmed delivery, and saved device after reload.');
} finally {
  clearInterval(heartbeat);
  socket?.close();
  await stopChild(receiver);
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
