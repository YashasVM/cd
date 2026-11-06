import { summarize, browserTransportProbe } from './bench-metrics.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, release } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildCLI, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild, captureOutput } from './harness.mjs';

// Speed is the product, so it gets a number. Measures, on this machine:
//   code    command -> share code on stdout (the agent path, detached send)
//   foreground foreground readiness, verified CLI -> CLI throughput
//   relay   CLI -> CLI throughput through the relay room
//   p2p     browser -> browser encrypted records over negotiated WebRTC
//   tunnel  browser -> browser throughput when P2P falls back to the relay
//   legacy  explicitly unsupported historical PeerJS mode (fails clearly)
// Local by default (loopback: measures CPU and protocol overhead, not the
// network). CD_VERIFY_URL=https://cd.yash0.in measures production.
// CD_BENCH_MIB sets the payload (default 64), CD_BENCH_RUNS every mode's runs
// (default 3), CD_BENCH_ONLY a comma list of the names above, and
// CD_BENCH_CPU_THROTTLE slows the receiving page's CPU by that factor (4
// approximates a phone).
const cpuThrottle = Number(process.env.CD_BENCH_CPU_THROTTLE ?? 1);
const mib = Number(process.env.CD_BENCH_MIB ?? 64);
const codeRuns = Number(process.env.CD_BENCH_RUNS ?? 3);
assert.ok(Number.isInteger(codeRuns) && codeRuns > 0, 'CD_BENCH_RUNS must be a positive integer');
assert.ok(Number.isInteger(mib) && mib > 0, 'CD_BENCH_MIB must be a positive integer');
assert.ok(Number.isFinite(cpuThrottle) && cpuThrottle >= 1, 'CD_BENCH_CPU_THROTTLE must be at least 1');
const only = new Set((process.env.CD_BENCH_ONLY ?? 'code,foreground,relay,tunnel').split(','));
for (const mode of only) assert.ok(['code', 'foreground', 'relay', 'p2p', 'tunnel', 'legacy'].includes(mode), `unknown benchmark mode: ${mode}`);
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

  for (const mode of ['code', 'foreground', 'relay'].filter((name) => only.has(name))) {
    const trials = [];
    for (let run = 0; run < codeRuns; run += 1) {
      trials.push(await cliTransfer(executable, env, payloadPath, payload, mode, run));
    }
    results[mode] = summarize(trials);
    console.error(`${mode}: ${JSON.stringify(results[mode])}`);
  }

  if (only.has('p2p') || only.has('tunnel') || only.has('legacy')) {
    browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
    for (const mode of ['p2p', 'legacy', 'tunnel'].filter((name) => only.has(name))) {
      try {
        const trials = [];
        for (let run = 0; run < codeRuns; run += 1) {
          try { trials.push({ completed: true, ...await browserTransfer(browser, worker.publicBase, payloadPath, payload, mode) }); }
          catch (error) { trials.push({ completed: false, error: error.message.split('\n')[0] }); }
        }
        results[mode] = summarize(trials);
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
console.log(JSON.stringify({ version: 1, target, mib, cpuThrottle, runs: codeRuns,
  environment: { platform: process.platform, arch: process.arch, release: release(), node: process.version, cpu: cpus()[0]?.model }, ...results }));
if (Object.values(results).some((result) => result.completionRate !== 1)) process.exitCode = 1;


async function cliTransfer(executable, env, payloadPath, payload, mode, run) {
  const detached = mode === 'code';
  const trialEnv = { ...env, CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1', CD_STATE_DIR: join(work, `${mode}-state-${run}`) };
  const outDir = join(work, `${mode}-out-${run}`);
  await mkdir(outDir);
  let sender, receiver, holderPID, holderLogPath;
  let senderOutput, receiverOutput;
  const started = performance.now();
  let readinessMs, parentExitMs;
  try {
    sender = spawn(executable, ['send', ...(detached ? [] : ['--wait']), payloadPath], { env: trialEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    senderOutput = captureOutput(sender);
    const senderExit = childExit(sender, 600_000);
    // Attach rejection handling while readiness is pending.
    senderExit.catch(() => {});
    const code = await firstLine(sender.stdout, 30_000);
    readinessMs = performance.now() - started;
    assert.match(code, /^\d{4,5}$/, 'sender must print a numeric share code');
    if (detached) {
      assert.equal(await senderExit, 0, senderOutput.stderr);
      parentExitMs = performance.now() - started;
      const status = spawn(executable, ['status', '--json', code], { env: trialEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const statusOutput = captureOutput(status);
      assert.equal(await childExit(status), 0, statusOutput.stderr);
      await statusOutput.finished;
      const state = JSON.parse(statusOutput.stdout);
      holderPID = state.pid;
      holderLogPath = state.log;
      assert.equal(state.phase, 'waiting', 'detached holder must remain waiting after parent exit');
      process.kill(holderPID, 0);
      assert.ok(parentExitMs < 30_000, 'detached parent must return within readiness deadline');
    }
    const transferStarted = performance.now();
    receiver = spawn(executable, ['receive', code, '--out', outDir], { env: trialEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    receiverOutput = captureOutput(receiver);
    assert.equal(await childExit(receiver, 600_000), 0, receiverOutput.stderr);
    await receiverOutput.finished;
    const seconds = (performance.now() - transferStarted) / 1000;
    if (detached) {
      const waiter = spawn(executable, ['wait', '--timeout', '30s', code], { env: trialEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const waiterOutput = captureOutput(waiter);
      assert.equal(await childExit(waiter), 0, waiterOutput.stderr);
      await waiterOutput.finished;
    } else assert.equal(await senderExit, 0, senderOutput.stderr);
    await senderOutput.finished;
    assert.equal(sha(await readFile(join(outDir, 'payload.bin'))), sha(payload));
    const holderLog = holderLogPath ? await readFile(holderLogPath, 'utf8') : '';
    const stderr = senderOutput.stderr + receiverOutput.stderr + holderLog;
    assert.ok(!stderr.includes('switched to a direct connection'), 'forced relay unexpectedly upgraded');
    const reports = stderr.split('\n').flatMap((line) => {
      try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
    });
    assert.ok(reports.length > 0, 'missing transport report: build a CLI with CD_TRANSPORT_REPORT support');
    for (const report of reports) { assert.equal(report.transport, 'relay'); assert.equal(report.directBytes, 0); }
    assert.ok(reports.some((report) => report.relayBytes >= payload.length), 'relay telemetry must cover payload bytes');
    return { completed: true, transport: 'relay', transportEvidence: reports.length ? reports : 'CD_DIRECT=0 in both clients; verified relay completion',
      readinessMs: round(readinessMs), ...(detached ? { parentExitMs: round(parentExitMs), holderAliveAfterExit: true } : {}),
      seconds: Math.round(seconds * 10000) / 10000, mibPerSecond: round(mib / seconds), outputBytes: senderOutput.bytes + receiverOutput.bytes,
      holderLogBytes: Buffer.byteLength(holderLog), stdoutBytes: senderOutput.stdoutBytes + receiverOutput.stdoutBytes, stderrBytes: senderOutput.stderrBytes + receiverOutput.stderrBytes };
  } catch (error) {
    return { completed: false, readinessMs, parentExitMs, error: error.message,
      stdout: senderOutput?.stdout, stderr: senderOutput?.stderr + (receiverOutput?.stderr ?? '') };
  } finally {
    await stopChild(receiver);
    await stopChild(sender);
    if (holderPID) { try { process.kill(holderPID, 'SIGTERM'); } catch {} }
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// browserTransfer times connect click -> download event for one payload.
async function browserTransfer(browser, baseUrl, payloadPath, payload, mode) {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript(browserTransportProbe, { blockDirect: mode === 'tunnel' });
    const sender = await context.newPage();
    const receiver = await context.newPage();
    if (mode === 'legacy') throw new Error('legacy PeerJS transport is unsupported; use encrypted p2p or tunnel');
    if (cpuThrottle > 1) {
      const session = await context.newCDPSession(receiver);
      await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    }
    sender.setDefaultTimeout(60_000);
    receiver.setDefaultTimeout(60_000);
    await sender.goto(baseUrl);
    await sender.locator('.workbench:not([inert])').waitFor();
    const readyStarted = performance.now();
    await sender.locator('#file-input').setInputFiles(payloadPath);
    try { await sender.locator('#sender-code-section:not(.hidden)').waitFor(); }
    catch (error) {
      const status = await sender.locator('#sender-status').textContent().catch(() => 'page unavailable');
      throw new Error(`browser sender did not become ready: ${status || error.message.split('\n')[0]}`);
    }
    const readinessMs = performance.now() - readyStarted;
    const code = (await sender.locator('#share-code').textContent()).trim();
    await receiver.goto(baseUrl);
    await receiver.locator('.workbench:not([inert])').waitFor();
    await receiver.locator('#receive-mode-btn').click();
    const downloadEvent = receiver.waitForEvent('download', { timeout: 60_000 });
    const started = performance.now();
    // Numeric codes auto-connect on input; clicking Connect again would join
    // a second receiver after the one-use code was consumed.
    await receiver.locator('#code-input').fill(code);
    if (!/^\d{4,5}$/.test(code)) await receiver.locator('#connect-btn').click();
    const download = await downloadEvent;
    const seconds = (performance.now() - started) / 1000;
    const savedPath = join(work, `${mode}.bin`);
    await download.saveAs(savedPath);
    assert.equal(sha(await readFile(savedPath)), sha(payload), `${mode} bytes differ`);
    const measured = await sender.evaluate(() => window.__benchTransport);
    if (mode === 'p2p') assert.ok(measured.directPayloadBytes >= Math.min(payload.length, 1024 * 1024), `p2p encrypted direct payload unavailable: ${JSON.stringify(measured)}`);
    if (mode === 'tunnel') {
      assert.equal(measured.directBytes, 0, 'forced tunnel sent data directly');
      assert.ok(measured.relayPayloadBytes >= payload.length, 'forced relay payload accounting missing');
    }
    return { mib, readinessMs: round(readinessMs), seconds: Math.round(seconds * 10000) / 10000, mibPerSecond: round(mib / seconds), transport: mode === 'p2p' ? 'encrypted-direct' : 'encrypted-relay', transportBytes: measured, outputBytes: null };
  } finally {
    await context.close();
  }
}
