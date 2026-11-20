import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const { startWorker, cliEnv, stopChild, childExit } = await import(pathToFileURL(resolve('scripts/harness.mjs')));
const output = resolve(process.argv[2] || '/workspace/work/relay-profile');
await mkdir(output, { recursive: true });
const mib = Number(process.env.CD_PROFILE_MIB || 512), children = [];
const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const input = join(output, 'payload.bin'), target = join(output, 'received.bin');
let worker;
const report = { method: 'CPU diagnosis only: tagged Go test binary profiles the actual CLI for one forced-relay transfer through the unchanged Wrangler development proxy. Profiler/test-harness startup and shutdown are included, so timings MUST NOT be used as a performance comparison. Full input/output SHA256 verifies bytes.', mib, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), processes: {}, ticksPerSecond: ticks };
async function digest(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
report.binarySHA256 = await digest('/workspace/work/cdx-profile.test');
report.diffSHA256 = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex');
report.sourceSHA256 = Object.fromEntries(await Promise.all(['cmd/cdx/link.go', 'cmd/cdx/receive.go', 'cmd/cdx/retry.go', 'cmd/cdx/compression.go', 'worker/index.ts'].map(async name => [name, await digest(name)])));
function processList() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return match && { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  }).filter(Boolean);
}
async function snapshot(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { cpuTicks: Number(fields[11]) + Number(fields[12]), rssPages: Number(fields[21]) };
}
function launch(role, args) {
  const child = spawn('/workspace/work/cdx-profile.test', ['-test.run=^TestProfileCLI$', `-test.cpuprofile=${join(output, role + '.cpu.pprof')}`, `-test.memprofile=${join(output, role + '.mem.pprof')}`], {
    env: cliEnv(worker, { CD_PROFILE_ARGS: JSON.stringify(args), CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1', CD_STATE_DIR: join(output, 'state') }), stdio: ['ignore', 'pipe', 'pipe']
  });
  const proc = { child, stdout: '', stderr: '' }; children.push(proc);
  child.stdout.on('data', chunk => { proc.stdout += chunk; }); child.stderr.on('data', chunk => { proc.stderr += chunk; });
  return proc;
}
try {
  const file = await open(input, 'w');
  try { for (let i = 0; i < mib; i++) await file.writeFile(randomBytes(1048576)); } finally { await file.close(); }
  report.inputSHA256 = await digest(input);
  process.env.CD_VERIFY_WRANGLER_CONFIG = resolve('scripts/bench-worker.wrangler.jsonc');
  worker = await startWorker(output);
  const all = processList(); const descendants = new Set([process.pid]);
  for (let changed = true; changed;) { changed = false; for (const p of all) if (descendants.has(p.ppid) && !descendants.has(p.pid)) { descendants.add(p.pid); changed = true; } }
  for (const proc of all.filter(p => descendants.has(p.pid) && /workerd|wrangler-dist/.test(p.command))) {
    report.processes[proc.pid] = { command: proc.command, before: await snapshot(proc.pid) };
  }
  const start = performance.now();
  const sender = launch('sender', ['send', '--wait', input]);
  let code;
  for (let i = 0; !code; i++) { assert.ok(i < 3000, 'sender readiness timeout'); assert.equal(sender.child.exitCode, null, sender.stderr); code = sender.stdout.match(/^(\d{4,5})\s*$/m)?.[1]; if (!code) await delay(10); }
  const receiver = launch('receiver', ['receive', code, '--out', target]);
  assert.equal(await childExit(receiver.child, 120000), 0, receiver.stderr);
  assert.equal(await childExit(sender.child, 120000), 0, sender.stderr);
  report.instrumentedElapsedMs = performance.now() - start;
  for (const [pid, entry] of Object.entries(report.processes)) {
    try { entry.after = await snapshot(pid); entry.cpuSeconds = (entry.after.cpuTicks - entry.before.cpuTicks) / ticks; } catch (error) { entry.error = error.message; }
  }
  report.outputSHA256 = await digest(target); assert.equal(report.outputSHA256, report.inputSHA256);
  report.verified = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  for (const proc of children) { await stopChild(proc.child); await writeFile(join(output, `${proc.child.pid}.stdout.log`), proc.stdout); await writeFile(join(output, `${proc.child.pid}.stderr.log`), proc.stderr); }
  await worker?.stop(); await rm(input, { force: true }); await rm(target, { force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
