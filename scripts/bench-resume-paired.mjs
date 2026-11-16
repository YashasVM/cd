import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { childExit, stopChild } from './harness.mjs';

// Compare only the hash module, keeping the current UI and relay identical.
const baseline = process.argv[2];
assert.ok(baseline, 'usage: node scripts/bench-resume-paired.mjs <baseline-ref> <report-directory>');
assert.equal(process.env.CD_VERIFY_URL, undefined, 'paired benchmark requires a local relay');
assert.equal(process.env.CD_BENCH_RUNTIME_BUNDLE, undefined, 'paired benchmark requires the current relay');
const output = resolve(process.argv[3] ?? '/tmp/cd-resume-paired');
const bytes = Number(process.env.CD_RESUME_BENCH_BYTES ?? 64 * 1024 * 1024 + 77);
const runs = Number(process.env.CD_RESUME_BENCH_RUNS ?? 7);
assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
const work = await mkdtemp(join(tmpdir(), 'cd-resume-paired-'));
const report = { baseline, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cpu: cpus()[0]?.model, temporaryStorage: tmpdir(), bytes, runs,
  method: 'Alternating hash implementations in the same current UI and local v2 relay. Fresh random input per pair, identical bytes within each pair. Fresh Chromium process and contexts per trial. Full output digest and bytes verified. OPFS Worker path; OS cache allowed. Not LAN, WAN, phone or fsync evidence.', rows: [] };
await mkdir(output, { recursive: true });
try {
  const before = execFileSync('git', ['show', `${baseline}:src/incremental-sha256.js`], { encoding: 'utf8' });
  report.hashModules = {};
  for (const [variant, source] of [['before', before], ['after', await readFile('src/incremental-sha256.js')]]) {
    report.hashModules[variant] = createHash('sha256').update(source).digest('hex');
  }
  let replacements = 0;
  for (const variant of ['before', 'after']) await build({
    logLevel: 'error', build: { outDir: join(work, variant) },
    plugins: variant === 'before' ? [{ name: 'baseline-hash', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/incremental-sha256.js')) { replacements++; return before; }
    } }] : []
  });
  assert.ok(replacements > 0, 'baseline build must replace the hash module');
  for (let run = 0; run < runs; run++) {
    const input = join(work, 'payload.bin');
    const payload = randomBytes(bytes);
    const expected = createHash('sha256').update(payload).digest('hex');
    await writeFile(input, payload);
    for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
      const trial = join(output, `${run}-${variant}.json`);
      const child = spawn(process.execPath, ['scripts/verify-browser-resume.mjs'], { env: {
        ...process.env, CD_BROWSER_RESUME_ONLY: 'browser-browser', CD_BROWSER_RESUME_BYTES: String(bytes),
        CD_BROWSER_RESUME_INPUT: input, CD_VERIFY_ASSET_DIR: join(work, variant), CD_BROWSER_RESUME_REPORT: trial
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
      const row = { run, variant, expected, ok: false };
      try {
        const code = await childExit(child, 300_000);
        row.result = JSON.parse(await readFile(trial, 'utf8'));
        assert.equal(code, 0, log);
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
  await writeFile(join(output, 'paired.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.rows.length !== runs * 2 || report.rows.some(row => !row.ok)) process.exitCode = 1;
