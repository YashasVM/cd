// Loopback protocol/CPU benchmark, not a WAN or maximum-bandwidth claim.
// node scripts/bench-croc-matrix.mjs --cdx /absolute/cdx --runs 5 --output /tmp/results.json
// Smoke: --cases random-4k --routes auto --storage tmpfs --runs 1
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, buildCLI, cliEnv, startWorker, stopChild } from './harness.mjs';

export const cases = Object.fromEntries(['random', 'compressible'].flatMap(kind => [['4k', 4096], ['1m', 1048576], ['64m', 67108864], ['256m', 268435456]].map(([size, bytes]) => [`${kind}-${size}`, { kind, bytes }])));
export function median(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function summarize(rows, runs) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.storage}/${row.route}/${row.case}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([caseKey, entries]) => {
    const tools = Object.fromEntries(['cd', 'croc', 'croc-no-compress'].map(tool => {
      const trials = entries.filter(row => row.tool === tool), good = trials.filter(row => row.ok);
      return [tool, { complete: trials.length === runs && good.length === runs, runs: trials.length, successful: good.length,
        ...Object.fromEntries(['readyMs', 'receiverMs', 'durableMs', 'totalMs'].map(metric => [metric, good.length ? median(good.map(row => row[metric])) : null])),
        spread: Object.fromEntries(['readyMs', 'receiverMs', 'durableMs', 'totalMs'].map(metric => [metric, good.length ? { min: Math.min(...good.map(row => row[metric])), max: Math.max(...good.map(row => row[metric])) } : null])) }];
    }));
    const complete = Object.values(tools).every(tool => tool.complete);
    const comparisons = Object.fromEntries(['croc', 'croc-no-compress'].map(tool => [tool, Object.fromEntries(['readyMs', 'receiverMs', 'durableMs', 'totalMs'].map(metric => [metric, complete ? tools[tool][metric] / tools.cd[metric] : null]))]));
    const ratios = Object.values(comparisons).flatMap(Object.values);
    return { case: caseKey, tools, speedup: comparisons, pass1_5: complete && ratios.every(value => value >= 1.5), pass2: complete && ratios.every(value => value >= 2) };
  });
}

function options(argv) {
  const opts = { cdx: process.env.CD_BENCH_CDX, croc: process.env.CD_BENCH_CROC || 'croc', runs: '5', cases: Object.keys(cases).join(','), routes: 'auto,relay', storage: 'disk,tmpfs', 'disk-dir': join(homedir(), '.cache'), 'tmpfs-dir': '/dev/shm', 'control-dir': '/dev/shm', timeout: '120000', output: resolve('cd-croc-matrix.json') };
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(argv[i].startsWith('--') && argv[i + 1] && argv[i].slice(2) in opts, `unknown/missing option ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ['runs', 'timeout']) { opts[key] = Number(opts[key]); assert.ok(Number.isInteger(opts[key]) && opts[key] > 0, `invalid ${key}`); }
  for (const key of ['cases', 'routes', 'storage']) opts[key] = [...new Set(opts[key].split(','))];
  assert.ok(opts.cases.every(key => key in cases), 'unknown payload case');
  assert.ok(opts.routes.every(key => ['auto', 'relay'].includes(key)), 'routes must be auto,relay');
  assert.ok(opts.storage.every(key => ['disk', 'tmpfs'].includes(key)), 'storage must be disk,tmpfs');
  if (opts.cdx) opts.cdx = resolve(opts.cdx);
  return opts;
}
const children = new Set();
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const result = { child, stdout: '', stderr: '', done: false, closedAt: null };
  for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => { result[name] = (result[name] + chunk).slice(-262144); });
  result.exit = new Promise((resolve, reject) => { child.once('error', error => { result.done = true; reject(error); }); child.once('close', code => { result.closedAt = performance.now(); result.done = true; children.delete(child); resolve(code); }); });
  result.exit.catch(() => {});
  return result;
}
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function ready(proc, test, timeout) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = test(proc.stdout + proc.stderr);
    if (value) return value;
    if (proc.done) throw new Error(`sender exited before ready: ${proc.stderr}`);
    if (performance.now() > deadline) throw new Error(`sender readiness timed out: ${proc.stdout}${proc.stderr}`);
    await delay(2);
  }
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function payload(path, spec) {
  const file = await open(path, 'w');
  try { for (let remaining = spec.bytes; remaining > 0;) {
    const size = Math.min(1048576, remaining), buffer = spec.kind === 'random' ? randomBytes(size) : Buffer.alloc(size, 65);
    let offset = 0;
    while (offset < buffer.length) offset += (await file.write(buffer, offset)).bytesWritten;
    remaining -= size;
  } await file.sync(); } finally { await file.close(); }
}
async function portReady(port, proc) {
  for (let i = 0; i < 100 && !proc.done; i++) {
    const ok = await new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.setTimeout(100); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
    if (ok) return true;
    await delay(50);
  }
  return false;
}
export async function trial({ tool, route, input, output, state, executable, croc, worker, relay, timeout, expected }, lifecycle = {}) {
  let sender, receiver;
  const started = performance.now();
  try {
    let code;
    const env = cliEnv(worker, { CD_STATE_DIR: state, CD_TRANSPORT_REPORT: '1', CD_DIRECT: route === 'relay' ? '0' : '1' });
    const secret = `${randomBytes(8).toString('hex')}-matrix-${process.pid}`;
    const flags = ['--ignore-stdin', '--relay', relay, '--relay6', relay, '--disable-clipboard', '--yes', '--overwrite', ...(tool === 'croc-no-compress' ? ['--no-compress'] : [])];
    const crocEnv = { ...process.env, CROC_SECRET: secret };
    if (tool === 'cd') {
      sender = launch(executable, ['send', '--wait', input], env);
      code = await ready(sender, text => text.match(/^(\d{4,5})\s*$/m)?.[1], timeout);
    } else {
      // croc 11.5.5 can use Tailcat even with --no-local. A forced-relay
      // diagnostic must disable both paths; auto retains the fastest default.
      sender = launch(croc, [...flags, 'send', ...(route === 'relay' ? ['--no-local', '--transport', 'relay'] : []), input], crocEnv);
      await ready(sender, text => /Code is:|On the other computer, run:/.test(text), timeout);
    }
    const receiverStarted = performance.now();
    receiver = tool === 'cd' ? launch(executable, ['receive', code, '--out', output], env) : launch(croc, [...flags, '--out', output], crocEnv);
    assert.equal(await bounded(receiver.exit, timeout, 'receiver'), 0, receiver.stderr);
    const received = receiver.closedAt;
    const target = join(output, 'payload.bin');
    // Optional barriers let offline tests order real process closes against
    // durability without replacing the monotonic clock or guessing fsync time.
    if (lifecycle.beforeDurable) await bounded(lifecycle.beforeDurable({ senderExit: sender.exit }), timeout, 'before durability hook');
    // Equalize durable output: file and containing directory fsync for BOTH tools.
    for (const path of [target, output]) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
    const durable = performance.now();
    if (lifecycle.afterDurable) await bounded(lifecycle.afterDurable(), timeout, 'after durability hook');
    assert.equal(await bounded(sender.exit, timeout, 'sender'), 0, sender.stderr);
    // Capture the lifecycle timestamp, not the time we happen to await it.
    // The sender may finish either before or after receiver durability.
    const completed = Math.max(durable, sender.closedAt);
    const verifyStarted = performance.now(), actual = await digest(target);
    assert.equal(actual, expected, 'SHA256 mismatch');
    const text = sender.stderr + '\n' + receiver.stderr;
    const reports = [];
    if (tool === 'cd') for (const [endpoint, process] of Object.entries({ sender, receiver })) {
      const evidence = process.stderr.split('\n').flatMap(line => { try { const item = JSON.parse(line); return item?.transport ? [{ ...item, endpoint }] : []; } catch { return []; } });
      assert.equal(evidence.length, 1, `${endpoint} transport evidence missing or ambiguous`);
      const report = evidence[0];
      assert.ok(['relay', 'direct'].includes(report.transport)
        && [report.relayBytes, report.directBytes].every(value => Number.isSafeInteger(value) && value >= 0)
        && (report.relayBytes > 0 || report.directBytes > 0)
        && (report.transport === 'direct') === (report.directBytes > 0), `${endpoint} transport evidence invalid`);
      if (route === 'relay') assert.ok(report.transport === 'relay' && report.directBytes === 0, `${endpoint} forced relay used direct bytes`);
      reports.push(report);
    }
    return { ok: true, routeObserved: reports.length ? [...new Set(reports.map(report => report.transport))].join(',') : 'unconfirmed; see textual route evidence', readyMs: receiverStarted - started, receiverMs: received - receiverStarted, durableMs: durable - receiverStarted, senderExitMs: sender.closedAt - started, totalMs: completed - started, verificationMs: performance.now() - verifyStarted, sha256: actual, reports,
      routeEvidence: text.split(/[\r\n]+/).filter(line => /switched to|connecting|connected|local|relay/i.test(line)), diagnostics: { sender: sender.stderr, receiver: receiver.stderr } };
  } catch (error) { return { ok: false, error: error.message, diagnostics: { sender: sender?.stderr, receiver: receiver?.stderr } }; }
  finally { await Promise.all([stopChild(sender?.child), stopChild(receiver?.child)]); }
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node scripts/bench-croc-matrix.mjs [options]
  --cdx PATH         Already-built CD binary, otherwise build checkout (CD_BENCH_CDX)
  --croc PATH        croc binary, default croc (CD_BENCH_CROC)
  --runs N           Repetitions per tool/case, default 5
  --cases LIST       random-4k,random-1m,random-256m,compressible-4k,compressible-1m,compressible-256m
  --routes LIST      auto,relay (default both); auto allows direct and fallback
  --storage LIST     disk,tmpfs (default both)
  --disk-dir PATH    Disk workspace parent, default ~/.cache
  --tmpfs-dir PATH   Verified tmpfs workspace parent, default /dev/shm
  --control-dir PATH Local Worker SQLite/control parent, default /dev/shm (must exist)
  --timeout MS       Per-process/readiness timeout, default 120000
  --output PATH      JSON report, default ./cd-croc-matrix.json
Without CD_VERIFY_URL this uses scripts/bench-worker.wrangler.jsonc locally.
CD_VERIFY_WRANGLER_CONFIG selects a different explicit local experiment config.
NEVER deploy that benchmark config. Hosted Workers retain their own limits.
Control infrastructure defaults to RAM for BOTH disk and tmpfs output suites.
Use --control-dir ~/.cache for a separate disk-infrastructure diagnostic.
SHA256 verification is outside timings; durable timing fsyncs file and directory.
Total timing includes both process closes and receiver durability, not just receipt.
Forced relay requires croc send --transport relay (verified with croc 11.5.5).
Unsupported croc binaries fail rather than silently use a different transport.
Speed gates in JSON require all metrics against both croc variants.
Exit 1 indicates setup/transfer failure; speed gate failure alone exits 0.`);
    return;
  }
  const opts = options(argv), rows = [], roots = [];
  let worker, relayProcess;
  const interrupt = async signal => {
    await Promise.all([...children].map(stopChild));
    await worker?.stop();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const sigint = () => { void interrupt('SIGINT'); }, sigterm = () => { void interrupt('SIGTERM'); };
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  const metadata = command => spawnSync(command[0], command.slice(1), { encoding: 'utf8' }).stdout?.trim();
  const report = { version: 2, startedAt: new Date().toISOString(), options: opts,
    source: { commit: metadata(['git', 'rev-parse', 'HEAD']), dirty: metadata(['git', 'status', '--porcelain']), diffSha256: createHash('sha256').update(spawnSync('git', ['diff', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 }).stdout || '').digest('hex'), note: 'Dirty listing includes untracked files; diff hash includes tracked files only. Binary SHA256 identifies the tested CD executable.' },
    environment: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model, cores: cpus().length,
      transferFlags: Object.fromEntries(['CD_LAN', 'CD_WEBRTC', 'CD_LARGE_RECORDS', 'CD_LAN_GRACE', 'CD_RELAY_STREAMING'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) },
    method: { topology: 'same-host loopback, local relays; auto retains default transport selection and allows direct discovery and fallback. Forced relay is a separate diagnostic; croc uses send --no-local --transport relay, verified with 11.5.5. CD requires valid route counters from both endpoints; direct means some encrypted records used that route, not necessarily all payload.', timing: 'readyMs: sender launch to receiver launch; receiverMs: receiver launch to receiver process close; durableMs: receiver launch through file and directory fsync; senderExitMs: sender launch to sender process close; totalMs: sender launch through both process closes and receiver durability. Version 1 totalMs omitted sender tail time.', durability: 'receiver exit measured separately; timed durable completion adds file fsync and directory fsync equally to both tools. Internal tool fsync differences remain part of native completion.', verification: 'SHA256 every output outside all reported transfer timings', cache: 'warm input/page cache, output deleted after SHA256; sync before each trial; no privileged cache dropping; no excluded process or transport warmup trials', limits: 'No WAN, packet-loss, browser, concurrency, directory-tree or cross-host claims. tmpfs fsync does not represent physical persistence. croc auto telemetry is textual and does not prove direct routing.' }, rows };
  try {
    await mkdir(opts['disk-dir'], { recursive: true });
    assert.ok((await stat(opts['control-dir'])).isDirectory(), '--control-dir must be an existing writable directory; default /dev/shm requires RAM storage, or choose another directory explicitly');
    const controlFilesystem = metadata(['stat', '-f', '-c', '%T', opts['control-dir']]);
    assert.ok(controlFilesystem, 'cannot determine --control-dir filesystem');
    if (resolve(opts['control-dir']) === '/dev/shm') assert.equal(controlFilesystem, 'tmpfs', 'default /dev/shm is not tmpfs; choose --control-dir explicitly');
    const control = await mkdtemp(join(opts['control-dir'], 'cd-matrix-control-')); roots.push(control);
    report.infrastructure = { controlParent: resolve(opts['control-dir']), filesystem: controlFilesystem,
      storage: controlFilesystem === 'tmpfs' ? 'RAM' : 'disk or other filesystem', localWorkerPersistence: process.env.CD_VERIFY_URL ? null : join(control, 'wrangler-state'),
      note: 'Local Worker SQLite persistence uses this infrastructure directory for both disk and tmpfs payload suites. Disk output remains on --disk-dir. Compare --control-dir on disk as a separate infrastructure diagnostic.' };
    // /dev/shm is commonly noexec, so keep newly built executables on disk.
    let executable = opts.cdx;
    if (!executable) {
      const buildRoot = await mkdtemp(join(opts['disk-dir'], 'cd-matrix-build-')); roots.push(buildRoot);
      executable = await buildCLI(buildRoot);
    }
    report.binary = { cdx: executable, sha256: await digest(executable), croc: metadata([opts.croc, '--version']) };
    const previousConfig = process.env.CD_VERIFY_WRANGLER_CONFIG;
    if (!process.env.CD_VERIFY_URL && !previousConfig) process.env.CD_VERIFY_WRANGLER_CONFIG = fileURLToPath(new URL('./bench-worker.wrangler.jsonc', import.meta.url));
    report.worker = { hosted: Boolean(process.env.CD_VERIFY_URL), config: process.env.CD_VERIFY_URL ? null : process.env.CD_VERIFY_WRANGLER_CONFIG };
    try { worker = await startWorker(control); }
    finally {
      if (previousConfig === undefined) delete process.env.CD_VERIFY_WRANGLER_CONFIG;
      else process.env.CD_VERIFY_WRANGLER_CONFIG = previousConfig;
    }
    let relay;
    for (let attempt = 0; attempt < 5 && !relay; attempt++) {
      const base = await availablePort();
      if (base > 65531) continue;
      // croc 11.5.5 defaults to 30 room joins per source per minute.
      // These serial local trials intentionally exceed that admission rate.
      relayProcess = launch(opts.croc, ['relay', '--host', '127.0.0.1', '--ports', [0, 1, 2, 3, 4].map(n => base + n).join(',')], { ...process.env, CROC_SOURCE_JOIN_LIMIT: '100000', CROC_ROOM_JOIN_LIMIT: '100000' });
      if (await portReady(base, relayProcess)) relay = `127.0.0.1:${base}`;
      else await stopChild(relayProcess.child);
    }
    assert.ok(relay, 'croc relay did not start');
    for (const storage of opts.storage) {
      const root = await mkdtemp(join(opts[`${storage === 'disk' ? 'disk' : 'tmpfs'}-dir`], 'cd-matrix-')); roots.push(root);
      if (storage === 'tmpfs') assert.equal(metadata(['stat', '-f', '-c', '%T', root]), 'tmpfs', '--tmpfs-dir must be a tmpfs filesystem');
      for (const name of opts.cases) {
        const input = join(root, 'payload.bin'); await payload(input, cases[name]); const expected = await digest(input);
        for (const route of opts.routes) for (let run = 0; run < opts.runs; run++) {
          const tools = ['cd', 'croc', 'croc-no-compress'];
          // Rotate first position each repetition rather than favoring CD with fixed order.
          const order = tools.slice(run % 3).concat(tools.slice(0, run % 3));
          for (const tool of order) {
            const output = await mkdtemp(join(root, 'receive-'));
            const flush = spawnSync('sync'); assert.equal(flush.status, 0, 'sync failed');
            const result = await trial({ tool, route, input, output, state: join(root, `state-${name}-${route}-${run}-${tool}`), executable, croc: opts.croc, worker, relay, timeout: opts.timeout, expected });
            rows.push({ tool, route, storage, case: name, bytes: cases[name].bytes, run, ...result });
            await rm(output, { recursive: true, force: true });
            console.error(`${storage}/${route}/${name} ${tool} #${run + 1}: ${result.ok ? `${result.durableMs.toFixed(2)} ms durable` : result.error}`);
            report.summary = summarize(rows, opts.runs); await writeFile(opts.output, JSON.stringify(report, null, 2) + '\n');
          }
        }
        await rm(input);
      }
    }
  } catch (error) { report.error = error.stack; }
  finally {
    await Promise.all([...children].map(stopChild)); await worker?.stop();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    report.summary = summarize(rows, opts.runs); report.finishedAt = new Date().toISOString();
    report.pass1_5 = !report.error && report.summary.length === opts.storage.length * opts.routes.length * opts.cases.length && report.summary.every(item => item.pass1_5);
    report.pass2 = report.pass1_5 && report.summary.every(item => item.pass2);
    await writeFile(opts.output, JSON.stringify(report, null, 2) + '\n');
  }
  process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  console.log(JSON.stringify({ output: opts.output, pass1_5: report.pass1_5, pass2: report.pass2, error: report.error }));
  if (report.error || rows.some(row => !row.ok)) process.exitCode = 1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
