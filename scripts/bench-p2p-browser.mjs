// Real browser product comparison. Uses the public ToffeeShare service, never a reimplementation.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, startWorker } from './harness.mjs';
import { trialOrder } from './bench-order.mjs';

export function routeObserved(stats) {
  const pairs = stats.peers.flatMap(peer => peer.selectedPairs || []);
  if (!pairs.length) return 'unconfirmed';
  const relayed = pairs.some(pair => pair.localType === 'relay' || pair.remoteType === 'relay');
  const direct = pairs.some(pair => ['host', 'srflx', 'prflx'].includes(pair.localType) && ['host', 'srflx', 'prflx'].includes(pair.remoteType));
  return relayed && direct ? 'mixed-ice' : relayed ? 'turn' : direct ? 'direct-webrtc' : 'unconfirmed';
}

export function classifyPayloadRoute(stats, inputBytes) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) return 'unconfirmed';
  // Byte counts and selected ICE candidates must belong to the same peer.
  // A separate control-only direct peer cannot establish the file's route.
  const payloadPeers = stats.peers.filter(peer => [peer.dataChannelSentBytes, peer.dataChannelReceivedBytes].some(bytes => Number.isFinite(bytes) && bytes >= inputBytes));
  return routeObserved({ peers: payloadPeers });
}

function median(values) { const sorted = values.toSorted((a, b) => a - b), i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; }
export function summarize(report) {
  const tools = {};
  const validInput = Number.isSafeInteger(report.input?.bytes) && report.input.bytes > 0 && /^[a-f0-9]{64}$/.test(report.input?.sha256 || '');
  for (const tool of ['cd', 'toffeeshare']) {
    const rows = report.rows.filter(row => row.tool === tool);
    const valid = rows.filter(row => validInput && row.ok && row.received?.sha256 === report.input.sha256 && row.received?.bytes === report.input.bytes && ['readyMs', 'receiveMs', 'totalMs'].every(key => Number.isFinite(row[key]) && row[key] > 0));
    const complete = rows.length === report.runs && valid.length === report.runs && new Set(valid.map(row => row.run)).size === report.runs && valid.every(row => Number.isSafeInteger(row.run) && row.run >= 0 && row.run < report.runs);
    tools[tool] = { status: !rows.length ? 'not_run' : complete ? 'measured' : 'incomplete', successful: valid.length, attempted: rows.length,
      routes: [...new Set(rows.map(row => row.route || 'unconfirmed'))],
      medians: complete ? Object.fromEntries(['readyMs', 'receiveMs', 'totalMs'].map(key => [key, median(valid.map(row => row[key]))])) : null,
      spread: complete ? Object.fromEntries(['readyMs', 'receiveMs', 'totalMs'].map(key => [key, { min: Math.min(...valid.map(row => row[key])), max: Math.max(...valid.map(row => row[key])) }])) : null };
  }
  const complete = !report.error && !report.interrupted && Object.values(tools).every(tool => tool.status === 'measured');
  return { complete, repeatedComparison: complete && report.runs >= 5, tools,
    toffeeOverCd: complete ? Object.fromEntries(['readyMs', 'receiveMs', 'totalMs'].map(key => [key, tools.toffeeshare.medians[key] / tools.cd.medians[key]])) : null,
    fastestWorldwideProven: false,
    scope: 'Two Chromium processes on one host; product defaults, same random file and browser. CD and ToffeeShare signaling/relay paths may differ. No WAN, cross-device, loss, concurrency or worldwide ranking follows. Ratios compare medians, not statistical confidence intervals.' };
}

// Identical, read-only transport instrumentation in both products. Preserve the
// last selected candidate pair before the application closes its connection.
function observeTransport() {
  const stats = { peers: [], dataChannelSentBytes: 0, dataChannelReceivedBytes: 0, webSocketSentBytes: 0, webSocketReceivedBytes: 0 };
  const peers = [];
  const connectionRecords = new WeakMap(), channelRecords = new WeakMap();
  const byteLength = data => typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength ?? data.size ?? 0;
  const NativePeer = window.RTCPeerConnection;
  const watch = (connection, channel) => {
    const record = connectionRecords.get(connection);
    channelRecords.set(channel, record);
    channel.addEventListener('message', event => {
      const bytes = byteLength(event.data);
      stats.dataChannelReceivedBytes += bytes;
      if (record) record.dataChannelReceivedBytes += bytes;
    });
  };
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      const record = { states: [], candidateTypes: [], selectedPairs: [], dataChannelSentBytes: 0, dataChannelReceivedBytes: 0 };
      connectionRecords.set(this, record);
      stats.peers.push(record); peers.push({ connection: this, record });
      this.addEventListener('icecandidate', event => { if (event.candidate) record.candidateTypes.push(event.candidate.type); });
      this.addEventListener('connectionstatechange', () => { record.states.push(this.connectionState); void snapshot(); });
      this.addEventListener('datachannel', event => watch(this, event.channel));
    }
    createDataChannel(...args) { const channel = super.createDataChannel(...args); watch(this, channel); return channel; }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function(data) {
    const result = send.call(this, data), bytes = byteLength(data);
    stats.dataChannelSentBytes += bytes;
    const record = channelRecords.get(this);
    if (record) record.dataChannelSentBytes += bytes;
    return result;
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); this.addEventListener('message', event => { if (typeof event.data !== 'string') stats.webSocketReceivedBytes += byteLength(event.data); }); }
    send(data) { const result = super.send(data); if (typeof data !== 'string') stats.webSocketSentBytes += byteLength(data); return result; }
  };
  async function snapshot() {
    for (const { connection, record } of peers) {
      try {
        const items = await connection.getStats();
        const pairs = [...items.values()].filter(item => item.type === 'candidate-pair' && (item.nominated || item.selected) && item.state === 'succeeded');
        if (pairs.length) record.selectedPairs = pairs.map(item => ({ bytesSent: item.bytesSent, bytesReceived: item.bytesReceived, currentRoundTripTime: item.currentRoundTripTime,
          localType: items.get(item.localCandidateId)?.candidateType, remoteType: items.get(item.remoteCandidateId)?.candidateType, protocol: items.get(item.localCandidateId)?.protocol }));
      } catch {}
    }
    return stats;
  }
  window.__p2pBenchmarkSnapshot = snapshot;
  setInterval(() => { void snapshot(); }, 250);
}

async function digest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
const redact = value => String(value).replace(/https:\/\/toffeesha\.re\/c\/[^\s"')]+/g, 'https://toffeesha.re/c/<code>');
async function bounded(promise, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('download completion timed out')), timeout); })]); }
  finally { clearTimeout(timer); }
}

export async function main() {
  if (process.argv.includes('--help')) {
    console.log(`npm run build && node scripts/bench-p2p-browser.mjs
Environment: CD_P2P_MIB=16 CD_P2P_RUNS=5 CD_P2P_TIMEOUT_MS=60000
CD_P2P_OUTPUT=/absolute/report.json CD_P2P_SEED=recorded-seed
CD_P2P_TOOLS=cd,toffeeshare (subset for diagnostic smoke only)
CD_VERIFY_URL=https://your-staging-site (otherwise local Worker)
Public ToffeeShare is always the real service. Defaults/fallbacks are unchanged.
Two separate Chromium processes; fresh contexts per row. Sender page preloaded.
readyMs: file selection through usable code/link. receiveMs: receiver navigation
through download.saveAs. totalMs: file selection through saved output, excluding
hash verification. Output cache allowed; no fsync durability claim. Failures stay
in JSON and cause exit 1. Direct routing requires observed ICE telemetry.
For publishable comparisons use >=5 repetitions, more payloads, actual endpoints
and uncongested hosts; same-host results cannot establish the world's fastest.`);
    return;
  }
  const mib = Number(process.env.CD_P2P_MIB || 16), runs = Number(process.env.CD_P2P_RUNS || 5), timeout = Number(process.env.CD_P2P_TIMEOUT_MS || 60000);
  for (const value of [mib, runs, timeout]) assert.ok(Number.isSafeInteger(value) && value > 0);
  const tools = (process.env.CD_P2P_TOOLS || 'cd,toffeeshare').split(',');
  assert.ok(tools.length > 0 && new Set(tools).size === tools.length && tools.every(tool => ['cd', 'toffeeshare'].includes(tool)));
  const output = resolve(process.env.CD_P2P_OUTPUT || 'p2p-browser-results.json');
  const seed = process.env.CD_P2P_SEED || randomBytes(16).toString('hex');
  const work = await mkdtemp(join(tmpdir(), 'cd-p2p-browser-'));
  const report = { schema: 1, startedAt: new Date().toISOString(), runs, mib, seed, tools, rows: [],
    source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), runnerSha256: (await digest(fileURLToPath(import.meta.url))).sha256 },
    environment: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model, cores: cpus().length, node: process.version, initialLoad: loadavg() },
    method: { order: 'seeded randomized blocks', topology: 'two browser processes on one host; public ToffeeShare; CD endpoint recorded below',
      ready: 'preloaded sender file selection through usable share code/link', receive: 'receiver navigation through completed download.saveAs', total: 'sender file selection through saved receiver output; SHA256 verification outside timing',
      verification: 'full output byte count and SHA256 equality per trial', durability: 'no fsync; output page cache allowed', defaults: 'product defaults including transport fallback; CD explicitly selects numeric code flow' } };
  const browsers = []; let worker;
  let interrupted = false;
  const stop = () => { interrupted = true; void Promise.allSettled(browsers.map(browser => browser.close())); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const save = async () => { report.summary = summarize(report); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  try {
    const input = join(work, 'payload.bin'), file = await open(input, 'wx');
    try { for (let i = 0; i < mib; i++) await file.writeFile(randomBytes(1048576)); } finally { await file.close(); }
    report.input = await digest(input);
    if (tools.includes('cd')) { worker = await startWorker(work); report.cdEndpoint = worker.publicBase; }
    const executablePath = await findChromium(); report.chromiumExecutable = { path: executablePath, ...await digest(executablePath) };
    for (let i = 0; i < 2; i++) browsers.push(await chromium.launch({ executablePath, headless: true }));
    report.chromiumVersions = browsers.map(browser => browser.version());
    for (let run = 0; run < runs; run++) {
      const order = trialOrder(tools, seed, run);
      for (const tool of order) {
        if (interrupted) throw new Error('benchmark interrupted');
        const row = { tool, run, order, position: order.indexOf(tool), ok: false, load: loadavg(), pageErrors: [], requestErrors: [], scriptAssets: [] };
        const contexts = [], pages = [], assets = [];
        try {
          for (const browser of browsers) { const context = await browser.newContext({ acceptDownloads: true }); contexts.push(context); await context.addInitScript(observeTransport); pages.push(await context.newPage()); }
          const [sender, receiver] = pages;
          for (const [role, page] of [['sender', sender], ['receiver', receiver]]) {
            page.setDefaultTimeout(timeout);
            page.on('pageerror', error => row.pageErrors.push({ role, message: redact(error.message) }));
            page.on('requestfailed', request => row.requestErrors.push({ role, host: new URL(request.url()).hostname, error: request.failure()?.errorText }));
            page.on('response', response => {
              if (response.request().resourceType() !== 'script') return;
              const url = new URL(response.url());
              if (!['toffeeshare.com', 'toffeesha.re', new URL(worker?.publicBase || 'http://localhost').hostname].includes(url.hostname)) return;
              assets.push(response.body().then(body => row.scriptAssets.push({ role, host: url.hostname, path: url.pathname, status: response.status(), sha256: createHash('sha256').update(body).digest('hex') })).catch(() => {}));
            });
          }
          const base = tool === 'cd' ? worker.publicBase : 'https://toffeeshare.com/';
          await sender.goto(base, { waitUntil: 'domcontentloaded', timeout });
          await sender.locator(tool === 'cd' ? '.workbench:not([inert])' : 'input[type=file]').waitFor({ state: 'attached' });
          let code, shareLink;
          const start = performance.now();
          if (tool === 'cd') {
            await sender.locator('#file-input').setInputFiles(input);
            await sender.getByLabel('Sharing method').selectOption('code'); await sender.locator('#start-send-btn').click();
            await sender.locator('#sender-code-section:not(.hidden)').waitFor(); code = (await sender.locator('#share-code').textContent()).trim(); assert.match(code, /^\d{4,5}$/);
          } else {
            await sender.locator('input[type=file]').setInputFiles(input);
            await sender.waitForFunction(() => [...document.querySelectorAll('input[type=text]')].some(element => /^https:\/\/toffeesha\.re\/c\//.test(element.value)), null, { timeout });
            shareLink = await sender.locator('input[type=text]').inputValue(); assert.match(shareLink, /^https:\/\/toffeesha\.re\/c\/[A-Za-z0-9_-]+$/);
          }
          row.readyMs = performance.now() - start;
          const receiveStart = performance.now(), downloaded = receiver.waitForEvent('download', { timeout }); downloaded.catch(() => {});
          if (tool === 'cd') {
            await receiver.goto(base, { waitUntil: 'domcontentloaded', timeout }); await receiver.locator('#receive-mode-btn').click(); await receiver.locator('#code-input').fill(code);
          } else {
            await receiver.goto(shareLink, { waitUntil: 'domcontentloaded', timeout }); await receiver.locator('a.button.on-white').filter({ hasText: /^Download$/ }).click();
          }
          const download = await downloaded;
          row.downloadEventMs = performance.now() - receiveStart;
          const target = join(work, 'received.bin'); await bounded(download.saveAs(target), timeout);
          row.receiveMs = performance.now() - receiveStart; row.totalMs = performance.now() - start;
          row.received = await digest(target); assert.deepEqual(row.received, report.input, 'received file does not match source'); await rm(target);
          row.mibPerSecond = mib / (row.receiveMs / 1000); row.ok = true;
        } catch (error) { row.error = redact(error.message); }
        finally {
          row.transport = await Promise.all(pages.map(page => page.evaluate(() => window.__p2pBenchmarkSnapshot?.()).catch(() => null)));
          const peers = row.transport.filter(Boolean).flatMap(item => item.peers);
          row.iceRoute = routeObserved({ peers });
          // An ICE handshake alone does not prove that the file used WebRTC.
          row.route = classifyPayloadRoute({ peers }, report.input?.bytes);
          await Promise.allSettled(assets);
          for (const context of contexts) await context.close();
        }
        report.rows.push(row); await save(); console.log(JSON.stringify({ tool, run, ok: row.ok, route: row.route, receiveMs: row.receiveMs, error: row.error }));
      }
    }
  } catch (error) { report.error = redact(error.message); }
  finally {
    for (const browser of browsers) await browser.close(); await worker?.stop(); await rm(work, { recursive: true, force: true });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    report.finishedAt = new Date().toISOString(); report.interrupted = interrupted; await save();
  }
  if (report.error || report.rows.length !== tools.length * runs || report.rows.some(row => !row.ok)) process.exitCode = 1;
  console.log(JSON.stringify({ output, summary: report.summary }));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
