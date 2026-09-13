export const SENDER_DIRECTION = 0;
export const RECEIVER_DIRECTION = 1;

export const KIND_OFFER = 1;
export const KIND_CHUNK = 2;
export const KIND_END = 3;
export const KIND_ACCEPT = 4;
export const KIND_ACK = 5;
export const KIND_COMPLETE = 6;

export const MAX_RECORD_BYTES = 80 * 1024;

const HEADER_BYTES = 12;
const VERSION = 1;
const encoder = new TextEncoder();

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('This CD link is invalid.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function parseInvitation(url) {
  const match = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  const keyMatch = /^#v1\.([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (!match || !keyMatch) throw new Error('This CD link is invalid.');
  const id = decodeBase64Url(match[1]);
  const key = decodeBase64Url(keyMatch[1]);
  if (id.length !== 16 || key.length !== 32) throw new Error('This CD link is invalid.');
  return { id, key };
}

async function deriveBytes(invitation, info) {
  const source = await crypto.subtle.importKey('raw', invitation.key, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: invitation.id,
    info: encoder.encode(info)
  }, source, 256);
  return new Uint8Array(bits);
}

export async function receiverAdmission(invitation) {
  const token = await deriveBytes(invitation, 'cd-transfer-v1 receiver join');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', token));
  return { token, digest };
}

async function recordKey(invitation, direction) {
  const info = direction === SENDER_DIRECTION
    ? 'cd-transfer-v1 sender frames'
    : 'cd-transfer-v1 receiver frames';
  const raw = await deriveBytes(invitation, info);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function isValidKind(direction, kind) {
  return direction === SENDER_DIRECTION
    ? kind >= KIND_OFFER && kind <= KIND_END
    : kind >= KIND_ACCEPT && kind <= KIND_COMPLETE;
}

function nonce(direction, sequence) {
  const value = new Uint8Array(12);
  value.set(encoder.encode(direction === SENDER_DIRECTION ? 'CDS1' : 'CDR1'));
  new DataView(value.buffer).setBigUint64(4, BigInt(sequence));
  return value;
}

function additionalData(header, id) {
  const value = new Uint8Array(HEADER_BYTES + id.length);
  value.set(header);
  value.set(id, HEADER_BYTES);
  return value;
}

export async function createSealer(invitation, direction) {
  const key = await recordKey(invitation, direction);
  let sequence = 0;
  return {
    async seal(kind, plaintext) {
      if (!isValidKind(direction, kind)) throw new Error('Message kind is invalid for direction.');
      if (sequence > 0xffffffff) throw new Error('Record sequence exhausted.');
      const header = new Uint8Array(HEADER_BYTES);
      header.set([0x43, 0x44, VERSION, kind]);
      const view = new DataView(header.buffer);
      view.setUint32(4, sequence);
      view.setUint32(8, plaintext.byteLength);
      if (HEADER_BYTES + plaintext.byteLength + 16 > MAX_RECORD_BYTES) throw new Error('Record is too large.');
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv: nonce(direction, sequence),
        additionalData: additionalData(header, invitation.id)
      }, key, plaintext));
      const record = new Uint8Array(header.byteLength + ciphertext.byteLength);
      record.set(header);
      record.set(ciphertext, header.byteLength);
      sequence += 1;
      return record;
    }
  };
}

export async function createOpener(invitation, direction) {
  const key = await recordKey(invitation, direction);
  let expectedSequence = 0;
  return {
    async open(input) {
      const record = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (record.byteLength < HEADER_BYTES + 16 || record.byteLength > MAX_RECORD_BYTES) throw new Error('Record length is invalid.');
      const header = record.slice(0, HEADER_BYTES);
      const view = new DataView(header.buffer);
      const kind = header[3];
      if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== VERSION) throw new Error('Record protocol is invalid.');
      if (!isValidKind(direction, kind)) throw new Error('Message kind is invalid for direction.');
      const sequence = view.getUint32(4);
      if (sequence !== expectedSequence) throw new Error(`Record sequence ${sequence}, expected ${expectedSequence}.`);
      if (view.getUint32(8) + HEADER_BYTES + 16 !== record.byteLength) throw new Error('Record plaintext length is invalid.');
      let plaintext;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
          name: 'AES-GCM',
          iv: nonce(direction, sequence),
          additionalData: additionalData(header, invitation.id)
        }, key, record.slice(HEADER_BYTES)));
      } catch {
        throw new Error('Record authentication failed.');
      }
      expectedSequence += 1;
      return { kind, plaintext };
    }
  };
}
