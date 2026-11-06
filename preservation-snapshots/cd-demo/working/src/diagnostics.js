import { encodeBase64Url, receiverAdmission } from './agent-protocol.js';
import './diagnostics.css';

const transfers = [];
const mode = new URLSearchParams(location.search).get('mode') === 'relay' ? 'relay' : 'auto';
let panel;
function mount() {
  if (document.getElementById('diagnostics-panel')) return;
  panel = document.createElement('section');
  panel.id = 'diagnostics-panel';
  panel.className = 'diagnostics-panel';
  panel.innerHTML = `<p class="panel-kicker">CD transfer lab</p><h2>Find what slows a transfer down</h2>
    <p>Use your phone on mobile data, or another Wi-Fi network. This demo records transfer timing, connection route and browser performance. It never records file contents, filenames, keys or IP addresses. Reports expire after 24 hours.</p>
    <label>Connection test <select id="diagnostic-mode"><option value="auto">Automatic: try a direct connection</option><option value="relay">Relay only: compare the server route</option></select></label>
    <p class="diagnostic-note">Keep this page open during the transfer. Start a send or enter a code below. Each transfer gets a private report link.</p><div id="diagnostic-transfers"></div>`;
  document.querySelector('.shell')?.prepend(panel);
  panel.querySelector('select').value = mode;
  panel.querySelector('select').addEventListener('change', (event) => {
    cdDiagnostics.mode = event.target.value;
  });
  for (const transfer of transfers) transfer.paint();
}

function start(role, invitation) {
  const started = performance.now();
  const report = {
    version: 1, role, phase: 'connecting', transport: 'relay', startedAt: Date.now(), elapsedMs: 0,
    bytes: 0, total: 0, chunks: 0, peakQueueBytes: 0,
    client: { userAgent: navigator.userAgent.slice(0, 250), mobile: navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent), cores: navigator.hardwareConcurrency || 0, memoryGiB: navigator.deviceMemory || 0, mode: cdDiagnostics.mode },
    timings: {}, samples: [], events: []
  };
  const network = navigator.connection;
  if (network) {
    for (const [key, value] of Object.entries({ effectiveType: network.effectiveType, downlinkMbps: network.downlink, networkRttMs: network.rtt, saveData: network.saveData })) {
      if (value !== undefined && (typeof value !== 'number' || Number.isFinite(value))) report.client[key] = value;
    }
  }
  const id = encodeBase64Url(invitation.id);
  let token;
  const admission = receiverAdmission(invitation).then((value) => { token = encodeBase64Url(value.token); });
  let pc;
  let queueBytes = 0;
  let lastBytes = 0;
  let lastAt = started;
  let sampling = false;
  let finished = false;
  let upload = Promise.resolve();
  let card;
  let uploaded = false;
  let uploadFailed = false;
  const reportUrl = () => `${location.origin}/diagnostics/${id}#${token || ''}`;
  function paint() {
    const host = document.getElementById('diagnostic-transfers');
    if (!host) return;
    if (!card) { card = document.createElement('article'); host.prepend(card); }
    card.innerHTML = `<strong>${role === 'sender' ? 'Sending' : 'Receiving'} · ${report.phase}</strong>
      <div class="diagnostic-stats"><span>${report.transport}<small>route</small></span><span>${(report.bytes / 1048576).toFixed(1)} MiB<small>verified bytes</small></span><span>${(report.samples.at(-1)?.mibPerSecond || 0).toFixed(2)} MiB/s<small>latest speed</small></span><span>${(report.peakQueueBytes / 1048576).toFixed(1)} MiB<small>peak queue</small></span></div>
      <p class="diagnostic-note">${uploadFailed ? 'Report upload failed; local JSON is still available. Retrying automatically.' : uploaded ? 'Measurements saved. Share the private report link to review them.' : 'Collecting measurements...'}</p>
      <div class="diagnostic-actions"><a target="_blank" rel="noopener">Open private report</a><button type="button">Save JSON</button></div>`;
    card.querySelector('a').href = reportUrl();
    card.querySelector('button').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `cd-${role}-diagnostics.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
  }
  function flush() {
    const snapshot = JSON.stringify(report);
    upload = upload.catch(() => {}).then(async () => {
      await admission;
      const response = await fetch(`/api/diagnostics/${id}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: snapshot, keepalive: snapshot.length < 60_000 });
      if (!response.ok) throw new Error('report upload failed');
      uploaded = true; uploadFailed = false;
    }).catch(() => { uploadFailed = true; }).finally(paint);
    return upload;
  }
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const now = performance.now();
      report.elapsedMs = now - started;
      const sample = { atMs: report.elapsedMs, bytes: report.bytes, mibPerSecond: (report.bytes - lastBytes) / 1048576 / Math.max(0.001, (now - lastAt) / 1000), queueBytes, eventLoopLagMs: Math.max(0, now - lastAt - 1000), transport: report.transport, visibility: document.visibilityState };
      lastBytes = report.bytes; lastAt = now;
      if (pc && pc.connectionState !== 'closed') {
        const stats = await pc.getStats();
        let pair;
        for (const item of stats.values()) {
          if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId);
        }
        if (!pair) for (const item of stats.values()) if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item;
        if (pair) {
          for (const [key, value] of Object.entries({ rttMs: pair.currentRoundTripTime === undefined ? undefined : pair.currentRoundTripTime * 1000, availableOutgoingBitrate: pair.availableOutgoingBitrate, rtcBytesSent: pair.bytesSent, rtcBytesReceived: pair.bytesReceived, localCandidateType: stats.get(pair.localCandidateId)?.candidateType, remoteCandidateType: stats.get(pair.remoteCandidateId)?.candidateType, protocol: stats.get(pair.localCandidateId)?.protocol })) {
            if (value !== undefined && (typeof value !== 'number' || Number.isFinite(value))) sample[key] = value;
          }
        }
      }
      report.samples.push(sample);
      if (report.samples.length > 180) report.samples.shift();
      paint();
    } catch { /* Timing and disk measurements remain useful without RTC stats. */ }
    finally { sampling = false; }
  }
  const timer = setInterval(() => void sample(), 1000);
  const publish = setInterval(() => void flush(), 5000);
  const visibility = () => trace.event('visibility', document.visibilityState);
  document.addEventListener('visibilitychange', visibility);
  const pagehide = () => { if (!finished) trace.finish('cancelled'); };
  window.addEventListener('pagehide', pagehide, { once: true });
  const trace = {
    mode: report.client.mode,
    paint,
    event(name, value = '') {
      if (report.events.length < 80) report.events.push({ atMs: performance.now() - started, name, value: String(value).slice(0, 100) });
      if (name === 'code-ready') report.phase = 'waiting';
      if (name === 'accepted') report.phase = 'transferring';
      if (name === 'transport') report.transport = value;
    },
    timing(name, duration) {
      const metric = report.timings[name] ||= { count: 0, totalMs: 0, maxMs: 0 };
      metric.count++; metric.totalMs += duration; metric.maxMs = Math.max(metric.maxMs, duration);
    },
    queue(bytes) { queueBytes = bytes; report.peakQueueBytes = Math.max(bytes, report.peakQueueBytes); },
    progress(bytes, total, chunks, transport) { Object.assign(report, { bytes, total, chunks, transport }); },
    rtc(connection) { pc = connection; },
    finish(phase) {
      if (finished) return;
      finished = true;
      report.phase = phase;
      trace.event(phase);
      clearInterval(timer); clearInterval(publish);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      void sample().then(flush);
    }
  };
  transfers.push(trace);
  admission.then(paint);
  return trace;
}

export const cdDiagnostics = { mode, start, mount };
globalThis.cdDiagnostics = cdDiagnostics;
