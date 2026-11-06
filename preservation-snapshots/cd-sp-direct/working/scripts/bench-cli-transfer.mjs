import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCLI, childExit, cliEnv, collect, firstLine, startWorker, stopChild } from './harness.mjs';

// Build origin/main separately and pass CD_CLI_BASE=/absolute/path/to/cdx.
// Each pair alternates execution order to reduce bias on a shared machine.
assert(process.env.CD_CLI_BASE, 'set CD_CLI_BASE to an origin/main CLI binary');
const baseline = resolve(process.env.CD_CLI_BASE);
const runs = Number(process.env.CD_BENCH_RUNS ?? 5);
const sizes = (process.env.CD_BENCH_SIZES ?? '64,256').split(',').map(Number);
const modes = (process.env.CD_BENCH_MODES ?? 'relay,default').split(',').filter(Boolean);
const work = await mkdtemp(join(tmpdir(), 'cd-cli-pairs-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let worker;
let serial = 0;
try {
  const current = process.env.CD_CLI_NEW ? resolve(process.env.CD_CLI_NEW) : await buildCLI(work);
  for (const mib of sizes) {
    const payload = Buffer.alloc(mib * 1024 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + Math.floor(index / 251)) & 255;
    const source = join(work, 'payload.bin');
    await writeFile(source, payload);
    const expected = sha(payload);
    for (const mode of modes) {
      await worker?.stop();
      worker = await startWorker(await mkdtemp(join(work, 'relay-')));
      for (let pair = 0; pair < runs; pair += 1) {
        const result = {};
        for (const version of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
          result[version] = await transfer(version === 'old' ? baseline : current, version === 'old' ? baseline : current, source, expected, mode);
        }
        console.log(JSON.stringify({ mib, mode, pair: pair + 1, ...result, ratio: result.old.seconds / result.new.seconds }));
      }
    }
    // Reset the local relay connection limiter before compatibility checks.
    await worker?.stop();
    worker = await startWorker(await mkdtemp(join(work, 'relay-')));
    // Wire compatibility in both directions, including direct negotiation.
    for (const [sender, receiver, name] of [[baseline, current, 'old-new'], [current, baseline, 'new-old']]) {
      console.log(JSON.stringify({ mib, mode: 'compatibility', direction: name, ...await transfer(sender, receiver, source, expected, 'default') }));
    }
  }
} finally {
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

async function transfer(senderCLI, receiverCLI, source, expected, mode) {
  const destination = join(work, `receive-${serial++}`);
  await mkdir(destination);
  const env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state'), CD_DIRECT: mode === 'relay' ? '0' : '1', CD_STRIPE: '1' });
  const sender = spawn(senderCLI, ['send', '--wait', '--link', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const senderExit = childExit(sender, 120_000);
  const senderError = collect(sender.stderr);
  let receiver;
  try {
    const link = await firstLine(sender.stdout, 30_000).catch(async (error) => {
      throw new Error(`${error.message}\n${await senderError}`, { cause: error });
    });
    const started = performance.now();
    receiver = spawn(receiverCLI, ['receive', link, '--out', destination], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const receiverError = collect(receiver.stderr);
    assert.equal(await childExit(receiver, 120_000), 0, await receiverError);
    const seconds = (performance.now() - started) / 1000;
    assert.equal(await senderExit, 0, await senderError);
    const received = await readFile(join(destination, 'payload.bin'));
    assert.equal(sha(received), expected, 'received SHA-256 differs');
    const diagnostics = await senderError;
    return { seconds, mibPerSecond: received.length / 1024 / 1024 / seconds, direct: diagnostics.includes('switched to a direct connection') };
  } finally {
    await stopChild(receiver);
    await stopChild(sender);
    await rm(destination, { recursive: true, force: true });
  }
}
