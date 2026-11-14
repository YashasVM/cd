import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createV2Socket } from './resume-browser.js';

class Socket extends EventTarget {
  readyState = 0;
  constructor() {
    super();
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send() {}
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  close(code) {
    this.closedWith = code;
    this.readyState = 3;
    const event = new Event('close');
    event.code = code;
    this.dispatchEvent(event);
  }
}

async function connection() {
  return createV2Socket({ id: new Uint8Array(16), key: new Uint8Array(32) }, 'receiver', null, {
    WebSocketCtor: Socket, location: { protocol: 'https:', host: 'cd.example' }
  });
}

it('accepts the CLI four MiB encrypted resume window while storage is busy', async () => {
  const { socket, inbox } = await connection();
  const frames = Array.from({ length: 16 }, (_, index) => {
    const frame = new Uint8Array(256 * 1024 + 28);
    frame[0] = index;
    return frame;
  });
  socket.receive(JSON.stringify({ type: 'peer-joined' }));
  for (const frame of frames) socket.receive(frame.buffer);
  assert.equal(socket.closedWith, undefined);
  assert.equal(typeof (await inbox.next()).data, 'string');
  for (const frame of frames) assert.deepEqual(new Uint8Array((await inbox.next()).data), frame);
});

it('still rejects resume peers exceeding the byte or record queue cap', async () => {
  for (const mode of ['bytes', 'records']) {
    const { socket, inbox } = await connection();
    const frame = new Uint8Array(mode === 'bytes' ? 256 * 1024 + 28 : 1);
    for (let index = 0; index < (mode === 'bytes' ? 17 : 33); index++) socket.receive(frame.buffer);
    assert.equal(socket.closedWith, 4429);
    socket.close(1006);
    await assert.rejects(inbox.next(), /bounded resume receive queue/);
  }
});

it('rejects queued records after fatal authentication and policy close codes', async () => {
  for (const code of [4401, 4403, 4406, 4408, 4410, 4429]) {
    const { socket, inbox } = await connection();
    socket.receive(JSON.stringify({ type: 'completed', protocol: 'cd-transfer-v2' }));
    socket.close(code);
    await assert.rejects(inbox.next(), /rejected|expired/i);
  }
});

it('drains events received before an ordinary transport close', async () => {
  const { socket, inbox } = await connection();
  const completed = JSON.stringify({ type: 'completed', protocol: 'cd-transfer-v2' });
  socket.receive(completed);
  socket.close(1006);
  assert.equal((await inbox.next()).data, completed);
  await assert.rejects(inbox.next(), /interrupted/);
});
