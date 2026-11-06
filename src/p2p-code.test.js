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

test('generates a word pair deterministically', () => {
  const a = generateCode({ getRandomValues: (bytes) => bytes.fill(0x00) });
  const b = generateCode({ getRandomValues: (bytes) => bytes.fill(0x00) });
  assert.equal(a, b);
  assert.match(a, /^[a-z]{3,5}-[a-z]{3,5}$/);
  assert.equal(isValidCode(a), true);
});

test('still accepts legacy single words', () => {
  assert.equal(isValidCode('river'), true);
  assert.equal(normalizeCode('RIVER'), 'river');
  assert.equal(peerIdFor('river'), 'cd-river');
});

test('ephemeral ids stay random base64url', () => {
  const id = generateEphemeralId({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(id, '________');
  assert.equal(id.length, 8);
});

test('codes are case-insensitive but links stay lowercase', () => {
  assert.equal(isValidCode('RIVER-BRAVE'), true);
  assert.equal(isValidCode('river-brave'), true);
  assert.equal(normalizeCode('RIVER-BRAVE'), 'river-brave');
  assert.equal(peerIdFor('RIVER-BRAVE'), 'cd-river-brave');
  const link = receiveLinkFor('RIVER-BRAVE', 'https://cd.yash0.in/anything?old=1');
  assert.equal(link, 'https://cd.yash0.in/#p2p.river-brave');
  assert.equal(codeFromUrl(link), 'river-brave');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.RIVER-BRAVE'), 'river-brave');
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
