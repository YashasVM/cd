// Raw data channel for browser P2P. PeerJS `binary` serialization packs
// every chunk with BinaryPack and re-splits it into 16,300-byte messages
// that the receiver reassembles, which caps throughput in JS. When both
// pages support it, they open a second, pre-negotiated RTCDataChannel on the
// same peer connection and exchange the P2P messages directly: JSON strings
// for control messages and ArrayBuffers for file bytes, up to 256 KiB each.
// The receiver announces support in the PeerJS connect metadata; senders that
// don't (the Android app, cached old pages) keep using the PeerJS channel.
//
// The wrapper mimics the slice of the PeerJS DataConnection API the P2P
// sender and receiver use, like the relay tunnel does.

// Both sides create the channel with this SCTP stream id, so it needs no
// signaling. PeerJS's own channel uses the low, DTLS-role-derived ids.
const RAW_CHANNEL_ID = 1000;
const MAX_RAW_CHUNK_BYTES = 256 * 1024;
const MIN_RAW_CHUNK_BYTES = 16 * 1024;

// openRawChannel attaches the raw channel to `owner`, a PeerJS
// DataConnection whose peer connection it shares. Closing the owner closes
// the raw channel with it.
export function openRawChannel(owner) {
  const peerConnection = owner.peerConnection;
  const channel = peerConnection.createDataChannel('cd-raw', { negotiated: true, id: RAW_CHANNEL_ID, ordered: true });
  channel.binaryType = 'arraybuffer';
  const listeners = { open: [], data: [], close: [], error: [] };
  let closed = false;
  const emit = (event, value) => {
    for (const listener of listeners[event]) listener(value);
  };
  channel.addEventListener('open', () => emit('open'));
  channel.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      emit('data', event.data);
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      emit('error', new Error('raw channel sent invalid JSON'));
      return;
    }
    emit('data', message);
  });
  channel.addEventListener('error', (event) => emit('error', event.error ?? new Error('raw channel error')));
  channel.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    emit('close');
  });
  return {
    owner,
    dataChannel: channel,
    get open() { return channel.readyState === 'open'; },
    // The largest file chunk this channel carries in one message.
    get maxChunkBytes() { return rawChunkBytes(peerConnection.sctp?.maxMessageSize); },
    on(event, listener) {
      listeners[event]?.push(listener);
    },
    send(data) {
      channel.send(data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : JSON.stringify(data));
    },
    close() {
      try { channel.close(); } catch { /* Already closed. */ }
    }
  };
}

export function rawChunkBytes(maxMessageSize) {
  if (!Number.isFinite(maxMessageSize) || maxMessageSize <= 0) return MAX_RAW_CHUNK_BYTES;
  return Math.max(MIN_RAW_CHUNK_BYTES, Math.min(MAX_RAW_CHUNK_BYTES, Math.floor(maxMessageSize)));
}

// Receive windows the receiver may announce. Anything outside is ignored and
// the sender keeps the conservative default.
export const MIN_ANNOUNCED_WINDOW = 1024 * 1024;
export const MAX_ANNOUNCED_WINDOW = 64 * 1024 * 1024;

// parseTransferOffer reads the receiver's capabilities from untrusted
// connect metadata.
export function parseTransferOffer(metadata) {
  const window = metadata?.window;
  return {
    raw: metadata?.raw === 1,
    window: Number.isSafeInteger(window) && window >= MIN_ANNOUNCED_WINDOW && window <= MAX_ANNOUNCED_WINDOW ? window : null
  };
}

// receiveWindowFor picks how many unacknowledged bytes this receiver lets a
// sender keep in flight: throughput over a path is at most window / RTT.
export function receiveWindowFor(userAgent, mobileHint) {
  const mobile = mobileHint ?? /Mobi|Android|iPhone|iPad/i.test(userAgent);
  return mobile ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
}
