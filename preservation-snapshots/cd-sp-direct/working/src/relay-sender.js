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
import { isShortCode } from './agent-code.js';
import { fileSource, rechunk } from './zip-bundle.js';
import { SendWindow } from './send-window.js';
import { DIRECT_MIN_BYTES, createRecordMerger, offerDirect } from './direct-link.js';

// Browser relay sender: mints a numeric share code plus a share link and
// streams one byte source with the same encrypted records `cdx send` uses,
// so `cdx receive <code>` or any browser Receive box can take it.
// startRelaySend is the engine (used by the main page); mountRelaySender
// wires it to the standalone `/send` page.

const CHUNK_SIZE = 256 * 1024;
const PREPARED_CHUNKS = 3;
const ADMISSION_WAIT_MS = 10_000;
const PEER_WAIT_MS = 15 * 60_000;
const CONSENT_WAIT_MS = 10 * 60_000;
const TRANSFER_IDLE_MS = 90_000;
// A signal record holds one SDP answer (at most 64 KiB) or one candidate.
const MAX_SIGNAL_BYTES = 80 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export class RelaySendError extends Error {}

// startRelaySend sends source ({ name, type, size, stream() }) and reports
// through hooks: onShare({ code, url }), onState(state), onStatus(text),
// onProgress(done, total), onRoute('relay' | 'direct') when file data starts
// on the relay and when it moves to a direct connection. It resolves when the
// receiver verified every byte and rejects with the reason otherwise.
// cancel() stops it. `direct: false` never offers a direct connection, which
// would show the receiver this device's network addresses.
export function startRelaySend(source, hooks = {}) {
  const onShare = hooks.onShare || (() => {});
  const onState = hooks.onState || (() => {});
  const onStatus = hooks.onStatus || (() => {});
  const onProgress = hooks.onProgress || (() => {});
  const onRoute = hooks.onRoute || (() => {});
  let socket = null;
  let cancelled = false;
  let sendWindow = null;
  // Set when END is queued: no sender signal record may follow it.
  let ending = false;

  // Single persistent pump: every socket message is buffered exactly once and
  // handed to waiters in arrival order. Attaching a fresh message listener per
  // wait (instead of this pump) drops records that arrive while a chunk is
  // being sealed or sent, which stalls multi-megabyte transfers.
  const incoming = [];
  const waiters = [];
  let closedError = null;

  function arrive(event) {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else incoming.push(event);
  }

  function stopPump(error) {
    if (closedError) return;
    closedError = error;
    for (const waiter of waiters.splice(0)) waiter(null);
  }

  // Receiver records arrive on the relay and, once it opens, the direct
  // path; the merger restores sequence order and drops the second copy of
  // records the receiver re-sends on the direct path when it switches.
  const merger = createRecordMerger();
  function receiveRecord(data, arrivedAt) {
    let ordered;
    try {
      ordered = merger.push(data);
    } catch {
      stopPump(new RelaySendError('The receiver sent records out of order.'));
      return;
    }
    for (const record of ordered) arrive({ data: record, arrivedAt });
  }

  function attachPump() {
    socket.addEventListener('message', (message) => {
      const arrivedAt = performance.now();
      if (typeof message.data === 'string') arrive({ data: message.data, arrivedAt });
      else receiveRecord(message.data, arrivedAt);
    });
    socket.addEventListener('close', (event) => {
      // Once the direct path carries the transfer, the relay is optional.
      if (directUsed) return;
      stopPump(new RelaySendError(event.code === 4408
        ? 'The code expired before anyone used it. Send again for a fresh code.'
        : 'Lost the connection to CD. Check your network and try again.'));
    });
  }

  // The direct path (see direct-link.js): offered in the file offer, moved
  // to once it opens. directUsed is set once a record crossed it in either
  // direction; from then on losing it is fatal (receivers fail too) and
  // losing the relay is not.
  let directOffer = null;
  let direct = null;
  let directUsed = false;
  let switching = null;
  // Records sent on the relay while the direct path may still open, until
  // the receiver acknowledges them: release is the acknowledged byte count
  // that covers a CHUNK, Infinity for control records. They go out again on
  // the direct path when it opens, so the transfer never waits for the relay
  // to drain; the receiver drops second copies (cmd/cdx/link.go).
  let retained = [];

  function startDirect(sendSignal) {
    directOffer = offerDirect({
      onRecord(record) {
        directUsed = true;
        receiveRecord(record, performance.now());
      },
      onCandidate(candidate) {
        if (!ending) sendSignal({ candidate });
      },
      // Move over as soon as the channel opens, even while the send window
      // waits for acknowledgements a slow relay has yet to deliver.
      onOpen() {
        if (direct && !switching) void switchToDirect().catch(() => {});
      },
      onLost() {
        if (directUsed) stopPump(new RelaySendError('The direct connection was lost. Send again for a fresh code.'));
        else dropDirect();
      }
    }).then((path) => {
      if (directOffer === null) path.close();
      else direct = path;
      return direct;
    }, () => null);
  }

  // dropDirect closes the direct path. Before it carried data the transfer
  // just stays on the relay.
  function dropDirect() {
    const offer = directOffer;
    directOffer = null;
    direct = null;
    retained = [];
    void offer?.then((path) => path?.close());
  }

  // handleSignal applies the receiver's direct-path answer and candidates.
  // Anything malformed leaves the transfer on the relay.
  async function handleSignal(plaintext) {
    if (!direct || plaintext.byteLength > MAX_SIGNAL_BYTES) return;
    let value;
    try { value = JSON.parse(decoder.decode(plaintext)); } catch { return; }
    await direct?.signal(value);
  }

  // switchToDirect moves sending to the direct path. The retained records
  // are queued on it at once, in order, ahead of any later record.
  function switchToDirect() {
    if (!switching) {
      directUsed = true;
      onRoute('direct');
      switching = Promise.all(retained.splice(0).map((entry) => direct.send(entry.record)));
    }
    return switching;
  }

  // transmit sends one sealed record, in sequence order: on the direct path
  // once it is open, else on the relay.
  async function transmit(record, release) {
    if (direct && (switching || direct.open)) {
      try {
        await Promise.all([switchToDirect(), direct.send(record)]);
      } catch {
        throw new RelaySendError('The direct connection was lost. Send again for a fresh code.');
      }
      return;
    }
    if (direct && !direct.lost) retained.push({ record, release });
    socket.send(record);
  }

  // releaseRetained drops retained records the receiver has acknowledged.
  function releaseRetained(acknowledged) {
    if (retained.length > 0) retained = retained.filter((entry) => entry.release > acknowledged);
  }

  function pump(timeoutMs, handle, timeoutMessage) {
    return new Promise((resolve, reject) => {
      if (cancelled) {
        reject(new RelaySendError('Transfer canceled.'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = waiters.indexOf(entry);
        if (index !== -1) waiters.splice(index, 1);
        reject(new RelaySendError(timeoutMessage));
      }, timeoutMs);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const entry = (event) => {
        if (event === null) {
          finish(cancelled ? new RelaySendError('Transfer canceled.') : closedError);
          return;
        }
        void Promise.resolve()
          .then(() => handle(event))
          .then((result) => {
            if (result === null || result === undefined) {
              // Not what this wait wanted; keep waiting for the next message.
              if (!settled) {
                if (incoming.length > 0) entry(incoming.shift());
                else if (closedError) entry(null);
                else waiters.push(entry);
              }
              return;
            }
            finish(null, result);
          })
          .catch((error) => finish(error));
      };
      if (incoming.length > 0) entry(incoming.shift());
      else if (closedError) entry(null);
      else waiters.push(entry);
    });
  }

  function waitForText(type, timeoutMs, timeoutMessage) {
    return pump(timeoutMs, (event) => {
      if (typeof event.data !== 'string') return null;
      let value;
      try { value = JSON.parse(event.data); } catch { return null; }
      if (value?.protocol !== 'cd-transfer-v1') return null;
      if (value.type === 'peer-left') throw new RelaySendError('The receiver left.');
      return value.type === type ? value : null;
    }, timeoutMessage);
  }

  function waitForRecord(opener, kinds, timeoutMs, timeoutMessage) {
    return pump(timeoutMs, async (event) => {
      if (typeof event.data === 'string') {
        let value;
        try { value = JSON.parse(event.data); } catch { return null; }
        // Once the direct path carries the transfer, the relay is optional.
        if (value?.type === 'peer-left' && !directUsed) throw new RelaySendError('The receiver left.');
        return null;
      }
      const { kind, plaintext } = await opener.open(event.data);
      if (kind === KIND_SIGNAL) {
        await handleSignal(plaintext);
        return null;
      }
      if (!kinds.includes(kind)) throw new RelaySendError('The receiver sent a message out of order.');
      return { kind, plaintext, arrivedAt: event.arrivedAt };
    }, timeoutMessage);
  }

  function decodeCounts(value) {
    if (value.byteLength !== 12) throw new RelaySendError('The receiver sent invalid progress.');
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

  const onPageHide = () => {
    try { socket?.close(1000, 'sender left'); } catch { /* Best effort. */ }
  };

  async function run() {
    onState('connecting');
    onStatus('Getting a code...');
    const id = crypto.getRandomValues(new Uint8Array(16));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const invitation = { id, key };
    const { digest } = await receiverAdmission(invitation);
    const encodedId = encodeBase64Url(id);
    const encodedKey = encodeBase64Url(key);
    const shareUrl = `${window.location.origin}/s/${encodedId}#v1.${encodedKey}`;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/v1/${encodedId}`);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const unreachable = () => reject(new RelaySendError('Could not reach CD. Check your connection and try again.'));
      const timer = setTimeout(unreachable, ADMISSION_WAIT_MS);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); unreachable(); }, { once: true });
    });
    attachPump();
    window.addEventListener('pagehide', onPageHide, { once: true });
    if (cancelled) throw new RelaySendError('Transfer canceled.');

    // shareKey asks the relay to claim the share code during the join.
    socket.send(JSON.stringify({
      type: 'join', protocol: 'cd-transfer-v1', role: 'sender',
      receiverTokenHash: encodeBase64Url(digest), shareKey: encodedKey
    }));
    const accepted = await waitForText('accepted', ADMISSION_WAIT_MS, 'CD did not answer. Check your connection and try again.');
    // Relays that predate join-time codes: claim one separately.
    const code = isShortCode(accepted.code) ? accepted.code : await claimShareCode(encodedId, encodedKey);
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    onShare({ code, url: shareUrl });
    onState('waiting');
    onStatus('Waiting for the receiver. The code works for 15 minutes.');
    // Gather direct-path candidates while waiting for the receiver.
    if (hooks.direct !== false && source.size >= DIRECT_MIN_BYTES && typeof RTCPeerConnection === 'function') {
      // Candidates are trickled only after the receiver's answer, which
      // follows the offer: `send` exists by then.
      startDirect((signal) => { void send(KIND_SIGNAL, encoder.encode(JSON.stringify(signal))).catch(() => {}); });
    }
    await waitForText('peer-joined', PEER_WAIT_MS, 'Nobody used the code within 15 minutes. Send again for a fresh code.');

    const [sealer, opener] = await Promise.all([
      createSealer(invitation, SENDER_DIRECTION),
      createOpener(invitation, RECEIVER_DIRECTION)
    ]);
    let seals = Promise.resolve();
    let sends = Promise.resolve();
    const send = (kind, payload = new Uint8Array()) => {
      // Encryption and transport have separate ordered queues. A few chunks
      // can be read and sealed while the transport waits for window space,
      // without concurrent seal calls reusing the sealer's sequence/nonce.
      const record = seals.then(() => {
        if (cancelled) throw new RelaySendError('Transfer canceled.');
        if (sendWindow?.error) throw sendWindow.error;
        return sealer.seal(kind, payload);
      });
      seals = record;
      sends = sends.then(async () => {
        const sealed = await record;
        let release = Infinity;
        if (kind === KIND_CHUNK) {
          // Only the relay's queue counts here: the direct path waits for
          // its own channel queue in transmit.
          await sendWindow.waitForSpace(sealed.byteLength, () => socket.bufferedAmount);
          sendWindow.recordSent(payload.byteLength, sealed.byteLength, performance.now());
          release = sendWindow.sent;
        }
        if (cancelled) throw new RelaySendError('Transfer canceled.');
        await transmit(sealed, release);
      });
      void record.catch(() => {});
      void sends.catch(() => {});
      return sends;
    };

    onState('connecting');
    onStatus('Receiver connected. Waiting for them to accept...');
    // The offer carries the direct path's SDP; `trickle` lets receivers
    // that know it take candidates found later (direct-link.js).
    let directSdp = null;
    if (directOffer) {
      directSdp = await directOffer.then((path) => path?.description()).catch(() => null);
      if (!directSdp) dropDirect();
    }
    await send(KIND_OFFER, encoder.encode(JSON.stringify({
      name: source.name,
      mediaType: source.type || 'application/octet-stream',
      size: String(source.size),
      chunkSize: CHUNK_SIZE,
      ...(directSdp ? { direct: { sdp: directSdp, trickle: true } } : {}),
      ...(source.bundle ? { bundle: true, files: source.files } : {})
    })));
    await waitForRecord(opener, [KIND_ACCEPT], CONSENT_WAIT_MS, 'The receiver did not accept within 10 minutes.');

    onState('transferring');
    onStatus('Sending...');
    if (!switching) onRoute('relay');
    const total = BigInt(source.size);
    sendWindow = new SendWindow();
    onProgress(0, source.size);
    // This is the only reader after ACCEPT. Decrypt in order, but use the
    // pump's arrival time rather than time spent waiting on crypto/UI work.
    const complete = (async () => {
      while (true) {
        const { kind, plaintext, arrivedAt } = await waitForRecord(opener, [KIND_ACK, KIND_COMPLETE], TRANSFER_IDLE_MS, 'The transfer stalled: no progress for 90 seconds.');
        const counts = decodeCounts(plaintext);
        if (kind === KIND_COMPLETE) {
          if (!ending || counts.bytes !== sendWindow.sent || counts.chunks !== sendWindow.chunks) {
            throw new RelaySendError('The receiver did not verify the transfer.');
          }
          return;
        }
        try { sendWindow.acknowledge(counts, arrivedAt); }
        catch (error) { throw new RelaySendError(error.message); }
        releaseRetained(sendWindow.acknowledged);
        onProgress(Number(sendWindow.acknowledged), source.size);
      }
    })();
    void complete.catch((error) => sendWindow.fail(error));

    const transfer = (async () => {
      const pending = [];
      let read = 0n;
      for await (const chunk of rechunk(source.stream(), CHUNK_SIZE)) {
        if (sendWindow.error) throw sendWindow.error;
        read += BigInt(chunk.byteLength);
        if (read > total) throw new RelaySendError('A file changed while it was being sent.');
        pending.push(send(KIND_CHUNK, chunk));
        if (pending.length >= PREPARED_CHUNKS) await pending.shift();
      }
      await Promise.all(pending);
      if (read !== total) throw new RelaySendError('A file changed while it was being sent.');
      await sendWindow.waitForAcknowledged();
      ending = true;
      await send(KIND_END, encodeCounts(sendWindow.chunks, sendWindow.sent));
      await complete;
    })();
    await Promise.race([transfer, sendWindow.failed]);
    onProgress(source.size, source.size);
    onState('complete');
    onStatus('The receiver has every byte.');
    window.removeEventListener('pagehide', onPageHide);
    // Closing the direct path tells a waiting `cdx receive` that COMPLETE
    // arrived (cmd/cdx/link.go finish).
    dropDirect();
    socket.close(1000, 'complete');
  }

  const done = run().catch((error) => {
    window.removeEventListener('pagehide', onPageHide);
    dropDirect();
    sendWindow?.fail(error);
    try { socket?.close(cancelled ? 1000 : 4400, cancelled ? 'sender canceled' : 'sender failed'); } catch { /* Best effort. */ }
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    throw error instanceof RelaySendError ? error : new RelaySendError('The transfer failed. Try again.');
  });

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      sendWindow?.fail(new RelaySendError('Transfer canceled.'));
      dropDirect();
      try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
      for (const waiter of waiters.splice(0)) waiter(null);
    }
  };
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
    active = startRelaySend(fileSource(file), {
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
