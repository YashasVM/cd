import { IncrementalSHA256 } from './incremental-sha256.js';
import { RESUME_CHUNK_SIZE, decodeResumeCounts } from './transport.js';

/** Shared receive loop; CD passes its durable OPFS stage and authenticated retained hash. */
export async function receiveContent({ offer, offset = 0, hash = new IncrementalSHA256(), next, write, acknowledge, check, progress, verifying, publish }) {
  let bytes = offset;
  let chunks = Math.ceil(offset / RESUME_CHUNK_SIZE);
  while (true) {
    check();
    const record = await next();
    check();
    if (record.kind === 2) {
      const data = record.plaintext;
      if (!data.byteLength || data.byteLength > RESUME_CHUNK_SIZE || bytes + data.byteLength > offer.size || (data.byteLength !== RESUME_CHUNK_SIZE && bytes + data.byteLength !== offer.size)) throw new Error('Invalid chunk bounds.');
      await write(data); check(); hash.update(data); bytes += data.byteLength; chunks++;
      await acknowledge(chunks, bytes); progress(bytes);
      continue;
    }
    verifying();
    const end = decodeResumeCounts(record.plaintext);
    if (record.kind !== 3 || end.chunks !== chunks || end.bytes !== BigInt(offer.size) || bytes !== offer.size || end.wholeSha256 !== offer.sha256 || hash.digestHex() !== offer.sha256) throw new Error('Final digest or size failed verification.');
    check(); await publish(); check();
    return { size: bytes, sha256: offer.sha256 };
  }
}
