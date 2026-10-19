// Direct path for relay transfers, browser side (see cmd/cdx/direct.go).
// The sender offers WebRTC SDP inside its encrypted file offer; this page
// answers with a signal record, trickles its ICE candidates, and the two
// exchange the same encrypted records over a pre-negotiated data channel
// once it opens. Records are split into 64 KiB messages and rebuilt from
// their plaintext header; both paths feed one merger that orders records by
// sequence number and drops the second copy of any record.

const HEADER_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_PENDING_RECORDS = 256;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const DIRECT_CHANNEL_ID = 1;
export const DIRECT_PIECE_BYTES = 64 * 1024;
export const DIRECT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// parseDirectOffer returns the sender's offer SDP, or null if it offered none.
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
  let buffer = header;
  let filled = 0;
  return {
    get bufferedBytes() { return filled; },
    push(piece) {
      const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      if (bytes.byteLength > DIRECT_PIECE_BYTES) throw new Error('The direct connection exceeded its assembly buffer.');
      const records = [];
      for (let at = 0; at < bytes.byteLength;) {
        const count = Math.min(buffer.byteLength - filled, bytes.byteLength - at);
        buffer.set(bytes.subarray(at, at + count), filled);
        filled += count;
        at += count;
        if (filled !== buffer.byteLength) continue;
        if (buffer === header) {
          if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== 1) throw new Error('The direct connection sent an invalid record.');
          const length = HEADER_BYTES + new DataView(header.buffer).getUint32(8) + TAG_BYTES;
          if (length > MAX_RECORD_BYTES) throw new Error('The direct connection sent an oversized record.');
          buffer = new Uint8Array(length);
          buffer.set(header);
        } else {
          records.push(buffer);
          buffer = header;
          filled = 0;
        }
      }
      return records;
    }
  };
}

// createRecordMerger orders records from both paths by their header
// sequence number and drops second copies (the sender re-sends relay
// records on the direct path when it opens).
export function createRecordMerger() {
  let expected = 0;
  const pending = new Map();
  let pendingBytes = 0;
  return {
    push(record) {
      const bytes = record instanceof Uint8Array ? record : new Uint8Array(record);
      if (bytes.byteLength < HEADER_BYTES) throw new Error('The sender sent an invalid record.');
      const sequence = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0);
      if (sequence < expected || pending.has(sequence)) return [];
      if (bytes.byteLength > MAX_RECORD_BYTES || pending.size >= MAX_PENDING_RECORDS || pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) throw new Error('The sender sent too many records out of order.');
      pending.set(sequence, bytes);
      pendingBytes += bytes.byteLength;
      const ready = [];
      while (pending.has(expected)) {
        const record = pending.get(expected);
        ready.push(record);
        pendingBytes -= record.byteLength;
        pending.delete(expected);
        expected += 1;
      }
      return ready;
    }
  };
}

// answerDirect answers the sender's offer. onSignal receives each signal
// payload to seal and send (the answer, then trickled candidates);
// onRecord receives records from the data channel.
export async function answerDirect({ offerSdp, onSignal, onRecord, onOpen, onLost, RTCPeerConnectionImpl = globalThis.RTCPeerConnection }) {
  const connection = new RTCPeerConnectionImpl({ iceServers: DIRECT_ICE_SERVERS });
  const channel = connection.createDataChannel('cd-direct', { negotiated: true, id: DIRECT_CHANNEL_ID, ordered: true });
  channel.binaryType = 'arraybuffer';
  const assembler = createRecordAssembler();
  let lost = false;
  const lose = (error) => {
    if (lost) return;
    lost = true;
    onLost(error);
  };
  channel.addEventListener('open', () => onOpen());
  channel.addEventListener('close', () => lose(new Error('The direct connection closed.')));
  channel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      lose(new Error('The direct connection sent text.'));
      return;
    }
    try {
      for (const record of assembler.push(event.data)) onRecord(record);
    } catch (error) {
      lose(error);
      connection.close();
    }
  });
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') lose(new Error('The direct connection failed.'));
  });
  // Candidates found before the answer is out wait for it.
  let answered = false;
  const early = [];
  connection.addEventListener('icecandidate', (event) => {
    if (!event.candidate) return;
    const signal = { candidate: event.candidate.toJSON() };
    if (answered) onSignal(signal);
    else early.push(signal);
  });
  await connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await connection.setLocalDescription(await connection.createAnswer());
  onSignal({ sdp: connection.localDescription.sdp });
  answered = true;
  for (const signal of early.splice(0)) onSignal(signal);
  return {
    get open() { return !lost && channel.readyState === 'open'; },
    send(record) {
      for (const piece of splitRecord(record)) channel.send(piece);
    },
    close() { connection.close(); }
  };
}
