import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, childExit, firstLine, startWorker, stopChild } from './harness.mjs';

// Deliberately loopback-only. No production relay, discovery, compression, or
// browser transport. Pass separately built, verified binaries; never install here.
assert.equal(process.env.CD_VERIFY_URL, undefined, 'Hosted benchmarks are not supported');
const cdx = resolve(process.env.CD_BENCH_CLI ?? '');
const candidate = process.env.CD_BENCH_CANDIDATE ? resolve(process.env.CD_BENCH_CANDIDATE) : null;
const names = ['cd-v2', ...(candidate ? ['cd-v2-candidate'] : []), 'croc-4', 'croc-1'];
const croc = resolve(process.env.CROC_BENCH_BIN ?? '');
assert.ok(process.env.CD_BENCH_CLI && process.env.CROC_BENCH_BIN, 'Set CD_BENCH_CLI and CROC_BENCH_BIN');
const sizes = (process.env.CD_BENCH_MIB ?? '64,256').split(',').map(Number);
const runs = Number(process.env.CD_BENCH_RUNS ?? 5);
assert.ok(sizes.every(n => Number.isInteger(n) && n > 0 && n <= 512));
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
const workRoot = resolve(process.env.CD_BENCH_WORKDIR ?? tmpdir());
const work = await mkdtemp(join(workRoot, 'cd-croc-bench-'));
let lastCDStart = -Infinity;
const children = new Set();
const samples = [];
const env = { ...process.env, CD_DIRECT: '0', CROC_DO_CHECK: '0', WRANGLER_SEND_METRICS: 'false' };
for (const key of Object.keys(env)) if (/proxy/i.test(key) || /^CROC_(SECRET|RELAY|RELAY6|PASS|CONFIG_DIR|PORT|PORTS)$/.test(key)) delete env[key];
let worker;
function launch(binary, args, extra = {}) {
  const child = spawn(binary, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '', stdout = '';
  child.stdout.on('data', b => { stdout = (stdout + b).slice(-65536); });
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-65536); });
  return { child, error: () => stderr, output: () => stdout };
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function seedConfig(directory) {
  await mkdir(directory, { recursive: true });
  // Official croc's documented source cache suppresses its optional update query.
  await writeFile(join(directory, 'version-check.json'), JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '11.5.4' }));
}
const common = ['--relay6', '', '--connect', '', '--socks5', '', '--no-compress', '--ignore-stdin', '--disable-clipboard', '--yes'];
async function crocRelay(streams) {
  const ports = [];
  while (ports.length <= streams) { const port = await availablePort(); if (!ports.includes(port)) ports.push(port); }
  const config = join(work, `relay-${streams}`);
  await seedConfig(config);
  const pass = `bench-${randomBytes(16).toString('hex')}`;
  const relay = launch(croc, ['--pass', pass, 'relay', '--host', '127.0.0.1', '--ports', ports.join(',')], { CROC_CONFIG_DIR: config });
  relay.child.stdout.resume();
  // Croc logs each listener after binding. No readiness connection is needed,
  // which avoids consuming an incomplete-handshake slot in the measured relay.
  for (let n = 0; n < 100; n++) {
    if (ports.every(port => (relay.error() + relay.output()).includes(`:${port}`))) return { address: `127.0.0.1:${ports[0]}`, pass, relay };
    if (relay.child.exitCode !== null) throw new Error('croc relay exited before readiness');
    await delay(50);
  }
  throw new Error('croc relay did not announce all loopback listeners');
}
async function transfer(tool, mib, run, source, expected, relay) {
  const directory = join(work, `${tool}-${mib}-${run}`);
  await mkdir(directory);
  let sender, receiver;
  const config = join(directory, 'config');
  if (!tool.startsWith('cd-v2')) await seedConfig(config);
  // Respect the unchanged local relay's 30 connections/minute allowance.
  // Each CD transfer opens two connections; pacing is outside measured time.
  if (tool.startsWith('cd-v2')) {
    await delay(Math.max(0, 5000 - (performance.now() - lastCDStart)));
    lastCDStart = performance.now();
  }
  const started = performance.now();
  let receiveStarted;
  if (tool.startsWith('cd-v2')) {
    const binary = tool === 'cd-v2' ? cdx : candidate;
    const extra = { ...env, CD_RELAY_URL: worker.relayBase, CD_PUBLIC_URL: worker.publicBase, CD_STATE_DIR: join(directory, 'state') };
    sender = launch(binary, ['send', '--resumable', '--json', source], extra);
    const ready = JSON.parse(await firstLine(sender.child.stdout, 30_000));
    assert.equal(ready.version, 2, `CD sender did not become ready: ${ready.error?.kind ?? ready.phase ?? 'unexpected event'}`);
    assert.equal(new URL(ready.url).hostname, '127.0.0.1');
    receiveStarted = performance.now();
    receiver = launch(binary, ['receive', '--json', ready.url, '--out', directory], extra);
  } else {
    const extra = { CROC_CONFIG_DIR: config, CROC_SECRET: `bench-${randomBytes(16).toString('hex')}` };
    const flags = [...common, '--relay', relay.address, '--pass', relay.pass];
    sender = launch(croc, [...flags, 'send', '--no-local', '--transport', 'relay', '--hash', 'xxhash', '--connect', '', '--socks5', '', source], extra);
    sender.child.stdout.resume();
    receiveStarted = performance.now();
    receiver = launch(croc, [...flags, '--ip', relay.address, '--out', directory], extra);
  }
  receiver.child.stdout.resume();
  const [sent, received] = await Promise.all([childExit(sender.child, 120_000), childExit(receiver.child, 120_000)]);
  const ended = performance.now();
  if (sent !== 0 || received !== 0) await writeFile('/tmp/cd-croc-last-error.log', sender.error() + '\nRECEIVER\n' + receiver.error());
  assert.equal(sent, 0, `${tool} sender failed (inspect /tmp/cd-croc-last-error.log)`);
  assert.equal(received, 0, `${tool} receiver failed (inspect local process logs)`);
  const actual = await digest(join(directory, 'payload.bin'));
  assert.equal(actual, expected, `${tool} output SHA-256 mismatch`);
  const sample = { tool, mib, run, totalMs: ended - started, receiveToBothExitMs: ended - receiveStarted, senderLeadMs: receiveStarted - started, sha256: actual };
  if (run >= 0) samples.push(sample);
  console.error(JSON.stringify(sample));
  await rm(directory, { recursive: true, force: true });
}
try {
  const versionConfig = join(work, 'version-config');
  await seedConfig(versionConfig);
  const versionCheck = launch(croc, ['--version'], { CROC_CONFIG_DIR: versionConfig });
  assert.equal(await childExit(versionCheck.child), 0, 'croc version check failed');
  assert.match(versionCheck.output() + versionCheck.error(), /\b11\.5\.4\b/, 'Expected official croc 11.5.4 binary');
  worker = await startWorker(work, { localOnly: true, env });
  const relays = { 'croc-4': await crocRelay(4), 'croc-1': await crocRelay(1) };
  for (const mib of sizes) {
    const source = join(work, 'payload.bin');
    const file = await open(source, 'w');
    try { for (let n = 0; n < mib; n++) await file.write(randomBytes(1024 * 1024)); } finally { await file.close(); }
    const expected = await digest(source);
    for (let run = -1; run < runs; run++) {
      // Rotate order, rather than always favoring one tool with a warmed host.
      for (let n = 0; n < names.length; n++) {
        const tool = names[(run + n + names.length) % names.length];
        await transfer(tool, mib, run, source, expected, relays[tool]);
      }
    }
  }
  const summaries = [];
  for (const mib of sizes) for (const tool of names) {
    const values = samples.filter(s => s.mib === mib && s.tool === tool).map(s => s.totalMs).sort((a,b) => a-b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    summaries.push({ tool, mib, runs: values.length, medianTotalMs: median, minTotalMs: values[0], maxTotalMs: values.at(-1), medianMiBPerSecond: mib * 1000 / median });
  }
  console.log(JSON.stringify({ scope: 'loopback relay, warm source cache; no WAN/device claim', crocVersion: '11.5.4', cdBinary: cdx, candidateBinary: candidate, workRoot, crocBinary: croc, compression: false, cpu: cpus()[0]?.model, affinity: (await readFile('/proc/self/status','utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1], timing: 'sender launch through both successful exits; external SHA256 verification excluded', caveat: 'CD v2 authenticates SHA256 and durable resume checkpoints; croc xxhash and write durability differ; Go toolchain versions may differ', summaries, samples }));
} finally {
  for (const child of children) await stopChild(child);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
