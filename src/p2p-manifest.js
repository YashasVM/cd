export const MAX_P2P_FILES = 100;
// 5 GiB per file: streams to disk via file-picker → OPFS, never held in RAM.
// WebKit blob fallback stays capped at 256 MiB in sink.js with a clear error.
export const MAX_P2P_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_P2P_FILENAME_BYTES = 255;

const encoder = new TextEncoder();

export function parseManifest(value) {
  if (!value || typeof value !== 'object' || value.type !== 'manifest') throw new Error('invalid manifest');
  if (!Number.isSafeInteger(value.totalFiles) || value.totalFiles < 1 || value.totalFiles > MAX_P2P_FILES) {
    throw new Error('invalid file count');
  }
  if (!Array.isArray(value.files) || value.files.length !== value.totalFiles) throw new Error('invalid file list');

  let totalSize = 0;
  const files = value.files.map((file, index) => {
    if (!file || typeof file !== 'object' || file.index !== index) throw new Error('invalid file index');
    if (typeof file.name !== 'string' || file.name.length === 0 || encoder.encode(file.name).byteLength > MAX_P2P_FILENAME_BYTES) {
      throw new Error('invalid file name');
    }
    if (/[/\\\u0000-\u001f\u007f]/.test(file.name) || file.name === '.' || file.name === '..') throw new Error('unsafe file name');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_P2P_FILE_BYTES) throw new Error('invalid file size');
    const mimeType = file.mimeType || 'application/octet-stream';
    if (typeof mimeType !== 'string' || mimeType.length > 127 || !/^[\x20-\x7e]+$/.test(mimeType)) throw new Error('invalid MIME type');
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize)) throw new Error('invalid total size');
    return { index, name: file.name, size: file.size, mimeType };
  });
  if (value.totalSize !== totalSize) throw new Error('total size mismatch');
  return { totalFiles: files.length, totalSize, files };
}
