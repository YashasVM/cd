import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from './verify-helpers.mjs';

// Serve only the sample and SDK modules through Playwright on the actual relay origin.
// WebSockets still go to the real Worker, with the browser's unmodified Origin header.
export async function verifyWebExample(origin) {
  const browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.grantPermissions(['local-network-access'], { origin });
    const errors = [];
    await context.route(`${origin}/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (!/^\/(examples\/transfer-web\/(index\.html|main\.js)|packages\/transfer-web\/src\/[a-z0-9-]+\.js)$/.test(path)) return route.continue();
      await route.fulfill({ body: await readFile(new URL(`..${path}`, import.meta.url)), contentType: path.endsWith('.html') ? 'text/html' : 'text/javascript' });
    });
    const sender = await context.newPage(), receiver = await context.newPage();
    for (const page of [sender, receiver]) { page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); await page.goto(`${origin}/examples/transfer-web/index.html`); }
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 731);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await sender.locator('#file').setInputFiles({ name: 'browser.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await sender.locator('#send').click();
    try { await sender.waitForFunction(() => document.getElementById('link').value.includes('#v2.')); }
    catch (error) { throw new Error(`Sender did not become ready: ${await sender.locator('#status').textContent()}; page errors: ${errors.join('; ')}`, { cause: error }); }
    const link = await sender.locator('#link').inputValue();
    await receiver.locator('#link').fill(link);
    const dialog = receiver.waitForEvent('dialog', { timeout: 15000 });
    const clicked = receiver.locator('#receive').click();
    const prompt = await dialog;
    assert.ok(prompt.message().includes('Accept browser.bin'));
    await prompt.accept();
    await clicked;
    await receiver.waitForFunction(() => document.getElementById('status').textContent.startsWith('Verified '));
    await sender.waitForFunction(() => document.getElementById('status').textContent.startsWith('Verified '));
    assert.equal(await receiver.locator('#status').textContent(), await sender.locator('#status').textContent());
    const stored = await receiver.evaluate(async () => Array.from(new Uint8Array(await (await fetch(document.getElementById('download').href)).arrayBuffer())));
    assert.deepEqual(Buffer.from(stored), bytes);
    // The host's Reject button returns null to the SDK, and neither side completes.
    await sender.locator('#send').click();
    await sender.waitForFunction(old => document.getElementById('link').value !== old, link);
    await receiver.locator('#link').fill(await sender.locator('#link').inputValue());
    receiver.once('dialog', prompt => prompt.dismiss());
    await receiver.locator('#receive').click();
    await receiver.waitForFunction(() => document.getElementById('status').textContent === 'rejected');
    await sender.waitForFunction(() => document.getElementById('status').textContent === 'rejected');
    assert.deepEqual(errors, []);
    console.log('PASS Chromium host consent, OPFS exact bytes/hash, sender verification and rejection');
  } finally { await browser.close(); }
}
