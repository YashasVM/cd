export const CHUNK_SIZE = 256 * 1024;
export const LARGE_CHUNK_SIZE = 768 * 1024;

// Keep the advertised base size readable by older peers. Larger encrypted
// records are sent only after the receiver explicitly accepts them.
export function selectReceiveChunkSize({ chunkSize, maxChunkSize = 0 }) {
  if (chunkSize !== 64 * 1024 && chunkSize !== CHUNK_SIZE) throw new Error('The sender uses unsupported transfer limits.');
  if (maxChunkSize !== 0 && maxChunkSize !== LARGE_CHUNK_SIZE) throw new Error('The sender uses unsupported negotiated transfer limits.');
  return maxChunkSize === LARGE_CHUNK_SIZE ? LARGE_CHUNK_SIZE : chunkSize;
}

export function acceptedSendChunkSize(payload) {
  if (payload.byteLength === 0) return CHUNK_SIZE;
  if (payload.byteLength > 4096) throw new Error('The receiver sent an invalid transfer selection.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
  catch { throw new Error('The receiver sent an invalid transfer selection.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'chunkSize') || (value.chunkSize !== CHUNK_SIZE && value.chunkSize !== LARGE_CHUNK_SIZE)) {
    throw new Error('The receiver sent an invalid transfer selection.');
  }
  return value.chunkSize;
}
