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

test('capability parser rejects missing and malformed fragments', async () => {
  assert.throws(() => parseInvitation(new URL('https://cd.yash0.in/s/AAAAAAAAAAAAAAAAAAAAAA')), /link/);
  assert.throws(() => parseInvitation(new URL('https://cd.yash0.in/s/not-an-id#v1.bad')), /link/);
});
