import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { resolve, join } from 'node:path';
import { childExit, cliEnv, collect, firstLine, startWorker, stopChild } from './harness.mjs';

assert(process.env.CD_CLI_BASE && process.env.CD_CLI_NEW, 'set CD_CLI_BASE and CD_CLI_NEW');
const binaries = { old: resolve(process.env.CD_CLI_BASE), new: resolve(process.env.CD_CLI_NEW) };
await mkdir(resolve('.perf-round2'), { recursive: true });
const work = await mkdtemp(resolve('.perf-round2/stripe-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const mib = Number(process.env.CD_BENCH_MIB ?? 64);
const payload = Buffer.alloc(mib * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + Math.floor(i / 251)) & 255;
const source = join(work, 'payload.bin');
await writeFile(source, payload);
const expected = sha(payload);
let serial = 0;
let worker;
let proxy;
let sockets = new Set();
try {
  for (const profile of (process.env.CD_RELAY_PROFILES ?? 'fast,slow').split(',')) {
    // Each group uses <=30 connections to avoid local rate-limit bias.
    for (let pair = 0; pair < Number(process.env.CD_BENCH_RUNS ?? 5); pair++) {
      worker = await startWorker(await mkdtemp(join(work, 'worker-')));
      const target = new URL(worker.publicBase);
      proxy = createServer((client) => {
        const upstream = connect(Number(target.port), target.hostname);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          socket.on('error', () => { client.destroy(); upstream.destroy(); });
        }
        if (profile === 'fast') { client.pipe(upstream); upstream.pipe(client); }
        else { shape(client, upstream); shape(upstream, client); }
      });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      const results = {};
      for (const mode of pair % 2 ? ['new', 'old', 'direct'] : ['direct', 'old', 'new']) {
        console.error(`running ${profile} pair=${pair+1} mode=${mode}`);
        const binary = binaries[mode === 'old' ? 'old' : 'new'];
        const out = join(work, `out-${serial++}`);
        await mkdir(out);
        const env = cliEnv(worker, {
          CD_RELAY_URL: `ws://127.0.0.1:${proxy.address().port}/ws/v1`,
          CD_PUBLIC_URL: `http://127.0.0.1:${proxy.address().port}`,
          CD_DIRECT: '1', CD_STRIPE: mode === 'direct' ? '0' : '1', CD_STATE_DIR: join(work, 'state')
        });
        let sender, receiver;
        try {
          sender = spawn(binary, ['send', '--wait', '--link', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          const senderExit = childExit(sender);
          const senderError = collect(sender.stderr);
          const link = await firstLine(sender.stdout).catch(async (e) => { throw new Error(`${e.message}: ${await senderError}`); });
          const started = performance.now();
          receiver = spawn(binary, ['receive', link, '--out', out], { env, stdio: ['ignore', 'ignore', 'pipe'] });
          const receiverError = collect(receiver.stderr);
          assert.equal(await childExit(receiver), 0, await receiverError);
          const seconds = (performance.now() - started) / 1000;
          assert.equal(await senderExit, 0, await senderError);
          assert.equal(sha(await readFile(join(out, 'payload.bin'))), expected);
          assert((await senderError).includes('switched to a direct connection'), 'direct did not open');
          results[mode] = seconds;
        } finally { await stopChild(receiver); await stopChild(sender); }
        await rm(out, { recursive: true, force: true });
      }
      console.log(JSON.stringify({ profile, pair: pair + 1, mib, sha256: expected, seconds: results,
        directOverNew: results.direct / results.new, oldOverNew: results.old / results.new }));
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => proxy.close(r)); proxy = null;
      await worker.stop(); worker = null;
    }
  }
} finally {
  for (const socket of sockets) socket.destroy();
  proxy?.close(); await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

// Fixed 50 ms one-way propagation plus 8 MiB/s serialization per socket.
// Pause at 2 MiB queued so the test proxy cannot absorb an unbounded transfer.
function shape(source, destination) {
  let next = 0, pending = 0, ended = false;
  const queue = [];
  let timer;
  const drain = () => {
    timer = undefined;
    while (queue.length && queue[0].at <= performance.now()) {
      const { data } = queue.shift();
      if (!destination.destroyed) destination.write(data);
      pending -= data.length;
    }
    if (pending < 1024 * 1024) source.resume();
    if (ended && !pending) destination.end();
    if (queue.length) timer = setTimeout(drain, Math.max(1, queue[0].at - performance.now()));
  };
  source.on('data', (data) => {
    const now = performance.now();
    next = Math.max(now + 50, next) + data.length / (8 * 1024 * 1024) * 1000;
    queue.push({ data: Buffer.from(data), at: next });
    pending += data.length;
    if (pending >= 2 * 1024 * 1024) source.pause();
    if (!timer) drain();
  });
  source.on('end', () => { ended = true; if (!pending) destination.end(); });
}
