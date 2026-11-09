import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdTransferClient, TransferError } from '../src/index.js';

test('validates public app ID, source metadata, lifetime and invitation before network IO', () => {
  for (const appId of ['', 'a b', 'x'.repeat(129)]) assert.throws(() => new CdTransferClient({ appId }));
  for (const relayOrigin of ['http://example.com', 'http://10.evil.com', 'http://127.evil.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/#key']) assert.throws(() => new CdTransferClient({ appId: 'host', relayOrigin }));
  const client = new CdTransferClient({ appId: 'host' });
  for (const name of ['..', '../escape', 'a\\b', 'bad\nname', 'é'.repeat(128)]) assert.throws(() => client.outgoing(new File(['hello'], name)));
  for (const lifetimeMs of [0, 999, 86_400_001, NaN]) assert.throws(() => client.outgoing(new File(['hello'], 'file'), { lifetimeMs }));
  assert.throws(() => client.incoming('https://example.com/s/AAECAwQFBgcICQoLDA0ODw#v1.ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8'));
});

test('cancel before run never connects or reports success', async () => {
  const op = new CdTransferClient({ appId: 'host' }).outgoing(new File(['hello'], 'file'));
  op.cancel();
  await assert.rejects(op.run(() => assert.fail('Must not advertise a cancelled invitation')), error => error instanceof TransferError && error.state === 'cancelled');
});
