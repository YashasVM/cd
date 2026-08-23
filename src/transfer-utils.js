const TRANSFER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{4,126}[A-Za-z0-9]$/;

export const isTransferId = value => TRANSFER_ID.test(value);

export const appendFiles = (current, incoming) => [...current, ...Array.from(incoming || [])];

export function makeGuestLink(origin, peerId) {
  if (!isTransferId(peerId)) throw new Error('Invalid transfer code.');
  const url = new URL('/', origin);
  url.searchParams.set('guest', peerId);
  return url.href;
}

export function parseReceiveTarget(input, origin) {
  const value = input.trim();
  if (!value) return { error: 'Paste a CD link or transfer code.' };

  const base = new URL(origin);
  let url;
  if (isTransferId(value)) {
    url = new URL(makeGuestLink(base.origin, value));
  } else {
    try {
      url = new URL(value, base);
    } catch {
      return { error: 'That is not a valid CD link or transfer code.' };
    }
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.pathname !== '/') {
    return { error: 'Use a link created by this CD website.' };
  }

  const keys = [...url.searchParams.keys()];
  const guest = url.searchParams.get('guest');
  const emailTransfer = url.searchParams.get('emailTransfer');
  if (keys.length !== 1 || Boolean(guest) === Boolean(emailTransfer)) {
    return { error: 'This CD link is missing a valid transfer code.' };
  }

  const transferId = guest || emailTransfer;
  if (!isTransferId(transferId) || (guest && url.hash)) {
    return { error: 'This CD link is missing a valid transfer code.' };
  }

  return guest
    ? { target: { kind: 'guest', peerId: guest, href: url.href } }
    : { target: { kind: 'email', transferId: emailTransfer, capability: url.hash.slice(1), href: url.href } };
}
