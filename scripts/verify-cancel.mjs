// Browser regression for cancellation while receiver sink initialization is pending.
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const baseUrl = process.env.CD_VERIFY_URL;
if (!baseUrl) throw new Error('Set CD_VERIFY_URL to a running cd instance');
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const work = await mkdtemp(join(tmpdir(), 'cd-verify-cancel-'));
const sourcePath = join(work, 'cancel.bin');
await writeFile(sourcePath, Buffer.alloc(128 * 1024, 23));
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(() => {
  delete window.showSaveFilePicker;
  const original = navigator.storage.getDirectory.bind(navigator.storage);
  window.__restoreOPFS = () => { navigator.storage.getDirectory = original; };
  navigator.storage.getDirectory = () => {
    window.__opfsPending = true;
    return new Promise((_, reject) => { window.__releaseOPFS = () => reject(new Error('released')); });
  };
});
try {
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await sender.goto(baseUrl);
  await sender.locator('#file-input').setInputFiles(sourcePath);
  await sender.locator('#sender-code-section:not(.hidden)').waitFor();
  const code = (await sender.locator('#share-code').textContent()).trim();
  await receiver.goto(baseUrl);
  await receiver.locator('#receive-mode-btn').click();
  await receiver.locator('#code-input').fill(code);
  await receiver.locator('#connect-btn').click();
  await receiver.waitForFunction(() => window.__opfsPending === true);
  await receiver.locator('#receiver-cancel-btn').click();
  await receiver.evaluate(() => { window.__releaseOPFS?.(); window.__restoreOPFS?.(); });
  await receiver.locator('#receiver-input-section:not(.hidden)').waitFor();
  assert.equal(await receiver.locator('#receiver-error').isVisible(), false);
  console.log('verified receiver cancellation during sink initialization');
} finally {
  await context.close();
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
