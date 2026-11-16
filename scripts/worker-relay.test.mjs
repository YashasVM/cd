import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTransferRoom, relayFixture } from './worker-relay-harness.mjs';

const TransferRoom = await loadTransferRoom();

test('warm relay forwards identical records and ACKs without scanning peers again', async () => {
  const { room, sender, receiver, counts } = await relayFixture(TransferRoom);
  const record = new Uint8Array([67, 68, 1, 2, 7]).buffer;
  await room.webSocketMessage(sender, record);
  assert.equal(receiver.sent[0], record, 'forward without copying ciphertext');
  await room.webSocketMessage(receiver, record);
  const scans = counts.scans, reads = counts.reads;
  for (let i = 0; i < 100; i++) await room.webSocketMessage(sender, record);
  assert.equal(counts.scans, scans);
  assert.equal(counts.reads - reads, 100, 'one attachment read for dispatch per frame');
  assert.equal(sender.sent[0], record);
});

test('a reconstructed instance rebuilds role cache from persisted attachments', async () => {
  const fixture = await relayFixture(TransferRoom);
  await fixture.room.webSocketMessage(fixture.sender, new ArrayBuffer(16));
  const room = await fixture.reconstruct();
  const scans = fixture.counts.scans;
  await room.webSocketMessage(fixture.sender, new ArrayBuffer(16));
  assert.equal(fixture.receiver.sent.length, 2);
  assert.equal(fixture.counts.scans, scans + 1);
});

test('cached closed socket is replaced only by an admitted open role', async () => {
  const { room, sender, receiver, sockets, socket } = await relayFixture(TransferRoom);
  await room.webSocketMessage(sender, new ArrayBuffer(16));
  receiver.readyState = WebSocket.CLOSED;
  const pending = socket('receiver'); pending.attachment = { kind: 'pending', expiresAt: Date.now() + 1000 };
  const admitted = socket('receiver');
  sockets.push(pending, admitted);
  const record = new ArrayBuffer(16);
  await room.webSocketMessage(sender, record);
  assert.equal(receiver.sent.length, 1);
  assert.equal(pending.sent.length, 0);
  assert.equal(admitted.sent[0], record);
});

test('cached closed receiver cannot receive another frame', async () => {
  const { room, sender, receiver } = await relayFixture(TransferRoom);
  await room.webSocketMessage(sender, new ArrayBuffer(16));
  receiver.readyState = WebSocket.CLOSED;
  await room.webSocketMessage(sender, new ArrayBuffer(16));
  assert.equal(receiver.sent.length, 1);
  assert.equal(sender.closed.at(-1).code, 4404);
});

test('buffer limit remains enforced for a cached peer', async () => {
  const { room, sender, receiver } = await relayFixture(TransferRoom);
  await room.webSocketMessage(sender, new ArrayBuffer(16));
  receiver.bufferedAmount = 32 * 1024 * 1024;
  await room.webSocketMessage(sender, new ArrayBuffer(16));
  assert.equal(receiver.sent.length, 1);
  assert.equal(sender.closed.at(-1).code, 4429);
  assert.equal(receiver.closed.at(-1).code, 4429);
});

test('malformed attachments and oversized records cannot use the cache', async () => {
  for (const malformed of [true, false]) {
    const { room, sender, receiver } = await relayFixture(TransferRoom);
    await room.webSocketMessage(sender, new ArrayBuffer(16));
    if (malformed) sender.attachment = { kind: 'peer', role: 'attacker' };
    await room.webSocketMessage(sender, new ArrayBuffer(malformed ? 16 : 1024 * 1024 + 1));
    assert.equal(receiver.sent.length, 1);
    assert.equal(sender.closed.at(-1).code, malformed ? 4400 : 4403);
  }
});
