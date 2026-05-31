import { Peer } from 'peerjs';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import './style.css';

const FUN_CODES = [
  'spark',
  'orbit',
  'pixel',
  'vault',
  'sonic',
  'mango',
  'laser',
  'comet',
  'glint',
  'turbo',
  'relay',
  'frost',
  'nova',
  'bloom',
  'cargo'
];
const CODE_SUFFIX_LENGTH = 5;
const MAX_CODE_LENGTH = Math.max(...FUN_CODES.map((item) => item.length)) + CODE_SUFFIX_LENGTH;
const PEER_PREFIX = 'cd-';
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const BUFFER_LOW_AMOUNT = 2 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL = 80;
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
  receiverFileInfo: document.getElementById('receiver-file-info'),
  receiverProgress: document.getElementById('receiver-progress'),
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
  const values = crypto.getRandomValues(new Uint32Array(2));
  const word = FUN_CODES[values[0] % FUN_CODES.length];
  const suffix = values[1].toString(36).padStart(CODE_SUFFIX_LENGTH, '0').slice(-CODE_SUFFIX_LENGTH);
  return word + suffix;
}

function cleanCode(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MAX_CODE_LENGTH);
}

function isValidCode(value) {
  const code = cleanCode(value);
  const word = FUN_CODES.find((item) => code.startsWith(item));
  return Boolean(word && code.length === word.length + CODE_SUFFIX_LENGTH && /^[a-z0-9]+$/.test(code.slice(word.length)));
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

function updateProgress(container, bytes, total, startedAt, force, lastUpdateRef) {
  if (!startedAt) return lastUpdateRef.value;

  const now = performance.now();
  if (!force && now - lastUpdateRef.value < PROGRESS_UPDATE_INTERVAL) {
    return lastUpdateRef.value;
  }

  const percent = total === 0 ? 100 : Math.min((bytes / total) * 100, 100);
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const speed = bytes / elapsed;

  container.querySelector('.progress-fill').style.width = `${percent}%`;
  container.querySelector('.progress-percent').textContent = `${percent.toFixed(1)}%`;
  container.querySelector('.progress-speed').textContent = `${formatSize(speed)}/s`;
  container.querySelector('.progress-transferred').textContent = `${formatSize(bytes)} / ${formatSize(total)}`;

  return now;
}

const Sender = (() => {
  let peer = null;
  let connection = null;
  let files = [];
  let code = null;
  let bytesSent = 0;
  let totalSize = 0;
  let transferStartTime = null;
  let transferFinished = false;
  const lastProgressUpdate = { value: 0 };

  function init(selectedFiles) {
    reset();
    files = selectedFiles.filter(Boolean);
    if (files.length === 0) return;

    code = generateCode();
    bytesSent = 0;
    totalSize = files.reduce((sum, item) => sum + item.size, 0);
    transferFinished = false;

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
    await QRCode.toCanvas(els.shareQr, receiveLinkFor(code), {
      margin: 1,
      width: 180,
      color: {
        dark: '#101010',
        light: '#f5f000'
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
      els.senderStatus.textContent = 'Receiver connected.';
      setState('connecting');

      conn.on('open', () => {
        void sendFiles();
      });

      conn.on('error', () => {
        els.senderStatus.textContent = 'Connection error. Try again.';
        setState('failed');
      });

      conn.on('close', () => {
        if (!transferFinished) {
          els.senderStatus.textContent = 'Connection closed before transfer finished.';
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

      els.senderStatus.textContent = 'Connection error. Please refresh.';
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
      showCurrentFile(index);
      els.senderStatus.textContent = `Sending file ${index + 1} of ${files.length}`;
      connection.send({ type: 'file-start', index });
      await sendSingleFile(files[index]);
      connection.send({ type: 'file-complete', index });
    }

    connection.send({ type: 'transfer-complete' });
    transferFinished = true;
    showComplete();
  }

  async function sendSingleFile(file) {
    const reader = file.stream().getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          lastProgressUpdate.value = updateProgress(
            els.senderProgress,
            bytesSent,
            totalSize,
            transferStartTime,
            true,
            lastProgressUpdate
          );
          return;
        }

        await waitForBuffer();
        connection.send(value);
        bytesSent += value.byteLength;
        lastProgressUpdate.value = updateProgress(
          els.senderProgress,
          bytesSent,
          totalSize,
          transferStartTime,
          false,
          lastProgressUpdate
        );
      }
    } finally {
      reader.releaseLock();
    }
  }

  function waitForBuffer() {
    const dataChannel = connection?.dataChannel;
    if (!dataChannel || dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      return Promise.resolve();
    }

    dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_AMOUNT;

    return new Promise((resolve) => {
      let settled = false;
      let intervalId = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        dataChannel.removeEventListener?.('bufferedamountlow', onBufferedLow);
        if (intervalId) clearInterval(intervalId);
        resolve();
      };

      const onBufferedLow = () => {
        if (!connection?.open || dataChannel.bufferedAmount <= BUFFER_LOW_AMOUNT) {
          finish();
        }
      };

      dataChannel.addEventListener?.('bufferedamountlow', onBufferedLow);
      intervalId = setInterval(onBufferedLow, 16);
    });
  }

  function showComplete() {
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.remove('hidden');
    els.senderCompleteMessage.textContent = files.length === 1 ? 'Transfer complete' : `${files.length} files transferred`;
    setState('complete');
  }

  function reset() {
    peer?.destroy();
    peer = null;
    connection = null;
    files = [];
    code = null;
    bytesSent = 0;
    totalSize = 0;
    transferStartTime = null;
    transferFinished = false;
    lastProgressUpdate.value = 0;

    els.dropZone.classList.remove('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.add('hidden');
    els.senderStatus.textContent = 'Waiting for receiver...';
    els.senderCompleteMessage.textContent = 'Transfer complete';
    els.senderProgress.querySelector('.progress-fill').style.width = '0%';
    els.senderProgress.querySelector('.progress-percent').textContent = '0%';
    els.senderProgress.querySelector('.progress-speed').textContent = '0 MB/s';
    els.senderProgress.querySelector('.progress-transferred').textContent = '0 / 0 MB';
  }

  return {
    init,
    reset,
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
  let totalBytesReceived = 0;
  let transferStartTime = null;
  let transferComplete = false;
  let dataQueue = Promise.resolve();
  let timeoutId = null;
  const lastProgressUpdate = { value: 0 };

  function connect(rawCode) {
    const code = cleanCode(rawCode);
    if (!isValidCode(code)) {
      showError('Enter a valid cd code.');
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
          showError('Transfer failed while receiving data.');
        });
      });

      connection.on('error', () => {
        showError('Connection lost. Please try again.');
      });

      connection.on('close', () => {
        if (!transferComplete && totalBytesReceived < (manifest?.totalSize ?? Infinity)) {
          showError('Connection closed unexpectedly.');
        }
      });
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        showError('Invalid code or sender not available.');
        return;
      }
      showError('Connection error. Please try again.');
    });

    timeoutId = setTimeout(() => {
      if (!connection || !connection.open) {
        showError('Connection timeout. Check the code and try again.');
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  async function handleData(data) {
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
      setFileInfo(els.receiverFileInfo, onlyFile.name, formatSize(onlyFile.size), 'Preparing transfer');
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
    setFileInfo(
      els.receiverFileInfo,
      currentFile.name,
      formatSize(currentFile.size),
      `File ${data.index + 1} of ${manifest.totalFiles}`
    );

    if ('showSaveFilePicker' in window) {
      try {
        currentFileHandle = await window.showSaveFilePicker({
          suggestedName: currentFile.name,
          types: [{ description: currentFile.mimeType, accept: { [currentFile.mimeType]: ['.' + extensionFor(currentFile.name)] } }]
        });
        currentWritable = await currentFileHandle.createWritable();
        setState('saving');
      } catch {
        currentWritable = null;
        currentFileHandle = null;
      }
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
  }

  async function handleFileComplete() {
    if (!currentFile) return;

    if (currentWritable) {
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
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.remove('hidden');
    els.receiverCompleteMessage.textContent =
      manifest && manifest.totalFiles > 1 ? `${manifest.totalFiles} files downloaded` : 'Download complete';
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

  function resetConnectionOnly() {
    peer?.destroy();
    peer = null;
    connection = null;
    manifest = null;
    currentFile = null;
    currentFileChunks = [];
    currentWritable = null;
    currentFileHandle = null;
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
    els.receiverCompleteMessage.textContent = 'Download complete';
    els.codeInput.value = '';
    els.receiverProgress.querySelector('.progress-fill').style.width = '0%';
    els.receiverProgress.querySelector('.progress-percent').textContent = '0%';
    els.receiverProgress.querySelector('.progress-speed').textContent = '0 MB/s';
    els.receiverProgress.querySelector('.progress-transferred').textContent = '0 / 0 MB';
    setState('idle');
  }

  return {
    connect,
    reset
  };
})();

let scanner = null;

async function startScanner() {
  els.scannerStatus.textContent = 'Requesting camera...';
  els.qrReader.classList.remove('hidden');
  els.scanQrBtn.classList.add('hidden');
  els.stopScanBtn.classList.remove('hidden');

  try {
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
    els.scannerStatus.textContent = 'Point the camera at a cd QR code.';
  } catch {
    els.scannerStatus.textContent = 'Camera unavailable. Enter the code manually.';
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
