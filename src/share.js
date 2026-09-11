import './style.css';

const code = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
const encodedKey = window.location.hash.slice(1);

document.body.innerHTML = `
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><span class="tagline">/di·rect/</span></div>
      <p class="brand-note">private CD relay</p>
      <p class="share-description">A file is being handed to you through CD.</p>
    </header>
    <section class="workbench">
      <div class="share-panel">
        <span class="panel-kicker">incoming transfer</span>
        <p id="status" class="status">Connecting to the sender...</p>
        <a id="download" class="primary-btn share-download" hidden></a>
      </div>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;
const status = document.getElementById('status');
const download = document.getElementById('download');

function decodeBase64Url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const keyPromise = encodedKey
  ? crypto.subtle.importKey('raw', decodeBase64Url(encodedKey), 'AES-GCM', false, ['decrypt'])
  : Promise.reject(new Error('missing transfer key'));
const chunks = [];
let file;

async function decrypt(data) {
  const bytes = new Uint8Array(data);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await keyPromise, bytes.slice(12));
}

const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}`);
socket.binaryType = 'arraybuffer';
socket.addEventListener('open', () => socket.send('hello:receiver'));
socket.addEventListener('error', () => {
  status.textContent = 'This CD transfer is unavailable or has expired.';
});
socket.addEventListener('message', async (event) => {
  if (typeof event.data === 'string') {
    if (event.data === 'ready') status.textContent = 'Receiving securely...';
    if (event.data.startsWith('data:')) {
      try {
        const plaintext = new Uint8Array(await decrypt(decodeBase64(event.data.slice(5))));
        if (!file) {
          file = JSON.parse(new TextDecoder().decode(plaintext));
          status.textContent = `Receiving ${file.filename}...`;
        } else {
          chunks.push(plaintext);
        }
      } catch {
        status.textContent = 'The transfer could not be decrypted.';
        socket.close();
      }
    }
    if (event.data === 'done' && file) {
      const blob = new Blob(chunks, { type: file.mime });
      download.href = URL.createObjectURL(blob);
      download.download = file.filename;
      download.textContent = `Download ${file.filename}`;
      download.hidden = false;
      status.textContent = 'File received.';
      socket.close();
    }
    return;
  }
});
socket.addEventListener('close', () => {
  if (!download || download.hidden) status.textContent = 'The sender is no longer available.';
});
