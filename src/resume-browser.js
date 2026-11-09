import {
  RESUME_CHUNK_SIZE, RESUME_LIMIT_MS, RESUME_DB_NAME, parseResumeLink, decodeBase64Url,
  bytesToHex, hashFile, checkpointFor, createV2Socket, authenticateV2Peer, sessionParams,
  nextRecord, sendRecord, waitForRelayEvent, encodeResumeAck, encodeResumeCounts,
  decodeResumeCounts, resumeSafeFilename, textEncoder, textDecoder,
  KIND_ACCEPT, KIND_ACK, KIND_CHUNK, KIND_COMPLETE, KIND_END, KIND_OFFER,
  RECEIVER_DIRECTION, SENDER_DIRECTION, createResumeSealer, createResumeOpener,
} from '../packages/transfer-web/src/transport.js';
import { receiveContent } from '../packages/transfer-web/src/content.js';
import { signResumeCheckpoint, verifyResumeCheckpoint } from './resume-protocol.js';
import { encodeBase64Url } from './agent-protocol.js';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { downloadUrlFor } from './sink.js';
import { createResumeWriter } from './resume-opfs.js';
export * from '../packages/transfer-web/src/transport.js';
function reportResumeProgress(hooks, role, done, total, metrics) {
  hooks.onProgress?.(done, total, metrics);
  try { globalThis.__CD_RESUME_TEST_OBSERVER__?.({ role, done, total, ...metrics }); } catch { /* Test instrumentation is optional. */ }
}

export function openResumeDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.reject(new Error('This browser cannot keep resumable transfer data locally.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RESUME_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints');
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local resume storage.'));
  });
}

export function createResumeKV(db, storeName) {
  return {
    get(key) { return idbRequest(db, storeName, 'readonly', (store) => store.get(key)); },
    put(key, value) { return idbRequest(db, storeName, 'readwrite', (store) => store.put(value, key)); },
    delete(key) { return idbRequest(db, storeName, 'readwrite', (store) => store.delete(key)); },
    keys() { return idbRequest(db, storeName, 'readonly', (store) => store.getAllKeys()); }
  };
}

function idbRequest(db, name, mode, invoke) {
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = db.transaction(name, mode, { durability: 'strict' }); }
    catch { transaction = db.transaction(name, mode); }
    const request = invoke(transaction.objectStore(name));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Local resume storage failed.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('Local resume storage failed.'));
  });
}

export { cleanExpiredResumeRecords } from './resume-retention.js';

export function newStagingId() { return `cd-rx-${crypto.randomUUID()}`; }
export function isOpaqueStagingId(value) { return typeof value === 'string' && /^cd-rx-[0-9a-f-]{36}$/.test(value); }

export async function createReceiverStage({ invitation, rootId, offer, storage = globalThis.navigator?.storage, checkpoints, secrets, now = Date.now() }) {
  if (!storage?.getDirectory) throw new Error('Resume needs browser durable storage (OPFS). Open this link in a supported browser with site storage enabled.');
  if (!Number.isSafeInteger(Number(offer.size)) || Number(offer.size) < 0 || String(Number(offer.size)) !== String(offer.size)) throw new Error('The sender offered an invalid file size.');
  if (offer.chunkSize !== RESUME_CHUNK_SIZE || !/^[0-9a-f]{64}$/.test(offer.wholeSha256)) throw new Error('The sender offered invalid resumable file details.');
  const directory = await storage.getDirectory();
  const checkpointKey = `receiver:${rootId}`;
  let checkpoint = await checkpoints.get(checkpointKey);
  let handle;
  let offset = 0;
  let stagingId;
  let hash = new IncrementalSHA256();
  const destination = 'browser-download';
  const secret = invitation.key;
  if (checkpoint) {
    if (!(await verifyResumeCheckpoint(checkpoint, secret, now)) || checkpoint.role !== 'receiver' || checkpoint.rootId !== rootId || checkpoint.filename !== offer.name || checkpoint.size !== Number(offer.size) || checkpoint.wholeSha256 !== offer.wholeSha256 || checkpoint.destination !== destination || checkpoint.expiresAt <= now || !isOpaqueStagingId(checkpoint.stagingId)) {
      throw new Error('Saved receive progress failed its integrity or file identity check. Cancel it and ask the sender to start a new resumable transfer.');
    }
    offset = checkpoint.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number(offer.size) || (offset % RESUME_CHUNK_SIZE !== 0 && offset !== Number(offer.size))) {
      throw new Error('Saved receive progress has an invalid offset. Cancel it and start a new transfer.');
    }
    stagingId = checkpoint.stagingId;
    handle = await directory.getFileHandle(stagingId);
    const file = await handle.getFile();
    if (file.size < offset) throw new Error('Saved receive data is truncated. Cancel it and start a new transfer.');
    hash = await hashFile(file, { length: offset });
    if (hash.digestHex() !== checkpoint.prefixSha256) throw new Error('Saved receive data failed its integrity check. Cancel it and start a new transfer.');
    if (file.size !== offset) {
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.truncate(offset);
      await writable.close();
    }
  } else {
    stagingId = newStagingId();
    handle = await directory.getFileHandle(stagingId, { create: true });
  }

  const writer = await createResumeWriter(handle);
  const expiresAt = checkpoint?.expiresAt ?? Math.min(now + RESUME_LIMIT_MS, Number(offer.expiresAt) || now + RESUME_LIMIT_MS);
  let currentOffset = offset;
  let closed = false;
  async function persist(nextOffset, nextHash, priorSessionNonce) {
    const unsigned = checkpointFor({ role: 'receiver', rootId, offer, offset: nextOffset, prefixSha256: nextHash.digestHex(), stagingId, destination, expiresAt, priorSessionNonce });
    checkpoint = await signResumeCheckpoint(unsigned, secret);
    await checkpoints.put(checkpointKey, checkpoint);
  }
  let operation = Promise.resolve();
  async function appendInner(bytes, priorSessionNonce) {
    if (closed) throw new Error('The saved receive stage is closed.');
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nextOffset = currentOffset + value.byteLength;
    if (!value.byteLength || value.byteLength > RESUME_CHUNK_SIZE || nextOffset > Number(offer.size) || (nextOffset < Number(offer.size) && value.byteLength !== RESUME_CHUNK_SIZE)) throw new Error('The sender sent an invalid chunk boundary.');
    const nextHash = hash.clone().update(value);
    await writer.write(value, currentOffset);
    await persist(nextOffset, nextHash, priorSessionNonce);
    currentOffset = nextOffset;
    hash = nextHash;
  }
  function append(bytes, priorSessionNonce) {
    const current = operation.then(() => appendInner(bytes, priorSessionNonce));
    operation = current.catch(() => {});
    return current;
  }
  async function finishInner() {
    if (closed) throw new Error('The saved receive stage is closed.');
    if (currentOffset !== Number(offer.size) || hash.digestHex() !== offer.wholeSha256) throw new Error('The received file did not match the sender’s whole-file digest.');
    closed = true;
    await writer.close();
    return handle.getFile();
  }
  function finish() {
    const current = operation.then(finishInner);
    operation = current.catch(() => {});
    return current;
  }
  async function release() {
    closed = true;
    await operation.catch(() => {});
    await writer.close();
  }
  async function cancel() {
    try { await release(); }
    finally {
      try { await directory.removeEntry(stagingId); } catch { /* Best effort. */ }
      await checkpoints.delete(checkpointKey);
    }
  }
  function bindSession(priorSessionNonce) {
    const current = operation.then(() => {
      if (closed) throw new Error('The saved receive stage is closed.');
      return persist(currentOffset, hash, priorSessionNonce);
    });
    operation = current.catch(() => {});
    return current;
  }
  return { offset, prefixSha256: hash.digestHex(), expiresAt, stagingId, bindSession, append, finish, cancel, release, get currentOffset() { return currentOffset; }, get wholeHash() { return hash.digestHex(); }, get hashState() { return hash.clone(); } };
}

export function mountResumableReceiver(container, link, { storage = globalThis.navigator?.storage, checkpoints, secrets, download = true, hooks = {} } = {}) {
  let stopped = false;
  let discard = false;
  let socket;
  container.classList.add('share-panel');
  container.innerHTML = '<span class="panel-kicker">resumable transfer</span><p role="status" data-resume-status>Connecting securely…</p><strong data-resume-name></strong><div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div><span data-resume-progress></span><button type="button" class="secondary-btn" data-resume-cancel>Cancel saved progress</button>';
  const status = container.querySelector('[data-resume-status]');
  const filename = container.querySelector('[data-resume-name]');
  const progress = container.querySelector('[data-resume-progress]');
  const fill = container.querySelector('.progress-fill');
  const cancel = container.querySelector('[data-resume-cancel]');
  let stage;
  const cancelClick = () => {
    stopped = true;
    discard = true;
    void stage?.cancel().catch(error => {
      status.textContent = error.message || 'Could not remove saved progress.';
      hooks.onError?.(error);
    });
    try { socket?.close(1000, 'receiver canceled'); } catch { /* Best effort. */ }
    status.textContent = 'Saved progress removed.';
  };
  cancel.addEventListener('click', cancelClick);
  const done = (async () => {
    if (!storage?.getDirectory) throw new Error('Resume needs browser durable storage (OPFS). Open this link in a supported browser with site storage enabled.');
    const parsed = parseResumeLink(link);
    const invitation = { id: parsed.id, key: parsed.key };
    const { socket: activeSocket, nonce, inbox } = await createV2Socket(invitation, 'receiver', null, { onSocket(value) { socket = value; } });
    socket = activeSocket;
    const session = await authenticateV2Peer(invitation, 'receiver', nonce, inbox);
    if (stopped) return;
    const [opener, sealer] = await Promise.all([
      createResumeOpener(invitation, SENDER_DIRECTION, sessionParams(session)),
      createResumeSealer(invitation, RECEIVER_DIRECTION, sessionParams(session))
    ]);
    const rawOffer = await nextRecord(inbox, opener, KIND_OFFER);
    if (stopped) return;
    if (rawOffer.byteLength > 16 * 1024) throw new Error('The sender offered oversized file metadata.');
    let offer;
    try { offer = JSON.parse(textDecoder.decode(rawOffer)); } catch { throw new Error('The sender offered invalid file details.'); }
    if (!resumeSafeFilename(offer.name) || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= Date.now() || (session.expiresAt && offer.expiresAt !== session.expiresAt)) throw new Error('The sender offered an invalid or expired file.');
    filename.textContent = offer.name;
    stage = await createReceiverStage({ invitation, rootId: parsed.rootId, offer, storage, checkpoints, secrets, now: Date.now() });
    if (stopped) {
      if (discard) await stage.cancel();
      else { await stage.bindSession(encodeBase64Url(session.sessionNonce)); await stage.release(); }
      return;
    }
    await stage.bindSession(encodeBase64Url(session.sessionNonce));
    if (stopped) { if (discard) await stage.cancel(); else await stage.release(); return; }
    const resumeControl = { offset: String(stage.offset), prefixSha256: stage.prefixSha256 };
    sendRecord(socket, await sealer.seal(KIND_ACCEPT, textEncoder.encode(JSON.stringify(resumeControl))));
    let maxWorkingBytes = 0;
    let publishedDownload;
    await receiveContent({
      offer: { size: Number(offer.size), sha256: offer.wholeSha256 }, offset: stage.offset, hash: stage.hashState,
      next: async () => {
        while (true) {
          const event = await inbox.next();
          if (typeof event.data !== 'string') {
            maxWorkingBytes = Math.max(maxWorkingBytes, event.data.byteLength * 3);
            return opener.open(event.data);
          }
        }
      },
      write: (bytes) => stage.append(bytes, encodeBase64Url(session.sessionNonce)),
      acknowledge: async (chunks, bytes) => sendRecord(socket, await sealer.seal(KIND_ACK, encodeResumeAck(chunks, bytes))),
      check: () => { if (stopped) throw new Error('Receive stopped.'); },
      progress: (bytes) => {
        const percent = offer.size === '0' ? 100 : Math.min(bytes * 100 / Number(offer.size), 100);
        fill.style.transform = `scaleX(${percent / 100})`;
        progress.textContent = `${percent.toFixed(1)}% · ${bytes} / ${offer.size} bytes`;
        reportResumeProgress(hooks, 'receiver', bytes, Number(offer.size), { writtenBytes: bytes, resumedBytes: stage.offset, retainedBytes: bytes, maxWorkingBytes });
      },
      verifying: () => { status.textContent = 'Verifying file…'; },
      publish: async () => {
        const stagedFile = await stage.finish();
        if (stopped) throw new Error('Receive stopped.');
        const endHash = await hashFile(stagedFile);
        if (stopped) throw new Error('Receive stopped.');
        if (endHash.digestHex() !== offer.wholeSha256) throw new Error('The received file failed its whole-file digest check.');
        if (download) {
          publishedDownload = downloadUrlFor(stagedFile, offer.name, () => stage.cancel());
          const anchor = document.createElement('a');
          anchor.href = publishedDownload.url;
          anchor.download = publishedDownload.name;
          anchor.click();
          setTimeout(publishedDownload.revoke, 60_000);
          globalThis.addEventListener?.('pagehide', publishedDownload.revoke, { once: true });
        }
      },
    });
    sendRecord(socket, await sealer.seal(KIND_COMPLETE, encodeResumeCounts(Math.ceil(stage.currentOffset / RESUME_CHUNK_SIZE), stage.currentOffset, offer.wholeSha256)));
    socket.send(JSON.stringify({ type: 'complete', protocol: 'cd-transfer-v2', sessionNonce: encodeBase64Url(session.sessionNonce), receiverNonce: encodeBase64Url(session.receiverNonce) }));
    await waitForRelayEvent(inbox, ['completed'], 15000);
    if (!publishedDownload) await stage.cancel();
    status.textContent = 'File received and verified.';
    hooks.onComplete?.();
    return { bytesWritten: Number(offer.size), resumedBytes: stage.offset, retainedBytes: publishedDownload ? stage.currentOffset : 0, maxWorkingBytes };

  })().catch(async (error) => {
    await stage?.release().catch(() => {});
    try { socket?.close(1011, 'receiver failed'); } catch { /* Best effort. */ }
    if (stopped) { if (discard) status.textContent = 'Saved progress removed.'; return; }
    status.textContent = error.message || 'The resumable transfer failed.';
    hooks.onError?.(error);
    throw error;
  });
  return { done, stop() { stopped = true; void stage?.release().catch(() => {}); try { socket?.close(1000, 'receiver left'); } catch { /* Best effort. */ } }, cancel: cancelClick };
}
