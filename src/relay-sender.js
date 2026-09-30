import {
  KIND_ACCEPT,
  KIND_ACK,
  KIND_COMPLETE,
  KIND_CHUNK,
  KIND_END,
  KIND_OFFER,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  encodeBase64Url,
  receiverAdmission
} from './agent-protocol.js';
import { isShortCode } from './agent-code.js';

// Relay sender engine shared by the standalone `/send` page. Picks one
// file, mints a numeric share code plus a share link, and streams it with
// the same encrypted records `cd send` uses, so `cd receive <code>` (or
// another browser on the share page) can take it.
//
// `els` must provide the same named nodes the `/send` page uses:
// fileInput, pickBtn, fileLine, shareBox, shareCode, shareLink,
// receiveCommand, copyCodeBtn, copyLinkBtn, copyCmdBtn, progress,
// progressBar, progressFill, progressCopy, status, cancelBtn, againBtn.

const CHUNK_SIZE = 256 * 1024;
const SEND_WINDOW_BYTES = 8 * 1024 * 1024;
const ADMISSION_WAIT_MS = 10_000;
const PEER_WAIT_MS = 15 * 60_000;
const CONSENT_WAIT_MS = 10 * 60_000;
const TRANSFER_IDLE_MS = 90_000;

const encoder = new TextEncoder();

// Short codes come from the relay directory: typable in any browser Receive
// box or `cd receive`. The directory holds the transfer key, so code mode
// relies on TLS + the live relay rather than end-to-end encryption.
async function claimShareCode(transferId, key) {
  let response;
  try {
    response = await fetch('/api/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, key })
    });
  } catch {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  if (!response.ok) throw new Error('Share codes are busy right now. Wait a moment and try again.');
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  if (!body || !isShortCode(body.code)) {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  return body.code;
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function mountRelaySender(els, hooks = {}) {
  const reportState = hooks.onState || (() => {});
  let socket = null;
  let cancelled = false;
  let shareUrl = '';
  let shareCode = '';

  // Single persistent pump: every socket message is buffered exactly once and
  // handed to waiters in arrival order. Attaching a fresh message listener per
  // wait (instead of this pump) drops records that arrive while a chunk is
  // being sealed or sent, which stalls multi-megabyte transfers.
  const incoming = [];
  const waiters = [];
  let pumpAttached = null;

  function setStatus(text) {
    els.status.textContent = text;
  }

  function paintProgress(sent, total) {
    const percent = total === 0n ? 100 : Math.min(Number(sent * 1000n / total) / 10, 100);
    els.progress.hidden = false;
    els.progressFill.style.transform = `scaleX(${percent / 100})`;
    els.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
    els.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(sent)} / ${formatSize(total)}`;
  }

  function fail(message) {
    if (cancelled) return;
    cancelled = true;
    reportState('failed');
    try { socket?.close(4400, 'sender failed'); } catch { /* Best effort. */ }
    setStatus(message);
    els.cancelBtn.hidden = true;
    els.againBtn.hidden = false;
  }

  function ensurePump() {
    if (pumpAttached) return;
    pumpAttached = socket;
    socket.addEventListener('message', (event) => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else incoming.push(event);
    });
  }

  function pump(_label, timeoutMs, handle, timeoutMessage) {
    ensurePump();
    return new Promise((resolve, reject) => {
      if (cancelled) {
        reject(new Error('Transfer canceled.'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = waiters.indexOf(entry);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      const entry = (event) => {
        void Promise.resolve()
          .then(() => handle(event))
          .then((result) => {
            if (result === null || result === undefined) {
              // Not what this wait wanted; keep waiting for the next message.
              if (!settled) waiters.push(entry);
              return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
          })
          .catch((error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          });
      };
      if (incoming.length > 0) entry(incoming.shift());
      else waiters.push(entry);
    });
  }

  function waitForText(type, timeoutMs) {
    return pump('text', timeoutMs, (event) => {
      if (typeof event.data !== 'string') return null;
      let value;
      try { value = JSON.parse(event.data); } catch { return null; }
      if (value?.protocol !== 'cd-transfer-v1') return null;
      if (value.type === 'peer-left') throw new Error('The receiver left.');
      return value.type === type ? true : null;
    }, `Timed out waiting for ${type}.`);
  }

  function waitForRecord(opener, kinds, timeoutMs) {
    return pump('record', timeoutMs, async (event) => {
      if (typeof event.data === 'string') {
        let value;
        try { value = JSON.parse(event.data); } catch { return null; }
        if (value?.type === 'peer-left') throw new Error('The receiver left.');
        return null;
      }
      const { kind, plaintext } = await opener.open(event.data);
      if (!kinds.includes(kind)) throw new Error('The receiver sent a message out of order.');
      return { kind, plaintext };
    }, 'The receiver stopped responding.');
  }

  function decodeCounts(value) {
    if (value.byteLength !== 12) throw new Error('The receiver sent invalid progress.');
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return { chunks: view.getUint32(0), bytes: BigInt(view.getBigUint64(4)) };
  }

  function encodeCounts(chunks, bytes) {
    const value = new Uint8Array(12);
    const view = new DataView(value.buffer);
    view.setUint32(0, chunks);
    view.setBigUint64(4, bytes);
    return value;
  }

  async function sendFile(file) {
    cancelled = false;
    // Fresh socket per send: drop any state from a previous transfer.
    incoming.length = 0;
    waiters.length = 0;
    pumpAttached = null;
    els.dropZone?.classList.add('hidden');
    els.pickBtn.disabled = true;
    els.cancelBtn.hidden = false;
    els.againBtn.hidden = true;
    els.fileLine.textContent = `${file.name} · ${formatSize(file.size)}`;
    reportState('connecting');

    const id = crypto.getRandomValues(new Uint8Array(16));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const invitation = { id, key };
    const [{ digest }] = await Promise.all([receiverAdmission(invitation)]);
    const encodedId = encodeBase64Url(id);
    const encodedKey = encodeBase64Url(key);
    shareUrl = `${window.location.origin}/s/${encodedId}#v1.${encodedKey}`;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/v1/${encodedId}`);
    socket.binaryType = 'arraybuffer';

    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not reach the CD relay. Check your connection and try again.')), ADMISSION_WAIT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not reach the CD relay. Check your connection and try again.'));
      }, { once: true });
    });
    window.addEventListener('pagehide', () => {
      try { socket?.close(1000, 'sender left'); } catch { /* Best effort. */ }
    }, { once: true });

    try {
      await opened;
      if (cancelled) return;
      socket.send(JSON.stringify({
        type: 'join', protocol: 'cd-transfer-v1', role: 'sender',
        receiverTokenHash: encodeBase64Url(digest)
      }));
      await waitForText('accepted', ADMISSION_WAIT_MS);
      if (cancelled) return;

      shareCode = await claimShareCode(encodedId, encodedKey);
      if (cancelled) return;

    els.shareBox.hidden = false;
    els.shareCode.textContent = shareCode;
    els.shareLink.textContent = shareUrl;
    els.receiveCommand.textContent = `cd receive ${shareCode}`;
    setStatus('Waiting for the receiver (up to 15 minutes)...');
    reportState('waiting');
    await waitForText('peer-joined', PEER_WAIT_MS);
    if (cancelled) return;

      const [sealer, opener] = await Promise.all([
        createSealer(invitation, SENDER_DIRECTION),
        createOpener(invitation, RECEIVER_DIRECTION)
      ]);
      const send = async (kind, payload = new Uint8Array()) => {
        socket.send(await sealer.seal(kind, payload));
      };

      setStatus('Receiver connected — sending file offer...');
    reportState('connecting');
      await send(KIND_OFFER, encoder.encode(JSON.stringify({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: String(file.size),
        chunkSize: CHUNK_SIZE
      })));
      await waitForRecord(opener, [KIND_ACCEPT], CONSENT_WAIT_MS);
      if (cancelled) return;

      setStatus('Receiver accepted — sending file...');
    reportState('transferring');
      let sent = 0n;
      let acknowledged = 0n;
      let chunks = 0;
      let offset = 0;
      // Prefetch one chunk ahead: disk reads overlap with crypto + socket
      // writes instead of serializing all three per 256 KiB.
      let nextChunk = offset < file.size
        ? file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer()
        : null;
      while (offset < file.size) {
        if (cancelled) return;
        const chunk = new Uint8Array(await nextChunk);
        offset += chunk.byteLength;
        nextChunk = offset < file.size
          ? file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer()
          : null;
        await send(KIND_CHUNK, chunk);
        sent += BigInt(chunk.byteLength);
        chunks += 1;
        paintProgress(sent, BigInt(file.size));
        while (sent - acknowledged >= BigInt(SEND_WINDOW_BYTES) || sent === BigInt(file.size)) {
          const { plaintext } = await waitForRecord(opener, [KIND_ACK], TRANSFER_IDLE_MS);
          const ack = decodeCounts(plaintext);
          if (ack.chunks > chunks || ack.bytes < acknowledged || ack.bytes > sent) {
            throw new Error('The receiver sent invalid progress.');
          }
          acknowledged = ack.bytes;
          paintProgress(acknowledged > sent ? sent : acknowledged, BigInt(file.size));
          if (acknowledged >= sent) break;
        }
      }
      if (sent !== BigInt(file.size)) throw new Error('The file changed while it was being sent.');
      paintProgress(sent, BigInt(file.size));

      await send(KIND_END, encodeCounts(chunks, sent));
      const { plaintext } = await waitForRecord(opener, [KIND_COMPLETE], TRANSFER_IDLE_MS);
      const done = decodeCounts(plaintext);
      if (done.bytes !== sent || done.chunks !== chunks) throw new Error('The receiver did not verify the transfer.');
    paintProgress(sent, BigInt(file.size));
    setStatus('Receiver verified the file.');
    reportState('complete');
    els.cancelBtn.hidden = true;
      els.againBtn.hidden = false;
      socket.close(1000, 'complete');
    } catch (error) {
      if (!cancelled) fail(error instanceof Error ? error.message : 'The transfer failed.');
    }
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
    if (file) void sendFile(file);
  });
  els.cancelBtn.addEventListener('click', () => {
    cancelled = true;
    try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
    setStatus('Transfer canceled.');
    reportState('idle');
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.dropZone?.classList.remove('hidden');
    els.cancelBtn.hidden = true;
    els.pickBtn.disabled = false;
    els.againBtn.hidden = false;
  });
  els.againBtn.addEventListener('click', () => {
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.dropZone?.classList.remove('hidden');
    els.fileInput.value = '';
    els.fileLine.textContent = 'No file chosen yet.';
    els.pickBtn.disabled = false;
    els.againBtn.hidden = true;
    reportState('idle');
    setStatus('');
  });
  els.copyLinkBtn.addEventListener('click', () => void copyText(shareUrl, els.copyLinkBtn));
  els.copyCodeBtn.addEventListener('click', () => void copyText(shareCode, els.copyCodeBtn));
  els.copyCmdBtn.addEventListener('click', () => {
    void copyText(`cd receive ${shareCode}`, els.copyCmdBtn);
  });

  return { sendFile };
}
