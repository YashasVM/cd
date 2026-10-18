import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SendWindow, MIN_SEND_WINDOW, MAX_SEND_WINDOW } from './send-window.js';

const MIB = 1024 * 1024;
const CHUNK = 256 * 1024;

function simulate(bandwidth, rtt, total) {
  const window = new SendWindow();
  let now = 0;
  let linkFree = 0;
  const acks = [];
  while (window.acknowledged < BigInt(total)) {
    while (window.sent < BigInt(total) && window.inFlightBytes + CHUNK + 28 <= window.size) {
      window.recordSent(CHUNK, CHUNK + 28, now);
      linkFree = Math.max(now, linkFree) + CHUNK / bandwidth * 1000;
      if (window.sent % BigInt(MIB) === 0n || window.sent === BigInt(total)) {
        acks.push({ at: linkFree + rtt, bytes: window.sent, chunks: window.chunks });
      }
    }
    const ack = acks.shift();
    assert.ok(ack, 'window must allow another acknowledgement');
    now = ack.at;
    window.acknowledge(ack, now);
  }
  return { window, throughput: total / now * 1000 };
}

test('window grows to 24 MiB on a fast path with 300 ms RTT', () => {
  const { window, throughput } = simulate(200 * MIB, 300, 2048 * MIB);
  assert.equal(window.size, MAX_SEND_WINDOW);
  assert.ok(throughput > 60 * MIB);
});

test('window stays at 8 MiB on a slow path', () => {
  const { window } = simulate(2 * MIB, 150, 64 * MIB);
  assert.equal(window.size, MIN_SEND_WINDOW);
});

test('arrival times track the most recently covered record and minimum RTT', () => {
  const window = new SendWindow();
  window.recordSent(1024, 1052, 0);
  window.recordSent(1024, 1052, 10);
  window.acknowledge({ bytes: 2048n, chunks: 2 }, 90);
  assert.equal(window.minRTT, 80);
  assert.equal(window.samples.length, 0);
  assert.equal(window.inFlightBytes, 0);
  window.recordSent(1024, 1052, 100);
  window.acknowledge({ bytes: 3072n, chunks: 3 }, 200);
  assert.equal(window.minRTT, 80);
});

test('record overhead and local buffered bytes count against the window', async () => {
  const window = new SendWindow();
  for (let index = 0; index < 31; index += 1) window.recordSent(CHUNK, CHUNK + 28, index);
  let opened = false;
  const room = window.waitForSpace(CHUNK + 28, () => 0).then(() => { opened = true; });
  await Promise.resolve();
  assert.equal(opened, false, 'a 32nd record would exceed 8 MiB including headers/tags');
  window.acknowledge({ bytes: BigInt(MIB), chunks: 4 }, 100);
  await room;
  assert.equal(opened, true);

  // Bytes in the local socket queue also belong to the ACK window.
  await window.waitForSpace(CHUNK + 28, () => 2 * MIB);
  const large = new SendWindow();
  large.size = MAX_SEND_WINDOW;
  for (let index = 0; index < 92; index += 1) large.recordSent(CHUNK, CHUNK + 28, index);
  let buffered = 9 * MIB;
  opened = false;
  const drainage = large.waitForSpace(CHUNK + 28, () => buffered).then(() => { opened = true; });
  await Promise.resolve();
  assert.equal(opened, false);
  buffered = 0;
  await drainage;
  assert.equal(opened, true, 'local socket drainage wakes a sender without another ACK');
});

test('ACK validation preserves chunk and byte checks, including partial offsets', () => {
  const window = new SendWindow();
  window.recordSent(100, 128, 0);
  assert.throws(() => window.acknowledge({ bytes: 101n, chunks: 1 }, 1), /invalid progress/);
  assert.throws(() => window.acknowledge({ bytes: 100n, chunks: 2 }, 1), /invalid progress/);
  window.acknowledge({ bytes: 50n, chunks: 1 }, 1);
  assert.equal(window.inFlightBytes, 128);
  assert.throws(() => window.acknowledge({ bytes: 49n, chunks: 1 }, 2), /invalid progress/);
  window.acknowledge({ bytes: 100n, chunks: 1 }, 3);
  assert.equal(window.inFlightBytes, 0);
});

test('failure rejects all waits and prevents further sends', async () => {
  const window = new SendWindow();
  window.recordSent(MIN_SEND_WINDOW, MIN_SEND_WINDOW + 28, 0);
  const space = window.waitForSpace(100, () => 0);
  const ack = window.waitForAcknowledged();
  const error = new Error('receiver left');
  window.fail(error);
  await assert.rejects(space, /receiver left/);
  await assert.rejects(ack, /receiver left/);
  await assert.rejects(window.failed, /receiver left/);
  assert.equal(window.waiters.size, 0);
  assert.throws(() => window.recordSent(1, 29, 1), /receiver left/);
});
