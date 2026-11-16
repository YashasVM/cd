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
  const offers = [], waitingOffers = [], seenOffers = new Set();
  const nextOffer = () => offers.length ? Promise.resolve(offers.shift()) : new Promise(resolve => waitingOffers.push(resolve));
  const receiveOffer = offer => {
    if (seenOffers.has(offer.transferId)) return;
    seenOffers.add(offer.transferId);
    const waiter = waitingOffers.shift();
    if (waiter) waiter(offer); else offers.push(offer);
  };
  const waitForCanceledRecords = async () => {
    await page.waitForFunction(pairId => new Promise((resolve, reject) => {
      const open = indexedDB.open('cd-browser-devices');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const pending = db.transaction('devices').objectStore('devices').get(`pending:${pairId}`);
        pending.onsuccess = () => { db.close(); resolve(pending.result === undefined); };
      };
    }), pair.pairId);
  };
  const connect = async () => {
    socket = new WebSocket(pair.relayUrl); socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        const value = JSON.parse(event.data);
        if (['accepted', 'peer-joined'].includes(value.type)) socket.send(seal({ type: 'paired', name: 'Test Pixel' }));
      } else receiveOffer(open(event.data));
    });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.send(JSON.stringify({ type: 'join', protocol: 'cd-device-v1', role: 'receiver', token: derive('receiver join').toString('base64url') }));
  };
  await connect();
  heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', protocol: 'cd-device-v1' })); }, 20_000);
  await page.getByText('Test Pixel · saved in this browser', { exact: true }).waitFor();
  await page.locator('#start-send-btn').click();
  const canceledOffer = await withTimeout(nextOffer(), 30_000, 'Browser did not offer to the trusted phone');
  await page.locator('#sender-cancel-btn').click();
  await waitForCanceledRecords();
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#start-send-btn').click();
  const offered = await withTimeout(nextOffer(), 30_000, 'Canceled phone send did not restart');
  assert.notEqual(offered.transferId, canceledOffer.transferId, 'a canceled capability must not be reused');
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
  await page.evaluate(({ pairId, link, size }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('cd-browser-devices');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('devices', 'readwrite');
      transaction.objectStore('devices').put({ pending: true, pairId, name: 'phone photo.bin', size, link }, `pending:${pairId}`);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => reject(transaction.error);
    };
  }), { pairId: pair.pairId, link: canceledOffer.url, size: bytes.length });
  await page.getByLabel('Test Pixel · saved in this browser').check();
  await page.locator('#start-send-btn').click();
  const recoveredOffer = await withTimeout(nextOffer(), 30_000, 'Orphaned pending link prevented a fresh phone send');
  assert.notEqual(recoveredOffer.transferId, canceledOffer.transferId);
  await page.locator('#sender-cancel-btn').click();
  await waitForCanceledRecords();
  assert.deepEqual(errors, []);
  console.log('Verified browser QR pairing approval, authenticated phone offer, resumable browser-to-CLI bytes, confirmed delivery, saved device after reload, cancel-and-resend, and orphaned pending-link recovery.');
} finally {
  clearInterval(heartbeat);
  socket?.close();
  await stopChild(receiver);
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
