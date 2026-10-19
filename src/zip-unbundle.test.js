import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZipBundle } from './zip-bundle.js';
import { downloadNames, readBundle, safeEntryPath } from './zip-unbundle.js';

async function collect(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  return new Blob(parts);
}

test('readBundle returns every file from a browser bundle', async () => {
  const big = new Uint8Array(300_000).map((_, index) => index % 251);
  const files = [new File(['hello'], 'a.txt'), new File([big], 'big.bin'), new File([], 'empty'), new File(['dup'], 'a.txt')];
  const read = await readBundle(await collect(createZipBundle(files, { chunkBytes: 4096 }).stream()));
  assert.deepEqual(read.map((file) => [file.path, file.size]), [['a.txt', 5], ['big.bin', 300_000], ['empty', 0], ['a (2).txt', 3]]);
  assert.equal(await read[0].blob.text(), 'hello');
  assert.deepEqual(new Uint8Array(await read[1].blob.arrayBuffer()), big);
});

test('readBundle reads folders from a Go-built bundle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-unbundle-'));
  mkdirSync(join(dir, 'docs', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'deep', 'note.md'), 'nested');
  writeFileSync(join(dir, 'top.txt'), 'top');
  try {
    execFileSync('zip', ['-0', '-qr', 'out.zip', 'docs', 'top.txt'], { cwd: dir });
  } catch {
    t.skip('zip is not installed');
    return;
  }
  const read = await readBundle(new Blob([readFileSync(join(dir, 'out.zip'))]));
  assert.deepEqual(read.map((file) => file.path).sort(), ['docs/deep/note.md', 'top.txt']);
  assert.equal(await read.find((file) => file.path === 'top.txt').blob.text(), 'top');
});

test('readBundle refuses archives it cannot hand out as-is', async () => {
  await assert.rejects(readBundle(new Blob(['not a zip'])));
});

test('safeEntryPath rejects escapes and control characters', () => {
  assert.equal(safeEntryPath('a/b.txt'), 'a/b.txt');
  assert.equal(safeEntryPath('folder/'), 'folder');
  for (const name of ['../x', '/etc/passwd', 'a/../b', 'a\\b', 'a\u0000b', '', 'a//b', './a']) assert.equal(safeEntryPath(name), null, name);
});

test('downloadNames flattens only colliding paths', () => {
  assert.deepEqual(downloadNames(['a.txt', 'x/b.txt', 'y/b.txt']), ['a.txt', 'x_b.txt', 'y_b.txt']);
});
