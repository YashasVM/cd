import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const work = '/workspace/work/buffer-variants';
await mkdir(work, { recursive: true });
const env = { ...process.env, PATH: '/workspace/work/toolchains/go/bin:' + process.env.PATH, GOCACHE: '/workspace/work/go-cache', GOPATH: '/workspace/work/go' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceIdentity() {
  const files = ['go.mod', 'go.sum'];
  for (const root of ['cmd/cdx', 'worker']) for (const name of await readdir(root)) if ((name.endsWith('.go') && !name.endsWith('_test.go')) || name.endsWith('.ts')) files.push(join(root, name));
  return hash(JSON.stringify(await Promise.all(files.sort().map(async path => [path, hash(await readFile(path))]))));
}
const identity = await sourceIdentity(), input = join(work, 'payload.bin');
const file = await open(input, 'w');
try { for (let i = 0; i < 64; i++) await file.writeFile(randomBytes(1048576)); } finally { await file.close(); }
const report = { method: 'Diagnostic only: Go -overlay changes only relayWriteBufferSize; same64MiB random input; unchanged Wrangler runtime; separate3-run blocks in forward then reverse variant order; native output hashes/fsync/transport checked by unchanged matrix. Not final product acceptance evidence.', sourceIdentity: identity, startedAt: new Date().toISOString(), variants: {}, blocks: [] };
const source = await readFile('cmd/cdx/retry.go', 'utf8');
assert.ok(source.includes('const relayWriteBufferSize = 64 * 1024'));
for (const kib of [64, 256, 1024]) {
  const path = join(work, `retry-${kib}.go`), overlay = join(work, `overlay-${kib}.json`), binary = join(work, `cdx-${kib}`);
  const content = source.replace('const relayWriteBufferSize = 64 * 1024', `const relayWriteBufferSize = ${kib} * 1024`);
  await writeFile(path, content);
  await writeFile(overlay, JSON.stringify({ Replace: { [resolve('cmd/cdx/retry.go')]: path } }));
  execFileSync('/workspace/work/toolchains/go/bin/go', ['build', '-overlay', overlay, '-buildvcs=false', '-trimpath', '-o', binary, './cmd/cdx'], { env, stdio: 'inherit' });
  report.variants[kib] = { binary, binarySHA256: hash(await readFile(binary)), overlaySourceSHA256: hash(content) };
}
for (const [index, kib] of [64, 256, 1024, 1024, 256, 64].entries()) {
  assert.equal(await sourceIdentity(), identity, 'production source changed during buffer diagnostic');
  const output = join(work, `block-${index}-${kib}.json`), log = join(work, `block-${index}-${kib}.log`);
  const args = ['scripts/bench-croc-matrix.mjs', '--cdx', report.variants[kib].binary, '--croc', '/workspace/work/toolchains/bin/croc', '--runs', '3', '--routes', 'relay', '--input', input, '--storage', 'disk', '--disk-dir', work, '--cd-interval-ms', '0', '--seed', 'relay-buffer-diagnostic', '--output', output];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { text += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await writeFile(log, text); assert.equal(code, 0, text);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.rows.length, 9); assert.ok(result.rows.every(row => row.ok));
  report.blocks.push({ index, kib, output, cdRows: result.rows.filter(row => row.tool === 'cd') });
  await writeFile(join(work, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ index, kib, cdDurableMs: report.blocks.at(-1).cdRows.map(row => row.durableMs) }));
}
assert.equal(await sourceIdentity(), identity, 'production source changed during buffer diagnostic');
report.finishedAt = new Date().toISOString();
await writeFile(join(work, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
