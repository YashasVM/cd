import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCLI, childExit, cliEnv, collect, firstLine, startWorker, withTimeout } from './harness.mjs';

// Regression check for the CLI->CLI completion race: the receiver saved the
// file but the sender saw `peer-left` instead of COMPLETE and exited 1.
// Every run uses the agent path (detached `cdx send`, then `cdx wait`) and
// must exit 0 on both sides with identical bytes.
// CD_LOOP_RUNS overrides the default of 20 runs. Runs are paced under the
// relay's 30 requests/minute per-IP limit, so 20 runs take about 3 minutes.
const runs = Number(process.env.CD_LOOP_RUNS ?? 20);
const runsPerMinute = 7;
const work = await mkdtemp(join(tmpdir(), 'cd-verify-loop-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Mix tiny, sub-ack-interval, and multi-window sizes: tiny files hit the
// early-COMPLETE path, larger ones the ack window.
const sizes = [0, 1, 5_000, 300_000, 1_048_577, 3 * 1024 * 1024 + 7];

let worker;
try {
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  const failures = [];
  const started = [];
  for (let index = 0; index < runs; index += 1) {
    if (started.length >= runsPerMinute) {
      const wait = started[started.length - runsPerMinute] + 61_000 - Date.now();
      if (wait > 0) await delay(wait);
    }
    started.push(Date.now());
    const size = sizes[index % sizes.length];
    const source = randomBytes(size);
    const sourcePath = join(work, `loop-${index}.bin`);
    await writeFile(sourcePath, source);
    const outDir = join(work, `out-${index}`);
    await mkdir(outDir);
    const env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state') });
    const sender = spawn(executable, ['send', sourcePath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await firstLine(sender.stdout);
    assert.match(code, /^\d{4,5}$/);
    assert.equal(await childExit(sender, 10_000), 0, `run ${index}: detached send did not exit 0`);
    const waiter = spawn(executable, ['wait', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const waitExit = childExit(waiter, 60_000);
    const senderStderr = collect(waiter.stderr);
    const receiver = spawn(executable, ['receive', code, '--out', outDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const receiverStderr = collect(receiver.stderr);
    const receiverCode = await childExit(receiver);
    const senderCode = await withTimeout(waitExit, 30_000, `run ${index}: cdx wait did not finish`);
    const received = receiverCode === 0 ? await readFile(join(outDir, `loop-${index}.bin`)) : null;
    if (senderCode !== 0 || receiverCode !== 0 || sha(received ?? '') !== sha(source)) {
      failures.push(`run ${index} (${size} bytes): sender=${senderCode} receiver=${receiverCode}\n  sender: ${(await senderStderr).trim()}\n  receiver: ${(await receiverStderr).trim()}`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length}/${runs} CLI->CLI runs failed:\n${failures.join('\n')}`);
  console.log(`verified ${runs}/${runs} CLI->CLI transfers exit 0 with exact bytes`);
} finally {
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
