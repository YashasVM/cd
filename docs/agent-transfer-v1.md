# CD agent transfer protocol v1

## Caller contract

`cdx send <file>` opens and validates one regular file, reserves a live relay
room, then writes one capability URL to stdout. The process stays in the
foreground. Status goes to stderr. Exit code 0 means the receiver reconstructed
the authenticated byte stream and prepared it for download or finished writing
it to a user-approved file destination.

The URL has this form:

```text
https://cd.yash0.in/s/<transfer-id>#v1.<master-key>
```

The transfer ID is 16 random bytes encoded as 22 unpadded base64url characters.
The master key is 32 random bytes encoded as 43 unpadded base64url characters.
The fragment is never part of an HTTP or WebSocket request.

## Trust model

The Cloudflare relay sees the transfer ID, endpoint addresses, roles, timing,
and ciphertext sizes. It never receives the master key, filename, media type,
or file bytes. AES-256-GCM authenticates all peer messages. The relay can delay,
drop, or deny a transfer. The browser trusts the JavaScript served by
`cd.yash0.in`; a compromised origin can read the fragment key.

The receiver join token is HKDF-SHA-256 output derived from the master key, the
transfer ID salt, and `cd-transfer-v1 receiver join`. The sender registers the
SHA-256 digest of this token. The browser presents the token when joining. This
prevents a route copied from infrastructure logs from consuming the receiver
slot. It does not attempt to protect against a malicious relay.

## Relay messages

Clients connect to `/ws/v1/<transfer-id>`. Their first message is bounded JSON:

```json
{"type":"join","protocol":"cd-transfer-v1","role":"sender","receiverTokenHash":"<base64url>"}
```

```json
{"type":"join","protocol":"cd-transfer-v1","role":"receiver","receiverToken":"<base64url>"}
```

The relay replies with JSON events named `accepted`, `peer-joined`, and
`peer-left`. A receiver cannot create a room. Duplicate roles, invalid joins,
wrong versions, text after admission, and frames above 80 KiB are rejected with
stable private WebSocket close codes.

An upgraded socket has 10 seconds to send a valid join. Silent sockets are
closed by the room alarm and cannot permanently consume its connection cap.

One Durable Object owns one room. Its stored phase and absolute expiry are the
source of truth. WebSocket attachments own each live role across hibernation.
Rooms admit one sender and one receiver and cannot be reused during their short
terminal tombstone lifetime. Ciphertext is forwarded and never stored.

## Encrypted records

After pairing, peers send only binary records:

```text
0..1    ASCII "CD"
2       version, 1
3       message kind
4..7    sequence, uint32 big-endian
8..11   plaintext length, uint32 big-endian
12..    AES-GCM ciphertext and 16-byte tag
```

The fixed header and raw transfer ID are AES-GCM additional authenticated data.
HKDF derives independent sender and receiver AES keys. The nonce is four fixed
direction bytes followed by the uint32 sequence zero-extended to eight bytes.
Sequence starts at zero in each direction. Reuse, gaps, overflow, unknown kinds,
and non-canonical lengths are terminal errors.

Sender kinds are `offer`, `chunk`, and `end`. Receiver kinds are `accept`,
`ack`, and `complete`. Offer metadata is encrypted JSON. Size is a decimal
string so Go `uint64` and JavaScript `BigInt` have one exact wire
representation. Chunk content is raw bytes. Ack, end, and complete are fixed
binary counters. Either peer closes the socket to abort.

The receiver must explicitly accept the decrypted offer before chunks start.
The sender permits at most 1 MiB of unacknowledged plaintext. An acknowledgement
is sent only after the active byte sink owns the bytes. The receiver also caps
pending encrypted input at 2 MiB and closes peers that ignore flow control.

The end record authenticates total bytes and chunk count. The receiver compares
them with the offer and its committed counters before closing its sink. It sends
complete with the matching counters. Per-record authentication, ordered
sequences, and authenticated terminal counts detect changed, reordered,
duplicated, missing, or extra content without a second file read.

## Timeouts and limits

- Sender relay admission: 10 seconds.
- Receiver wait: 15 minutes.
- User consent after an offer: 10 minutes.
- Transfer inactivity after acceptance: 45 seconds.
- Hard room lifetime: 2 hours.
- Plaintext chunk: 64 KiB.
- Unacknowledged sender window: 1 MiB.
- Pending receiver ciphertext: 2 MiB.
- Blob fallback: 256 MiB.

The browser reports a Blob result as "ready to download", not "saved". A direct
file-system sink may report "saved" only after its writable closes successfully.

## Croc influence

Croc demonstrates the useful product shape: one live sender command, an
untrusted rendezvous relay, end-to-end authenticated encryption, explicit file
metadata, progress, and receiver-confirmed completion. Croc uses PAKE because
its human code phrases have low entropy, and it supports direct-path discovery,
parallel connections, reconnect, resume, compression, and an explicit stored
mode. CD v1 uses a random fragment key and one browser-compatible WebSocket
path, so those mechanisms do not belong in this recovery.

Primary references:

- https://github.com/schollz/croc
- https://github.com/schollz/croc/blob/main/web/README.md
- https://github.com/schollz/croc/blob/main/src/docs/STORED_TRANSFERS.md
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/limits/
