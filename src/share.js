const code = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
const encodedKey = window.location.hash.slice(1);

document.body.innerHTML = `
  <main style="max-width:560px;margin:12vh auto;padding:24px;font:16px system-ui;color:#f4eadb;background:#160806">
    <h1>cd</h1><p id="status">Connecting to the sender...</p>
    <a id="download" hidden></a>
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

const keyPromise = crypto.subtle.importKey('raw', decodeBase64Url(encodedKey), 'AES-GCM', false, ['decrypt']);
const chunks = [];
let file;

async function decrypt(data) {
  const bytes = new Uint8Array(data);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await keyPromise, bytes.slice(12));
}

const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}`);
socket.binaryType = 'arraybuffer';
socket.addEventListener('open', () => socket.send('hello:receiver'));
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
