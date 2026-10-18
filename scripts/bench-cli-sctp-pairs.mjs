import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const binaries = {
  old: process.env.CD_GO_BASE_TEST,
  piece60: process.env.CD_GO_NEW_TEST,
  cwnd1m: process.env.CD_GO_CWND_TEST
};
assert(Object.values(binaries).every(Boolean), 'set CD_GO_BASE_TEST, CD_GO_NEW_TEST, and CD_GO_CWND_TEST');
for (let pair = 0; pair < Number(process.env.CD_BENCH_RUNS ?? 5); pair++) {
  for (const version of pair % 2 ? ['cwnd1m', 'piece60', 'old'] : ['old', 'piece60', 'cwnd1m']) {
    const result = spawnSync('bash', ['scripts/bench-cli-netem.sh', binaries[version],
      '-test.run', '^$', '-test.bench', '^BenchmarkDirectPathThroughput$', '-test.benchtime', '1x', '-test.count', '1'], {
      encoding: 'utf8', timeout: 120_000
    });
    console.log(JSON.stringify({ pair: pair + 1, version, exit: result.status, output: result.stdout + result.stderr }));
    if (result.status !== 0) process.exit(1);
  }
}
