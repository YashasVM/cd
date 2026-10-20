// Physical-LAN diagnostic. Never replaces installed binaries. Run only while
// this PC and the remote host are otherwise idle; loopback gates are separate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker, stopChild } from './harness.mjs';

const options = { cdx: process.env.CD_BENCH_CDX || '', croc: process.env.CD_BENCH_CROC || 'croc', remote: 'yvm@192.168.1.8', address: '192.168.1.8', mib: '64', runs: '3', 'require-tcp': '1', timeout: '180000', output: resolve('cd-croc-lan.json') };
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/bench-croc-lan.mjs --cdx /absolute/candidate [--croc PATH] [--remote yvm@192.168.1.8] [--address 192.168.1.8] [--mib 64] [--runs 3] [--require-tcp 1] [--timeout 180000] [--output report.json]\nStages private binaries under remote ~/cd-bench-20261020. Requires remote python3, setsid, sha256sum and working SSH/SCP. Uses a private remote croc relay and local Worker via reverse SSH for CD rendezvous. Bulk CD traffic must show authenticated direct-lane telemetry. Receiver timing includes SSH launch; remote SHA256 runs outside timing. No WAN claims.');
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert.ok(key in options && process.argv[i + 1], `unknown/missing option ${process.argv[i]}`);
  options[key] = process.argv[i + 1];
}
assert.ok(options.cdx, '--cdx is required');
for (const key of ['runs', 'mib', 'timeout']) { options[key] = Number(options[key]); assert.ok(Number.isInteger(options[key]) && options[key] > 0, `invalid ${key}`); }
assert.match(options.remote, /^[\w.@:-]+$/, 'invalid SSH destination');
assert.match(options.address, /^[\d.]+$/, 'IPv4 relay address required');
assert.ok(['0','1'].includes(options['require-tcp']), '--require-tcp must be 0 or 1');
options.cdx = resolve(options.cdx);
if (!options.croc.includes('/')) {
  const found = spawnSync('which', [options.croc], { encoding: 'utf8' });
  assert.equal(found.status, 0, 'croc not found'); options.croc = found.stdout.trim();
}
options.croc = resolve(options.croc);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const password = randomBytes(32).toString('hex');
const redact = value => String(value || '').replaceAll(password, '[ephemeral relay password]');
const children = new Set();
function launch(command, args, { env = process.env, input = null } = {}) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
  const result = { child, stdout: '', stderr: '', done: false };
  for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => { result[key] = (result[key] + redact(chunk)).slice(-262144); });
  result.exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { result.done = true; children.delete(child); resolve(code); }); }); result.exit.catch(() => {});
  if (input !== null) child.stdin.end(input); else child.stdin.end();
  return result;
}
async function bounded(promise, label) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), options.timeout); })]); } finally { clearTimeout(timer); }
}
async function success(proc, label) { assert.equal(await bounded(proc.exit, label), 0, `${label}: ${proc.stderr}`); return proc.stdout; }
const sshFlags = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
function remote(script) { return launch('ssh', [...sshFlags, options.remote, 'sh -s'], { input: script + '\n' }); }
async function remoteRun(script) { return success(remote(script), 'SSH command'); }
async function hash(path) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
async function ready(proc, predicate) {
  const deadline = performance.now() + Math.min(options.timeout, 30000);
  for (;;) {
    const result = predicate(proc.stdout + proc.stderr); if (result) return result;
    if (proc.done || performance.now() > deadline) throw new Error(`sender not ready: ${proc.stdout}${proc.stderr}`);
    await delay(5);
  }
}
const report = { version: 1, date: new Date().toISOString(), options, rows: [], method: {
  topology: 'PC sender to Ubuntu receiver over physical LAN. CD uses a local Worker through reverse SSH only for rendezvous/fallback; CD actual transport telemetry is recorded; default strict mode requires TCP direct bytes. --require-tcp0 permits annotated fallback diagnostics. croc uses a private TCP relay on the receiver machine with --no-local. Both carry bulk bytes over the LAN once; their rendezvous topology differs.',
  timing: 'Receiver duration starts before SSH receiver launch, ends after receiver process exits. Durable duration also includes remote file and output-directory fsync before SSH exits. Readiness and total measured separately. SHA256 verification runs over a separate SSH command outside all transfer timings.',
  limitations: 'Three trials by default, one physical LAN, no WAN/browser/concurrency claim. Both tools use identical staged binaries at both ends. croc default and no-compress both measured. Remote infrastructure uses disk, local Worker SQLite uses RAM. SSH launch overhead is present in each receiver duration.',
  durability: 'Native receiver exit observed by remote launcher; file/directory fsync added equally for both tools. Existing internal fsync differences remain included.' } };
let work, control, remoteRoot, worker, relay, tunnel;
let cleaning = false;
async function cleanup() {
  if (cleaning) return; cleaning = true;
  // Receiver and relay own setsid groups; close them before dropping SSH control.
  if (remoteRoot) {
    const cleanupCommand = remote(`for marker in ${quote(remoteRoot)}/*.pid; do
[ -f "$marker" ] || continue
pid=$(cat "$marker")
case "$pid" in ''|*[!0-9]*) continue;; esac
/bin/kill -TERM -- "-$pid" 2>/dev/null || true
done
sleep 0.2
for marker in ${quote(remoteRoot)}/*.pid; do
[ -f "$marker" ] || continue
pid=$(cat "$marker")
case "$pid" in ''|*[!0-9]*) continue;; esac
/bin/kill -KILL -- "-$pid" 2>/dev/null || true
done
rm -rf -- ${quote(remoteRoot)}`);
    try { await success(cleanupCommand, 'remote cleanup'); } catch (error) { report.cleanupError = error.message; await stopChild(cleanupCommand.child); }
  }
  await Promise.all([...children].map(stopChild)); await worker?.stop();
  if (work) await rm(work, { recursive: true, force: true });
  if (control) await rm(control, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(async () => { report.interrupted = signal; await writeFile(options.output, JSON.stringify(report, null, 2)); process.exit(signal === 'SIGINT' ? 130 : 143); }); });
try {
  await mkdir(join(homedir(), '.cache'), { recursive: true });
  work = await mkdtemp(join(homedir(), '.cache', 'cd-lan-bench-'));
  control = await mkdtemp('/dev/shm/cd-lan-control-');
  const input = join(work, 'payload.bin'), file = await open(input, 'w');
  try { for (let i = 0; i < options.mib; i++) { const chunk = randomBytes(1048576); let offset = 0; while (offset < chunk.length) offset += (await file.write(chunk, offset)).bytesWritten; } await file.sync(); } finally { await file.close(); }
  const expected = await hash(input);
  const localVersion = spawnSync(options.croc, ['--version'], { encoding: 'utf8' }); assert.equal(localVersion.status, 0); assert.ok(localVersion.stdout.trim(), 'missing croc version');
  report.binaries = { cdSha256: await hash(options.cdx), crocSha256: await hash(options.croc), crocVersion: localVersion.stdout.trim() };
  remoteRoot = (await remoteRun('set -eu\nmkdir -p "$HOME/cd-bench-20261020"\nmktemp -d "$HOME/cd-bench-20261020/run-XXXXXXXX"')).trim();
  assert.ok(remoteRoot.startsWith('/') && !remoteRoot.includes('\n'), 'invalid remote workspace');
  await success(launch('scp', ['-q', options.cdx, `${options.remote}:${remoteRoot}/cdx`]), 'copy CD');
  await success(launch('scp', ['-q', options.croc, `${options.remote}:${remoteRoot}/croc`]), 'copy croc');
  await remoteRun(`set -eu\nchmod 700 ${quote(remoteRoot + '/cdx')} ${quote(remoteRoot + '/croc')}\nsha256sum ${quote(remoteRoot + '/cdx')} ${quote(remoteRoot + '/croc')}` ).then(text => {
    assert.ok(text.includes(report.binaries.cdSha256) && text.includes(report.binaries.crocSha256), 'staged binary hashes differ');
  });
  const ports = JSON.parse(await remoteRun(`python3 - <<'PY'
import socket,random,json
for attempt in range(100):
 base=random.randint(20000,59990)
 sockets=[]
 try:
  for port in range(base,base+6):
   s=socket.socket();s.bind(('0.0.0.0',port));sockets.append(s)
  print(json.dumps({'relay':base,'forward':base+5}));break
 except OSError: pass
 finally:
  for s in sockets:s.close()
else: raise RuntimeError('no consecutive relay ports')
PY`));
  const previousConfig = process.env.CD_VERIFY_WRANGLER_CONFIG;
  const previousHosted = process.env.CD_VERIFY_URL;
  delete process.env.CD_VERIFY_URL;
  process.env.CD_VERIFY_WRANGLER_CONFIG = fileURLToPath(new URL('./bench-worker.wrangler.jsonc', import.meta.url));
  try { worker = await startWorker(control); } finally {
    if (previousConfig === undefined) delete process.env.CD_VERIFY_WRANGLER_CONFIG; else process.env.CD_VERIFY_WRANGLER_CONFIG = previousConfig;
    if (previousHosted !== undefined) process.env.CD_VERIFY_URL = previousHosted;
  }
  tunnel = launch('ssh', [...sshFlags, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${ports.forward}:127.0.0.1:${new URL(worker.publicBase).port}`, options.remote]);
  await remoteRun(`python3 - <<'PY'
import urllib.request,time
for attempt in range(100):
 try:
  assert urllib.request.urlopen('http://127.0.0.1:${ports.forward}/api/health',timeout=1).status==200
  break
 except Exception:time.sleep(.1)
else:raise RuntimeError('reverse SSH worker unavailable')
PY`);
  const relayAddress = `${options.address}:${ports.relay}`;
  relay = remote(`set -eu
setsid env CROC_SOURCE_JOIN_LIMIT=100000 CROC_PASS=${quote(password)} ${quote(remoteRoot + '/croc')} relay --host 0.0.0.0 --ports ${[0,1,2,3,4].map(n => ports.relay+n).join(',')} </dev/null &
pid=$!
printf '%s' "$pid" > ${quote(remoteRoot + '/relay.pid')}
trap '/bin/kill -TERM -- "-$pid" 2>/dev/null || true' EXIT HUP INT TERM
wait "$pid"`);
  await remoteRun(`python3 - <<'PY'
import socket,time
for attempt in range(100):
 try:
  s=socket.create_connection(('127.0.0.1',${ports.relay}),1);s.close();break
 except OSError:time.sleep(.1)
else:raise RuntimeError('private croc relay unavailable')
PY`);
  report.infrastructure = { remoteRoot, relayAddress, localWorkerStorage: 'tmpfs', remoteWorkerForward: `127.0.0.1:${ports.forward}`, relayPassword: 'ephemeral, redacted, never persisted' };
  for (let run = 0; run < options.runs; run++) {
    const tools = ['cd', 'croc', 'croc-no-compress'], order = tools.slice(run%3).concat(tools.slice(0,run%3));
    for (const tool of order) {
      const output = `${remoteRoot}/out-${run}-${tool}`, marker = `${remoteRoot}/receiver-${run}-${tool}.pid`;
      await remoteRun(`mkdir ${quote(output)}\nsync`); assert.equal(spawnSync('sync').status, 0, 'local sync failed');
      const secret = `lan-${randomBytes(12).toString('hex')}`;
      const flags = ['--ignore-stdin', '--relay', relayAddress, '--relay6', relayAddress, '--disable-clipboard', '--yes', '--overwrite', ...(tool === 'croc-no-compress' ? ['--no-compress'] : [])];
      let sender, receiver;
      const started = performance.now();
      try {
        sender = tool === 'cd' ? launch(options.cdx, ['send','--wait',input], { env: { ...process.env, CD_STATE_DIR: join(work,`state-${run}`), CD_RELAY_URL: worker.relayBase, CD_PUBLIC_URL: worker.publicBase, CD_TRANSPORT_REPORT: '1', CD_DIRECT: '1', CD_LAN: '1' } }) : launch(options.croc, [...flags,'send','--no-local',input], { env: { ...process.env, CROC_SECRET: secret, CROC_PASS: password } });
        const code = await ready(sender, text => tool === 'cd' ? text.match(/^(\d{4,5})\s*$/m)?.[1] : /Code is:|On the other computer, run:/.test(text) ? secret : null);
        const receiverStart = performance.now();
        const command = tool === 'cd' ? ['env', `CD_RELAY_URL=ws://127.0.0.1:${ports.forward}/ws/v1`, `CD_PUBLIC_URL=http://127.0.0.1:${ports.forward}`, 'CD_TRANSPORT_REPORT=1', 'CD_DIRECT=1', 'CD_LAN=1', `CD_STATE_DIR=${remoteRoot}/state`, remoteRoot+'/cdx','receive',code,'--out',output] : ['env',`CROC_SECRET=${secret}`,`CROC_PASS=${password}`,remoteRoot+'/croc',...flags,'--out',output];
        // Python owns the child process group and reports the native-exit instant
        // before equalized fsync, so both measurements share the same SSH launch.
        const python = `import subprocess,os,time,json,signal\ncommand=${JSON.stringify(command)}\np=subprocess.Popen(command,start_new_session=True,stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(marker)},'w').write(str(p.pid))\ndef stop(sig,frame):\n try:os.killpg(p.pid,signal.SIGTERM)\n except ProcessLookupError:pass\n try:p.wait(timeout=2)\n except subprocess.TimeoutExpired:\n  os.killpg(p.pid,signal.SIGKILL)\n  p.wait()\n raise SystemExit(128+sig)\nsignal.signal(signal.SIGTERM,stop)\nsignal.signal(signal.SIGHUP,stop)\ntry:\n code=p.wait()\n native=time.monotonic()\n if code:raise SystemExit(code)\n for path in [${JSON.stringify(output+'/payload.bin')},${JSON.stringify(output)}]:\n  fd=os.open(path,os.O_RDONLY)\n  try:os.fsync(fd)\n  finally:os.close(fd)\n print('CD_BENCH_TIMING '+json.dumps({'postExitFsyncMs':(time.monotonic()-native)*1000}))\nfinally:\n try:os.unlink(${JSON.stringify(marker)})\n except FileNotFoundError:pass\n`;
        receiver = remote(`python3 - <<'PY'
${python}PY`);
        await success(receiver, 'receiver'); const finished = performance.now();
        await success(sender, 'sender');
        const timing = JSON.parse(receiver.stdout.match(/CD_BENCH_TIMING (.*)/)?.[1] || '{}');
        assert.ok(Number.isFinite(timing.postExitFsyncMs), 'missing fsync timing');
        const verifyStart = performance.now();
        const actual = (await remoteRun(`sha256sum ${quote(output+'/payload.bin')}`)).split(/\s/)[0]; assert.equal(actual, expected, 'remote SHA256 mismatch');
        const diagnostics = { sender: sender.stderr, receiver: receiver.stderr };
        const reports = (sender.stderr+'\n'+receiver.stderr).split('\n').flatMap(line => { try { const item = JSON.parse(line); return item.transport ? [item] : []; } catch { return []; } });
        const tcpGate = tool === 'cd' ? reports.length >= 2 && reports.every(item => item.directBytes > 0 && item.directProtocol === 'tcp') : null;
        if (tool === 'cd' && options['require-tcp'] === '1') assert.ok(tcpGate, 'CD actual TCP-lane telemetry missing; LAN row invalid');
        report.rows.push({ tool, run, ok: true, bytes: options.mib*1048576, readyMs: receiverStart-started, receiverMs: finished-receiverStart-timing.postExitFsyncMs, durableMs: finished-receiverStart, totalMs: finished-started, sha256: actual, verificationMs: performance.now()-verifyStart, tcpGate, reports, diagnostics });
      } catch (error) { report.rows.push({ tool, run, ok: false, error: redact(error.stack), diagnostics: { sender: sender?.stderr, receiver: receiver?.stderr } }); }
      finally {
        await Promise.all([stopChild(sender?.child),stopChild(receiver?.child)]);
        if (!report.rows.at(-1)?.ok) {
          // A disconnected SSH process may leave its remote child behind.
          await remoteRun(`if [ -f ${quote(marker)} ]; then
pid=$(cat ${quote(marker)})
case "$pid" in ''|*[!0-9]*) exit 1;; esac
/bin/kill -TERM -- "-$pid" 2>/dev/null || true
sleep 0.2
/bin/kill -KILL -- "-$pid" 2>/dev/null || true
rm -f ${quote(marker)}
fi`);
        }
      }
      console.error(`${tool} #${run+1}: ${report.rows.at(-1).ok ? report.rows.at(-1).durableMs.toFixed(1)+' ms durable' : report.rows.at(-1).error}`);
      await writeFile(options.output, JSON.stringify(report,null,2)+'\n');
      // Includes per-trial outputs and CD state; final cleanup removes binaries.
      await remoteRun(`rm -rf -- ${quote(output)}`);
    }
  }
} catch (error) { report.error = redact(error.stack); }
finally {
  await cleanup(); report.finishedAt = new Date().toISOString();
  const median = numbers => { const sorted = [...numbers].sort((a,b)=>a-b), m=Math.floor(sorted.length/2); return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2; };
  report.summary = Object.fromEntries(['cd','croc','croc-no-compress'].map(tool => { const rows=report.rows.filter(row=>row.tool===tool && row.ok); return [tool,{ runs:rows.length, complete:rows.length===options.runs, ...Object.fromEntries(['readyMs','receiverMs','durableMs','totalMs'].map(key=>[key,rows.length?median(rows.map(row=>row[key])):null])) }]; }));
  const complete = !report.error && !report.cleanupError && Object.values(report.summary).every(item => item.complete);
  report.speedup = Object.fromEntries(['croc', 'croc-no-compress'].map(tool => [tool, Object.fromEntries(['readyMs', 'receiverMs', 'durableMs', 'totalMs'].map(metric => [metric, complete ? report.summary[tool][metric] / report.summary.cd[metric] : null]))]));
  const ratios = Object.values(report.speedup).flatMap(Object.values);
  report.tcpGate = complete && report.rows.filter(row => row.tool === 'cd').every(row => row.tcpGate);
  report.pass1_5 = complete && ratios.every(ratio => ratio >= 1.5);
  report.pass2 = complete && ratios.every(ratio => ratio >= 2);
  await writeFile(options.output,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({output:options.output,error:report.error,cleanupError:report.cleanupError}));
if (report.error || report.cleanupError || report.rows.some(row=>!row.ok)) process.exitCode=1;
