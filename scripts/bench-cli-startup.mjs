import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCLI, childExit, cliEnv, collect, firstLine, startWorker, stopChild } from './harness.mjs';

// Observe the receiver JOIN and the first encrypted CHUNK byte in a transparent TCP
// proxy. Forward bytes unchanged, including masked WebSocket frames.
assert(process.env.CD_CLI_BASE, 'set CD_CLI_BASE to an origin/main CLI binary');
const baseline = resolve(process.env.CD_CLI_BASE);
const work = await mkdtemp(join(tmpdir(), 'cd-cli-startup-'));
let worker;
let proxy;
let joined = 0;
let firstByte = 0;
try {
  const current = process.env.CD_CLI_NEW ? resolve(process.env.CD_CLI_NEW) : await buildCLI(work);
  worker = await startWorker(work);
  const upstreamURL = new URL(worker.publicBase);
  proxy = createServer((downstream) => {
    const upstream = connect(Number(upstreamURL.port), upstreamURL.hostname);
    const outgoing = observeFrames((opcode, payload) => {
      if (opcode === 1 && JSON.parse(payload.toString()).role === 'receiver') joined = performance.now();
    });
    const incoming = observeFrames((opcode, payload) => {
      if (opcode === 2 && payload[0] === 67 && payload[1] === 68 && payload[3] === 2 && !firstByte) firstByte = performance.now();
    });
    downstream.on('data', outgoing);
    upstream.on('data', incoming);
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const publicBase = `http://127.0.0.1:${proxy.address().port}`;
  const env = cliEnv({ publicBase, relayBase: publicBase.replace('http', 'ws') + '/ws/v1' }, {
    CD_STATE_DIR: join(work, 'state'), CD_DIRECT: '1', CD_STRIPE: '1'
  });
  const payload = Buffer.alloc(1024 * 1024, 73);
  const source = join(work, 'payload.bin');
  await writeFile(source, payload);
  // Five pairs use 20 relay connections, below the local 30/min limit.
  for (let pair = 0; pair < 5; pair += 1) {
    const samples = {};
    for (const version of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
      joined = firstByte = 0;
      const binary = version === 'old' ? baseline : current;
      const sender = spawn(binary, ['send', '--wait', '--link', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const senderExit = childExit(sender);
      const senderError = collect(sender.stderr);
      let receiver;
      try {
        const link = await firstLine(sender.stdout);
        const destination = join(work, `${pair}-${version}`);
        await mkdir(destination);
        receiver = spawn(binary, ['receive', link, '--out', destination], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        const receiverError = collect(receiver.stderr);
        assert.equal(await childExit(receiver), 0, await receiverError);
        assert.equal(await senderExit, 0, await senderError);
        assert.deepEqual(await readFile(join(destination, 'payload.bin')), payload);
        assert(joined && firstByte, 'proxy missed JOIN or first CHUNK');
        samples[version] = firstByte - joined;
      } finally {
        await stopChild(receiver);
        await stopChild(sender);
      }
    }
    console.log(JSON.stringify({ pair: pair + 1, oldMs: samples.old, newMs: samples.new, ratio: samples.old / samples.new }));
  }
} finally {
  proxy?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

// This loopback probe inspects only uncompressed client/server frames. It
// reports a CHUNK after its 12-byte record header and first ciphertext byte.
function observeFrames(onFrame) {
  let buffer = Buffer.alloc(0);
  let handshake = true;
  let remaining = 0;
  let reported = false;
  return (piece) => {
    if (remaining) {
      const consumed = Math.min(remaining, piece.length);
      remaining -= consumed;
      piece = piece.subarray(consumed);
    }
    if (!piece.length) return;
    buffer = buffer.length ? Buffer.concat([buffer, piece]) : piece;
    if (handshake) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      buffer = buffer.subarray(end + 4);
      handshake = false;
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      const masked = Boolean(buffer[1] & 128);
      let length = buffer[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      const observed = opcode === 1 ? length : Math.min(13, length);
      if (buffer.length < offset + observed) return;
      if (!reported) {
        const payload = Buffer.from(buffer.subarray(offset, offset + observed));
        if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[maskOffset + index % 4];
        onFrame(opcode, payload);
        reported = true;
      }
      if (buffer.length < offset + length) {
        remaining = offset + length - buffer.length;
        buffer = Buffer.alloc(0);
        reported = false;
        return;
      }
      buffer = buffer.subarray(offset + length);
      reported = false;
    }
  };
}
