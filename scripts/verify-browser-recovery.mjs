import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startWorker, findChromium } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-browser-recovery-'));
let worker, browser;
async function records(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('cd-resume-v2');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('checkpoints').objectStore('checkpoints').getAll();
      request.onsuccess = () => { resolve(request.result.filter(record => record.version === 2)); db.close(); };
      request.onerror = () => reject(request.error);
    };
  }));
}
try {
  const bytes = randomBytes(8 * 1024 * 1024 + 123);
  const source = join(work, 'recovery.bin');
  await writeFile(source, bytes);
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  for (const page of [sender, receiver]) { page.setDefaultTimeout(30000); page.on('console', message => { if (message.type() === 'error') console.error(message.text()); }); }
  await sender.addInitScript(() => {
    window.resumeEvents = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); window.transferSocket = this; } };
    window.__CD_RESUME_TEST_OBSERVER__ = event => {
      window.resumeEvents.push(event);
      if (event.role === 'sender' && event.done > 0 && !sessionStorage.interrupted) {
        sessionStorage.interrupted = 'yes';
        window.transferSocket.close(1000, 'verification interruption after ACK');
      }
    };
  });
  await receiver.addInitScript(() => {
    window.resumeEvents = [];
    window.__CD_RESUME_TEST_OBSERVER__ = event => window.resumeEvents.push(event);
  });
  await sender.goto(worker.publicBase);
  await sender.locator('.workbench:not([inert])').waitFor();
  await sender.locator('#file-input').setInputFiles(source);
  await sender.getByLabel('Keep progress if interrupted').check();
  await sender.locator('#start-send-btn').click();
  await sender.locator('#receive-command').filter({ hasText: '#v2.' }).waitFor();
  const command = await sender.locator('#receive-command').textContent();
  const link = command.match(/https?:\/\/[^\s'"]+/)?.[0];
  assert.ok(link, 'private v2 link exposed');
  await receiver.goto(link);
  await sender.waitForFunction(() => sessionStorage.interrupted === 'yes');
  await sender.waitForFunction(() => /interrupted|retry|saved progress/i.test(document.body.innerText));
  const sent = await records(sender);
  const received = await records(receiver);
  assert.ok(sent.some(record => record.offset > 0), `sender checkpoint missing: ${JSON.stringify(sent)}`);
  assert.ok(received.some(record => record.offset > 0), `receiver checkpoint missing: ${JSON.stringify(received)}`);
  console.log('Retained checkpoint offsets:', sent.map(r => r.offset), received.map(r => r.offset));
  await sender.reload();
  await sender.getByLabel('Choose original file for recovery.bin').setInputFiles(source);
  const download = await receiver.waitForEvent('download', { timeout: 60000 }).catch(async error => {
    console.error('Sender UI:', await sender.locator('body').innerText());
    console.error('Receiver UI:', await receiver.locator('body').innerText());
    console.error('Receiver progress:', JSON.stringify(await receiver.evaluate(() => window.resumeEvents)));
    throw error;
  });
  assert.deepEqual(await readFile(await download.path()), bytes, 'download must match every original byte');
  const events = await receiver.evaluate(() => window.resumeEvents);
  assert.ok(events.some(event => event.resumedBytes > 0), `receiver restarted instead of resuming: ${JSON.stringify(events)}`);
  await receiver.getByText('File verified. Download started; check your downloads.', { exact: true }).waitFor();
  await receiver.goto(worker.publicBase);
  await receiver.locator('.workbench:not([inert])').waitFor();
  await receiver.waitForFunction(() => new Promise(resolve => { const open = indexedDB.open('cd-resume-v2'); open.onsuccess = () => { const db = open.result; const request = db.transaction('checkpoints').objectStore('checkpoints').getAll(); request.onsuccess = () => { db.close(); resolve(request.result.filter(record => record.version === 2).length === 0); }; }; }));
  assert.equal((await records(receiver)).length, 0);
  console.log('PASS: ACK interruption, retained checkpoints, original-file recovery UI, resumed bytes, exact download and completion cleanup');
} finally {
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
