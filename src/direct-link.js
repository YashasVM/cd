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
  let buffer = new Uint8Array(0);
  return {
    push(piece) {
      const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      const joined = new Uint8Array(buffer.byteLength + bytes.byteLength);
      joined.set(buffer);
      joined.set(bytes, buffer.byteLength);
      buffer = joined;
      const records = [];
      while (buffer.byteLength >= HEADER_BYTES) {
        if (buffer[0] !== 0x43 || buffer[1] !== 0x44 || buffer[2] !== 1) throw new Error('The direct connection sent an invalid record.');
        const length = HEADER_BYTES + new DataView(buffer.buffer, buffer.byteOffset + 8, 4).getUint32(0) + TAG_BYTES;
        if (length > MAX_RECORD_BYTES) throw new Error('The direct connection sent an oversized record.');
        if (buffer.byteLength < length) break;
        records.push(buffer.slice(0, length));
        buffer = buffer.slice(length);
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
  return {
    push(record) {
      const bytes = record instanceof Uint8Array ? record : new Uint8Array(record);
      if (bytes.byteLength < HEADER_BYTES) throw new Error('The sender sent an invalid record.');
      const sequence = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0);
      if (sequence < expected || pending.has(sequence)) return [];
      if (pending.size >= MAX_PENDING_RECORDS) throw new Error('The sender sent too many records out of order.');
      pending.set(sequence, bytes);
      const ready = [];
      while (pending.has(expected)) {
        ready.push(pending.get(expected));
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
