import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median } from './bench-croc-matrix.mjs';

export function summarizeResumePairs(report) {
  assert.ok(report.finishedAt, 'cohort must be finished');
  assert.ok(Number.isSafeInteger(report.runs) && report.runs > 0);
  assert.ok(Number.isSafeInteger(report.bytes) && report.bytes > 0);
  assert.ok(['browser-browser', 'browser-browser-fallback', 'browser-cli'].includes(report.scenario));
  for (const variant of ['before', 'after']) assert.match(report.sourceSHA256[variant], /^[0-9a-f]{64}$/);
  assert.notEqual(report.sourceSHA256.before, report.sourceSHA256.after, 'implementations must differ');
  assert.equal(report.rows.length, report.runs * 2, 'retain every planned trial');
  const pairs = [];
  for (let run = 0; run < report.runs; run++) {
    const rows = report.rows.slice(run * 2, run * 2 + 2);
    assert.deepEqual(rows.map(row => [row.run, row.variant]), (run % 2 ? ['after', 'before'] : ['before', 'after']).map(variant => [run, variant]));
    assert.equal(rows[0].expected, rows[1].expected, 'paired inputs must match');
    for (const row of rows) {
      assert.equal(row.ok, true, 'failed trials cannot establish a speedup');
      assert.ok(!row.error && !row.result.failure);
      assert.equal(row.result.profiling, false, 'profiling is not a speed benchmark');
      assert.equal(row.result.measurements.length, 1);
      const value = row.result.measurements[0];
      assert.equal(value.bytes, report.bytes);
      assert.match(row.expected, /^[0-9a-f]{64}$/);
      assert.equal(value.sha256, row.expected);
      assert.equal(value.scenario, report.scenario);
      assert.equal(value.route, 'v2-relay');
      const origin = new URL(value.relayOrigin);
      assert.equal(origin.protocol, 'http:');
      assert.equal(origin.hostname, '127.0.0.1', 'keep local and remote routes separate');
      if (report.scenario === 'browser-cli') {
        assert.match(report.cliSHA256, /^[0-9a-f]{64}$/);
        assert.equal(row.result.cliSHA256, report.cliSHA256);
      }
      for (const metric of ['preparationMs', 'transferMs', 'milliseconds']) assert.ok(Number.isFinite(value[metric]) && value[metric] > 0);
    }
    pairs.push(Object.fromEntries(rows.map(row => [row.variant, row.result.measurements[0]])));
  }
  assert.equal(new Set(report.rows.map(row => row.expected)).size, report.runs, 'fresh input is required per pair');
  const metrics = Object.fromEntries(['preparationMs', 'transferMs', 'milliseconds'].map(metric => {
    const variants = Object.fromEntries(['before', 'after'].map(variant => {
      const values = pairs.map(pair => pair[variant][metric]);
      return [variant, { median: median(values), min: Math.min(...values), max: Math.max(...values) }];
    }));
    return [metric, { ...variants, ratio: variants.before.median / variants.after.median,
      afterWins: pairs.filter(pair => pair.after[metric] < pair.before[metric]).length,
      pairedRatios: pairs.map(pair => pair.before[metric] / pair.after[metric]) }];
  }));
  return { pairs: report.runs, bytes: report.bytes, scenario: report.scenario, sourceSHA256: report.sourceSHA256, cliSHA256: report.cliSHA256, metrics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2]);
  const report = JSON.parse(await readFile(path, 'utf8'));
  const summary = summarizeResumePairs(report);
  for (const row of report.rows) assert.deepEqual(JSON.parse(await readFile(join(dirname(path), `${row.run}-${row.variant}.json`), 'utf8')), row.result, 'standalone raw report differs from paired record');
  console.log(JSON.stringify(summary, null, 2));
}
