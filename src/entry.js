const agentShare = /^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(window.location.pathname);

// Opened share links use the receiver; / and /send share the same app.
const app = agentShare ? import('./share-page.js') : import('./main.js');

// Lead with the installer for the visitor's OS; the other one stays as the alternative.
if (/Win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) {
  const main = document.querySelector('#install-copy code');
  const alt = document.querySelector('.install-alt code');
  const altOs = document.querySelector('.install-alt-os');
  if (main && alt && altOs) {
    [main.textContent, alt.textContent] = [alt.textContent, main.textContent];
    altOs.textContent = 'macOS / Linux';
    document.querySelector('.install-prompt').textContent = '>';
  }
}

document.getElementById('install-toggle')?.addEventListener('click', (event) => {
  const toggle = event.currentTarget;
  const panel = document.getElementById('install-panel');
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  panel.classList.toggle('open', open);
  panel.inert = !open;
});

document.getElementById('install-copy')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const hint = button.querySelector('.install-hint');
  let copied = true;
  try {
    await navigator.clipboard.writeText(button.querySelector('code').textContent);
  } catch {
    copied = false;
  }
  hint.textContent = copied ? 'copied' : 'select it';
  button.classList.remove('copied');
  button.offsetWidth; // restart the animation on repeat clicks
  if (copied) button.classList.add('copied');
  clearTimeout(button.resetHint);
  button.resetHint = setTimeout(() => {
    hint.textContent = 'copy';
    button.classList.remove('copied');
  }, 1800);
});

app.then(() => {
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
