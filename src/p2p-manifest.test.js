import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_P2P_FILE_BYTES, parseManifest } from './p2p-manifest.js';

const valid = () => ({
  type: 'manifest', totalFiles: 1, totalSize: 3,
  files: [{ index: 0, name: 'hello.txt', size: 3, mimeType: 'text/plain' }],
});

test('accepts an exact manifest', () => assert.deepEqual(parseManifest(valid()), {
  totalFiles: 1, totalSize: 3,
  files: [{ index: 0, name: 'hello.txt', size: 3, mimeType: 'text/plain' }],
}));

test('rejects traversal, count, size, and total mismatches', () => {
  for (const mutate of [
    (m) => { m.files[0].name = '../secret'; },
    (m) => { m.totalFiles = 2; },
    (m) => { m.files[0].size = MAX_P2P_FILE_BYTES + 1; },
    (m) => { m.totalSize = 4; },
  ]) {
    const manifest = valid();
    mutate(manifest);
    assert.throws(() => parseManifest(manifest));
  }
});
