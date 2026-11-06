#!/usr/bin/env node
// Transfer-speed benchmark: repeated, interleaved, hash-verified trials of the
// real CLI and browser flows through a local relay, with optional latency and
// bandwidth shaping and per-route byte accounting.
//
//   node scripts/bench-speed.mjs                        all scenarios, 64+256 MiB, 5 trials
//   node scripts/bench-speed.mjs --scenarios cli-relay,browser-relay --sizes 64 --rtt 0,100
//   node scripts/bench-speed.mjs --help
//
// Self-contained: needs only scripts/harness.mjs and playwright-core, so it
// can be copied into any branch. It builds the CLI and the web app of the
// checkout it runs in (cwd is moved to the repo root), starts `wrangler dev`,
// and reports from that tree.
//
// Scenarios
//   cli-relay             cdx send -> cdx receive, CD_DIRECT=0 (relay only)
//   cli-auto              cdx send -> cdx receive, default routing (direct + stripe)
//   browser-relay         main-page Send flow -> main-page Receive tab (code typed in)
//   browser-to-cli        main-page Send flow -> cdx receive
//   cli-to-browser        cdx send (default routing) -> main-page Receive tab
//   cli-to-browser-relay  cdx send with CD_DIRECT=0 -> main-page Receive tab
//
// Timing, per trial (all on one machine clock, milliseconds):
//   transfer     receiver join (spawn `cdx receive`, or typing the code into the
//                page) -> the file is complete on disk. For the browser that is
//                the finished download (Playwright download.path()), not the
//                download event. This is the MiB/s that is reported.
//   shareCode    sender start (spawn, or choosing the file) -> code visible.
//   firstPayload receiver join -> first CHUNK record delivered to the receiver
//                by the relay. Null if no chunk crossed the relay.
//   senderDone   receiver join -> the sender reports the transfer complete. A
//                sender that does not complete counts as a failed trial.
// Every received file is SHA-256 verified (streamed) against the payload; a
// mismatch is a failed trial and counts against the completion rate.
//
// Route accounting: every client talks to the relay through a local proxy
// (disable with --no-proxy). The proxy parses WebSocket frames and the
// plaintext 12-byte record headers, so it counts the unique CHUNK sequence
// numbers the relay delivered. relayFraction = unique relay chunks / expected
// chunks; the rest travelled over WebRTC. Replays (duplicate sequence
// numbers) are counted separately.
//
// Shaping (--rtt, --mbit): applied by the same proxy to WebSocket traffic and
// /api/* requests only, never to static assets. --rtt is the added sender <->
// receiver round trip through the relay: each client link gets rtt/4 each way,
// so a payload record plus its ACK picks up exactly `rtt`. --mbit caps each
// client link, per direction. This does NOT shape WebRTC/UDP: the direct path
// of cli-auto and cli-to-browser runs at full loopback speed regardless.
//
// Machine noise: each trial records the 1-minute load average before/after and
// the system-wide CPU busy percentage during the trial (includes this
// benchmark's own processes). Compare branches with interleaved runs, not by
// absolute numbers.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomFillSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildCLI, childExit, cliEnv, findChromium, firstLine, run, startWorker, stopChild } from './harness.mjs';

const MIB = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);

const SCENARIOS = {
  'cli-relay': { sender: 'cli', receiver: 'cli', direct: false, text: 'CLI -> CLI, relay only (CD_DIRECT=0)' },
  'cli-auto': { sender: 'cli', receiver: 'cli', direct: true, text: 'CLI -> CLI, default routing (direct + stripe)' },
  'browser-relay': { sender: 'browser', receiver: 'browser', text: 'browser page -> browser page via code' },
  'browser-to-cli': { sender: 'browser', receiver: 'cli', text: 'browser page -> cdx receive' },
  'cli-to-browser': { sender: 'cli', receiver: 'browser', direct: true, text: 'cdx send (default routing) -> browser page' },
  'cli-to-browser-relay': { sender: 'cli', receiver: 'browser', direct: false, text: 'cdx send (CD_DIRECT=0) -> browser page' }
};

const USAGE = `usage: node scripts/bench-speed.mjs [options]

options (each also reads the CD_BENCH_* variable shown; flags win):
  --scenarios a,b   ${Object.keys(SCENARIOS).join(',')}   (CD_BENCH_SCENARIOS)
  --sizes 64,256    payload sizes in MiB                    (CD_BENCH_SIZES, default 64,256)
  --trials 5        measured trials per scenario and cell   (CD_BENCH_TRIALS)
  --warmup 1        unmeasured trials per scenario and cell (CD_BENCH_WARMUP)
  --rtt 0,100       added sender<->receiver RTT in ms       (CD_BENCH_RTT, default 0)
  --mbit 0          per-client-link cap in Mbit/s, 0 = off  (CD_BENCH_MBIT, default 0)
  --out file.json   JSON results                            (CD_BENCH_OUT)
  --label text      free-form label stored in the JSON      (CD_BENCH_LABEL)
  --timeout sec     per-trial timeout override              (CD_BENCH_TIMEOUT)
  --cpu-throttle N  slow the receiving page's CPU N times  (CD_BENCH_CPU_THROTTLE)
  --build mode      always | never: run npm run build first (CD_BENCH_BUILD, default always)
  --work-root dir   scratch directory root, default os.tmpdir() (CD_BENCH_WORK_ROOT)
  --no-proxy        talk to the relay directly: no shaping, no route accounting
  --no-ip-rotation  keep one client address for all trials (may hit local rate limits)
  --list            list scenarios and exit
`;

const options = parseOptions(process.argv.slice(2));
if (options.help) { process.stderr.write(USAGE); process.exit(0); }
if (options.list) {
  for (const [name, scenario] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(22)} ${scenario.text}`);
  process.exit(0);
}

const scenarioNames = list(option('scenarios', 'CD_BENCH_SCENARIOS', Object.keys(SCENARIOS).join(',')));
for (const name of scenarioNames) if (!SCENARIOS[name]) fail(`unknown scenario ${name}; try --list`);
const sizes = numbers('sizes', 'CD_BENCH_SIZES', '64,256', (value) => value > 0);
const rtts = numbers('rtt', 'CD_BENCH_RTT', '0', (value) => value >= 0 && value <= 2000);
const mbits = numbers('mbit', 'CD_BENCH_MBIT', '0', (value) => value >= 0);
const trialCount = Number(option('trials', 'CD_BENCH_TRIALS', '5'));
const warmupCount = Number(option('warmup', 'CD_BENCH_WARMUP', '1'));
const cpuThrottle = Number(option('cpu-throttle', 'CD_BENCH_CPU_THROTTLE', '1'));
const buildMode = option('build', 'CD_BENCH_BUILD', 'always');
const label = option('label', 'CD_BENCH_LABEL', '');
const timeoutOverride = Number(option('timeout', 'CD_BENCH_TIMEOUT', '0'));
const useProxy = !options['no-proxy'];
const rotateIp = useProxy && !options['no-ip-rotation'];
if (!Number.isInteger(trialCount) || trialCount < 1) fail('--trials must be a positive integer');
if (!Number.isInteger(warmupCount) || warmupCount < 0) fail('--warmup must be a non-negative integer');
if (!(cpuThrottle >= 1)) fail('--cpu-throttle must be >= 1');
if (!['always', 'never'].includes(buildMode)) fail('--build must be always or never');
if (!useProxy && (rtts.some((value) => value > 0) || mbits.some((value) => value > 0))) fail('--rtt and --mbit need the proxy');
if (process.env.CD_VERIFY_URL && useProxy) fail('the shaping proxy only supports the local worker; use --no-proxy with CD_VERIFY_URL');
const needsBrowser = scenarioNames.some((name) => SCENARIOS[name].sender === 'browser' || SCENARIOS[name].receiver === 'browser');
const startedAt = new Date();
const outPath = resolve(option('out', 'CD_BENCH_OUT', join('bench-results', `bench-speed-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`)));

const now = () => performance.timeOrigin + performance.now();
const log = (message) => process.stderr.write(`${message}\n`);

const state = { trials: [], notes: [], aborted: false };
let work;
let worker;
let proxy;
let browser;
let cleanedUp = false;
let meta = {};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`\n${signal}: stopping and saving partial results`);
    state.aborted = true;
    void finish(130);
  });
}

async function main() {
  work = await mkdtemp(join(options['work-root'] ?? process.env.CD_BENCH_WORK_ROOT ?? os.tmpdir(), 'cd-bench-speed-'));
  if (buildMode === 'always') {
    log('building web app (npm run build)');
    await run('npm', ['run', 'build']);
  }
  log('building cdx');
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  const upstream = new URL(worker.publicBase);
  if (useProxy) proxy = await startProxy({ host: upstream.hostname, port: Number(upstream.port), rotateIp });
  const base = proxy ? proxy.base : worker.publicBase;
  const relay = proxy ? proxy.relay : worker.relayBase;
  if (needsBrowser) {
    browser = await chromium.launch({
      executablePath: await findChromium(),
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
  }
  meta = await collectMeta(executable);
  log(`commit ${meta.git.commit?.slice(0, 9)}${meta.git.dirty ? ' (dirty)' : ''}, chromium ${meta.chromium ?? 'n/a'}, ${meta.cpu.cores} cores, load ${meta.loadavgStart.map((v) => v.toFixed(2)).join(' ')}`);

  const payloads = new Map();
  for (const size of sizes) {
    const path = join(work, `payload-${size}MiB.bin`);
    payloads.set(size, { path, size, bytes: size * MIB, sha256: await makePayload(path, size) });
  }

  const env = { executable, base, relay, payloads, stateDir: join(work, 'state'), configDir: join(work, 'config') };
  const cells = [];
  for (const size of sizes) for (const rtt of rtts) for (const mbit of mbits) cells.push({ size, rtt, mbit });
  const total = cells.length * scenarioNames.length * (trialCount + warmupCount);
  let done = 0;
  for (const cell of cells) {
    if (state.aborted) break;
    proxy?.configure(cell);
    log(`\n== ${cell.size} MiB, +${cell.rtt} ms RTT${cell.mbit ? `, ${cell.mbit} Mbit/s` : ''} ==`);
    const failures = new Map(scenarioNames.map((name) => [name, 0]));
    const plan = [];
    for (let index = 0; index < warmupCount; index += 1) for (const name of scenarioNames) plan.push({ name, warmup: true, index });
    for (let index = 0; index < trialCount; index += 1) {
      // Rotate the order each round so no scenario always runs first or last.
      for (let slot = 0; slot < scenarioNames.length; slot += 1) plan.push({ name: scenarioNames[(slot + index) % scenarioNames.length], warmup: false, index });
    }
    for (const step of plan) {
      if (state.aborted) break;
      done += 1;
      if (failures.get(step.name) >= 3) {
        state.trials.push({ scenario: step.name, sizeMiB: cell.size, rttMs: cell.rtt, mbit: cell.mbit, trial: step.index, warmup: step.warmup, ok: false, stage: 'skipped', error: 'skipped after 3 consecutive failures' });
        continue;
      }
      const trial = await runTrial(env, step.name, cell, step);
      failures.set(step.name, trial.ok ? 0 : failures.get(step.name) + 1);
      state.trials.push(trial);
      log(`[${done}/${total}] ${formatTrial(trial)}`);
    }
    await save();
  }
  log('');
  printTable();
}

// ---------------------------------------------------------------------------
// Trials

async function runTrial(env, name, cell, step) {
  const scenario = SCENARIOS[name];
  const payload = env.payloads.get(cell.size);
  const trial = {
    scenario: name, sizeMiB: cell.size, rttMs: cell.rtt, mbit: cell.mbit, trial: step.index, warmup: step.warmup,
    startedAt: new Date().toISOString(), ok: false, stage: 'setup'
  };
  const timeoutMs = (timeoutOverride > 0 ? timeoutOverride : 90 + cell.size * (cell.mbit ? (8 / cell.mbit) * 2 : 0.5)) * 1000;
  const cleanups = [];
  const cpuBefore = cpuTimes();
  trial.loadAvgBefore = os.loadavg()[0];
  const outDir = join(work, `out-${Math.random().toString(36).slice(2)}`);
  let sender;
  let t0;
  let tracker;
  try {
    await mkdir(outDir, { recursive: true });
    cleanups.push(() => rm(outDir, { recursive: true, force: true }));
    tracker = proxy?.beginTrial();
    // Pre-open the receiving page so page load is not part of the join time.
    let browserReceiver;
    if (scenario.receiver === 'browser') {
      trial.stage = 'receiver-page';
      browserReceiver = await openBrowserReceiver(env, cleanups);
    }
    trial.stage = 'share-code';
    sender = scenario.sender === 'cli' ? await startCliSender(env, scenario, payload, cleanups, timeoutMs) : await startBrowserSender(env, payload, cleanups, timeoutMs);
    trial.shareCodeMs = sender.shareCodeAt - sender.startedAt;

    trial.stage = 'transfer';
    let received;
    if (scenario.receiver === 'cli') {
      t0 = now();
      received = await runCliReceiver(env, sender.code, outDir, cleanups, timeoutMs);
    } else {
      received = await runBrowserReceiver(browserReceiver, sender.code, timeoutMs, () => { t0 = now(); });
    }
    trial.transferMs = received.endAt - t0;
    trial.mibPerSec = cell.size / (trial.transferMs / 1000);
    if (received.verifiedAt) trial.verifiedMs = received.verifiedAt - t0;
    if (received.downloadEventAt) trial.downloadEventMs = received.downloadEventAt - t0;

    trial.stage = 'verify';
    const digest = await sha256File(received.path);
    trial.sha256Ok = digest === payload.sha256;
    if (!trial.sha256Ok) throw new Error('received file differs from the payload (SHA-256 mismatch)');
    const size = (await stat(received.path)).size;
    if (size !== payload.bytes) throw new Error(`received ${size} bytes, expected ${payload.bytes}`);

    trial.stage = 'sender-complete';
    const senderDoneAt = await sender.done(Math.max(30_000, timeoutMs / 4));
    trial.senderDoneMs = senderDoneAt - t0;
    trial.totalMs = senderDoneAt - sender.startedAt;
    trial.ok = true;
    trial.stage = 'done';
  } catch (error) {
    trial.error = String(error.message ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
  } finally {
    const summary = proxy?.endTrial();
    if (summary) Object.assign(trial, routeReport(summary, payload, t0));
    trial.loadAvgAfter = os.loadavg()[0];
    trial.cpuBusyPct = cpuBusy(cpuBefore, cpuTimes());
    await sender?.stop().catch(() => {});
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
  }
  return trial;
}

function formatTrial(trial) {
  const head = `${trial.warmup ? 'warmup ' : ''}${trial.scenario} #${trial.trial + 1}`;
  if (!trial.ok) return `${head}: FAILED at ${trial.stage}: ${trial.error}`;
  const route = trial.route ? ` relay ${(trial.route.relayFraction * 100).toFixed(0)}%` : '';
  return `${head}: ${trial.mibPerSec.toFixed(1)} MiB/s in ${(trial.transferMs / 1000).toFixed(2)} s, code ${Math.round(trial.shareCodeMs)} ms, first payload ${trial.firstPayloadMs == null ? 'n/a' : `${Math.round(trial.firstPayloadMs)} ms`}${route}, cpu ${trial.cpuBusyPct}%`;
}

// ---------------------------------------------------------------------------
// CLI endpoints

function cliEnvFor(env, scenario) {
  const extra = {
    CD_STATE_DIR: env.stateDir,
    XDG_CONFIG_HOME: env.configDir,
    CD_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1'
  };
  const result = cliEnv({ relayBase: env.relay, publicBase: env.base }, extra);
  if (scenario?.direct === false) result.CD_DIRECT = '0';
  else delete result.CD_DIRECT;
  return result;
}

async function startCliSender(env, scenario, payload, cleanups, timeoutMs) {
  const startedAt = now();
  const child = spawn(env.executable, ['send', '--wait', payload.path], { env: cliEnvFor(env, scenario), stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => stopChild(child));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  let exitedAt = null;
  const exit = childExit(child, timeoutMs + 60_000).then((code) => { exitedAt = now(); return code; });
  exit.catch(() => {});
  const code = await firstLine(child.stdout, 30_000).catch((error) => { throw new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`); });
  const shareCodeAt = now();
  if (!/^\d{4,5}$/.test(code)) throw new Error(`sender printed ${JSON.stringify(code)} instead of a share code`);
  return {
    code, startedAt, shareCodeAt,
    async done(graceMs) {
      const result = await Promise.race([exit, new Promise((resolveTimer) => setTimeout(() => resolveTimer('timeout'), graceMs))]);
      if (result === 'timeout') throw new Error(`sender did not finish within ${Math.round(graceMs / 1000)} s of the receiver`);
      if (result !== 0) throw new Error(`sender exited ${result}: ${stderr.trim()}`);
      return exitedAt;
    },
    stop: () => stopChild(child)
  };
}

async function runCliReceiver(env, code, outDir, cleanups, timeoutMs) {
  const child = spawn(env.executable, ['receive', code, '--out', outDir], { env: cliEnvFor(env, null), stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => stopChild(child));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const status = await childExit(child, timeoutMs);
  const endAt = now();
  if (status !== 0) throw new Error(`receiver exited ${status}: ${stderr.trim()}`);
  const path = stdout.trim().split('\n').pop();
  if (!path) throw new Error('receiver printed no path');
  return { endAt, path };
}

// ---------------------------------------------------------------------------
// Browser endpoints

// Runs in every page before its scripts: stamps the moments the UI shows a
// share code, finishes sending, starts receiving, verifies, or fails.
const INSTRUMENT = () => {
  const marks = {};
  window.__bench = { marks };
  const stamp = (name, detail) => { if (!(name in marks)) marks[name] = { at: performance.timeOrigin + performance.now(), detail }; };
  const shown = (id) => { const element = document.getElementById(id); return element && !element.classList.contains('hidden') ? element : null; };
  const check = () => {
    const code = document.getElementById('share-code');
    if (code && /\d{4,5}/.test(code.textContent)) stamp('shareCode', code.textContent.trim());
    if (shown('sender-complete')) stamp('senderComplete');
    const senderError = shown('sender-error');
    if (senderError) stamp('senderError', senderError.textContent.replace(/\s+/g, ' ').trim());
    const receiverError = shown('receiver-error');
    if (receiverError) stamp('receiverError', receiverError.textContent.replace(/\s+/g, ' ').trim());
    const status = document.querySelector('[data-relay="status"]');
    if (status) {
      const text = status.textContent.trim();
      if (/^Receiving /.test(text)) stamp('receiving');
      else if (/verified/i.test(text)) stamp('verified');
      else if (text && !/^(Connecting|Connected|Preparing|Ready when)/.test(text)) stamp('receiverError', text);
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  delete window.showSaveFilePicker;
};

async function newPage(env, cleanups, { throttle = 1 } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  cleanups.push(() => context.close());
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  if (throttle > 1) {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  page.setDefaultTimeout(60_000);
  await page.goto(env.base);
  await page.locator('.workbench:not([inert])').waitFor();
  return page;
}

async function openBrowserReceiver(env, cleanups) {
  const page = await newPage(env, cleanups, { throttle: cpuThrottle });
  await page.locator('#receive-mode-btn').click();
  await page.locator('#code-input').waitFor();
  return page;
}

async function startBrowserSender(env, payload, cleanups, timeoutMs) {
  const page = await newPage(env, cleanups);
  const startedAt = now();
  await page.locator('#file-input').setInputFiles(payload.path);
  const mark = (name) => page.evaluate((key) => window.__bench.marks[key] ?? null, name);
  await page.waitForFunction(() => window.__bench.marks.shareCode || window.__bench.marks.senderError, null, { timeout: 30_000, polling: 10 });
  const senderError = await mark('senderError');
  if (senderError) throw new Error(`sender page failed: ${senderError.detail}`);
  const shareCode = await mark('shareCode');
  return {
    code: shareCode.detail, startedAt, shareCodeAt: shareCode.at,
    async done(graceMs) {
      await page.waitForFunction(() => window.__bench.marks.senderComplete || window.__bench.marks.senderError, null, { timeout: graceMs, polling: 50 })
        .catch(() => { throw new Error(`sender page did not report completion within ${Math.round(graceMs / 1000)} s of the receiver`); });
      const failure = await mark('senderError');
      if (failure) throw new Error(`sender page failed: ${failure.detail}`);
      return (await mark('senderComplete')).at;
    },
    stop: async () => {}
  };
}

async function runBrowserReceiver(page, code, timeoutMs, onStart) {
  const download = page.waitForEvent('download', { timeout: timeoutMs });
  download.catch(() => {});
  let stopWatching = false;
  const failure = page.waitForFunction(() => window.__bench.marks.receiverError, null, { timeout: timeoutMs, polling: 250 })
    .then(async () => {
      if (stopWatching) return new Promise(() => {});
      const mark = await page.evaluate(() => window.__bench.marks.receiverError);
      throw new Error(`receiver page failed: ${mark?.detail ?? 'unknown'}`);
    }, () => new Promise(() => {}));
  onStart();
  await page.locator('#code-input').fill(code);
  // A five-digit code connects as it is typed; a four-digit one waits for the button.
  if (await page.locator('#connect-btn').isVisible()) await page.locator('#connect-btn').click();
  try {
    const file = await Promise.race([download, failure]);
    const downloadEventAt = now();
    const path = await file.path();
    if (!path) throw new Error(`download failed: ${await file.failure()}`);
    const endAt = now();
    const marks = await page.evaluate(() => window.__bench.marks);
    return { path, endAt, downloadEventAt, verifiedAt: marks.verified?.at };
  } finally {
    stopWatching = true;
  }
}

// ---------------------------------------------------------------------------
// Shaping and counting proxy

const KIND_NAMES = { 1: 'offer', 2: 'chunk', 3: 'end', 4: 'accept', 5: 'ack', 6: 'complete', 7: 'tunnelJson', 8: 'tunnelBytes', 9: 'signal' };
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// Sides: 'S>' sender->relay, '>R' relay->receiver, 'R>' receiver->relay,
// '>S' relay->sender. Each is observed where the bytes leave the proxy, so
// '>R' timestamps are deliveries to the receiver, after any simulated delay.
async function startProxy({ host, port, rotateIp }) {
  const config = { oneWayMs: 0, bytesPerSec: 0 };
  const agent = new http.Agent({ keepAlive: true });
  const upstreamOrigin = `http://${host}:${port}`;
  let listenPort = 0;
  let tracker = null;
  let addressCounter = 0;
  let clientIp = null;
  const sockets = new Set();

  const server = http.createServer((request, response) => handleRequest(request, response));
  server.on('upgrade', (request, socket, head) => handleUpgrade(request, socket, head));
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setNoDelay(true); });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  listenPort = server.address().port;
  const proxyOrigin = `http://127.0.0.1:${listenPort}`;

  function headersFor(rawHeaders, { keepHop }) {
    const headers = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index];
      const lower = name.toLowerCase();
      let value = rawHeaders[index + 1];
      if (lower === 'host') value = `${host}:${port}`;
      else if (lower === 'origin' && value === proxyOrigin) value = upstreamOrigin;
      else if (lower === 'cf-connecting-ip') continue;
      else if (!keepHop && HOP_HEADERS.has(lower)) continue;
      headers.push([name, value]);
    }
    if (clientIp) headers.push(['CF-Connecting-IP', clientIp]);
    return headers;
  }

  async function handleRequest(request, response) {
    const active = tracker;
    const shaped = request.url.startsWith('/api/') && config.oneWayMs > 0;
    const began = now();
    const headers = Object.fromEntries(headersFor(request.rawHeaders, { keepHop: false }));
    const upstreamRequest = http.request({ host, port, method: request.method, path: request.url, headers, agent }, async (upstreamResponse) => {
      const responseHeaders = [];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        if (!HOP_HEADERS.has(upstreamResponse.rawHeaders[index].toLowerCase())) responseHeaders.push(upstreamResponse.rawHeaders[index], upstreamResponse.rawHeaders[index + 1]);
      }
      const finish = () => {
        if (!active) return;
        active.http.push({ method: request.method, path: request.url.replace(/\/\d{4,5}$/, '/<code>'), status: upstreamResponse.statusCode, ms: now() - began });
        if (upstreamResponse.statusCode === 429) active.rateLimited += 1;
      };
      if (shaped) {
        const body = [];
        for await (const chunk of upstreamResponse) body.push(chunk);
        await sleep(config.oneWayMs);
        response.writeHead(upstreamResponse.statusCode, responseHeaders);
        response.end(Buffer.concat(body));
        finish();
      } else {
        response.writeHead(upstreamResponse.statusCode, responseHeaders);
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', finish);
      }
    });
    upstreamRequest.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { if (!response.writableEnded) upstreamRequest.destroy(); });
    if (shaped) {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      await sleep(config.oneWayMs);
      upstreamRequest.end(Buffer.concat(body));
    } else {
      request.pipe(upstreamRequest);
    }
  }

  function handleUpgrade(request, client, head) {
    const active = tracker;
    // The sender must join first (the receiver needs its code), so connection
    // order names the roles even when the join message is compressed and
    // unreadable; a readable join message overrides the guess.
    const order = active ? active.connections.length : 0;
    const connection = { path: request.url.split('?')[0].replace(/\/[A-Za-z0-9_-]{22}$/, '/<id>'), role: order === 0 ? 'sender' : order === 1 ? 'receiver' : null, status: null };
    active?.connections.push(connection);
    const upstream = net.connect({ host, port, allowHalfOpen: true });
    upstream.setNoDelay(true);
    const sideUp = () => (connection.role === 'sender' ? 'S>' : connection.role === 'receiver' ? 'R>' : '?>');
    const sideDown = () => (connection.role === 'receiver' ? '>R' : connection.role === 'sender' ? '>S' : '>?');
    const shape = { oneWayMs: config.oneWayMs, bytesPerSec: config.bytesPerSec };

    const sniffUp = createFrameSniffer({
      expectHead: false,
      onFrame: (frame) => {
        if (frame.opcode === 1) {
          try {
            const message = JSON.parse(frame.peek.toString('utf8'));
            if (message?.type === 'join' && (message.role === 'sender' || message.role === 'receiver')) {
              if (connection.role && connection.role !== message.role && active) active.roleMismatches += 1;
              connection.role = message.role;
            }
          } catch { /* Not the join message. */ }
        }
        active?.frame(sideUp(), frame);
      }
    });
    const sniffDown = createFrameSniffer({
      expectHead: true,
      onHead: (text) => {
        connection.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
        if (connection.status === 429 && active) active.rateLimited += 1;
      },
      onFrame: (frame) => active?.frame(sideDown(), frame)
    });

    const toUpstream = createShapedPipe(client, upstream, shape, (chunk, meta) => {
      active?.wire(sideUp(), chunk.length);
      if (meta.sniff !== false) sniffUp(chunk);
    });
    const toClient = createShapedPipe(upstream, client, shape, (chunk) => {
      active?.wire(sideDown(), chunk.length);
      sniffDown(chunk);
    });
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of headersFor(request.rawHeaders, { keepHop: true })) lines.push(`${name}: ${value}`);
    toUpstream.push(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), { sniff: false });
    if (head?.length) toUpstream.push(head, {});
    toUpstream.attach();
    toClient.attach();
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    for (const socket of [client, upstream]) sockets.add(socket);
    upstream.once('close', () => sockets.delete(upstream));
  }

  return {
    base: proxyOrigin,
    relay: `ws://127.0.0.1:${listenPort}/ws/v1`,
    configure(cell) {
      config.oneWayMs = cell.rtt / 4;
      config.bytesPerSec = cell.mbit > 0 ? (cell.mbit * 1_000_000) / 8 : 0;
    },
    beginTrial() {
      tracker = createTracker();
      // A fresh client address per trial keeps the Worker's per-address
      // admission limits (30 connections/min, 12 code lookups/min) from
      // throttling back-to-back trials. The Worker code is unchanged.
      addressCounter += 1;
      clientIp = rotateIp ? `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter & 255}` : null;
      return tracker;
    },
    endTrial() {
      const finished = tracker;
      tracker = null;
      return finished?.summary();
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  };
}

function createTracker() {
  const sides = {};
  const firstAt = {};
  const lastAt = {};
  const seqs = { '>R': new Map(), 'S>': new Map() };
  const lastKind = {};
  const tracker = {
    connections: [], http: [], rateLimited: 0, compressedFrames: 0, unparsedFrames: 0, roleMismatches: 0,
    wire(side, bytes) { (sides[side] ??= { wireBytes: 0, frames: 0, fragments: 0, bytes: 0, kinds: {} }).wireBytes += bytes; },
    frame(side, frame) {
      if (frame.opcode >= 8) return;
      const entry = (sides[side] ??= { wireBytes: 0, frames: 0, fragments: 0, bytes: 0, kinds: {} });
      // A message sent as several frames (gorilla's 4 KiB write buffer on
      // clients) continues in opcode-0 frames: count it once, add its bytes.
      if (frame.opcode === 0) {
        entry.fragments += 1;
        entry.bytes += frame.length;
        if (lastKind[side]) lastKind[side].bytes += frame.length;
        return;
      }
      entry.frames += 1;
      entry.bytes += frame.length;
      let kind = 'text';
      if (frame.opcode !== 1) {
        const peek = frame.peek;
        if (frame.rsv1) {
          // permessage-deflate (browsers negotiate it with the Worker) hides the
          // record header. A compressed frame of 128 KiB or more can only be a
          // 256 KiB CHUNK record (random data deflates to about its own size).
          tracker.compressedFrames += 1;
          kind = frame.length >= 128 * 1024 ? 'chunk~' : 'compressed';
        }
        else if (frame.opcode === 2 && peek.length >= 12 && peek[0] === 0x43 && peek[1] === 0x44 && peek[2] === 1) {
          kind = KIND_NAMES[peek[3]] ?? `kind${peek[3]}`;
          if (kind === 'chunk' && seqs[side]) seqs[side].set(peek.readUInt32BE(4), (seqs[side].get(peek.readUInt32BE(4)) ?? 0) + 1);
        } else { tracker.unparsedFrames += 1; kind = 'other'; }
      }
      const counts = (entry.kinds[kind] ??= { frames: 0, bytes: 0 });
      counts.frames += 1;
      counts.bytes += frame.length;
      lastKind[side] = counts;
      const key = `${side}${kind}`;
      const time = now();
      firstAt[key] ??= time;
      lastAt[key] = time;
    },
    summary() {
      return {
        sides, firstAt, lastAt, connections: tracker.connections, http: tracker.http, rateLimited: tracker.rateLimited,
        compressedFrames: tracker.compressedFrames, unparsedFrames: tracker.unparsedFrames, roleMismatches: tracker.roleMismatches,
        chunkSeqs: { '>R': [...seqs['>R'].values()], 'S>': [...seqs['S>'].values()] }
      };
    }
  };
  return tracker;
}

// One direction of a proxied connection. Chunks leave `delayMs` after they
// would finish serialising at `bytesPerSec`; order is preserved. Reading from
// the source pauses while too much is queued, like a full socket buffer.
function createShapedPipe(source, destination, { oneWayMs, bytesPerSec }, onRelease) {
  const queue = [];
  const maxQueued = bytesPerSec ? 8 * MIB : 16 * MIB;
  let queued = 0;
  let linkFree = 0;
  let timer = null;
  let ended = false;
  let blocked = false;
  let paused = false;

  function push(chunk, meta) {
    const arrival = performance.now();
    let departure = arrival;
    if (bytesPerSec && meta.sniff !== false) {
      linkFree = Math.max(linkFree, arrival) + (chunk.length * 1000) / bytesPerSec;
      departure = linkFree;
    }
    queue.push({ at: departure + oneWayMs, chunk, meta });
    queued += chunk.length;
    if (!paused && queued >= maxQueued) { paused = true; source.pause(); }
    pump();
  }

  function pump() {
    clearTimeout(timer);
    timer = null;
    if (blocked) return;
    const current = performance.now();
    while (queue.length > 0 && queue[0].at <= current) {
      const { chunk, meta } = queue.shift();
      queued -= chunk.length;
      onRelease(chunk, meta);
      if (!destination.destroyed && !destination.write(chunk)) {
        blocked = true;
        destination.once('drain', () => { blocked = false; pump(); });
        break;
      }
    }
    if (paused && queued < maxQueued / 2) { paused = false; source.resume(); }
    if (queue.length === 0 && ended) {
      if (!destination.destroyed && !destination.writableEnded) destination.end();
    } else if (queue.length > 0 && !blocked) {
      timer = setTimeout(pump, Math.max(0, queue[0].at - performance.now()));
    }
  }

  return {
    push,
    attach() {
      source.on('data', (chunk) => push(chunk, {}));
      source.on('end', () => { ended = true; pump(); });
      source.on('close', (hadError) => {
        ended = true;
        if (hadError) destination.destroy();
        else pump();
      });
    }
  };
}

// Minimal WebSocket frame reader. Calls onFrame once the first 12 payload
// bytes (2048 for text frames) of each frame are known: enough to read the
// plaintext record header (kind, sequence) without buffering payloads.
function createFrameSniffer({ expectHead, onHead = () => {}, onFrame }) {
  let state = expectHead ? 'head' : 'header';
  let headBuffer = Buffer.alloc(0);
  const header = Buffer.alloc(14);
  let headerLength = 0;
  let frame = null;

  function emit() {
    frame.emitted = true;
    onFrame({ opcode: frame.opcode, fin: frame.fin, rsv1: frame.rsv1, length: frame.length, peek: frame.peek });
  }

  return function feed(input) {
    let chunk = input;
    let index = 0;
    while (index < chunk.length) {
      if (state === 'dead') return;
      if (state === 'head') {
        headBuffer = Buffer.concat([headBuffer, chunk.subarray(index)]);
        const end = headBuffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (headBuffer.length > 16 * 1024) state = 'dead';
          return;
        }
        onHead(headBuffer.subarray(0, end).toString('latin1'));
        chunk = headBuffer.subarray(end + 4);
        headBuffer = Buffer.alloc(0);
        index = 0;
        state = 'header';
        continue;
      }
      if (state === 'header') {
        let complete = false;
        while (index < chunk.length && !complete) {
          header[headerLength] = chunk[index];
          headerLength += 1;
          index += 1;
          if (headerLength >= 2) {
            const length7 = header[1] & 0x7f;
            const masked = (header[1] & 0x80) !== 0;
            const needed = 2 + (length7 === 126 ? 2 : length7 === 127 ? 8 : 0) + (masked ? 4 : 0);
            if (headerLength === needed) {
              const length = length7 < 126 ? length7 : length7 === 126 ? header.readUInt16BE(2) : Number(header.readBigUInt64BE(2));
              const opcode = header[0] & 0x0f;
              const peekNeeded = Math.min(length, opcode === 1 ? 2048 : 12);
              frame = {
                opcode, fin: (header[0] & 0x80) !== 0, rsv1: (header[0] & 0x40) !== 0, length,
                mask: masked ? Buffer.from(header.subarray(needed - 4, needed)) : null,
                peek: Buffer.alloc(peekNeeded), got: 0, remaining: length, emitted: false
              };
              headerLength = 0;
              complete = true;
              if (length === 0) { emit(); frame = null; } else state = 'payload';
            }
          }
        }
        continue;
      }
      // payload
      const take = Math.min(frame.remaining, chunk.length - index);
      if (frame.got < frame.peek.length) {
        const copy = Math.min(take, frame.peek.length - frame.got);
        for (let offset = 0; offset < copy; offset += 1) {
          frame.peek[frame.got + offset] = chunk[index + offset] ^ (frame.mask ? frame.mask[(frame.got + offset) & 3] : 0);
        }
        frame.got += copy;
        if (frame.got === frame.peek.length && !frame.emitted) emit();
      }
      frame.remaining -= take;
      index += take;
      if (frame.remaining === 0) { state = 'header'; frame = null; }
    }
  };
}

function routeReport(summary, payload, t0) {
  const expectedChunks = Math.ceil(payload.bytes / CHUNK_BYTES);
  // Pick the most exact view of what the relay carried. Record headers are
  // readable on uncompressed links (cdx clients); browsers' links are
  // permessage-deflate compressed, so there chunks are counted by frame size.
  const delivered = summary.chunkSeqs['>R'];
  const uplink = summary.chunkSeqs['S>'];
  const approximate = summary.sides['>R']?.kinds['chunk~']?.frames ?? 0;
  let source;
  let unique;
  let frames;
  if (delivered.length > 0) { source = 'relay-to-receiver'; unique = delivered.length; frames = delivered.reduce((sum, count) => sum + count, 0); }
  else if (uplink.length > 0) { source = 'sender-to-relay'; unique = uplink.length; frames = uplink.reduce((sum, count) => sum + count, 0); }
  else { source = approximate > 0 ? 'frame-size' : 'none'; unique = approximate; frames = approximate; }
  const relayFraction = Math.min(1, unique / expectedChunks);
  const at = (key) => (summary.firstAt[key] == null || t0 == null ? null : summary.firstAt[key] - t0);
  const firstChunk = at('>Rchunk') ?? at('>Rchunk~');
  const lastRaw = summary.lastAt['>Rchunk'] ?? summary.lastAt['>Rchunk~'];
  const route = {
    source,
    accuracy: source === 'frame-size' ? 'approximate' : source === 'none' ? 'none' : 'exact',
    expectedChunks,
    relayUniqueChunks: unique,
    relayChunkFrames: frames,
    replayedChunkFrames: frames - unique,
    relayFraction,
    directFraction: 1 - relayFraction,
    kind: relayFraction >= 0.999 ? 'relay-only' : unique === 0 ? 'direct-only' : 'mixed',
    wireBytes: Object.fromEntries(Object.entries(summary.sides).map(([side, value]) => [side, value.wireBytes])),
    wsMessages: Object.fromEntries(Object.entries(summary.sides).map(([side, value]) => [side, Object.fromEntries(Object.entries(value.kinds).map(([kind, counts]) => [kind, counts.frames]))])),
    wsContinuationFrames: Object.fromEntries(Object.entries(summary.sides).map(([side, value]) => [side, value.fragments])),
    compressedFrames: summary.compressedFrames,
    unparsedFrames: summary.unparsedFrames,
    roleMismatches: summary.roleMismatches
  };
  return {
    route,
    firstPayloadMs: firstChunk,
    phasesMs: {
      offerDelivered: at('>Roffer'),
      acceptAtRelay: at('R>accept'),
      firstChunkDelivered: firstChunk,
      lastChunkDelivered: lastRaw == null || t0 == null ? null : lastRaw - t0,
      endDelivered: at('>Rend'),
      completeAtRelay: at('R>complete')
    },
    api: summary.http,
    handshakes: summary.connections.map((connection) => connection.status),
    rateLimited: summary.rateLimited
  };
}

// ---------------------------------------------------------------------------
// Results

async function save() {
  const result = buildResult();
  await mkdir(dirname(outPath), { recursive: true });
  const temporary = `${outPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporary, outPath);
}

function buildResult() {
  const finishedAt = new Date();
  return {
    tool: 'scripts/bench-speed.mjs',
    label,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    aborted: state.aborted,
    config: {
      scenarios: scenarioNames, sizesMiB: sizes, trials: trialCount, warmup: warmupCount, addedRttMs: rtts, mbit: mbits,
      cpuThrottle, proxy: useProxy, ipRotation: rotateIp, build: buildMode, argv: process.argv.slice(2)
    },
    environment: { ...meta, loadavgEnd: os.loadavg() },
    notes: [
      'MiB/s = payload MiB / (receiver join -> file complete on disk), SHA-256 verified. Failures count in completionRate.',
      useProxy
        ? 'All client traffic goes through a local Node proxy (extra hop even at 0 ms). It shapes WebSocket and /api traffic only; it does not shape WebRTC/UDP, so direct paths run at full loopback speed.'
        : 'No proxy: no shaping and no route accounting.',
      'cpuBusyPct is system-wide (includes this benchmark and other agents); loadAvg is the 1-minute average.',
      ...state.notes
    ],
    summary: summarize(),
    trials: state.trials
  };
}

function summarize() {
  const groups = new Map();
  for (const trial of state.trials) {
    if (trial.warmup) continue;
    const key = [trial.sizeMiB, trial.rttMs, trial.mbit, trial.scenario].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  const rows = [];
  for (const group of groups.values()) {
    const ok = group.filter((trial) => trial.ok);
    const first = group[0];
    const stat = (values) => (values.length === 0 ? null : { median: median(values), min: Math.min(...values), max: Math.max(...values) });
    const numbersOf = (pick) => ok.map(pick).filter((value) => typeof value === 'number' && Number.isFinite(value));
    const failureStages = {};
    for (const trial of group) if (!trial.ok) failureStages[trial.stage] = (failureStages[trial.stage] ?? 0) + 1;
    rows.push({
      scenario: first.scenario, sizeMiB: first.sizeMiB, addedRttMs: first.rttMs, mbit: first.mbit,
      trials: group.length, completed: ok.length, completionRate: ok.length / group.length, failureStages,
      mibPerSec: stat(numbersOf((trial) => trial.mibPerSec)),
      samplesMibPerSec: numbersOf((trial) => trial.mibPerSec),
      transferMs: stat(numbersOf((trial) => trial.transferMs)),
      shareCodeMs: stat(numbersOf((trial) => trial.shareCodeMs)),
      firstPayloadMs: stat(numbersOf((trial) => trial.firstPayloadMs)),
      senderDoneMs: stat(numbersOf((trial) => trial.senderDoneMs)),
      relayFraction: stat(numbersOf((trial) => trial.route?.relayFraction)),
      cpuBusyPct: stat(numbersOf((trial) => trial.cpuBusyPct)),
      loadAvgBefore: stat(numbersOf((trial) => trial.loadAvgBefore))
    });
  }
  return rows;
}

function printTable() {
  const rows = summarize();
  const fmt = (value, digits = 1) => (value == null ? '-' : value.toFixed(digits));
  const header = ['size', '+rtt', 'mbit', 'scenario', 'ok', 'MiB/s med', 'min', 'max', 'code ms', '1st payload ms', 'relay %', 'cpu %', 'load'];
  const lines = [header];
  for (const row of rows) {
    lines.push([
      `${row.sizeMiB}`, `${row.addedRttMs}`, row.mbit ? `${row.mbit}` : '-', row.scenario, `${row.completed}/${row.trials}`,
      fmt(row.mibPerSec?.median), fmt(row.mibPerSec?.min), fmt(row.mibPerSec?.max),
      fmt(row.shareCodeMs?.median, 0), fmt(row.firstPayloadMs?.median, 0),
      row.relayFraction ? fmt(row.relayFraction.median * 100, 0) : '-',
      fmt(row.cpuBusyPct?.median, 0), fmt(row.loadAvgBefore?.median, 1)
    ]);
  }
  const widths = header.map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  for (const line of lines) log(line.map((cell, column) => (column === 3 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  '));
  log(useProxy ? 'note: relay shaping does not apply to WebRTC/UDP; direct paths run unshaped on loopback.' : 'note: no proxy, so no shaping or route accounting.');
  log(`results: ${outPath}`);
}

async function finish(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    await save();
  } catch (error) {
    log(`could not write results: ${error.message}`);
  }
  await browser?.close().catch(() => {});
  await proxy?.stop().catch(() => {});
  await worker?.stop().catch(() => {});
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Helpers

async function makePayload(path, mib) {
  const hash = createHash('sha256');
  const file = await open(path, 'w');
  try {
    const block = Buffer.allocUnsafe(4 * MIB);
    for (let written = 0; written < mib * MIB; written += block.length) {
      const length = Math.min(block.length, mib * MIB - written);
      randomFillSync(block);
      const part = block.subarray(0, length);
      hash.update(part);
      await file.write(part);
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')));
  });
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle') idle += value;
    }
  }
  return { idle, total };
}

function cpuBusy(before, after) {
  const total = after.total - before.total;
  return total <= 0 ? null : Math.round(100 * (1 - (after.idle - before.idle) / total));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function exec(command, args) {
  return new Promise((resolveExec) => {
    execFile(command, args, { cwd: repoRoot, timeout: 20_000 }, (error, stdout) => resolveExec(error ? null : stdout.trim()));
  });
}

async function collectMeta(executable) {
  const [commit, branch, porcelain, goVersion, filesystem] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD']),
    exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    exec('git', ['status', '--porcelain', '--', '.', ':!bench-results']),
    exec('go', ['version']),
    exec('stat', ['-f', '-c', '%T', work])
  ]);
  const cpus = os.cpus();
  return {
    git: { commit, branch, dirty: porcelain ? porcelain.split('\n').length : 0 },
    node: process.version,
    go: goVersion,
    chromium: browser ? browser.version() : null,
    os: `${os.type()} ${os.release()}`,
    cpu: { model: cpus[0]?.model, cores: cpus.length },
    memTotalMiB: Math.round(os.totalmem() / MIB),
    workFilesystem: filesystem,
    cdxSha256: await sha256File(executable),
    distSha256: await hashDirectory(join(repoRoot, 'dist')),
    target: process.env.CD_VERIFY_URL ? process.env.CD_VERIFY_URL : 'local wrangler dev',
    loadavgStart: os.loadavg()
  };
}

async function hashDirectory(directory) {
  const hash = createHash('sha256');
  async function walk(current) {
    let entries;
    try { entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name)); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { hash.update(path.slice(directory.length)); hash.update(await readFile(path)); }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h') { parsed.help = true; continue; }
    if (!argument.startsWith('--')) fail(`unexpected argument ${argument}`);
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2);
    if (['help', 'list', 'no-proxy', 'no-ip-rotation'].includes(name)) parsed[name] = true;
    else parsed[name] = inline ?? argv[++index];
  }
  return parsed;
}

function option(name, variable, fallback) {
  return options[name] ?? process.env[variable] ?? fallback;
}

function list(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function numbers(name, variable, fallback, valid) {
  const values = list(option(name, variable, fallback)).map(Number);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || !valid(value))) fail(`invalid --${name}`);
  return values;
}

function fail(message) {
  process.stderr.write(`bench-speed: ${message}\n`);
  process.exit(2);
}

// Everything above is declarations; start only after the module has evaluated.
try {
  await main();
  await finish(state.trials.some((trial) => !trial.warmup && !trial.ok) ? 1 : 0);
} catch (error) {
  log(`bench-speed failed: ${error.stack ?? error}`);
  state.notes.push(`fatal: ${error.message}`);
  await finish(2);
}
