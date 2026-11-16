import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeResumePairs } from './summarize-resume-paired.mjs';

function cohort() {
  const report = { finishedAt: '2026-11-16', runs: 2, bytes: 77, scenario: 'browser-cli', cliSHA256: 'c'.repeat(64), sourceSHA256: { before: 'a'.repeat(64), after: 'b'.repeat(64) }, rows: [] };
  for (let run = 0; run < 2; run++) for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const sha256 = String(run + 1).repeat(64);
    const ms = variant === 'before' ? [10, 30][run] : [20, 10][run];
    report.rows.push({ run, variant, expected: sha256, ok: true, result: { profiling: false, cliSHA256: report.cliSHA256, measurements: [{ bytes: 77, sha256, scenario: 'browser-cli', route: 'v2-relay', relayOrigin: 'http://127.0.0.1:1234', preparationMs: ms / 2, transferMs: ms / 2, milliseconds: ms }] } });
  }
  return report;
}

test('summarizes every verified pair, including the slower candidate pair', () => {
  const summary = summarizeResumePairs(cohort());
  assert.deepEqual(summary.metrics.milliseconds, { before: { median: 20, min: 10, max: 30 }, after: { median: 15, min: 10, max: 20 }, ratio: 4 / 3, afterWins: 1, pairedRatios: [0.5, 3] });
});

test('rejects incomplete, failed, mismatched, profiled or reused-input cohorts', () => {
  for (const mutate of [r => { delete r.finishedAt; }, r => r.rows.pop(), r => { r.rows[0].ok = false; }, r => { r.rows[0].result.profiling = true; }, r => { r.rows[0].result.cliSHA256 = 'd'.repeat(64); }, r => { r.rows[0].result.measurements[0].bytes--; }, r => { r.rows[0].result.measurements[0].sha256 = 'd'.repeat(64); }, r => { r.rows[0].result.measurements[0].transferMs = NaN; }, r => { r.rows.reverse(); }, r => { for (const row of r.rows) { row.expected = 'e'.repeat(64); row.result.measurements[0].sha256 = row.expected; } }]) {
    const report = cohort(); mutate(report);
    assert.throws(() => summarizeResumePairs(report));
  }
});
