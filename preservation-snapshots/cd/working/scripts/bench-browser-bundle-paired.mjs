import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { build as workerBuild } from 'esbuild';
import { chromium } from 'playwright-core';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, stopChild } from './harness.mjs';
import { startDirectRuntime } from './bench-direct-runtime.mjs';

const output = resolve(process.argv[2] || 'docs/measurements/bundle-source-2026-10-26/paired.json');
const baseline = await readFile('docs/measurements/bundle-source-2026-10-26/zip-bundle-before.js.txt', 'utf8');
const candidate = await readFile('docs/measurements/bundle-source-2026-10-26/zip-bundle-candidate.js.txt', 'utf8');
const runs = Number(process.env.CD_BUNDLE_PAIR_RUNS || 7), mib = Number(process.env.CD_BUNDLE_PAIR_MIB || 64);
assert.ok(Number.isInteger(runs) && runs > 0 && Number.isInteger(mib) && mib >= 2);
const work = await mkdtemp(join(tmpdir(), 'cd-bundle-pair-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = [], children = new Set(), frontendHashes = {};
async function assetHashes(directory, prefix = '') {
  const hashes = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await assetHashes(directory, path));
    else hashes[path] = sha(await readFile(join(directory, path)));
  }
  return hashes;
}
let runtime, browser;
try {
  const variants = {};
  for (const [mode, source] of Object.entries({ before: baseline, after: candidate })) {
    const outDir = join(work, mode);
    await viteBuild({ logLevel: 'error', plugins: [{ name: 'frozen-zip-source', enforce: 'pre', load(id) { if (id === resolve('src/zip-bundle.js')) return source; } }], build: { outDir, emptyOutDir: true } });
    variants[mode] = outDir;
    frontendHashes[mode] = await assetHashes(outDir);
  }
  const workerBundle = join(work, 'worker.mjs');
  await workerBuild({ entryPoints: ['worker/index.ts'], outfile: workerBundle, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  runtime = await startDirectRuntime(workerBundle, { compression: false, assets: true });
  const executable = await buildCLI(work);
  const payloads = { 'alpha.bin': randomBytes(Math.floor(mib / 2) * 1048576 + 17), 'beta.bin': randomBytes(Math.ceil(mib / 2) * 1048576 + 29) };
  const hashes = { baseline: sha(baseline), candidate: sha(candidate), worker: sha(await readFile(workerBundle)), receiver: sha(await readFile(executable)), payloads: Object.fromEntries(Object.entries(payloads).map(([name, bytes]) => [name, sha(bytes)])) };
  const sources = [];
  for (const [name, bytes] of Object.entries(payloads)) { const path = join(work, name); await writeFile(path, bytes); sources.push(path); }
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
  for (let trial = 1; trial <= runs; trial++) {
    for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
      const context = await browser.newContext({ permissions: ['local-network-access'] });
      try {
        await context.addInitScript(() => { globalThis.RTCPeerConnection = undefined; });
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== runtime.publicBase || !(url.pathname === '/' || url.pathname.startsWith('/assets/'))) return route.continue();
          const path = join(variants[mode], url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
          const body = await readFile(path);
          const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
          return route.fulfill({ contentType: type, body });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
        page.on('websocket', socket => socket.on('socketerror', error => console.error('WebSocket error', error)));
        await page.goto(runtime.publicBase);
        await page.locator('.workbench:not([inert])').waitFor();
        const selectedAt = performance.now();
        await page.locator('#file-input').setInputFiles(sources);
        await Promise.race([page.locator('#sender-code-section:not(.hidden)').waitFor(), page.locator('#sender-error:not(.hidden)').waitFor().then(async () => { throw new Error(await page.locator('#sender-error').innerText()); })]);
        const readyAt = performance.now();
        const invitation = (await page.locator('#share-code').textContent()).trim();
        assert.match(invitation, /^\d{4,5}$/);
        const destination = join(work, `${mode}-${trial}.zip`);
        const receivingAt = performance.now();
        const child = spawn(executable, ['receive', '--json', invitation, '--out', destination], { env: cliEnv(runtime, { CD_DIRECT: '0', CD_STATE_DIR: join(work, `state-${mode}-${trial}`) }), stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const captured = captureOutput(child);
        assert.equal(await childExit(child, 60_000), 0, captured.stderr);
        const exitedAt = performance.now();
        for (const path of [...Object.keys(payloads).map(name => join(destination, name)), destination, work]) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
        const durableAt = performance.now();
        await page.locator('#sender-complete:not(.hidden)').waitFor();
        const completeAt = performance.now();
        await captured.finished;
        const result = JSON.parse(captured.stdout.trim().split('\n').at(-1));
        assert.equal(result.files.length, Object.keys(payloads).length, 'CLI did not unpack the ZIP');
        for (const [name, expected] of Object.entries(hashes.payloads)) assert.equal(sha(await readFile(join(destination, name))), expected, name);
        rows.push({ mode, trial, bytes: Object.values(payloads).reduce((sum, bytes) => sum + bytes.length, 0), archiveBytes: result.size, readyMs: readyAt - selectedAt, receiverMs: exitedAt - receivingAt, durableMs: durableAt - receivingAt, senderCompleteMs: completeAt - receivingAt, totalMs: durableAt - selectedAt, verified: true });
        console.error(`${mode} ${trial}: ${rows.at(-1).durableMs.toFixed(1)}ms durable, both extracted SHA-256 verified`);
        await rm(destination, { recursive: true });
      } finally { await context.close(); }
    }
  }
  const medians = Object.fromEntries(['before', 'after'].map(mode => [mode, Object.fromEntries(['readyMs', 'durableMs', 'totalMs'].map(metric => { const ordered = rows.filter(row => row.mode === mode).map(row => row[metric]).sort((a, b) => a - b); return [metric, ordered[Math.floor(ordered.length / 2)]]; }))]));
  const report = { version: 1, scenario: 'Two random files, browser UI ZIP to actual CLI, forced uncompressed local relay, same Worker/receiver, native file and directory sync, seven alternating order pairs, fresh browser contexts, actual CLI unzip with exact extracted hashes outside timing', runs, mib, chromium: browser.version(), hashes, frontendHashes, rows, medians, speedup: Object.fromEntries(['readyMs', 'durableMs', 'totalMs'].map(metric => [metric, medians.before[metric] / medians.after[metric]])) };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, medians, speedup: report.speedup }, null, 2));
} finally {
  for (const child of children) await stopChild(child);
  await browser?.close(); await runtime?.stop();
  await rm(work, { recursive: true, force: true });
}
