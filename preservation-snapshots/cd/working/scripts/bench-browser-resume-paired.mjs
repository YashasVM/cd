import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, startWorker, stopChild } from './harness.mjs';

// Compares only the browser resumable sender. Both modes share the current
// crypto/hash modules, Worker and durable CLI receiver. Run without competitors.
const output = resolve(process.argv[2] || 'docs/measurements/resume-pipeline-2026-10-26/browser-cli-paired.json');
const baselinePath = resolve('docs/measurements/resume-pipeline-2026-10-26/resume-browser-before.js.txt');
const baseline = await readFile(baselinePath, 'utf8');
const runs = Number(process.env.CD_RESUME_PAIR_RUNS || 7);
const mib = Number(process.env.CD_RESUME_PAIR_MIB || 8);
assert.ok(Number.isInteger(runs) && runs > 0 && Number.isInteger(mib) && mib > 0);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered.length % 2 ? ordered[(ordered.length - 1) / 2] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2; };
const work = await mkdtemp(join(tmpdir(), 'cd-browser-resume-pair-'));
const children = new Set(), rows = [];
let worker, browser;
try {
  const payload = randomBytes(mib * 1024 * 1024 + 77), expectedSha256 = sha(payload);
  const source = join(work, 'payload.bin');
  await writeFile(source, payload);
  const executable = await buildCLI(work);
  process.env.CD_VERIFY_WRANGLER_CONFIG ||= resolve('scripts/bench-worker.wrangler.jsonc');
  worker = await startWorker(work);
  const chromiumPath = await findChromium();
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  const bundle = (await readdir('dist/assets')).find(name => /^resume-browser-.*\.js$/.test(name));
  assert.ok(bundle, 'run npm run build before this benchmark');
  const sources = {};
  for (const name of ['agent-protocol', 'resume-protocol', 'incremental-sha256', 'resume-retention']) sources[name] = await readFile(`src/${name}.js`, 'utf8');
  const hashes = {
    baseline: sha(baseline), candidateBundle: sha(await readFile(`dist/assets/${bundle}`)),
    receiver: sha(await readFile(executable)),
    sharedSources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])),
    worker: Object.fromEntries(await Promise.all(['worker/index.ts', 'worker/resume-room.ts'].map(async path => [path, sha(await readFile(path))])))
  };
  for (let trial = 1; trial <= runs; trial++) {
    for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
      const context = await browser.newContext();
      let intercepted = 0;
      try {
        if (mode === 'before') {
          await context.route('**/assets/resume-browser-*.js', route => { intercepted++; return route.fulfill({ contentType: 'text/javascript', body: baseline }); });
          await context.route(/\/assets\/(agent-protocol|resume-protocol|incremental-sha256|resume-retention)\.js$/, route => {
            const name = new URL(route.request().url()).pathname.split('/').at(-1).slice(0, -3);
            return route.fulfill({ contentType: 'text/javascript', body: sources[name] });
          });
        }
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(worker.publicBase);
        // Load each module graph before timing so interception does not turn
        // the transfer measurement into a module-loading comparison.
        await page.evaluate(async url => { await import(url); }, `${worker.publicBase}/assets/${bundle}`);
        await page.locator('#resumable-check').check();
        const selectedAt = performance.now();
        await page.locator('#file-input').setInputFiles(source);
        await page.locator('#sender-code-section:not(.hidden)').waitFor();
        const readyAt = performance.now();
        const invitation = await page.locator('#share-private-link').getAttribute('href');
        assert.match(invitation, /#v2\./);
        const destination = join(work, `${trial}-${mode}.bin`);
        const receivingAt = performance.now();
        const child = spawn(executable, ['receive', '--json', invitation, '--out', destination], { env: cliEnv(worker, { CD_STATE_DIR: join(work, `state-${trial}-${mode}`) }), stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const captured = captureOutput(child);
        assert.equal(await childExit(child, 60_000), 0, captured.stderr);
        const durableAt = performance.now();
        await page.locator('#sender-complete:not(.hidden)').waitFor();
        const senderCompleteAt = performance.now();
        await captured.finished;
        const receivedSha256 = sha(await readFile(destination));
        assert.equal(receivedSha256, expectedSha256);
        assert.equal(JSON.parse(captured.stdout.trim().split('\n').at(-1)).resumedBytes, 0);
        assert.equal(intercepted, mode === 'before' ? 1 : 0);
        rows.push({ mode, trial, bytes: payload.length, sha256: receivedSha256, readyMs: readyAt - selectedAt, receiverDurableMs: durableAt - receivingAt, senderCompleteMs: senderCompleteAt - receivingAt, selectedToDurableMs: durableAt - selectedAt, baselineIntercepts: intercepted });
        console.error(`${mode} trial ${trial}: receiver durable ${(durableAt - receivingAt).toFixed(1)} ms, SHA-256 verified`);
        await rm(destination);
      } finally { await context.close(); }
    }
  }
  const metrics = ['readyMs', 'receiverDurableMs', 'senderCompleteMs', 'selectedToDurableMs'];
  const medians = Object.fromEntries(['before', 'after'].map(mode => [mode, Object.fromEntries(metrics.map(metric => [metric, median(rows.filter(row => row.mode === mode).map(row => row[metric]))]))]));
  const report = { version: 1, scenario: 'Browser built UI to durable CLI receiver, local Worker relay, random payload, fresh browser context per transfer, seven alternating order pairs, module graphs prewarmed, no artificial latency', runs, payloadBytes: payload.length, sha256: expectedSha256, chromiumPath, chromiumVersion: browser.version(), storagePath: work, hashes, rows, medians, speedup: Object.fromEntries(metrics.map(metric => [metric, medians.before[metric] / medians.after[metric]])) };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, medians, speedup: report.speedup }, null, 2));
} finally {
  for (const child of children) await stopChild(child);
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
