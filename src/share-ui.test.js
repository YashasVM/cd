import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  KIND_OFFER,
  KIND_CHUNK,
  SENDER_DIRECTION,
  createSealer,
  encodeBase64Url,
  parseInvitation
} from './agent-protocol.js';
import { formatEta, formatCountdown, mountRelayReceiver } from './share.js';

// A tiny DOM double for the relay receiver panel. `mountRelayReceiver`
// renders PANEL_HTML into `container.innerHTML` and looks elements up with
// `[data-relay="…"]` plus two nested `.progress-*` selectors; these stand in
// for that without a full document.
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.href = '';
    this.download = '';
    this.style = {};
    this.attributes = {};
    this.children = [];
    this._listeners = new Map();
    this.bySelector = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((fn) => fn !== handler));
  }
  dispatch(type, event = {}) {
    for (const handler of this._listeners.get(type) || []) handler(event);
  }
  click() {
    this.dispatch('click', { preventDefault() {}, target: this });
  }
  append(...nodes) { this.children.push(...nodes); }
  querySelector(selector) {
    if (this.bySelector?.has(selector)) return this.bySelector.get(selector);
    throw new Error(`FakeElement.querySelector("${selector}") is not mocked`);
  }
}

class FakeContainer {
  constructor() {
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.elements = {};
    this._build();
  }
  _build() {
    const mk = (tag) => new FakeElement(tag);
    const status = mk('p');
    const offer = mk('div'); offer.hidden = true;
    const fileName = mk('strong');
    const fileSize = mk('span');
    const accept = mk('button');
    const progress = mk('div'); progress.hidden = true;
    const progressBar = mk('div');
    const progressFill = mk('div');
    const progressCopy = mk('span');
    const download = mk('a'); download.hidden = true;
    const files = mk('ul'); files.hidden = true;
    const cancel = mk('button');

    progress.bySelector = new Map([
      ['.progress-bar', progressBar],
      ['.progress-fill', progressFill]
    ]);

    this.elements = { status, offer, fileName, fileSize, accept, progress, progressBar, progressFill, progressCopy, download, files, cancel };
    this._selectors = new Map([
      ['[data-relay="status"]', status],
      ['[data-relay="offer"]', offer],
      ['[data-relay="file-name"]', fileName],
      ['[data-relay="file-size"]', fileSize],
      ['[data-relay="accept"]', accept],
      ['[data-relay="progress"]', progress],
      ['[data-relay="progress-copy"]', progressCopy],
      ['[data-relay="download"]', download],
      ['[data-relay="files"]', files],
      ['[data-relay="cancel"]', cancel]
    ]);
  }
  querySelector(selector) {
    const element = this._selectors.get(selector);
    if (element) return element;
    throw new Error(`FakeContainer.querySelector("${selector}") is not mocked`);
  }
}

// Installs the browser globals `mountRelayReceiver` needs (window, location,
// navigator, WebSocket) and restores them when the test finishes. Returns the
// minted v1 share link, its parsed invitation, and the receiver's WebSocket.
function setupReceiver(t) {
  const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const key = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const shareUrl = `http://localhost:9999/s/${id}#v1.${key}`;
  const invitation = parseInvitation(new URL(shareUrl));

  let socketInstance = null;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.bufferedAmount = 0;
      this.readyState = 1;
      this.binaryType = 'arraybuffer';
      this.sent = [];
      this.closes = [];
      socketInstance = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data) { this.sent.push(data); }
    close(code, reason) {
      this.readyState = 3;
      this.closes.push({ code, reason });
      const event = new Event('close');
      Object.defineProperty(event, 'code', { value: code });
      Object.defineProperty(event, 'reason', { value: reason });
      this.dispatchEvent(event);
    }
    message(data) {
      const event = new Event('message');
      event.data = data;
      this.dispatchEvent(event);
    }
  }

  const names = ['window', 'location', 'navigator', 'WebSocket', 'RTCPeerConnection', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const events = new EventTarget();
  globalThis.window = {
    location: new URL(shareUrl),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  };
  globalThis.location = new URL(shareUrl);
  // `navigator` is a getter-only global in modern Node, so define it instead
  // of assigning.
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true, writable: true });
  globalThis.WebSocket = FakeSocket;
  globalThis.RTCPeerConnection = undefined;
  globalThis.requestAnimationFrame = (callback) => { callback(); return 0; };
  globalThis.cancelAnimationFrame = () => {};

  return { shareUrl, invitation, getSocket: () => socketInstance };
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await delay(5);
  }
}

test('formatEta renders sub-minute, minute, and hour durations', () => {
  assert.equal(formatEta(NaN), '');
  assert.equal(formatEta(Infinity), '');
  assert.equal(formatEta(-1), '');
  assert.equal(formatEta(0), '<1s');
  assert.equal(formatEta(0.5), '<1s');
  assert.equal(formatEta(1), '1s');
  assert.equal(formatEta(59), '59s');
  assert.equal(formatEta(60), '1m 0s');
  assert.equal(formatEta(90), '1m 30s');
  assert.equal(formatEta(3599), '59m 59s');
  assert.equal(formatEta(3600), '1h 0m');
  assert.equal(formatEta(3660), '1h 1m');
  assert.equal(formatEta(7200), '2h 0m');
});

test('formatCountdown renders a wait timer as M:SS', () => {
  assert.equal(formatCountdown(NaN), '');
  assert.equal(formatCountdown(-1), '');
  assert.equal(formatCountdown(0), '<1s');
  assert.equal(formatCountdown(0.5), '<1s');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(59), '0:59');
  assert.equal(formatCountdown(60), '1:00');
  assert.equal(formatCountdown(899), '14:59');
  assert.equal(formatCountdown(900), '15:00');
});

test('mountRelayReceiver paints progress and omits the "left" suffix at 100%', async (t) => {
  const { shareUrl, invitation, getSocket } = setupReceiver(t);
  const container = new FakeContainer();
  const states = [];
  const progress = [];
  const senderSealer = await createSealer(invitation, SENDER_DIRECTION);

  const stop = mountRelayReceiver(container, shareUrl, {
    autoReceive: true,
    hooks: {
      onState: (state) => states.push(state),
      onProgress: (received, total, percent) => progress.push({ received, total, percent })
    }
  });

  await waitFor(() => getSocket() && getSocket().sent.some((data) => typeof data === 'string'), 'receiver never joined the relay');

  const payload = new TextEncoder().encode('hello');
  const offer = await senderSealer.seal(KIND_OFFER, new TextEncoder().encode(JSON.stringify({
    name: 'hello.txt', mediaType: 'text/plain', size: String(payload.length), chunkSize: 64 * 1024
  })));
  getSocket().message(offer);
  await waitFor(() => states.includes('transferring'), 'receiver never reached transferring');

  getSocket().message(await senderSealer.seal(KIND_CHUNK, payload));
  await waitFor(() => progress.some((entry) => entry.received === BigInt(payload.length)), 'progress never reached the full size');

  const last = progress.at(-1);
  assert.equal(last.received, BigInt(payload.length));
  assert.equal(last.total, BigInt(payload.length));
  assert.equal(last.percent, 100);
  assert.match(container.elements.progressCopy.textContent, /^100\.0% · 5 B \/ 5 B/);
  assert.ok(!container.elements.progressCopy.textContent.includes('left'), '100% must not carry a "left" suffix');
  assert.equal(container.elements.status.textContent, 'Verifying file…');

  stop();
});

test('mountRelayReceiver cancel stops the transfer and reports idle', async (t) => {
  const { shareUrl, invitation, getSocket } = setupReceiver(t);
  const container = new FakeContainer();
  const states = [];
  let cancels = 0;
  const senderSealer = await createSealer(invitation, SENDER_DIRECTION);

  const stop = mountRelayReceiver(container, shareUrl, {
    autoReceive: true,
    hooks: {
      onState: (state) => states.push(state),
      onCancel: () => { cancels += 1; }
    }
  });

  await waitFor(() => getSocket() && getSocket().sent.some((data) => typeof data === 'string'), 'receiver never joined the relay');

  const payload = new TextEncoder().encode('hello world');
  const offer = await senderSealer.seal(KIND_OFFER, new TextEncoder().encode(JSON.stringify({
    name: 'hello.txt', mediaType: 'text/plain', size: String(payload.length), chunkSize: 64 * 1024
  })));
  getSocket().message(offer);
  await waitFor(() => states.includes('transferring'), 'receiver never reached transferring');

  container.elements.cancel.click();
  assert.equal(container.elements.status.textContent, 'Transfer canceled.');
  assert.equal(container.elements.offer.hidden, true);
  assert.equal(container.elements.progress.hidden, true);
  assert.equal(container.elements.cancel.hidden, true);
  assert.equal(states.at(-1), 'idle');
  assert.equal(cancels, 1);

  stop();
});
