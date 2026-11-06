import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseline = await readFile(new URL('./resume-browser-before.js.txt', import.meta.url), 'utf8');
const sourceRoot = new URL('../../../src/', import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'cd-resume-pair-'));
const beforePath = join(temporary, 'before.mjs');
const rows = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  await writeFile(beforePath, baseline.replace(/from '\.\/([^']+)'/g, (_, name) => `from '${new URL(name, sourceRoot).href}'`));
  for (let trial = 1; trial <= 7; trial++) {
    for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
      const env = { ...process.env, CD_RESUME_BENCH: '1', CD_RESUME_BENCH_RUNS: '1' };
      delete env.CD_RESUME_SENDER_MODULE;
      if (mode === 'before') env.CD_RESUME_SENDER_MODULE = new URL(`file://${beforePath}`).href;
      const run = spawnSync(process.execPath, ['--test', '--test-name-pattern=measures encrypted', 'src/resume-sender.test.js'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const line = run.stdout.split('\n').find(value => value.includes('"benchmark":'));
      assert.ok(line, 'benchmark emitted no result');
      const result = JSON.parse(line.slice(line.indexOf('{')));
      rows.push({ mode, trial, ...result.rows[0] });
    }
  }
  const report = {
    scenario: '8 MiB actual v2 crypto, substituted network, simulated 30 ms ACK latency, seven alternating order pairs',
    hashes: { baseline: hash(baseline), candidate: hash(await readFile(new URL('resume-browser.js', sourceRoot))), harness: hash(await readFile(new URL('resume-sender.test.js', sourceRoot))) },
    rows,
    mediansMs: Object.fromEntries(['before', 'after'].map(mode => [mode, median(rows.filter(row => row.mode === mode).map(row => row.elapsedMs))]))
  };
  report.speedup = report.mediansMs.before / report.mediansMs.after;
  await writeFile(process.argv[2] || new URL('./delayed-ack.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mediansMs: report.mediansMs, speedup: report.speedup }));
} finally { await rm(temporary, { recursive: true, force: true }); }
