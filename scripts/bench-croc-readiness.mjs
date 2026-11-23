// Passive readiness diagnostic, separate from all product speed comparisons.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, stopChild } from './harness.mjs';

const version = '11.6.5';
const binarySHA256 = 'd6cde9a91bb16007e96355ef68b64da1b5cc714a8999c16e10d050f6407c5d5c';
const sources = [
  { name: 'croc.go', path: 'src/croc/croc.go', sha256: 'c3481ceef3fe6329c2ee8b1388c20dea2c3c7db01e5a50a1723d6a1dcff26914' },
  { name: 'tcp.go', path: 'src/tcp/tcp.go', sha256: '292153627553a32ba5c6863fb3591254054eaaf1bdc04ffbf786f7b84899a9aa' }
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

export function sourceOrdering(croc, tcp) {
  const begin = croc.indexOf('func (c *Client) Send(');
  assert.ok(begin >= 0, 'missing upstream Send implementation');
  const end = croc.indexOf('\nfunc ', begin + 5);
  const send = croc.slice(begin, end < 0 ? undefined : end);
  const displayed = send.indexOf('fmt.Fprint(output, formatSendInstructions(');
  const local = send.indexOf('c.setupLocalRelay()');
  const remote = send.indexOf('c.connectRelayControl(');
  assert.ok(displayed >= 0 && local > displayed && remote > displayed, 'upstream display/registration ordering changed');
  const admission = tcp.indexOf('admission := s.admitToRoom(room, c)');
  const created = tcp.indexOf('if admission.created {', admission);
  const admitted = tcp.indexOf('err = sendAdmission("ok")', created);
  const logged = tcp.indexOf('log.Debug("room has first peer")', admitted);
  assert.ok(admission >= 0 && created > admission && admitted > created && logged > admitted, 'upstream room admission log ordering changed');
  return {
    instructionsLine: lineAt(croc, begin + displayed),
    localSetupLine: lineAt(croc, begin + local),
    remoteConnectLine: lineAt(croc, begin + remote),
    roomAdmitLine: lineAt(tcp, admission),
    admissionReplyLine: lineAt(tcp, admitted),
    passiveMarkerLine: lineAt(tcp, logged),
    conclusion: 'Send prints complete instructions before local relay setup and remote relay connection. The passive relay marker follows room admission and its successful reply.'
  };
}

export function readinessObservation(code, now = () => performance.now()) {
  const started = now();
  const row = { codeDisplayedMs: null, roomRegisteredMs: null, senderText: '', relayText: '' };
  return {
    sender(text) {
      row.senderText += text;
      if (row.codeDisplayedMs === null && /On the other computer, run:|Code is:/.test(row.senderText) && row.senderText.includes(code)) row.codeDisplayedMs = now() - started;
    },
    relay(text) {
      row.relayText += text;
      if (row.roomRegisteredMs === null && row.relayText.includes('room has first peer')) row.roomRegisteredMs = now() - started;
    },
    get complete() { return row.codeDisplayedMs !== null && row.roomRegisteredMs !== null; },
    result() {
      return { ...row, observedRegistrationAfterDisplayMs: row.codeDisplayedMs === null || row.roomRegisteredMs === null ? null : row.roomRegisteredMs - row.codeDisplayedMs };
    }
  };
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function executable(command) {
  const candidates = command.includes('/') ? [resolve(command)] : (process.env.PATH || '').split(delimiter).map(root => join(root, command));
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch {} }
  throw new Error('croc executable unavailable');
}
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { child, stdout: '', stderr: '', done: false, error: null };
  result.closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { result.error = error; result.done = true; });
  child.once('close', () => { result.done = true; });
  for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => { result[name] += bytes.toString(); });
  return result;
}
async function stopped(process) {
  if (!process) return;
  if (process.child.pid) await stopChild(process.child);
  await Promise.race([process.closed, delay(1000)]);
}
async function listening(port, process, timeout) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (process.error) throw process.error;
    if (process.done) throw new Error('relay stopped before listening: ' + process.stderr);
    const ready = await new Promise(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(100);
      const finish = ok => { socket.destroy(); resolve(ok); };
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
    });
    if (ready) return;
    await delay(20);
  }
  throw new Error('relay startup timed out: ' + process.stderr);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('node scripts/bench-croc-readiness.mjs --croc /absolute/croc --runs 3 --output /absolute/readiness.json\nDiagnostic only: no receiver, no file transfer, no acceptance-speed ratios. The relay runs with --debug to expose its passive room-admission marker; the sender uses normal logging. Debug relay startup can perform an external-IP lookup and is outside observed sender timing. Raw logs include only this diagnostic synthetic invitation, terminated before exit.');
    return;
  }
  const opts = { croc: process.env.CD_BENCH_CROC || 'croc', runs: '3', timeout: '20000', output: resolve('croc-readiness.json') };
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(argv[i]?.startsWith('--') && argv[i + 1] && argv[i].slice(2) in opts, 'unknown/missing readiness option ' + argv[i]);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of ['runs', 'timeout']) { opts[name] = Number(opts[name]); assert.ok(Number.isSafeInteger(opts[name]) && opts[name] > 0); }
  const work = await mkdtemp(join(tmpdir(), 'croc-readiness-'));
  const report = {
    schema: 1, startedAt: new Date().toISOString(), options: opts, rows: [],
    method: 'Separate passive diagnostic. One pinned upstream croc relay, serial senders, no receiver and no transfer. Code-display observation is complete invitation text on the sender pipe; usable relay-registration observation is room has first peer on the relay pipe. Timestamps are Node receipt times, not synchronized internal process clocks; pipe scheduling can obscure or invert a tiny observed gap. Source ordering is checked independently. No elapsed time is added to the main matrix. No advertised-readiness metric or acceptance gate is changed.',
    caveats: [
      'Relay debug logging adds observation overhead and is not suitable for acceptance speed comparisons.',
      'Global --debug invokes an external-IP lookup; only the relay uses it, before sender timing.',
      'This measures the custom local relay registration, not public-relay availability or completion.',
      'Main matrix readyMs remains native invitation display; totalMs remains sender launch through durable completion.'
    ]
  };
  let relay, active, observation;
  let interrupted = null;
  const onInterrupt = signal => {
    interrupted = signal;
    void Promise.allSettled([stopped(active), stopped(relay)]);
  };
  const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM');
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  const output = resolve(opts.output);
  try {
    const croc = await executable(opts.croc);
    const actualSHA256 = await digest(croc);
    assert.equal(actualSHA256, binarySHA256, 'diagnostic requires checksum-pinned upstream croc 11.6.5');
    report.binary = { path: croc, sha256: actualSHA256, version: execFileSync(croc, ['--version'], { encoding: 'utf8' }).trim() };
    assert.equal(report.binary.version, 'croc version ' + version);
    report.runnerSHA256 = await digest(fileURLToPath(import.meta.url));
    report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    report.upstream = [];
    const code = {};
    for (const source of sources) {
      const url = 'https://raw.githubusercontent.com/schollz/croc/v' + version + '/' + source.path;
      const bytes = execFileSync('curl', ['-fsSL', '--max-time', '20', url], { maxBuffer: 1048576 });
      assert.equal(sha256(bytes), source.sha256, 'upstream source fingerprint changed: ' + url);
      code[source.name] = bytes.toString();
      report.upstream.push({ url, sha256: source.sha256 });
    }
    report.sourceOrdering = sourceOrdering(code['croc.go'], code['tcp.go']);
    const input = join(work, 'synthetic-readiness.txt'), payload = Buffer.from('croc readiness diagnostic only\n');
    await writeFile(input, payload);
    report.input = { bytes: payload.length, sha256: sha256(payload) };
    let port;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (interrupted) throw new Error('readiness diagnostic interrupted: ' + interrupted);
      const base = await availablePort();
      if (base > 65531) continue;
      relay = launch(croc, ['--debug', 'relay', '--host', '127.0.0.1', '--ports', [0, 1, 2, 3, 4].map(i => base + i).join(',')], process.env);
      try { await listening(base, relay, opts.timeout); port = base; break; }
      catch (error) { await stopped(relay); report.relaySetupFailures ??= []; report.relaySetupFailures.push({ error: error.message, stdout: relay.stdout, stderr: relay.stderr }); relay = null; }
    }
    assert.ok(port, 'could not start passive diagnostic relay');
    report.relay = { address: '127.0.0.1:' + port, flags: ['--debug', 'relay', '--host', '127.0.0.1'], timing: 'outside all sender observations' };
    for (const name of ['stdout', 'stderr']) relay.child[name].on('data', bytes => observation?.relay(bytes.toString()));
    for (let run = 0; run < opts.runs; run++) {
      if (interrupted) throw new Error('readiness diagnostic interrupted: ' + interrupted);
      const secret = randomBytes(12).toString('hex') + '-readiness';
      observation = readinessObservation(secret);
      const startedAt = new Date().toISOString();
      active = launch(croc, ['--ignore-stdin', '--relay', report.relay.address, '--relay6', report.relay.address, '--disable-clipboard', '--yes', '--overwrite', 'send', '--transport', 'relay', '--no-local', input], { ...process.env, CROC_SECRET: secret });
      for (const name of ['stdout', 'stderr']) active.child[name].on('data', bytes => observation?.sender(bytes.toString()));
      const deadline = performance.now() + opts.timeout;
      try {
        while (!observation.complete) {
          if (interrupted) throw new Error('readiness diagnostic interrupted: ' + interrupted);
          if (active.error) throw active.error;
          if (active.done) throw new Error('sender exited before both observations: ' + active.stderr);
          if (performance.now() >= deadline) throw new Error('readiness observations timed out');
          await delay(1);
        }
        report.rows.push({ run, startedAt, ok: true, ...observation.result() });
      } catch (error) {
        report.rows.push({ run, startedAt, ok: false, error: error.message, ...observation.result() });
      } finally {
        observation = null;
        await stopped(active);
        report.rows.at(-1).rawSender = { stdout: active.stdout, stderr: active.stderr, exitCode: active.child.exitCode, signal: active.child.signalCode, termination: 'intentionally stopped after passive observations; no transfer attempted' };
        active = null;
      }
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
  } catch (error) { report.error = error.stack; }
  finally {
    await stopped(active); await stopped(relay);
    if (relay) report.rawRelay = { stdout: relay.stdout, stderr: relay.stderr };
    await rm(work, { recursive: true, force: true });
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
    report.interrupted = interrupted;
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  if (report.error || interrupted || report.rows.length !== opts.runs || report.rows.some(row => !row.ok)) process.exitCode = 1;
  console.log(JSON.stringify({ output, error: report.error, rows: report.rows.map(({ run, ok, codeDisplayedMs, roomRegisteredMs, observedRegistrationAfterDisplayMs }) => ({ run, ok, codeDisplayedMs, roomRegisteredMs, observedRegistrationAfterDisplayMs })) }));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
