import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTransferOffer, rawChunkBytes, receiveWindowFor } from './raw-channel.js';

test('raw chunks respect the negotiated SCTP message size', () => {
  assert.equal(rawChunkBytes(undefined), 256 * 1024);
  assert.equal(rawChunkBytes(1024 * 1024 * 1024), 256 * 1024);
  assert.equal(rawChunkBytes(65_536), 65_536);
  assert.equal(rawChunkBytes(1000), 16 * 1024);
  assert.equal(rawChunkBytes(0), 256 * 1024);
});

test('transfer offers accept only sane windows and an explicit raw flag', () => {
  assert.deepEqual(parseTransferOffer({ raw: 1, window: 16 * 1024 * 1024 }), { raw: true, window: 16 * 1024 * 1024 });
  assert.deepEqual(parseTransferOffer(undefined), { raw: false, window: null });
  assert.deepEqual(parseTransferOffer({ raw: true, window: 1 }), { raw: false, window: null });
  assert.equal(parseTransferOffer({ window: 1e12 }).window, null);
  assert.equal(parseTransferOffer({ window: 2 * 1024 * 1024 + 0.5 }).window, null);
});

test('desktop receivers announce a larger window than phones', () => {
  const desktop = receiveWindowFor('Mozilla/5.0 (X11; Linux x86_64) Chrome/140');
  const phone = receiveWindowFor('Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140');
  assert.equal(desktop, 16 * 1024 * 1024);
  assert.equal(phone, 4 * 1024 * 1024);
  assert.equal(receiveWindowFor('desktop-looking', true), phone);
});
