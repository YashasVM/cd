// Handler-level test/benchmark harness. No sockets, transport or Cloudflare
// runtime are measured here; attachments clone like the native API does.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

export async function loadTransferRoom(sourcePath = new URL('../worker/index.ts', import.meta.url)) {
  const source = await readFile(sourcePath, 'utf8');
  const result = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: new URL('../worker/', import.meta.url).pathname },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    plugins: [{ name: 'cloudflare-test-base', setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'base', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).TransferRoom;
}

export async function relayFixture(TransferRoom) {
  const counts = { scans: 0, reads: 0, writes: 0, forwarded: 0 };
  const socket = (role) => ({
    readyState: WebSocket.OPEN, bufferedAmount: 0, attachment: { kind: 'peer', role },
    sent: [], closed: [], retain: true,
    deserializeAttachment() { counts.reads++; return structuredClone(this.attachment); },
    serializeAttachment(value) { counts.writes++; this.attachment = structuredClone(value); },
    send(value) { counts.forwarded++; if (this.retain) this.sent.push(value); },
    close(code, reason) { this.closed.push({ code, reason }); this.readyState = WebSocket.CLOSED; },
  });
  const sender = socket('sender'), receiver = socket('receiver');
  const sockets = [sender, receiver];
  const paired = { kind: 'paired', receiverTokenHash: 'a'.repeat(43), expiresAt: Date.now() + 60_000 };
  let startup;
  const ctx = {
    getWebSockets() { counts.scans++; return sockets.filter(s => s.readyState === WebSocket.OPEN); },
    blockConcurrencyWhile(fn) { startup = fn(); return startup; },
    storage: {
      async get() { return structuredClone(paired); }, async put() {}, async getAlarm() { return null; }, async setAlarm() {},
    },
  };
  const reconstruct = async () => {
    const room = new TransferRoom(ctx, {});
    await startup;
    return room;
  };
  const room = await reconstruct();
  counts.scans = 0; counts.reads = 0;
  return { room, sender, receiver, sockets, socket, counts, reconstruct };
}
