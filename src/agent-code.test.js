import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanShortCode,
  codeLookupPath,
  isShortCode,
  parseCapability,
  shareUrlFromCapability
} from './agent-code.js';

describe('short share codes', () => {
  it('accepts four or five digits', () => {
    assert.equal(isShortCode('48291'), true);
    assert.equal(isShortCode('  4829  '), true);
    assert.equal(isShortCode('river-cloud'), false);
    assert.equal(isShortCode('482a1'), false);
    assert.equal(isShortCode('123456'), false);
    assert.equal(isShortCode(''), false);
    assert.equal(isShortCode(null), false);
  });

  it('builds the lookup path', () => {
    assert.equal(codeLookupPath('48291'), '/api/codes/48291');
    assert.throws(() => codeLookupPath('river-cloud'), /invalid share code/);
  });

  it('builds share links from capabilities', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    assert.equal(
      shareUrlFromCapability('https://cd.yash0.in', id, key),
      `https://cd.yash0.in/s/${id}#v1.${key}`
    );
    assert.throws(() => shareUrlFromCapability('https://cd.yash0.in', 'short', key), /invalid/);
  });

  it('parses lookup responses strictly', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    assert.deepEqual(parseCapability({ transferId: id, key }), { transferId: id, key });
    assert.throws(() => parseCapability({ transferId: id }), /invalid/);
    assert.throws(() => parseCapability(null), /invalid/);
  });

  it('cleans pasted codes', () => {
    assert.equal(cleanShortCode('  48291\n'), '48291');
  });
});
