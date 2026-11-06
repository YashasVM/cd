// CD_SHA256_BASELINE=/path/to/before.js node scripts/bench-incremental-sha256.mjs
// CPU-only benchmark of the browser's resumable-transfer hashing, not network throughput.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

const runs = Number(process.env.CD_SHA256_RUNS ?? 7);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
const sources = { current: await readFile(new URL('../src/incremental-sha256.js', import.meta.url), 'utf8') };
if (process.env.CD_SHA256_BASELINE) sources.before = await readFile(process.env.CD_SHA256_BASELINE, 'utf8');
const chunk = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
const reference = createHash('sha256');
for (let i = 0; i < 128; i++) reference.update(chunk);
const expected = reference.digest('hex');
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const trials = await page.evaluate(async ({ sources, runs, expected }) => {
    const modules = {};
    for (const [name, code] of Object.entries(sources)) {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { modules[name] = await import(url); } finally { URL.revokeObjectURL(url); }
    }
    const chunk = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
    const results = [];
    const names = Object.keys(modules);
    for (let run = -1; run < runs; run++) {
      // Alternate the execution order to limit drift between baseline and current.
      for (const name of run % 2 ? [...names].reverse() : names) {
        const hash = new modules[name].IncrementalSHA256();
        const start = performance.now();
        for (let i = 0; i < 128; i++) hash.update(chunk);
        if (hash.digestHex() !== expected) throw new Error(`${name} SHA-256 mismatch`);
        const milliseconds = performance.now() - start;
        if (run >= 0) results.push({ name, run, milliseconds, mibPerSecond: 32 / (milliseconds / 1000) });
      }
    }
    return results;
  }, { sources, runs, expected });
  console.log(JSON.stringify({ chromium: browser.version(), payloadMiB: 32, chunkBytes: chunk.length, runs, verified: true, expected, trials }, null, 2));
} finally {
  await browser.close();
}
