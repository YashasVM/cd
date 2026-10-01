import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZipBundle, crc32, fileSource, rechunk } from './zip-bundle.js';

async function collect(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip bundle size is exact and unzip restores every file', async () => {
  const files = [
    new File(['hello world'], 'a.txt'),
    new File([new Uint8Array(300_000).fill(7)], 'big.bin'),
    new File([], 'empty'),
    new File(['dup'], 'a.txt')
  ];
  const bundle = createZipBundle(files, { chunkBytes: 4096 });
  const bytes = await collect(bundle.stream());
  assert.equal(bytes.length, bundle.size);
  assert.match(bundle.name, /^cd-\d{8}-\d{6}\.zip$/);

  const dir = mkdtempSync(join(tmpdir(), 'cd-zip-'));
  writeFileSync(join(dir, 'b.zip'), bytes);
  execFileSync('unzip', ['-q', 'b.zip'], { cwd: dir });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello world');
  assert.equal(readFileSync(join(dir, 'a (2).txt'), 'utf8'), 'dup');
  assert.equal(readFileSync(join(dir, 'big.bin')).length, 300_000);
  assert.equal(readFileSync(join(dir, 'empty')).length, 0);
});

test('rechunk emits fixed-size pieces', async () => {
  const source = fileSource(new File([new Uint8Array(10_000)], 'x'), { chunkBytes: 333 });
  const sizes = [];
  for await (const piece of rechunk(source.stream(), 4096)) sizes.push(piece.length);
  assert.deepEqual(sizes, [4096, 4096, 1808]);
});
