import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CdTransferClient } from '../packages/transfer-web/src/index.js';
const [mode, origin, invitationPath, resultPath] = process.argv.slice(2);
const bytes = Uint8Array.from({ length: 5 * 1024 * 1024 + 731 }, (_, i) => i % 251);
const expected = createHash('sha256').update(bytes).digest('hex');
const client = new CdTransferClient({ appId: 'com.example.web-peer', relayOrigin: origin });
let operation;
try {
  let result;
  if (mode === 'send') {
    operation = client.outgoing(new File([bytes], 'interop.bin'));
    result = await operation.run(async link => { await writeFile(`${invitationPath}.tmp`, link, { mode: 0o600 }); await rename(`${invitationPath}.tmp`, invitationPath); });
  } else {
    operation = client.incoming(await readFile(invitationPath, 'utf8'));
    const hash = createHash('sha256'); let size = 0;
    result = await operation.run(() => mode === 'reject' ? null : {
      write(chunk) {
        for (let i = 0; i < chunk.length; i++) if (chunk[i] !== (size + i) % 251) throw new Error('Wrong bytes');
        hash.update(chunk); size += chunk.length;
      },
      commit(file) { if (size !== bytes.length || hash.digest('hex') !== expected || file.sha256 !== expected) throw new Error('Wrong result'); },
      abort() {},
    });
  }
  if (result.size !== bytes.length || result.sha256 !== expected) throw new Error('Wrong verified result');
  await writeFile(resultPath, JSON.stringify({ state: operation.state, ...result }));
} catch (error) {
  await writeFile(resultPath, JSON.stringify({ state: error.state || 'failed' }));
  if (!(mode === 'reject' && error.state === 'rejected')) process.exitCode = 1;
}
