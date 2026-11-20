// Isolate the checksum stage used by browser multi-file sends.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

assert.ok(process.argv[2], 'usage: node scripts/bench-zip-crc.mjs <baseline-zip-bundle.js> [report.json]');
const sources = {
  before: await readFile(process.argv[2], 'utf8'),
  after: await readFile(new URL('../src/zip-bundle.js', import.meta.url), 'utf8')
};
const payload = randomBytes(16 * 1024 * 1024);
const repeats = 8;
const runs = 7;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let expected = 0;
for (let repeat = 0; repeat < repeats; repeat++) expected = crc32(payload, expected);
const report = {
  method: 'Isolated IEEE CRC32 CPU microbenchmark in Chromium headless. Same preloaded 16 MiB random bytes repeated eight times (128 MiB/trial), incremental 256 KiB blocks, one unmeasured warm-up per version, seven alternating pairs with order reversed per pair. Input conversion/module loading/checksum verification outside timing. No network, file reading, encryption, transfer, storage, or end-to-end speed claim.',
  runs, bytesPerTrial: payload.length * repeats, inputSha256: sha(payload), expectedCRC32: expected,
  sourceSHA256: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])),
  cpu: cpus()[0]?.model, load: loadavg(), node: process.version,
  startedAt: new Date().toISOString(), rows: []
};
let browser;
try {
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
  report.chromium = browser.version();
  const page = await browser.newPage();
  await page.evaluate(async ({ sources, input }) => {
    window.versions = {};
    for (const [name, source] of Object.entries(sources)) window.versions[name] = (await import('data:text/javascript;base64,' + btoa(source))).crc32;
    window.input = Uint8Array.from(atob(input), byte => byte.charCodeAt(0));
  }, { sources, input: payload.toString('base64') });
  for (let run = -1; run < runs; run++) for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const result = await page.evaluate(({ variant, repeats }) => {
      const crc32 = window.versions[variant];
      let crc = 0;
      const started = performance.now();
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (let at = 0; at < window.input.length; at += 262144) crc = crc32(window.input.subarray(at, at + 262144), crc);
      }
      return { milliseconds: performance.now() - started, crc32: crc };
    }, { variant, repeats });
    assert.equal(result.crc32, expected, 'must match independent native zlib CRC32');
    if (run >= 0) {
      const row = { run, variant, ...result, verified: true };
      report.rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  report.medians = {};
  for (const variant of ['before', 'after']) report.medians[variant] = report.rows.filter(row => row.variant === variant).map(row => row.milliseconds).sort((a, b) => a - b)[3];
  report.speedup = report.medians.before / report.medians.after;
  console.log(JSON.stringify({ medians: report.medians, speedup: report.speedup }));
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await browser?.close();
  await writeFile(process.argv[3] ?? '/tmp/cd-zip-crc-benchmark.json', JSON.stringify(report, null, 2) + '\n');
}
