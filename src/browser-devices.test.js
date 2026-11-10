import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createDeviceCodec, newBrowserPair, validateBrowserPair, validatePendingResume, ownsPendingRecord } from './browser-devices.js';
import { encodeBase64Url } from './agent-protocol.js';
import { signResumeCheckpoint } from './resume-protocol.js';

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

test('pending phone resume reuses only live authenticated credentials for the same source identity', async () => {
  const id = randomBytes(16), key = randomBytes(32), token = randomBytes(32);
  const rootId = id.toString('base64url');
  const link = `https://cd.example/s/${rootId}#v2.${key.toString('base64url')}`;
  const file = { name: 'photo.bin', size: 12 };
  const secret = { senderToken: encodeBase64Url(token), expiresAt: Date.now() + 60_000 };
  const checkpoints = new Map();
  const secrets = new Map([[`sender:${rootId}`, secret]]);
  const kv = map => ({ get: async key => map.get(key) });
  const checkpoint = await signResumeCheckpoint({
    version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: 262144,
    wholeSha256: 'a'.repeat(64), offset: 0, prefixSha256: 'b'.repeat(64), stagingId: 'sender-source',
    destination: 'source-reselect', expiresAt: secret.expiresAt, priorSessionNonce: randomBytes(32).toString('base64url')
  }, token);
  checkpoints.set(`sender:${rootId}`, checkpoint);
  assert.equal(await validatePendingResume(link, file, kv(secrets), kv(checkpoints), origin), true);
  await assert.rejects(validatePendingResume(link.replace('cd.example', 'other.example'), file, kv(secrets), kv(checkpoints), origin), /different CD site/);
  await assert.rejects(validatePendingResume(link, { ...file, name: 'changed.bin' }, kv(secrets), kv(checkpoints), origin), /does not match/);

  const forged = { ...checkpoint, wholeSha256: 'c'.repeat(64) };
  checkpoints.set(`sender:${rootId}`, forged);
  await assert.rejects(validatePendingResume(link, file, kv(secrets), kv(checkpoints), origin), /integrity/);

  const expiredAt = Date.now() - 1000;
  checkpoints.set(`sender:${rootId}`, await signResumeCheckpoint({ ...checkpoint, expiresAt: expiredAt }, token));
  secrets.set(`sender:${rootId}`, { ...secret, expiresAt: expiredAt });
  assert.equal(await validatePendingResume(link, file, kv(secrets), kv(checkpoints), origin), false);
  checkpoints.delete(`sender:${rootId}`);
  assert.equal(await validatePendingResume(link, file, kv(secrets), kv(checkpoints), origin), false);
});

test('a canceled phone send cannot delete a newer send pending record', () => {
  const newer = { pending: true, pendingId: 'new-send', pairId: 'same-phone', link: 'new-link' };
  assert.equal(ownsPendingRecord(newer, 'old-send'), false);
  assert.equal(ownsPendingRecord(newer, 'new-send'), true);
});
