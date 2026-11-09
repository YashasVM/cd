import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { CdTransferClient, TransferError } from '../src/index.js';
const origin = process.env.CD_SDK_RELAY;
const options = { skip: !origin, timeout: 20_000 };
const client = () => new CdTransferClient({ appId: 'com.example.web', relayOrigin: origin });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = () => Uint8Array.from({ length: 5 * 1024 * 1024 + 731 }, (_, i) => i % 251);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function sink({ failCommit = false } = {}) {
  const chunks = [];
  return {
    committed: false, aborted: false, chunks,
    async write(bytes) { chunks.push(bytes.slice()); },
    async commit(result) { if (failCommit) throw new Error('Host disk failed'); this.committed = true; this.result = result; },
    async abort() { this.aborted = true; chunks.length = 0; },
    bytes() { return Buffer.concat(chunks); },
  };
}
function start(bytes, config = {}) {
  const ready = deferred();
  const op = client().outgoing(new File([bytes], 'archive.zip'), config);
  const done = op.run(ready.resolve);
  done.catch(() => {});
  return { op, done, link: ready.promise };
}
const failure = (promise, state) => assert.rejects(promise, error => error instanceof TransferError && (!state || error.state === state));

test('explicit host consent precedes all chunks; exact bytes/hash cross several windows', options, async () => {
  const bytes = payload();
  const states = [];
  const sending = start(bytes, { onUpdate: value => states.push(value.state) });
  const receiving = client().incoming(await sending.link);
  const offered = deferred(), consent = deferred();
  const destination = sink();
  const result = receiving.run(async offer => {
    assert.equal(offer.appId, 'com.example.web'); assert.equal(offer.sha256, hash(bytes));
    offered.resolve(); await consent.promise; return destination;
  });
  await offered.promise;
  assert.equal(destination.chunks.length, 0); assert.equal(states.includes('transferring'), false);
  consent.resolve();
  assert.deepEqual(await result, { size: bytes.length, sha256: hash(bytes) });
  assert.deepEqual(await sending.done, destination.result);
  assert.deepEqual(destination.bytes(), Buffer.from(bytes));
  assert.equal(receiving.state, 'complete');
  assert.ok(states.includes('verifying'));
  await assert.rejects(sending.op.run(() => {}), /already run/);
});

test('empty file verifies', options, async () => {
  const sending = start(new Uint8Array()); const destination = sink();
  const receiving = client().incoming(await sending.link);
  assert.deepEqual(await receiving.run(() => destination), { size: 0, sha256: hash(new Uint8Array()) });
  assert.deepEqual(await sending.done, destination.result);
});

test('rejection is explicit at both endpoints and sends no file bytes', options, async () => {
  const sending = start(payload()); const receiving = client().incoming(await sending.link);
  await Promise.all([failure(receiving.run(() => null), 'rejected'), failure(sending.done, 'rejected')]);
});

test('sender cancellation wakes waiting socket', options, async () => {
  const sending = start(payload()); await sending.link; sending.op.cancel();
  await failure(sending.done, 'cancelled');
});

test('receiver cancellation during a pending consent callback wakes run and aborts a late sink', options, async () => {
  const sending = start(payload()); const offered = deferred(), consent = deferred(); const destination = sink();
  const receiving = client().incoming(await sending.link);
  const result = receiving.run(() => { offered.resolve(); return consent.promise; });
  result.catch(() => {});
  await offered.promise; receiving.cancel(); await failure(result, 'cancelled');
  consent.resolve(destination); await new Promise(r => setTimeout(r, 0));
  assert.equal(destination.aborted, true); assert.equal(destination.committed, false);
  await failure(sending.done);
});

test('expiry wakes sender and expired invitation cannot deliver', options, async () => {
  const sending = start(new Uint8Array([1]), { lifetimeMs: 1200 }); const link = await sending.link;
  await failure(sending.done, 'expired');
  await failure(client().incoming(link).run(() => { throw new Error('Expired offer delivered'); }));
});

test('host storage failure prevents receiver COMPLETE and sender success', options, async () => {
  const sending = start(payload()); const destination = sink({ failCommit: true });
  const receiving = client().incoming(await sending.link);
  await Promise.all([failure(receiving.run(() => destination)), failure(sending.done)]);
  assert.equal(destination.aborted, true); assert.equal(destination.committed, false);
});

test('socket loss is recoverable and a fresh invitation works', options, async () => {
  const sending = start(payload()); let receiving;
  const destination = sink();
  const original = destination.write.bind(destination);
  const Native = globalThis.WebSocket;
  let socket;
  globalThis.WebSocket = class extends Native { constructor(url) { super(url); socket = this; } };
  destination.write = async bytes => { await original(bytes); socket.close(4000, 'simulated network loss'); };
  receiving = client().incoming(await sending.link);
  try { await Promise.all([failure(receiving.run(() => destination), 'recoverable-failure'), failure(sending.done, 'recoverable-failure')]); }
  finally { globalThis.WebSocket = Native; }
  assert.equal(destination.aborted, true);
  const retry = start(new Uint8Array([1, 2, 3]));
  await client().incoming(await retry.link).run(() => sink()); await retry.done;
});

test('modified source fails authenticated whole-file verification', options, async () => {
  const bytes = payload(); let calls = 0;
  const blob = new File([bytes], 'archive.zip');
  const mutable = { size: blob.size, name: blob.name, slice(start, end) {
    const chunk = bytes.slice(start, end);
    if (calls++ >= Math.ceil(bytes.length / 262144)) chunk[0] ^= 1;
    return new Blob([chunk]);
  } };
  const ready = deferred(); const op = client().outgoing(mutable);
  const sent = op.run(ready.resolve); sent.catch(() => {});
  const destination = sink();
  await Promise.all([failure(client().incoming(await ready.promise).run(() => destination)), failure(sent)]);
  assert.equal(destination.committed, false); assert.equal(destination.aborted, true);
});
