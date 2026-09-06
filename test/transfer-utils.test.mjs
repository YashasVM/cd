import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFiles, makeGuestLink, parseReceiveTarget } from '../src/transfer-utils.js';

const origin = 'http://127.0.0.1:5178';

test('file selections append in order', () => {
  const a = { name: 'a.txt' };
  const b = { name: 'b.txt' };
  assert.deepEqual(appendFiles([a], [b]), [a, b]);
});

test('guest links stay on the current product origin', () => {
  const link = makeGuestLink(origin, 'peer_123456');
  assert.equal(link, `${origin}/?guest=peer_123456`);
  assert.deepEqual(parseReceiveTarget(link, origin).target, {
    kind: 'guest', peerId: 'peer_123456', href: link,
  });
  assert.equal(parseReceiveTarget('peer_123456', origin).target.href, link);
});

test('email invitation links preserve their local capability', () => {
  const link = `${origin}/?emailTransfer=invite_123456#capability`;
  assert.deepEqual(parseReceiveTarget(link, origin).target, {
    kind: 'email', transferId: 'invite_123456', capability: 'capability', href: link,
  });
});

test('receive input rejects navigation and malformed transfers', () => {
  for (const value of [
    '',
    'javascript:alert(1)',
    'https://evil.example/?guest=peer_123456',
    `${origin}/elsewhere?guest=peer_123456`,
    `${origin}/?guest=`,
    `${origin}/?guest=short`,
    `${origin}/?guest=peer_123456&extra=1`,
    `${origin}/?guest=peer_123456#unexpected`,
  ]) assert.ok(parseReceiveTarget(value, origin).error, value);
});
