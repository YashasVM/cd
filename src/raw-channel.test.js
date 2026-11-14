import assert from 'node:assert/strict';
import test from 'node:test';
import { openRawChannel, parseTransferOffer, rawChunkBytes, receiveWindowFor } from './raw-channel.js';

test('raw chunks respect the negotiated SCTP message size', () => {
  assert.equal(rawChunkBytes(undefined), 256 * 1024);
  assert.equal(rawChunkBytes(1024 * 1024 * 1024), 256 * 1024);
  assert.equal(rawChunkBytes(65_536), 65_536);
  assert.equal(rawChunkBytes(1000), 1000);
  assert.equal(rawChunkBytes(0), 256 * 1024);
});

test('raw channel chunks fit a peer with a small negotiated message limit', () => {
  const sent = [];
  const channel = new EventTarget();
  channel.send = (data) => {
    assert.ok(data.byteLength <= 1000, 'SCTP rejects messages above the negotiated limit');
    sent.push(data);
  };
  const raw = openRawChannel({ peerConnection: {
    sctp: { maxMessageSize: 1000 },
    createDataChannel() { return channel; }
  } });
  const payload = new Uint8Array(4097).fill(73);
  for (let offset = 0; offset < payload.length; offset += raw.maxChunkBytes) {
    raw.send(payload.subarray(offset, offset + raw.maxChunkBytes));
  }
  assert.deepEqual(Buffer.concat(sent), Buffer.from(payload));
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
