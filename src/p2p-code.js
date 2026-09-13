export const P2P_CODE_BYTES = 16;
export const P2P_CODE_LENGTH = 22;

export function generateCode(random = crypto) {
  const bytes = new Uint8Array(P2P_CODE_BYTES);
  random.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function cleanCode(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, P2P_CODE_LENGTH);
}

export function isValidCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function codeFromUrl(value, base = 'https://cd.yash0.in/') {
  const raw = String(value ?? '').trim();
  if (isValidCode(raw)) return raw;
  try {
    const url = new URL(raw, base);
    const fragment = url.hash.startsWith('#p2p.') ? url.hash.slice(5) : '';
    return cleanCode(fragment);
  } catch {
    return cleanCode(raw);
  }
}

export function receiveLinkFor(code, current = 'https://cd.yash0.in/') {
  if (!isValidCode(code)) throw new Error('invalid P2P code');
  const url = new URL(current);
  url.pathname = '/';
  url.search = '';
  url.hash = `p2p.${code}`;
  return url.toString();
}

export function peerIdFor(code) {
  if (!isValidCode(code)) throw new Error('invalid P2P code');
  return `cd-${code}`;
}
