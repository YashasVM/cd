import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { childExit, collect } from './harness.mjs';

// Build the two test binaries first. The baseline needs the repaired benchmark
// helpers from docs/measurements/cli-transfer-2026-10-18/baseline-benchmark.patch.
assert(process.env.CD_GO_BASE_TEST && process.env.CD_GO_NEW_TEST, 'set CD_GO_BASE_TEST and CD_GO_NEW_TEST to compiled Go test binaries');
const binaries = { old: resolve(process.env.CD_GO_BASE_TEST), new: resolve(process.env.CD_GO_NEW_TEST) };
const runs = Number(process.env.CD_BENCH_RUNS ?? 5);
for (let pair = 0; pair < runs; pair += 1) {
  for (const version of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
    for (const [benchmark, benchtime] of [
      ['Benchmark(DirectPathThroughput|RelayPathThroughput)$', '3x'],
      ['Benchmark(SealChunk|RecordRoundTrip)$', '500x']
    ]) {
      console.log(`pair=${pair + 1} version=${version} benchtime=${benchtime}`);
      const child = spawn(binaries[version], ['-test.run', '^$', '-test.bench', benchmark, '-test.benchtime', benchtime, '-test.count', '1'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      assert.equal(await childExit(child), 0, await stderr);
      process.stdout.write(await stdout);
    }
  }
}
