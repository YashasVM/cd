import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDirectRuntime } from './bench-direct-runtime.mjs';

test('the direct-runtime frontend preserves the browser origin through its proxy', async () => {
  const work = await mkdtemp(join(tmpdir(), 'cd-runtime-origin-'));
  let runtime;
  try {
    const bundle = join(work, 'worker.mjs');
    await writeFile(bundle, `
import { DurableObject } from 'cloudflare:workers';
export class TransferRoom extends DurableObject {}
export class PeerSignal extends DurableObject {}
export class CodeDirectory extends DurableObject {}
export class DeviceRoom extends DurableObject {}
export default {fetch(request) {
  return new Response(null, {status: request.headers.get('Origin') === new URL(request.url).origin ? 204 : 403});
}};
`);
    runtime = await startDirectRuntime(bundle, { compression: false, assets: true });
    const response = await fetch(runtime.publicBase + '/api/health', { headers: { Origin: runtime.publicBase } });
    assert.equal(response.status, 204);
    const crossOrigin = await fetch(runtime.publicBase + '/api/health', { headers: { Origin: 'https://other.example' } });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await runtime?.stop();
    await rm(work, { recursive: true, force: true });
  }
});
