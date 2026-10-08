import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncrementalSHA256 } from './incremental-sha256.js';

test('incremental SHA256 matches node across chunk boundaries and clone/final is nonmutating', () => {
  for (const size of [0,1,55,56,63,64,65,255,256,257,65539]) {
    const bytes=Uint8Array.from({length:size},(_,i)=>(i*37+11)&255), hasher=new IncrementalSHA256();
    for(let i=0;i<bytes.length;i+=17)hasher.update(bytes.subarray(i,i+17));
    const expected=createHash('sha256').update(bytes).digest('hex');
    assert.equal(hasher.digestHex(),expected);assert.equal(hasher.clone().digestHex(),expected);assert.equal(hasher.digestHex(),expected);
  }
});
