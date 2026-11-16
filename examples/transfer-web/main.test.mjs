import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('./main.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function host({ createWritable, getFile, removeEntry = async () => {} }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: true });
    return elements.get(id);
  };
  const controller = new AbortController();
  const events = {};
  const result = { urls: [], error: null };
  const directory = { getFileHandle: async () => ({ createWritable, getFile }), removeEntry };
  class CdTransferClient {
    incoming() {
      return {
        cancel: () => controller.abort(),
        async run(onOffer) {
          let sink;
          try {
            sink = await onOffer({ name: 'received.zip', size: 3, sha256: 'digest' }, controller.signal);
            await sink.commit({}, controller.signal);
            return { size: 3, sha256: 'digest' };
          } catch (error) {
            result.error = error;
            await sink?.abort();
            throw error;
          }
        },
      };
    }
  }
  runInNewContext(source, {
    CdTransferClient, document: { getElementById: element }, location: { origin: 'http://localhost' },
    navigator: { storage: { getDirectory: async () => directory } }, confirm: () => true,
    crypto: { randomUUID: () => 'test' }, addEventListener: (name, callback) => { events[name] = callback; },
    URL: { createObjectURL: value => { result.urls.push(value); return 'blob:verified'; }, revokeObjectURL() {} },
  });
  return { element, events, result };
}

test('failed writable construction removes its staging entry and preserves the failure', async () => {
  const failure = new Error('No space');
  const removed = [];
  const page = host({
    createWritable: async () => { throw failure; },
    removeEntry: async name => { removed.push(name); throw new Error('Cleanup also failed'); },
  });
  await page.element('receive').onclick();
  assert.deepEqual(removed, ['host-test.part']);
  assert.equal(page.result.error, failure);
  assert.equal(page.element('download').hidden, true);
  assert.equal(page.result.urls.length, 0);
});

for (const action of ['cancel', 'pagehide']) {
  test(`${action} during getFile never publishes a late download`, async () => {
    const reading = deferred(), file = deferred();
    const removed = [];
    const page = host({
      createWritable: async () => ({ close: async () => {}, abort: async () => {} }),
      getFile: () => { reading.resolve(); return file.promise; },
      removeEntry: async name => { removed.push(name); },
    });
    const receiving = page.element('receive').onclick();
    await reading.promise;
    if (action === 'cancel') page.element('cancel').onclick();
    else page.events.pagehide();
    file.resolve(new Blob(['123']));
    await receiving;
    assert.equal(page.result.error.name, 'AbortError');
    assert.equal(page.element('download').hidden, true);
    assert.equal(page.result.urls.length, 0);
    assert.deepEqual(removed, ['host-test.part']);
  });
}
