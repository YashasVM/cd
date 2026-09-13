import assert from 'node:assert/strict';
import test from 'node:test';
import {
  P2P_CODE_LENGTH,
  cleanCode,
  codeFromUrl,
  generateCode,
  isValidCode,
  peerIdFor,
  receiveLinkFor,
} from './p2p-code.js';

test('generates a 128-bit base64url code', () => {
  const code = generateCode({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(code, '_____________________w');
  assert.equal(code.length, P2P_CODE_LENGTH);
  assert.equal(isValidCode(code), true);
});

test('preserves case and rejects short or decorated codes', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(cleanCode(` ${code}!`), code);
  assert.equal(isValidCode(code), true);
  assert.equal(isValidCode('waffle'), false);
});

test('puts private routing material in the URL fragment', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv';
  const link = receiveLinkFor(code, 'https://cd.yash0.in/anything?old=1');
  assert.equal(link, `https://cd.yash0.in/#p2p.${code}`);
  assert.equal(codeFromUrl(link), code);
  assert.equal(peerIdFor(code), `cd-${code}`);
});

test('does not turn an unrelated URL into a code', () => {
  assert.equal(codeFromUrl('https://example.com/abcdefghijklmnopqrstuv'), '');
});
