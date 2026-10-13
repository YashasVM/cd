// Sends several files with one code in both directions against a running
// site: `cdx send` → browser Receive box, and browser picker → `cdx receive`.
// Each file must arrive on its own, byte for byte.
//
//   CD_BASE=http://127.0.0.1:8787 CDX=./bin/cdx node scripts/verify-multi-file.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = (process.env.CD_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const cdx = resolve(process.env.CDX || './bin/cdx');
const env = {
  ...process.env,
  CD_PUBLIC_URL: base,
  CD_RELAY_URL: base.replace(/^http/, 'ws') + '/ws/v1',
  CD_NO_UPDATE_CHECK: '1'
};

const work = await mkdtemp(join(tmpdir(), 'cd-multi-'));
const source = join(work, 'source');
await mkdir(join(source, 'notes'), { recursive: true });
const files = {
  'report.txt': Buffer.from('quarterly numbers\n'),
  'photo.bin': randomBytes(3 * 1024 * 1024 + 17),
  'notes/todo.md': Buffer.from('- ship multi-file\n')
};
for (const [name, bytes] of Object.entries(files)) await writeFile(join(source, name), bytes);

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cdx, args, { env, cwd: source, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${args.join(' ')}: ${stderr || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Chromium was not found; set CHROMIUM_PATH');
}

const browser = await chromium.launch({ executablePath: await findChromium() });
try {
  // 1. cdx send → browser.
  const code = await run(['send', 'report.txt', 'photo.bin', 'notes']);
  assert.match(code, /^\d{4,5}$/);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.goto(base);
  await page.click('#receive-mode-btn');
  await page.fill('#code-input', code);
  if (await page.locator('#connect-btn').isVisible()) await page.click('#connect-btn').catch(() => {});
  const accept = page.locator('[data-relay="accept"]');
  await Promise.race([
    accept.waitFor({ state: 'visible', timeout: 20_000 }).then(() => accept.click()).catch(() => {}),
    page.locator('.bundle-files li').first().waitFor({ timeout: 20_000 })
  ]);
  await page.locator('.bundle-files li').nth(2).waitFor({ timeout: 30_000 });
  const listed = await page.locator('.bundle-files a').allTextContents();
  assert.deepEqual(listed.sort(), Object.keys(files).sort());
  if (downloads.length === 0) await page.click('[data-relay="download"]');
  for (let waited = 0; downloads.length < 3 && waited < 50; waited += 1) await page.waitForTimeout(100);
  assert.equal(downloads.length, 3, 'browser should download three separate files');
  for (const download of downloads) {
    const name = download.suggestedFilename();
    const original = Object.keys(files).find((path) => path.endsWith(name));
    assert.ok(original, `unexpected download ${name}`);
    assert.deepEqual(await readFile(await download.path()), files[original], name);
  }
  console.log(`ok cdx send → browser: ${downloads.map((download) => download.suggestedFilename()).join(', ')}`);
  await context.close();

  // 2. browser → cdx receive.
  const senderPage = await browser.newPage();
  await senderPage.goto(base);
  await senderPage.setInputFiles('#file-input', Object.keys(files).map((name) => join(source, name)));
  const shareCode = senderPage.locator('#share-code');
  await shareCode.filter({ hasText: /^\d{4,5}$/ }).waitFor({ timeout: 20_000 });
  const browserCode = (await shareCode.textContent()).trim();
  const out = join(work, 'from-browser');
  const result = JSON.parse(await run(['receive', '--json', '--out', out, browserCode]));
  assert.equal(result.files.length, 3);
  for (const [name, bytes] of Object.entries(files)) {
    const flat = name.slice(name.lastIndexOf('/') + 1);
    assert.deepEqual(await readFile(join(out, flat)), bytes, flat);
  }
  console.log(`ok browser → cdx receive: ${result.files.map((file) => file.filename).join(', ')}`);
} finally {
  await browser.close();
}
