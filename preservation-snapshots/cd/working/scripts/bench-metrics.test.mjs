import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { summarize } from './bench-metrics.mjs';
import { captureOutput, childExit, firstLine } from './harness.mjs';

test('failed trials reduce completion rate and never inflate successful medians', () => {
  const result = summarize([
    { completed: true, readinessMs: 10, seconds: 2, mibPerSecond: 8, outputBytes: 100 },
    { completed: false, readinessMs: 1000, error: 'relay did not admit sender' },
    { completed: true, readinessMs: 20, seconds: 4, mibPerSecond: 4, outputBytes: 200 }
  ]);
  assert.equal(result.completionRate, 2 / 3);
  assert.equal(result.readinessMs, 20);
  assert.equal(result.outputBytes, 200);
  assert.equal(result.trials[1].error, 'relay did not admit sender');
  assert.equal(summarize([{ completed: false }]).mibPerSecond, null);
});

test('output accounts for both streams and exact UTF-8 bytes', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("é\\n"); process.stderr.write("oops\\n")']);
  const output = captureOutput(child);
  assert.equal(await childExit(child), 0);
  await output.finished;
  assert.equal(output.stdout, 'é\n');
  assert.equal(output.stderr, 'oops\n');
  assert.equal(output.stdoutBytes, 3);
  assert.equal(output.stderrBytes, 5);
  assert.equal(output.bytes, 8);
});

test('readiness handles fragmented lines and releases listeners', async () => {
  const stream = new PassThrough();
  const ready = firstLine(stream);
  stream.write('12');
  stream.write('345\nmore');
  assert.equal(await ready, '12345');
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('end'), 0);
});

test('readiness timeout and early EOF remain actionable', async () => {
  const stream = new PassThrough();
  await assert.rejects(firstLine(stream, 5), /sender did not print a line/);
  assert.equal(stream.listenerCount('data'), 0);
  const ended = new PassThrough();
  const ready = firstLine(ended);
  ended.end('diagnostic');
  await assert.rejects(ready, /sender ended before printing a line: diagnostic/);
});

test('browser evidence counts complete encrypted payloads after successful negotiated sends', async () => {
  const { runInNewContext } = await import('node:vm');
  const { browserTransportProbe } = await import('./bench-metrics.mjs');
  const result = runInNewContext(`
    class RTCDataChannel {
      constructor(label) { this.label = label; this.bufferedAmount = 123; }
      send() { if (this.fail) throw new Error('closed'); }
    }
    class WebSocket {
      constructor() { this.url = 'ws://localhost/ws/v1/transfer'; this.bufferedAmount = 456; }
      send() {}
    }
    const window = {};
    (${browserTransportProbe.toString()})();
    const chunk = new Uint8Array(12 + 17 + 16);
    chunk.set([0x43, 0x44, 1, 2]);
    new DataView(chunk.buffer).setUint32(8, 17);
    const channel = new RTCDataChannel('cd-direct');
    channel.send(chunk.subarray(0, 7));
    if (window.__benchTransport.directPayloadBytes !== 0) throw new Error('partial frame counted');
    channel.send(chunk.subarray(7));
    channel.fail = true;
    try { channel.send(chunk); } catch {}
    new RTCDataChannel('cd-raw').send(chunk);
    new WebSocket().send(chunk);
    window.__benchTransport;
  `, { URL });
  assert.equal(result.directPayloadBytes, 17);
  assert.equal(result.directBytes, 45);
  assert.equal(result.successfulDirectPieces, 2);
  assert.equal(result.relayPayloadBytes, 17);
  assert.equal(result.legacyBytes, 45);
  assert.equal(result.maxDirectBufferedBytes, 123);
  assert.equal(result.maxRelayBufferedBytes, 456);
  assert.equal(result.routes.join(','), 'direct,relay');
});
