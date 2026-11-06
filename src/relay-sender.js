import {
  KIND_ACCEPT,
  KIND_ACK,
  KIND_COMPLETE,
  KIND_CHUNK,
  KIND_END,
  KIND_OFFER,
  KIND_SIGNAL,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  encodeBase64Url,
  receiverAdmission
} from './agent-protocol.js';
import { createRecordMerger, offerDirect } from './direct-link.js';
import { isShortCode } from './agent-code.js';
import { fileSource, rechunk } from './zip-bundle.js';

// Browser relay sender: mints a numeric share code plus a share link and
// streams one byte source with the same encrypted records `cdx send` uses,
// so `cdx receive <code>` or any browser Receive box can take it.
// startRelaySend is the engine (used by the main page); mountRelaySender
// wires it to the standalone `/send` page.

const CHUNK_SIZE = 256 * 1024;
const SEND_WINDOW_BYTES = 8 * 1024 * 1024;
const ADMISSION_WAIT_MS = 10_000;
const PEER_WAIT_MS = 15 * 60_000;
const CONSENT_WAIT_MS = 10 * 60_000;
const TRANSFER_IDLE_MS = 90_000;

const encoder = new TextEncoder();

function formatSize(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export class RelaySendError extends Error {}

// startRelaySend sends source ({ name, type, size, stream() }) and reports
// through hooks: onShare({ code, url }), onState(state), onStatus(text),
// onProgress(done, total). It resolves when the receiver verified every
// byte and rejects with the reason otherwise. cancel() stops it.
export function startRelaySend(source, hooks = {}) {
  const onShare = hooks.onShare || (() => {});
  const onState = hooks.onState || (() => {});
  const onStatus = hooks.onStatus || (() => {});
  const onProgress = hooks.onProgress || (() => {});
  let socket;
  let direct;
  let directUsed = false;
  let switched = false;
  let cancelled = false;
  let completed = false;
  let finished = false;
  let trace;
  let retained = [];
  const merger = createRecordMerger();
  const incoming = [];
  let wake;
  let failure;
  const fail = (error) => { failure ||= error; wake?.(); };
  const enqueue = (data) => {
    try {
      if (typeof data === 'string') {
        if (incoming.length > 256) throw new Error('Too many relay events.');
        incoming.push(data);
      } else {
        incoming.push(...merger.push(data));
        trace?.queue(merger.bufferedBytes);
      }
      wake?.();
    } catch (error) { fail(error); }
  };
  const next = async (timeout, message) => {
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    if (!incoming.length && !failure) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { fail(new RelaySendError(message)); }, timeout);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    }
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    if (incoming.length) return incoming.shift();
    throw failure;
  };
  const textEvent = (data) => {
    const value = JSON.parse(data);
    if (value.protocol !== 'cd-transfer-v1') throw new Error('Invalid relay event.');
    if (value.type === 'peer-left' && !directUsed) throw new RelaySendError('The receiver left.');
    return value;
  };
  const waitForText = async (type, timeout, message) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const data = await next(deadline - Date.now(), message);
      if (typeof data !== 'string') throw new Error('Unexpected transfer record.');
      const value = textEvent(data);
      if (value.type === type) return value;
    }
    throw new RelaySendError(message);
  };
  const close = () => { direct?.close(); socket?.close(1000, 'sender left'); };

  async function run() {
    onState('connecting');
    onStatus('Getting a code...');
    const invitation = { id: crypto.getRandomValues(new Uint8Array(16)), key: crypto.getRandomValues(new Uint8Array(32)) };
    const [{ digest }, sealer, opener] = await Promise.all([
      receiverAdmission(invitation), createSealer(invitation, SENDER_DIRECTION), createOpener(invitation, RECEIVER_DIRECTION)
    ]);
    const id = encodeBase64Url(invitation.id);
    trace = import.meta.env?.VITE_CD_DIAGNOSTICS === '1' ? globalThis.cdDiagnostics?.start('sender', invitation) : null;
    trace?.event('connecting');
    const shareUrl = `${window.location.origin}/s/${id}#v1.${encodeBase64Url(invitation.key)}`;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/v1/${id}`);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => enqueue(event.data));
    socket.addEventListener('close', () => { if (!directUsed && !completed) fail(new RelaySendError('Lost the connection to CD.')); });
    socket.addEventListener('error', () => { if (!directUsed) fail(new RelaySendError('Could not reach CD.')); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelaySendError('Could not reach CD.')), ADMISSION_WAIT_MS);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new RelaySendError('Could not reach CD.')); }, { once: true });
    });
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    window.addEventListener('pagehide', close, { once: true });
    socket.send(JSON.stringify({ type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: encodeBase64Url(digest), shareKey: encodeBase64Url(invitation.key) }));
    const accepted = await waitForText('accepted', ADMISSION_WAIT_MS, 'CD did not answer.');
    if (!isShortCode(accepted.code)) throw new RelaySendError('This relay needs an update. Use the current CD site.');
    trace?.event('code-ready');
    onShare({ code: accepted.code, url: shareUrl });
    onState('waiting');
    onStatus('Waiting for the receiver. The code works for 15 minutes.');
    hooks.onTransport?.('relay');
    const directPromise = source.size >= 1024 * 1024 && typeof RTCPeerConnection === 'function' && hooks.transport !== 'relay' && trace?.mode !== 'relay'
      ? offerDirect({
          trace,
          onRecord(record) { directUsed = true; enqueue(record); },
          onLost(error) { if (directUsed && !completed) fail(error); },
          onOpen() { hooks.onTransport?.('direct'); }
        }).then((path) => { direct = path; if (cancelled || finished) path.close(); return path; }).catch(() => null)
      : Promise.resolve(null);
    await waitForText('peer-joined', PEER_WAIT_MS, 'Nobody used the code within 15 minutes.');
    trace?.event('peer-joined');
    const path = await directPromise;
    const send = async (kind, payload = new Uint8Array(), release = Infinity) => {
      if (cancelled) throw new RelaySendError('Transfer canceled.');
      if (failure) throw failure;
      const started = trace ? performance.now() : 0;
      const record = await sealer.seal(kind, payload);
      trace?.timing('seal', performance.now() - started);
      if (direct?.open) {
        directUsed = true;
        if (!switched) {
          switched = true;
          trace?.event('transport', 'direct');
          for (const earlier of retained) await direct.send(earlier.record);
          retained = [];
        }
        await direct.send(record);
      } else {
        if (direct && !switched) retained.push({ record, release });
        socket.send(record);
      }
    };
    const waitForRecord = async (kind, timeout, message) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = await next(deadline - Date.now(), message);
        if (typeof data === 'string') { textEvent(data); continue; }
        let opened;
        try { opened = await opener.open(data); } finally { merger.release(data); }
        if (opened.kind === KIND_SIGNAL && direct) {
          try { await direct.signal(JSON.parse(new TextDecoder().decode(opened.plaintext))); } catch { if (!directUsed) direct.close(); }
          continue;
        }
        if (opened.kind !== kind) throw new RelaySendError('The receiver sent a message out of order.');
        return opened.plaintext;
      }
      throw new RelaySendError(message);
    };
    const decodeCounts = (value) => {
      if (value.byteLength !== 12) throw new RelaySendError('The receiver sent invalid progress.');
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      return { chunks: view.getUint32(0), bytes: view.getBigUint64(4) };
    };
    const encodeCounts = (chunks, bytes) => {
      const value = new Uint8Array(12);
      const view = new DataView(value.buffer);
      view.setUint32(0, chunks); view.setBigUint64(4, bytes);
      return value;
    };
    onState('connecting');
    onStatus('Receiver connected. Waiting for them to accept...');
    await send(KIND_OFFER, encoder.encode(JSON.stringify({ name: source.name, mediaType: source.type || 'application/octet-stream', size: String(source.size), chunkSize: CHUNK_SIZE, ...(path ? { direct: { sdp: path.sdp } } : {}) })));
    await waitForRecord(KIND_ACCEPT, CONSENT_WAIT_MS, 'The receiver did not accept within 10 minutes.');
    trace?.event('accepted');
    onState('transferring');
    onStatus('Sending...');
    const total = BigInt(source.size);
    let sent = 0n;
    let acknowledged = 0n;
    let chunks = 0;
    const awaitAck = async () => {
      const started = trace ? performance.now() : 0;
      const ack = decodeCounts(await waitForRecord(KIND_ACK, TRANSFER_IDLE_MS, 'The transfer stalled: no progress for 90 seconds.'));
      trace?.timing('ackWait', performance.now() - started);
      if (ack.chunks > chunks || ack.bytes < acknowledged || ack.bytes > sent) throw new RelaySendError('The receiver sent invalid progress.');
      acknowledged = ack.bytes;
      retained = retained.filter((entry) => entry.release > Number(acknowledged));
      trace?.progress(Number(acknowledged), source.size, chunks, switched ? 'direct' : 'relay');
      onProgress(Number(acknowledged), source.size);
    };
    const iterator = rechunk(source.stream(), CHUNK_SIZE)[Symbol.asyncIterator]();
    for (;;) {
      const started = trace ? performance.now() : 0;
      const item = await iterator.next();
      trace?.timing('read', performance.now() - started);
      if (item.done) break;
      const chunk = item.value;
      if (sent + BigInt(chunk.byteLength) > total) throw new RelaySendError('A file changed while it was being sent.');
      await send(KIND_CHUNK, chunk, Number(sent) + chunk.byteLength);
      sent += BigInt(chunk.byteLength); chunks++;
      while (sent - acknowledged >= BigInt(SEND_WINDOW_BYTES)) await awaitAck();
    }
    if (sent !== total) throw new RelaySendError('A file changed while it was being sent.');
    while (acknowledged < sent) await awaitAck();
    await send(KIND_END, encodeCounts(chunks, sent));
    const done = decodeCounts(await waitForRecord(KIND_COMPLETE, TRANSFER_IDLE_MS, 'The receiver did not confirm the file.'));
    if (done.bytes !== sent || done.chunks !== chunks) throw new RelaySendError('The receiver did not verify the transfer.');
    completed = true;
    trace?.finish('complete');
    onProgress(source.size, source.size);
    onState('complete');
    onStatus('The receiver has every byte.');
  }
  const done = run().catch((error) => {
    trace?.finish(cancelled ? 'cancelled' : 'failed');
    throw error instanceof RelaySendError ? error : new RelaySendError(error.message || 'The transfer failed.');
  }).finally(() => { finished = true; window.removeEventListener('pagehide', close); close(); retained = []; merger.clear(); incoming.length = 0; });
  return { done, cancel() { cancelled = true; close(); fail(new RelaySendError('Transfer canceled.')); } };
}

// mountRelaySender wires startRelaySend to the standalone `/send` page.
// `els` provides: fileInput, pickBtn, fileLine, shareBox, shareCode,
// shareLink, receiveCommand, copyCodeBtn, copyLinkBtn, copyCmdBtn, progress,
// progressBar, progressFill, progressCopy, status, cancelBtn, againBtn.
export function mountRelaySender(els) {
  let active = null;
  let shareUrl = '';
  let shareCode = '';

  function paintProgress(sent, total) {
    const percent = total === 0 ? 100 : Math.min((sent / total) * 100, 100);
    els.progress.hidden = false;
    els.progressFill.style.transform = `scaleX(${percent / 100})`;
    els.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
    els.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(sent)} / ${formatSize(total)}`;
  }

  function sendFile(file) {
    els.pickBtn.disabled = true;
    els.cancelBtn.hidden = false;
    els.againBtn.hidden = true;
    els.fileLine.textContent = `${file.name} · ${formatSize(file.size)}`;
    active = startRelaySend(fileSource(file, { chunkBytes: CHUNK_SIZE }), {
      onShare({ code, url }) {
        shareCode = code;
        shareUrl = url;
        els.shareBox.hidden = false;
        els.shareCode.textContent = code;
        els.shareLink.textContent = url;
        els.receiveCommand.textContent = `cdx receive ${code}`;
      },
      onStatus(text) { els.status.textContent = text; },
      onProgress: paintProgress
    });
    active.done.then(() => {
      els.cancelBtn.hidden = true;
      els.againBtn.hidden = false;
    }, (error) => {
      els.status.textContent = error.message;
      els.cancelBtn.hidden = true;
      els.againBtn.hidden = false;
    });
  }

  async function copyText(text, button) {
    const original = button.textContent;
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1400);
  }

  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) sendFile(file);
  });
  els.cancelBtn.addEventListener('click', () => {
    active?.cancel();
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.pickBtn.disabled = false;
  });
  els.againBtn.addEventListener('click', () => {
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.fileInput.value = '';
    els.fileLine.textContent = 'No file chosen yet.';
    els.pickBtn.disabled = false;
    els.againBtn.hidden = true;
    els.status.textContent = '';
  });
  els.copyLinkBtn.addEventListener('click', () => void copyText(shareUrl, els.copyLinkBtn));
  els.copyCodeBtn.addEventListener('click', () => void copyText(shareCode, els.copyCodeBtn));
  els.copyCmdBtn.addEventListener('click', () => void copyText(`cdx receive ${shareCode}`, els.copyCmdBtn));

  return { sendFile };
}
