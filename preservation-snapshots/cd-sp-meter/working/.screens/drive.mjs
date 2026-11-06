// Local speedometer check: two Chromium contexts move a payload through a
// local relay while CDP network conditions on the sender change in phases.
// Samples both gauges every 250 ms and screenshots them. Not committed.
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { findChromium, startWorker } from '../scripts/harness.mjs';

const MODE = process.env.MODE ?? 'main'; // main | standalone
const VIEW = process.env.VIEW ?? 'desktop'; // desktop | mobile
const MIB_TOTAL = Number(process.env.MIB ?? 200);
// [seconds from first progress, upload bytes/s or 0 for no throttle, label]
const PHASES = JSON.parse(process.env.PHASES ?? '[[0, 12582912, "12 MiB/s"], [5, 4194304, "4 MiB/s"], [10, 1, "stall"], [17, 26214400, "25 MiB/s"]]');
const SHOTS = JSON.parse(process.env.SHOTS ?? '[[8, "mid"], [16, "stall"]]');
const TAG = process.env.TAG ?? `${MODE}-${VIEW}`;
const OUT = new URL('.', import.meta.url).pathname;

const work = await mkdtemp(join(tmpdir(), 'cd-sp-meter-'));
const payloadPath = join(work, 'holiday-video.mp4');
{
  const file = await open(payloadPath, 'w');
  for (let written = 0; written < MIB_TOTAL; written += 8) await file.write(randomBytes(8 * 1024 * 1024));
  await file.close();
}

const worker = await startWorker(work);
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
const mobile = VIEW === 'mobile';
const contextOptions = {
  viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  isMobile: mobile,
  hasTouch: mobile,
  acceptDownloads: true
};
const log = [];
try {
  const senderContext = await browser.newContext(contextOptions);
  const receiverContext = await browser.newContext(contextOptions);
  await receiverContext.addInitScript(() => { delete window.showSaveFilePicker; });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  for (const page of [sender, receiver]) {
    page.setDefaultTimeout(120_000);
    page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
  }
  const cdp = await senderContext.newCDPSession(sender);
  await cdp.send('Network.enable');
  const throttle = (bytesPerSecond) => cdp.send('Network.emulateNetworkConditions', bytesPerSecond > 0
    ? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  let senderPanel;
  let receiverPanel;
  if (MODE === 'main') {
    await sender.goto(worker.publicBase);
    await sender.locator('.workbench:not([inert])').waitFor();
    await sender.locator('#file-input').setInputFiles(payloadPath);
    await sender.locator('#sender-code-section:not(.hidden)').waitFor();
    const code = (await sender.locator('#share-code').textContent()).trim();
    await receiver.goto(worker.publicBase);
    await receiver.locator('.workbench:not([inert])').waitFor();
    await receiver.locator('#receive-mode-btn').click();
    await receiver.locator('#code-input').fill(code);
    senderPanel = '#sender-progress';
    receiverPanel = '#receiver-relay-panel';
  } else {
    await sender.goto(`${worker.publicBase}/send`);
    await sender.locator('#file-input').setInputFiles(payloadPath);
    await sender.locator('#share-box:not([hidden])').waitFor();
    const link = (await sender.locator('#share-link').textContent()).trim();
    await receiver.goto(link);
    await receiver.locator('[data-relay="accept"]').click();
    senderPanel = '#send-progress';
    receiverPanel = '#relay-receiver';
  }
  const download = receiver.waitForEvent('download', { timeout: 600_000 });
  await throttle(PHASES[0][1]);
  await sender.locator(`${senderPanel} .gauge-dial`).waitFor({ state: 'visible' });
  await receiver.locator(`${receiverPanel} .gauge-dial`).waitFor({ state: 'visible' });
  const started = performance.now();
  let done = false;
  void download.then(() => { done = true; });

  const read = (page, panel) => page.evaluate((panel) => {
    const root = document.querySelector(panel);
    const text = (selector) => root.querySelector(selector)?.textContent.trim() ?? '';
    return {
      value: text('.gauge-value'), unit: text('.gauge-unit'), moved: text('[data-gauge="moved"]'),
      left: text('[data-gauge="left"]'), peak: text('[data-gauge="peak"]'), avg: text('[data-gauge="avg"]'),
      note: text('.gauge-wait'), max: text('.gauge-max')
    };
  }, panel);
  const toMiB = (value, unit) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return unit === 'KB/s' ? number / 1024 : unit === 'GB/s' ? number * 1024 : number;
  };
  const movedMiB = (text) => {
    const match = /^([\d.]+) (B|KB|MB|GB)/.exec(text);
    if (!match) return 0;
    return Number(match[1]) * { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]];
  };

  let phase = 0;
  const shots = [...SHOTS];
  const history = [];
  while (!done) {
    const t = (performance.now() - started) / 1000;
    while (phase + 1 < PHASES.length && t >= PHASES[phase + 1][0]) {
      phase += 1;
      await throttle(PHASES[phase][1]);
    }
    const [s, r] = await Promise.all([read(sender, senderPanel), read(receiver, receiverPanel)]);
    const moved = movedMiB(r.moved);
    history.push([t, moved]);
    const before = history.find(([at]) => at >= t - 1) ?? history[0];
    const truth = t - before[0] > 0.5 ? (moved - before[1]) / (t - before[0]) : null;
    log.push({ t: +t.toFixed(2), phase: PHASES[phase][2], truth1s: truth === null ? null : +truth.toFixed(1),
      sender: toMiB(s.value, s.unit), receiver: toMiB(r.value, r.unit), sText: `${s.value} ${s.unit}`, rText: `${r.value} ${r.unit}`,
      sLeft: s.left, rLeft: r.left, sMax: s.max, sNote: s.note, rNote: r.note, moved: r.moved });
    if (shots.length > 0 && t >= shots[0][0]) {
      const [, name] = shots.shift();
      await sender.screenshot({ path: join(OUT, `${TAG}-sender-${name}.png`), fullPage: true });
      await receiver.screenshot({ path: join(OUT, `${TAG}-receiver-${name}.png`), fullPage: true });
    }
    await delay(250);
  }
  await (await download).path();
  await delay(800);
  await sender.waitForFunction((panel) => {
    const root = document.querySelector(panel);
    return root?.closest('section, .share-panel')?.querySelector('#sender-complete:not(.hidden), [id="again-btn"]:not([hidden])') || document.querySelector('#sender-complete:not(.hidden), #again-btn:not([hidden])');
  }, senderPanel, { timeout: 60_000 });
  await delay(400);
  await sender.screenshot({ path: join(OUT, `${TAG}-sender-done.png`), fullPage: true });
  await receiver.screenshot({ path: join(OUT, `${TAG}-receiver-done.png`), fullPage: true });
  const finish = await Promise.all([
    sender.evaluate(() => document.querySelector('#sender-complete-speed, #progress-copy')?.textContent),
    receiver.evaluate(() => document.querySelector('[data-relay="progress-copy"]')?.textContent)
  ]);
  console.log(JSON.stringify({ finish }));
} finally {
  await browser.close().catch(() => {});
  await worker.stop();
  await rm(work, { recursive: true, force: true });
}
const fs = await import('node:fs/promises');
await fs.writeFile(join(OUT, `${TAG}-log.json`), JSON.stringify(log, null, 1));
for (const row of log.filter((_, index) => index % 2 === 0)) {
  console.log(`${row.t.toFixed(1).padStart(5)}s ${row.phase.padEnd(9)} truth ${String(row.truth1s).padStart(5)}  send ${row.sText.padEnd(10)} recv ${row.rText.padEnd(10)} left ${row.sLeft}/${row.rLeft} ${row.sNote || row.rNote ? '[' + (row.sNote || row.rNote) + ']' : ''}`);
}
