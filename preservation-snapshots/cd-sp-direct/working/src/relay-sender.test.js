import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createOpener, createSealer, decodeBase64Url, KIND_ACCEPT, KIND_ACK, KIND_CHUNK,
  KIND_COMPLETE, KIND_END, KIND_OFFER, RECEIVER_DIRECTION, SENDER_DIRECTION
} from './agent-protocol.js';
import { startRelaySend } from './relay-sender.js';

const CHUNK = 256 * 1024;
const originalWindow = globalThis.window;
const originalSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.WebSocket = originalSocket;
});

function counts(chunks, bytes) {
  const value = new Uint8Array(12);
  const view = new DataView(value.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, BigInt(bytes));
  return value;
}

function receiver({ ack = (chunks, bytes) => counts(chunks, bytes), completeEarly = false, closeOnComplete = false, holdAcks = false } = {}) {
  const state = { chunks: [], kinds: [], sequences: [], queued: Promise.resolve(), error: null };
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: 'http://localhost', protocol: 'http:', host: 'localhost' }
  });
  globalThis.WebSocket = class extends EventTarget {
    bufferedAmount = 0;
    constructor(url) {
      super();
      this.id = decodeBase64Url(url.split('/').pop());
      state.socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    send(data) {
      state.queued = state.queued.then(async () => {
        if (typeof data === 'string') {
          const join = JSON.parse(data);
          const invitation = { id: this.id, key: decodeBase64Url(join.shareKey) };
          state.opener = await createOpener(invitation, SENDER_DIRECTION);
          state.sealer = await createSealer(invitation, RECEIVER_DIRECTION);
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'accepted', code: '12345' }));
          // Queue irrelevant text before the next wanted event to exercise
          // draining the pump while its asynchronous handler is busy.
          this.message('{}');
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'peer-joined' }));
          return;
        }
        state.sequences.push(new DataView(data.buffer, data.byteOffset).getUint32(4));
        const { kind, plaintext } = await state.opener.open(data);
        state.kinds.push(kind);
        if (kind === KIND_OFFER) {
          this.message(await state.sealer.seal(KIND_ACCEPT, new Uint8Array()));
        } else if (kind === KIND_CHUNK) {
          state.chunks.push(plaintext);
          const bytes = state.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (!holdAcks) this.message(await state.sealer.seal(completeEarly ? KIND_COMPLETE : KIND_ACK, ack(state.chunks.length, bytes)));
        } else if (kind === KIND_END) {
          this.message(await state.sealer.seal(KIND_COMPLETE, plaintext));
          if (closeOnComplete) this.close(1000);
        }
      }).catch((error) => { state.error = error; this.close(4400); });
    }
    close(code) {
      const event = new Event('close');
      event.code = code;
      this.dispatchEvent(event);
    }
  };
  return state;
}

function source(chunks) {
  return { name: 'payload', size: chunks.reduce((sum, chunk) => sum + chunk.length, 0), async *stream() { yield* chunks; } };
}

test('continuous ACK consumer reports progress while the next source read is blocked', { timeout: 5000 }, async () => {
  receiver();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let progressed;
  const progress = new Promise((resolve) => { progressed = resolve; });
  const input = { name: 'blocked', size: 2 * CHUNK, async *stream() {
    yield new Uint8Array(CHUNK);
    await blocked;
    yield new Uint8Array(CHUNK).fill(1);
  } };
  const sender = startRelaySend(input, { onProgress(bytes) { if (bytes === CHUNK) progressed(); } });
  try {
    await progress;
    release();
    await sender.done;
  } finally { release(); sender.cancel(); }
});

test('pipelined chunks retain byte order and unique consecutive record sequences', { timeout: 5000 }, async () => {
  const received = receiver();
  const chunks = Array.from({ length: 40 }, (_, index) => new Uint8Array(CHUNK).fill(index));
  const progress = [];
  await startRelaySend(source(chunks), { onProgress(bytes) { progress.push(bytes); } }).done;
  assert.equal(received.error, null);
  assert.deepEqual(received.kinds, [KIND_OFFER, ...chunks.map(() => KIND_CHUNK), KIND_END]);
  assert.deepEqual(received.sequences, Array.from({ length: 42 }, (_, index) => index));
  assert.deepEqual(received.chunks, chunks);
  assert.deepEqual(progress, [0, ...chunks.map((_, index) => (index + 1) * CHUNK), chunks.length * CHUNK]);
});

for (const [name, ack] of [
  ['too many chunks', (chunks, bytes) => counts(chunks + 100, bytes)],
  ['bytes not sent', (chunks, bytes) => counts(chunks, bytes + 100 * CHUNK)],
  ['regressing bytes', (chunks, bytes) => counts(chunks, chunks === 2 ? 0 : bytes)],
  ['malformed counts', () => new Uint8Array(11)]
]) {
  test(`ACK consumer rejects ${name}`, { timeout: 5000 }, async () => {
    receiver({ ack });
    const sender = startRelaySend(source([new Uint8Array(CHUNK), new Uint8Array(CHUNK)]));
    await assert.rejects(sender.done, /invalid progress/);
  });
}

test('ACK consumer rejects COMPLETE before END', { timeout: 5000 }, async () => {
  receiver({ completeEarly: true });
  await assert.rejects(startRelaySend(source([new Uint8Array(CHUNK)])).done, /did not verify/);
});

test('empty source completes without waiting for an ACK', { timeout: 5000 }, async () => {
  const received = receiver();
  await startRelaySend(source([])).done;
  assert.deepEqual(received.kinds, [KIND_OFFER, KIND_END]);
});

test('cancellation interrupts a blocked source read and the ACK consumer', { timeout: 5000 }, async () => {
  receiver();
  let entered;
  const reading = new Promise((resolve) => { entered = resolve; });
  const input = { name: 'blocked', size: CHUNK, async *stream() {
    entered();
    await new Promise(() => {});
  } };
  const sender = startRelaySend(input);
  await reading;
  sender.cancel();
  await assert.rejects(sender.done, /Transfer canceled/);
});

for (const difference of [-1, 1]) {
  test(`source size change of ${difference} byte fails with pending seals safely drained`, { timeout: 5000 }, async () => {
    receiver();
    const input = source([new Uint8Array(CHUNK), new Uint8Array(CHUNK)]);
    input.size += difference;
    await assert.rejects(startRelaySend(input).done, /file changed/);
  });
}


test('COMPLETE received before close is authenticated before handling close', { timeout: 5000 }, async () => {
  receiver({ closeOnComplete: true });
  await startRelaySend(source([new Uint8Array(CHUNK)])).done;
});

test('read/seal prefetch stays bounded while the window waits for ACKs', { timeout: 5000 }, async () => {
  const received = receiver({ holdAcks: true });
  let reads = 0;
  const input = { name: 'bounded', size: 100 * CHUNK, async *stream() {
    for (let index = 0; index < 100; index += 1) {
      reads += 1;
      yield new Uint8Array(CHUNK);
    }
  } };
  const sender = startRelaySend(input);
  try {
    while (received.chunks.length < 31) await new Promise((resolve) => setTimeout(resolve, 1));
    // One more task turn lets the producer reach its blocked window wait.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(received.chunks.length, 31);
    assert.equal(reads, 34, '31 sent records plus at most three prepared chunks');
  } finally { sender.cancel(); }
  await assert.rejects(sender.done, /Transfer canceled/);
});
