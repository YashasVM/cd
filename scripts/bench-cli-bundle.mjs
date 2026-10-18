import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startWorker, cliEnv, firstLine, stopChild } from './harness.mjs';

assert(process.env.CD_CLI_BASE && process.env.CD_CLI_NEW, 'set CD_CLI_BASE and CD_CLI_NEW');
await mkdir(resolve('.perf-round2'), { recursive: true });
const work = await mkdtemp(resolve('.perf-round2/bundle-'));
await mkdir(join(work, 'folder'));
const file = await open(join(work, 'folder', 'sparse.bin'), 'w');
await file.truncate(20 * 1024 ** 3);
await file.close();
let worker;
try {
  worker = await startWorker(work);
  for (let pair = 0; pair < 5; pair++) {
    const seconds = {};
    for (const version of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
      const started = performance.now();
      const binary = resolve(version === 'old' ? process.env.CD_CLI_BASE : process.env.CD_CLI_NEW);
      const child = spawn(binary, ['send', '--wait', '--link', join(work, 'folder')], {
        env: cliEnv(worker, { CD_STATE_DIR: join(work, 'state') }), stdio: ['ignore', 'pipe', 'pipe']
      });
      try {
        await firstLine(child.stdout, 30_000);
        seconds[version] = (performance.now() - started) / 1000;
      } finally { await stopChild(child); }
    }
    console.log(JSON.stringify({ pair: pair + 1, GiB: 20, seconds, ratio: seconds.old / seconds.new }));
  }
} finally {
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
