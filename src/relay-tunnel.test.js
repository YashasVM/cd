import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTunnelCapability, openRelayTunnel, parseTunnelCapability } from './relay-tunnel.js';

const location = { protocol: 'https:', host: 'cd.test' };

// fakeRelay mimics the TransferRoom events the tunnel depends on: sender
// creates, receiver joins (4404 while empty), binary frames are forwarded,
// and a departing peer produces peer-left.
function fakeRelay({ tamper = false } = {}) {
  const peers = {};
  function connect() {
    const listeners = { open: [], message: [], close: [] };
    let role = null;
    let closed = false;
    const socket = {
      binaryType: 'blob',
      bufferedAmount: 0,
      addEventListener(event, listener) { listeners[event].push(listener); },
      send(data) {
        if (closed) return;
        if (typeof data === 'string') {
          const join = JSON.parse(data);
          if (join.role === 'receiver' && !peers.sender) { socket.close(4404); return; }
          role = join.role;
          peers[role] = socket;
          deliver(socket, JSON.stringify({ type: 'accepted' }));
          if (role === 'receiver') {
            deliver(socket, JSON.stringify({ type: 'peer-joined' }));
            deliver(peers.sender, JSON.stringify({ type: 'peer-joined' }));
          }
          return;
        }
        const other = peers[role === 'sender' ? 'receiver' : 'sender'];
        const bytes = new Uint8Array(data).slice();
        if (tamper) bytes[bytes.length - 1] ^= 1;
        if (other) deliver(other, bytes.buffer);
      },
      close(code = 1000) {
        if (closed) return;
        closed = true;
        queueMicrotask(() => listeners.close.forEach((listener) => listener({ code })));
        const other = role && peers[role === 'sender' ? 'receiver' : 'sender'];
        if (role) delete peers[role];
        if (other) deliver(other, JSON.stringify({ type: 'peer-left' }));
      },
      emit(event, value) { listeners[event].forEach((listener) => listener(value)); }
    };
    setTimeout(() => socket.emit('open'), 0);
    return socket;
  }
  function deliver(socket, data) {
    setTimeout(() => socket.emit('message', { data }), 0);
  }
  return { connect };
}

function once(tunnel, event) {
  return new Promise((resolve) => tunnel.on(event, resolve));
}

function collect(tunnel, count) {
  const values = [];
  return new Promise((resolve) => tunnel.on('data', (value) => {
    values.push(value);
    if (values.length === count) resolve(values);
  }));
}

test('tunnel carries JSON and bytes both ways, in order', async () => {
  const relay = fakeRelay();
  const capability = generateTunnelCapability();
  const creator = openRelayTunnel({ capability, role: 'creator', connect: relay.connect, location });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const joiner = openRelayTunnel({ capability, role: 'joiner', connect: relay.connect, location });
  await Promise.all([once(creator, 'open'), once(joiner, 'open')]);
  assert.equal(creator.open && joiner.open, true);

  const atCreator = collect(creator, 21);
  joiner.send({ type: 'manifest', totalFiles: 1 });
  for (let index = 0; index < 20; index += 1) joiner.send(new Uint8Array([index, index + 1, index + 2]).buffer);
  const received = await atCreator;
  assert.deepEqual(received[0], { type: 'manifest', totalFiles: 1 });
  received.slice(1).forEach((value, index) => {
    assert.ok(value instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(value)], [index, index + 1, index + 2]);
  });

  const atJoiner = collect(joiner, 1);
  creator.send({ type: 'progress', bytes: 60 });
  assert.deepEqual(await atJoiner, [{ type: 'progress', bytes: 60 }]);

  const closed = once(creator, 'close');
  joiner.close();
  await closed;
  assert.equal(creator.open, false);
});

test('a joiner that arrives before the creator retries until the room exists', async () => {
  const relay = fakeRelay();
  const capability = generateTunnelCapability();
  const joiner = openRelayTunnel({ capability, role: 'joiner', connect: relay.connect, location });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const creator = openRelayTunnel({ capability, role: 'creator', connect: relay.connect, location });
  await Promise.all([once(creator, 'open'), once(joiner, 'open')]);
  joiner.close();
});

test('a tampered record fails the tunnel instead of delivering data', async () => {
  const relay = fakeRelay({ tamper: true });
  const capability = generateTunnelCapability();
  const creator = openRelayTunnel({ capability, role: 'creator', connect: relay.connect, location });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const joiner = openRelayTunnel({ capability, role: 'joiner', connect: relay.connect, location });
  await Promise.all([once(creator, 'open'), once(joiner, 'open')]);
  let delivered = false;
  creator.on('data', () => { delivered = true; });
  const failed = once(creator, 'error');
  joiner.send({ type: 'manifest' });
  await failed;
  assert.equal(delivered, false);
  assert.equal(creator.open, false);
});

test('parseTunnelCapability accepts only well-formed metadata', () => {
  const capability = generateTunnelCapability();
  assert.deepEqual(parseTunnelCapability({ relay: capability }), capability);
  assert.equal(parseTunnelCapability(undefined), null);
  assert.equal(parseTunnelCapability({ relay: { transferId: 'short', key: capability.key } }), null);
  assert.equal(parseTunnelCapability({ relay: { transferId: capability.transferId, key: `${capability.key}=` } }), null);
});
