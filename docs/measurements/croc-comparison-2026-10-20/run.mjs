// Head-to-head: cdx against croc on one machine, same random payload.
// Modes: cdx (defaults), cdx-webrtc (CD_LAN=0, the WebRTC direct path),
// cdx-relay (CD_DIRECT=0), croc (defaults), croc-no-compress.
// Both tools use loopback and their own local relay, so the result measures
// CPU and protocol overhead, not internet bandwidth.
//
//   node docs/measurements/head-to-head-2026-10-20/run.mjs   (from repo root)
//
// H2H_MIB sets the payload (default 1024), H2H_RUNS the runs per mode
// (default 5), H2H_ONLY a comma list of modes. Modes run interleaved so host
// load affects all of them alike, and the disk is flushed before every trial.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { cpus, homedir, release } from 'node:os';
import { join } from 'node:path';
import { buildCLI, availablePort, childExit, cliEnv, startWorker, stopChild } from '../../../scripts/harness.mjs';

const mib = Number(process.env.H2H_MIB ?? 1024);
const runs = Number(process.env.H2H_RUNS ?? 5);
const modes = (process.env.H2H_ONLY ?? 'cdx,cdx-relay,croc,croc-no-compress').split(',');
// H2H_DIR picks the filesystem both receivers write to (default ~/.cache).
const parent = process.env.H2H_DIR ?? join(homedir(), '.cache');
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, 'cd-h2h-'));
const payloadPath = join(work, 'payload.bin');
const trials = Object.fromEntries(modes.map((mode) => [mode, []]));

let worker, crocRelay;
try {
  await writeRandom(payloadPath, mib);
  const expected = await sha256(payloadPath);
  const cdx = await buildCLI(work);
  worker = await startWorker(work);
  // The relay needs five consecutive ports; retry when one is taken.
  let crocPort;
  for (let attempt = 0; !crocPort; attempt += 1) {
    const base = await availablePort();
    const ports = [0, 1, 2, 3, 4].map((offset) => base + offset).join(',');
    crocRelay = spawn('croc', ['relay', '--host', '127.0.0.1', '--ports', ports], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (await waitForPort(base)) crocPort = base;
    else {
      await stopChild(crocRelay);
      assert.ok(attempt < 4, 'croc relay did not start');
    }
  }

  for (let run = 0; run < runs; run += 1) {
    for (const mode of modes) {
      const outDir = join(work, `${mode}-${run}`);
      await mkdir(outDir);
      // Flush earlier runs' dirty pages so no tool pays for another's writeback.
      spawnSync('sync');
      const trial = mode.startsWith('cdx')
        ? await cdxTrial(cdx, mode, outDir, run)
        : await crocTrial(mode, outDir, run, `127.0.0.1:${crocPort}`);
      assert.equal(await sha256(join(outDir, 'payload.bin')), expected, `${mode} run ${run} corrupted the payload`);
      await rm(outDir, { recursive: true, force: true });
      trials[mode].push(trial);
      console.error(`${mode} #${run}: total ${trial.totalSeconds}s, transfer ${trial.transferSeconds}s, ${trial.mibPerSecond} MiB/s`);
    }
  }
} finally {
  await stopChild(crocRelay);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

const summary = Object.fromEntries(Object.entries(trials).map(([mode, list]) => [mode, {
  runs: list.length,
  medianTotalSeconds: median(list.map((t) => t.totalSeconds)),
  medianTransferSeconds: median(list.map((t) => t.transferSeconds)),
  medianMibPerSecond: median(list.map((t) => t.mibPerSecond)),
  trials: list
}]));
const croc = await version('croc', ['--version']);
console.log(JSON.stringify({ version: 1, date: new Date().toISOString(), mib, runs, croc,
  route: 'loopback; cdx through local wrangler dev relay (direct WebRTC allowed in "cdx"), croc through a local croc relay',
  environment: { platform: process.platform, arch: process.arch, release: release(), node: process.version, cpu: cpus()[0]?.model, cores: cpus().length },
  summary }, null, 2));

async function cdxTrial(executable, mode, outDir, run) {
  const forced = { 'cdx-relay': { CD_DIRECT: '0' }, 'cdx-webrtc': { CD_LAN: '0' } }[mode] ?? {};
  const env = cliEnv(worker, { CD_STATE_DIR: join(work, `state-${mode}-${run}`), CD_TRANSPORT_REPORT: '1', ...forced });
  const started = performance.now();
  const sender = spawn(executable, ['send', '--wait', payloadPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const senderOutput = captureOutput(sender);
  const senderExit = childExit(sender, 600_000);
  senderExit.catch(() => {});
  const code = (await waitFor(senderOutput, () => senderOutput.stdout.match(/^(\d{4,5})\s*$/m)?.[1], 'cdx code'));
  const transferStarted = performance.now();
  const receiver = spawn(executable, ['receive', code, '--out', outDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const receiverOutput = captureOutput(receiver);
  assert.equal(await childExit(receiver, 600_000), 0, receiverOutput.stderr);
  const finished = performance.now();
  assert.equal(await senderExit, 0, senderOutput.stderr);
  await Promise.all([senderOutput.finished, receiverOutput.finished]);
  const reports = (senderOutput.stderr + receiverOutput.stderr).split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
  });
  const routes = (senderOutput.stderr + receiverOutput.stderr).split('\n').filter((line) => line.startsWith('switched to'));
  return timing(started, transferStarted, finished, { routes, ...(reports.length ? { reports } : {}) });
}

async function crocTrial(mode, outDir, run, relay) {
  const code = `cd-h2h-${process.pid}-${mode}-${run}`;
  const flags = ['--relay', relay, '--disable-clipboard', '--yes', '--overwrite', ...(mode === 'croc-no-compress' ? ['--no-compress'] : [])];
  const started = performance.now();
  const env = { ...process.env, CROC_SECRET: code };
  const sender = spawn('croc', [...flags, 'send', '--no-local', payloadPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const senderOutput = captureOutput(sender);
  const senderExit = childExit(sender, 600_000);
  senderExit.catch(() => {});
  await waitFor(senderOutput, () => /Code is:/.test(senderOutput.stdout + senderOutput.stderr), 'croc code');
  const transferStarted = performance.now();
  const receiver = spawn('croc', [...flags, '--out', outDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const receiverOutput = captureOutput(receiver);
  assert.equal(await childExit(receiver, 600_000), 0, receiverOutput.stderr);
  const finished = performance.now();
  assert.equal(await senderExit, 0, senderOutput.stderr);
  return timing(started, transferStarted, finished, {});
}

function timing(started, transferStarted, finished, extra) {
  const totalSeconds = round((finished - started) / 1000);
  const transferSeconds = round((finished - transferStarted) / 1000);
  return { totalSeconds, transferSeconds, readySeconds: round((transferStarted - started) / 1000), mibPerSecond: round(mib / transferSeconds), ...extra };
}

async function waitFor(output, test, label) {
  const deadline = performance.now() + 120_000;
  for (;;) {
    const value = test();
    if (value) return value;
    assert.ok(performance.now() < deadline, `timed out waiting for ${label}: ${output.stdout}${output.stderr}`);
    await delay(5);
  }
}

async function writeRandom(path, size) {
  const { randomFillSync } = await import('node:crypto');
  const stream = createWriteStream(path);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < size; i += 1) {
    randomFillSync(chunk);
    if (!stream.write(Buffer.from(chunk))) await new Promise((resolve) => stream.once('drain', resolve));
  }
  await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function version(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = captureOutput(child);
  await childExit(child);
  await output.finished;
  return (output.stdout + output.stderr).trim();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function captureOutput(child) {
  const result = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => { result[name] += chunk.toString(); });
  result.finished = new Promise((resolve) => child.once('close', resolve));
  return result;
}

async function waitForPort(port) {
  const { connect } = await import('node:net');
  const deadline = performance.now() + 10_000;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return true;
    if (performance.now() > deadline) return false;
    await delay(100);
  }
}

function round(value) { return Math.round(value * 1000) / 1000; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
