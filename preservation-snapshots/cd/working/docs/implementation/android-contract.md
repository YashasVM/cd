# Android integration contract

Implementation contract for the approved Android plan. Existing v1/v2 transfers remain supported. Initial native app uses a Kotlin implementation of the existing v2 protocol and shared fixture tests; integrating a Go Android library is deferred if the available toolchain cannot support it.

## Paired control channel

A per-pair random 16-byte ID and random 32-byte master secret are stored privately on both devices. This is the device credential; names and IDs alone never authorize a transfer. Pairing QR: `cdpair://v1#<base64url UTF-8 JSON>` with fields `version:1`, `pairId` (base64url16), `secret` (base64url32), `name` (laptop name), `relayUrl` (wss origin endpoint, e.g. wss://cd.yash0.in/ws/devices/v1/<pairId>), `localUrls` (array of ws:// private LAN IP:port/ws/devices/v1/<pairId>), `expiresAt` (Unix milliseconds, 5 minutes). Android requires explicit Trust confirmation before storing it. QR secret must never reach relay/logs or ordinary CLI JSON device listing. Revoke deletes the pair on Android and closes its sockets; forget deletes CLI credentials.

Derive via HKDF-SHA256(secret,salt=rawPairID,info,32). Infos: `cd-device-v1 sender join`, `cd-device-v1 receiver join`, `cd-device-v1 sender messages`, `cd-device-v1 receiver messages`. Join JSON {type:"join",protocol:"cd-device-v1",role:"sender"|"receiver",token:<derived role join token base64url>}. Sender additionally supplies senderTokenHash and receiverTokenHash (base64url SHA256 of role tokens) for initial relay registration. Relay stores only hashes. It allows one active peer per role, uses hibernation, bounded frames and queues, keeps pair registration for 30 days with authenticated activity refresh, supports reconnect without replacing active peers. No files or encrypted messages persist on the server.

Local control uses a challenge before admission. The server sends `{type:"challenge",protocol:"cd-device-v1",nonce:<random base64url32>}`. A local join omits token and both token hashes and supplies `localProof`. Its MAC key is HKDF-SHA256(secret,salt=rawPairID,info=`cd-device-v1 <role> local join`,32). Its MAC input is UTF8 `cd-device-v1 <role> <encodedPairID> <encodedChallengeNonce>`. Fresh server challenges are connection-specific. Relay admission stays token-based over TLS. Explicit local transport selection is required because development relays may also use ws.

After admission, clients send `{type:"ping",protocol:"cd-device-v1"}` every 20 seconds. Both transports answer `pong`. The relay reclaims sockets after 75 seconds without an authenticated application message, without replacing live peers. This is independent of raw WebSocket ping/pong, which the platform can handle without waking the object.

Server events JSON {type:"accepted"|"peer-joined"|"peer-left",protocol:"cd-device-v1"}. Binary control frame: 12 random nonce bytes followed by AES-256-GCM(ciphertext+tag). Direction-specific message key above. AAD UTF8 `cd-device-v1 ` + role + ` ` + encoded pairId. Nonces are generated randomly for every message, never reset counters under a reused key. Plaintext JSON includes version:1, type, messageId (random base64url16), expiresAt (millis, at most now+5min); reject expired/replayed messages. Permit at most30 seconds of positive clock skew when validating the maximum future lifetime; already-expired messages remain rejected. Persist transfer IDs/completion state on receiver to reject repeated offers across restart. Maximum control frame 16KiB.

Receiver `paired` message adds name (phone nickname). Sender `offer` message adds transferId (base64url16), url (existing private v2 invitation), localUrl (optional local v2 WebSocket endpoint), filename, size (decimal string), wholeSha256, expiresAt. Receiver `received` adds transferId. Receiver `paused` adds transferId. Both endpoints authenticate decrypted fields and enforce their roles. Local control server implements same admission/events. Device trust is the paired secret; relay tokens are never encryption keys.

A `received` message acknowledges verified publication of that exact root. It may recover a lost final v2 completion exchange. Before treating the receipt as success, the CLI revalidates its authenticated pending capability and the source filename, size and full digest. Receipts for another root cannot finish the active command.

## Optional Firebase wake-up

The default Android build omits Firebase. `-PcdFcm=true` requires a real `android/app/google-services.json`. Receiving, notifications and the separate Trusted wake-up notifications opt-in must all be enabled. Only a fresh hint for a currently trusted pair can wake its control connection. Explicit Stop remains off. A force-stopped app requires reopening.

Authenticated HTTPS routes use `/api/devices/v1/<pairId>/push-target` for receiver-role POST registration and DELETE removal, and `/api/devices/v1/<pairId>/push` for sender-role POST wake requests. Targets remain private. Wake requests are limited to one per 30 seconds and 20 per hour per pair. Missing server configuration is an optional no-op. Google receives only the installation routing ID and a data hint containing the protocol version, type, pair ID and issue time. It receives no filename, file data, transfer capability or pair secret.

The CLI requests a hint only after waiting for the paired receiver. A hint never acknowledges transfer delivery. The phone rechecks trust and receiving state before starting a foreground service. Downgraded priority or blocked service startup produces a tap notification. Opt-out and revocation queue authenticated target deletion. See [project setup](../guides/firebase-setup.md) and [Android push policy](../../android/docs/push.md).

## Local discovery

The default LAN listener is TCP53318, shared by pairing and subsequent sends so stored local endpoints survive process restarts. CD_DEVICE_LISTEN can override it for tests. CLI advertises `_cdx._tcp` over mDNS while pairing or sending, TXT `pairId=<id>` and `version=1`. Android resolves only paired IDs while receiving is enabled and connects `ws://<resolved LAN IP>:<port>/ws/devices/v1/<pairId>`. Discovery is untrusted; message AEAD is mandatory. No file paths, transfer keys, or pair master secrets in mDNS. Direct local websockets carry end-to-end encrypted records; public/internet endpoints MUST be wss. Discovered endpoints must resolve to local/private/link-local addresses. Explicit localhost allowed only in tests/emulator forwarding.

## Existing resumable file data

Use existing `cd-transfer-v2` from cmd/cdx/resume.go, cmd/cdx/resume_protocol.go, fixtures/resume-v2.json and docs/adr/0001-authenticated-resume.md. A private v2 URL contains rootID and capability. Android needs the same HKDF, nonce proof, AES-GCM record codec, offer/accept/chunk/ack/end/complete. Preserve fresh session nonce binding, durable checkpoint before ACK, prefix hash verification, exact size and final SHA256 before publish. New senders advertise windowBytes=4194304 and accept cumulative durable ACKs. Kotlin receivers commit 1 MiB batches only when windowBytes>=1048576, otherwise commit each 256 KiB chunk for old sender compatibility. Checkpoint rename durability requires syncing its directory. Keep staging internal and publish into Downloads/CD via MediaStore. Source remains live on CLI.

Local v2 server handles same join and fresh-nonce proof exchange and binary framing as relay. Sender uses its accepted websocket in resumeSession. When local transport fails, reconnect both peers on existing v2 relay with fresh nonces; never reuse sequence/key pairs. Endpoint chosen through offer.localUrl when LAN reachable, otherwise existing relay derived from url. Automatic retries stop after explicit Pause or Stop. Distinguish pause/retention from Cancel and discard.

Resumable relay waiting peers expire after 16 minutes; paired peers expire after 15 minutes without forwarded records. Forwarding renews both peers without per-frame storage writes or alarm resets. Expiry preserves checkpoint capability and nonce history. An authenticated join beyond the existing 128-session limit receives `{type:"exhausted",protocol:"cd-transfer-v2",reason:"session_limit"}` and close code 4410. Clients stop retrying that root and retain partial state. Replays still close with 4409.

## Native WebRTC path

For a non-local transfer of at least 1 MiB, the encrypted v2 file offer may include `direct:{sdp}`. Android answers using encrypted receiver record kind 9, containing `{sdp}` or `{candidate:{candidate,sdpMid,sdpMLineIndex}}`. The channel is reliable, ordered and negotiated, with label `cd-direct` and ID 1. Ciphertext records use the existing v2 header and are split into at most 64 KiB channel messages. Reassembly is bounded by the maximum record size.

Relay transfer starts while ICE negotiates. Optional negotiation failure leaves relay transfer available. To switch, the sender first reaches a complete receiver acknowledgement interval and drains every outstanding durable ACK. Only subsequent CHUNK records move to WebRTC. ACK, signaling, END and COMPLETE stay on the relay. END follows acknowledgements for every chunk, so it cannot overtake direct data. A used direct path that fails interrupts the attempt and recovers through a fresh authenticated resume session. No opener skips sequence checks to merge transports.

The receiver's mobile-data policy must constrain native ICE as well as WebSocket sockets. A native path that cannot enforce that policy remains unavailable while relay transfer continues through the allowed bound network.

## Ownership

Parent owns cmd/cdx integration, worker control-room implementation, shared docs and end-to-end verification.
Core worker owns ONLY internal/devices/** for paired codec, private store, local control server, mDNS advertise and Go tests. Export practical APIs; document usage to parent without editing cmd/cdx.
Android worker owns ONLY android/** for a buildable native app, controls, background service, pairing, local discovery, persistent trust, v2 receive, and tests.
Research worker writes ONLY docs/implementation/android-platform-research.md; inspect toolchain and current official Android docs. Do not modify Android SDKs, project source or system configuration.
