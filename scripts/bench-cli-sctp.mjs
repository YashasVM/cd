import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Build isolated package copies so the working source is never rewritten.
// Netem runs in a private namespace; the host network is untouched.
const work = resolve('.perf-round2');
mkdirSync(work, { recursive: true });
for (const receive of (process.env.CD_SCTP_RECEIVE ?? '8,16,24').split(',').map(Number)) {
  for (const cwnd of (process.env.CD_SCTP_CWND ?? '0,262144,1048576').split(',').map(Number)) {
    const name = `r${receive}-c${cwnd}`;
    const dir = `${work}/${name}`;
    cpSync('cmd/cdx', dir, { recursive: true });
    const direct = `${dir}/direct.go`;
    let source = readFileSync(direct, 'utf8')
      .replace(/directReceiveBuffer = .*/, `directReceiveBuffer = ${receive} * 1024 * 1024`)
      .replace(/directBufferHigh = .*/, `directBufferHigh = ${receive} * 1024 * 1024`)
      .replace(/directBufferLow  = .*/, `directBufferLow  = ${Math.floor(receive / 4)} * 1024 * 1024`);
    if (cwnd) source = source.replace('settings.SetSCTPMaxReceiveBufferSize(directReceiveBuffer)',
      `settings.SetSCTPMaxReceiveBufferSize(directReceiveBuffer)\n settings.SetSCTPMinCwnd(${cwnd})`);
    writeFileSync(direct, source);
    const build = spawnSync('go', ['test', '-c', '-o', `${dir}/bench.test`, `./.perf-round2/${name}`], { encoding: 'utf8' });
    if (build.status) throw new Error(build.stderr);
    const result = spawnSync('bash', ['scripts/bench-cli-netem.sh', `${dir}/bench.test`, '-test.run', '^$',
      '-test.bench', '^BenchmarkDirectPathThroughput$', '-test.benchtime', '1x', '-test.count', process.env.CD_SCTP_RUNS ?? '3'], { encoding: 'utf8', timeout: 120000 });
    console.log(JSON.stringify({ receiveMiB: receive, highMiB: receive, lowMiB: Math.floor(receive / 4), minCwnd: cwnd,
      exit: result.status, output: result.stdout + result.stderr }));
    if (result.status) process.exit(1);
  }
}
