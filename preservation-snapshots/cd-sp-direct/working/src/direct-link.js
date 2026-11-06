// Direct path for relay transfers, browser side (see cmd/cdx/direct.go).
// The sender offers WebRTC SDP inside its encrypted file offer; the receiver
// answers with a signal record, trickles its ICE candidates, and the two
// exchange the same encrypted records over a pre-negotiated data channel
// once it opens. Records are split into 64 KiB messages and rebuilt from
// their plaintext header; both paths feed one merger that orders records by
// sequence number and drops the second copy of any record.
//
// Sender candidates found after the offer go out as signal records only when
// both sides advertised `trickle: true` (offer and answer): receivers that
// predate it treat a sender signal record as out of order.

const HEADER_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_PENDING_RECORDS = 256;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
// Bounds on what a peer can hand this side's ICE agent (cmd/cdx/direct.go).
const MAX_CANDIDATES = 64;
const MAX_CANDIDATE_BYTES = 1024;
// Sends wait while more than DIRECT_BUFFER_HIGH bytes sit in the channel's
// queue and resume when it drains to DIRECT_BUFFER_LOW. Chrome closes a data
// channel whose queue passes 16 MiB; one record past the mark stays far below.
const DIRECT_BUFFER_HIGH = 8 * 1024 * 1024;
const DIRECT_BUFFER_LOW = 2 * 1024 * 1024;
// A send that cannot get room for this long has lost the path.
const DIRECT_STALL_MS = 90_000;
export const DIRECT_CHANNEL_ID = 1;
export const DIRECT_PIECE_BYTES = 64 * 1024;
// The offer waits this long after the peer connection is created for host
// candidates; senders create it while the code is on screen, so receivers
// that join later get every candidate gathered by then.
export const DIRECT_GATHER_WAIT_MS = 50;
// Small files finish on the relay before a data channel would open.
export const DIRECT_MIN_BYTES = 1024 * 1024;
export const DIRECT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// parseDirectOffer returns the sender's offer SDP, or null if it offered none.
export function parseDirectOffer(offer) {
  const sdp = offer?.direct?.sdp;
  return typeof sdp === 'string' && sdp.length > 0 && sdp.length <= MAX_SDP_BYTES ? sdp : null;
}

// directTrickle reports whether an offer or answer accepts trickled
// candidates from the other side.
export function directTrickle(value) {
  return value?.trickle === true;
}

export function splitRecord(record, pieceBytes = DIRECT_PIECE_BYTES) {
  const pieces = [];
  for (let start = 0; start < record.byteLength; start += pieceBytes) {
    pieces.push(record.subarray(start, Math.min(start + pieceBytes, record.byteLength)));
  }
  return pieces;
}

// createRecordAssembler rebuilds records from data-channel messages of any
// size. Each record's header gives its length: a record inside one message is
// returned as a view of it, a longer one is copied once into a buffer of its
// exact size. Only a header split across messages is carried over.
export function createRecordAssembler() {
  const header = new Uint8Array(HEADER_BYTES);
  let headerFilled = 0;
  let record = null;
  let filled = 0;

  function recordLength(bytes, offset) {
    if (bytes[offset] !== 0x43 || bytes[offset + 1] !== 0x44 || bytes[offset + 2] !== 1) throw new Error('The direct connection sent an invalid record.');
    const length = HEADER_BYTES + new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 4).getUint32(0) + TAG_BYTES;
    if (length > MAX_RECORD_BYTES) throw new Error('The direct connection sent an oversized record.');
    return length;
  }

  return {
    push(piece) {
      const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      const records = [];
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (record === null) {
          const available = bytes.byteLength - offset;
          if (headerFilled === 0 && available >= HEADER_BYTES) {
            const length = recordLength(bytes, offset);
            if (available >= length) {
              records.push(bytes.subarray(offset, offset + length));
              offset += length;
              continue;
            }
            record = new Uint8Array(length);
          } else {
            const take = Math.min(HEADER_BYTES - headerFilled, available);
            header.set(bytes.subarray(offset, offset + take), headerFilled);
            headerFilled += take;
            offset += take;
            if (headerFilled < HEADER_BYTES) break;
            record = new Uint8Array(recordLength(header, 0));
            record.set(header);
            filled = HEADER_BYTES;
            headerFilled = 0;
          }
        }
        const take = Math.min(record.byteLength - filled, bytes.byteLength - offset);
        record.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
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

// candidateInit copies the fields an ICE agent needs from a peer's
// candidate, or returns null when they are malformed or oversized.
function candidateInit(value) {
  if (!value || typeof value !== 'object' || typeof value.candidate !== 'string' || value.candidate.length > MAX_CANDIDATE_BYTES) return null;
  const init = { candidate: value.candidate };
  if (typeof value.sdpMid === 'string' && value.sdpMid.length <= 64) init.sdpMid = value.sdpMid;
  if (Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 0xffff) init.sdpMLineIndex = value.sdpMLineIndex;
  if (typeof value.usernameFragment === 'string' && value.usernameFragment.length <= 256) init.usernameFragment = value.usernameFragment;
  return init;
}

// openDirectPath creates the peer connection and its pre-negotiated data
// channel, shared by both roles. onRecord receives each record that arrives
// on it; onLost reports the first failure once (never after close()).
function openDirectPath({ onRecord, onOpen = () => {}, onLost = () => {}, RTCPeerConnectionImpl = globalThis.RTCPeerConnection }) {
  const connection = new RTCPeerConnectionImpl({ iceServers: DIRECT_ICE_SERVERS });
  const channel = connection.createDataChannel('cd-direct', { negotiated: true, id: DIRECT_CHANNEL_ID, ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = DIRECT_BUFFER_LOW;
  const assembler = createRecordAssembler();
  // Sends waiting for the channel's queue to drain, woken with an error
  // when the path is lost or closed.
  const roomWaiters = new Set();
  let lostError = null;
  let closed = false;
  let pieceBytes = 0;
  let queued = null;
  let remoteCandidates = 0;

  const lose = (error) => {
    if (lostError) return;
    lostError = error;
    for (const wake of [...roomWaiters]) wake(error);
    if (!closed) onLost(error);
  };
  channel.addEventListener('open', () => { if (!lostError) onOpen(); });
  channel.addEventListener('close', () => lose(new Error('The direct connection closed.')));
  channel.addEventListener('message', (event) => {
    if (lostError) return;
    if (typeof event.data === 'string') {
      lose(new Error('The direct connection sent text.'));
      connection.close();
      return;
    }
    let records;
    try {
      records = assembler.push(event.data);
    } catch (error) {
      lose(error);
      connection.close();
      return;
    }
    for (const record of records) onRecord(record);
  });
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') lose(new Error('The direct connection failed.'));
  });

  // room resolves once the channel's queue is at or under the high-water
  // mark, waking on bufferedamountlow rather than polling.
  function room() {
    if (lostError) return Promise.reject(lostError);
    if (channel.bufferedAmount <= DIRECT_BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = (error) => {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', drained);
        roomWaiters.delete(wake);
        if (error) reject(error);
        else resolve();
      };
      const drained = () => wake();
      const timer = setTimeout(() => {
        wake(new Error('The direct connection stalled.'));
        lose(new Error('The direct connection stalled.'));
        connection.close();
      }, DIRECT_STALL_MS);
      channel.addEventListener('bufferedamountlow', drained);
      roomWaiters.add(wake);
    });
  }

  // write hands one record to the channel in pieces no larger than the
  // peer's SCTP message limit (64 KiB unless it advertised less).
  function write(record) {
    if (lostError) throw lostError;
    if (channel.readyState !== 'open') throw new Error('The direct connection is not open.');
    if (pieceBytes === 0) {
      const limit = connection.sctp?.maxMessageSize;
      pieceBytes = limit > 0 ? Math.min(DIRECT_PIECE_BYTES, limit) : DIRECT_PIECE_BYTES;
    }
    for (let start = 0; start < record.byteLength; start += pieceBytes) {
      channel.send(record.subarray(start, Math.min(start + pieceBytes, record.byteLength)));
    }
  }

  return {
    connection,
    get open() { return !lostError && channel.readyState === 'open'; },
    get lost() { return lostError !== null; },
    get bufferedAmount() { return channel.bufferedAmount; },
    // send writes one record, first waiting (in order behind earlier
    // waiting sends) while the channel's queue is over the high-water mark.
    // With room it writes before returning, so unawaited sends keep order.
    send(record) {
      if (queued === null && !lostError && channel.bufferedAmount <= DIRECT_BUFFER_HIGH) {
        try {
          write(record);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      const sent = (queued ?? Promise.resolve()).then(room).then(() => write(record));
      queued = sent;
      const settle = () => { if (queued === sent) queued = null; };
      sent.then(settle, settle);
      return sent;
    },
    // addCandidate applies one of the peer's trickled candidates; extra,
    // malformed, or rejected candidates are dropped.
    async addCandidate(value) {
      const init = candidateInit(value);
      if (!init || lostError || remoteCandidates >= MAX_CANDIDATES) return;
      remoteCandidates += 1;
      try { await connection.addIceCandidate(init); } catch { /* That route is unusable. */ }
    },
    // fail gives up on the path (a bad answer, say) and reports it once.
    fail(error) {
      lose(error);
      connection.close();
    },
    // close ends the path without reporting it lost.
    close() {
      closed = true;
      lose(new Error('The direct connection closed.'));
      connection.close();
    }
  };
}

// offerDirect starts the sender's side: it creates the offer at once and
// keeps gathering candidates while the code is on screen. description()
// resolves the offer SDP with every candidate gathered so far (waiting at
// most gatherWaitMs from creation); signal(value) applies the receiver's
// answer, then its candidates. Candidates found after description() go to
// onCandidate, but only once the answer accepted them (trickle: true).
export async function offerDirect({ onCandidate = () => {}, gatherWaitMs = DIRECT_GATHER_WAIT_MS, ...options }) {
  const path = openDirectPath(options);
  const { connection } = path;
  const gathered = new Promise((resolve) => {
    const timer = setTimeout(resolve, gatherWaitMs);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  let offered = false;
  let trickling = false;
  let localCandidates = 0;
  const late = [];
  connection.addEventListener('icecandidate', (event) => {
    // Candidates surfaced before the offer SDP was read are part of it.
    if (!offered || !event.candidate || localCandidates >= MAX_CANDIDATES) return;
    localCandidates += 1;
    const candidate = event.candidate.toJSON();
    if (trickling) onCandidate(candidate);
    else late.push(candidate);
  });
  try {
    await connection.setLocalDescription(await connection.createOffer());
  } catch (error) {
    path.close();
    throw error;
  }
  let answered = null;
  return Object.assign(path, {
    async description() {
      await gathered;
      const sdp = connection.localDescription?.sdp;
      if (!sdp || sdp.length > MAX_SDP_BYTES) throw new Error('The direct offer is too large.');
      offered = true;
      return sdp;
    },
    // signal never throws: a bad answer gives up on the path (the transfer
    // stays on the relay) and anything after the first answer is either a
    // bounded candidate or ignored, so a peer cannot renegotiate.
    async signal(value) {
      if (!value || typeof value !== 'object' || path.lost) return;
      if (typeof value.sdp === 'string') {
        if (answered) return;
        if (value.sdp.length === 0 || value.sdp.length > MAX_SDP_BYTES) {
          answered = Promise.resolve();
          path.fail(new Error('The receiver sent an invalid direct answer.'));
          return;
        }
        answered = connection.setRemoteDescription({ type: 'answer', sdp: value.sdp }).then(() => true, (error) => {
          path.fail(error);
          return false;
        });
        if (await answered && directTrickle(value)) {
          trickling = true;
          for (const candidate of late.splice(0)) onCandidate(candidate);
        }
        return;
      }
      if (value.candidate && answered && await answered) await path.addCandidate(value.candidate);
    }
  });
}

// answerDirect answers the sender's offer. onSignal receives each signal
// payload to seal and send (the answer, then trickled candidates); with
// trickle (the offer advertised it) the answer asks for the sender's later
// candidates, which go to the returned path's addCandidate.
export async function answerDirect({ offerSdp, trickle = false, onSignal, ...options }) {
  const path = openDirectPath(options);
  const { connection } = path;
  // Candidates found before the answer is out wait for it.
  let answered = false;
  let localCandidates = 0;
  const early = [];
  connection.addEventListener('icecandidate', (event) => {
    if (!event.candidate || localCandidates >= MAX_CANDIDATES) return;
    localCandidates += 1;
    const signal = { candidate: event.candidate.toJSON() };
    if (answered) onSignal(signal);
    else early.push(signal);
  });
  try {
    await connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await connection.setLocalDescription(await connection.createAnswer());
  } catch (error) {
    path.close();
    throw error;
  }
  onSignal(trickle ? { sdp: connection.localDescription.sdp, trickle: true } : { sdp: connection.localDescription.sdp });
  answered = true;
  for (const signal of early.splice(0)) onSignal(signal);
  return path;
}
