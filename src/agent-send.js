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
import './style.css';

// Browser sender for the agent relay: picks one file, mints a share link,
// and streams it with the same encrypted records `cdx send` uses, so
// `cdx receive <link>` (or another browser on the share page) can take it.

const CHUNK_SIZE = 64 * 1024;
const SEND_WINDOW_BYTES = 1024 * 1024;
const ADMISSION_WAIT_MS = 10_000;
const PEER_WAIT_MS = 15 * 60_000;
const CONSENT_WAIT_MS = 10 * 60_000;
const TRANSFER_IDLE_MS = 45_000;

const encoder = new TextEncoder();

document.body.innerHTML = `
  <canvas id="ambient-dots" class="ambient-dots" aria-hidden="true"></canvas>
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><span class="tagline">/di·rect/</span></div>
      <p class="brand-note">send to a terminal</p>
      <p class="share-description">Pick a file to hand it to <code>cdx receive</code> or another browser.</p>
    </header>
    <section class="workbench">
      <div class="share-panel">
        <span class="panel-kicker">terminal send</span>
        <div id="pick-row">
          <input id="file-input" type="file" hidden />
          <button id="pick-btn" class="primary-btn" type="button">Choose a file</button>
        </div>
        <p id="file-line" class="status" role="status">No file chosen yet.</p>
        <div id="share-box" class="terminal-share" hidden>
          <span class="panel-kicker">share this code</span>
          <strong id="share-code"></strong>
          <p class="code-help">On the other device, choose Receive and enter this code — or run the command below in a terminal.</p>
          <code id="receive-command"></code>
          <div class="result-actions">
            <button id="copy-code-btn" class="secondary-btn" type="button">Copy code</button>
            <button id="copy-cmd-btn" class="secondary-btn" type="button">Copy receive command</button>
          </div>
          <span class="panel-kicker">or share the link</span>
          <strong id="share-link"></strong>
          <div class="result-actions">
            <button id="copy-link-btn" class="secondary-btn" type="button">Copy link</button>
          </div>
        </div>
        <div id="send-progress" class="agent-progress" hidden>
          <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="progress-fill"></div>
          </div>
          <span id="progress-copy">0%</span>
        </div>
        <p id="status" class="status" role="status"></p>
        <div class="result-actions">
          <button id="cancel-btn" class="secondary-btn" type="button" hidden>Cancel</button>
          <button id="again-btn" class="primary-btn" type="button" hidden>Send another file</button>
        </div>
      </div>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;

const elements = {
  fileInput: document.getElementById('file-input'),
  pickBtn: document.getElementById('pick-btn'),
  fileLine: document.getElementById('file-line'),
  shareBox: document.getElementById('share-box'),
  shareCode: document.getElementById('share-code'),
  shareLink: document.getElementById('share-link'),
  receiveCommand: document.getElementById('receive-command'),
  copyCodeBtn: document.getElementById('copy-code-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  copyCmdBtn: document.getElementById('copy-cmd-btn'),
  progress: document.getElementById('send-progress'),
  progressBar: document.querySelector('#send-progress .progress-bar'),
  progressFill: document.querySelector('#send-progress .progress-fill'),
  progressCopy: document.getElementById('progress-copy'),
  status: document.getElementById('status'),
  cancelBtn: document.getElementById('cancel-btn'),
  againBtn: document.getElementById('again-btn')
};

try {
  const mark = document.querySelector('.share-transfer-page .watermark a');
  if (mark) mark.textContent = window.location.host;
} catch { /* cosmetic only */ }

let socket = null;
let cancelled = false;
let shareUrl = '';
let shareCode = '';

// Short codes come from the relay directory: typable in any browser Receive
// box or `cdx receive`. The directory holds the transfer key, so code mode
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

function setStatus(text) {
  elements.status.textContent = text;
}

function paintProgress(sent, total) {
  const percent = total === 0n ? 100 : Math.min(Number(sent * 1000n / total) / 10, 100);
  elements.progress.hidden = false;
  elements.progressFill.style.transform = `scaleX(${percent / 100})`;
  elements.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
  elements.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(sent)} / ${formatSize(total)}`;
}

function fail(message) {
  if (cancelled) return;
  cancelled = true;
  try { socket?.close(4400, 'sender failed'); } catch { /* Best effort. */ }
  setStatus(message);
  elements.cancelBtn.hidden = true;
  elements.againBtn.hidden = false;
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

// Single persistent pump: every socket message is buffered exactly once and
// handed to waiters in arrival order. Attaching a fresh message listener per
// wait (instead of this pump) drops records that arrive while a chunk is
// being sealed or sent, which stalls multi-megabyte transfers.
const incoming = [];
const waiters = [];
let pumpAttached = null;

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
  elements.pickBtn.disabled = true;
  elements.cancelBtn.hidden = false;
  elements.againBtn.hidden = true;
  elements.fileLine.textContent = `${file.name} · ${formatSize(file.size)}`;

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

    elements.shareBox.hidden = false;
    elements.shareCode.textContent = shareCode;
    elements.shareLink.textContent = shareUrl;
    elements.receiveCommand.textContent = `cdx receive ${shareCode}`;
    setStatus('Waiting for the receiver (up to 15 minutes)...');
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
    await send(KIND_OFFER, encoder.encode(JSON.stringify({
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      size: String(file.size),
      chunkSize: CHUNK_SIZE
    })));
    await waitForRecord(opener, [KIND_ACCEPT], CONSENT_WAIT_MS);
    if (cancelled) return;

    setStatus('Receiver accepted — sending file...');
    let sent = 0n;
    let acknowledged = 0n;
    let chunks = 0;
    let offset = 0;
    while (offset < file.size) {
      if (cancelled) return;
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      offset = end;
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
    elements.cancelBtn.hidden = true;
    elements.againBtn.hidden = false;
    socket.close(1000, 'complete');
  } catch (error) {
    if (!cancelled) fail(error instanceof Error ? error.message : 'The transfer failed.');
  }
}

elements.pickBtn.addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', () => {
  const file = elements.fileInput.files?.[0];
  if (file) void sendFile(file);
});
elements.cancelBtn.addEventListener('click', () => {
  cancelled = true;
  try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
  setStatus('Transfer canceled.');
  elements.cancelBtn.hidden = true;
  elements.pickBtn.disabled = false;
  elements.againBtn.hidden = false;
});
elements.againBtn.addEventListener('click', () => {
  elements.shareBox.hidden = true;
  elements.progress.hidden = true;
  elements.fileInput.value = '';
  elements.fileLine.textContent = 'No file chosen yet.';
  elements.pickBtn.disabled = false;
  elements.againBtn.hidden = true;
  setStatus('');
});

async function copyText(text, button) {
  const original = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1400);
}
elements.copyLinkBtn.addEventListener('click', () => void copyText(shareUrl, elements.copyLinkBtn));
elements.copyCodeBtn.addEventListener('click', () => void copyText(shareCode, elements.copyCodeBtn));
elements.copyCmdBtn.addEventListener('click', () => {
  void copyText(`cdx receive ${shareCode}`, elements.copyCmdBtn);
});
