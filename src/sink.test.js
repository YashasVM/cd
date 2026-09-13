import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WEBKIT_BLOB_LIMIT, detectCapabilities, isWebKitBrowser, selectSinkTier } from './sink.js';

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

  it('refuses over-limit blobs on WebKit only, with an exact 256 MiB boundary', () => {
    const caps = { filePicker: false, opfs: false };
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT, SAFARI_IOS), 'blob');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, SAFARI_IOS), 'too-large');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, SAFARI_MAC), 'too-large');
    assert.equal(selectSinkTier(caps, WEBKIT_BLOB_LIMIT + 1n, CHROME_IOS), 'too-large');
  });

  it('leaves blobs uncapped off WebKit', () => {
    const caps = { filePicker: false, opfs: false };
    const huge = 10n * 1024n * 1024n * 1024n;
    assert.equal(selectSinkTier(caps, huge, CHROME_ANDROID), 'blob');
    assert.equal(selectSinkTier(caps, huge, CHROME_DESKTOP), 'blob');
    assert.equal(selectSinkTier(caps, huge, FIREFOX_DESKTOP), 'blob');
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
