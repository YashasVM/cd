import {
  KIND_ACCEPT,
  KIND_ACK,
  KIND_CHUNK,
  KIND_COMPLETE,
  KIND_END,
  KIND_OFFER,
  KIND_SIGNAL,
  MAX_RECORD_BYTES,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  encodeBase64Url,
  parseInvitation,
  receiverAdmission
} from './agent-protocol.js';
import { createSink as createDownloadSink } from './sink.js';
import { answerDirect, createRecordMerger, parseDirectOffer } from './direct-link.js';

const ACK_INTERVAL = 1024n * 1024n;
// Match the relay's 32 MiB peer buffer: queue more undecrypted/unwritten
// bytes before failing, so slow OPFS/disk on big files doesn't abort.
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

const PANEL_HTML = `
  <span class="panel-kicker">incoming transfer</span>
  <p class="status" role="status" data-relay="status">Connecting securely...</p>
  <div class="agent-offer" data-relay="offer" hidden>
    <strong data-relay="file-name"></strong>
    <span data-relay="file-size"></span>
    <button class="primary-btn" type="button" data-relay="accept">Receive file</button>
  </div>
  <div class="agent-progress" data-relay="progress" hidden>
    <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="progress-fill"></div>
    </div>
    <span data-relay="progress-copy">0%</span>
  </div>
  <a class="primary-btn share-download" data-relay="download" hidden>Download file</a>`;

function formatSize(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function parseOffer(plaintext) {
  let value;
  try { value = JSON.parse(decoder.decode(plaintext)); } catch { throw new Error('The sender offered invalid file details.'); }
  if (!value || typeof value !== 'object') throw new Error('The sender offered invalid file details.');
  const { name, mediaType, size, chunkSize } = value;
  if (typeof name !== 'string' || new TextEncoder().encode(name).byteLength > 255 || name.length === 0 || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('The sender offered an unsafe filename.');
  }
  if (typeof mediaType !== 'string' || mediaType.length > 127 || !/^[\x20-\x7e]+$/.test(mediaType)) throw new Error('The sender offered an invalid file type.');
  if (typeof size !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(size)) throw new Error('The sender offered an invalid file size.');
  const byteSize = BigInt(size);
  if (byteSize > 0xffffffffffffffffn || (chunkSize !== 64 * 1024 && chunkSize !== 256 * 1024)) throw new Error('The sender uses unsupported transfer limits.');
  return { name, mediaType, size: byteSize, directSdp: parseDirectOffer(value) };
}

function encodeCounts(chunks, bytes) {
  const value = new Uint8Array(12);
  const view = new DataView(value.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, bytes);
  return value;
}

function decodeCounts(value) {
  if (value.byteLength !== 12) throw new Error('The sender sent invalid completion details.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4) };
}

// Renders the relay receiver into `container` and starts receiving the
// `/s/<id>#v1.<key>` link. Used by the standalone share page and inline by
// the main page's Receive tab. Returns a function that leaves the transfer.
export function mountRelayReceiver(container, shareUrl) {
  container.classList.add('share-panel');
  container.innerHTML = PANEL_HTML;
  const pick = (name) => container.querySelector(`[data-relay="${name}"]`);
  const elements = {
    status: pick('status'),
    offer: pick('offer'),
    fileName: pick('file-name'),
    fileSize: pick('file-size'),
    accept: pick('accept'),
    progress: pick('progress'),
    progressBar: pick('progress').querySelector('.progress-bar'),
    progressFill: pick('progress').querySelector('.progress-fill'),
    progressCopy: pick('progress-copy'),
    download: pick('download')
  };
  let failureShown = false;
  // Leaving before the socket exists must still stop receive() from joining.
  let stopped = false;
  let stop = () => { stopped = true; failureShown = true; };

  async function createSink(offer) {
    return createDownloadSink({ name: offer.name, size: offer.size, mediaType: offer.mediaType });
  }

  function waitForAcceptance(offer) {
    elements.fileName.textContent = offer.name;
    elements.fileSize.textContent = formatSize(offer.size);
    elements.offer.hidden = false;
    elements.status.textContent = 'Ready when you are. The file stays with the sender until you accept.';
    return new Promise((resolve, reject) => {
      elements.accept.addEventListener('click', async () => {
        elements.accept.disabled = true;
        try { resolve(await createSink(offer)); }
        catch (error) {
          elements.accept.disabled = false;
          if (error?.name === 'AbortError') return;
          reject(error);
        }
      });
    });
  }

  // Progress arrives per 64 KiB chunk; repainting the DOM that often janks the
  // page on fast links. Coalesce to ~10fps via rAF, with forced final paints.
  const PROGRESS_RENDER_MS = 100;
  let lastProgressPaint = 0;
  let progressQueued = false;
  let pendingProgress = null;

  function paintProgress(received, total) {
    const percent = total === 0n ? 100 : Math.min(Number(received * 1000n / total) / 10, 100);
    elements.progress.hidden = false;
    elements.progressFill.style.transform = `scaleX(${percent / 100})`;
    elements.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
    elements.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(received)} / ${formatSize(total)}`;
  }

  function renderProgress(received, total, force = false) {
    const now = performance.now();
    if (!force && now - lastProgressPaint < PROGRESS_RENDER_MS) {
      pendingProgress = { received, total };
      if (!progressQueued) {
        progressQueued = true;
        requestAnimationFrame(() => {
          progressQueued = false;
          if (pendingProgress && !failureShown) {
            const { received: r, total: t } = pendingProgress;
            pendingProgress = null;
            paintProgress(r, t);
            lastProgressPaint = performance.now();
          }
        });
      }
      return;
    }
    pendingProgress = null;
    paintProgress(received, total);
    lastProgressPaint = now;
  }

  let closeDirect = () => {};

  function fail(error, socket, sink) {
    if (failureShown) return;
    failureShown = true;
    closeDirect();
    if (sink) void sink.abort().catch(() => {});
    if (socket?.readyState === WebSocket.OPEN) socket.close(4400, 'receiver failed');
    elements.offer.hidden = true;
    elements.progress.hidden = true;
    elements.status.textContent = error instanceof Error ? error.message : 'The transfer failed.';
  }

  function closeReasonMessage(event) {
    switch (event?.code) {
      case 4401:
        return 'This CD link key does not match. Ask the sender for a fresh link.';
      case 4404:
        return 'The sender is no longer available.';
      case 4408:
        return 'This CD link has expired. Ask the sender for a fresh link.';
      case 4409:
        return 'This CD link is already claimed or expired. Ask the sender for a fresh link.';
      default:
        return 'The sender is no longer available.';
    }
  }

  async function receive() {
    const invitation = parseInvitation(new URL(shareUrl, window.location.href));
    const [{ token }, opener, sealer] = await Promise.all([
      receiverAdmission(invitation),
      createOpener(invitation, SENDER_DIRECTION),
      createSealer(invitation, RECEIVER_DIRECTION)
    ]);
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/v1/${encodeBase64Url(invitation.id)}`);
    socket.binaryType = 'arraybuffer';
    let state = 'connecting';
    let offer;
    let sink;
    let received = 0n;
    let acknowledged = 0n;
    let chunks = 0;
    let pendingBytes = 0;
    let queue = Promise.resolve();
    // Records from the relay and the direct path, in sequence order.
    const merger = createRecordMerger();
    let direct = null;
    let directUsed = false;
    // Records sent on the relay while the direct path may still open; they
    // go out again on it when it does (the sender drops second copies).
    let retained = [];
    let switched = false;
    let sendChain = Promise.resolve();

    // Sealing is async and sequence-numbered, so sends run on one chain.
    function send(kind, payload = new Uint8Array()) {
      sendChain = sendChain.catch(() => {}).then(async () => {
        const record = await sealer.seal(kind, payload);
        if (direct?.open) {
          directUsed = true;
          if (!switched) {
            switched = true;
            for (const earlier of retained.splice(0)) direct.send(earlier);
          }
          direct.send(record);
          return;
        }
        if (direct && !switched) retained.push(record);
        socket.send(record);
      });
      return sendChain;
    }

    function enqueueRecords(records, size) {
      pendingBytes += size;
      if (pendingBytes > MAX_PENDING_BYTES + MAX_RECORD_BYTES) {
        fail(new Error('The sender exceeded the safe receive buffer.'), socket, sink);
        return;
      }
      let ordered;
      try {
        ordered = merger.push(records);
      } catch (error) {
        fail(error, socket, sink);
        return;
      }
      if (ordered.length === 0) {
        pendingBytes -= size;
        return;
      }
      queue = queue.then(async () => {
        for (const record of ordered) await processMessage(record);
      }).finally(() => { pendingBytes -= size; });
      queue.catch((error) => fail(error, socket, sink));
    }

    // startDirect answers the sender's direct-path offer in the background;
    // the transfer starts on the relay and moves over when the channel opens.
    function startDirect(offerSdp) {
      answerDirect({
        offerSdp,
        onSignal: (signal) => { void send(KIND_SIGNAL, new TextEncoder().encode(JSON.stringify(signal))).catch(() => {}); },
        onRecord: (record) => {
          directUsed = true;
          enqueueRecords(record, record.byteLength);
        },
        onOpen: () => {},
        onLost: (error) => {
          if (directUsed && state !== 'complete') fail(error, socket, sink);
        }
      }).then((path) => {
        direct = path;
        closeDirect = () => path.close();
      }).catch(() => { /* The transfer stays on the relay. */ });
    }

    async function processMessage(data) {
      if (typeof data === 'string') {
        const value = JSON.parse(data);
        if (value.protocol !== 'cd-transfer-v1') throw new Error('The sender uses an incompatible CD version.');
        // Once the direct path carries the transfer, the relay is optional.
        if (value.type === 'peer-left' && !directUsed) throw new Error('The sender is no longer available.');
        if (value.type === 'accepted') elements.status.textContent = 'Connected. Waiting for file details...';
        return;
      }
      const { kind, plaintext } = await opener.open(data);
      if (state === 'connecting' && kind === KIND_OFFER) {
        offer = parseOffer(plaintext);
        state = 'offered';
        if (offer.directSdp && typeof RTCPeerConnection === 'function') startDirect(offer.directSdp);
        sink = await waitForAcceptance(offer);
        if (failureShown) {
          await sink.abort();
          return;
        }
        elements.offer.hidden = true;
        elements.status.textContent = `Receiving ${offer.name}...`;
        state = 'receiving';
        renderProgress(0n, offer.size, true);
        await send(KIND_ACCEPT);
        return;
      }
      if (state === 'receiving' && kind === KIND_CHUNK) {
        if (received + BigInt(plaintext.byteLength) > offer.size) throw new Error('The sender sent more data than promised.');
        await sink.write(plaintext);
        received += BigInt(plaintext.byteLength);
        chunks += 1;
        renderProgress(received, offer.size);
        if (received - acknowledged >= ACK_INTERVAL || received === offer.size) {
          await send(KIND_ACK, encodeCounts(chunks, received));
          acknowledged = received;
        }
        return;
      }
      if (state === 'receiving' && kind === KIND_END) {
        const ended = decodeCounts(plaintext);
        if (ended.bytes !== offer.size || ended.bytes !== received || ended.chunks !== chunks) throw new Error('The transfer ended before the complete file arrived.');
        const result = await sink.close();
        state = 'complete';
        renderProgress(received, offer.size, true);
        await send(KIND_COMPLETE, encodeCounts(chunks, received));
        if (sink.kind === 'download') {
          elements.download.href = result.url;
          elements.download.download = offer.name;
          elements.download.textContent = `Download ${offer.name}`;
          elements.download.hidden = false;
          elements.status.textContent = 'File verified and ready to download.';
          let revoked = false;
          const revoke = () => {
            if (revoked) return;
            revoked = true;
            result.revoke();
          };
          elements.download.addEventListener('click', () => setTimeout(revoke, 60_000), { once: true });
          window.addEventListener('pagehide', revoke, { once: true });
        } else elements.status.textContent = 'File verified and saved.';
        socket.close(1000, 'complete');
        return;
      }
      throw new Error('The sender sent a message out of order.');
    }

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: encodeBase64Url(token)
      }));
    });
    // Closing explicitly frees the sender's wait immediately; otherwise it only
    // learns the receiver left via the worker's close propagation.
    const leave = () => {
      try { socket.close(1000, 'receiver left'); } catch { /* Best effort. */ }
    };
    window.addEventListener('pagehide', leave, { once: true });
    stop = () => {
      window.removeEventListener('pagehide', leave);
      closeDirect();
      if (state !== 'complete') void sink?.abort().catch(() => {});
      leave();
    };
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        enqueueRecords(event.data, event.data.byteLength);
        return;
      }
      const size = event.data.length;
      pendingBytes += size;
      queue = queue.then(() => processMessage(event.data)).finally(() => { pendingBytes -= size; });
      queue.catch((error) => fail(error, socket, sink));
    });
    socket.addEventListener('error', () => {
      if (!directUsed) fail(new Error('This CD transfer is unavailable or has expired.'), socket, sink);
    });
    const connectTimeout = setTimeout(() => {
      if (state === 'connecting') fail(new Error('Could not reach the CD relay. Check your connection and reload the link.'), socket, sink);
    }, 15_000);
    socket.addEventListener('close', (event) => {
      clearTimeout(connectTimeout);
      if (state !== 'complete' && !directUsed) fail(new Error(closeReasonMessage(event)), null, sink);
    });
  }

  receive().catch((error) => fail(error));
  return () => stop();
}
