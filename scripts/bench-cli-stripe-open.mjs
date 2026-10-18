import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

assert(process.env.CD_GO_BASE_TEST && process.env.CD_GO_NEW_TEST, 'set CD_GO_BASE_TEST and CD_GO_NEW_TEST');
const binaries = { old: process.env.CD_GO_BASE_TEST, new: process.env.CD_GO_NEW_TEST, direct: process.env.CD_GO_NEW_TEST };
for (const profile of (process.env.CD_OPEN_PROFILES ?? 'local-slow,netem-fast').split(',')) {
  for (let pair = 0; pair < Number(process.env.CD_BENCH_RUNS ?? 5); pair++) {
    const seconds = {};
    for (const version of pair % 2 ? ['new', 'old', 'direct'] : ['direct', 'old', 'new']) {
      const args = [binaries[version], '-test.run', '^$', '-test.bench', '^BenchmarkStripedWindowThroughput$', '-test.benchtime', '1x'];
      const shaped = profile.startsWith('netem');
      const result = spawnSync(shaped ? 'bash' : args[0], shaped ? ['scripts/bench-cli-netem.sh', ...args] : args.slice(1), {
        env: { ...process.env, CD_STRIPE: version === 'direct' ? '0' : '1', CD_BENCH_RELAY_SLOW: profile.endsWith('slow') ? '1' : '0' },
        encoding: 'utf8', timeout: 120_000
      });
      const output = result.stdout + result.stderr;
      console.log(JSON.stringify({ profile, pair: pair + 1, version, exit: result.status, output }));
      assert.equal(result.status, 0, output);
      const match = output.match(/\s(\d+) ns\/op/);
      assert(match, 'benchmark timing missing');
      seconds[version] = Number(match[1]) / 1e9;
    }
    console.log(JSON.stringify({ profile, pair: pair + 1, seconds, directOverNew: seconds.direct / seconds.new, oldOverNew: seconds.old / seconds.new }));
  }
}
