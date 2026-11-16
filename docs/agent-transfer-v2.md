# CD live transfer protocol v2

This records the existing v2 contract implemented by `worker/resume-room.ts`,
Android's extracted `Protocol.kt` and the web `resume-protocol.js`. It supplements
[v1](agent-transfer-v1.md); v1 and v2 rooms are separate namespaces.

An invitation is `https://<relay>/s/<16-byte-base64url-id>#v2.<32-byte-base64url-key>`.
Only canonical unpadded base64url is accepted. The key stays in the fragment.
The socket endpoint is `/ws/v2/<id>`, with one sender and one active receiver.

Sender join contains `type: join`, `protocol: cd-transfer-v2`, `role: sender`, a
random 32-byte senderToken and its SHA-256 senderTokenHash, receiverTokenHash,
a fresh 32-byte sessionNonce and nonceProof. Receiver join contains role
receiver, receiverToken, fresh receiverNonce and nonceProof. Public `appId`
is optional untrusted attribution, never authorization.

The receiver token is HKDF-SHA256(master key, raw ID,
`cd-transfer-v2 receiver join`). Nonce proofs are HMAC-SHA256(master key,
UTF-8 `cd-transfer-v2 <role> nonce` concatenated with raw ID and own nonce).
The relay binds and forwards proofs; peers verify them. It stores hashes,
nonces, expiry, room state and replay history, never the master key or contents.

Accepted/peer-joined events carry authoritative expiresAt, sessionNonce,
receiverNonce when paired, senderNonceProof and receiverNonceProof. Peers must
check their own nonce, the peer proof and fixed expiry before using records.
A root can retain at most 128 sessions in CD's advanced resume implementation.
SDK high-level operations create fresh roots instead of reconnecting.

Records retain v1's 12-byte header and 16-byte AES-256-GCM tag, with version 2.
Independent direction keys derive through HKDF-SHA256 with salt
`raw ID || sessionNonce || receiverNonce` and info
`cd-transfer-v2 sender frames` or `cd-transfer-v2 receiver frames`.
AAD is `header || raw ID || sessionNonce || receiverNonce`. Nonces are ASCII
`CDS2` or `CDR2` followed by the uint32 sequence extended to uint64 big-endian.
Sequences start at zero per direction and cannot repeat, skip or overflow.

Sender kinds are offer=1, chunk=2, end=3. Receiver kinds are accept=4, ack=5,
complete=6, optional direct-path signal=9. Offer JSON contains name, decimal
string size, chunkSize=262144, wholeSha256, expiresAt, and optionally appId,
windowBytes and direct SDP. All metadata after joining is encrypted.

Accept JSON contains decimal string offset and prefixSha256; fresh receivers
use offset `0` and SHA-256 of empty bytes. Optional ackEveryBytes negotiates a
chunk-aligned ACK interval. No chunk may precede explicit host acceptance.
ACK plaintext is 12 bytes: uint32 chunk count and uint64 cumulative byte count,
big-endian. Receivers acknowledge only bytes their sink owns. End/complete add
the 32 raw SHA-256 bytes, for 44 bytes total. Whole-file digest, size, chunk
count and authenticated sequence must agree before host commit and COMPLETE.
After encrypted COMPLETE, the receiver sends plaintext routing control
`{type:"complete", protocol:"cd-transfer-v2", sessionNonce, receiverNonce}`.
The relay requires the forwarded COMPLETE header first and returns `completed`.
The sender requires the encrypted completion as well as the relay event.

## Preview rejection hint

The preview SDKs may send encrypted kind 4 with JSON `{"rejected":true}` instead
of an offset/prefix. This is a rejection, never permission to send chunks. Both
SDKs report REJECTED and terminate. Old v2 senders require offset/prefix, so
this hint fails safely before bytes, though their UI may show a generic failure.
No new record kind, cipher, key schedule or relay handling is introduced.

Closing the socket cancels/interrupts delivery. The relay admits no offline
receiver and never persists contents. Root expiry is at most 24 hours. Waiting
and paired leases, origin checks, IP budgets and nonce replay restrictions
remain defined by the Worker. SDKs bound their own queues and send windows;
see [integration limits](third-party-integration.md#limits-and-compatibility).
A receiver commit can succeed while final acknowledgements are lost. A sender
failure therefore never proves that the remote file was not received.
