// Real old/new executable interoperability through the current local Worker.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCLI, captureOutput, childExit, cliEnv, firstLine, startWorker, stopChild } from './harness.mjs';

assert.ok(process.argv[2], 'usage: node scripts/verify-legacy-cli.mjs /absolute/old-cdx [report.json]');
const legacy = resolve(process.argv[2]);
const output = resolve(process.argv[3] || '/tmp/cd-legacy-interop.json');
const work = await mkdtemp(join(tmpdir(), 'cd-legacy-interop-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), method: 'Actual old and new binaries, same current local Worker, numeric code, exact full output SHA256 and size. Both ordinary direct discovery and forced relay. Compatibility check, not performance evidence.', rows: [] };
let worker;
const children = new Set();
try {
  const current = await buildCLI(work);
  report.binaries = { legacy: sha(await readFile(legacy)), current: sha(await readFile(current)) };
  worker = await startWorker(work);
  for (const kind of ['random', 'compressible']) {
    const data = kind === 'random' ? randomBytes(4 * 1048576 + 17) : Buffer.alloc(4 * 1048576 + 17, 65);
    const input = join(work, `${kind}.bin`); await writeFile(input, data);
    for (const route of ['auto', 'relay']) for (const [from, to] of [['legacy', 'current'], ['current', 'legacy']]) {
      const directory = join(work, `${kind}-${route}-${from}`); await mkdir(directory);
      const target = join(directory, `${kind}.bin`);
      const env = cliEnv(worker, { CD_DIRECT: route === 'relay' ? '0' : '1', CD_STATE_DIR: join(directory, 'state'), CD_TRANSPORT_REPORT: '1' });
      const binaries = { legacy, current };
      const sender = spawn(binaries[from], ['send', '--wait', input], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(sender); const senderOutput = captureOutput(sender);
      const row = { kind, route, from, to, ok: false, input: { bytes: data.length, sha256: sha(data) } };
      let receiver;
      try {
        const code = await firstLine(sender.stdout); assert.match(code, /^\d{4,5}$/);
        receiver = spawn(binaries[to], ['receive', code, '--out', target], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(receiver); const receiverOutput = captureOutput(receiver);
        assert.equal(await childExit(receiver, 30000), 0, receiverOutput.stderr);
        assert.equal(await childExit(sender, 30000), 0, senderOutput.stderr);
        const bytes = await readFile(target);
        row.received = { bytes: bytes.length, sha256: sha(bytes) };
        assert.deepEqual(row.received, row.input);
        row.ok = true;
      } catch (error) { row.error = error.message; }
      finally { await stopChild(sender); await stopChild(receiver); children.delete(sender); children.delete(receiver); }
      report.rows.push(row); console.log(JSON.stringify(row));
    }
  }
} catch (error) { report.error = error.message; }
finally {
  for (const child of children) await stopChild(child);
  await worker?.stop(); await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.error || report.rows.length !== 8 || report.rows.some(row => !row.ok)) process.exitCode = 1;
