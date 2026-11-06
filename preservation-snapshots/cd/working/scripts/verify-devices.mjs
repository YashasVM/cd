import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCLI, childExit, cliEnv, collect, firstLine, startWorker, stopChild, withTimeout } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-devices-'));
let worker;
let pairing;
const sockets = [];
let keepalive;
function channel(endpoint) {
  const ws = new WebSocket(endpoint);
  sockets.push(ws);
  ws.binaryType = 'arraybuffer';
  const pending = [];
  const buffered = [];
  const push = value => pending.length ? pending.shift()(value) : buffered.push(value);
  ws.addEventListener('message', event => push({ message: event.data }));
  ws.addEventListener('close', event => push({ close: event.code }));
  ws.addEventListener('error', () => {});
  return {
    ws,
    open: withTimeout(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 10000, 'device socket did not open'),
    next: (timeout=10000) => withTimeout(buffered.length ? Promise.resolve(buffered.shift()) : new Promise(resolve => pending.push(resolve)), timeout, 'device event timed out')
  };
}
async function event(c, type) {
  for (;;) {
    const next = await c.next();
    assert.ok(!next.close, `unexpected close ${next.close}`);
    assert.equal(typeof next.message, 'string');
    const value = JSON.parse(next.message);
    assert.equal(value.protocol, 'cd-device-v1');
    if (value.type === type) return;
  }
}
const encoded = b => b.toString('base64url');
const hash = b => encoded(createHash('sha256').update(b).digest());
try {
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  const env = cliEnv(worker, { CD_DEVICE_DIR: join(work, 'devices'), CD_STATE_DIR: join(work, 'state') });
  pairing = spawn(executable, ['pair', '--name', 'test-phone', '--json', '--listen', '127.0.0.1:0', '--advertise-host', '127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const diagnostics = collect(pairing.stderr);
  const ready = JSON.parse(await firstLine(pairing.stdout));
  const pair = JSON.parse(Buffer.from(ready.qr.split('#')[1], 'base64url'));
  const secret = Buffer.from(pair.secret, 'base64url');
  const id = Buffer.from(pair.pairId, 'base64url');
  const derive = info => Buffer.from(hkdfSync('sha256', secret, id, `cd-device-v1 ${info}`, 32));
  const receiver = channel(pair.relayUrl);
  await receiver.open;
  receiver.ws.send(JSON.stringify({ type: 'join', protocol: 'cd-device-v1', role: 'receiver', token: encoded(derive('receiver join')) }));
  await event(receiver, 'accepted');
  await event(receiver, 'peer-joined');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive('receiver messages'), nonce);
  cipher.setAAD(Buffer.from(`cd-device-v1 receiver ${pair.pairId}`));
  const message = JSON.stringify({ version: 1, type: 'paired', messageId: encoded(randomBytes(16)), expiresAt: Date.now() + 299000, name: 'Test Android' });
  receiver.ws.send(Buffer.concat([nonce, cipher.update(message), cipher.final(), cipher.getAuthTag()]));
  assert.equal(await childExit(pairing, 15000), 0, await diagnostics);
  await event(receiver, 'peer-left');
  const listing = spawn(executable, ['devices', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const listingOutput = collect(listing.stdout);
  assert.equal(await childExit(listing), 0);
  const listed = await listingOutput;
  assert.deepEqual(JSON.parse(listed).devices, [{ name: 'test-phone', pairId: pair.pairId, deviceName: 'Test Android' }]);
  assert.ok(!listed.includes(pair.secret));

  const senderJoin = { type: 'join', protocol: 'cd-device-v1', role: 'sender', token: encoded(derive('sender join')), senderTokenHash: hash(derive('sender join')), receiverTokenHash: hash(derive('receiver join')) };
  const sender = channel(pair.relayUrl);
  await sender.open;
  sender.ws.send(JSON.stringify(senderJoin));
  await event(sender, 'accepted');
  await event(sender, 'peer-joined');
  await event(receiver, 'peer-joined');
  const binary = randomBytes(256);
  sender.ws.send(binary);
  const forwarded = await receiver.next();
  assert.deepEqual(Buffer.from(forwarded.message), binary);
  const forged = channel(pair.relayUrl);
  await forged.open;
  forged.ws.send(JSON.stringify({ ...senderJoin, token: encoded(randomBytes(32)) }));
  assert.equal((await forged.next()).close, 4401);
  const duplicate = channel(pair.relayUrl);
  await duplicate.open;
  duplicate.ws.send(JSON.stringify({ type: 'join', protocol: 'cd-device-v1', role: 'receiver', token: encoded(derive('receiver join')) }));
  assert.equal((await duplicate.next()).close, 4409);
  sender.ws.send(JSON.stringify({type:'ping',protocol:'cd-device-v1'}));
  await event(sender,'pong');
  // A rejected replacement must leave the original peer able to forward bytes.
  const reply = randomBytes(256);
  receiver.ws.send(reply);
  const received = await sender.next();
  assert.deepEqual(Buffer.from(received.message), reply);
  const response = await fetch(pair.relayUrl.replace(/^ws/, 'http'));
  assert.equal(response.status, 426);
  if (process.env.CD_VERIFY_DEVICE_LEASE === '1') {
    keepalive = setInterval(() => sender.ws.send(JSON.stringify({type:'ping',protocol:'cd-device-v1'})), 20_000);
    const expired = await withTimeout(receiver.next(90_000), 90_000, 'stale receiver lease was not reclaimed');
    assert.equal(expired.close,4408);
    const replacement = channel(pair.relayUrl);
    await replacement.open;
    replacement.ws.send(JSON.stringify({type:'join',protocol:'cd-device-v1',role:'receiver',token:encoded(derive('receiver join'))}));
    await event(replacement,'accepted');
    await event(replacement,'peer-joined');
    console.log('Verified stale receiver lease expires and a legitimate replacement reconnects while sender keepalives preserve its slot.');
  }
  console.log('Verified real CLI pairing through the Worker, credential privacy, reconnect, binary forwarding, forged-credential rejection, and active-peer preservation.');
} finally {
  clearInterval(keepalive);
  for (const socket of sockets) socket.close();
  await stopChild(pairing);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
