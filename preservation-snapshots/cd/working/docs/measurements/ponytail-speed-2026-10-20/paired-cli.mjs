// Run from the repository root. Each cohort also measures both croc modes.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {main, median} from '../../../scripts/bench-croc-matrix.mjs';
import {startDirectRuntime} from '../../../scripts/bench-direct-runtime.mjs';

const [before, after, target, count = '7'] = process.argv.slice(2);
assert.ok(before && after && target, 'Usage: node paired-cli.mjs BEFORE AFTER OUTPUT [RUNS]');
const runs = Number(count);
assert.ok(Number.isInteger(runs) && runs > 0);
const route = process.env.CD_PAIR_ROUTE || 'relay';
assert.ok(['auto', 'relay'].includes(route));
const output = resolve(target), work = await mkdtemp('/tmp/cd-cli-paired-');
const binaries = {before: resolve(before), after: resolve(after)};
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const report = {version: 1, runs, route, startedAt: new Date().toISOString(), rows: [], binaries: {},
  method: 'Alternate before/after binaries, reversing each round. Shared local Worker runtime and byte-preserving frontend proxy, no WebSocket compression. Each suite measures CD, then croc default, then croc without compression. Same 256 MiB random payload class; warm cache, RAM output, route in options and actual path in telemetry, file/directory fsync and SHA-256 verification. No profiler. Not a full acceptance run.'};
report.competition = [];
function inspectCompetition() {
  const others = execFileSync('ps', ['-eo', 'pid,args'], {encoding: 'utf8'}).split('\n')
    .filter(line => /^\s*\d+ (?:\S*\/)?node .*scripts\/(?:bench-|verify-)/.test(line));
  if (others.length) report.competition.push({at: new Date().toISOString(), pids: others.map(line => Number(line.trim().split(' ')[0]))});
}
inspectCompetition();
const monitor = setInterval(inspectCompetition, 500);
let worker;
try {
  assert.ok(process.env.CD_BENCH_RUNTIME_BUNDLE, 'Provide the frozen benchmark Worker bundle');
  report.runtime = {bundle: resolve(process.env.CD_BENCH_RUNTIME_BUNDLE), sha256: await digest(process.env.CD_BENCH_RUNTIME_BUNDLE), hosted: false};
  worker = await startDirectRuntime(process.env.CD_BENCH_RUNTIME_BUNDLE, {compression: false, assets: true});
  delete process.env.CD_BENCH_RUNTIME_BUNDLE;
  process.env.CD_VERIFY_URL = worker.publicBase;
  for (const [variant, path] of Object.entries(binaries)) report.binaries[variant] = {path, sha256: await digest(path)};
  for (let run = 0; run < runs; run++) for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const trial = await main(['--cdx', binaries[variant], '--croc', '/tmp/croc-bench-latest/croc', '--runs', '1',
      '--cases', 'random-256m', '--routes', route, '--storage', 'tmpfs', '--output', join(work, 'trial.json')]);
    assert.ok(trial.finishedAt && !trial.error && trial.rows.length === 3);
    assert.ok(trial.rows.every(row => row.ok && row.bytes === 268435456 && /^[a-f0-9]{64}$/.test(row.sha256)));
    report.rows.push(...trial.rows.map(row => ({...row, variant, run})));
    report.environment = trial.environment;
    report.worker = trial.worker;
    report.croc = trial.binary.croc;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  for (const [variant, path] of Object.entries(binaries)) assert.equal(await digest(path), report.binaries[variant].sha256);
  report.summary = Object.fromEntries(['before', 'after'].map(variant => [variant,
    Object.fromEntries(['cd', 'croc', 'croc-no-compress'].map(tool => [tool,
      Object.fromEntries(['readyMs', 'receiverMs', 'durableMs', 'totalMs'].map(metric => [metric,
        median(report.rows.filter(row => row.variant === variant && row.tool === tool).map(row => row[metric]))]))]))]));
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  report.contended = report.competition.length > 0;
  await worker?.stop();
  await rm(work, {recursive: true, force: true});
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
