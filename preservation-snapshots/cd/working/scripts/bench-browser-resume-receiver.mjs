// CLI to actual browser v2 receiver, comparing only receiver storage changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

const runs = Number(process.env.CD_OPFS_PAIR_RUNS ?? 7), mib = Number(process.env.CD_OPFS_PAIR_MIB ?? 32);
assert.ok(Number.isSafeInteger(runs) && runs > 0 && Number.isSafeInteger(mib) && mib > 0 && mib <= 128);
const output = resolve(process.argv[2] ?? 'docs/measurements/transfer-speed-2026-10-26/opfs-receiver-paired.json');
const baselinePath = resolve('docs/measurements/transfer-speed-2026-10-26/resume-browser-before-sync-opfs.js.txt');
const baseline = await readFile(baselinePath, 'utf8'), current = await readFile('src/resume-browser.js', 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceNames = ['agent-protocol', 'resume-protocol', 'incremental-sha256', 'resume-retention', 'sink', 'resume-opfs', 'resume-opfs-worker'];
const sources = Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, await readFile(`src/${name}.js`, 'utf8')])));
const work = await mkdtemp(join(tmpdir(), 'cd-opfs-receiver-'));
const cache = join(homedir(), '.cache');
await mkdir(cache, { recursive: true });
const profile = await mkdtemp(join(cache, 'cd-opfs-receiver-profile-'));
const rows = [], children = new Set();
let worker, context;
const loadBefore = loadavg();
try {
  const payload = randomBytes(mib * 1024 * 1024 + 77), expected = sha(payload), source = join(work, 'payload.bin');
  await writeFile(source, payload);
  const executable = await buildCLI(work);
  process.env.CD_VERIFY_WRANGLER_CONFIG ||= resolve('scripts/bench-worker.wrangler.jsonc');
  worker = await startWorker(work);
  context = await chromium.launchPersistentContext(profile, { executablePath: await findChromium(), headless: true, acceptDownloads: true });
  for (let trial = 0; trial <= runs; trial++) {
    for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      page.on('console', message => { if (message.type() === 'error') console.error('browser console', message.text()); });
      page.on('requestfailed', request => console.error('browser request', request.url(), request.failure()));
      try {
        await page.addInitScript(() => {
          const NativeWorker = Worker;
          globalThis.workerWrites = 0;
          globalThis.workerErrors = [];
          globalThis.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('error', event => globalThis.workerErrors.push(event.message));
            }
            postMessage(...args) {
              if (args[0]?.type === 'write') globalThis.workerWrites++;
              return super.postMessage(...args);
            }
          };
        });
        await context.route('**/assets/opfs-receiver-*.js', route => route.fulfill({ contentType: 'text/javascript', body: mode === 'before' ? baseline : current }));
        const sourceRoute = /\/assets\/(agent-protocol|resume-protocol|incremental-sha256|resume-retention|sink|resume-opfs|resume-opfs-worker)\.js$/;
        await context.route(sourceRoute, route => {
          const name = new URL(route.request().url()).pathname.split('/').at(-1).slice(0, -3);
          return route.fulfill({ contentType: 'text/javascript', body: sources[name] });
        });
        await page.goto(worker.publicBase);
        await page.evaluate(async moduleURL => {
          window.receiverModule = await import(moduleURL);
          window.receiverDB = await receiverModule.openResumeDatabase();
        }, `/assets/opfs-receiver-${trial}-${mode}.js`);
        const child = spawn(executable, ['send', '--resumable', '--json', source], { env: cliEnv(worker, { CD_STATE_DIR: join(work, `state-${trial}-${mode}`) }), stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const captured = captureOutput(child);
        const exit = childExit(child, 60_000);
        exit.catch(() => {});
        const ready = JSON.parse(await firstLine(child.stdout, 30_000));
        assert.match(ready.url, /#v2\./);
        const downloading = page.waitForEvent('download');
        const started = performance.now();
        await page.evaluate(link => {
          const container = document.createElement('div');
          document.body.append(container);
          window.receiving = receiverModule.mountResumableReceiver(container, link, {
            checkpoints: receiverModule.createResumeKV(receiverDB, 'checkpoints'),
            secrets: receiverModule.createResumeKV(receiverDB, 'secrets')
          });
        }, ready.url);
        const result = await page.evaluate(() => receiving.done);
        const milliseconds = performance.now() - started;
        assert.equal(await exit, 0, captured.stderr);
        const destination = join(work, `received-${trial}-${mode}.bin`);
        await (await downloading).saveAs(destination);
        assert.equal(sha(await readFile(destination)), expected);
        assert.equal(result.bytesWritten, payload.length);
        const workerWrites = await page.evaluate(() => globalThis.workerWrites);
        assert.equal(workerWrites, mode === 'after' ? Math.ceil(payload.length / (256 * 1024)) : 0, JSON.stringify(await page.evaluate(() => globalThis.workerErrors)));
        if (trial > 0) rows.push({ mode, trial, bytes: payload.length, milliseconds, workerWrites, mibPerSecond: payload.length / 1048576 / (milliseconds / 1000), sha256: expected });
        console.error(`${mode} #${trial}: ${milliseconds.toFixed(1)}ms, SHA256 verified`);
        await rm(destination);
        await page.evaluate(() => receiverDB.close());
      } finally {
        await page.close();
        await context.unroute('**/assets/opfs-receiver-*.js');
        await context.unroute(/\/assets\/(agent-protocol|resume-protocol|incremental-sha256|resume-retention|sink|resume-opfs|resume-opfs-worker)\.js$/);
      }
    }
  }
  const median = values => { const sorted = values.toSorted((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
  const medians = Object.fromEntries(['before', 'after'].map(mode => [mode, median(rows.filter(row => row.mode === mode).map(row => row.milliseconds))]));
  const report = {
    runs, mib, chromium: context.browser()?.version(), profile, profileFilesystem: await statfs(profile), loadBefore, loadAfter: loadavg(), expected, rows, medians, speedup: medians.before / medians.after,
    hashes: { baseline: sha(baseline), candidate: sha(current), cli: sha(await readFile(executable)), worker: Object.fromEntries(await Promise.all(['worker/index.ts', 'worker/resume-room.ts'].map(async name => [name, sha(await readFile(name))]))), shared: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])) },
    method: 'Actual CLI resumable sender through local v2 Worker to mountResumableReceiver with native OPFS, strict IndexedDB checkpoints, whole-file verification and browser download. Both receiver variants are source modules over identical current shared sources, preimported before timing. Baseline shares the confirmed 4 MiB + 64 KiB / 32-record inbox compatibility fix; storage is the only receiver difference. Sender readiness and source hashing outside timing. Timing starts at receiver mount, ends at verified receiver completion. Download copied and SHA256 checked after timing. Persistent Chromium profile on home filesystem. One warmup pair followed by alternating measured pairs.'
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, medians, speedup: report.speedup }, null, 2));
} finally {
  for (const child of children) await stopChild(child);
  await context?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
