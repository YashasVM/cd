import {
  KIND_TUNNEL_BYTES,
  KIND_TUNNEL_JSON,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  decodeBase64Url,
  encodeBase64Url,
  receiverAdmission
} from './agent-protocol.js';

// Relay fallback for browser P2P. When the WebRTC data channel cannot
// connect (CGNAT, mobile data, strict firewalls: no TURN on the free plan),
// both pages meet in a relay room and exchange the same P2P messages as
// encrypted records. The tunnel mimics the slice of the PeerJS
// DataConnection API the P2P sender and receiver use: `open`, `send`,
// `close`, `on('open' | 'data' | 'close' | 'error')`, and
// `dataChannel.bufferedAmount` for backpressure.
//
// The receiver mints the capability and creates the room; it reaches the
// sender inside the PeerJS connect metadata. Signaling therefore sees the
// key, the same trust as short share codes.

const ADMISSION_WAIT_MS = 10_000;
const JOIN_RETRY_MS = 300;
const JOIN_DEADLINE_MS = 10_000;
// Relay close code for "the room has no sender yet": the joiner raced the
// creator and retries.
const ROOM_NOT_READY = 4404;

export function generateTunnelCapability() {
  return {
    transferId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    key: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  };
}

// parseTunnelCapability validates the capability from untrusted connect
// metadata; it returns null when the peer did not offer a usable one.
export function parseTunnelCapability(value) {
  const relay = value?.relay;
  if (!relay || typeof relay !== 'object') return null;
  if (typeof relay.transferId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(relay.transferId)) return null;
  if (typeof relay.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(relay.key)) return null;
  return { transferId: relay.transferId, key: relay.key };
}

export function relaySocketUrl(location, transferId) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/v1/${transferId}`;
}

// openRelayTunnel connects to the room. role 'creator' opens the room and
// waits for the peer; role 'joiner' enters an existing room, retrying
// briefly if it arrives before the creator. connect(url) returns a
// WebSocket-like object.
export function openRelayTunnel({ capability, role, connect, location = globalThis.location }) {
  const invitation = { id: decodeBase64Url(capability.transferId), key: decodeBase64Url(capability.key) };
  const listeners = { open: [], data: [], close: [], error: [] };
  let socket = null;
  let open = false;
  let closed = false;
  let sealer = null;
  let opener = null;
  let queuedBytes = 0;
  // Sealing and opening are async and sequence-numbered, so both run on
  // strict promise chains to keep records in order.
  let sendChain = Promise.resolve();
  let receiveChain = Promise.resolve();
  const deadline = Date.now() + JOIN_DEADLINE_MS;

  const emit = (event, value) => {
    for (const listener of listeners[event]) listener(value);
  };

  function fail(error) {
    if (closed) return;
    emit('error', error);
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    open = false;
    try { socket?.close(1000, 'done'); } catch { /* Already closing. */ }
    emit('close');
  }

  async function start() {
    const creator = role === 'creator';
    const ownDirection = creator ? SENDER_DIRECTION : RECEIVER_DIRECTION;
    const peerDirection = creator ? RECEIVER_DIRECTION : SENDER_DIRECTION;
    const admission = await receiverAdmission(invitation);
    sealer = await createSealer(invitation, ownDirection, { tunnel: true });
    opener = await createOpener(invitation, peerDirection, { tunnel: true });
    const join = creator
      ? { type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: encodeBase64Url(admission.digest) }
      : { type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: encodeBase64Url(admission.token) };
    while (!closed) {
      const outcome = await attempt(join);
      if (outcome !== 'retry') return;
      if (creator || Date.now() + JOIN_RETRY_MS > deadline) {
        fail(new Error('relay room unavailable'));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, JOIN_RETRY_MS));
    }
  }

  // attempt resolves 'retry' when the room had no creator yet, otherwise
  // 'done' once the socket is live or failed.
  function attempt(join) {
    return new Promise((resolve) => {
      const current = connect(relaySocketUrl(location, capability.transferId));
      socket = current;
      current.binaryType = 'arraybuffer';
      let admitted = false;
      const admissionTimer = setTimeout(() => {
        if (!admitted) {
          fail(new Error('relay did not admit the tunnel'));
          resolve('done');
        }
      }, ADMISSION_WAIT_MS);
      current.addEventListener('open', () => current.send(JSON.stringify(join)));
      current.addEventListener('message', (event) => {
        if (socket !== current || closed) return;
        if (typeof event.data === 'string') {
          let message;
          try { message = JSON.parse(event.data); } catch { message = null; }
          if (message?.type === 'accepted') {
            admitted = true;
            clearTimeout(admissionTimer);
            resolve('done');
          } else if (message?.type === 'peer-joined' && !open) {
            open = true;
            emit('open');
          } else if (message?.type === 'peer-left') {
            close();
          } else {
            fail(new Error('relay sent an unexpected event'));
          }
          return;
        }
        receiveChain = receiveChain.then(async () => {
          if (closed) return;
          const { kind, plaintext } = await opener.open(event.data);
          if (closed) return;
          emit('data', kind === KIND_TUNNEL_JSON ? JSON.parse(new TextDecoder().decode(plaintext)) : plaintext.buffer);
        }).catch((error) => fail(error));
      });
      current.addEventListener('close', (event) => {
        if (socket !== current) return;
        clearTimeout(admissionTimer);
        if (!admitted && event.code === ROOM_NOT_READY && !closed) {
          resolve('retry');
          return;
        }
        resolve('done');
        if (!closed) {
          if (!open) emit('error', new Error(`relay closed the tunnel (${event.code})`));
          close();
        }
      });
    });
  }

  start().catch((error) => fail(error));

  return {
    get open() { return open; },
    // P2P backpressure reads bufferedAmount; queued plaintext still waiting
    // to be sealed counts too.
    dataChannel: {
      bufferedAmountLowThreshold: 0,
      get bufferedAmount() { return queuedBytes + (socket?.bufferedAmount ?? 0); }
    },
    on(event, listener) {
      listeners[event]?.push(listener);
    },
    send(data) {
      if (!open) throw new Error('relay tunnel is not open');
      const bytes = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
      const plaintext = bytes
        ? new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : new TextEncoder().encode(JSON.stringify(data));
      const kind = bytes ? KIND_TUNNEL_BYTES : KIND_TUNNEL_JSON;
      queuedBytes += plaintext.byteLength;
      const target = socket;
      sendChain = sendChain.then(async () => {
        const record = await sealer.seal(kind, plaintext);
        queuedBytes -= plaintext.byteLength;
        if (!closed && socket === target) target.send(record);
      }).catch((error) => fail(error));
    },
    close
  };
}
