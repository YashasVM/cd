import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { encodeBase64Url } from './agent-protocol.js';
import { BLOB_FALLBACK_LIMIT } from './sink.js';
import {
  RESUME_CHUNK_SIZE, bytesToHex, createReceiverStage, decodeResumeAck, decodeResumeCounts,
  encodeResumeAck, encodeResumeCounts, hashFile, parseResumeLink, resumeSafeFilename, assertResumeSourceIdentity
} from './resume-browser.js';

function makeKV() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async keys() { return [...values.keys()]; },
    values
  };
}

function opfs() {
  const files = new Map();
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new Error('Not found');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() {
          const snapshot = files.get(name).slice();
          return new Blob([snapshot]);
        },
        async createWritable({ keepExistingData = false } = {}) {
          let data = keepExistingData ? files.get(name).slice() : new Uint8Array();
          let cursor = 0;
          return {
            async seek(position) { cursor = position; },
            async truncate(size) { const next = new Uint8Array(size); next.set(data.subarray(0, size)); data = next; },
            async write(input) {
              const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
              if (cursor + bytes.length > data.length) {
                const expanded = new Uint8Array(cursor + bytes.length);
                expanded.set(data);
                data = expanded;
              }
              data.set(bytes, cursor);
              cursor += bytes.length;
            },
            async close() { files.set(name, data); },
            async abort() {}
          };
        }
      };
    },
    async removeEntry(name) { files.delete(name); }
  };
  return { files, storage: { async getDirectory() { return directory; } } };
}

describe('resume browser primitives', () => {
  it('parses only private v2 links and validates safe filenames', () => {
    const id = 'AAAAAAAAAAAAAAAAAAAAAA';
    const key = 'A'.repeat(43);
    const parsed = parseResumeLink(`https://cd.example/s/${id}#v2.${key}`);
    assert.equal(parsed.rootId, id);
    assert.equal(parsed.id.length, 16);
    assert.equal(parsed.key.length, 32);
    assert.throws(() => parseResumeLink(`https://cd.example/s/${id}#v1.${key}`));
    assert.equal(resumeSafeFilename('report.txt'), true);
    assert.equal(resumeSafeFilename('../report.txt'), false);
    assert.equal(resumeSafeFilename(''), false);
  });

  it('hashes files incrementally in bounded chunks', async () => {
    const bytes = new Uint8Array(RESUME_CHUNK_SIZE * 2 + 17).map((_, i) => i % 251);
    const file = new Blob([bytes]);
    const hash = await hashFile(file, { onBytes: () => {} });
    const reference = new IncrementalSHA256().update(bytes).digestHex();
    assert.equal(hash.digestHex(), reference);
    assert.equal(bytesToHex(hash.digest()).length, 64);
  });

  it('binds a resumed sender to the original name, size, and whole digest', () => {
    const file = { name: 'same.bin', size: 3 };
    const saved = { role: 'sender', filename: 'same.bin', size: 3, wholeSha256: 'a'.repeat(64) };
    assert.equal(assertResumeSourceIdentity(saved, file, 'a'.repeat(64)), true);
    assert.throws(() => assertResumeSourceIdentity(saved, { ...file, name: 'other.bin' }, 'a'.repeat(64)), /does not match/);
    assert.throws(() => assertResumeSourceIdentity(saved, { ...file, size: 4 }, 'a'.repeat(64)), /does not match/);
    assert.throws(() => assertResumeSourceIdentity(saved, file, 'b'.repeat(64)), /does not match/);
  });

  it('writes and reopens only durable OPFS bytes, truncates uncheckpointed tail, and detects corruption', async () => {
    const { storage, files } = opfs();
    const checkpoints = makeKV();
    const secrets = makeKV();
    const id = Uint8Array.from({ length: 16 }, (_, i) => i);
    const key = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const invitation = { id, key };
    const rootId = encodeBase64Url(id);
    const prefix = new Uint8Array(RESUME_CHUNK_SIZE).fill(7);
    const tail = Uint8Array.of(1, 2, 3, 4, 5);
    const full = new Uint8Array(prefix.length + tail.length);
    full.set(prefix);
    full.set(tail, prefix.length);
    const wholeSha256 = new IncrementalSHA256().update(full).digestHex();
    const offer = { name: 'archive.bin', size: String(full.length), chunkSize: RESUME_CHUNK_SIZE, wholeSha256, expiresAt: Date.now() + 60_000 };
    const first = await createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets });
    await first.append(prefix, 'A'.repeat(43));
    // Simulate bytes written after a crash but before the checkpoint update.
    const handle = await (await storage.getDirectory()).getFileHandle(first.stagingId);
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(first.currentOffset);
    await writable.write(Uint8Array.of(99, 98));
    await writable.close();

    const resumed = await createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets });
    assert.equal(resumed.offset, prefix.length);
    assert.equal((await handle.getFile()).size, prefix.length);
    await resumed.append(tail, 'B'.repeat(43));
    const result = await resumed.finish();
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), full);
    assert.equal(files.size, 1);
    assert.ok(checkpoints.values.has(`receiver:${rootId}`));

    const checkpoint = checkpoints.values.get(`receiver:${rootId}`);
    checkpoint.offset = String(0);
    checkpoints.values.set(`receiver:${rootId}`, checkpoint);
    await assert.rejects(createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets }), /integrity or file identity/);
  });

  it('batches only advertised windows and retains only flushed, checkpointed prefixes', async () => {
    for (const windowBytes of [undefined, 0, RESUME_CHUNK_SIZE, 4 * RESUME_CHUNK_SIZE, 16 * RESUME_CHUNK_SIZE, Number.MAX_SAFE_INTEGER]) {
      const { storage, files } = opfs(), checkpoints = makeKV(), secrets = makeKV();
      const id = new Uint8Array(16), key = new Uint8Array(32).fill(3), rootId = encodeBase64Url(id);
      const expectedBatch = windowBytes >= 16 * RESUME_CHUNK_SIZE ? 8 * RESUME_CHUNK_SIZE : windowBytes >= 4 * RESUME_CHUNK_SIZE ? 4 * RESUME_CHUNK_SIZE : RESUME_CHUNK_SIZE;
      const bytes = new Uint8Array(expectedBatch + 7).fill(17);
      const offer = { name: 'batch.bin', size: String(bytes.length), chunkSize: RESUME_CHUNK_SIZE, windowBytes, wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
      const stage = await createReceiverStage({ invitation: { id, key }, rootId, offer, storage, checkpoints, secrets });
      assert.equal(stage.ackEveryBytes, expectedBatch);
      await stage.bindSession('A'.repeat(43));
      for (let offset = 0; offset < expectedBatch; offset += RESUME_CHUNK_SIZE) {
        const committed = await stage.append(bytes.subarray(offset, offset + RESUME_CHUNK_SIZE), 'A'.repeat(43));
        const expected = offset + RESUME_CHUNK_SIZE === expectedBatch ? expectedBatch : 0;
        assert.equal(committed, expected > 0);
        assert.equal(stage.currentOffset, expected);
        assert.equal(checkpoints.values.get(`receiver:${rootId}`).offset, expected);
        assert.equal(files.get(stage.stagingId).length, expected);
      }
      assert.equal(await stage.append(bytes.subarray(expectedBatch), 'A'.repeat(43)), true);
      assert.equal(stage.currentOffset, bytes.length);
      assert.deepEqual(new Uint8Array(await (await stage.finish()).arrayBuffer()), bytes);
      await stage.cancel();
    }
  });

  it('discards a buffered receive tail on interruption and resumes from its committed prefix', async () => {
    for (const legacyPrefix of [false, true]) {
      const { storage, files } = opfs(), checkpoints = makeKV(), secrets = makeKV();
      const id = new Uint8Array(16), key = new Uint8Array(32).fill(4), rootId = encodeBase64Url(id);
      const bytes = new Uint8Array(RESUME_CHUNK_SIZE * 9 + 7).fill(19);
      const offer = { name: 'resume-batch.bin', size: String(bytes.length), chunkSize: RESUME_CHUNK_SIZE, windowBytes: legacyPrefix ? 0 : 4 * RESUME_CHUNK_SIZE, wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
      const options = { invitation: { id, key }, rootId, offer, storage, checkpoints, secrets };
      const stage = await createReceiverStage(options);
      await stage.bindSession('A'.repeat(43));
      for (let i = 0; i < 5; i++) await stage.append(bytes.subarray(i * RESUME_CHUNK_SIZE, (i + 1) * RESUME_CHUNK_SIZE), 'A'.repeat(43));
      await stage.release();
      const committed = (legacyPrefix ? 5 : 4) * RESUME_CHUNK_SIZE;
      assert.equal(checkpoints.values.get(`receiver:${rootId}`).offset, committed);
      assert.equal(files.get(stage.stagingId).length, committed);
      if (legacyPrefix) offer.windowBytes = 16 * RESUME_CHUNK_SIZE;
      const resumed = await createReceiverStage(options);
      assert.equal(resumed.offset, committed);
      for (let offset = resumed.offset; offset < bytes.length; offset += RESUME_CHUNK_SIZE) await resumed.append(bytes.subarray(offset, offset + RESUME_CHUNK_SIZE), 'B'.repeat(43));
      assert.deepEqual(new Uint8Array(await (await resumed.finish()).arrayBuffer()), bytes);
      await resumed.cancel();
    }
  });

  it('never advances progress after a batch checkpoint fails and truncates its disk tail on reopen', async () => {
    const { storage, files } = opfs(), checkpoints = makeKV(), secrets = makeKV();
    const id = new Uint8Array(16), key = new Uint8Array(32).fill(5), rootId = encodeBase64Url(id);
    const bytes = new Uint8Array(4 * RESUME_CHUNK_SIZE + 7).fill(23);
    const offer = { name: 'failed-batch.bin', size: String(bytes.length), chunkSize: RESUME_CHUNK_SIZE, windowBytes: 4 * RESUME_CHUNK_SIZE, wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
    const options = { invitation: { id, key }, rootId, offer, storage, checkpoints, secrets };
    const stage = await createReceiverStage(options);
    await stage.bindSession('A'.repeat(43));
    const put = checkpoints.put;
    checkpoints.put = async () => { throw new Error('checkpoint unavailable'); };
    for (let i = 0; i < 3; i++) assert.equal(await stage.append(bytes.subarray(i * RESUME_CHUNK_SIZE, (i + 1) * RESUME_CHUNK_SIZE), 'A'.repeat(43)), false);
    await assert.rejects(stage.append(bytes.subarray(3 * RESUME_CHUNK_SIZE, 4 * RESUME_CHUNK_SIZE), 'A'.repeat(43)), /checkpoint unavailable/);
    assert.equal(stage.currentOffset, 0);
    assert.equal(checkpoints.values.get(`receiver:${rootId}`).offset, 0);
    assert.equal(files.get(stage.stagingId).length, 4 * RESUME_CHUNK_SIZE);
    await assert.rejects(stage.append(bytes.subarray(4 * RESUME_CHUNK_SIZE), 'A'.repeat(43)), /checkpoint unavailable/);
    await stage.release();
    checkpoints.put = put;
    const reopened = await createReceiverStage(options);
    assert.equal(reopened.offset, 0);
    assert.equal(files.get(stage.stagingId).length, 0);
    await reopened.cancel();
  });

  it('rejects invalid advertised receive windows before allocating storage', async () => {
    for (const windowBytes of [-1, 1, 1.5, '4194304', Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      const storage = { getDirectory() { assert.fail('invalid window must fail before storage allocation'); } };
      await assert.rejects(createReceiverStage({ invitation: { id: new Uint8Array(16), key: new Uint8Array(32) }, rootId: 'A'.repeat(22), offer: { name: 'bad.bin', size: '0', chunkSize: RESUME_CHUNK_SIZE, windowBytes, wholeSha256: new IncrementalSHA256().digestHex() }, storage, checkpoints: makeKV() }), /send window/);
    }
  });

  it('round-trips v2 progress records and confirms the fallback cap', () => {
    const ack = encodeResumeAck(12, 2n ** 40n);
    assert.deepEqual(decodeResumeAck(ack), { chunks: 12, bytes: 2n ** 40n });
    const end = encodeResumeCounts(12, 2n ** 40n, 'ab'.repeat(32));
    assert.deepEqual(decodeResumeCounts(end), { chunks: 12, bytes: 2n ** 40n, wholeSha256: 'ab'.repeat(32) });
    assert.equal(BLOB_FALLBACK_LIMIT, 256n * 1024n * 1024n);
  });
});
