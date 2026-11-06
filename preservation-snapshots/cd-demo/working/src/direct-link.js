const HEADER_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const DIRECT_CHANNEL_ID = 1;
export const DIRECT_PIECE_BYTES = 64 * 1024;
export const DIRECT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

export function parseDirectOffer(offer) {
  const sdp = offer?.direct?.sdp;
  return typeof sdp === 'string' && sdp.length > 0 && sdp.length <= MAX_SDP_BYTES ? sdp : null;
}

export function splitRecord(record) {
  const pieces = [];
  for (let start = 0; start < record.byteLength; start += DIRECT_PIECE_BYTES) {
    pieces.push(record.subarray(start, Math.min(start + DIRECT_PIECE_BYTES, record.byteLength)));
  }
  return pieces;
}

export function createRecordAssembler() {
  const header = new Uint8Array(HEADER_BYTES);
  let filled = 0;
  let record = null;
  return {
    push(piece) {
      const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      const records = [];
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (!record) {
          const take = Math.min(HEADER_BYTES - filled, bytes.byteLength - offset);
          header.set(bytes.subarray(offset, offset + take), filled);
          offset += take;
          filled += take;
          if (filled < HEADER_BYTES) continue;
          if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== 1) throw new Error('The direct connection sent an invalid record.');
          const length = HEADER_BYTES + new DataView(header.buffer).getUint32(8) + TAG_BYTES;
          if (length > MAX_RECORD_BYTES) throw new Error('The direct connection sent an oversized record.');
          record = new Uint8Array(length);
          record.set(header);
        }
        const take = Math.min(record.byteLength - filled, bytes.byteLength - offset);
        record.set(bytes.subarray(offset, offset + take), filled);
        offset += take;
        filled += take;
        if (filled === record.byteLength) {
          records.push(record);
          record = null;
          filled = 0;
        }
      }
      return records;
    }
  };
}

// Bytes stay charged while reordered AND while the consumer processes them.
export function createRecordMerger({ maxBytes = MAX_PENDING_BYTES } = {}) {
  let expected = 0;
  let bytesHeld = 0;
  const pending = new Map();
  return {
    get bufferedBytes() { return bytesHeld; },
    push(record) {
      const bytes = record instanceof Uint8Array ? record : new Uint8Array(record);
      if (bytes.byteLength < HEADER_BYTES + TAG_BYTES || bytes.byteLength > MAX_RECORD_BYTES) throw new Error('The sender sent an invalid record.');
      const sequence = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0);
      if (sequence < expected || pending.has(sequence)) return [];
      if (pending.size >= 256 || bytesHeld + bytes.byteLength > maxBytes) throw new Error('The sender exceeded the safe receive buffer.');
      bytesHeld += bytes.byteLength;
      pending.set(sequence, bytes);
      const ready = [];
      while (pending.has(expected)) {
        ready.push(pending.get(expected));
        pending.delete(expected++);
      }
      return ready;
    },
    release(record) { bytesHeld -= record.byteLength; },
    clear() { pending.clear(); bytesHeld = 0; }
  };
}

function createDirect({ onRecord, onOpen = () => {}, onLost, trace, RTCPeerConnectionImpl = globalThis.RTCPeerConnection }) {
  const connection = new RTCPeerConnectionImpl({ iceServers: DIRECT_ICE_SERVERS });
  const channel = connection.createDataChannel('cd-direct', { negotiated: true, id: DIRECT_CHANNEL_ID, ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;
  const assembler = createRecordAssembler();
  let lost = false;
  const lose = (error) => {
    if (lost) return;
    lost = true;
    trace?.event('direct-lost');
    onLost(error);
  };
  channel.addEventListener('open', () => { trace?.event('direct-open'); onOpen(); });
  channel.addEventListener('close', () => lose(new Error('The direct connection closed.')));
  channel.addEventListener('error', () => lose(new Error('The direct connection failed.')));
  channel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') { lose(new Error('The direct connection sent text.')); return; }
    try {
      const started = trace ? performance.now() : 0;
      const records = assembler.push(event.data);
      trace?.timing('assemble', performance.now() - started);
      for (const record of records) onRecord(record);
    } catch (error) { lose(error); connection.close(); }
  });
  connection.addEventListener('connectionstatechange', () => {
    trace?.event('ice-state', connection.connectionState);
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') lose(new Error('The direct connection failed.'));
  });
  trace?.rtc(connection);
  return {
    connection,
    get open() { return !lost && channel.readyState === 'open'; },
    async send(record) {
      if (channel.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise((resolve, reject) => {
          const clean = () => {
            clearTimeout(timer);
            channel.removeEventListener('bufferedamountlow', drained);
            channel.removeEventListener('close', closed);
          };
          const drained = () => { clean(); resolve(); };
          const closed = () => { clean(); reject(new Error('The direct connection closed.')); };
          const timer = setTimeout(() => { clean(); reject(new Error('The direct connection stalled.')); }, 90_000);
          channel.addEventListener('bufferedamountlow', drained);
          channel.addEventListener('close', closed);
          if (channel.readyState !== 'open') closed();
          else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) drained();
        });
      }
      for (const piece of splitRecord(record)) channel.send(piece);
    },
    close() { connection.close(); }
  };
}

export async function answerDirect({ offerSdp, onSignal, ...options }) {
  const path = createDirect(options);
  try {
    let answered = false;
    const early = [];
    path.connection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      const signal = { candidate: event.candidate.toJSON() };
      if (answered) onSignal(signal);
      else early.push(signal);
    });
    await path.connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await path.connection.setLocalDescription(await path.connection.createAnswer());
    onSignal({ sdp: path.connection.localDescription.sdp });
    answered = true;
    for (const signal of early) onSignal(signal);
    return path;
  } catch (error) { path.close(); throw error; }
}

export async function offerDirect(options) {
  const path = createDirect(options);
  try {
    await path.connection.setLocalDescription(await path.connection.createOffer());
    // The v1 protocol carries the sender's candidates in the offer. Gathering
    // happens while the share code waits for a receiver, bounded to one second.
    if (path.connection.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); path.connection.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (path.connection.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 1000);
        path.connection.addEventListener('icegatheringstatechange', changed);
        changed();
      });
    }
    let answered = false;
    let candidates = 0;
    return Object.assign(path, {
      sdp: path.connection.localDescription.sdp,
      async signal(signal) {
        if (signal?.candidate && answered && candidates++ < 64) {
          if (typeof signal.candidate.candidate !== 'string' || signal.candidate.candidate.length > 1024) return;
          await path.connection.addIceCandidate(signal.candidate);
        } else if (!answered && typeof signal?.sdp === 'string' && signal.sdp.length <= MAX_SDP_BYTES) {
          await path.connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          answered = true;
        }
      }
    });
  } catch (error) { path.close(); throw error; }
}
