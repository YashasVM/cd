import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

assert.ok(process.argv[2], 'usage: node scripts/bench-incremental-sha256.mjs <baseline-module> [report.json]');
const source = {
  before: await readFile(process.argv[2], 'utf8'),
  after: await readFile('src/incremental-sha256.js', 'utf8')
};
const bytes = randomBytes(16 * 1024 * 1024);
const expected = createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
const report = { method: 'Alternating versions, 7 trials each, 16 MiB identical random input in 256 KiB chunks; Chromium headless hashing only, not transfer throughput', chromium: browser.version(), expected, rows: [] };
try {
  const page = await browser.newPage();
  await page.evaluate(async ({ source, input }) => {
    window.hashes = {};
    for (const [name, text] of Object.entries(source)) window.hashes[name] = (await import('data:text/javascript;base64,' + btoa(text))).IncrementalSHA256;
    window.input = Uint8Array.from(atob(input), x => x.charCodeAt(0));
  }, { source, input: bytes.toString('base64') });
  for (let run = 0; run < 7; run++) for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const result = await page.evaluate(variant => {
      const hash = new window.hashes[variant]();
      const start = performance.now();
      for (let i = 0; i < window.input.length; i += 262144) hash.update(window.input.subarray(i, i + 262144));
      const digest = hash.digestHex();
      return { ms: performance.now() - start, digest };
    }, variant);
    assert.equal(result.digest, expected);
    const row = { run, variant, ...result }; report.rows.push(row); console.log(JSON.stringify(row));
  }
  report.medians = {};
  for (const variant of ['before', 'after']) report.medians[variant] = report.rows.filter(x => x.variant === variant).map(x => x.ms).sort((a, b) => a - b)[3];
  report.speedup = report.medians.before / report.medians.after;
  console.log(JSON.stringify({ medians: report.medians, speedup: report.speedup }));
} finally {
  await writeFile(process.argv[3] ?? '/tmp/cd-sha256-benchmark.json', JSON.stringify(report, null, 2));
  await browser.close();
}
