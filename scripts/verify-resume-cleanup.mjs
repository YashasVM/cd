import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

// Exercise actual OPFS locking, not a mocked removeEntry error. Serve only this
// blank fixture and the public source modules over isolated loopback HTTP.
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Resume cleanup regression</title>');
    return;
  }
  if (!/^\/src\/[a-z0-9-]+\.js$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL(`..${path}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { createReceiverStage, RESUME_CHUNK_SIZE } = await import('/src/resume-browser.js');
    const { cleanExpiredResumeRecords } = await import('/src/resume-retention.js');
    const { encodeBase64Url } = await import('/src/agent-protocol.js');
    const makeKV = () => {
      const values = new Map();
      return {
        get: async key => values.get(key),
        put: async (key, value) => { values.set(key, structuredClone(value)); },
        delete: async key => { values.delete(key); },
        keys: async () => [...values.keys()]
      };
    };
    const checkpoints = makeKV(), secrets = makeKV();
    const invitation = { id: crypto.getRandomValues(new Uint8Array(16)), key: crypto.getRandomValues(new Uint8Array(32)) };
    const rootId = encodeBase64Url(invitation.id);
    const contents = Uint8Array.of(42);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', contents)), b => b.toString(16).padStart(2, '0')).join('');
    const offer = { name: 'cleanup-fixture.bin', size: '1', chunkSize: RESUME_CHUNK_SIZE, wholeSha256: digest, expiresAt: Date.now() + 60_000 };
    const stage = await createReceiverStage({ invitation, rootId, offer, checkpoints, secrets });
    await stage.append(contents, 'A'.repeat(43));
    const workerURL = URL.createObjectURL(new Blob([`
      let handle;
      onmessage = async ({ data }) => {
        try {
          if (data.release) { handle.close(); postMessage({ released: true }); return; }
          const directory = await navigator.storage.getDirectory();
          const file = await directory.getFileHandle(data.name);
          handle = await file.createSyncAccessHandle();
          postMessage({ locked: true });
        } catch (error) { postMessage({ error: error.name + ': ' + error.message }); }
      };
    `], { type: 'text/javascript' }));
    const worker = new Worker(workerURL);
    const exchange = data => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OPFS lock worker timed out')), 10_000);
      worker.onmessage = event => { clearTimeout(timeout); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage(data);
    });
    try {
      await exchange({ name: stage.stagingId });
      let cancellationError;
      try { await stage.cancel(); } catch (error) { cancellationError = error.name; }
      const key = `receiver:${rootId}`;
      const afterCancel = await checkpoints.get(key);
      await cleanExpiredResumeRecords({ checkpoints, secrets, storage: navigator.storage });
      const retainedWhileLocked = Boolean(await checkpoints.get(key));
      await exchange({ release: true });
      await cleanExpiredResumeRecords({ checkpoints, secrets, storage: navigator.storage });
      let missing = false;
      try { await (await navigator.storage.getDirectory()).getFileHandle(stage.stagingId); }
      catch (error) { missing = error.name === 'NotFoundError'; }
      return { cancellationError, tombstone: afterCancel?.cleanupPending === true, retainedWhileLocked,
        removedAfterUnlock: missing && !(await checkpoints.get(key)) };
    } finally { worker.terminate(); URL.revokeObjectURL(workerURL); }
  });
  assert.equal(result.cancellationError, 'NoModificationAllowedError');
  assert.equal(result.tombstone, true);
  assert.equal(result.retainedWhileLocked, true);
  assert.equal(result.removedAfterUnlock, true);
  console.log('PASS real OPFS exclusive lock: failed cancellation remains retryable; cleanup succeeds after unlock');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
