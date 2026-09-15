// Short-word rendezvous codes: plain everyday words (3-5 lowercase letters)
// that are easy to read out loud and type, safe to show on a big screen.
// The pool is small on purpose for a low-traffic site; collisions retry via
// ID-TAKEN and words are only live while the sender tab stays open.
export const P2P_WORDS = [
  'sun', 'sky', 'sea', 'oak', 'elm', 'fox', 'owl', 'ant', 'bee', 'red',
  'cup', 'mug', 'pen', 'map', 'key', 'box', 'jar', 'egg', 'fig', 'pie',
  'tea', 'jam', 'bus', 'car', 'gem', 'toy', 'top', 'run',
  'pine', 'fern', 'moss', 'rain', 'snow', 'leaf', 'dune', 'reef', 'bear', 'wolf',
  'lion', 'crab', 'dove', 'hawk', 'seal', 'swan', 'goat', 'blue', 'lamp', 'book',
  'vase', 'drum', 'bell', 'tent', 'kite', 'desk', 'ring', 'coin', 'kind', 'warm',
  'cool', 'calm', 'moon', 'star', 'cake', 'rice', 'bean', 'corn', 'plum', 'pear',
  'kiwi', 'jump', 'sing',
  'river', 'cloud', 'bloom', 'coral', 'pearl', 'eagle', 'panda', 'koala', 'otter', 'robin',
  'finch', 'gecko', 'camel', 'zebra', 'tiger', 'horse', 'sheep', 'mouse', 'mango', 'lemon',
  'apple', 'bread', 'honey', 'cocoa', 'mocha', 'latte', 'melon', 'berry', 'peach', 'grape',
  'chair', 'table', 'clock', 'frame', 'photo', 'piano', 'flute', 'green', 'amber', 'dance',
  'smile', 'laugh', 'shine', 'happy', 'swift', 'brave', 'fresh', 'crisp', 'trail', 'grove',
];

const WORD_SET = new Set(P2P_WORDS);

// Random codes issued before short words: 6 bytes / 8 chars, then the
// original 16 bytes / 22 chars. Receivers keep accepting them so links
// created just before the deploy still connect.
export const P2P_LEGACY_CODE_LENGTHS = [8, 22];
export const P2P_MAX_CODE_LENGTH = 22;

function isLegacyCode(value) {
  return /^[A-Za-z0-9_-]{8}$/.test(value) || /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  const lower = value.toLowerCase();
  if (WORD_SET.has(lower)) return lower;
  return value;
}

export function generateCode(random = crypto) {
  const bytes = new Uint8Array(4);
  random.getRandomValues(bytes);
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return P2P_WORDS[n % P2P_WORDS.length];
}

// Ephemeral receiver peer suffixes need uniqueness, not memorability, so
// they stay random base64url instead of short words.
export function generateEphemeralId(random = crypto) {
  const bytes = new Uint8Array(6);
  random.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function cleanCode(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, P2P_MAX_CODE_LENGTH);
}

export function isValidCode(value) {
  if (typeof value !== 'string') return false;
  if (WORD_SET.has(value.toLowerCase())) return true;
  return isLegacyCode(value);
}

export function codeFromUrl(value, base = 'https://cd.yash0.in/') {
  const raw = String(value ?? '').trim();
  if (isValidCode(raw)) return normalizeCode(raw);
  try {
    const url = new URL(raw, base);
    const fragment = url.hash.startsWith('#p2p.') ? url.hash.slice(5) : '';
    const cleaned = cleanCode(fragment);
    if (isValidCode(cleaned)) return normalizeCode(cleaned);
    return '';
  } catch {
    const cleaned = cleanCode(raw);
    if (isValidCode(cleaned)) return normalizeCode(cleaned);
    return '';
  }
}

export function receiveLinkFor(code, current = 'https://cd.yash0.in/') {
  if (!isValidCode(code)) throw new Error('invalid P2P code');
  const url = new URL(current);
  url.pathname = '/';
  url.search = '';
  url.hash = `p2p.${normalizeCode(code)}`;
  return url.toString();
}

export function peerIdFor(code) {
  if (!isValidCode(code)) throw new Error('invalid P2P code');
  return `cd-${normalizeCode(code)}`;
}
