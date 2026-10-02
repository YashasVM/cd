import { startAmbientDots } from './ambient-dots.js';

const agentShare = /^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(window.location.pathname);
const agentSend = /^\/send\/?$/.test(window.location.pathname);

// Single app: `/s/*` renders the relay receiver, `/send` the relay sender,
// everything else the browser-to-browser P2P UI (which also resolves numeric
// relay codes by redirecting to the share page).
const app = agentShare ? import('./share.js') : agentSend ? import('./agent-send.js') : import('./main.js');

document.getElementById('install-copy')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const hint = button.querySelector('.install-hint');
  try {
    await navigator.clipboard.writeText(button.querySelector('code').textContent);
    hint.textContent = 'copied';
  } catch {
    hint.textContent = 'select & copy';
  }
  setTimeout(() => { hint.textContent = 'copy'; }, 1600);
});

app.then(() => {
  startAmbientDots();
  const workbench = document.querySelector('.workbench');
  workbench?.removeAttribute('inert');
  workbench?.removeAttribute('aria-busy');
}).catch(() => {
  const workbench = document.querySelector('.workbench');
  const state = document.getElementById('app-state');
  if (state) state.textContent = 'offline';
  if (!workbench) return;
  const message = document.createElement('p');
  message.textContent = "CD couldn't load. Check your connection and try again.";
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'primary-btn';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => window.location.reload());
  workbench.replaceChildren(message, retry);
  workbench.removeAttribute('inert');
  workbench.removeAttribute('aria-busy');
});
