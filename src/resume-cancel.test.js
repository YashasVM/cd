import assert from 'node:assert/strict';
import { it } from 'node:test';
import { encodeBase64Url } from './agent-protocol.js';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { createReceiverStage, RESUME_CHUNK_SIZE } from './resume-browser.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeKV({ blockPut } = {}) {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async put(key, value) {
      if (blockPut) {
        blockPut.entered.resolve();
        await blockPut.release.promise;
      }
      values.set(key, structuredClone(value));
    },
    async delete(key) { values.delete(key); },
    values
  };
}

function makeStorage(blockClose) {
  const files = new Map();
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new Error('Not found');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return new Blob([files.get(name).slice()]); },
        async createWritable({ keepExistingData = false } = {}) {
          let data = keepExistingData ? files.get(name).slice() : new Uint8Array();
          let cursor = 0;
          return {
            async seek(position) { cursor = position; },
            async write(input) {
              const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
              const next = new Uint8Array(Math.max(data.length, cursor + bytes.length));
              next.set(data);
              next.set(bytes, cursor);
              data = next;
              cursor += bytes.length;
            },
            async close() {
              if (blockClose) {
                blockClose.entered.resolve();
                await blockClose.release.promise;
              }
              files.set(name, data);
            },
            async abort() {}
          };
        }
      };
    },
    async removeEntry(name) { files.delete(name); }
  };
  return { files, storage: { async getDirectory() { return directory; } } };
}

it('cancel waits for an in-flight append and removes any checkpoint it finishes writing', async () => {
  const closeGate = { entered: deferred(), release: deferred() };
  const putGate = { entered: deferred(), release: deferred() };
  const { storage, files } = makeStorage(closeGate);
  const checkpoints = makeKV({ blockPut: putGate });
  const id = Uint8Array.from({ length: 16 }, (_, index) => index);
  const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const invitation = { id, key };
  const rootId = encodeBase64Url(id);
  const chunk = Uint8Array.of(42);
  const offer = {
    name: 'cancel.bin', size: String(chunk.length), chunkSize: RESUME_CHUNK_SIZE,
    wholeSha256: new IncrementalSHA256().update(chunk).digestHex(), expiresAt: Date.now() + 60_000
  };
  const stage = await createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets: makeKV() });

  const append = stage.append(chunk, 'A'.repeat(43));
  await closeGate.entered.promise;
  const cancelling = stage.cancel();
  let cancelSettled = false;
  void cancelling.then(() => { cancelSettled = true; });
  await Promise.resolve();
  assert.equal(cancelSettled, false, 'cancel must wait for the in-flight file close');

  closeGate.release.resolve();
  await putGate.entered.promise;
  await Promise.resolve();
  assert.equal(cancelSettled, false, 'cancel must wait for the in-flight checkpoint write');

  putGate.release.resolve();
  await append;
  await cancelling;
  assert.equal(files.size, 0, 'cancel removes the staged file after append settles');
  assert.equal(checkpoints.values.has(`receiver:${rootId}`), false, 'cancel removes a checkpoint written by the in-flight append');
  await assert.rejects(stage.append(chunk, 'B'.repeat(43)), /stage is closed/);
  assert.equal(files.size, 0, 'a later append cannot recreate staged data');
  assert.equal(checkpoints.values.has(`receiver:${rootId}`), false, 'a later append cannot recreate the checkpoint');
});

it('cancel before an offer clears only the selected opaque receive stage', async () => {
  const { discardReceiverProgress } = await import('./resume-browser.js');
  const { storage, files } = makeStorage();
  const checkpoints = makeKV();
  const root = encodeBase64Url(new Uint8Array(16));
  const stagingId = 'cd-rx-12345678-1234-1234-1234-123456789abc';
  files.set(stagingId, Uint8Array.of(1));
  files.set('unrelated-file', Uint8Array.of(2));
  await checkpoints.put(`receiver:${root}`, { stagingId });
  await discardReceiverProgress(root, { storage, checkpoints });
  assert.equal(files.has(stagingId), false);
  assert.equal(files.has('unrelated-file'), true);
  assert.equal(checkpoints.values.has(`receiver:${root}`), false);
  await checkpoints.put(`receiver:${root}`, { stagingId: 'unrelated-file' });
  await discardReceiverProgress(root, { storage, checkpoints });
  assert.equal(files.has('unrelated-file'), true, 'untrusted names never select an unrelated OPFS file');
});
