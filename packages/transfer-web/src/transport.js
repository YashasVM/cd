import {
  createResumeOpener, createResumeSealer, resumeNonceProof, resumeReceiverAdmission,
  signResumeCheckpoint, verifyResumeCheckpoint
} from './resume-protocol.js';
import { KIND_ACCEPT, KIND_ACK, KIND_CHUNK, KIND_COMPLETE, KIND_END, KIND_OFFER, RECEIVER_DIRECTION, SENDER_DIRECTION, encodeBase64Url } from './agent-protocol.js';
import { IncrementalSHA256 } from './incremental-sha256.js';

export class TransferRejectedError extends Error {}
export class ConnectionFailure extends Error { constructor(message, code) { super(message); this.code = code; } }

export const RESUME_CHUNK_SIZE = 256 * 1024;
export const RESUME_LIMIT_MS = 24 * 60 * 60 * 1000;
export const RESUME_DB_NAME = 'cd-resume-v2';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function reportResumeProgress(hooks, role, done, total, metrics) {
  hooks.onProgress?.(done, total, metrics);
  try { globalThis.__CD_RESUME_TEST_OBSERVER__?.({ role, done, total, ...metrics }); } catch { /* Test instrumentation is optional. */ }
}

export function parseResumeLink(value, base = globalThis.location?.href) {
  const url = new URL(value, base);
  const path = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  const hash = /^#v2\.([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (!path || !hash) throw new Error('This resumable CD link is invalid.');
  const id = decodeBase64Url(path[1]);
  const key = decodeBase64Url(hash[1]);
  if (id.byteLength !== 16 || key.byteLength !== 32 || encodeBase64Url(id) !== path[1] || encodeBase64Url(key) !== hash[1]) throw new Error('This resumable CD link is invalid.');
  return { id, key, rootId: path[1], url };
}

export function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFile(file, { length = file.size, chunkSize = RESUME_CHUNK_SIZE, onBytes = () => {} } = {}) {
  if (!Number.isSafeInteger(file.size) || !Number.isSafeInteger(length) || length < 0 || length > file.size) {
    throw new Error('The selected file size is invalid.');
  }
  const hash = new IncrementalSHA256();
  for (let offset = 0; offset < length; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(length, offset + chunkSize)).arrayBuffer());
    hash.update(bytes);
    onBytes(offset + bytes.byteLength);
  }
  return hash;
}

export function checkpointFor({ role, rootId, offer, offset, prefixSha256, stagingId, destination, expiresAt, priorSessionNonce }) {
  return {
    version: 2, role, rootId, filename: offer.name, size: Number(offer.size), chunkSize: RESUME_CHUNK_SIZE,
    wholeSha256: offer.wholeSha256, offset: Number(offset), prefixSha256, stagingId,
    destination, expiresAt, priorSessionNonce
  };
}

export async function hashFilePrefix(file, offset) {
  return (await hashFile(file, { length: offset })).digestHex();
}

export function assertResumeSourceIdentity(checkpoint, file, wholeSha256) {
  if (!checkpoint || checkpoint.role !== 'sender' || checkpoint.filename !== file.name || checkpoint.size !== file.size || checkpoint.wholeSha256 !== wholeSha256) {
    throw new Error('The selected file does not match the saved source. Choose the original file and try again.');
  }
  return true;
}

export async function createPrivateSenderCapability({ origin = globalThis.location?.origin, secrets, lifetimeMs = RESUME_LIMIT_MS }) {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const key = crypto.getRandomValues(new Uint8Array(32));
  const senderToken = crypto.getRandomValues(new Uint8Array(32));
  const rootId = encodeBase64Url(id);
  const invitation = { id, key };
  const receiver = await resumeReceiverAdmission(invitation);
  const expiresAt = Date.now() + lifetimeMs;
  await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt });
  return { invitation, rootId, senderToken, receiverToken: receiver.token, receiverTokenHash: receiver.digest, expiresAt, url: `${origin}/s/${rootId}#v2.${encodeBase64Url(key)}` };
}

export async function createV2Socket(invitation, role, token, { senderTokenHash, receiverTokenHash, sessionNonce, onSocket, WebSocketCtor = globalThis.WebSocket, location = globalThis.location, expiresAt, appId } = {}) {
  const { token: receiverToken } = await resumeReceiverAdmission(invitation);
  const nonce = sessionNonce || crypto.getRandomValues(new Uint8Array(32));
  const proofRole = role === 'sender' ? 'sender' : 'receiver';
  const proof = await resumeNonceProof(invitation, proofRole, nonce);
  const encodedId = encodeBase64Url(invitation.id);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocketCtor(`${scheme}://${location.host}/ws/v2/${encodedId}`);
  onSocket?.(socket);
  socket.binaryType = 'arraybuffer';
  const inbox = createSocketInbox(socket);
  await waitSocketOpen(socket);
  if (socket.readyState !== 1) throw new Error('The transfer connection was closed before joining.');
  const join = role === 'sender'
    ? { type: 'join', protocol: 'cd-transfer-v2', role, senderToken: encodeBase64Url(token), senderTokenHash, receiverTokenHash, sessionNonce: encodeBase64Url(nonce), nonceProof: encodeBase64Url(proof) }
    : { type: 'join', protocol: 'cd-transfer-v2', role, receiverToken: encodeBase64Url(receiverToken), receiverNonce: encodeBase64Url(nonce), nonceProof: encodeBase64Url(proof) };
  if (expiresAt !== undefined && role === 'sender') join.expiresAt = expiresAt;
  if (appId !== undefined) join.appId = appId;
  socket.send(JSON.stringify(join));
  return { socket, nonce, receiverToken, inbox };
}

function createSocketInbox(socket) {
  const pending = [];
  const waiters = [];
  let failure = null;
  let queuedBytes = 0;
  let disconnected;
  const listeners = new Set();
  const disconnect = error => {
    disconnected ||= error;
    for (const listener of listeners) listener(disconnected);
  };
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        const value = JSON.parse(event.data);
        if (value.protocol === 'cd-transfer-v2' && value.type === 'peer-left') disconnect(new ConnectionFailure('The other device disconnected.', 4404));
      } catch { /* Record consumers validate malformed relay events. */ }
    }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(event);
    else {
      const size = typeof event.data === 'string' ? textEncoder.encode(event.data).byteLength : event.data?.byteLength ?? 0;
      // CLI senders allow 4 MiB outstanding, plus encrypted headers and control records.
      if (pending.length >= 32 || queuedBytes + size > 4 * 1024 * 1024 + 64 * 1024) {
        failure = new Error('The peer exceeded the bounded resume receive queue.');
        try { socket.close(4429, 'receive queue full'); } catch { /* Best effort. */ }
        while (waiters.length) waiters.shift().reject(failure);
        return;
      }
      pending.push({ event, size });
      queuedBytes += size;
    }
  });
  socket.addEventListener('close', (event) => {
    failure = new ConnectionFailure(event.code === 4408 ? 'This resumable CD transfer has expired.' : 'The transfer connection was interrupted. Your saved progress can be resumed from the same private link.', event.code);
    disconnect(failure);
    while (waiters.length) waiters.shift().reject(failure);
  });
  socket.addEventListener('error', () => {
    failure ||= new ConnectionFailure('The transfer connection failed. Your saved progress can be resumed from the same private link.', 0);
    disconnect(failure);
    while (waiters.length) waiters.shift().reject(failure);
  });
  return { onDisconnect(listener) {
    listeners.add(listener);
    if (disconnected) listener(disconnected);
    return () => listeners.delete(listener);
  }, next(timeout = 90_000) {
    if (pending.length) {
      const item = pending.shift();
      queuedBytes -= item.size;
      return Promise.resolve(item.event);
    }
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (event) => { clearTimeout(timer); resolve(event); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new ConnectionFailure('The transfer timed out waiting for the other device.', 0));
      }, timeout);
      waiters.push(waiter);
    });
  } };
}

export async function waitForRelayEvent(inbox, types, timeout) {
  while (true) {
    const event = await inbox.next(timeout);
    if (typeof event.data !== 'string') return event;
    let value;
    try { value = JSON.parse(event.data); } catch { throw new Error('CD sent an invalid resume response.'); }
    if (value.protocol !== 'cd-transfer-v2') throw new Error('The relay uses an incompatible resume protocol.');
    if (value.type === 'peer-left') throw new ConnectionFailure('The other device disconnected.', 4404);
    if (types.includes(value.type)) return value;
    if (value.type === 'completed') return value;
  }
}

export async function authenticateV2Peer(invitation, role, ownNonce, inbox, onAccepted) {
  let relayEvent = await waitForRelayEvent(inbox, ['accepted', 'peer-joined'], 15 * 60_000);
  if (relayEvent.type === 'accepted') await onAccepted?.(Number(relayEvent.expiresAt) || 0);
  while (!relayEvent.sessionNonce || !relayEvent.receiverNonce) {
    relayEvent = await waitForRelayEvent(inbox, ['accepted', 'peer-joined'], 15 * 60_000);
  }
  if (relayEvent.type === 'peer-joined') await onAccepted?.(Number(relayEvent.expiresAt) || 0);
  const sessionNonceText = relayEvent.sessionNonce;
  const receiverNonceText = relayEvent.receiverNonce;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionNonceText || '') || !/^[A-Za-z0-9_-]{43}$/.test(receiverNonceText || '')) throw new Error('The relay did not bind this transfer to a fresh session.');
  const sessionNonce = decodeBase64Url(sessionNonceText);
  const receiverNonce = decodeBase64Url(receiverNonceText);
  if (role === 'sender' && !constantTimeEqual(sessionNonce, ownNonce)) throw new Error('The relay returned a stale sender session.');
  if (role === 'receiver' && !constantTimeEqual(receiverNonce, ownNonce)) throw new Error('The relay returned a stale receiver session.');
  const peerRole = role === 'sender' ? 'receiver' : 'sender';
  const proofText = role === 'sender' ? relayEvent.receiverNonceProof : relayEvent.senderNonceProof;
  if (typeof proofText !== 'string' || !(await verifyPeerNonce(invitation, peerRole, role === 'sender' ? receiverNonce : sessionNonce, decodeBase64Url(proofText)))) {
    throw new Error('The other device could not prove its private transfer capability.');
  }
  return { sessionNonce, receiverNonce, sessionNonceText, receiverNonceText, expiresAt: Number(relayEvent.expiresAt) || 0 };
}

export function sendRecord(socket, record) {
  if (socket.readyState !== 1) throw new ConnectionFailure('The transfer connection was interrupted.', 0);
  socket.send(record);
}

export async function nextRecord(inbox, opener, expectedKind) {
  while (true) {
    const event = await inbox.next();
    if (typeof event.data === 'string') {
      let value;
      try { value = JSON.parse(event.data); } catch { continue; }
      if (value.type === 'peer-left') throw new ConnectionFailure('The other device disconnected.', 4404);
      continue;
    }
    const opened = await opener.open(event.data);
    if (opened.kind !== expectedKind) throw new Error('The other device sent messages out of order.');
    return opened.plaintext;
  }
}

export function sessionParams(session) { return { sessionNonce: session.sessionNonce, receiverNonce: session.receiverNonce }; }

function hashBytes(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('The peer sent an invalid file digest.');
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

export function startResumableSend(file, { link = '', secrets, checkpoints, hooks = {}, origin = globalThis.location?.origin, lifetimeMs, appId, WebSocketCtor = globalThis.WebSocket } = {}) {
  let socket;
  let cancelled = false;
  let privateRootId = '';
  const done = (async () => {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) throw new Error('Choose one file to send with resume enabled.');
    const capability = link
      ? await loadSenderCapability(link, { secrets, checkpoints, origin })
      : await createPrivateSenderCapability({ origin, secrets, lifetimeMs });
    const { invitation, rootId, senderToken, receiverToken, receiverTokenHash, expiresAt, url, reconnect, saved } = capability;
    privateRootId = rootId;
    if (cancelled) {
      await checkpoints.delete(`sender:${rootId}`);
      await secrets.delete(`sender:${rootId}`);
      throw new Error('Transfer canceled.');
    }
    hooks.onStatus?.('Checking the file before sharing…');
    const fullHash = await hashFile(file, { onBytes() { if (cancelled) throw new Error('Transfer canceled.'); } });
    const wholeSha256 = fullHash.digestHex();
    if (cancelled) throw new Error('Transfer canceled.');
    if (reconnect) assertResumeSourceIdentity(saved, file, wholeSha256);
    const chunkCount = Math.ceil(file.size / RESUME_CHUNK_SIZE);
    let sourceBytesRead = file.size;
    let maxWorkingBytes = RESUME_CHUNK_SIZE * 2 + 64;
    let sessionNonce = crypto.getRandomValues(new Uint8Array(32));
    if (!reconnect) {
      const emptyPrefix = new IncrementalSHA256().digestHex();
      await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: 0, prefixSha256: emptyPrefix, stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt, priorSessionNonce: encodeBase64Url(sessionNonce)
      }, senderToken));
    }
    if (cancelled) throw new Error('Transfer canceled.');
    const tokenHashBytes = await crypto.subtle.digest('SHA-256', senderToken);
    if (cancelled) throw new Error('Transfer canceled.');
    const connection = await createV2Socket(invitation, 'sender', senderToken, {
      senderTokenHash: encodeBase64Url(new Uint8Array(tokenHashBytes)),
      receiverTokenHash: encodeBase64Url(receiverTokenHash), sessionNonce,
      onSocket(value) { socket = value; if (cancelled) { try { value.close(1000, 'sender canceled'); } catch { /* Best effort. */ } } }, location: new URL(origin), WebSocketCtor, expiresAt: lifetimeMs === undefined ? undefined : expiresAt, appId
    });
    socket = connection.socket;
    let sharePublished = false;
    const publishShare = async (relayExpiry) => {
      if (cancelled) throw new Error('Transfer canceled.');
      const authoritativeExpiry = relayExpiry || expiresAt;
      if (!Number.isSafeInteger(authoritativeExpiry) || authoritativeExpiry <= Date.now() || authoritativeExpiry > Date.now() + RESUME_LIMIT_MS + 60_000) {
        throw new Error('The relay returned an invalid resume expiry.');
      }
      if (reconnect && authoritativeExpiry !== saved.expiresAt) {
        throw new Error('The relay expiry does not match this saved transfer.');
      }
      if (!reconnect && authoritativeExpiry !== expiresAt) {
        await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt: authoritativeExpiry });
        const checkpoint = await checkpoints.get(`sender:${rootId}`);
        if (checkpoint) await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({ ...checkpoint, expiresAt: authoritativeExpiry }, senderToken));
      }
      if (cancelled) throw new Error('Transfer canceled.');
      if (!sharePublished) {
        hooks.onShare?.({ url, rootId, expiresAt: authoritativeExpiry, resumed: Boolean(reconnect) });
        sharePublished = true;
      }
    };
    const session = await authenticateV2Peer(invitation, 'sender', sessionNonce, connection.inbox, publishShare);
    if (cancelled) throw new Error('Transfer canceled.');
    const activeExpiry = session.expiresAt || expiresAt;
    if (!reconnect && session.expiresAt) {
      await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt: activeExpiry });
      await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: 0, prefixSha256: new IncrementalSHA256().digestHex(), stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
      }, senderToken));
    }
    const [sealer, opener] = await Promise.all([
      createResumeSealer(invitation, SENDER_DIRECTION, sessionParams(session)),
      createResumeOpener(invitation, RECEIVER_DIRECTION, sessionParams(session))
    ]);
    const offer = { ...(appId ? { appId } : {}), name: file.name, size: String(file.size), chunkSize: RESUME_CHUNK_SIZE, wholeSha256, expiresAt: activeExpiry };
    sendRecord(socket, await sealer.seal(KIND_OFFER, textEncoder.encode(JSON.stringify(offer))));
    hooks.onPhase?.('awaiting-consent');
    const acceptanceBytes = await nextRecord(connection.inbox, opener, KIND_ACCEPT);
    if (acceptanceBytes.byteLength > 2048) throw new Error('The receiver sent oversized saved progress.');
    let acceptance;
    try { acceptance = JSON.parse(textDecoder.decode(acceptanceBytes)); } catch { throw new Error('The receiver sent invalid saved progress.'); }
    if (acceptance.rejected === true) throw new TransferRejectedError();
    const ackEveryBytes = acceptance.ackEveryBytes ?? RESUME_CHUNK_SIZE;
    if (!Number.isSafeInteger(ackEveryBytes) || ackEveryBytes < RESUME_CHUNK_SIZE || ackEveryBytes > 4 * 1024 * 1024 || ackEveryBytes % RESUME_CHUNK_SIZE !== 0) throw new Error('Invalid acknowledgement interval.');
    const windowChunks = Math.max(4, ackEveryBytes / RESUME_CHUNK_SIZE);
    const offset = Number(acceptance.offset);
    if (String(offset) !== acceptance.offset) throw new Error('Invalid offset.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size || (offset % RESUME_CHUNK_SIZE !== 0 && offset !== file.size)) throw new Error('The receiver sent an invalid resume offset.');
    if (!/^[0-9a-f]{64}$/.test(acceptance.prefixSha256 || '')) throw new Error('The receiver sent an invalid saved digest.');
    const prefixState = await hashFile(file, { length: offset });
    sourceBytesRead += offset;
    const prefixSha256 = prefixState.digestHex();
    if (prefixSha256 !== acceptance.prefixSha256) throw new Error('The selected file does not match the saved source. Choose the original file and try again.');
    if (hashBytes(wholeSha256).length !== 32 || fullHash.digestHex() !== wholeSha256) throw new Error('The selected file changed while it was being checked.');
    const checkpoint = await signResumeCheckpoint({
      version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
      wholeSha256, offset, prefixSha256, stagingId: 'sender-source', destination: 'source-reselect',
      expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
    }, senderToken);
    await checkpoints.put(`sender:${rootId}`, checkpoint);
    let bytesSent = offset;
    let chunksSent = Math.ceil(offset / RESUME_CHUNK_SIZE);
    let ackedBytes = offset;
    reportResumeProgress(hooks, 'sender', offset, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    const outstanding = [];
    let position = offset;
    while (position < file.size || outstanding.length) {
      if (cancelled) throw new Error('Transfer canceled.');
      // Keep the window bounded, but large enough to reach the negotiated cumulative ACK.
      if (position < file.size && outstanding.length < windowChunks) {
        const block = new Uint8Array(await file.slice(position, Math.min(file.size, position + RESUME_CHUNK_SIZE)).arrayBuffer());
        if (cancelled) throw new Error('Transfer canceled.');
        if (block.byteLength !== Math.min(RESUME_CHUNK_SIZE, file.size - position)) throw new Error('The selected file changed while sending.');
        sourceBytesRead += block.byteLength;
        const sealed = await sealer.seal(KIND_CHUNK, block);
        if (cancelled) throw new Error('Transfer canceled.');
        maxWorkingBytes = Math.max(maxWorkingBytes, block.byteLength + sealed.byteLength + outstanding.length * (RESUME_CHUNK_SIZE + 28));
        sendRecord(socket, sealed);
        bytesSent += block.byteLength;
        chunksSent++;
        position += block.byteLength;
        prefixState.update(block);
        outstanding.push({ bytes: bytesSent, chunks: chunksSent, prefixSha256: prefixState.digestHex() });
        continue;
      }
      const ack = decodeResumeAck(await nextRecord(connection.inbox, opener, KIND_ACK));
      const index = outstanding.findIndex(item => ack.bytes === BigInt(item.bytes) && ack.chunks === item.chunks);
      if (index < 0) throw new Error('The receiver acknowledged invalid saved progress.');
      const expected = outstanding[index];
      outstanding.splice(0, index + 1);
      ackedBytes = expected.bytes;
      const savedCheckpoint = await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: ackedBytes, prefixSha256: expected.prefixSha256, stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
      }, senderToken);
      await checkpoints.put(`sender:${rootId}`, savedCheckpoint);
      reportResumeProgress(hooks, 'sender', ackedBytes, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    }
    if (cancelled) throw new Error('Transfer canceled.');
    if (prefixState.digestHex() !== wholeSha256) throw new Error('Source changed while sending.');
    hooks.onPhase?.('verifying');
    sendRecord(socket, await sealer.seal(KIND_END, encodeResumeCounts(chunksSent, bytesSent, wholeSha256)));
    const result = decodeResumeCounts(await nextRecord(connection.inbox, opener, KIND_COMPLETE));
    if (result.bytes !== BigInt(file.size) || result.chunks !== chunkCount || result.wholeSha256 !== wholeSha256) throw new Error('The receiver did not verify the complete file.');
    await waitForRelayEvent(connection.inbox, ['completed'], 15000);
    await checkpoints.delete(`sender:${rootId}`);
    await secrets.delete(`sender:${rootId}`);
    reportResumeProgress(hooks, 'sender', file.size, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    hooks.onComplete?.();
    return { rootId, url, wholeSha256, bytesRead: sourceBytesRead, bytesSent: file.size - offset, resumedBytes: offset, retainedBytes: 0, maxWorkingBytes };
  })();
  done.catch((error) => { if (!cancelled) hooks.onError?.(error); }).finally(() => {
    try { socket?.close(1000, 'transfer stopped'); } catch { /* Best effort. */ }
    if (cancelled && privateRootId) {
      void checkpoints.delete(`sender:${privateRootId}`).catch(() => {});
      void secrets.delete(`sender:${privateRootId}`).catch(() => {});
    }
  });
  return { done, cancel() {
    cancelled = true;
    try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
    // Cleanup waits until active hashing and checkpoint writes have settled.
    // A socket loss or page close never calls this method.
  } };
}

async function loadSenderCapability(link, { secrets, checkpoints, origin }) {
  const parsed = parseResumeLink(link, `${origin}/`);
  const secret = await secrets.get(`sender:${parsed.rootId}`);
  const checkpoint = await checkpoints.get(`sender:${parsed.rootId}`);
  if (!secret || !checkpoint || secret.expiresAt <= Date.now() || !(await verifyResumeCheckpoint(checkpoint, decodeBase64Url(secret.senderToken))) || checkpoint.role !== 'sender') {
    throw new Error('This device has no active sender resume record for that private link. Resume on the device that started the send.');
  }
  return {
    invitation: { id: parsed.id, key: parsed.key }, rootId: parsed.rootId,
    senderToken: decodeBase64Url(secret.senderToken), receiverTokenHash: (await resumeReceiverAdmission({ id: parsed.id, key: parsed.key })).digest,
    expiresAt: checkpoint.expiresAt, url: parsed.url.href, reconnect: true, saved: checkpoint
  };
}

function waitSocketOpen(socket, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new ConnectionFailure('Could not reach CD. Check your connection and try again.', 0)), timeout);
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('error', () => finish(new ConnectionFailure('Could not reach CD. Check your connection and try again.', 0)), { once: true });
    socket.addEventListener('close', () => finish(new ConnectionFailure('Transfer canceled before the connection opened.', 0)), { once: true });
  });
}

export function verifyPeerNonce(invitation, role, nonce, proof) {
  return resumeNonceProof(invitation, role, nonce).then((expected) => constantTimeEqual(expected, proof));
}

function constantTimeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function encodeResumeCounts(chunks, bytes, wholeSha256) {
  const result = new Uint8Array(44);
  const view = new DataView(result.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, BigInt(bytes));
  result.set(typeof wholeSha256 === 'string' ? Uint8Array.from(wholeSha256.match(/../g).map((x) => Number.parseInt(x, 16))) : wholeSha256, 12);
  return result;
}

export function decodeResumeCounts(value) {
  if (value.byteLength !== 44) throw new Error('The peer sent invalid final transfer counts.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4), wholeSha256: bytesToHex(value.subarray(12)) };
}

export function encodeResumeAck(chunks, bytes) {
  const result = new Uint8Array(12);
  const view = new DataView(result.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, BigInt(bytes));
  return result;
}

export function decodeResumeAck(value) {
  if (value.byteLength !== 12) throw new Error('The peer sent invalid transfer progress.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4) };
}

export function resumeSafeFilename(value) {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') && !/[\\/\0]/.test(value) && value !== '.' && value !== '..';
}

export { KIND_ACCEPT, KIND_ACK, KIND_CHUNK, KIND_COMPLETE, KIND_END, KIND_OFFER, RECEIVER_DIRECTION, SENDER_DIRECTION, createResumeOpener, createResumeSealer, textEncoder, textDecoder };
