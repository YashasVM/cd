import { cleanShortCode, codeLookupPath, isShortCode, parseCapability, shareUrlFromCapability } from './agent-code.js';
import { startRelaySend } from './relay-sender.js';
import { createZipBundle, fileSource } from './zip-bundle.js';
import { startQrScanner } from './qr-scanner.js';
if (import.meta.env?.VITE_CD_DIAGNOSTICS !== '1' && 'serviceWorker' in navigator) {
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


function loadQrCode() {
  qrCodeModulePromise ??= import('qrcode')
    .then((module) => module.default || module)
    .catch((error) => {
      qrCodeModulePromise = undefined;
      throw error;
    });
  return qrCodeModulePromise;
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

const PROGRESS_UPDATE_INTERVAL = 120;
// Agent-relay links (from `cdx send` or a browser terminal-send) look like
// https://cd.yash0.in/s/<22 chars>#v1.<43 chars>. The room lives on the
// sender's origin, so receivers open the pasted link as-is instead of
// treating it as a P2P word code.
const AGENT_LINK_PATH = /^\/s\/([A-Za-z0-9_-]{22})\/?$/;
const AGENT_LINK_KEY = /^v1\.([A-Za-z0-9_-]{43})$/;
const AGENT_BARE_CODE = /^([A-Za-z0-9_-]{22})#v1\.([A-Za-z0-9_-]{43})$/;

function agentShareUrlFromInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !raw.includes('#v1.')) return '';
  const candidates = [raw];
  for (const token of raw.split(/[\s"'<>]+/)) {
    if (token && token !== raw) candidates.push(token);
  }
  for (const candidate of candidates) {
    const bare = AGENT_BARE_CODE.exec(candidate);
    if (bare) return `${window.location.origin}/s/${bare[1]}#v1.${bare[2]}`;
    try {
      const url = new URL(candidate, window.location.href);
      // Only web links: `javascript:/s/...` would otherwise pass the path check.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const path = AGENT_LINK_PATH.exec(url.pathname);
      const key = AGENT_LINK_KEY.exec(url.hash.slice(1));
      if (path && key) return url.toString();
    } catch { /* Not a URL; try the next candidate. */ }
  }
  return '';
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
  senderError: document.getElementById('sender-error'),
  senderErrorMessage: document.querySelector('#sender-error .error-message'),
  senderRetryBtn: document.getElementById('sender-retry-btn'),
  receiveCommand: document.getElementById('receive-command'),
  copyCmdBtn: document.getElementById('copy-cmd-btn'),
  senderComplete: document.getElementById('sender-complete'),
  senderCompleteMessage: document.getElementById('sender-complete-message'),
  senderCompleteDetail: document.getElementById('sender-complete-detail'),
  sendAnotherBtn: document.getElementById('send-another-btn'),
  receiverInputSection: document.getElementById('receiver-input-section'),
  codeInput: document.getElementById('code-input'),
  connectBtn: document.getElementById('connect-btn'),
  scanQrBtn: document.getElementById('scan-qr-btn'),
  stopScanBtn: document.getElementById('stop-scan-btn'),
  scannerStatus: document.getElementById('scanner-status'),
  qrReader: document.getElementById('qr-reader'),
  qrVideo: document.getElementById('qr-video'),
  scannerLive: document.getElementById('scanner-live'),
  receiverConnecting: document.getElementById('receiver-connecting'),
  receiverConnectingCancelBtn: document.getElementById('receiver-connecting-cancel-btn'),
  receiverFileInfo: document.getElementById('receiver-file-info'),
  receiverProgress: document.getElementById('receiver-progress'),
  receiverCancelBtn: document.getElementById('receiver-cancel-btn'),
  receiverComplete: document.getElementById('receiver-complete'),
  receiverCompleteMessage: document.getElementById('receiver-complete-message'),
  receiverCompleteDetail: document.getElementById('receiver-complete-detail'),
  receiverError: document.getElementById('receiver-error'),
  retryBtn: document.getElementById('retry-btn'),
  receiveAnotherBtn: document.getElementById('receive-another-btn'),
  receiverRelay: document.getElementById('receiver-relay'),
  receiverRelayPanel: document.getElementById('receiver-relay-panel'),
  relayDoneBtn: document.getElementById('relay-done-btn')
};

const STATE_LABELS = {
  idle: 'ready',
  connecting: 'connecting',
  waiting: 'waiting for receiver',
  transferring: 'transferring',
  saving: 'saving',
  complete: 'done',
  failed: 'failed'
};
// Closing the tab mid-transfer kills it, so the browser asks first.
const BUSY_STATES = new Set(['connecting', 'waiting', 'transferring', 'saving']);
const BASE_TITLE = document.title;

function setState(state) {
  els.appState.textContent = STATE_LABELS[state] || state;
  els.appState.dataset.state = state;
  if (state === 'complete') document.title = `Done · ${BASE_TITLE}`;
  else if (state === 'failed') document.title = `Failed · ${BASE_TITLE}`;
  else if (state !== 'transferring') document.title = BASE_TITLE;
}

window.addEventListener('beforeunload', (event) => {
  if (BUSY_STATES.has(els.appState.dataset.state)) event.preventDefault();
});

// shortenMiddle keeps both ends of a long filename, where the extension and
// the distinguishing suffix usually are.
function shortenMiddle(text, max = 32) {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(-Math.floor(keep / 2))}`;
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
  refs.speed.textContent = '–';
  refs.transferred.textContent = '–';
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
  document.title = `${Math.floor(percent)}% · ${BASE_TITLE}`;
  // No speed until bytes move: "0 B/s" while connecting reads as a stall.
  refs.speed.textContent = bytes > 0 ? `${formatSize(refs.emaSpeed)}/s` : '–';
  refs.transferred.textContent = `${formatSize(bytes)} / ${formatSize(total)}`;
  if (refs.eta) {
    refs.eta.textContent = bytes >= total || refs.emaSpeed <= 0 ? '–' : formatEta((total - bytes) / refs.emaSpeed);
  }

  return now;
}

// Browser sends go through the relay with the same protocol as `cdx send`,
// so one numeric code works in any browser Receive box and in
// `cdx receive`. Several files travel as one .zip.
const Sender = (() => {
  let active = null;
  let files = [];
  let share = null;
  let totalSize = 0;
  let generation = 0;
  let startedAt = 0;
  const lastProgressUpdate = { value: 0 };

  function init(selectedFiles) {
    reset();
    files = selectedFiles.filter(Boolean);
    if (files.length === 0) return;
    totalSize = files.reduce((sum, item) => sum + item.size, 0);

    let source;
    try {
      source = files.length === 1 ? fileSource(files[0]) : createZipBundle(files);
    } catch {
      setFileInfo(els.senderFileInfo, `${files.length} files selected`, formatSize(totalSize), 'Together these are over 4 GB. Send them in smaller batches.');
      setState('failed');
      return;
    }
    els.dropZone.classList.add('hidden');
    renderSelectionSummary(source);

    const current = ++generation;
    active = startRelaySend(source, {
      onShare(value) {
        if (current !== generation) return;
        share = value;
        els.shareCode.textContent = value.code;
        els.receiveCommand.textContent = `cdx receive ${value.code}`;
        els.senderCodeSection.classList.remove('hidden');
        void renderQr(value.url, current);
      },
      onState(state) {
        if (current !== generation) return;
        if (state === 'transferring' && !startedAt) {
          startedAt = Date.now();
          els.senderCodeSection.classList.add('hidden');
          els.senderProgress.classList.remove('hidden');
        }
        if (state !== 'complete') setState(state);
      },
      onStatus(text) {
        if (current === generation) els.senderStatus.textContent = text;
      },
      onTransport(route) { els.senderView.dataset.transport = route; },
      onProgress(done, total) {
        if (current !== generation) return;
        lastProgressUpdate.value = updateProgress(els.senderProgress, done, total, startedAt || Date.now(), done === total, lastProgressUpdate);
      }
    });
    active.done.then(() => {
      if (current === generation) showComplete();
    }, (error) => {
      if (current === generation && error.message !== 'Transfer canceled.') failSend(error.message);
    });
  }

  function renderSelectionSummary(source) {
    if (files.length === 1) {
      setFileInfo(els.senderFileInfo, files[0].name, formatSize(files[0].size), '');
      return;
    }
    const previewNames = files.slice(0, 3).map((item) => item.name).join(', ');
    const remaining = files.length - 3;
    const suffix = remaining > 0 ? ` + ${remaining} more` : '';
    setFileInfo(els.senderFileInfo, `${files.length} files`, formatSize(totalSize), `${previewNames}${suffix} · arrives as ${source.name}`);
  }

  async function renderQr(url, current) {
    const QRCode = await loadQrCode().catch(() => null);
    if (!QRCode || current !== generation) return;
    // The QR holds the private link, so a phone camera opens the transfer
    // directly without typing anything.
    await QRCode.toCanvas(els.shareQr, url, {
      margin: 2,
      width: 220,
      color: { dark: '#0d0503', light: '#e4d4b6' }
    });
  }

  function showComplete() {
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderComplete.classList.remove('hidden');
    els.senderCompleteMessage.textContent = files.length === 1 ? 'Sent' : `Sent ${files.length} files`;
    els.senderCompleteDetail.textContent = files.length === 1
      ? `${shortenMiddle(files[0].name, 48)} · ${formatSize(totalSize)}`
      : formatSize(totalSize);
    setState('complete');
  }

  function failSend(message) {
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderErrorMessage.textContent = message;
    els.senderError.classList.remove('hidden');
    setState('failed');
  }

  function cancel() {
    reset();
    setState('idle');
  }

  function reset() {
    generation += 1;
    active?.cancel();
    active = null;
    files = [];
    share = null;
    totalSize = 0;
    startedAt = 0;
    lastProgressUpdate.value = 0;
    els.dropZone.classList.remove('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.add('hidden');
    els.senderError.classList.add('hidden');
    els.senderStatus.textContent = '';
    resetProgress(els.senderProgress);
  }

  return {
    init,
    reset,
    cancel,
    copyCode: () => share && copyText(share.code, els.copyCodeBtn, 'Copied'),
    copyLink: () => share && copyText(share.url, els.copyLinkBtn, 'Copied'),
    copyCommand: () => share && copyText(`cdx receive ${share.code}`, els.copyCmdBtn, 'Copied')
  };
})();

const Receiver = (() => {
  let generation = 0;
  let stopRelay = null;
  let lookup = null;

  function reset() {
    generation++;
    lookup?.abort();
    lookup = null;
    stopRelay?.();
    stopRelay = null;
    els.receiverRelayPanel.replaceChildren();
    for (const element of [els.receiverRelay, els.receiverConnecting, els.receiverError]) element.classList.add('hidden');
    els.receiverInputSection.classList.remove('hidden');
    els.codeInput.value = '';
    setState('idle');
  }

  function showError(message) {
    els.receiverConnecting.classList.add('hidden');
    els.receiverError.querySelector('.error-message').textContent = message;
    els.receiverError.classList.remove('hidden');
    setState('failed');
  }

  async function openRelay(value) {
    const target = new URL(value, location.href);
    if (target.origin !== location.origin) { location.href = target.href; return; }
    reset();
    stopScanner();
    const current = generation;
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    setState('connecting');
    try {
      const { mountRelayReceiver } = await import('./share.js');
      if (current !== generation) return;
      els.receiverConnecting.classList.add('hidden');
      els.receiverRelay.classList.remove('hidden');
      stopRelay = mountRelayReceiver(els.receiverRelayPanel, target.href, { autoReceive: true, onState: setState });
    } catch { if (current === generation) showError('Could not load the receiver. Check your connection and try again.'); }
  }

  async function connect(value) {
    const url = agentShareUrlFromInput(value);
    if (url) { await openRelay(url); return; }
    const code = codeFromInput(value);
    if (!isShortCode(code)) {
      els.scannerStatus.textContent = 'Enter a 5-digit code or paste a share link. For an old word code, ask the sender to reload CD.';
      els.codeInput.setAttribute('aria-invalid', 'true');
      return;
    }
    reset();
    stopScanner();
    const current = generation;
    lookup = new AbortController();
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    setState('connecting');
    const timer = setTimeout(() => lookup?.abort(), 15_000);
    try {
      const response = await fetch(codeLookupPath(code), { signal: lookup.signal });
      if (current !== generation) return;
      if (!response.ok) throw new Error(response.status === 404 ? 'No transfer with that code. Ask the sender for a fresh code.' : 'Could not look up the code. Try again shortly.');
      const capability = parseCapability(await response.json());
      if (current !== generation) return;
      await openRelay(shareUrlFromCapability(location.origin, capability.transferId, capability.key));
    } catch (error) {
      if (current === generation) showError(error.name === 'AbortError' ? 'Code lookup timed out. Check your connection and retry.' : error.message);
    } finally { clearTimeout(timer); }
  }
  return { connect, openRelay, reset, cancel: reset };
})();

function codeFromInput(value) {
  const text = String(value ?? '').trim();
  if (isShortCode(text)) return text;
  try {
    const code = new URL(text, location.href).hash.slice(1);
    return isShortCode(code) ? code : '';
  } catch { return ''; }
}

let stopCamera = null;
let scannerGeneration = 0;

function closeScannerView() {
  stopCamera?.();
  stopCamera = null;
  els.qrReader.classList.add('hidden');
  document.documentElement.classList.remove('scanning');
}

async function startScanner() {
  const generation = ++scannerGeneration;
  els.scannerLive.textContent = 'Starting the camera…';
  els.qrReader.classList.remove('hidden');
  document.documentElement.classList.add('scanning');
  els.stopScanBtn.focus();
  try {
    const stop = await startQrScanner(els.qrVideo, (text) => {
      if (generation !== scannerGeneration) return true;
      const value = text.trim();
      // Anything the Receive box accepts: a numeric code, a private /s/ link,
      // or a private share link.
      if (!isShortCode(codeFromInput(value)) && !agentShareUrlFromInput(value)) {
        els.scannerLive.textContent = 'That QR code isn’t from CD. Point at the code on the sender’s screen.';
        return false;
      }
      scannerGeneration += 1;
      closeScannerView();
      if (navigator.vibrate) navigator.vibrate(40);
      Receiver.connect(value);
      return true;
    });
    if (generation !== scannerGeneration) {
      stop();
      return;
    }
    stopCamera = stop;
    els.scannerLive.textContent = 'Point it at the QR code on the sender’s screen.';
  } catch (error) {
    if (generation !== scannerGeneration) return;
    closeScannerView();
    els.scannerStatus.textContent = error?.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or type the code.'
      : 'No camera available. Type the code instead.';
  }
}

function stopScanner() {
  scannerGeneration += 1;
  closeScannerView();
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

els.copyCodeBtn.addEventListener('click', () => void Sender.copyCode());
els.copyLinkBtn.addEventListener('click', () => void Sender.copyLink());
els.sendAnotherBtn.addEventListener('click', () => {
  Sender.reset();
  els.fileInput.value = '';
  setState('idle');
});
els.senderCancelBtn.addEventListener('click', () => Sender.cancel());
els.senderRetryBtn.addEventListener('click', () => {
  Sender.reset();
  els.fileInput.value = '';
  setState('idle');
});
els.copyCmdBtn.addEventListener('click', () => void Sender.copyCommand());

let autoConnectTimer = null;

function connectEnteredCode() {
  clearTimeout(autoConnectTimer);
  els.codeInput.blur();
  Receiver.connect(els.codeInput.value);
}

els.connectBtn.addEventListener('click', connectEnteredCode);
els.codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectEnteredCode();
});
els.codeInput.addEventListener('input', (event) => {
  clearTimeout(autoConnectTimer);
  const raw = event.target.value;
  // Agent links (from `cdx send`) open the relay receiver instead of
  // being cleaned into a P2P code. Check before mangling the pasted text.
  const agentUrl = agentShareUrlFromInput(raw);
  if (agentUrl) {
    Receiver.openRelay(agentUrl);
    return;
  }
  // Pasting a full link via autofill/drag doesn't fire a paste event, so
  // detect link characters and extract the code instead of mangling it.
  event.target.value = /[:\/#.]/.test(raw) ? codeFromInput(raw) : raw.replace(/[^0-9]/g, '').slice(0, 5);
  els.codeInput.removeAttribute('aria-invalid');
  // Five digits is the longest numeric code, so nothing else is coming.
  if (/^\d{5}$/.test(event.target.value.trim())) connectEnteredCode();
  else if (/^\d{4}$/.test(event.target.value.trim())) {
    autoConnectTimer = setTimeout(() => {
      if (!els.receiverInputSection.classList.contains('hidden') &&
          els.receiveModeBtn.getAttribute('aria-selected') === 'true') connectEnteredCode();
    }, 800);
  }
});
els.codeInput.addEventListener('paste', (event) => {
  clearTimeout(autoConnectTimer);
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text');
  const agentUrl = agentShareUrlFromInput(text);
  if (agentUrl) {
    Receiver.openRelay(agentUrl);
    return;
  }
  els.codeInput.value = codeFromInput(text);
  els.codeInput.removeAttribute('aria-invalid');
  // A pasted code is complete; don't make people find the Connect button.
  if (isShortCode(text)) Receiver.connect(text);
  else if (isShortCode(els.codeInput.value)) Receiver.connect(els.codeInput.value);
});

els.scanQrBtn.addEventListener('click', () => void startScanner());
els.stopScanBtn.addEventListener('click', () => stopScanner());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.qrReader.classList.contains('hidden')) stopScanner();
});
els.receiveAnotherBtn.addEventListener('click', () => Receiver.reset());
els.relayDoneBtn.addEventListener('click', () => Receiver.reset());
els.retryBtn.addEventListener('click', () => Receiver.reset());
els.receiverCancelBtn.addEventListener('click', () => Receiver.cancel());
els.receiverConnectingCancelBtn.addEventListener('click', () => Receiver.reset());

// Pasting files anywhere on the Send tab starts a transfer immediately.
window.addEventListener('paste', (event) => {
  if (!els.senderView.classList.contains('active')) return;
  const files = Array.from(event.clipboardData?.files || []).filter(Boolean);
  if (files.length > 0) Sender.init(files);
});

// Files dropped anywhere on the page start a send, not just on the drop
// zone. Only while nothing else is in flight; elsewhere drops are swallowed
// so the browser doesn't navigate away to the file.
function acceptsFileDrop(event) {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return false;
  if (els.appState.dataset.state !== 'idle') return false;
  return els.senderView.classList.contains('active')
    ? !els.dropZone.classList.contains('hidden')
    : !els.receiverInputSection.classList.contains('hidden');
}

let dragDepth = 0;
function setDragging(on) {
  document.body.classList.toggle('dragging-files', on);
  els.dropZone.classList.toggle('drag-over', on);
}
window.addEventListener('dragenter', (event) => {
  if (!acceptsFileDrop(event)) return;
  dragDepth++;
  setDragging(true);
});
window.addEventListener('dragleave', () => {
  if (dragDepth === 0) return;
  dragDepth--;
  if (dragDepth === 0) setDragging(false);
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = acceptsFileDrop(event) ? 'copy' : 'none';
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (!acceptsFileDrop(event)) return;
  const files = Array.from(event.dataTransfer.files);
  if (files.length === 0) return;
  switchToSendMode();
  Sender.init(files);
});

const initialCode = codeFromInput(location.href);
if (isShortCode(initialCode)) {
  history.replaceState(null, '', location.pathname + location.search);
  switchToReceiveMode();
  els.codeInput.value = initialCode;
  Receiver.connect(initialCode);
} else {
  setState('idle');
}
