import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelaySend } from './relay-sender.js';
import { createZipBundle } from './zip-bundle.js';
import { createRecordAssembler, createRecordMerger } from './direct-link.js';
import { createOpener, createSealer, decodeBase64Url, KIND_ACCEPT, KIND_ACK, KIND_COMPLETE, KIND_OFFER, KIND_CHUNK, KIND_END, KIND_SIGNAL, SENDER_DIRECTION, RECEIVER_DIRECTION } from './agent-protocol.js';

function setup(t, payload, { largeChunks = false, directCandidate = null, privateMode = false, deferredHello = false, delayedOffer = false, releaseOnOffer = false, releaseOnChunk = false, holdACKsUntilDirect = false, dropRelayAfterUpgrade = false } = {}) {
  let instance;
  let offerStarted;
  const offerStartedPromise = new Promise(resolve => { offerStarted = resolve; });
  const installed = ['window', 'WebSocket', 'RTCPeerConnection'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const events = new EventTarget();
  globalThis.window = { location: new URL('http://localhost:9999'), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  globalThis.RTCPeerConnection = undefined;
  class FakeSocket extends EventTarget {
    bufferedAmount = 0;
    readyState = 1;
    received = [];
    acknowledged = 0;
    chain = Promise.resolve();
    merger = createRecordMerger();
    directChunks = 0;
    offers = [];
    signals = [];
    frames = [];
    directCiphertexts = [];
    constructor(url) { super(); instance = this; this.id = new URL(url).pathname.split('/').at(-1); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    message(data) {
      const event = new Event('message'); event.data = data;
      if (this.readyState !== 1 && typeof data !== 'string') this.peer.channel.dispatchEvent(event);
      else this.dispatchEvent(event);
    }
    async acknowledge() {
      const size = this.received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (size <= this.acknowledged) return;
      if (size - this.acknowledged < 1024 * 1024 && size !== payload.length) return;
      this.acknowledged = size;
      const counts = new Uint8Array(12); const view = new DataView(counts.buffer);
      view.setUint32(0, this.received.length); view.setBigUint64(4, BigInt(size));
      if (this.prefixAck) this.message('{}');
      this.message(await this.sealer.seal(KIND_ACK, counts));
    }
    send(data, viaDirect = false) {
      if (this.readyState !== 1 && !viaDirect) throw new Error('The simulated relay has closed.');
      if (viaDirect) this.directCiphertexts.push(data.slice());
      this.chain = this.chain.then(async () => {
        if (typeof data === 'string') {
          const join = JSON.parse(data);
          if (privateMode) {
            assert.equal(Object.hasOwn(join, 'shareKey'), false);
            this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'accepted' }));
            return;
          }
          const invitation = { id: decodeBase64Url(this.id), key: decodeBase64Url(join.shareKey) };
          this.opener = await createOpener(invitation, SENDER_DIRECTION);
          this.sealer = await createSealer(invitation, RECEIVER_DIRECTION);
          // Both arriving in one turn exercises pump resubscription while queued.
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'accepted', code: '11111' }));
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'peer-joined' }));
          if (deferredHello) this.message(await this.sealer.seal(KIND_SIGNAL, new TextEncoder().encode(JSON.stringify({ candidate: { candidate: '' }, deferredOffer: true }))));
          return;
        }
        if (viaDirect && data[3] === KIND_CHUNK && holdACKsUntilDirect) await this.acknowledge();
        if (!this.merger.push(data).length) return;
        const { kind, plaintext } = await this.opener.open(data);
        this.frames.push(kind);
        if (kind === KIND_OFFER) {
          const offer = JSON.parse(new TextDecoder().decode(plaintext));
          this.offers.push(offer);
          if (offer.directPending) this.opener.enableDirectSignal();
          if (releaseOnOffer) this.peer.releaseOffer();
          const selection = largeChunks ? new TextEncoder().encode(JSON.stringify({ chunkSize: offer.maxChunkSize })) : new Uint8Array();
          if (directCandidate) this.message(await this.sealer.seal(KIND_SIGNAL, new TextEncoder().encode(JSON.stringify({ sdp: 'answer' }))));
          this.message(await this.sealer.seal(KIND_ACCEPT, selection)); return;
        }
        if (kind === KIND_SIGNAL) {
          this.signals.push(JSON.parse(new TextDecoder().decode(plaintext)));
          if (dropRelayAfterUpgrade) this.message(await this.sealer.seal(KIND_SIGNAL, new TextEncoder().encode('{"sdp":"answer"}')));
          return;
        }
        if (kind === KIND_CHUNK) {
          this.received.push(plaintext);
          if (!viaDirect && !this.firstRelayChunk) this.firstRelayChunk = data.slice();
          if (releaseOnChunk) this.peer.releaseOffer();
          if (directCandidate && this.directChunks && !this.candidateSent) {
            this.candidateSent = true;
            this.message(await this.sealer.seal(KIND_SIGNAL, new TextEncoder().encode(JSON.stringify({ candidate: directCandidate }))));
          }
          if (!holdACKsUntilDirect || this.directChunks) await this.acknowledge();
          return;
        }
        if (kind === KIND_END) this.message(await this.sealer.seal(KIND_COMPLETE, plaintext));
      });
      this.chain.catch(() => {});
    }
    close() { this.readyState = 3; const event = new Event('close'); event.code = 1000; this.dispatchEvent(event); }
  }
  globalThis.WebSocket = FakeSocket;
  if (directCandidate || delayedOffer) {
    class FakeChannel extends EventTarget {
      readyState = 'connecting';
      bufferedAmount = 0;
      assembler = createRecordAssembler();
      send(piece) {
        for (const record of this.assembler.push(piece)) {
          if (record[3] === KIND_CHUNK) instance.directChunks++;
          instance.send(record, true);
          if (dropRelayAfterUpgrade && !instance.relayDropped) {
            instance.relayDropped = true;
            setTimeout(() => instance.close(1006), 0);
          }
        }
      }
    }
    globalThis.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = 'complete';
      channel = new FakeChannel();
      candidates = [];
      closedCount = 0;
      constructor() {
        super(); instance.peer = this;
        this.waitForOffer = new Promise((resolve, reject) => { this.releaseOffer = resolve; this.failOffer = reject; });
        this.closed = new Promise(resolve => { this.closedResolve = resolve; });
      }
      createDataChannel() { return this.channel; }
      async createOffer() { offerStarted(); if (delayedOffer) await this.waitForOffer; return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')); }
      async addIceCandidate(value) { this.candidates.push(value); }
      close() { this.closedCount++; this.channel.readyState = 'closed'; this.closedResolve(); }
    };
  }
  t.after(() => { for (const [name, descriptor] of installed) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const getInstance = () => instance;
  getInstance.offerStarted = offerStartedPromise;
  return getInstance;
}

function source(payload, pause = 0) {
  return { name: 'payload.bin', type: 'application/octet-stream', size: payload.length, async *stream() { if (pause) await delay(pause); yield payload; } };
}

test('relay fallback preserves exact encrypted bytes and drains queued admission events', async (t) => {
  const payload = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
  const socket = setup(t, payload);
  const stats = [];
  const transfer = startRelaySend(source(payload), { onTransport: (value) => stats.push(value) });
  await transfer.done;
  const received = Buffer.concat(socket().received.map((chunk) => Buffer.from(chunk)));
  assert.deepEqual(received, Buffer.from(payload));
  assert.equal(stats.at(-1).transport, 'relay');
  assert.equal(stats.at(-1).directBytes, 0);
  assert.ok(stats.at(-1).relayBytes > payload.length);
  assert.ok(stats.every((value) => value.retainedBytes === 0 && value.incomingBytes <= 4 * 1024 * 1024));
});

test('direct transfer accepts an encrypted ICE candidate after switching', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
  const candidate = { candidate: 'candidate:late 1 UDP 123 192.0.2.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  const socket = setup(t, payload, { directCandidate: candidate });
  await startRelaySend(source(payload)).done;
  assert.ok(socket().directChunks > 0);
  assert.deepEqual(socket().peer.candidates, [candidate]);
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
});

test('negotiated deferred offers start the file before SDP and send one authenticated late SDP before END', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array(1024).fill(31);
  const socket = setup(t, payload, { delayedOffer: true, deferredHello: true, releaseOnOffer: true });
  await startRelaySend(source(payload, 5)).done;
  assert.equal(socket().offers.length, 1);
  assert.equal(socket().offers[0].directPending, true);
  assert.equal(socket().offers[0].direct, undefined);
  assert.deepEqual(socket().signals, [{ sdp: 'offer' }]);
  assert.equal(socket().frames[0], KIND_OFFER);
  assert.ok(socket().frames.indexOf(KIND_SIGNAL) < socket().frames.indexOf(KIND_END));
  assert.equal(socket().frames.at(-1), KIND_END);
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
});

test('legacy receivers keep the complete initial SDP offer and never receive a late sender signal', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array([1, 2, 3]);
  const socket = setup(t, payload, { delayedOffer: true });
  const transfer = startRelaySend(source(payload));
  await socket.offerStarted;
  assert.equal(socket().offers.length, 0);
  socket().peer.releaseOffer();
  await transfer.done;
  assert.deepEqual(socket().offers[0].direct, { sdp: 'offer' });
  assert.equal(socket().offers[0].directPending, undefined);
  assert.deepEqual(socket().signals, []);
});

test('SDP resolving after a completed deferred transfer is closed without sending a signal after END', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array([7]);
  const socket = setup(t, payload, { delayedOffer: true, deferredHello: true });
  await startRelaySend(source(payload)).done;
  assert.equal(socket().offers[0].directPending, true);
  socket().peer.releaseOffer();
  await socket().peer.closed;
  assert.deepEqual(socket().frames, [KIND_OFFER, KIND_CHUNK, KIND_END]);
  assert.deepEqual(socket().signals, []);
});

test('deferred preparation retains unacknowledged early ciphertext for exact direct replay after relay loss', { timeout: 5000 }, async t => {
  const payload = new Uint8Array(2 * 1024 * 1024).fill(29);
  const socket = setup(t, payload, { delayedOffer: true, deferredHello: true, releaseOnChunk: true, holdACKsUntilDirect: true, dropRelayAfterUpgrade: true });
  const snapshots = [];
  await startRelaySend(source(payload), { onTransport: value => snapshots.push(value) }).done;
  assert.equal(socket().relayDropped, true);
  assert.ok(socket().firstRelayChunk, 'source bytes must have used the relay before SDP preparation finished');
  assert.ok(socket().directCiphertexts.some(record => Buffer.from(record).equals(Buffer.from(socket().firstRelayChunk))), 'early unacknowledged ciphertext must be replayed byte-for-byte');
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
  assert.ok(snapshots.some(value => value.retainedBytes > 262144));
  assert.ok(snapshots.every(value => value.retainedBytes <= 16 * 1024 * 1024));
});

test('failed direct preparation cannot be reactivated by an in-flight capability decrypt', { timeout: 5000 }, async t => {
  const payload = new Uint8Array(32 * 1024).fill(47);
  const socket = setup(t, payload, { delayedOffer: true, deferredHello: true });
  const subtle = crypto.subtle;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'decrypt');
  const original = subtle.decrypt;
  let started, release;
  const helloDecryptStarted = new Promise(resolve => { started = resolve; });
  const holdHelloDecrypt = new Promise(resolve => { release = resolve; });
  subtle.decrypt = async function(...args) {
    const value = await original.apply(this, args);
    if (new Uint8Array(args[0].additionalData)[3] === KIND_SIGNAL && new Uint8Array(args[0].iv)[2] === 0x52) {
      started();
      await holdHelloDecrypt;
    }
    return value;
  };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, 'decrypt', descriptor); else delete subtle.decrypt; });
  const snapshots = [];
  const transfer = startRelaySend(source(payload), { onTransport: value => snapshots.push(value) });
  await helloDecryptStarted;
  socket().peer.failOffer(new Error('Simulated direct preparation failure.'));
  await socket().peer.closed;
  await delay(0); // Let failure settle while the authenticated hello is still held.
  release();
  await transfer.done;
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
  assert.deepEqual(socket().signals, []);
  assert.ok(snapshots.every(value => value.retainedBytes === 0 && value.maxRetainedBytes === 0), 'failed preparation must not retain relay ciphertext');
});

test('bundled source fragments retain exact archive bytes through negotiated relay records', async (t) => {
  const bundle = createZipBundle([new File([new Uint8Array(3 * 1024 * 1024 + 17).fill(71)], 'part.bin')]);
  const parts = [];
  for await (const part of bundle.stream()) parts.push(Buffer.from(part));
  const payload = Buffer.concat(parts);
  const socket = setup(t, payload, { largeChunks: true });
  await startRelaySend(bundle).done;
  assert.deepEqual(Buffer.concat(socket().received.map(part => Buffer.from(part))), payload);
  assert.ok(socket().received.every(part => part.byteLength <= 262144));
});

test('negotiated limits allow relay-sized frames with cumulative ACKs and an adaptive window', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array(9 * 1024 * 1024 + 17).map((_, index) => index % 251);
  const socket = setup(t, payload, { largeChunks: true });
  await startRelaySend(source(payload)).done;
  assert.equal(socket().received[0].byteLength, 262144);
  assert.equal(socket().received.at(-1).byteLength, 17);
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
});

test('relay native queue applies backpressure and resumes after drain', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  let timer;
  const transfer = startRelaySend(source(payload), { onState(state) { if (state === 'transferring') { socket().bufferedAmount = 4 * 1024 * 1024; timer = setTimeout(() => { socket().bufferedAmount = 0; }, 25); } } });
  t.after(() => clearTimeout(timer));
  await transfer.done;
  assert.equal(socket().received.length, 4);
});

test('unsolicited responses cannot grow the sender queue without limit', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  const transfer = startRelaySend(source(payload, 25), { onState(state) { if (state === 'transferring') { for (let index = 0; index < 300; index += 1) socket().message('{}'); } } });
  await assert.rejects(transfer.done, /safe response buffer/);
});

test('ACKs advance progress while the next source read is blocked', async (t) => {
  const payload = new Uint8Array(2 * 1024 * 1024);
  const socket = setup(t, payload);
  let acknowledged = false;
  let wake;
  const progress = new Promise(resolve => { wake = resolve; });
  let timer;
  t.after(() => clearTimeout(timer));
  const input = {
    name: 'payload.bin', type: 'application/octet-stream', size: payload.length,
    async *stream() {
      yield payload.subarray(0, 1024 * 1024);
      await Promise.race([progress, new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
      assert.equal(acknowledged, true, 'delivered bytes must be acknowledged while source is waiting');
      yield payload.subarray(1024 * 1024);
    }
  };
  const transfer = startRelaySend(input, { onProgress(bytes) {
    if (bytes >= 1024 * 1024) { acknowledged = true; wake(); }
  } });
  await transfer.done;
  assert.equal(socket().received.length, 8);
});


test('source failure stops the concurrent ACK reader', async (t) => {
  setup(t, new Uint8Array(1024 * 1024));
  const input = { name: 'broken.bin', size: 1024 * 1024, async *stream() { throw new Error('read failed'); } };
  await assert.rejects(startRelaySend(input).done, /transfer failed/i);
});

test('empty source completes without waiting for an ACK', async (t) => {
  const payload = new Uint8Array();
  const socket = setup(t, payload);
  await startRelaySend(source(payload)).done;
  assert.equal(socket().received.length, 0);
});

test('short source fails instead of leaving the ACK reader waiting', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  setup(t, payload);
  const input = source(payload);
  input.size += 1;
  await assert.rejects(startRelaySend(input).done, /file changed/);
});


test('ignored control events do not strand a queued ACK', { timeout: 2000 }, async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  const transfer = startRelaySend(source(payload), { onState(state) {
    if (state === 'transferring') socket().prefixAck = true;
  } });
  t.after(() => transfer.cancel());
  await transfer.done;
});

test('private sharing omits the relay key and code registration', async (t) => {
  setup(t, new Uint8Array(), { privateMode: true });
  const prior = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Private mode must not register a code'); };
  t.after(() => { globalThis.fetch = prior; });
  let transfer;
  transfer = startRelaySend(source(new Uint8Array()), { onShare(value) {
    assert.equal(value.code, '');
    assert.match(value.url, /#v1\.[A-Za-z0-9_-]+$/);
    transfer.cancel();
  } }, { sharing: 'private' });
  await assert.rejects(transfer.done, /cancel/i);
});
