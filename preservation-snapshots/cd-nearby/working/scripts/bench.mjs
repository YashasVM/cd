import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildCLI, childExit, cliEnv, collect, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

// Speed is the product, so it gets a number. Measures, on this machine:
//   code    command -> share code on stdout (the agent path, detached send)
//   relay   CLI -> CLI throughput through the relay room
//   p2p     browser -> browser throughput over the WebRTC data channel
//   tunnel  browser -> browser throughput when P2P falls back to the relay
//   legacy  browser -> browser P2P over PeerJS binary framing (what the
//           old cached pages get), for comparison with p2p
// Local by default (loopback: measures CPU and protocol overhead, not the
// network). CD_VERIFY_URL=https://cd.yash0.in measures production.
// CD_BENCH_MIB sets the payload (default 64), CD_BENCH_RUNS the code runs
// (default 5), CD_BENCH_ONLY a comma list of the names above, and
// CD_BENCH_CPU_THROTTLE slows the receiving page's CPU by that factor (4
// approximates a phone).
const cpuThrottle = Number(process.env.CD_BENCH_CPU_THROTTLE ?? 1);
const mib = Number(process.env.CD_BENCH_MIB ?? 64);
const codeRuns = Number(process.env.CD_BENCH_RUNS ?? 5);
const only = new Set((process.env.CD_BENCH_ONLY ?? 'code,relay,p2p,tunnel,legacy').split(','));
const work = await mkdtemp(join(tmpdir(), 'cd-bench-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const results = {};

let worker;
let browser;
try {
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  const env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state') });
  const payload = randomBytes(mib * 1024 * 1024);
  const payloadPath = join(work, 'payload.bin');
  await writeFile(payloadPath, payload);

  if (only.has('code')) {
    const tiny = join(work, 'tiny.txt');
    await writeFile(tiny, 'bench');
    const samples = [];
    for (let run = 0; run < codeRuns; run += 1) {
      const started = performance.now();
      const sender = spawn(executable, ['send', '--wait', tiny], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      await firstLine(sender.stdout, 30_000);
      samples.push(performance.now() - started);
      await stopChild(sender);
    }
    samples.sort((left, right) => left - right);
    results.code = { medianMs: Math.round(samples[Math.floor(samples.length / 2)]), minMs: Math.round(samples[0]), runs: samples.length };
    console.error(`code: ${JSON.stringify(results.code)}`);
  }

  if (only.has('relay')) {
    const outDir = join(work, 'relay-out');
    await mkdir(outDir);
    const sender = spawn(executable, ['send', '--wait', payloadPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const senderExit = childExit(sender, 600_000);
    const senderStderr = collect(sender.stderr);
    const code = await firstLine(sender.stdout, 30_000);
    const started = performance.now();
    const receiver = spawn(executable, ['receive', code, '--out', outDir], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const receiverStderr = collect(receiver.stderr);
    assert.equal(await childExit(receiver, 600_000), 0, await receiverStderr);
    const seconds = (performance.now() - started) / 1000;
    assert.equal(await senderExit, 0, await senderStderr);
    assert.equal(sha(await readFile(join(outDir, 'payload.bin'))), sha(payload));
    results.relay = { mib, seconds: round(seconds), mibPerSecond: round(mib / seconds) };
    console.error(`relay: ${JSON.stringify(results.relay)}`);
  }

  if (only.has('p2p') || only.has('tunnel') || only.has('legacy')) {
    browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
    for (const mode of ['p2p', 'legacy', 'tunnel'].filter((name) => only.has(name))) {
      try {
        results[mode] = await browserTransfer(browser, worker.publicBase, payloadPath, payload, mode);
      } catch (error) {
        results[mode] = { error: error.message.split('\n')[0] };
      }
      console.error(`${mode}: ${JSON.stringify(results[mode])}`);
    }
  }
} finally {
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

const target = process.env.CD_VERIFY_URL ? new URL(process.env.CD_VERIFY_URL).host : 'local wrangler dev';
console.log(`CD bench (${target}, ${mib} MiB payload${cpuThrottle > 1 ? `, receiver CPU ${cpuThrottle}x slower` : ''})`);
console.log('| measurement | result |');
console.log('| --- | --- |');
if (results.code) console.log(`| command -> code (median of ${results.code.runs}) | ${results.code.medianMs} ms (min ${results.code.minMs} ms) |`);
for (const [name, label] of [['relay', 'CLI -> CLI relay'], ['p2p', 'browser -> browser P2P'], ['legacy', 'browser -> browser P2P, PeerJS framing'], ['tunnel', 'browser -> browser relay fallback']]) {
  if (results[name]?.error) console.log(`| ${label} | failed: ${results[name].error} |`);
  else if (results[name]) console.log(`| ${label} | ${results[name].mibPerSecond} MiB/s (${results[name].seconds} s) |`);
}
console.log(JSON.stringify({ target, mib, cpuThrottle, ...results }));

function round(value) {
  return Math.round(value * 100) / 100;
}

// browserTransfer times connect click -> download event for one payload.
async function browserTransfer(browser, baseUrl, payloadPath, payload, mode) {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript((forceRelay) => {
      delete window.showSaveFilePicker;
      if (forceRelay) {
        const NativePeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function RTCPeerConnection(config = {}) {
          return new NativePeerConnection({ ...config, iceTransportPolicy: 'relay' });
        };
        window.RTCPeerConnection.prototype = NativePeerConnection.prototype;
      }
    }, mode === 'tunnel');
    const sender = await context.newPage();
    const receiver = await context.newPage();
    if (mode === 'legacy') {
      // Hide the raw-channel offer from the sender, as old cached pages
      // ignore it: the transfer then uses PeerJS binary framing.
      await sender.routeWebSocket(/\/peerjs\/peerjs/, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => server.send(message));
        server.onMessage((message) => {
          const value = JSON.parse(message);
          if (value.type === 'OFFER' && value.payload?.metadata) {
            delete value.payload.metadata.raw;
            delete value.payload.metadata.window;
          }
          socket.send(JSON.stringify(value));
        });
      });
    }
    if (cpuThrottle > 1) {
      const session = await context.newCDPSession(receiver);
      await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    }
    sender.setDefaultTimeout(60_000);
    receiver.setDefaultTimeout(600_000);
    await sender.goto(baseUrl);
    await sender.locator('.workbench:not([inert])').waitFor();
    await sender.locator('#file-input').setInputFiles(payloadPath);
    await sender.locator('#sender-code-section:not(.hidden)').waitFor();
    const code = (await sender.locator('#share-code').textContent()).trim();
    await receiver.goto(baseUrl);
    await receiver.locator('.workbench:not([inert])').waitFor();
    await receiver.locator('#receive-mode-btn').click();
    await receiver.locator('#code-input').fill(code);
    const downloadEvent = receiver.waitForEvent('download', { timeout: 600_000 });
    const started = performance.now();
    await receiver.locator('#connect-btn').click();
    const download = await downloadEvent;
    const seconds = (performance.now() - started) / 1000;
    const savedPath = join(work, `${mode}.bin`);
    await download.saveAs(savedPath);
    assert.equal(sha(await readFile(savedPath)), sha(payload), `${mode} bytes differ`);
    return { mib, seconds: round(seconds), mibPerSecond: round(mib / seconds) };
  } finally {
    await context.close();
  }
}
