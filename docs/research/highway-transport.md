# CD transport highway research

Status: PASS for a bounded design recommendation; implementation remains for a
follow-up ticket. This report answers issue 11 (LAN routing, internet fallback,
authenticated peers, and durable resume).

## What exists today

The Android path in `android/app/src/main/kotlin/in/yash0/cd/transfer/` uses
WebRTC data channels through a PeerJS-compatible signaling endpoint at
`cd.yash0.in/peerjs/`, with Google and Twilio STUN servers. It sends a manifest,
then ordered raw file bytes, and treats a lost ICE/data channel as a terminal
failure. `TransferRepository` streams directly from the selected content URI to
the channel and the receiver directly to a sink. There is no transfer ID that
survives process death, no persisted byte checkpoint, no file or chunk digest,
and no reconnect handshake. The current Android guard also limits each file to
256 MiB and 100 files.

The browser path has the same short-code/PeerJS shape and is similarly a live
stream. The current CLI path is stronger about message authentication: its
random invitation key derives directional AES-256-GCM keys, authenticates every
record, and enforces monotonically increasing record sequences. It still has no
resume support (the release design explicitly says a disconnect fails the
transfer).

The existing Cloudflare Worker is useful for rendezvous and an optional live
fallback. `/ws/v1/<transfer-id>` maps to one Durable Object room. The room
authenticates a receiver capability by hash, forwards encrypted binary records,
and stores only room state. It currently limits room lifetime to two hours,
single sender/single receiver pairing, 80 KiB records, 2 MiB peer buffering,
and a finite signal count; a peer close terminates the room. It does not retain
file bytes or checkpoints. The separate `/peerjs/peerjs` Durable Object is
signaling only. Reusing these endpoints for a new protocol would need a
versioned room/protocol and bounded free-tier limits; it must not pretend that a
live relay is durable storage.

## Recommendation

Use one transfer protocol and three route candidates, selected in this order:

1. **LAN direct:** advertise a short-lived CD service with Android NSD/DNS-SD
   (`_cd-transfer._tcp`) and simultaneously listen on a local stream socket.
   The local socket transport is an unresolved architecture choice for the
   implementation plan: a small TCP stream is simpler to ship, while QUIC
   offers path validation and migration. Do not put the transfer capability or
   any secret in public mDNS/TXT metadata. TXT may contain only an opaque
   transfer ID, protocol version, port, and public-key fingerprint. On Linux,
   use mDNS/DNS-SD when available and retain the pasted code/link as the
   deterministic fallback. A discovered peer must prove possession of the
   transfer capability before accepting data.
2. **Internet direct:** keep WebRTC ICE for browser compatibility. Gather host,
   server-reflexive, and (when configured) relay candidates; prefer a validated
   direct pair. STUN helps discover mappings but does not guarantee a path.
   ICE's candidate-pair checks are the right mechanism for choosing a working
   path (RFC 8445).
3. **Internet fallback:** use the existing Cloudflare encrypted WebSocket relay
   only as a live forwarding path, after direct candidates fail. Add a small
   protocol adapter rather than sending WebRTC frames through the current
   `cd-transfer-v1` CLI room. Cap relay bytes, duration, and concurrent rooms;
   report a clear free-limit error. Do not add a TURN service under the
   no-hosting/no-bill requirement: when both NATs reject hole punching, a relay
   is mathematically required, and TURN's defining purpose is precisely to
   provide that intermediate node (RFC 8656 / RFC 5766).

For a native Linux/Android highway, TCP and QUIC remain proposed alternatives
for the first implementation. TCP is the smaller LAN MVP if route changes are
handled by reconnect plus checkpoint resume. QUIC provides authenticated
streams and can validate a new path after an address/NAT change, but it adds a
native stack and does not solve a completely disconnected process or an
unreachable peer. The implementation plan should choose one after a small
interop/performance spike; either way, keep WebRTC as a compatibility adapter
until browser and native implementations share the chosen native transport.

## Discovery and authentication contract

The sender creates a transfer record before advertising:

* `transfer_id` (128 random bits), protocol version, expiration, file manifest,
  and sender public identity key;
* a receiver capability secret delivered by QR/code/link, preferably in the
  URL fragment so it is not sent to the web server;
* a signed or MACed `manifest_id` and route-independent session nonce.

NSD/mDNS TXT records should contain only an opaque transfer ID, version, port,
and a public-key fingerprint. They are observable and spoofable on a LAN. The
first explicit pairing performs a challenge-response with the capability and
binds a stable peer key (TOFU); remembered sender keys can then auto-accept.
“Trusted recipients auto-accept” therefore means an already trusted sender key
must authenticate the session. A valid one-time capability bootstraps an
explicit first pairing; by itself it must not trigger automatic acceptance.
Unknown keys remain pending or fail closed. All data remains end-to-end
authenticated and encrypted regardless of route; the relay sees metadata and
ciphertext only.

## Durable resume and integrity

Make the manifest the immutable transfer identity. For each file record name,
size, media type, modification metadata if available, whole-file SHA-256 (or a
tree root for very large files), and fixed chunk size. A chunk is addressed by
`(transfer_id, file_id, chunk_index, offset, length, digest)`. The sender must
reopen/seek the source and the receiver must be able to report its durable
checkpoint after a reconnect.

Receiver state should be persisted in an app-owned staging directory (or a
Linux state directory) as a small journal containing manifest ID, file index,
highest contiguous chunk, per-file byte count, and verified whole-file status.
Write each chunk, flush it, then atomically advance the journal; only rename a
fully verified staged file into the user destination. On restart, discard a
partial tail after the last durable checkpoint and request that range again.
The sender never trusts an unverified offset: it sends the receiver's
checkpoint, then the receiver verifies each chunk and the final whole-file
digest before acknowledging completion.

The data channel can remain ordered/reliable for a first implementation, but
application checkpoints are still mandatory: WebRTC reliability covers delivery
while a channel exists, not process restart or a new route. The WebRTC API
defines ordered and reliable defaults, while allowing unreliable settings; CD
should explicitly request ordered/reliable mode for the compatibility adapter
(W3C WebRTC 1.0).

Reconnect is a new authenticated connection carrying the same transfer ID and
manifest ID. It should exchange `HELLO`, `RESUME(offsets)`, `ACCEPT`, and then
send only missing ranges. If the source file changed, the sender must fail
closed and require a new transfer. If the manifest, peer key, or capability
does not match, reject the reconnect and preserve the staged data for a later
valid attempt. A process crash is recoverable; cancellation or expiry is
terminal and should remove the capability while retaining or cleaning staging
according to explicit user choice.

## Automatic route switching

Keep route state separate from transfer state. When the active path fails, stop
new application chunks, persist the last acknowledged checkpoint, and race
fresh candidates (new LAN addresses, ICE restart, then relay). Validate the new
path and peer challenge before resuming. Do not replay an entire file or assume
that a WebRTC ICE restart preserves application delivery state. QUIC can migrate
an established connection after path validation, but the same checkpoint logic
is required when the process or connection is gone.

## Google Drive and zero-bill tradeoffs

The existing 5 TB Google Drive is useful as an optional user-owned spool, not as
peer discovery or a general relay. Drive's resumable upload API returns a
session URI, permits querying the received byte range after interruption, and
the session expires after one week. That can back a “store then fetch” mode if
the user signs in and grants Drive scope, but it adds OAuth, quota, account
ownership, server-side metadata, and a second endpoint to implement. It also
does not make two endpoints automatically discoverable or provide free
unlimited egress. Keep it opt-in and end-to-end encrypt the object before
upload; never silently upload a private transfer.

The no-bill baseline can guarantee: direct same-LAN transfer, direct ICE where
NATs permit it, and live encrypted Cloudflare relay within explicitly bounded
free limits. It cannot guarantee internet delivery between hostile NATs without
some relay capacity. A production promise should say “automatic fallback when
the configured free relay is available,” with a deterministic failure and
resume option when the relay limit, room lifetime, or network is exhausted.

## Bounded implementation sequence

1. Extract a route-neutral protocol package shared by Android, Linux, and the
   browser adapter: manifest, capability handshake, peer-key binding, chunk
   digests, checkpoints, resume, and completion acknowledgment.
2. Add durable staging/checkpoint storage and seekable sender reads first; test
   crash, duplicate chunk, changed source, truncated staging, and final digest
   cases without any networking.
3. Add LAN NSD advertisement/discovery and a local direct stream. Require the
   capability challenge before auto-accept and expose a pasted-code fallback.
4. Add route selection and reconnect: LAN, then WebRTC ICE restart/direct, then
   the versioned Cloudflare live relay. Keep relay byte/time/room limits and
   make every route report the same checkpoint.
5. Add Android foreground/user-initiated transfer lifecycle and Linux service
   lifecycle so process/background termination leaves a resumable journal.

## Primary sources

* [RFC 8445: Interactive Connectivity Establishment (ICE)](https://www.rfc-editor.org/rfc/rfc8445.html) — candidate gathering and connectivity checks.
* [RFC 8656: TURN](https://www.rfc-editor.org/rfc/rfc8656.html) and [RFC 5766 introduction](https://www.rfc-editor.org/rfc/rfc5766.html) — why a relay is required when direct NAT traversal fails and why it costs relay bandwidth.
* [RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000.html) — path validation, NAT rebinding, and connection migration limits.
* [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/) — ordered/reliable data-channel semantics.
* [Android NsdManager](https://developer.android.com/reference/android/net/nsd/NsdManager) — DNS-SD/mDNS discovery, multicast-lock and local-network permission constraints.
* [Android data-transfer options](https://developer.android.com/develop/background-work/background-tasks/data-transfer-options) — connected-device foreground service and user-initiated transfer guidance.
* [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads) — resumable session and byte-range recovery behavior.
