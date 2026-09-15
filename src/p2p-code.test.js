import assert from 'node:assert/strict';
import test from 'node:test';
import {
  P2P_WORDS,
  cleanCode,
  codeFromUrl,
  generateCode,
  generateEphemeralId,
  isValidCode,
  normalizeCode,
  peerIdFor,
  receiveLinkFor,
} from './p2p-code.js';

test('word list is short plain words', () => {
  assert.ok(P2P_WORDS.length >= 100);
  assert.equal(new Set(P2P_WORDS).size, P2P_WORDS.length);
  for (const word of P2P_WORDS) {
    assert.match(word, /^[a-z]{3,5}$/);
  }
});

test('generates a short word deterministically', () => {
  const a = generateCode({ getRandomValues: (bytes) => bytes.fill(0xff) });
  const b = generateCode({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(a, b);
  assert.ok(P2P_WORDS.includes(a));
  assert.equal(isValidCode(a), true);
});

test('ephemeral ids stay random base64url', () => {
  const id = generateEphemeralId({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(id, '________');
  assert.equal(id.length, 8);
});

test('codes are case-insensitive but links stay lowercase', () => {
  assert.equal(isValidCode('RIVER'), true);
  assert.equal(isValidCode('river'), true);
  assert.equal(normalizeCode('RIVER'), 'river');
  assert.equal(peerIdFor('RIVER'), 'cd-river');
  const link = receiveLinkFor('RIVER', 'https://cd.yash0.in/anything?old=1');
  assert.equal(link, 'https://cd.yash0.in/#p2p.river');
  assert.equal(codeFromUrl(link), 'river');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.RIVER'), 'river');
});

test('rejects random short strings that are not words', () => {
  assert.equal(isValidCode('waffle'), false);
  assert.equal(isValidCode('zzzz'), false);
  assert.equal(cleanCode(' mango!'), 'mango');
});

test('still accepts legacy random codes', () => {
  assert.equal(isValidCode('AbCdEfGh'), true);
  assert.equal(isValidCode('AbCdEfGhIjKlMnOpQrStUv'), true);
  assert.equal(peerIdFor('AbCdEfGh'), 'cd-AbCdEfGh');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.AbCdEfGh'), 'AbCdEfGh');
});

test('does not turn an unrelated URL into a code', () => {
  assert.equal(codeFromUrl('https://example.com/abcdefghijklmnopqrstuv'), '');
});
