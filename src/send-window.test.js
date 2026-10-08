import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendWindow } from './send-window.js';

const MiB = 1024 * 1024;

test('capacity admits complete chunks and prevents an extra chunk overflow', () => {
  const window = createSendWindow();
  assert.equal(window.canSend(4 * MiB), true);
  window.sent(4n * BigInt(MiB), 0);
  assert.equal(window.capacity, 0);
  assert.equal(window.canSend(256 * 1024), false);
  assert.throws(() => window.sent(4n * BigInt(MiB) + 1n, 0), /available window/);
  window.acked(1n * BigInt(MiB), 100);
  assert.equal(window.capacity, MiB);
});

test('slow delivery shrinks the window while outstanding data remains accounted', () => {
  const window = createSendWindow();
  window.sent(4 * MiB, 0);
  window.acked(MiB, 1000);
  window.acked(2 * MiB, 3000);
  assert.equal(window.size, MiB);
  assert.equal(window.inFlight, 2 * MiB);
  assert.equal(window.capacity, 0);
  window.acked(4 * MiB, 5000);
  assert.equal(window.inFlight, 0);
  assert(window.size >= MiB);
});

test('sustained full-window receipts grow within the configured maximum', () => {
  const window = createSendWindow();
  let sent = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    sent += window.capacity;
    window.sent(sent, cycle * 100);
    window.acked(sent, cycle * 100 + 100);
    assert(window.size <= 12 * MiB);
    assert.equal(window.inFlight, 0);
  }
  assert.equal(window.size, 12 * MiB);
});

test('ACK compression and zero RTT do not inflate a window without a delivery interval', () => {
  const window = createSendWindow();
  window.sent(4 * MiB, 0);
  window.acked(MiB, 0);
  window.acked(2 * MiB, 0);
  window.acked(3 * MiB, 1);
  window.acked(4 * MiB, 1);
  assert.equal(window.size, 4 * MiB);
  assert.equal(window.snapshot().sampleCount, 0);
});

test('invalid ACKs and clocks leave accounting unchanged', () => {
  const window = createSendWindow();
  window.sent(MiB, 10);
  window.acked(MiB / 2, 20);
  const before = window.snapshot();
  for (const [bytes, at] of [[MiB / 4, 30], [2 * MiB, 30], [MiB, 19], [-1, 30], [Number.MAX_SAFE_INTEGER + 1, 30]]) {
    assert.throws(() => window.acked(bytes, at), RangeError);
    assert.deepEqual(window.snapshot(), before);
  }
  assert.equal(window.acked(MiB / 2, 20), false);
});

test('tiny chunks use bounded metadata and payload is never retained', () => {
  const window = createSendWindow();
  for (let i = 1; i <= 100_000; i++) window.sent(i, i);
  assert.equal(window.snapshot().sampleCount, 64);
  window.acked(100_000n, 100_001);
  assert.equal(window.snapshot().sampleCount, 0);
});

test('bounds reject unsafe allocations', () => {
  for (const options of [{ maxBytes: 32 * MiB }, { minBytes: 8 * MiB }, { initialBytes: 0 }, { maxBytes: Infinity }]) {
    assert.throws(() => createSendWindow(options), RangeError);
  }
});
