import { receiveContent } from './content.js';
import {
  startResumableSend, parseResumeLink, createV2Socket, authenticateV2Peer, sessionParams,
  nextRecord, sendRecord, waitForRelayEvent, encodeResumeAck, encodeResumeCounts,
  resumeSafeFilename, textEncoder, textDecoder, ConnectionFailure, TransferRejectedError,
  RESUME_CHUNK_SIZE, createResumeOpener, createResumeSealer,
} from './transport.js';
import { IncrementalSHA256 } from './incremental-sha256.js';

export class TransferError extends Error {
  constructor(state, cause) { super(`Transfer ${state}`, { cause }); this.name = 'TransferError'; this.state = state; }
}
const memoryStore = () => {
  const values = new Map();
  return { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
};
function originOf(value) {
  const url = new URL(value);
  const parts = url.hostname.split('.').map(Number);
  const ipv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(url.hostname) && parts.every(value => value <= 255);
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || (ipv4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254)));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('Use an HTTPS relay origin or a local HTTP origin.');
  return url.origin;
}
function validateOffer(value, expiry) {
  if (!value || !resumeSafeFilename(value.name) || new TextEncoder().encode(value.name).length > 255 || /[\x00-\x1f]/.test(value.name) || !/^(0|[1-9][0-9]*)$/.test(value.size) || typeof value.size !== 'string' || !Number.isSafeInteger(Number(value.size)) || value.chunkSize !== RESUME_CHUNK_SIZE || !/^[a-f0-9]{64}$/.test(value.wholeSha256) || value.expiresAt !== expiry) throw new Error('Invalid file offer.');
  if (value.appId !== undefined && (typeof value.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.appId))) throw new Error('Invalid public appId.');
  return { name: value.name, size: Number(value.size), sha256: value.wholeSha256, expiresAt: expiry, appId: value.appId };
}

/** UI-free v2 preview client. Never persists secrets, chooses a destination or installs page listeners. */
export class CdTransferClient {
  constructor({ appId, relayOrigin = 'https://cd.yash0.in' }) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(appId)) throw new Error('Invalid public appId.');
    this.appId = appId;
    this.origin = originOf(relayOrigin);
  }
  outgoing(file, { lifetimeMs = 900_000, onUpdate = () => {} } = {}) {
    if (!file || !resumeSafeFilename(file.name) || new TextEncoder().encode(file.name).length > 255 || /[\x00-\x1f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') throw new Error('Choose one immutable File.');
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 86_400_000) throw new Error('Lifetime must be 1 second to 24 hours.');
    const operation = new TransferOperation(onUpdate);
    operation.run = (onReady) => operation.execute(async () => {
      const sender = startResumableSend(file, {
        origin: this.origin, appId: this.appId, lifetimeMs, secrets: memoryStore(), checkpoints: memoryStore(),
        hooks: {
          onShare: ({ url, expiresAt }) => { operation.expire(expiresAt); operation.update('waiting'); onReady(url); },
          onPhase: (state) => operation.update(state),
          onProgress: (bytes, total) => { if (operation.state !== 'verifying') operation.update('transferring', bytes, total); },
        },
      });
      operation.stop = () => sender.cancel();
      operation.check();
      const result = await sender.done;
      return { size: file.size, sha256: result.wholeSha256 };
    });
    return operation;
  }
  incoming(link, { onUpdate = () => {} } = {}) {
    const parsed = parseResumeLink(link);
    originOf(parsed.url.origin);
    if (parsed.url.username || parsed.url.password || parsed.url.search) throw new Error('Invalid invitation.');
    const operation = new TransferOperation(onUpdate);
    operation.run = (onOffer) => operation.execute(async () => {
      let sink;
      let committed = false;
      let socket;
      operation.stop = () => { socket?.close(1000, 'host stopped'); };
      try {
        const connection = await createV2Socket(parsed, 'receiver', null, {
          location: parsed.url, onSocket(value) { socket = value; if (operation.stopped) socket.close(1000, 'host stopped'); },
        });
        const session = await authenticateV2Peer(parsed, 'receiver', connection.nonce, connection.inbox);
        operation.expire(session.expiresAt);
        const [opener, sealer] = await Promise.all([
          createResumeOpener(parsed, 0, sessionParams(session)), createResumeSealer(parsed, 1, sessionParams(session)),
        ]);
        const raw = await nextRecord(connection.inbox, opener, 1);
        if (raw.byteLength > 16384) throw new Error('Offer too large.');
        const json = JSON.parse(textDecoder.decode(raw));
        const offer = validateOffer(json, session.expiresAt);
        operation.update('awaiting-consent', 0, offer.size);
        sink = await operation.wait(Promise.resolve(onOffer(offer, operation.signal)).then(async (value) => {
          if (operation.stopped) { await value?.abort(); operation.check(); }
          return value;
        }));
        operation.check();
        if (sink === null) {
          sendRecord(socket, await sealer.seal(4, textEncoder.encode('{"rejected":true}')));
          // Let the encrypted rejection leave the browser's queue before closing.
          await waitForRelayEvent(connection.inbox, ['peer-left'], 1000).catch(() => {});
          throw new TransferError('rejected');
        }
        if (!sink || typeof sink.write !== 'function' || typeof sink.commit !== 'function' || typeof sink.abort !== 'function') throw new Error('Host must supply a sink after consent.');
        const accept = { offset: '0', prefixSha256: new IncrementalSHA256().digestHex(), ackEveryBytes: RESUME_CHUNK_SIZE };
        sendRecord(socket, await sealer.seal(4, textEncoder.encode(JSON.stringify(accept))));
        const result = await receiveContent({
          offer, next: () => nextOpened(connection.inbox, opener),
          write: (bytes) => sink.write(bytes, operation.signal),
          acknowledge: async (chunks, bytes) => sendRecord(socket, await sealer.seal(5, encodeResumeAck(chunks, bytes))),
          check: () => operation.check(), progress: (bytes) => operation.update('transferring', bytes, offer.size),
          verifying: () => operation.update('verifying', offer.size, offer.size),
          publish: async () => { await sink.commit({ size: offer.size, sha256: offer.sha256 }, operation.signal); committed = true; },
        });
        sendRecord(socket, await sealer.seal(6, encodeResumeCounts(Math.ceil(offer.size / RESUME_CHUNK_SIZE), offer.size, offer.sha256)));
        socket.send(JSON.stringify({ type: 'complete', protocol: 'cd-transfer-v2', sessionNonce: session.sessionNonceText, receiverNonce: session.receiverNonceText }));
        await waitForRelayEvent(connection.inbox, ['completed'], 10_000).catch(() => {});
        return result;
      } finally {
        socket?.close(1000, 'transfer stopped');
        if (sink && !committed) await sink.abort();
      }
    });
    return operation;
  }
}

async function nextOpened(inbox, opener) {
  while (true) {
    const event = await inbox.next();
    if (typeof event.data !== 'string') return opener.open(event.data);
    const value = JSON.parse(event.data);
    if (value.protocol !== 'cd-transfer-v2') throw new Error('Incompatible protocol.');
    if (value.type === 'peer-left') throw new ConnectionFailure('Peer left.', 4404);
  }
}

class TransferOperation {
  constructor(onUpdate) { this.onUpdate = onUpdate; this.state = 'connecting'; this.started = false; this.controller = new AbortController(); this.signal = this.controller.signal; }
  update(state, bytes = 0, total = 0) { this.state = state; this.onUpdate({ state, bytes, total }); }
  check() { if (this.stopped) throw new TransferError(this.stopped); }
  cancel() { if (!this.finished && !this.stopped) { this.stopped = 'cancelled'; this.controller.abort(); this.stop?.(); } }
  expire(at) {
    if (!Number.isSafeInteger(at) || at <= Date.now() || at > Date.now() + 86_430_000) throw new TransferError('expired');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.finished) { this.stopped = 'expired'; this.controller.abort(); this.stop?.(); } }, at - Date.now());
  }
  async wait(promise) {
    this.check();
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(new TransferError(this.stopped)); this.signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([promise, cancelled]); } finally { this.signal.removeEventListener('abort', abort); }
  }
  async execute(body) {
    if (this.started) throw new Error('Transfer already run.');
    this.started = true;
    try { this.check(); this.update('connecting'); const result = await body(); this.check(); this.finished = true; this.update('complete', result.size, result.size); return result; }
    catch (cause) {
      const state = this.stopped || failureState(cause);
      this.finished = true; this.update(state); throw new TransferError(state, cause);
    } finally { clearTimeout(this.timer); }
  }
}

function failureState(cause) {
  if (cause instanceof TransferError) return cause.state;
  if (cause instanceof TransferRejectedError) return 'rejected';
  if (cause instanceof ConnectionFailure) {
    if (cause.code === 4408) return 'expired';
    return [4401, 4403, 4406, 4409, 4410].includes(cause.code) ? 'failed' : 'recoverable-failure';
  }
  return 'failed';
}
