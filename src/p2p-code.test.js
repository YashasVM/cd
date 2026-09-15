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

test('word list is short lowercase slang', () => {
  assert.ok(P2P_WORDS.length >= 100);
  assert.equal(new Set(P2P_WORDS).size, P2P_WORDS.length);
  for (const word of P2P_WORDS) {
    assert.match(word, /^[a-z]{3,5}$/);
  }
});

test('generates a funny word deterministically', () => {
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
  assert.equal(isValidCode('YEET'), true);
  assert.equal(isValidCode('yeet'), true);
  assert.equal(normalizeCode('YEET'), 'yeet');
  assert.equal(peerIdFor('YEET'), 'cd-yeet');
  const link = receiveLinkFor('YEET', 'https://cd.yash0.in/anything?old=1');
  assert.equal(link, 'https://cd.yash0.in/#p2p.yeet');
  assert.equal(codeFromUrl(link), 'yeet');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.YEET'), 'yeet');
});

test('rejects random short strings that are not words', () => {
  assert.equal(isValidCode('waffle'), false);
  assert.equal(isValidCode('zzzz'), false);
  assert.equal(cleanCode(' yeet!'), 'yeet');
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
