// Shared download sinks for the agent receiver (share.js) and the
// browser P2P receiver (main.js).
//
// Tier order, best first:
//   1. file-picker: File System Access streaming write, no size cap.
//      Desktop Chromium and modern Chrome Android.
//   2. opfs: stage chunks into the Origin Private File System as they
//      arrive (bounded RAM), then hand the staged file to the browser
//      download as a disk-backed object URL. Baseline since 2023 on
//      Chromium, Firefox, and Safari 15.2+/iOS.
//   3. blob: accumulate in memory, one Blob at the end. Chromium spills
//      large blobs to disk, so only WebKit keeps a cap: blob downloads
//      above ~256 MiB crash real iOS devices in the field.
//
// Callers must not overlap write() calls; both receivers already
// serialize chunk handling through a promise queue.

export const WEBKIT_BLOB_LIMIT = 256n * 1024n * 1024n;

export const DOWNLOAD_TOO_LARGE =
  'This file is over 256 MB and this browser cannot save downloads that large. ' +
  'Open the link in a desktop Chromium browser for this file.';

// True for Safari on macOS/iOS and every iOS browser (all WebKit under
// the hood, including Chrome/Firefox on iOS). False for desktop and
// Android Chromium, which carry an AppleWebKit token but a real
// Chrome/Chromium token too. Firefox is intentionally not
// distinguished: out of scope, treated like Chromium.
export function isWebKitBrowser(userAgent = '') {
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium)\//.test(userAgent);
}

export function detectCapabilities(host = globalThis) {
  const filePicker =
    typeof host.window !== 'undefined' && typeof host.window.showSaveFilePicker === 'function';
  const opfs =
    typeof host.navigator !== 'undefined' &&
    typeof host.navigator.storage?.getDirectory === 'function';
  return { filePicker, opfs };
}

// Pure tier selection so the policy is unit-testable in Node.
export function selectSinkTier(capabilities, size, userAgent = '') {
  if (capabilities.filePicker) return 'file-picker';
  if (capabilities.opfs) return 'opfs';
  if (isWebKitBrowser(userAgent) && BigInt(size) > WEBKIT_BLOB_LIMIT) return 'too-large';
  return 'blob';
}

function stagingName() {
  return `cd-rx-${crypto.randomUUID()}`;
}

export function downloadUrlFor(file, offerName, onRevoke) {
  const url = URL.createObjectURL(file);
  let revoked = false;
  return {
    url,
    name: offerName,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
      try { void Promise.resolve(onRevoke?.()).catch(() => {}); } catch { /* Best effort. */ }
    }
  };
}

export async function createPickerSink({ name }) {
  const handle = await window.showSaveFilePicker({ suggestedName: name });
  const writable = await handle.createWritable();
  return {
    kind: 'saved',
    async write(bytes) { await writable.write(bytes); },
    async close() { await writable.close(); return {}; },
    async abort() { try { await writable.abort(); } catch { /* Best effort. */ } }
  };
}

export async function createOPFSSink({ name }) {
  const root = await navigator.storage.getDirectory();
  const internal = stagingName();
  const fileHandle = await root.getFileHandle(internal, { create: true });
  let writable;
  try {
    writable = await fileHandle.createWritable();
  } catch (error) {
    try { await root.removeEntry(internal); } catch { /* Best effort. */ }
    throw error;
  }
  const discard = async () => {
    try { await writable.abort(); } catch { /* Best effort. */ }
    try { await root.removeEntry(internal); } catch { /* Best effort. */ }
  };
  return {
    kind: 'download',
    internalName: internal,
    async write(bytes) { await writable.write(bytes); },
    async file() {
      await writable.close();
      return fileHandle.getFile();
    },
    async cleanup() {
      try { await root.removeEntry(internal); } catch { /* Best effort. */ }
    },
    async close() {
      const file = await this.file();
      // The object URL reads lazily from the staged entry: it must stay
      // until the download is done, so removal happens in revoke(), which
      // callers run after the click settles or the page hides.
      return downloadUrlFor(file, name, () => root.removeEntry(internal));
    },
    async abort() { await discard(); }
  };
}

// Staging buffer for receivers that must keep bytes while waiting on
// something else (the P2P flow fires the save dialog without blocking
// the transfer). Prefers OPFS so staging stays off the JS heap;
// falls back to a RAM array. Single-use: call exactly one of toFile()
// (pipe the staged bytes somewhere else) or toDownload() (offer them
// as a download); discard() drops them.
export async function createStageSink({ name, size = 0 }) {
  try {
    if (detectCapabilities().opfs) {
      const staged = await createOPFSSink({ name });
      return {
        async write(bytes) { await staged.write(bytes); },
        async toFile() {
          const file = await staged.file();
          return { file, cleanup: () => staged.cleanup() };
        },
        async toDownload() { return staged.close(); },
        async discard() { await staged.abort(); }
      };
    }
  } catch {
    // OPFS can fail after detection (private mode, full disk).
  }
  assertBlobSize(size);
  const chunks = [];
  return {
    async write(bytes) { chunks.push(bytes); },
    async toFile(mediaType) {
      const file = new Blob(chunks, { type: mediaType });
      chunks.length = 0;
      return { file, cleanup: async () => {} };
    },
    async toDownload(mediaType) {
      const { file } = await this.toFile(mediaType);
      return downloadUrlFor(file, name);
    },
    async discard() { chunks.length = 0; }
  };
}

export function createBlobSink({ mediaType, name }) {
  const chunks = [];
  return {
    kind: 'download',
    async write(bytes) { chunks.push(bytes); },
    async close() {
      const file = new Blob(chunks, { type: mediaType });
      chunks.length = 0;
      return downloadUrlFor(file, name);
    },
    async abort() { chunks.length = 0; }
  };
}

function assertBlobSize(size) {
  if (selectSinkTier({ filePicker: false, opfs: false }, size, navigator.userAgent) === 'too-large') {
    throw new Error(DOWNLOAD_TOO_LARGE);
  }
}

// Single-file receiver entry point (share.js): routes to the best tier
// and throws a readable error when the browser cannot take the size.
export async function createSink({ name, size, mediaType }) {
  const capabilities = detectCapabilities();
  const tier = selectSinkTier(capabilities, size, navigator.userAgent);
  if (tier === 'file-picker') {
    try {
      return await createPickerSink({ name });
    } catch (error) {
      // The picker is known-flaky on some Android builds; fall through
      // to disk staging instead of failing. A user cancel stays a
      // cancel so the page can wait for another click.
      if (error?.name === 'AbortError') throw error;
    }
  }
  if (tier !== 'too-large') {
    if (capabilities.opfs) {
      try {
        return await createOPFSSink({ name });
      } catch {
        // Private mode and full disks disable OPFS; Blob is the last resort.
      }
    }
    assertBlobSize(size);
    return createBlobSink({ mediaType, name });
  }
  throw new Error(DOWNLOAD_TOO_LARGE);
}
