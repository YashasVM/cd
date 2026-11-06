import { startAmbientDots } from './ambient-dots.js';

const agentShare = /^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(window.location.pathname);
const agentSend = /^\/send\/?$/.test(window.location.pathname);

const diagnostics = import.meta.env.VITE_CD_DIAGNOSTICS === '1'
  ? import('./diagnostics.js') : Promise.resolve(null);
const app = diagnostics.then(() => /^\/diagnostics\//.test(location.pathname) && import.meta.env.VITE_CD_DIAGNOSTICS === '1'
  ? import('./diagnostic-report.js')
  : agentShare ? import('./share-page.js') : agentSend ? import('./agent-send.js') : import('./main.js'));

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

// Cycle the tagline's endpoints one word at a time so every pairing shows:
// browser-to-browser → browser-to-terminal → terminal-to-terminal → terminal-to-browser.
function cycleRoute() {
  const words = document.querySelectorAll('.route .swap');
  if (words.length !== 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const swap = (el, text) => {
    const start = el.getBoundingClientRect().width;
    el.style.width = `${start}px`;
    el.classList.remove('in');
    el.classList.add('out');
    el.addEventListener('animationend', () => {
      el.textContent = text;
      el.style.width = '';
      const target = el.getBoundingClientRect().width;
      el.style.width = `${start}px`;
      el.offsetWidth; // commit the old width so the change transitions
      el.style.width = `${target}px`;
      el.classList.replace('out', 'in');
      // Drop the fixed width afterwards so later font or size changes can't leave a gap.
      el.addEventListener('transitionend', () => { el.style.width = ''; }, { once: true });
    }, { once: true });
  };
  let step = 0;
  setInterval(() => {
    const el = words[(step + 1) % 2];
    swap(el, el.textContent === 'browser' ? 'terminal' : 'browser');
    step++;
  }, 2600);
}

app.then(() => {
  globalThis.cdDiagnostics?.mount();
  const cleanup = () => import('./sink.js').then(({ cleanAbandonedStages }) => cleanAbandonedStages()).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(cleanup);
  else setTimeout(cleanup, 1500);
  startAmbientDots();
  cycleRoute();
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
