import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSink, createStageSink, createOPFSSink, createBlobSink, downloadUrlFor, DOWNLOAD_TOO_LARGE, WEBKIT_BLOB_LIMIT, detectCapabilities, isWebKitBrowser, selectSinkTier } from './sink.js';

const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.0.0 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const FIREFOX_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0';

describe('webkit detection', () => {
  it('flags Safari macOS, Safari iOS, and Chrome iOS as WebKit', () => {
    assert.equal(isWebKitBrowser(SAFARI_MAC), true);
    assert.equal(isWebKitBrowser(SAFARI_IOS), true);
    assert.equal(isWebKitBrowser(CHROME_IOS), true);
  });

  it('does not flag desktop/Android Chromium or Firefox', () => {
    assert.equal(isWebKitBrowser(CHROME_ANDROID), false);
    assert.equal(isWebKitBrowser(CHROME_DESKTOP), false);
    assert.equal(isWebKitBrowser(FIREFOX_DESKTOP), false);
    assert.equal(isWebKitBrowser(''), false);
  });
});

describe('tier selection', () => {
  it('prefers the file picker whenever it exists, at any size', () => {
    const huge = 10n * 1024n * 1024n * 1024n;
    for (const ua of [SAFARI_MAC, CHROME_ANDROID, FIREFOX_DESKTOP, '']) {
      assert.equal(selectSinkTier({ filePicker: true, opfs: true }, huge, ua), 'file-picker');
      assert.equal(selectSinkTier({ filePicker: true, opfs: false }, huge, ua), 'file-picker');
    }
  });

  it('uses OPFS staging without a picker, at any size, on every engine', () => {
    const huge = 10n * 1024n * 1024n * 1024n;
    for (const ua of [SAFARI_IOS, CHROME_ANDROID, CHROME_DESKTOP, FIREFOX_DESKTOP]) {
      assert.equal(selectSinkTier({ filePicker: false, opfs: true }, huge, ua), 'opfs');
    }
  });

  it('caps every Blob fallback at 256 MiB while preserving the exact boundary', () => {
    const caps = { filePicker: false, opfs: false };
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT, SAFARI_IOS), 'blob');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, SAFARI_IOS), 'too-large');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, SAFARI_MAC), 'too-large');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, CHROME_IOS), 'too-large');
    const huge = 10n * 1024n * 1024n * 1024n;
    for (const ua of [CHROME_ANDROID, CHROME_DESKTOP, FIREFOX_DESKTOP]) {
      assert.equal(selectSinkTier(caps, huge, ua), 'too-large');
    }
  });

  it('accepts plain numbers as well as bigints for sizes', () => {
    const caps = { filePicker: false, opfs: false };
    assert.equal(selectSinkTier(caps, 1024, SAFARI_IOS), 'blob');
    assert.equal(selectSinkTier(caps, 1024, CHROME_DESKTOP), 'blob');
  });
});

describe('capability detection', () => {
  it('detects nothing in bare Node (no window/navigator)', () => {
    assert.deepEqual(detectCapabilities({}), { filePicker: false, opfs: false });
  });

  it('reads picker and OPFS support from the host', () => {
    const host = {
      window: { showSaveFilePicker() {} },
      navigator: { storage: { getDirectory() {} } }
    };
    assert.deepEqual(detectCapabilities(host), { filePicker: true, opfs: true });
  });
});

describe('download sink lifecycle', () => {
  async function withBrowser(t, storage, run) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: SAFARI_IOS, storage } });
    try { return await run(); } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    }
  }

  it('refuses oversized Safari blobs when advertised OPFS fails', async (t) => {
    await withBrowser(t, { async getDirectory() { throw new Error('storage unavailable'); } }, async () => {
      const offer = { name: 'large.bin', size: WEBKIT_BLOB_LIMIT + 1n, mediaType: 'application/octet-stream' };
      await assert.rejects(createSink(offer), { message: DOWNLOAD_TOO_LARGE });
      await assert.rejects(createStageSink(offer), { message: DOWNLOAD_TOO_LARGE });
    });
  });

  it('caps declared no-OPFS fallback offers and enforces the actual cumulative write limit', async (t) => {
    await withBrowser(t, {}, async () => {
      await assert.rejects(createSink({ name: 'large.bin', size: WEBKIT_BLOB_LIMIT + 1n }), { message: DOWNLOAD_TOO_LARGE });
      const sink = await createStageSink({ name: 'unknown.bin', maxBytes: 4 });
      await sink.write(Uint8Array.of(1, 2, 3));
      await assert.rejects(sink.write(Uint8Array.of(4, 5)), { message: DOWNLOAD_TOO_LARGE });
      const staged = await sink.toFile();
      assert.deepEqual([...new Uint8Array(await staged.file.arrayBuffer())], [1, 2, 3]);
      const direct = createBlobSink({ name: 'unknown.bin', maxBytes: 4 });
      await direct.write(Uint8Array.of(1, 2, 3));
      await assert.rejects(direct.write(Uint8Array.of(4, 5)), { message: DOWNLOAD_TOO_LARGE });
      await direct.abort();
    });
  });

  it('removes the staging entry when opening its writable fails', async (t) => {
    const removed = [];
    let created;
    await withBrowser(t, { async getDirectory() { return {
      async getFileHandle(name) { created = name; return { async createWritable() { throw new Error('quota'); } }; },
      async removeEntry(name) { removed.push(name); }
    }; } }, async () => {
      await assert.rejects(createOPFSSink({ name: 'a'.repeat(255) }), { message: 'quota' });
      assert.ok(created.length < 255);
      assert.deepEqual(removed, [created]);
    });
  });

  it('coalesces small OPFS writes into large flushes without losing bytes', async (t) => {
    const writes = [];
    let closed = 0;
    await withBrowser(t, { async getDirectory() { return {
      async getFileHandle() { return {
        async createWritable() { return {
          async write(bytes) { writes.push(Uint8Array.from(bytes)); },
          async close() { closed++; },
          async abort() {}
        }; },
        async getFile() { return new Blob([]); }
      }; },
      async removeEntry() {}
    }; } }, async () => {
      const sink = await createOPFSSink({ name: 'big.bin' });
      const chunkSize = 64 * 1024;
      for (let index = 0; index < 10; index++) {
        const chunk = new Uint8Array(chunkSize).fill(index);
        // Exercise every accepted input shape across the chunks.
        if (index % 3 === 0) await sink.write(chunk);
        else if (index % 3 === 1) await sink.write(chunk.buffer.slice(0));
        else await sink.write(new DataView(chunk.buffer.slice(0)));
      }
      // 10 x 64 KiB: the 8th chunk completes 512 KiB and flushes once.
      assert.equal(writes.length, 1);
      assert.equal(writes[0].byteLength, 512 * 1024);
      await sink.file();
      assert.equal(writes.length, 2);
      assert.equal(writes[1].byteLength, 2 * chunkSize);
      assert.equal(closed, 1);
      const total = writes[0].byteLength + writes[1].byteLength;
      assert.equal(total, 10 * chunkSize);
      const flat = new Uint8Array(total);
      flat.set(writes[0]);
      flat.set(writes[1], writes[0].byteLength);
      for (let index = 0; index < 10; index++) {
        assert.ok(flat.slice(index * chunkSize, (index + 1) * chunkSize).every((byte) => byte === index));
      }
    });
  });

  it('preserves bytes in the fallback and revokes cleanup only once', async (t) => {
    await withBrowser(t, {}, async () => {
      const sink = await createSink({ name: 'hello.txt', size: 5, mediaType: 'text/plain' });
      await sink.write(new TextEncoder().encode('hello'));
      const result = await sink.close();
      assert.equal(await (await fetch(result.url)).text(), 'hello');
      result.revoke();
      let cleaned = 0;
      const download = downloadUrlFor(new Blob(['x']), 'x', async () => { cleaned++; throw new Error('already removed'); });
      download.revoke();
      download.revoke();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cleaned, 1);
    });
  });
});
