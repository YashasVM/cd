const cdShareCode = window.location.pathname.match(/^\/([a-z]+(?:-[a-z]+){2,7})\/?$/i)?.[1];
if (cdShareCode) {
  window.location.replace(`https://getcroc.com/?code=${encodeURIComponent(cdShareCode)}`);
}

import { Peer } from 'peerjs';
import './style.css';

if ('serviceWorker' in navigator) {
  // Register after first paint/idle so the install never contends with app
  // boot (or an in-progress transfer) for bandwidth and CPU.
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline shell support is optional; transfers still work without it.
    });
  };
  if ('requestIdleCallback' in window) {
    window.addEventListener('load', () => requestIdleCallback(registerSw, { timeout: 4000 }));
  } else {
    window.addEventListener('load', () => setTimeout(registerSw, 1500));
  }
}

let qrCodeModulePromise;
let scannerModulePromise;

function loadQrCode() {
  qrCodeModulePromise ??= import('qrcode')
    .then((module) => module.default || module)
    .catch((error) => {
      qrCodeModulePromise = undefined;
      throw error;
    });
  return qrCodeModulePromise;
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
// file selection instead of stalling on a dynamic import.
warmUpOnIdle(() => {
  loadQrCode().catch(() => {
    // Retried on demand when files are selected.
  });
});

const FUN_CODES = [
  'beep', 'boop', 'bork', 'bonk', 'blob', 'cake', 'clam', 'clap', 'dino', 'drip',
  'duck', 'flap', 'goof', 'honk', 'jazz', 'mochi', 'muffin', 'nacho', 'noodle',
  'otter', 'pickle', 'pizza', 'plop', 'quack', 'salsa', 'snack', 'spork', 'taco',
  'tofu', 'wacky', 'waffle', 'yeti', 'zippy'
];
const MAX_CODE_LENGTH = Math.max(...FUN_CODES.map((item) => item.length));
const PEER_PREFIX = 'cd-';
// PeerJS's binary serializer fragments payloads above its ~16 KB MTU. Keep
// application chunks just below that limit to avoid an extra fragment/
// reassembly cycle for every file chunk.
const TRANSFER_CHUNK_SIZE = 16 * 1024 - 128;
// PeerJS starts queueing internally at 8 MB. Stay below that threshold so
// backpressure remains controlled by this transfer loop instead of creating a
// second, opaque queue inside the library.
const MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024;
const BUFFER_LOW_AMOUNT = 2 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL = 120;
const CONNECTION_TIMEOUT_MS = 15000;

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

function generateCode() {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return FUN_CODES[values[0] % FUN_CODES.length];
}

function cleanCode(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MAX_CODE_LENGTH);
}

function isValidCode(value) {
  const code = cleanCode(value);
  return FUN_CODES.includes(code);
}

function codeFromUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return cleanCode(url.searchParams.get('receive') || value);
  } catch {
    return cleanCode(value);
  }
}

function peerIdFor(code) {
  return PEER_PREFIX + code.toLowerCase();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function receiveLinkFor(code) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('receive', code);
  return url.toString();
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

    code = generateCode();
    bytesSent = 0;
    bytesConfirmed = 0;
    totalSize = files.reduce((sum, item) => sum + item.size, 0);
    transferFinished = false;
    transferCancelled = false;

    renderSelectionSummary();
    els.shareCode.textContent = code;
    els.senderCodeSection.classList.remove('hidden');
    els.dropZone.classList.add('hidden');
    renderQr();
    createPeer();
    setState('waiting');
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
    const QRCode = await loadQrCode();
    await QRCode.toCanvas(els.shareQr, receiveLinkFor(code), {
      margin: 1,
      width: 180,
      color: {
        dark: '#0d0503',
        light: '#e4d4b6'
      }
    });
  }

  function createPeer() {
    peer?.destroy();
    peer = new Peer(peerIdFor(code), { debug: 0 });

    peer.on('open', () => {
      els.senderStatus.textContent = 'Waiting for receiver...';
    });

    peer.on('connection', (conn) => {
      connection = conn;
      els.senderStatus.textContent = 'Receiver found.';
      setState('connecting');

      conn.on('open', () => {
        void sendFiles();
      });

      conn.on('error', () => {
        els.senderStatus.textContent = 'Connection got grumpy. Try again.';
        setState('failed');
      });

      conn.on('data', (data) => {
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
      if (err.type === 'unavailable-id') {
        code = generateCode();
        els.shareCode.textContent = code;
        void renderQr();
        createPeer();
        return;
      }

      els.senderStatus.textContent = 'Connection failed. Give it a refresh.';
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
    await transferAck;
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
    if (transferCancelled) return Promise.resolve();
    return new Promise((resolve) => {
      transferAckResolve = resolve;
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
    els.senderStatus.textContent = message;
    reset();
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
  let currentFileChunks = [];
  let currentWritable = null;
  let currentFileHandle = null;
  let pickerPromise = null;
  let totalBytesReceived = 0;
  let transferStartTime = null;
  let transferComplete = false;
  let transferCancelled = false;
  let lastProgressAckAt = 0;
  let dataQueue = Promise.resolve();
  let timeoutId = null;
  const lastProgressUpdate = { value: 0 };

  function connect(rawCode) {
    const code = cleanCode(rawCode);
    if (!isValidCode(code)) {
      showError('That code is a dud.');
      return;
    }

    stopScanner();
    resetConnectionOnly();
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    els.codeInput.value = code;
    setState('connecting');

    peer = new Peer({ debug: 0 });

    peer.on('open', () => {
      connection = peer.connect(peerIdFor(code), {
        reliable: true,
        serialization: 'binary'
      });

      connection.on('open', () => {
        els.receiverConnecting.classList.add('hidden');
      });

      connection.on('data', (data) => {
        dataQueue = dataQueue.then(() => handleData(data)).catch(() => {
        showError('The transfer tripped. Try again.');
        });
      });

      connection.on('error', () => {
        showError('Connection vanished. Try again.');
      });

      connection.on('close', () => {
        if (!transferCancelled && !transferComplete && totalBytesReceived < (manifest?.totalSize ?? Infinity)) {
          showError('Connection vanished unexpectedly.');
        }
      });
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        showError('Bad code, or the sender wandered off.');
        return;
      }
      showError('Connection failed. Try again.');
    });

    timeoutId = setTimeout(() => {
      if (!connection || !connection.open) {
        showError('Connection timed out. Check the code and try again.');
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  async function handleData(data) {
    if (transferCancelled && data?.type !== 'manifest') return;

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
        await handleFileComplete();
        break;
      case 'transfer-complete':
        handleTransferComplete();
        break;
      case 'cancel':
        transferCancelled = true;
        showError('The sender canceled the transfer.');
        break;
      default:
        break;
    }
  }

  function handleManifest(data) {
    manifest = {
      totalFiles: data.totalFiles,
      totalSize: data.totalSize,
      files: data.files
    };
    totalBytesReceived = 0;
    transferStartTime = Date.now();
    transferCancelled = false;
    lastProgressAckAt = 0;
    lastProgressUpdate.value = 0;

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
    if (!manifest) return;

    currentFile = manifest.files[data.index];
    currentFileChunks = [];
    currentWritable = null;
    currentFileHandle = null;
    pickerPromise = null;
    setFileInfo(
      els.receiverFileInfo,
      currentFile.name,
      formatSize(currentFile.size),
      `File ${data.index + 1} of ${manifest.totalFiles}`
    );

    if ('showSaveFilePicker' in window) {
      // Fire the save dialog WITHOUT blocking the transfer queue. Awaiting
      // it here stalls the sender (backpressure) until the user picks a
      // location; instead chunks buffer in memory and flush at file-complete.
      pickerPromise = openWritable(currentFile);
    }
  }

  async function openWritable(file) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: file.name,
        types: [{ description: file.mimeType, accept: { [file.mimeType]: ['.' + extensionFor(file.name)] } }]
      });
      return { handle, writable: await handle.createWritable() };
    } catch {
      return null;
    }
  }

  async function handleChunk(data) {
    if (!currentFile) return;

    const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    const chunkSize = chunk.byteLength;

    if (currentWritable) {
      await currentWritable.write(chunk);
    } else {
      currentFileChunks.push(chunk);
    }

    totalBytesReceived += chunkSize;
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

  async function handleFileComplete() {
    if (!currentFile) return;

    // Adopt the save stream if the dialog resolved while chunks streamed in.
    const picked = await pickerPromise;
    pickerPromise = null;
    if (picked && !transferCancelled) {
      currentWritable = picked.writable;
      currentFileHandle = picked.handle;
      setState('saving');
    }

    if (currentWritable) {
      for (const buffered of currentFileChunks) {
        await currentWritable.write(buffered);
      }
      currentFileChunks = [];
      await currentWritable.close();
    } else {
      const blob = new Blob(currentFileChunks, { type: currentFile.mimeType });
      downloadBlob(blob, currentFile.name);
    }

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
    currentFileChunks = [];
    currentWritable = null;
    currentFileHandle = null;
  }

  function extensionFor(fileName) {
    const extension = fileName.split('.').pop();
    return extension && extension !== fileName ? extension : 'download';
  }

  function handleTransferComplete() {
    transferComplete = true;
    clearTimeout(timeoutId);
    sendProgressAck(true);
    connection?.send({ type: 'transfer-ack' });
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.remove('hidden');
    els.receiverCompleteMessage.textContent =
      manifest && manifest.totalFiles > 1 ? `${manifest.totalFiles} files landed.` : 'All here. Nice.';
    setState('complete');
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showError(message) {
    clearTimeout(timeoutId);
    els.receiverConnecting.classList.add('hidden');
    els.receiverInputSection.classList.add('hidden');
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.add('hidden');
    els.receiverError.querySelector('.error-message').textContent = message;
    els.receiverError.classList.remove('hidden');
    setState('failed');
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
    transferCancelled = true;
    peer?.destroy();
    peer = null;
    connection = null;
    manifest = null;
    currentFile = null;
    currentFileChunks = [];
    currentWritable = null;
    currentFileHandle = null;
    pickerPromise = null;
    totalBytesReceived = 0;
    transferStartTime = null;
    transferComplete = false;
    dataQueue = Promise.resolve();
    clearTimeout(timeoutId);
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

  return {
    connect,
    reset,
    cancel
  };
})();

let scanner = null;

async function startScanner() {
  els.scannerStatus.textContent = 'Waking the camera...';
  els.qrReader.classList.remove('hidden');
  els.scanQrBtn.classList.add('hidden');
  els.stopScanBtn.classList.remove('hidden');

  try {
    const Html5Qrcode = await loadScanner();
    scanner = new Html5Qrcode('qr-reader');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        const code = codeFromUrl(decodedText);
        if (isValidCode(code)) {
          els.codeInput.value = code;
          Receiver.connect(code);
        }
      }
    );
    els.scannerStatus.textContent = 'Point it at the code.';
  } catch {
    els.scannerStatus.textContent = 'Camera said no. Type the code.';
    await stopScanner();
  }
}

async function stopScanner() {
  if (scanner) {
    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
      await scanner.clear();
    } catch {
      // Camera cleanup should not block manual receive.
    }
  }
  scanner = null;
  els.qrReader.classList.add('hidden');
  els.scanQrBtn.classList.remove('hidden');
  els.stopScanBtn.classList.add('hidden');
}

function switchToSendMode() {
  els.sendModeBtn.classList.add('active');
  els.receiveModeBtn.classList.remove('active');
  els.sendModeBtn.setAttribute('aria-selected', 'true');
  els.receiveModeBtn.setAttribute('aria-selected', 'false');
  els.senderView.classList.add('active');
  els.senderView.classList.remove('hidden');
  els.receiverView.classList.remove('active');
  els.receiverView.classList.add('hidden');
  Receiver.reset();
  setState('idle');
}

function switchToReceiveMode() {
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
  // Warm the 369 KB scanner chunk while idle so tapping "Scan code" later
  // opens the camera instead of downloading and parsing a library.
  warmUpOnIdle(() => {
    loadScanner().catch(() => {
      // Retried on demand when scanning starts.
    });
  });
}

els.sendModeBtn.addEventListener('click', switchToSendMode);
els.receiveModeBtn.addEventListener('click', switchToReceiveMode);

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
  event.target.value = cleanCode(event.target.value);
});
els.codeInput.addEventListener('paste', (event) => {
  event.preventDefault();
  els.codeInput.value = codeFromUrl((event.clipboardData || window.clipboardData).getData('text'));
});

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

const initialCode = cleanCode(new URLSearchParams(window.location.search).get('receive') || '');
if (isValidCode(initialCode)) {
  switchToReceiveMode();
  els.codeInput.value = initialCode;
  Receiver.connect(initialCode);
} else {
  setState('idle');
}
