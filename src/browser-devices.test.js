import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createDeviceCodec, newBrowserPair, validateBrowserPair } from './browser-devices.js';

const origin = 'https://cd.example';
const derive = (pair, role) => hkdfSync('sha256', Buffer.from(pair.secret, 'base64url'), Buffer.from(pair.pairId, 'base64url'), `cd-device-v1 ${role} messages`, 32);
function receiverFrame(pair, message) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(pair, 'receiver'), nonce);
  cipher.setAAD(Buffer.from(`cd-device-v1 receiver ${pair.pairId}`));
  return Buffer.concat([nonce, cipher.update(JSON.stringify({ version: 1, messageId: randomBytes(16).toString('base64url'), expiresAt: Date.now() + 60000, ...message })), cipher.final(), cipher.getAuthTag()]);
}

test('browser pairing restricts credential use to the original site', () => {
  const pair = newBrowserPair(origin);
  assert.equal(pair.relayUrl, `wss://cd.example/ws/devices/v1/${pair.pairId}`);
  assert.equal(validateBrowserPair(pair, origin), pair);
  for (const relayUrl of [pair.relayUrl.replace('cd.example', 'evil.example'), pair.relayUrl.replace('wss:', 'ws:'), pair.relayUrl + '?secret=1', pair.relayUrl.replace('wss://', 'wss://user@')]) {
    assert.throws(() => validateBrowserPair({ ...pair, relayUrl }, origin));
  }
  assert.throws(() => validateBrowserPair({ ...pair, secret: 'invalid' }, origin));
});

test('browser control frames interoperate with the Go AES-GCM wire format', async () => {
  const pair = newBrowserPair(origin);
  const codec = await createDeviceCodec(pair);
  const frame = await codec.seal({ type: 'offer', filename: 'photo.jpg' });
  const decipher = createDecipheriv('aes-256-gcm', derive(pair, 'sender'), frame.slice(0, 12));
  decipher.setAAD(Buffer.from(`cd-device-v1 sender ${pair.pairId}`));
  decipher.setAuthTag(frame.slice(-16));
  const message = JSON.parse(Buffer.concat([decipher.update(frame.slice(12, -16)), decipher.final()]));
  assert.equal(message.type, 'offer');
  assert.equal(message.filename, 'photo.jpg');
  assert.equal(message.version, 1);
  assert.equal(Buffer.from(message.messageId, 'base64url').length, 16);
  assert.ok(message.expiresAt > Date.now());
  const received = receiverFrame(pair, { type: 'paired', name: 'Pixel' });
  assert.equal((await codec.open(received)).name, 'Pixel');
  await assert.rejects(codec.open(received), /Replayed/);
});

test('receiver control rejects forged, expired and wrong-direction messages', async () => {
  const pair = newBrowserPair(origin);
  const codec = await createDeviceCodec(pair);
  const frame = receiverFrame(pair, { type: 'paired', name: 'Pixel' });
  frame[15] ^= 1;
  await assert.rejects(codec.open(frame));
  await assert.rejects(codec.open(receiverFrame(pair, { type: 'paired', name: 'Pixel', expiresAt: Date.now() - 1000 })), /Expired/);
  await assert.rejects(codec.open(receiverFrame(pair, { type: 'offer' })), /message type/);
  await assert.rejects(codec.open(receiverFrame(pair, { type: 'received', transferId: 'invalid' })));
  await assert.rejects(codec.open(receiverFrame(pair, { type: 'paired', name: 'Pixel\nforged' })), /name/);
});
