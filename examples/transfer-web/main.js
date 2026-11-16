import { CdTransferClient } from '../../packages/transfer-web/src/index.js';
const element = id => document.getElementById(id);
element('origin').value = location.origin;
let active;
let busy = false;
let revoke;
const status = text => { element('status').textContent = text; };
const update = value => status(`${value.state}: ${value.bytes}/${value.total} bytes`);
async function run(create) {
  if (busy) return status('Cancel the active transfer before starting another.');
  busy = true;
  try {
    active = create(new CdTransferClient({ appId: 'com.example.web-host', relayOrigin: element('origin').value }));
    const result = await active();
    status(`Verified ${result.size} bytes\nSHA-256: ${result.sha256}`);
  } catch (error) { status(error.state || 'Transfer failed. Check the link, relay and storage.'); }
  finally { busy = false; active = null; }
}
element('send').onclick = () => run(client => {
  const operation = client.outgoing(element('file').files[0], { onUpdate: update });
  const invoke = () => operation.run(link => { element('link').value = link; });
  invoke.cancel = () => operation.cancel();
  return invoke;
});
element('receive').onclick = () => run(client => {
  const operation = client.incoming(element('link').value, { onUpdate: update });
  const invoke = () => operation.run(async (offer, signal) => {
    if (!confirm(`Accept ${offer.name}, ${offer.size} bytes?\nUnverified app ID: ${offer.appId || 'unspecified'}\nSHA-256: ${offer.sha256}`)) return null;
    signal.throwIfAborted();
    const directory = await navigator.storage.getDirectory();
    const name = `host-${crypto.randomUUID()}.part`;
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable().catch(async error => {
      await directory.removeEntry(name).catch(() => {});
      throw error;
    });
    let closed = false;
    return {
      async write(bytes, signal) { signal.throwIfAborted(); await writable.write(bytes); },
      async commit(file, signal) {
        signal.throwIfAborted(); await writable.close(); closed = true; signal.throwIfAborted();
        const verified = await handle.getFile();
        signal.throwIfAborted();
        revoke?.();
        const url = URL.createObjectURL(verified);
        const anchor = element('download');
        anchor.href = url; anchor.download = offer.name; anchor.hidden = false;
        revoke = () => { URL.revokeObjectURL(url); void directory.removeEntry(name); anchor.hidden = true; };
      },
      async abort() { if (!closed) await writable.abort().catch(() => {}); await directory.removeEntry(name); },
    };
  });
  invoke.cancel = () => operation.cancel();
  return invoke;
});
element('cancel').onclick = () => active?.cancel();
addEventListener('pagehide', () => { active?.cancel(); revoke?.(); });
