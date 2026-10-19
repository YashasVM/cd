// Interleaved automatic/direct and forced-relay trials. Run from repository root
// after npm run build. Timing includes download.saveAs and sender completion.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserTransportProbe } from '../../../scripts/bench-metrics.mjs';
import { findChromium, startWorker } from '../../../scripts/harness.mjs';

assert.ok(!process.env.CD_VERIFY_URL, 'This comparison uses local infrastructure');
const work = await mkdtemp(join(tmpdir(), 'cd-browser-speed-'));
const mib = 64;
const runs = 5;
const probe = process.env.CD_COMPARE_PROBE ?? 'full';
assert.ok(['full', 'engine'].includes(probe));
const result = { timestamp: new Date().toISOString(), mib, runs, warmupPairs: 1, probe, workerIsolation: 'one local Worker per pair to bound admission counts', cpu: cpus()[0]?.model, loadBefore: loadavg(), timing: 'receiver code input through download.saveAs and sender complete', trials: [] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let worker, browser;
try {
  const bytes = randomBytes(mib * 1024 * 1024);
  const expected = sha(bytes);
  const source = join(work, 'payload.bin');
  await writeFile(source, bytes);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage', '--enable-precise-memory-info'] });
  result.chromium = browser.version();
  for (let pair = -1; pair < runs; pair++) {
    // Code creation/lookup and both socket joins consume admission budget.
    // Keep all production limits enabled and isolate pairs instead.
    const workerDirectory = join(work, `worker-${pair}`);
    await mkdir(workerDirectory);
    worker = await startWorker(workerDirectory);
    for (const mode of pair % 2 ? ['relay', 'automatic'] : ['automatic', 'relay']) {
      const trial = { pair, mode, warmup: pair < 0, completed: false };
      const context = await browser.newContext({ acceptDownloads: true });
      try {
        if (probe === 'full') await context.addInitScript(browserTransportProbe, { blockDirect: mode === 'relay' });
        else await context.addInitScript(({ blockDirect }) => {
          // Use only existing app counters. No wrapped native send/message calls
          // and no heap sampling, to check the full probe's timing influence.
          window.__CD_TRANSFER_TEST_OBSERVER__ = snapshot => { window.__speedLastTransport = snapshot; };
          delete window.showSaveFilePicker;
          if (blockDirect) window.RTCPeerConnection = function() { throw new Error('Direct blocked for speed comparison'); };
        }, { blockDirect: mode === 'relay' });
        const sender = await context.newPage();
        const receiver = await context.newPage();
        sender.setDefaultTimeout(45000);
        receiver.setDefaultTimeout(45000);
        await sender.goto(worker.publicBase);
        await sender.locator('.workbench:not([inert])').waitFor();
        const readyStart = performance.now();
        await sender.locator('#file-input').setInputFiles(source);
        await sender.locator('#sender-code-section:not(.hidden)').waitFor();
        const code = (await sender.locator('#share-code').textContent()).trim();
        trial.readinessMs = performance.now() - readyStart;
        await receiver.goto(worker.publicBase);
        await receiver.locator('.workbench:not([inert])').waitFor();
        await receiver.locator('#receive-mode-btn').click();
        const downloadEvent = receiver.waitForEvent('download', { timeout: 45000 });
        const start = performance.now();
        await receiver.locator('#code-input').fill(code);
        if (!/^\d{4,5}$/.test(code)) await receiver.locator('#connect-btn').click();
        const download = await downloadEvent;
        trial.downloadReadySeconds = (performance.now() - start) / 1000;
        const destination = join(work, 'received.bin');
        await download.saveAs(destination);
        await sender.locator('#sender-complete:not(.hidden)').waitFor();
        trial.seconds = (performance.now() - start) / 1000;
        assert.equal(sha(await readFile(destination)), expected);
        await rm(destination);
        trial.mibPerSecond = mib / trial.seconds;
        trial.senderStats = await sender.evaluate(probe => probe === 'full' ? window.__benchTransport : window.__speedLastTransport, probe);
        trial.receiverStats = await receiver.evaluate(probe => probe === 'full' ? window.__benchTransport : window.__speedLastTransport, probe);
        const directBytes = probe === 'full' ? trial.senderStats.directPayloadBytes : trial.senderStats.directBytes;
        const relayBytes = probe === 'full' ? trial.senderStats.relayPayloadBytes : trial.senderStats.relayBytes;
        if (mode === 'relay') {
          assert.equal(directBytes, 0);
          assert.ok(relayBytes >= bytes.length);
        } else {
          assert.ok(directBytes >= bytes.length * 0.98, 'automatic trial did not primarily carry data directly');
        }
        trial.completed = true;
      } catch (error) {
        trial.error = error.stack ?? String(error);
        process.exitCode = 1;
      } finally {
        await context.close();
      }
      result.trials.push(trial);
      console.error(JSON.stringify({ ...trial, senderStats: undefined, receiverStats: undefined }));
    }
    await worker.stop();
    worker = null;
  }
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
  result.loadAfter = loadavg();
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}
