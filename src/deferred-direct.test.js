import assert from 'node:assert/strict';
import test from 'node:test';
import { mountRelayReceiver } from './share.js';
import { DEFERRED_DIRECT_MODE, deferredDirectHello, isDeferredDirectHello, deferredDirectSDP, directPending } from './deferred-direct.js';
import { createSealer, createOpener, encodeBase64Url, SENDER_DIRECTION, RECEIVER_DIRECTION, KIND_OFFER, KIND_SIGNAL, KIND_ACCEPT, KIND_CHUNK, KIND_END, KIND_COMPLETE } from './agent-protocol.js';

const encoder = new TextEncoder();
test('deferred negotiation requires explicit pending consent and bounds decoded UTF-8 SDP separately from JSON', () => {
  assert.equal(isDeferredDirectHello(deferredDirectHello()), true);
  assert.equal(isDeferredDirectHello(encoder.encode('{"deferredOffer":true}')), false);
  assert.equal(isDeferredDirectHello(encoder.encode('{"candidate":{"candidate":""},"deferredOffer":true,"sdp":"answer"}')), false);
  assert.equal(isDeferredDirectHello(new Uint8Array(1025)), false);
  assert.equal(directPending(undefined, false), false);
  assert.equal(directPending(true, true), true);
  assert.throws(() => directPending(true, false), /unnegotiated/);
  assert.throws(() => directPending(true, true, 'initial SDP'), /unnegotiated/);
  assert.throws(() => directPending('true', true), /invalid/);
  assert.equal(deferredDirectSDP(encoder.encode(JSON.stringify({ sdp: 'x'.repeat(65536) }))).length, 65536);
  assert.throws(() => deferredDirectSDP(encoder.encode(JSON.stringify({ sdp: 'é'.repeat(32769) }))), /invalid/);
  assert.throws(() => deferredDirectSDP(new Uint8Array(128 * 1024 + 1)), /oversized/);
  assert.throws(() => deferredDirectSDP(new Uint8Array([0xff])), /invalid/);
  assert.throws(() => deferredDirectSDP(encoder.encode('{"sdp":"offer","candidate":{}}')), /invalid/);
});

function receiverFixture(t, { hint = true, pending = true, duplicate = false, conflicting = false } = {}) {
  const descriptors = ['window', 'location', 'WebSocket', 'RTCPeerConnection', 'requestAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  class Element extends EventTarget {
    classList = { add() {} }; style = {}; hidden = false; textContent = '';
    children = new Map();
    querySelector(name) { if (!this.children.has(name)) this.children.set(name, new Element()); return this.children.get(name); }
    setAttribute() {}
    click() {} // A download UI action must not start a real browser in this test.
  }
  const container = new Element();
  const events = new EventTarget();
  const location = new URL('http://localhost:9999/');
  globalThis.window = { location, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  globalThis.location = location;
  globalThis.requestAnimationFrame = callback => queueMicrotask(callback);
  const peers = [];
  class Channel extends EventTarget { readyState = 'connecting'; bufferedAmount = 0; }
  globalThis.RTCPeerConnection = class extends EventTarget {
    channel = new Channel();
    constructor() { super(); peers.push(this); }
    createDataChannel() { return this.channel; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    close() { this.channel.readyState = 'closed'; }
  };
  const invitation = { id: new Uint8Array(16).fill(3), key: new Uint8Array(32).fill(7) };
  const bytes = new Uint8Array([1, 5, 9, 13]);
  let socket;
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0; chain = Promise.resolve(); hellos = []; sent = [];
    constructor() {
      super(); socket = this;
      this.crypto = Promise.all([createSealer(invitation, SENDER_DIRECTION), createOpener(invitation, RECEIVER_DIRECTION)]).then(([sealer, opener]) => { this.sealer = sealer; this.opener = opener; });
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    message(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event); }
    async emit(kind, data) { this.message(await this.sealer.seal(kind, data)); }
    async offer() {
      await this.emit(KIND_OFFER, encoder.encode(JSON.stringify({ name: 'test.bin', mediaType: 'application/octet-stream', size: String(bytes.length), chunkSize: 262144,
        ...(pending ? { directPending: true } : {}), ...(conflicting ? { direct: { sdp: 'initial' } } : {}) })));
      if (pending && hint && !conflicting) {
        this.sealer.enableDirectSignal();
        await this.emit(KIND_SIGNAL, encoder.encode('{"sdp":"deferred offer"}'));
        if (duplicate) await this.emit(KIND_SIGNAL, encoder.encode('{"sdp":"second offer"}'));
      }
    }
    send(data) {
      this.chain = this.chain.then(async () => {
        await this.crypto;
        if (typeof data === 'string') {
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'accepted', ...(hint ? { directOfferMode: DEFERRED_DIRECT_MODE } : {}) }));
          if (!hint) await this.offer();
          return;
        }
        const { kind, plaintext } = await this.opener.open(data);
        this.sent.push(kind);
        if (kind === KIND_SIGNAL && isDeferredDirectHello(plaintext)) { this.hellos.push(plaintext); await this.offer(); }
        if (kind === KIND_ACCEPT) {
          await this.emit(KIND_CHUNK, bytes);
          const counts = new Uint8Array(12), view = new DataView(counts.buffer);
          view.setUint32(0, 1); view.setBigUint64(4, BigInt(bytes.length));
          await this.emit(KIND_END, counts);
        }
      });
      this.chain.catch(() => {});
    }
    close(code = 1000) { this.readyState = 3; const event = new Event('close'); event.code = code; this.dispatchEvent(event); }
  }
  globalThis.WebSocket = Socket;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const stop = mountRelayReceiver(container, `http://localhost:9999/s/${encodeBase64Url(invitation.id)}#v1.${encodeBase64Url(invitation.key)}`, {
    autoReceive: true,
    hooks: { onState(state) { if (state === 'complete' || state === 'failed') finish(state); } }
  });
  t.after(() => {
    stop();
    const url = container.querySelector('[data-relay="download"]').href;
    if (url) URL.revokeObjectURL(url);
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { done, peers, bytes, socket: () => socket, container };
}

test('browser receiver negotiates one late SDP and verifies the same fallback bytes', { timeout: 5000 }, async t => {
  const fixture = receiverFixture(t);
  assert.equal(await fixture.done, 'complete');
  assert.equal(fixture.socket().hellos.length, 1);
  assert.equal(fixture.peers.length, 1);
  assert.deepEqual(fixture.peers[0].remoteDescription, { type: 'offer', sdp: 'deferred offer' });
  const result = await fetch(fixture.container.querySelector('[data-relay="download"]').href);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), fixture.bytes);
});

test('browser receiver emits no capability record to legacy sender or relay', { timeout: 5000 }, async t => {
  const fixture = receiverFixture(t, { hint: false, pending: false });
  assert.equal(await fixture.done, 'complete');
  assert.equal(fixture.socket().hellos.length, 0);
  assert.equal(fixture.socket().sent[0], KIND_ACCEPT);
});

for (const [name, options] of [['unnegotiated pending offer', { hint: false }], ['duplicate late offer', { duplicate: true }], ['conflicting initial and pending offers', { conflicting: true }]]) {
  test(`browser receiver rejects ${name}`, { timeout: 5000 }, async t => {
    const fixture = receiverFixture(t, options);
    assert.equal(await fixture.done, 'failed');
    assert.match(fixture.container.querySelector('[data-relay="status"]').textContent, /direct signaling/);
  });
}
