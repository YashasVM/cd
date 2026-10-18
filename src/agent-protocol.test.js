import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KIND_CHUNK,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  parseInvitation
} from './agent-protocol.js';

const id = Uint8Array.from({ length: 16 }, (_, index) => index);
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 32);

test('browser record codec preserves authenticated bytes', async () => {
  const sealer = await createSealer({ id, key }, SENDER_DIRECTION);
  const opener = await createOpener({ id, key }, SENDER_DIRECTION);
  const record = await sealer.seal(KIND_CHUNK, new TextEncoder().encode('exact bytes'));
  const opened = await opener.open(record);
  assert.equal(opened.kind, KIND_CHUNK);
  assert.equal(new TextDecoder().decode(opened.plaintext), 'exact bytes');
});

test('browser record codec rejects a sequence gap without advancing', async () => {
  const sealer = await createSealer({ id, key }, SENDER_DIRECTION);
  const opener = await createOpener({ id, key }, SENDER_DIRECTION);
  const first = await sealer.seal(KIND_CHUNK, new Uint8Array([1]));
  const second = await sealer.seal(KIND_CHUNK, new Uint8Array([2]));
  await assert.rejects(opener.open(second), /sequence/);
  assert.deepEqual([...((await opener.open(first)).plaintext)], [1]);
});

test('browser record codec rejects changed ciphertext', async () => {
  const sealer = await createSealer({ id, key }, SENDER_DIRECTION);
  const opener = await createOpener({ id, key }, SENDER_DIRECTION);
  const record = await sealer.seal(KIND_CHUNK, new TextEncoder().encode('exact bytes'));
  record[record.length - 1] ^= 1;
  await assert.rejects(opener.open(record), /authentication/);
});

test('browser opener decrypts ahead but releases records in order and rejects replay', async () => {
  const sealer = await createSealer({ id, key }, SENDER_DIRECTION);
  const opener = await createOpener({ id, key }, SENDER_DIRECTION);
  const first = await sealer.seal(KIND_CHUNK, new Uint8Array([1]));
  const second = await sealer.seal(KIND_CHUNK, new Uint8Array([2]));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const subtle = crypto.subtle;
  const decrypt = subtle.decrypt.bind(subtle);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let decryptCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: { decrypt(...args) {
      decryptCalls += 1;
      const result = decrypt(...args);
      return decryptCalls === 1 ? result.then(async (bytes) => { await firstGate; return bytes; }) : result;
    } }
  } });
  try {
    const openedFirst = opener.open(first);
    const openedSecond = opener.open(second);
    assert.equal(decryptCalls, 2);
    await assert.rejects(opener.open(first), /sequence/);
    let secondReleased = false;
    openedSecond.then(() => { secondReleased = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondReleased, false);
    releaseFirst();
    assert.deepEqual([...((await openedFirst).plaintext)], [1]);
    assert.deepEqual([...((await openedSecond).plaintext)], [2]);
  } finally {
    releaseFirst();
    Object.defineProperty(globalThis, 'crypto', original);
  }
});

test('authentication failure rejects later concurrent records', async () => {
  const sealer = await createSealer({ id, key }, SENDER_DIRECTION);
  const opener = await createOpener({ id, key }, SENDER_DIRECTION);
  const bad = await sealer.seal(KIND_CHUNK, new Uint8Array([1]));
  const later = await sealer.seal(KIND_CHUNK, new Uint8Array([2]));
  bad[bad.length - 1] ^= 1;
  const first = opener.open(bad);
  const second = opener.open(later);
  const secondRejected = assert.rejects(second, /authentication/);
  await assert.rejects(first, /authentication/);
  await secondRejected;
});

test('capability parser rejects missing and malformed fragments', async () => {
  assert.throws(() => parseInvitation(new URL('https://cd.yash0.in/s/AAAAAAAAAAAAAAAAAAAAAA')), /link/);
  assert.throws(() => parseInvitation(new URL('https://cd.yash0.in/s/not-an-id#v1.bad')), /link/);
});
