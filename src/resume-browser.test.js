import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanExpiredResumeRecords } from './resume-retention.js';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { encodeBase64Url } from './agent-protocol.js';
import {
  RESUME_CHUNK_SIZE, bytesToHex, createReceiverStage, decodeResumeAck, decodeResumeCounts,
  encodeResumeAck, encodeResumeCounts, hashFile, parseResumeLink, resumeSafeFilename
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
    for (const name of ['x\ny', 'x\u007fy', 'é'.repeat(128), 'a'.repeat(256)]) assert.equal(resumeSafeFilename(name), false);
    assert.throws(() => parseResumeLink(`javascript:/s/${id}#v2.${key}`));
    assert.throws(() => parseResumeLink(`https://user:pass@cd.example/s/${id}#v2.${key}`));
  });

  it('hashes files incrementally in bounded chunks', async () => {
    const bytes = new Uint8Array(RESUME_CHUNK_SIZE * 2 + 17).map((_, i) => i % 251);
    const file = new Blob([bytes]);
    const hash = await hashFile(file, { onBytes: () => {} });
    const reference = new IncrementalSHA256().update(bytes).digestHex();
    assert.equal(hash.digestHex(), reference);
    assert.equal(bytesToHex(hash.digest()).length, 64);
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

  it('keeps cancellation failures discoverable and retries removal on cleanup', async () => {
    const { storage, files } = opfs();
    const checkpoints = makeKV();
    const secrets = makeKV();
    const invitation = { id: new Uint8Array(16), key: new Uint8Array(32) };
    const rootId = encodeBase64Url(invitation.id);
    const bytes = Uint8Array.of(1, 2, 3);
    const offer = { name: 'private.bin', size: '3', chunkSize: RESUME_CHUNK_SIZE,
      wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
    const stage = await createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets });
    await stage.append(bytes, 'A'.repeat(43));
    const directory = await storage.getDirectory();
    const remove = directory.removeEntry;
    directory.removeEntry = async () => { throw new DOMException('Locked', 'NoModificationAllowedError'); };
    await assert.rejects(stage.cancel(), { name: 'NoModificationAllowedError' });
    assert.ok(checkpoints.values.has(`receiver:${rootId}`));
    assert.equal(files.size, 1);
    directory.removeEntry = remove;
    await cleanExpiredResumeRecords({ checkpoints, secrets, storage });
    assert.equal(files.size, 0, 'cancelled stages must not wait for the original expiry');
    assert.equal(checkpoints.values.has(`receiver:${rootId}`), false);
  });

  it('round-trips v2 progress records', () => {
    const ack = encodeResumeAck(12, 2n ** 40n);
    assert.deepEqual(decodeResumeAck(ack), { chunks: 12, bytes: 2n ** 40n });
    const end = encodeResumeCounts(12, 2n ** 40n, 'ab'.repeat(32));
    assert.deepEqual(decodeResumeCounts(end), { chunks: 12, bytes: 2n ** 40n, wholeSha256: 'ab'.repeat(32) });
  });
});
