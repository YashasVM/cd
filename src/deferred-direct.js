// Backward-compatible direct-path negotiation. The relay advertises the
// sender's support before a receiver sends any pre-offer encrypted record.
export const DEFERRED_DIRECT_MODE = 'deferred-v1';
export const MAX_DIRECT_SDP_BYTES = 64 * 1024;
export const MAX_DIRECT_SIGNAL_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function deferredDirectHello() {
  // The empty candidate makes existing signal-aware senders ignore the hello
  // before an answer instead of interpreting it as a malformed SDP answer.
  return encoder.encode(JSON.stringify({ candidate: { candidate: '' }, deferredOffer: true }));
}

export function isDeferredDirectHello(plaintext) {
  if (plaintext.byteLength > 1024) return false;
  try {
    const value = JSON.parse(decoder.decode(plaintext));
    return value?.deferredOffer === true && value.sdp === undefined
      && value.candidate?.candidate === '';
  } catch { return false; }
}

export function directPending(value, helloSent, initialSDP) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('The sender offered invalid direct signaling.');
  if (value === true && (!helloSent || initialSDP)) throw new Error('The sender offered unnegotiated direct signaling.');
  return value === true;
}

export function deferredDirectSDP(plaintext) {
  if (plaintext.byteLength > MAX_DIRECT_SIGNAL_BYTES) throw new Error('The sender sent oversized direct signaling.');
  let value;
  try { value = JSON.parse(decoder.decode(plaintext)); } catch { throw new Error('The sender sent invalid direct signaling.'); }
  if (typeof value?.sdp !== 'string' || value.sdp.length === 0 || encoder.encode(value.sdp).byteLength > MAX_DIRECT_SDP_BYTES
    || value.candidate !== undefined || value.deferredOffer !== undefined) throw new Error('The sender sent invalid direct signaling.');
  return value.sdp;
}
