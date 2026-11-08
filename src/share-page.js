import { mountRelayReceiver } from './share.js';
import './style.css';

// Standalone page for opened `/s/*` links; the main page's Receive tab
// mounts the same receiver inline.
document.body.innerHTML = `
  <canvas id="ambient-dots" class="ambient-dots" aria-hidden="true"></canvas>
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><span class="tagline">/di·rect/</span></div>
      <p class="brand-note">Receive files</p>
      <p class="share-description">Check the file details, then receive. Keep this tab open until verification finishes.</p>
    </header>
    <section class="workbench">
      <div id="relay-receiver"></div><p class="result-actions"><a href="/">Send or receive another file</a></p>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;

// Watermark shows the actual host (cd-test vs prod) instead of hardcoding prod.
try {
  const mark = document.querySelector('.share-transfer-page .watermark a');
  if (mark) mark.textContent = window.location.host;
} catch { /* cosmetic only */ }

const shareUrl = window.location.href;
history.replaceState(null, '', window.location.pathname);
let receiving = true;
window.addEventListener('beforeunload', event => { if (receiving) event.preventDefault(); });
const stop = mountRelayReceiver(document.getElementById('relay-receiver'), shareUrl, { hooks: { onState(state) { receiving = !['complete', 'failed'].includes(state); } } });
window.addEventListener('pagehide', stop, { once: true });
