// Controlled CLI comparison against committed HEAD, using one local relay.
// Run from the repository root. Build and Worker startup are outside timers.
// Both clients use the same version per trial; every output is hash-verified.
// CD_COMPARE_MIB=64 CD_COMPARE_RUNS=5 node docs/measurements/transfer-speed-2026-10-18/compare-cli-relay.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildCLI, captureOutput, childExit, cliEnv, firstLine, run, startWorker, stopChild } from '../../../scripts/harness.mjs';

assert.ok(!process.env.CD_VERIFY_URL, 'Use only a local relay for this comparison');
const mib = Number(process.env.CD_COMPARE_MIB ?? 64);
const runs = Number(process.env.CD_COMPARE_RUNS ?? 5);
const warmupPairs = Number(process.env.CD_COMPARE_WARMUP_PAIRS ?? 0);
assert.ok(Number.isSafeInteger(mib) && mib > 0);
assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 6);
assert.ok(Number.isSafeInteger(warmupPairs) && warmupPairs >= 0 && runs + warmupPairs <= 7);
const work = await mkdtemp(join(tmpdir(), 'cd-speed-compare-'));
const result = { timestamp: new Date().toISOString(), mib, runs, warmupPairs, cpu: cpus()[0]?.model, node: process.version, filesystem: work, loadBefore: loadavg(), trials: [] };
const sha = data => createHash('sha256').update(data).digest('hex');
let worker;
try {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
  result.baseCommit = stdout.trim();
  const historical = join(work, 'head');
  await mkdir(historical);
  const archive = spawn('git', ['archive', result.baseCommit], { stdio: ['ignore', 'pipe', 'inherit'] });
  const extract = spawn('tar', ['-x', '-C', historical], { stdio: ['pipe', 'ignore', 'inherit'] });
  archive.stdout.pipe(extract.stdin);
  assert.deepEqual(await Promise.all([childExit(archive), childExit(extract)]), [0, 0]);
  const executables = { current: await buildCLI(work), head: join(historical, 'cdx') };
  await run('go', ['build', '-buildvcs=false', '-trimpath', '-o', executables.head, './cmd/cdx'], { cwd: historical });
  result.executableSHA256 = Object.fromEntries(await Promise.all(Object.entries(executables).map(async ([name, path]) => [name, sha(await readFile(path))])));
  worker = await startWorker(work);
  const bytes = randomBytes(mib * 1024 * 1024);
  const expected = sha(bytes);
  const source = join(work, 'payload.bin');
  await writeFile(source, bytes);
  // Reverse the order each pair to reduce warm-up and time-order bias.
  for (let pair = -warmupPairs; pair < runs; pair++) {
    for (const version of pair % 2 ? ['current', 'head'] : ['head', 'current']) {
      const trial = { version, pair, warmup: pair < 0, completed: false };
      const destination = join(work, `out-${version}-${pair}`);
      await mkdir(destination);
      const env = cliEnv(worker, { CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1', CD_STATE_DIR: join(work, `state-${version}-${pair}`) });
      let sender, receiver;
      try {
        const start = performance.now();
        sender = spawn(executables[version], ['send', '--wait', '--json', '--link', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const senderOutput = captureOutput(sender);
        const senderExit = childExit(sender, 120000);
        senderExit.catch(() => {});
        const ready = JSON.parse(await firstLine(sender.stdout, 20000));
        assert.equal(typeof ready.url, 'string');
        trial.readinessMs = performance.now() - start;
        const transferStart = performance.now();
        receiver = spawn(executables[version], ['receive', '--json', ready.url, '--out', destination], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const receiverOutput = captureOutput(receiver);
        assert.equal(await childExit(receiver, 120000), 0, receiverOutput.stderr);
        await receiverOutput.finished;
        trial.seconds = (performance.now() - transferStart) / 1000;
        assert.equal(await senderExit, 0, senderOutput.stderr);
        await senderOutput.finished;
        assert.equal(sha(await readFile(join(destination, 'payload.bin'))), expected);
        trial.mibPerSecond = mib / trial.seconds;
        trial.commandOutputBytes = senderOutput.bytes + receiverOutput.bytes;
        if (version === 'current') {
          trial.transport = (senderOutput.stderr + receiverOutput.stderr).split('\n').flatMap(line => {
            try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
          });
          assert.ok(trial.transport.some(value => value.relayBytes >= bytes.length));
          assert.ok(trial.transport.every(value => value.directBytes === 0));
        }
        trial.completed = true;
      } catch (error) {
        trial.error = error.message;
        process.exitCode = 1;
      } finally {
        await stopChild(receiver);
        await stopChild(sender);
      }
      result.trials.push(trial);
      console.error(JSON.stringify(trial));
    }
  }
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
  result.loadAfter = loadavg();
  console.log(JSON.stringify(result, null, 2));
}
