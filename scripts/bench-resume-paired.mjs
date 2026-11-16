import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { childExit, stopChild } from './harness.mjs';

// Replace one selected browser module, keeping the rest of the UI and relay identical.
const baseline = process.argv[2];
assert.ok(baseline, 'usage: node scripts/bench-resume-paired.mjs <baseline-ref> <report-directory> [src/module.js]');
const sourceModule = process.argv[4] ?? 'src/incremental-sha256.js';
assert.match(sourceModule, /^src\/[A-Za-z0-9-]+\.js$/);
const scenario = process.env.CD_BROWSER_RESUME_ONLY ?? 'browser-browser';
assert.ok(['browser-browser', 'browser-browser-fallback', 'browser-cli'].includes(scenario));
assert.equal(process.env.CD_VERIFY_URL, undefined, 'paired benchmark requires a local relay');
assert.equal(process.env.CD_BENCH_RUNTIME_BUNDLE, undefined, 'paired benchmark requires the current relay');
assert.notEqual(process.env.CD_RESUME_PROFILE, '1', 'paired speed benchmark must run without profiling overhead');
const output = resolve(process.argv[3] ?? '/tmp/cd-resume-paired');
const bytes = Number(process.env.CD_RESUME_BENCH_BYTES ?? 64 * 1024 * 1024 + 77);
const runs = Number(process.env.CD_RESUME_BENCH_RUNS ?? 7);
assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
const work = await mkdtemp(join(tmpdir(), 'cd-resume-paired-'));
const report = { baseline, sourceModule, scenario, startedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cpu: cpus()[0]?.model, temporaryStorage: tmpdir(), bytes, runs,
  method: 'Alternating selected browser-module implementations in the same current UI and local v2 relay. Fresh random input per pair, identical bytes within each pair. Fresh Chromium process and contexts per trial. Full output digest and bytes verified. OS cache allowed. Not LAN, WAN, phone or physical disk persistence evidence.', rows: [] };
await mkdir(output, { recursive: true });
try {
  const before = execFileSync('git', ['show', `${baseline}:${sourceModule}`], { encoding: 'utf8' });
  report.sourceSHA256 = {};
  for (const [variant, source] of [['before', before], ['after', await readFile(sourceModule)]]) {
    report.sourceSHA256[variant] = createHash('sha256').update(source).digest('hex');
  }
  let replacements = 0;
  for (const variant of ['before', 'after']) await build({
    logLevel: 'error', build: { outDir: join(work, variant) },
    plugins: variant === 'before' ? [{ name: 'baseline-hash', enforce: 'pre', transform(code, id) {
      if (id === resolve(sourceModule)) { replacements++; return before; }
    } }] : []
  });
  assert.ok(replacements > 0, 'baseline build must replace the selected module');
  for (let run = 0; run < runs; run++) {
    const input = join(work, 'payload.bin');
    const payload = randomBytes(bytes);
    const expected = createHash('sha256').update(payload).digest('hex');
    await writeFile(input, payload);
    for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
      const trial = join(output, `${run}-${variant}.json`);
      const child = spawn(process.execPath, ['scripts/verify-browser-resume.mjs'], { env: {
        ...process.env, CD_BROWSER_RESUME_ONLY: scenario, CD_BROWSER_RESUME_BYTES: String(bytes),
        CD_BROWSER_RESUME_INPUT: input, CD_VERIFY_ASSET_DIR: join(work, variant), CD_BROWSER_RESUME_REPORT: trial
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
      const row = { run, variant, startedAt: new Date().toISOString(), loadavg: loadavg(), expected, ok: false };
      try {
        const code = await childExit(child, 300_000);
        row.result = JSON.parse(await readFile(trial, 'utf8'));
        assert.equal(code, 0, log);
        if (scenario === 'browser-cli') {
          assert.match(row.result.cliSHA256, /^[0-9a-f]{64}$/);
          report.cliSHA256 ??= row.result.cliSHA256;
          assert.equal(row.result.cliSHA256, report.cliSHA256, 'CLI binary must remain identical across all variants and trials');
        }
        assert.equal(row.result.measurements.length, 1);
        assert.equal(row.result.measurements[0].sha256, expected);
        assert.equal(row.result.measurements[0].bytes, bytes);
        row.ok = true;
      } catch (error) { row.error = error.message; }
      finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          try { await childExit(child, 30_000); }
          catch (error) {
            await stopChild(child);
            throw new Error('Trial cleanup timed out; aborting comparison to avoid overlapping processes.', { cause: error });
          }
        }
        await writeFile(join(output, `${run}-${variant}.log`), log);
      }
      report.rows.push(row);
      await writeFile(join(output, 'paired.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ run, variant, ok: row.ok, measurement: row.result?.measurements[0], error: row.error }));
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'paired.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.rows.length !== runs * 2 || report.rows.some(row => !row.ok)) process.exitCode = 1;
