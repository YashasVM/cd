import { cleanCode, codeFromUrl, generateCode, generateEphemeralId, isValidCode, peerIdFor, receiveLinkFor } from './p2p-code.js';
import { MAX_P2P_FILES, MAX_P2P_FILE_BYTES, parseManifest } from './p2p-manifest.js';
import {
  DOWNLOAD_TOO_LARGE,
  createSink,
  createStageSink,
  detectCapabilities,
  selectSinkTier
} from './sink.js';

if ('serviceWorker' in navigator) {
  // Register after first paint/idle so the install never contends with app
  // boot (or an in-progress transfer) for bandwidth and CPU.
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline shell support is optional; transfers still work without it.
    });
  };
  const scheduleRegistration = () => warmUpOnIdle(registerSw);
  if (document.readyState === 'complete') scheduleRegistration();
  else window.addEventListener('load', scheduleRegistration, { once: true });
}

let qrCodeModulePromise;
let scannerModulePromise;
let peerModulePromise;

function loadQrCode() {
  qrCodeModulePromise ??= import('qrcode')
    .then((module) => module.default || module)
    .catch((error) => {
      qrCodeModulePromise = undefined;
      throw error;
    });
  return qrCodeModulePromise;
}

function loadPeer() {
  // PeerJS is the heaviest dependency on this page. Loading it on demand
  // keeps first paint fast; transfers await it only when one starts.
  peerModulePromise ??= import('peerjs')
    .then((module) => module.Peer || module.default?.Peer || module.default)
    .catch((error) => {
      peerModulePromise = undefined;
      throw error;
    });
  return peerModulePromise;
}

function loadScanner() {
  scannerModulePromise ??= import('html5-qrcode')
    .then((module) => module.Html5Qrcode || module.default?.Html5Qrcode)
    .catch((error) => {
      scannerModulePromise = undefined;
      throw error;
    });
  return scannerModulePromise;
}

function warmUpOnIdle(task) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(task, { timeout: 5000 });
  } else {
    setTimeout(task, 1500);
  }
}

// Fetch the QR renderer during idle so the share panel paints instantly after
// file selection instead of stalling on a dynamic import. PeerJS is warmed
// the same way: free to download off the critical path, ready when needed.
warmUpOnIdle(() => {
  loadQrCode().catch(() => {
    // Retried on demand when files are selected.
  });
  loadPeer().catch(() => {
    // Retried on demand when a transfer starts.
  });
});

// WebRTC SCTP fragments large messages natively (cheap, inside the
// transport), while every application chunk pays JS event-loop,
// serialization, and receiver storage-write overhead. 64 KiB chunks mean
// ~4x fewer messages than PeerJS's ~16 KiB fragmentation size with no
// protocol change: the receiver bounds total pending bytes, not chunk size.
const TRANSFER_CHUNK_SIZE = 64 * 1024 - 128;
// PeerJS starts queueing internally at 8 MB. Stay below that threshold so
// backpressure remains controlled by this transfer loop instead of creating a
// second, opaque queue inside the library.
const MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024;
const BUFFER_LOW_AMOUNT = 2 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL = 120;
const CONNECTION_TIMEOUT_MS = 15000;
const TRANSFER_ACK_TIMEOUT_MS = 30000;
const MAX_PENDING_RECEIVE_BYTES = 8 * 1024 * 1024;

function peerOptions() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  // TURN-ready: set window.__CD_TURN_SERVERS__ to an array of RTCIceServer
  // before creating a transfer to relay through TURN (symmetric NAT/CGNAT).
  // STUN-only when unset.
  try {
    const injected = window.__CD_TURN_SERVERS__;
    if (Array.isArray(injected) && injected.length > 0) iceServers.push(...injected);
  } catch { /* STUN-only fallback */ }
  return {
    host: window.location.hostname,
    port: window.location.port ? Number(window.location.port) : window.location.protocol === 'https:' ? 443 : 80,
    path: '/peerjs/',
    secure: window.location.protocol === 'https:',
    key: 'peerjs',
    debug: 0,
    config: { iceServers },
  };
}

const els = {
  appState: document.getElementById('app-state'),
  sendModeBtn: document.getElementById('send-mode-btn'),
  receiveModeBtn: document.getElementById('receive-mode-btn'),
  senderView: document.getElementById('sender-view'),
  receiverView: document.getElementById('receiver-view'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  selectFileBtn: document.getElementById('select-file-btn'),
  senderFileInfo: document.getElementById('sender-file-info'),
  senderCodeSection: document.getElementById('sender-code-section'),
  shareCode: document.getElementById('share-code'),
  shareQr: document.getElementById('share-qr'),
  copyCodeBtn: document.getElementById('copy-code-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  senderStatus: document.getElementById('sender-status'),
  senderProgress: document.getElementById('sender-progress'),
  senderCancelBtn: document.getElementById('sender-cancel-btn'),
  senderComplete: document.getElementById('sender-complete'),
  senderCompleteMessage: document.getElementById('sender-complete-message'),
  sendAnotherBtn: document.getElementById('send-another-btn'),
  receiverInputSection: document.getElementById('receiver-input-section'),
  codeInput: document.getElementById('code-input'),
  connectBtn: document.getElementById('connect-btn'),
  scanQrBtn: document.getElementById('scan-qr-btn'),
  stopScanBtn: document.getElementById('stop-scan-btn'),
  scannerStatus: document.getElementById('scanner-status'),
  qrReader: document.getElementById('qr-reader'),
  receiverConnecting: document.getElementById('receiver-connecting'),
  receiverConnectingCancelBtn: document.getElementById('receiver-connecting-cancel-btn'),
  receiverFileInfo: document.getElementById('receiver-file-info'),
  receiverProgress: document.getElementById('receiver-progress'),
  receiverCancelBtn: document.getElementById('receiver-cancel-btn'),
  receiverComplete: document.getElementById('receiver-complete'),
  receiverCompleteMessage: document.getElementById('receiver-complete-message'),
  receiverError: document.getElementById('receiver-error'),
  retryBtn: document.getElementById('retry-btn'),
  receiveAnotherBtn: document.getElementById('receive-another-btn')
};

function setState(state) {
  els.appState.textContent = state;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function copyText(text, button, doneLabel) {
  const original = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = doneLabel;
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1400);
}

function setFileInfo(container, title, size, subtitle) {
  container.querySelector('.file-name').textContent = title;
  container.querySelector('.file-size').textContent = size;
  container.querySelector('.file-subtext').textContent = subtitle || '';
  container.classList.remove('hidden');
}
// Progress DOM nodes are cached per container: updateProgress runs on every
// throttled tick during a transfer, so re-querying the DOM each time is pure
// overhead on the hot path.
const progressRefs = new WeakMap();

function refsForProgress(container) {
  let refs = progressRefs.get(container);
  if (!refs) {
    refs = {
      fill: container.querySelector('.progress-fill'),
      bar: container.querySelector('.progress-bar'),
      percent: container.querySelector('.progress-percent'),
      speed: container.querySelector('.progress-speed'),
      transferred: container.querySelector('.progress-transferred'),
      eta: container.querySelector('.progress-eta'),
      emaSpeed: 0
    };
    progressRefs.set(container, refs);
  }
  return refs;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function resetProgress(container) {
  const refs = refsForProgress(container);
  refs.emaSpeed = 0;
  refs.fill.style.transform = 'scaleX(0)';
  refs.bar.setAttribute('aria-valuenow', '0');
  refs.percent.textContent = '0%';
  refs.speed.textContent = '0 MB/s';
  refs.transferred.textContent = '0 / 0 MB';
  if (refs.eta) refs.eta.textContent = '–';
}

function updateProgress(container, bytes, total, startedAt, force, lastUpdateRef) {
  if (!startedAt) return lastUpdateRef.value;

  const now = performance.now();
  if (!force && now - lastUpdateRef.value < PROGRESS_UPDATE_INTERVAL) {
    return lastUpdateRef.value;
  }

  const refs = refsForProgress(container);
  const percent = total === 0 ? 100 : Math.min((bytes / total) * 100, 100);
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const instantSpeed = bytes / elapsed;
  // Exponential moving average: per-chunk timing is noisy, and a flickering
  // speed readout makes the transfer feel slower than it is.
  refs.emaSpeed = refs.emaSpeed === 0 ? instantSpeed : refs.emaSpeed * 0.7 + instantSpeed * 0.3;

  // transform (not width) keeps the bar animation on the compositor thread.
  refs.fill.style.transform = `scaleX(${percent / 100})`;
  refs.bar.style.setProperty('--progress', `${percent}%`);
  refs.bar.setAttribute('aria-valuenow', percent.toFixed(1));
  refs.percent.textContent = `${percent.toFixed(1)}%`;
  refs.speed.textContent = `${formatSize(refs.emaSpeed)}/s`;
  refs.transferred.textContent = `${formatSize(bytes)} / ${formatSize(total)}`;
  if (refs.eta) {
    refs.eta.textContent = bytes >= total || refs.emaSpeed <= 0 ? '–' : formatEta((total - bytes) / refs.emaSpeed);
  }

  return now;
}

const Sender = (() => {
  let peer = null;
  let connection = null;
  let files = [];
  let code = null;
  let codeAttempts = 0;
  const MAX_CODE_ATTEMPTS = 5;
  let bytesSent = 0;
  let bytesConfirmed = 0;
  let totalSize = 0;
  let transferStartTime = null;
  let transferFinished = false;
  let transferCancelled = false;
  let transferAckResolve = null;
  const lastProgressUpdate = { value: 0 };

  function init(selectedFiles) {
    reset();
    files = selectedFiles.filter(Boolean);
    if (files.length === 0) return;

    if (files.length > MAX_P2P_FILES) {
      setFileInfo(els.senderFileInfo, `${files.length} files selected`, '', `Too many files — max is ${MAX_P2P_FILES}. Send in batches.`);
      setState('failed');
      return;
    }
    const oversize = files.find((f) => f.size > MAX_P2P_FILE_BYTES);
    if (oversize) {
      setFileInfo(els.senderFileInfo, oversize.name, formatSize(oversize.size), 'That file is over 5 GB — split it and try again.');
      setState('failed');
      return;
    }

    code = generateCode();
    codeAttempts = 1;
    bytesSent = 0;
    bytesConfirmed = 0;
    totalSize = files.reduce((sum, item) => sum + item.size, 0);
    transferFinished = false;
    transferCancelled = false;

    renderSelectionSummary();
    // Reserve-then-display: only paint code/QR after the Worker owns the ID
    // (peer open). Prevents copying a code that dials an unowned ID.
    els.senderCodeSection.classList.add('hidden');
    void createPeer();
    setState('connecting');
    els.senderFileInfo.querySelector('.file-subtext').textContent = 'Getting a share code...';
  }

  function renderSelectionSummary() {
    if (files.length === 1) {
      setFileInfo(els.senderFileInfo, files[0].name, formatSize(files[0].size), 'Ready to send');
      return;
    }

    const previewNames = files.slice(0, 3).map((item) => item.name).join(', ');
    const remaining = files.length - 3;
    const suffix = remaining > 0 ? ` + ${remaining} more` : '';
    setFileInfo(els.senderFileInfo, `${files.length} files selected`, formatSize(totalSize), previewNames + suffix);
  }

  function showCurrentFile(index) {
    const currentFile = files[index];
    setFileInfo(
      els.senderFileInfo,
      currentFile.name,
      formatSize(currentFile.size),
      `File ${index + 1} of ${files.length}`
    );
  }

  async function renderQr() {
    const renderingCode = code;
    const QRCode = await loadQrCode();
    if (code !== renderingCode) return;
    els.shareQr.hidden = false;
    await QRCode.toCanvas(els.shareQr, receiveLinkFor(renderingCode), {
      margin: 2,
      width: 220,
      color: {
        dark: '#0d0503',
        light: '#e4d4b6'
      }
    });
  }

  async function createPeer() {
    const creatingCode = code;
    peer?.destroy();
    const PeerCtor = await loadPeer().catch(() => null);
    if (code !== creatingCode || transferCancelled) return;
    if (!PeerCtor) {
      els.senderFileInfo.querySelector('.file-subtext').textContent = 'Could not start sharing. Check your connection and try again.';
      els.dropZone.classList.remove('hidden');
      setState('failed');
      return;
    }
    const activePeer = new PeerCtor(peerIdFor(creatingCode), peerOptions());
    peer = activePeer;
    els.senderCodeSection.classList.add('hidden');

    peer.on('open', () => {
      if (peer !== activePeer || transferCancelled) return;
      if (code !== creatingCode) return;
      renderSelectionSummary();
      els.shareCode.textContent = creatingCode;
      void renderQr().catch(() => { els.shareQr.hidden = true; });
      els.senderCodeSection.classList.remove('hidden');
      els.dropZone.classList.add('hidden');
      els.senderStatus.textContent = 'Waiting for receiver...';
      setState('waiting');
    });

    peer.on('connection', (conn) => {
      if (peer !== activePeer || transferCancelled) { conn.close(); return; }
      if (connection?.open) {
        conn.close();
        return;
      }
      connection = conn;
      els.senderStatus.textContent = 'Receiver found.';
      setState('connecting');

      conn.on('open', () => {
        if (peer !== activePeer || connection !== conn || transferCancelled) return;
        void sendFiles();
      });

      conn.on('error', () => {
        if (peer !== activePeer || connection !== conn) return;
        els.senderStatus.textContent = 'Connection got grumpy. Try again.';
        setState('failed');
      });

      conn.on('data', (data) => {
        if (peer !== activePeer || connection !== conn || transferCancelled) return;
        if (data?.type === 'progress') {
          bytesConfirmed = Math.max(bytesConfirmed, Math.min(data.bytes, totalSize));
          lastProgressUpdate.value = updateProgress(
            els.senderProgress,
            bytesConfirmed,
            totalSize,
            transferStartTime,
            false,
            lastProgressUpdate
          );
          return;
        }
        if (data?.type === 'transfer-ack') {
          bytesConfirmed = totalSize;
          lastProgressUpdate.value = updateProgress(
            els.senderProgress,
            bytesConfirmed,
            totalSize,
            transferStartTime,
            true,
            lastProgressUpdate
          );
          transferAckResolve?.();
          transferAckResolve = null;
          return;
        }
        if (data?.type === 'cancel') {
          cancel('Receiver canceled the transfer.');
        }
      });

      conn.on('close', () => {
        if (peer !== activePeer || connection !== conn) return;
        if (!transferFinished && !transferCancelled) {
          transferCancelled = true;
          transferAckResolve?.();
          transferAckResolve = null;
          els.senderStatus.textContent = 'Connection vanished mid-send.';
          setState('failed');
        }
      });
    });

    peer.on('error', (err) => {
      if (peer !== activePeer || transferCancelled) return;
      if (err.type === 'unavailable-id') {
        if (codeAttempts >= MAX_CODE_ATTEMPTS) {
          els.senderFileInfo.querySelector('.file-subtext').textContent = 'All share codes are busy right now. Wait a moment and try again.';
          els.senderStatus.textContent = 'All share codes are busy right now. Wait a moment and try again.';
          els.dropZone.classList.remove('hidden');
          setState('failed');
          return;
        }
        codeAttempts += 1;
        code = generateCode();
        const delay = 300 * codeAttempts;
        setTimeout(() => { if (!transferCancelled) void createPeer(); }, delay);
        return;
      }

      els.senderStatus.textContent = 'Connection failed. Give it a refresh.';
      els.senderFileInfo.querySelector('.file-subtext').textContent = 'Connection failed. Choose files to try again.';
      els.dropZone.classList.remove('hidden');
      els.senderCodeSection.classList.add('hidden');
      setState('failed');
    });
  }

  async function sendFiles() {
    if (!connection || files.length === 0) return;

    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.remove('hidden');
    setState('transferring');

    connection.send({
      type: 'manifest',
      totalFiles: files.length,
      totalSize,
      files: files.map((item, index) => ({
        index,
        name: item.name,
        size: item.size,
        mimeType: item.type || 'application/octet-stream'
      }))
    });

    transferStartTime = Date.now();
    lastProgressUpdate.value = updateProgress(els.senderProgress, bytesSent, totalSize, transferStartTime, true, lastProgressUpdate);

    for (let index = 0; index < files.length; index += 1) {
      if (transferCancelled) return;
      showCurrentFile(index);
      els.senderStatus.textContent = `Sending ${index + 1} of ${files.length}…`;
      connection.send({ type: 'file-start', index });
      await sendSingleFile(files[index]);
      if (transferCancelled) return;
      connection.send({ type: 'file-complete', index });
    }

    const transferAck = waitForTransferAck();
    connection.send({ type: 'transfer-complete' });
    if (!(await transferAck)) {
      if (!transferCancelled) {
        transferCancelled = true;
        els.senderStatus.textContent = 'Receiver did not confirm the download.';
        setState('failed');
      }
      return;
    }
    if (transferCancelled) return;
    transferFinished = true;
    showComplete();
  }

  async function sendSingleFile(file) {
    let offset = 0;
    let nextChunk = file.slice(0, Math.min(TRANSFER_CHUNK_SIZE, file.size)).arrayBuffer();

    while (offset < file.size && !transferCancelled) {
      // Start reading the next chunk before waiting for the data channel. On
      // slower storage this keeps the channel supplied without growing the
      // number of outstanding reads beyond one.
      const value = await nextChunk;
      offset += value.byteLength;
      nextChunk = offset < file.size
        ? file.slice(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, file.size)).arrayBuffer()
        : null;

      await waitForBuffer();
      connection.send(value);
      bytesSent += value.byteLength;
    }
  }

  function waitForTransferAck() {
    if (transferCancelled) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        transferAckResolve = null;
        resolve(false);
      }, TRANSFER_ACK_TIMEOUT_MS);
      transferAckResolve = () => {
        clearTimeout(timeout);
        resolve(true);
      };
    });
  }

  function waitForBuffer() {
    const dataChannel = connection?.dataChannel;
    if (!dataChannel || dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      return Promise.resolve();
    }

    dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_AMOUNT;

    // Event-driven: waking 60x/sec on a polling interval burns CPU for the
    // whole transfer. The coarse timeout is only a fallback for browsers
    // that never fire bufferedamountlow.
    return new Promise((resolve) => {
      let settled = false;
      let fallbackId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        dataChannel.removeEventListener?.('bufferedamountlow', onBufferedLow);
        clearTimeout(fallbackId);
        resolve();
      };

      const onBufferedLow = () => {
        if (transferCancelled || !connection?.open || dataChannel.bufferedAmount <= BUFFER_LOW_AMOUNT) {
          finish();
        } else {
          clearTimeout(fallbackId);
          fallbackId = setTimeout(onBufferedLow, 120);
        }
      };

      dataChannel.addEventListener?.('bufferedamountlow', onBufferedLow);
      fallbackId = setTimeout(onBufferedLow, 120);
    });
  }

  function showComplete() {
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.remove('hidden');
    els.senderCompleteMessage.textContent = files.length === 1 ? 'Sent. Nice.' : `${files.length} files escaped.`;
    setState('complete');
  }

  function cancel(message = 'Transfer canceled.') {
    if (transferCancelled) return;
    transferCancelled = true;
    try {
      connection?.send({ type: 'cancel' });
    } catch {
      // The connection may already be closing.
    }
    // reset() hides every panel and restores the default status text, so the
    // reason (e.g. "Receiver canceled the transfer.") must be shown after it.
    reset();
    setFileInfo(els.senderFileInfo, 'Transfer canceled', '', message);
    setState('idle');
  }

  function reset() {
    transferCancelled = true;
    peer?.destroy();
    peer = null;
    connection = null;
    files = [];
    code = null;
    bytesSent = 0;
    bytesConfirmed = 0;
    totalSize = 0;
    transferStartTime = null;
    transferFinished = false;
    transferAckResolve?.();
    transferAckResolve = null;
    lastProgressUpdate.value = 0;

    els.dropZone.classList.remove('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.add('hidden');
    els.senderStatus.textContent = 'Waiting for receiver...';
    els.senderCompleteMessage.textContent = 'Sent. Nice.';
    resetProgress(els.senderProgress);
  }

  return {
    init,
    reset,
    cancel,
    copyCode: () => code && copyText(code, els.copyCodeBtn, 'Copied'),
    copyLink: () => code && copyText(receiveLinkFor(code), els.copyLinkBtn, 'Copied')
  };
})();

const Receiver = (() => {
  let peer = null;
  let connection = null;
  let manifest = null;
  let currentFile = null;
  let currentSink = null;
  let stageSink = null;
  let pendingDownloadUrls = [];
  const DOWNLOAD_URL_TTL_MS = 10 * 60 * 1000;
  let currentFileBytes = 0;
  let nextFileIndex = 0;
  let pickerPromise = null;
  let totalBytesReceived = 0;
  let transferStartTime = null;
  let transferComplete = false;
  let transferCancelled = false;
  let lastProgressAckAt = 0;
  let dataQueue = Promise.resolve();
  let pendingReceiveBytes = 0;
  let transferGeneration = 0;
  let timeoutId = null;
  let lastArrivalAt = 0;
  let stallIntervalId = null;
  const lastProgressUpdate = { value: 0 };

  function connect(rawCode) {
    const code = codeFromUrl(rawCode, window.location.href);
    if (!isValidCode(code)) {
      els.scannerStatus.textContent = 'Paste the sender’s code or their link.';
      els.codeInput.setAttribute('aria-invalid', 'true');
      els.codeInput.focus();
      return;
    }

    els.codeInput.removeAttribute('aria-invalid');
    void stopScanner();
    resetConnectionOnly();
    transferCancelled = false;
    const connectionGeneration = transferGeneration;
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    els.codeInput.value = code;
    setState('connecting');

    void establishPeer(connectionGeneration, code);

    timeoutId = setTimeout(() => {
      if (!connection || !connection.open) {
        showError('Connection timed out. Check the code and try again.');
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  async function establishPeer(connectionGeneration, code) {
    const PeerCtor = await loadPeer().catch(() => null);
    if (connectionGeneration !== transferGeneration || transferCancelled) return;
    if (!PeerCtor) {
      showError('Could not start. Check your connection and try again.');
      return;
    }
    peer = new PeerCtor(`cd-r-${generateEphemeralId()}`, peerOptions());

    peer.on('open', () => {
      if (connectionGeneration !== transferGeneration || transferCancelled) return;
      connection = peer.connect(peerIdFor(code), {
        reliable: true,
        serialization: 'binary'
      });

      connection.on('open', () => {
        if (connectionGeneration !== transferGeneration || transferCancelled) return;
        els.receiverConnecting.classList.add('hidden');
      });

      connection.on('data', (data) => {
        if (connectionGeneration !== transferGeneration) return;
        lastArrivalAt = Date.now();
        const frameBytes = data instanceof Blob ? data.size : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 1024;
        pendingReceiveBytes += frameBytes;
        if (pendingReceiveBytes > MAX_PENDING_RECEIVE_BYTES) {
          failProtocol();
          return;
        }
        dataQueue = dataQueue
          .then(() => connectionGeneration === transferGeneration && handleData(data))
          .catch((error) => {
            if (connectionGeneration !== transferGeneration) return;
            if (error?.message === DOWNLOAD_TOO_LARGE) refuseTransfer(DOWNLOAD_TOO_LARGE);
            else if (error?.message === 'invalid file size' || error?.message === 'invalid file count') {
              refuseTransfer('That file is too large or too many files — max 5 GB per file, 100 files. Split it and try again.');
            } else failProtocol();
          })
          .finally(() => {
            if (connectionGeneration === transferGeneration) pendingReceiveBytes -= frameBytes;
          });
      });

      connection.on('error', () => {
        if (connectionGeneration !== transferGeneration || transferCancelled) return;
        showError('Connection vanished. Try again.');
      });

      connection.on('close', () => {
        if (connectionGeneration !== transferGeneration) return;
        if (!transferCancelled && !transferComplete && totalBytesReceived < (manifest?.totalSize ?? Infinity)) {
          showError('Connection vanished unexpectedly.');
        }
      });
    });

    peer.on('error', (err) => {
      if (connectionGeneration !== transferGeneration || transferCancelled) return;
      if (err.type === 'peer-unavailable') {
        showError('Bad code, or the sender wandered off.');
        return;
      }
      showError('Connection failed. Try again.');
    });
  }

  async function handleData(data) {
    if (transferCancelled) return;

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
      await handleChunk(data);
      return;
    }

    switch (data.type) {
      case 'manifest':
        handleManifest(data);
        break;
      case 'file-start':
        await handleFileStart(data);
        break;
      case 'file-complete':
        await handleFileComplete(data);
        break;
      case 'transfer-complete':
        handleTransferComplete();
        break;
      case 'cancel':
        transferCancelled = true;
        showError('The sender canceled the transfer.');
        break;
      default:
        throw new Error('unexpected control message');
    }
  }

  // A sender that stops sending without closing (dead network, a killed tab
  // on a network that never delivers FIN) would otherwise leave the receiver
  // on a progress bar forever. Arrival timestamps update for every frame,
  // even while chunks queue, so only true silence trips this.
  const STALL_TIMEOUT_MS = 45_000;
  const STALL_CHECK_MS = 5_000;

  function startStallWatch() {
    stopStallWatch();
    lastArrivalAt = Date.now();
    stallIntervalId = setInterval(() => {
      if (transferCancelled || transferComplete || !manifest) return;
      if (Date.now() - lastArrivalAt > STALL_TIMEOUT_MS) {
        failProtocol('Connection stalled. Check the network and try again.');
      }
    }, STALL_CHECK_MS);
  }

  function stopStallWatch() {
    if (stallIntervalId !== null) {
      clearInterval(stallIntervalId);
      stallIntervalId = null;
    }
  }

  function handleManifest(data) {
    if (manifest) throw new Error('duplicate manifest');
    manifest = parseManifest(data);
    totalBytesReceived = 0;
    transferStartTime = Date.now();
    transferCancelled = false;
    lastProgressAckAt = 0;
    nextFileIndex = 0;
    lastProgressUpdate.value = 0;
    startStallWatch();

    setManifestSummary();
    els.receiverProgress.classList.remove('hidden');
    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      true,
      lastProgressUpdate
    );
    setState('transferring');
  }

  function setManifestSummary() {
    if (!manifest) return;

    if (manifest.totalFiles === 1) {
      const onlyFile = manifest.files[0];
      setFileInfo(els.receiverFileInfo, onlyFile.name, formatSize(onlyFile.size), 'Getting ready');
      return;
    }

    const previewNames = manifest.files.slice(0, 3).map((item) => item.name).join(', ');
    const remaining = manifest.totalFiles - 3;
    const suffix = remaining > 0 ? ` + ${remaining} more` : '';
    setFileInfo(els.receiverFileInfo, `${manifest.totalFiles} files incoming`, formatSize(manifest.totalSize), previewNames + suffix);
  }

  async function handleFileStart(data) {
    if (!manifest || currentFile || !Number.isInteger(data.index) || data.index !== nextFileIndex) {
      throw new Error('unexpected file start');
    }

    const generation = transferGeneration;
    currentFile = manifest.files[data.index];
    currentFileBytes = 0;
    currentSink = null;
    stageSink = null;
    pickerPromise = null;
    setFileInfo(
      els.receiverFileInfo,
      currentFile.name,
      formatSize(currentFile.size),
      `File ${data.index + 1} of ${manifest.totalFiles}`
    );

    const tier = selectSinkTier(detectCapabilities(), currentFile.size, navigator.userAgent);
    if (tier === 'too-large') {
      refuseTransfer(DOWNLOAD_TOO_LARGE);
      return;
    }
    if (tier === 'file-picker') {
      // Fire the save dialog WITHOUT blocking the transfer queue. Awaiting
      // it here stalls the sender (backpressure) until the user picks a
      // location; instead chunks stage (preferably off-heap in OPFS) and
      // flush at file-complete.
      pickerPromise = openWritable(currentFile);
      const staged = await createStageSink({ name: currentFile.name, size: currentFile.size });
      if (generation !== transferGeneration || transferCancelled) {
        await staged.discard();
        return;
      }
      stageSink = staged;
    } else {
      const sink = await createSink({ mediaType: currentFile.mimeType, name: currentFile.name, size: currentFile.size });
      if (generation !== transferGeneration || transferCancelled) {
        await sink.abort();
        return;
      }
      currentSink = sink;
    }
  }

  async function openWritable(file) {
    const generation = transferGeneration;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: file.name,
        types: [{ description: file.mimeType, accept: { [file.mimeType]: ['.' + extensionFor(file.name)] } }]
      });
      const writable = await handle.createWritable();
      if (generation !== transferGeneration || transferCancelled) {
        await writable.abort();
        return null;
      }
      return { handle, writable };
    } catch {
      return null;
    }
  }

  async function handleChunk(data) {
    if (!currentFile || !manifest) throw new Error('unexpected file bytes');

    const generation = transferGeneration;
    const file = currentFile;
    const sink = currentSink || stageSink;
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;
    const chunkSize = chunk.byteLength;
    if (chunkSize === 0 || currentFileBytes + chunkSize > file.size || totalBytesReceived + chunkSize > manifest.totalSize) {
      throw new Error('file size exceeded');
    }

    if (!sink) {
      throw new Error('unexpected file bytes');
    }
    await sink.write(chunk);
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;

    totalBytesReceived += chunkSize;
    currentFileBytes += chunkSize;
    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      false,
      lastProgressUpdate
    );
    sendProgressAck();
  }

  function sendProgressAck(force = false) {
    if (!connection?.open) return;
    const now = performance.now();
    if (!force && now - lastProgressAckAt < PROGRESS_UPDATE_INTERVAL) return;
    connection.send({ type: 'progress', bytes: totalBytesReceived });
    lastProgressAckAt = now;
  }

  async function handleFileComplete(data) {
    if (!currentFile || data.index !== nextFileIndex || currentFileBytes !== currentFile.size) {
      throw new Error('incomplete file');
    }

    const generation = transferGeneration;
    const file = currentFile;
    const activeSink = currentSink;
    const activeStageSink = stageSink;
    const cleanupStale = async () => {
      try { await activeSink?.abort(); } catch { /* Best effort. */ }
      try { await activeStageSink?.discard(); } catch { /* Best effort. */ }
    };

    // Adopt the save stream if the dialog resolved while chunks staged.
    const picked = await pickerPromise;
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
      try { await picked?.writable?.abort(); } catch { /* Best effort. */ }
      await cleanupStale();
      return;
    }
    pickerPromise = null;
    if (picked && !transferCancelled) {
      setState('saving');
      if (activeStageSink) {
        const staged = await activeStageSink.toFile(file.mimeType);
        if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
          await staged.cleanup();
          try { await picked.writable.abort(); } catch { /* Best effort. */ }
          await cleanupStale();
          return;
        }
        stageSink = null;
        try {
          await staged.file.stream().pipeTo(picked.writable);
        } catch (error) {
          await staged.cleanup();
          throw error;
        }
        if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
          await staged.cleanup();
          await cleanupStale();
          return;
        }
        await staged.cleanup();
      }
    } else if (activeSink) {
      const result = await activeSink.close();
      if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
        try { result?.revoke?.(); } catch { /* Best effort. */ }
        await cleanupStale();
        return;
      }
      currentSink = null;
      downloadUrl(result.url, file.name, result.revoke);
    } else if (activeStageSink) {
      const download = await activeStageSink.toDownload(file.mimeType);
      if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
        try { download?.revoke?.(); } catch { /* Best effort. */ }
        await cleanupStale();
        return;
      }
      stageSink = null;
      downloadUrl(download.url, file.name, download.revoke);
    }

    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;

    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      true,
      lastProgressUpdate
    );
    sendProgressAck(true);
    currentFile = null;
    currentFileBytes = 0;
    nextFileIndex += 1;
    currentSink = null;
    stageSink = null;
  }

  function extensionFor(fileName) {
    const extension = fileName.split('.').pop();
    return extension && extension !== fileName ? extension : 'download';
  }

  function handleTransferComplete() {
    if (!manifest || currentFile || nextFileIndex !== manifest.totalFiles || totalBytesReceived !== manifest.totalSize) {
      throw new Error('incomplete transfer');
    }
    transferComplete = true;
    clearTimeout(timeoutId);
    stopStallWatch();
    sendProgressAck(true);
    connection?.send({ type: 'transfer-ack' });
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.remove('hidden');
    els.receiverCompleteMessage.textContent =
      manifest && manifest.totalFiles > 1 ? `${manifest.totalFiles} files landed.` : 'All here. Nice.';
    setState('complete');
  }

  function revokeDownload(entry) {
    const index = pendingDownloadUrls.indexOf(entry);
    if (index !== -1) pendingDownloadUrls.splice(index, 1);
    clearTimeout(entry.timeoutId);
    try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
    URL.revokeObjectURL(entry.url);
    entry.link?.remove();
  }

  function downloadUrl(url, fileName, revokeExtra) {
    const entry = { url, revokeExtra, timeoutId: 0, link: null };
    // Browsers can block automatic downloads after the first file, so every
    // file also gets a manual re-download link. Without it a blocked second
    // file is silently lost.
    const manual = document.createElement('a');
    manual.href = url;
    manual.download = fileName;
    manual.textContent = `Save ${fileName} again`;
    manual.className = 'secondary-btn';
    let list = els.receiverComplete.querySelector('.redownload-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'redownload-list';
      els.receiverComplete.insertBefore(list, els.receiveAnotherBtn);
    }
    list.appendChild(manual);
    entry.link = manual;
    pendingDownloadUrls.push(entry);

    const auto = document.createElement('a');
    auto.href = url;
    auto.download = fileName;
    document.body.appendChild(auto);
    auto.click();
    document.body.removeChild(auto);
    // Revoking too early aborts large downloads still flushing to disk; the
    // entry is also revoked on reset and pagehide.
    entry.timeoutId = setTimeout(() => revokeDownload(entry), DOWNLOAD_URL_TTL_MS);
  }

  function showError(message) {
    clearTimeout(timeoutId);
    stopStallWatch();
    els.receiverConnecting.classList.add('hidden');
    els.receiverInputSection.classList.add('hidden');
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.add('hidden');
    els.receiverError.querySelector('.error-message').textContent = message;
    els.receiverError.classList.remove('hidden');
    setState('failed');
  }

  function failProtocol(message = 'The sender sent invalid transfer data.') {
    transferCancelled = true;
    stopStallWatch();
    try { connection?.close(); } catch { /* Best effort. */ }
    peer?.destroy();
    showError(message);
  }

  function refuseTransfer(message) {
    transferCancelled = true;
    try { connection?.close(); } catch { /* Best effort. */ }
    try { peer?.destroy(); } catch { /* Best effort. */ }
    showError(message);
  }

  function cancel() {
    if (transferCancelled) return;
    transferCancelled = true;
    try {
      connection?.send({ type: 'cancel' });
    } catch {
      // The connection may already be closing.
    }
    reset();
  }

  function resetConnectionOnly() {
    transferGeneration += 1;
    transferCancelled = true;
    peer?.destroy();
    peer = null;
    connection = null;
    manifest = null;
    currentFile = null;
    if (currentSink) void currentSink.abort();
    if (stageSink) void stageSink.discard();
    currentSink = null;
    stageSink = null;
    for (const entry of pendingDownloadUrls) {
      clearTimeout(entry.timeoutId);
      try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
      try { URL.revokeObjectURL(entry.url); } catch { /* Best effort. */ }
      entry.link?.remove();
    }
    pendingDownloadUrls = [];
    currentFileBytes = 0;
    nextFileIndex = 0;
    pickerPromise = null;
    totalBytesReceived = 0;
    transferStartTime = null;
    transferComplete = false;
    dataQueue = Promise.resolve();
    pendingReceiveBytes = 0;
    clearTimeout(timeoutId);
    stopStallWatch();
  }

  function reset() {
    resetConnectionOnly();
    els.receiverInputSection.classList.remove('hidden');
    els.receiverConnecting.classList.add('hidden');
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.add('hidden');
    els.receiverError.classList.add('hidden');
    els.receiverCompleteMessage.textContent = 'All here. Nice.';
    els.codeInput.value = '';
    resetProgress(els.receiverProgress);
    setState('idle');
  }

  // Leaving with object URLs alive leaks the OPFS staging entries behind
  // them; downloads already handed to the browser are unaffected.
  window.addEventListener('pagehide', () => {
    for (const entry of pendingDownloadUrls) {
      clearTimeout(entry.timeoutId);
      try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
      try { URL.revokeObjectURL(entry.url); } catch { /* Best effort. */ }
    }
    pendingDownloadUrls = [];
  });

  return {
    connect,
    reset,
    cancel
  };
})();

let scanner = null;
let scannerGeneration = 0;
let scannerStart = null;
let scannerCleanup = Promise.resolve();

async function releaseScanner(instance) {
  if (!instance) return;
  try {
    if (instance.isScanning) await instance.stop();
    await instance.clear();
  } catch {
    // A camera failure must not block manual receive.
  } finally {
    // Startup can fail after acquiring media but before isScanning becomes true.
    for (const video of els.qrReader.querySelectorAll('video')) {
      for (const track of video.srcObject?.getTracks?.() || []) track.stop();
      video.srcObject = null;
    }
    els.qrReader.replaceChildren();
  }
}

async function startScanner() {
  const generation = ++scannerGeneration;
  let instance;
  els.scannerStatus.textContent = 'Waking the camera...';
  els.qrReader.classList.remove('hidden');
  els.scanQrBtn.classList.add('hidden');
  els.stopScanBtn.classList.remove('hidden');

  try {
    const Html5Qrcode = await loadScanner();
    if (generation !== scannerGeneration) return;
    instance = new Html5Qrcode('qr-reader');
    scanner = instance;
    scannerStart = instance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (width, height) => {
        const size = Math.min(220, Math.floor(Math.min(width, height) * 0.8));
        return { width: size, height: size };
      } },
      (decodedText) => {
        if (generation !== scannerGeneration) return;
        const code = codeFromUrl(decodedText);
        if (isValidCode(code)) {
          els.codeInput.value = code;
          Receiver.connect(code);
        }
      }
    );
    await scannerStart;
    if (generation !== scannerGeneration) return;
    els.scannerStatus.textContent = 'Point it at the code.';
  } catch {
    if (generation !== scannerGeneration) return;
    await stopScanner();
    els.scannerStatus.textContent = 'Camera unavailable. Paste the sender’s code or link instead.';
  }
}

async function stopScanner() {
  const generation = ++scannerGeneration;
  const pendingStart = scannerStart;
  scannerStart = null;
  const instance = scanner;
  scanner = null;
  els.qrReader.classList.add('hidden');
  els.scanQrBtn.classList.remove('hidden');
  els.stopScanBtn.classList.add('hidden');
  els.scannerStatus.textContent = "Paste the sender's code or link, or scan their QR code.";
  els.scanQrBtn.disabled = true;
  scannerCleanup = scannerCleanup.then(async () => {
    try { await pendingStart; } catch { /* Camera permission can be denied. */ }
    await releaseScanner(instance);
  });
  await scannerCleanup;
  if (generation === scannerGeneration) els.scanQrBtn.disabled = false;
}

function switchToSendMode() {
  if (els.sendModeBtn.getAttribute('aria-selected') === 'true') return;
  els.sendModeBtn.tabIndex = 0;
  els.receiveModeBtn.tabIndex = -1;
  els.sendModeBtn.classList.add('active');
  els.receiveModeBtn.classList.remove('active');
  els.sendModeBtn.setAttribute('aria-selected', 'true');
  els.receiveModeBtn.setAttribute('aria-selected', 'false');
  els.senderView.classList.add('active');
  els.senderView.classList.remove('hidden');
  els.receiverView.classList.remove('active');
  els.receiverView.classList.add('hidden');
  void stopScanner();
  Receiver.reset();
  setState('idle');
}

function switchToReceiveMode() {
  if (els.receiveModeBtn.getAttribute('aria-selected') === 'true') return;
  els.receiveModeBtn.tabIndex = 0;
  els.sendModeBtn.tabIndex = -1;
  els.receiveModeBtn.classList.add('active');
  els.sendModeBtn.classList.remove('active');
  els.receiveModeBtn.setAttribute('aria-selected', 'true');
  els.sendModeBtn.setAttribute('aria-selected', 'false');
  els.receiverView.classList.add('active');
  els.receiverView.classList.remove('hidden');
  els.senderView.classList.remove('active');
  els.senderView.classList.add('hidden');
  Sender.reset();
  setState('idle');
}

els.sendModeBtn.addEventListener('click', switchToSendMode);
els.receiveModeBtn.addEventListener('click', switchToReceiveMode);

for (const tab of [els.sendModeBtn, els.receiveModeBtn]) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? els.sendModeBtn
      : event.key === 'End' ? els.receiveModeBtn
      : tab === els.sendModeBtn ? els.receiveModeBtn : els.sendModeBtn;
    next.click();
    next.focus();
  });
}

els.selectFileBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  els.fileInput.click();
});
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (event) => Sender.init(Array.from(event.target.files)));

els.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.dropZone.classList.add('drag-over');
});
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag-over'));
els.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  els.dropZone.classList.remove('drag-over');
  Sender.init(Array.from(event.dataTransfer.files));
});

els.copyCodeBtn.addEventListener('click', () => void Sender.copyCode());
els.copyLinkBtn.addEventListener('click', () => void Sender.copyLink());
els.sendAnotherBtn.addEventListener('click', () => {
  Sender.reset();
  els.fileInput.value = '';
  setState('idle');
});
els.senderCancelBtn.addEventListener('click', () => Sender.cancel());

els.connectBtn.addEventListener('click', () => Receiver.connect(els.codeInput.value));
els.codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') Receiver.connect(els.codeInput.value);
});
els.codeInput.addEventListener('input', (event) => {
  const raw = event.target.value;
  // Pasting a full link via autofill/drag doesn't fire a paste event, so
  // detect link characters and extract the code instead of mangling it.
  event.target.value = /[:\/#.]/.test(raw) ? codeFromUrl(raw, window.location.href) : cleanCode(raw);
  els.codeInput.removeAttribute('aria-invalid');
});
els.codeInput.addEventListener('paste', (event) => {
  event.preventDefault();
  els.codeInput.value = codeFromUrl((event.clipboardData || window.clipboardData).getData('text'));
  els.codeInput.removeAttribute('aria-invalid');
});

els.scanQrBtn.addEventListener('pointerenter', () => void loadScanner().catch(() => {}), { once: true });
els.scanQrBtn.addEventListener('focus', () => void loadScanner().catch(() => {}), { once: true });
els.scanQrBtn.addEventListener('click', () => void startScanner());
els.stopScanBtn.addEventListener('click', () => void stopScanner());
els.receiveAnotherBtn.addEventListener('click', () => Receiver.reset());
els.retryBtn.addEventListener('click', () => Receiver.reset());
els.receiverCancelBtn.addEventListener('click', () => Receiver.cancel());
els.receiverConnectingCancelBtn.addEventListener('click', () => Receiver.reset());

// Pasting files anywhere on the Send tab starts a transfer immediately.
window.addEventListener('paste', (event) => {
  if (!els.senderView.classList.contains('active')) return;
  const files = Array.from(event.clipboardData?.files || []).filter(Boolean);
  if (files.length > 0) Sender.init(files);
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

const initialCode = codeFromUrl(window.location.href, window.location.href);
if (isValidCode(initialCode)) {
  history.replaceState(null, '', window.location.pathname);
  switchToReceiveMode();
  els.codeInput.value = initialCode;
  Receiver.connect(initialCode);
} else {
  setState('idle');
}
