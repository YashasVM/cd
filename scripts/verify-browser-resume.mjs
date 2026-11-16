import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { sanitizeDiagnostic } from './v2-browser-diagnostics.mjs';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

// Exercises the built UI, native browser storage, and the actual v2 Worker.
const work = await mkdtemp(join(tmpdir(), 'cd-browser-resume-'));
const children = [], contexts = [], measurements = [];
const cpuSessions = new Map();
const payloadSize = Number(process.env.CD_BROWSER_RESUME_BYTES ?? 8 * 1024 * 1024 + 77);
assert.ok(Number.isSafeInteger(payloadSize) && payloadSize > 0);
const payload = process.env.CD_BROWSER_RESUME_INPUT ? await readFile(process.env.CD_BROWSER_RESUME_INPUT) : randomBytes(payloadSize);
assert.equal(payload.length, payloadSize);
const source = join(work, 'payload.bin');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const only = process.env.CD_BROWSER_RESUME_ONLY;
const profiling = process.env.CD_RESUME_PROFILE === '1';
assert.ok(!only || ['browser-cli', 'browser-browser', 'browser-browser-fallback', 'browser-cli-restart', 'cli-browser-same-page-restart'].includes(only));
let worker, browser, cliSHA256;
let failure;
let interrupted = false;
const interrupt = () => { interrupted = true; void browser?.close().catch(() => {}); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
try {
  await writeFile(source, payload);
  const browserOnly = only === 'browser-browser' || only === 'browser-browser-fallback';
  const executable = browserOnly ? null : await buildCLI(work);
  if (executable) cliSHA256 = sha(await readFile(executable));
  worker = await startWorker(work);
  assert.ok(!interrupted, 'verification interrupted');
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
  assert.ok(!interrupted, 'verification interrupted');
  const launch = args => {
    const child = spawn(executable, args, { env: cliEnv(worker, { CD_STATE_DIR: join(work, 'state') }), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return { child, output: captureOutput(child) };
  };
  const page = async (interrupt = false, fallback = false) => {
    const context = await browser.newContext({ acceptDownloads: true });
    contexts.push(context);
    await context.addInitScript(({ fallback, profiling }) => {
      globalThis.__resumeWorkerWrites = 0;
      globalThis.__resumeWorkerWriteBytes = 0;
      globalThis.__resumeMaxWorkerWriteBytes = 0;
      const stats = globalThis.__resumeProfile = {};
      const record = (label, start) => {
        const elapsed = performance.now() - start;
        const stat = stats[label] ??= { calls: 0, ms: 0, maxMs: 0 };
        stat.calls++; stat.ms += elapsed; stat.maxMs = Math.max(stat.maxMs, elapsed);
      };
      if (profiling) {
        const measure = (prototype, method, label = () => method) => {
          if (!prototype?.[method]) return;
          const native = prototype[method];
          prototype[method] = async function(...args) {
            const start = performance.now();
            try { return await native.apply(this, args); }
            finally { record(label(args), start); }
          };
        };
        measure(SubtleCrypto.prototype, 'deriveBits', args => new TextDecoder().decode(args[0].info).endsWith(' checkpoint') ? 'deriveCheckpoint' : 'deriveOther');
        measure(SubtleCrypto.prototype, 'importKey', args => `import:${args[2].name ?? args[2]}`);
        for (const method of ['sign', 'encrypt', 'decrypt']) measure(SubtleCrypto.prototype, method);
        measure(Blob.prototype, 'arrayBuffer', () => 'blobRead');
        for (const method of ['write', 'close']) measure(globalThis.FileSystemWritableFileStream?.prototype, method, () => `stream:${method}`);
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
          const start = performance.now(), result = transaction.call(this, stores, mode, ...args);
          result.addEventListener('complete', () => record(`idb:${mode ?? 'readonly'}:${stores}`, start), { once: true });
          return result;
        };
      }
      if (fallback) { globalThis.Worker = undefined; return; }
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          if (profiling) this.addEventListener('message', () => {
            if (this.profileRequest) record(this.profileRequest.label, this.profileRequest.start);
            this.profileRequest = undefined;
          });
        }
        postMessage(...args) {
          if (args[0]?.type === 'write') {
            globalThis.__resumeWorkerWrites++;
            globalThis.__resumeWorkerWriteBytes += args[0].bytes.byteLength;
            globalThis.__resumeMaxWorkerWriteBytes = Math.max(globalThis.__resumeMaxWorkerWriteBytes, args[0].bytes.byteLength);
          }
          if (profiling) this.profileRequest = { label: `worker:${args[0]?.type}`, start: performance.now() };
          return super.postMessage(...args);
        }
      };
    }, { fallback, profiling });
    if (interrupt) await context.addInitScript(() => {
      const sockets = [];
      const NativeSocket = WebSocket;
      globalThis.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); sockets.push(this); }
      };
      globalThis.__resumeProgress = [];
      globalThis.__CD_RESUME_TEST_OBSERVER__ = value => {
        globalThis.__resumeProgress.push(value);
        if (value.role === 'receiver' && value.done >= 262144 && !globalThis.__resumeInterrupted) {
          globalThis.__resumeInterrupted = true;
          for (const socket of sockets) socket.close(1000, 'test interruption');
        }
      };
    });
    const result = await context.newPage();
    result.setDefaultTimeout(30_000);
    await result.goto(worker.publicBase);
    if (profiling) {
      const session = await context.newCDPSession(result);
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
      cpuSessions.set(result, session);
    }
    return result;
  };
  const send = async (sender, link = '') => {
    if (link) await sender.locator('#sender-retry-btn').click();
    else {
      await sender.goto(worker.publicBase);
      await sender.locator('.workbench:not([inert])').waitFor();
      await sender.locator('#file-input').setInputFiles(source);
      await sender.getByLabel('Keep progress if interrupted').check();
      await sender.locator('#start-send-btn').click();
    }
    try { await sender.locator('#sender-code-section:not(.hidden)').waitFor(); }
    catch (error) {
      throw new Error(`Sender did not publish: ${await sender.locator('#sender-status').textContent()}; ${await sender.locator('#sender-error').textContent()}`, { cause: error });
    }
    const command = await sender.locator('#receive-command').textContent();
    const match = /^cdx receive '(https?:\/\/[^']+)'$/.exec(command.trim());
    assert.ok(match, 'resumable sender must expose a private receive link');
    const invitation = match[1];
    assert.match(invitation, /#v2\./);
    return invitation;
  };
  const complete = sender => sender.locator('#sender-complete:not(.hidden)').waitFor();
  for (const direction of ['browser-cli', 'browser-browser', 'browser-browser-fallback'].filter(value => !only || value === only)) {
    const sender = await page(), started = performance.now();
    const invitation = await send(sender);
    const ready = performance.now();
    const destination = join(work, `${direction}.bin`);
    let receiverPage;
    if (direction === 'browser-cli') {
      const receiver = launch(['receive', '--json', invitation, '--out', destination]);
      assert.equal(await childExit(receiver.child), 0, receiver.output.stderr);
    } else {
      const receiver = await page(false, direction === 'browser-browser-fallback');
      receiverPage = receiver;
      const downloading = receiver.waitForEvent('download', { timeout: 60_000 });
      await receiver.goto(invitation);
      let download;
      try { download = await downloading; await download.saveAs(destination); }
      catch (error) {
        const detail = { error: error.message, download: await download?.failure(), receiver: await receiver.locator('[data-resume-status]').allTextContents(), progress: await receiver.locator('[data-resume-progress]').allTextContents(), sender: await sender.locator('#sender-status, #sender-error').allTextContents() };
        throw new Error(`Download failed: ${sanitizeDiagnostic(JSON.stringify(detail))}`, { cause: error });
      }
      await receiver.locator('[data-resume-status]').filter({ hasText: 'File verified. Download started; check your downloads.' }).waitFor();
      const workerWrites = await receiver.evaluate(() => ({ calls: globalThis.__resumeWorkerWrites, bytes: globalThis.__resumeWorkerWriteBytes, maxBytes: globalThis.__resumeMaxWorkerWriteBytes }));
      if (direction === 'browser-browser-fallback') assert.deepEqual(workerWrites, { calls: 0, bytes: 0, maxBytes: 0 });
      else {
        assert.equal(workerWrites.bytes, payload.length, 'Worker must write every payload byte exactly once');
        assert.ok(workerWrites.calls >= Math.ceil(payload.length / (2 * 1024 * 1024)) && workerWrites.calls <= Math.ceil(payload.length / 262144));
        assert.ok(workerWrites.maxBytes <= 2 * 1024 * 1024, 'Worker writes must stay bounded');
      }
    }
    await complete(sender);
    const completed = performance.now();
    const cpu = {};
    if (profiling) for (const [role, page] of [['sender', sender], ['receiver', receiverPage]]) {
      if (!page) continue;
      const { profile } = await cpuSessions.get(page).send('Profiler.stop');
      for (const node of profile.nodes) node.callFrame.url = node.callFrame.url.split(/[?#]/)[0];
      if (process.env.CD_BROWSER_RESUME_REPORT) await writeFile(`${process.env.CD_BROWSER_RESUME_REPORT}.${direction}.${role}.cpuprofile`, JSON.stringify(profile));
      assert.equal(profile.samples.length, profile.timeDeltas.length);
      const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
      const totals = new Map();
      for (let i = 0; i < profile.samples.length; i++) {
        const frame = nodes.get(profile.samples[i]);
        const key = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
        totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
      }
      cpu[role] = [...totals].map(([frame, selfMs]) => ({ frame, selfMs })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 20);
    }
    const received = await readFile(destination);
    assert.equal(received.length, payload.length);
    assert.equal(sha(received), sha(payload));
    const profile = profiling ? { sender: await sender.evaluate(() => globalThis.__resumeProfile), receiver: await receiverPage?.evaluate(() => globalThis.__resumeProfile), cpu } : undefined;
    measurements.push({ scenario: direction, route: 'v2-relay', relayOrigin: worker.publicBase, bytes: payload.length, sha256: sha(payload), preparationMs: ready - started, transferMs: completed - ready, milliseconds: completed - started, profile });
    console.error(`${direction}: verified ${payload.length} bytes`);
  }
  // A killed receiver retains its durable prefix. The same browser must resume
  // with its persisted sender capability and the original selected file.
  if (!only || only === 'browser-cli-restart') {
    const sender = await page(), invitation = await send(sender);
    const root = new URL(invitation).pathname.split('/').at(-1);
    const destination = join(work, 'restarted.bin');
    const receiver = launch(['receive', '--json', invitation, '--out', destination]);
    const exit = childExit(receiver.child);
    const checkpointPath = join(work, `.cd-${root}.checkpoint.json`);
    let checkpoint;
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch {}
      if (checkpoint?.offset > 0 && checkpoint.offset < payload.length) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(checkpoint?.offset > 0 && checkpoint.offset < payload.length, 'missing incomplete durable prefix');
    receiver.child.kill('SIGKILL');
    await exit;
    checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.equal(checkpoint.prefixSha256, sha(payload.subarray(0, checkpoint.offset)));
    await sender.locator('#sender-status').filter({ hasText: 'Connection interrupted. Reconnecting with saved progress' }).waitFor();
    await sender.locator('#sender-status').filter({ hasText: 'Waiting for the receiver.' }).waitFor();
    const command = await sender.locator('#receive-command').textContent();
    assert.equal(command.trim(), `cdx receive '${invitation}'`);
    const resumed = launch(['receive', '--resume', '--json', invitation, '--out', destination]);
    assert.equal(await childExit(resumed.child), 0, resumed.output.stderr);
    await resumed.output.finished;
    assert.equal(JSON.parse(resumed.output.stdout.trim().split('\n').at(-1)).resumedBytes, checkpoint.offset);
    await complete(sender);
    assert.equal(sha(await readFile(destination)), sha(payload));
    measurements.push({ scenario: 'browser-cli-restart', bytes: payload.length, resumedBytes: checkpoint.offset, sha256: sha(payload) });
  }
  if (!only || only === 'cli-browser-same-page-restart') {
    const receiver = await page(true);
    const sender = launch(['send', '--resumable', '--json', source]);
    const senderExit = childExit(sender.child);
    const ready = JSON.parse(await firstLine(sender.child.stdout));
    const root = new URL(ready.url).pathname.split('/').at(-1);
    await receiver.locator('#receive-mode-btn').click();
    await receiver.locator('#code-input').fill(ready.url);
    await receiver.waitForFunction(() => globalThis.__resumeInterrupted);
    await senderExit;
    await receiver.locator('[data-resume-status]').filter({ hasText: /interrupt|disconnect/i }).waitFor();
    const savedOffset = await receiver.evaluate(root => new Promise((resolve, reject) => {
      const request = indexedDB.open('cd-resume-v2', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('checkpoints').objectStore('checkpoints').get(`receiver:${root}`);
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result.offset); };
      };
    }), root);
    assert.ok(savedOffset > 0 && savedOffset < payload.length);
    const priorWorkerBytes = await receiver.evaluate(() => globalThis.__resumeWorkerWriteBytes);
    await receiver.locator('#relay-done-btn').click();
    const resumed = launch(['send', '--resume', root, '--json', source]);
    const resumedExit = childExit(resumed.child);
    const nextReady = JSON.parse(await firstLine(resumed.child.stdout));
    assert.equal(nextReady.url, ready.url);
    const downloading = receiver.waitForEvent('download', { timeout: 60_000 });
    await receiver.locator('#code-input').fill(ready.url);
    const destination = join(work, 'browser-same-page-restart.bin');
    try { await (await downloading).saveAs(destination); }
    catch (error) {
      throw new Error(sanitizeDiagnostic(`Same-page receive stalled: ${await receiver.locator('[data-resume-status]').textContent()}; sender: ${resumed.output.stderr}`), { cause: error });
    }
    assert.equal(await resumedExit, 0, resumed.output.stderr);
    await receiver.locator('[data-resume-status]').filter({ hasText: 'File verified. Download started; check your downloads.' }).waitFor();
    assert.equal(sha(await readFile(destination)), sha(payload));
    const observedOffset = await receiver.evaluate(() => globalThis.__resumeProgress.filter(value => value.role === 'receiver').at(-1).resumedBytes);
    assert.equal(observedOffset, savedOffset);
    const resumedWorkerBytes = await receiver.evaluate(() => globalThis.__resumeWorkerWriteBytes);
    assert.equal(resumedWorkerBytes - priorWorkerBytes, payload.length - savedOffset, 'Worker must write exactly the remaining resumed bytes');
    measurements.push({ scenario: 'cli-browser-same-page-restart', bytes: payload.length, resumedBytes: savedOffset, sha256: sha(payload) });
  }
  console.log(JSON.stringify({ version: 1, completed: measurements.length, measurements }, null, 2));
} catch (error) {
  failure = error.stack;
  throw error;
} finally {
  try {
    if (process.env.CD_BROWSER_RESUME_REPORT) await writeFile(process.env.CD_BROWSER_RESUME_REPORT, JSON.stringify({
      version: 1, profiling, chromium: browser?.version(), cliSHA256, temporaryStorage: tmpdir(), bytes: payload.length, sha256: sha(payload),
      assets: process.env.CD_VERIFY_ASSET_DIR ?? null, measurements, failure,
      method: 'One Chromium host; v2 relay origin recorded per measurement. OPFS commits preserved. OS cache allowed. Timing ends at download save and sender completion; full output digest checked outside timing. Profiling adds overhead; async operation latency totals can overlap and are not CPU time. No physical disk durability, LAN or WAN speed claim.'
    }, null, 2) + '\n');
  } finally {
    for (const child of children) await stopChild(child);
    for (const context of contexts) await context.close();
    await browser?.close();
    await worker?.stop();
    await rm(work, { recursive: true, force: true });
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
  }
}
