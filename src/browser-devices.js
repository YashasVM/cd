import { decodeBase64Url, encodeBase64Url } from './agent-protocol.js';
import { createStageSink } from './sink.js';

const protocol = 'cd-device-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const keyPrefix = 'device:';
const lifetime = 5 * 60_000;

function random(bytes) { return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes))); }
function exactBytes(value, size) {
  const bytes = decodeBase64Url(value);
  if (bytes.length !== size || encodeBase64Url(bytes) !== value) throw new Error('Invalid device credential.');
  return bytes;
}

export function validateBrowserPair(pair, origin = globalThis.location.origin) {
  if (!pair || pair.version !== 1 || typeof pair.name !== 'string' || !pair.name.trim() || encoder.encode(pair.name).length > 128 || /[\x00-\x1f]/.test(pair.name)) throw new Error('Invalid device name.');
  exactBytes(pair.pairId, 16);
  exactBytes(pair.secret, 32);
  const endpoint = new URL(pair.relayUrl);
  const site = new URL(origin);
  if (endpoint.protocol !== (site.protocol === 'https:' ? 'wss:' : 'ws:') || endpoint.host !== site.host || endpoint.pathname !== `/ws/devices/v1/${pair.pairId}` || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('Device belongs to a different CD site. Pair it on this site.');
  return pair;
}

export function newBrowserPair(origin = globalThis.location.origin) {
  const pair = { version: 1, pairId: random(16), secret: random(32), name: 'CD browser', localUrls: [], expiresAt: Date.now() + lifetime };
  pair.relayUrl = origin.replace(/^http/, 'ws') + '/ws/devices/v1/' + pair.pairId;
  return validateBrowserPair(pair, origin);
}

async function derive(pair, purpose) {
  const secret = await crypto.subtle.importKey('raw', exactBytes(pair.secret, 32), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: exactBytes(pair.pairId, 16), info: encoder.encode(`${protocol} ${purpose}`) }, secret, 256));
}
async function digest(bytes) { return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }

export async function createDeviceCodec(pair) {
  const [send, receive] = await Promise.all(['sender', 'receiver'].map(async role => crypto.subtle.importKey('raw', await derive(pair, `${role} messages`), 'AES-GCM', false, [role === 'sender' ? 'encrypt' : 'decrypt'])));
  const seen = new Map();
  return {
    async seal(message) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const plain = encoder.encode(JSON.stringify({ ...message, version: 1, messageId: random(16), expiresAt: Date.now() + lifetime }));
      if (plain.length + 28 > 16384) throw new Error('Device message is too large.');
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`${protocol} sender ${pair.pairId}`) }, send, plain));
      const frame = new Uint8Array(nonce.length + ciphertext.length);
      frame.set(nonce); frame.set(ciphertext, nonce.length);
      return frame;
    },
    async open(frame) {
      const bytes = new Uint8Array(frame);
      if (bytes.length < 28 || bytes.length > 16384) throw new Error('Invalid device message.');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(`${protocol} receiver ${pair.pairId}`) }, receive, bytes.slice(12));
      const message = JSON.parse(decoder.decode(plain));
      const now = Date.now();
      if (message.version !== 1 || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now || message.expiresAt > now + lifetime + 30_000) throw new Error('Expired device message.');
      exactBytes(message.messageId, 16);
      for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id);
      if (seen.has(message.messageId) || seen.size >= 8192) throw new Error('Replayed device message.');
      if (message.type === 'paired') {
        if (typeof message.name !== 'string' || !message.name.trim() || encoder.encode(message.name).length > 128 || /[\x00-\x1f]/.test(message.name)) throw new Error('Invalid device name.');
      } else if (message.type === 'received' || message.type === 'paused') exactBytes(message.transferId, 16);
      else throw new Error('Invalid device message type.');
      seen.set(message.messageId, message.expiresAt);
      return message;
    }
  };
}

function deviceStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cd-browser-devices', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('devices');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser device storage is unavailable.'));
  });
}
async function stored(method, key, value) {
  const db = await deviceStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('devices', method === 'getAll' ? 'readonly' : 'readwrite');
      const request = method === 'put' ? transaction.objectStore('devices').put(value, key) : method === 'getAll' ? transaction.objectStore('devices').getAll() : transaction.objectStore('devices').delete(key);
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Could not save browser device.'));
    });
  } finally { db.close(); }
}

function connect(pair, { onMessage, onStatus = () => {}, onError = () => {} }) {
  let socket, ping, deadline, rejectHandshake, closed = false, chain = Promise.resolve();
  const close = () => { closed = true; rejectHandshake?.(new Error('Device connection closed.'));  clearInterval(ping); clearTimeout(deadline); socket?.close(); };
  const fail = error => { if (!closed) { close(); onError(error); } };
  const ready = (async () => {
    validateBrowserPair(pair);
    const codec = await createDeviceCodec(pair);
    const [sender, receiver] = await Promise.all(['sender join', 'receiver join'].map(purpose => derive(pair, purpose)));
    const join = { type: 'join', protocol, role: 'sender', token: encodeBase64Url(sender), senderTokenHash: await digest(sender), receiverTokenHash: await digest(receiver) };
    if (closed) throw new Error('Transfer canceled.');
    socket = new WebSocket(pair.relayUrl);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      rejectHandshake = reject;
      const handshakeFailure = () => reject(new Error('Could not connect to CD device service.'));
      deadline = setTimeout(() => { handshakeFailure(); close(); }, 10_000);
      socket.addEventListener('open', () => { if (!closed) socket.send(JSON.stringify(join)); });
      socket.addEventListener('message', event => {
        chain = chain.then(async () => {
          if (closed) return;
          if (typeof event.data === 'string') {
            if (event.data.length > 256) throw new Error('Invalid device event.');
            const value = JSON.parse(event.data);
            if (value.protocol !== protocol) throw new Error('Invalid device event.');
            if (value.type === 'accepted') { clearTimeout(deadline); resolve(); onStatus('Waiting for your phone. Open CD and enable receiving.'); }
            if (value.type === 'peer-left') onStatus('Phone disconnected. Open CD and enable receiving.');
          } else await onMessage(await codec.open(event.data));
        }).catch(error => { reject(error); fail(error); });
      });
      socket.addEventListener('error', handshakeFailure, { once: true });
      socket.addEventListener('close', () => { handshakeFailure(); fail(new Error('Device connection closed. Reconnect to keep saved progress.')); });
    });
    ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', protocol })); }, 20_000);
    return { async send(message) { const frame = await codec.seal(message); if (socket.readyState !== WebSocket.OPEN) throw new Error('Device disconnected.'); socket.send(frame); } };
  })();
  ready.catch(fail);
  return { ready, close };
}

export function mountBrowserDevices(container, { onSelect, onChange = () => {} }) {
  container.innerHTML = '<fieldset class="device-picker"><legend>Send to</legend><div data-device-list></div><button type="button" class="secondary-btn" data-pair>Pair a phone</button><p class="status" role="status" data-device-status></p><div data-device-qr hidden><canvas aria-label="Scan in CD Android to pair this browser"></canvas><p>In CD Android, scan this QR and approve this browser. Then enable receiving. This invitation lasts 5 minutes.</p><button type="button" class="secondary-btn" data-pair-cancel>Cancel pairing</button></div></fieldset>';
  const list = container.querySelector('[data-device-list]');
  const status = container.querySelector('[data-device-status]');
  const qr = container.querySelector('[data-device-qr]');
  let pairing, timer, selected = '', stopped = false;
  function stopPairing() { pairing?.close(); pairing = null; clearTimeout(timer); qr.hidden = true; }
  async function render() {
    const devices = await stored('getAll');
    if (stopped) return;
    list.replaceChildren();
    const choices = [{ name: 'Share a link or code', pairId: '' }, ...devices.filter(d => d.pair)];
    for (const device of choices) {
      const row = document.createElement('div');
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'cd-destination'; input.value = device.pairId; input.checked = selected === device.pairId;
      input.addEventListener('change', () => { selected = device.pairId; onSelect(device.pair || null); });
      label.append(input, document.createTextNode(device.name + (device.pair ? ' · saved in this browser' : '')));
      row.append(label);
      if (device.pair) {
        const forget = document.createElement('button');
        forget.type = 'button'; forget.className = 'cancel-btn'; forget.textContent = 'Forget';
        forget.setAttribute('aria-label', `Forget ${device.name}`);
        forget.addEventListener('click', async () => {
          try { await stored('delete', keyPrefix + device.pairId); if (selected === device.pairId) { selected = ''; onSelect(null); } await render(); onChange(); }
          catch (error) { status.textContent = error.message; }
        });
        row.append(forget);
      }
      list.append(row);
    }
  }
  container.querySelector('[data-pair]').addEventListener('click', async () => {
    stopPairing();
    try {
      const pair = newBrowserPair();
      const qrcode = await import('qrcode');
      await qrcode.default.toCanvas(qr.querySelector('canvas'), 'cdpair://v1#' + encodeBase64Url(encoder.encode(JSON.stringify(pair))), { width: 260, margin: 2 });
      qr.hidden = false;
      status.textContent = 'Waiting for phone approval.';
      timer = setTimeout(() => { stopPairing(); status.textContent = 'Pairing invitation expired. Choose Pair a phone for a new QR.'; }, lifetime);
      pairing = connect(pair, {
        onMessage: async message => {
          if (message.type !== 'paired') return;
          await stored('put', keyPrefix + pair.pairId, { pairId: pair.pairId, name: message.name, pair: { ...pair, name: message.name } });
          stopPairing();
          selected = pair.pairId; onSelect({ ...pair, name: message.name });
          status.textContent = `${message.name} approved this browser. Receiving must stay enabled on the phone.`;
          await render(); onChange();
        },
        onError: error => { stopPairing(); status.textContent = error.message; }
      });
    } catch (error) { stopPairing(); status.textContent = error.message || 'Could not pair this browser.'; }
  });
  container.querySelector('[data-pair-cancel]').addEventListener('click', stopPairing);
  void render().catch(error => { status.textContent = error.message; });
  return () => { stopped = true; stopPairing(); };
}

export function startDeviceSend(device, source, hooks = {}) {
  let active, control, cancelled = false, cleanup = async () => {}, rootId = '', receiptResolve, receiptReject;
  const receipt = new Promise((resolve, reject) => { receiptResolve = resolve; receiptReject = reject; });
  receipt.catch(() => {});
  const done = (async () => {
    validateBrowserPair(device);
    hooks.onState?.('connecting');
    hooks.onStatus?.(`Connecting to ${device.name}. Open CD and enable receiving on the phone.`);
    const { startResumableSend, openResumeDatabase, createResumeKV } = await import('./resume-browser.js');
    let file = source.file || source;
    if (typeof file.slice !== 'function') {
      hooks.onStatus?.('Preparing the archive for resumable phone delivery…');
      const stage = await createStageSink({ name: source.name, size: source.size });
      try {
        for await (const bytes of source.stream()) { if (cancelled) throw new Error('Transfer canceled.'); await stage.write(bytes); }
        const staged = await stage.toFile(); cleanup = staged.cleanup;
        file = { name: source.name, size: staged.file.size, slice: (...args) => staged.file.slice(...args) };
      } catch (error) { await stage.discard(); throw error; }
    }
    if (cancelled) throw new Error('Transfer canceled.');
    const db = await openResumeDatabase();
    try {
      if (cancelled) throw new Error('Transfer canceled.');
      const checkpoints = createResumeKV(db, 'checkpoints');
      const secrets = createResumeKV(db, 'secrets');
      let readyControl;
      let pendingOffer;
      const sendOffer = async () => { if (readyControl && pendingOffer) await readyControl.send(pendingOffer); };
      control = connect(device, {
        onStatus: text => hooks.onStatus?.(text),
        onMessage: async message => {
          if (message.type === 'paired') { hooks.onStatus?.(`${device.name} connected.`); await sendOffer(); }
          if (message.transferId !== rootId) return;
          if (message.type === 'received') receiptResolve();
          if (message.type === 'paused') { receiptReject(new Error('The phone paused receiving. Open CD and resume it.')); active?.pause?.(); }
        },
        onError: error => { receiptReject(error); active?.pause?.(); }
      });
      if (cancelled) { control.close(); throw new Error('Transfer canceled.'); }
      readyControl = await control.ready;
      if (cancelled) throw new Error('Transfer canceled.');
      const prior = (await stored('getAll')).find(d => d.pending && d.pairId === device.pairId && d.name === file.name && d.size === file.size);
      if (cancelled) throw new Error('Transfer canceled.');
      active = startResumableSend(file, { secrets, checkpoints, link: prior?.link || '', hooks: {
        ...hooks,
        onShare(value) {
          rootId = value.rootId;
          pendingOffer = { type: 'offer', transferId: rootId, url: value.url, filename: file.name, size: String(file.size), wholeSha256: value.wholeSha256 };
          void (async () => {
            await stored('put', `pending:${device.pairId}`, { pending: true, pairId: device.pairId, name: file.name, size: file.size, link: value.url });
            await sendOffer();
            hooks.onState?.('waiting');
            hooks.onStatus?.(`Waiting for ${device.name}. Keep CD receiving enabled.`);
          })().catch(receiptReject);
        },
        onProgress(done, total, metrics) { hooks.onState?.(done >= total ? 'verifying' : 'transferring'); hooks.onProgress?.(done, total, metrics); }
      } });
      await Promise.race([active.done, receipt.then(() => new Promise(() => {}))]);
      hooks.onState?.('verifying');
      hooks.onStatus?.(`File verified. Waiting for ${device.name} to confirm it was saved…`);
      let timeout;
      try { await Promise.race([receipt, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The phone has not confirmed saving the file. Check CD on the phone before retrying.')), 30_000); })]); }
      finally { clearTimeout(timeout); }
      await stored('delete', `pending:${device.pairId}`);
      hooks.onState?.('complete');
      hooks.onStatus?.(`Delivered to ${device.name} and verified.`);
    } finally {
      active?.pause?.();
      await active?.done.catch(() => {});
      db.close();
    }
  })().finally(async () => { control?.close(); await cleanup(); });
  return { done, cancel() { cancelled = true; control?.close(); active?.cancel(); receiptReject(new Error('Transfer canceled.')); } };
}
