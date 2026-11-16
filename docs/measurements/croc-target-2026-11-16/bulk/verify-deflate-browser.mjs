import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '/workspace/work/cd/node_modules/playwright-core/index.mjs';

const fixtures = JSON.parse(await readFile('/workspace/work/deflate-browser-fixtures.json', 'utf8'));
const rows = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
  const page = await browser.newPage();
  for (const fixture of fixtures) {
    const encoded = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const chunks = [];
      for (let at = 0; at < raw.length; at += 16384) chunks.push(String.fromCharCode(...raw.subarray(at, at + 16384)));
      return btoa(chunks.join(''));
    }, fixture.deflated);
    const actual = Buffer.from(encoded, 'base64'), expected = Buffer.from(fixture.raw, 'base64');
    assert.deepEqual(actual, expected);
    rows.push({ name: fixture.name, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex'), verified: true });
  }
  const report = { method: 'Independent Chromium DecompressionStream(deflate-raw) reads chunks emitted by optimized Go RFC1951 encoder; full byte equality and SHA256. Correctness only, no throughput claim.', chromium: browser.version(), rows };
  await writeFile('/workspace/work/deflate-browser-interop.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
