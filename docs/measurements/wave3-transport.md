# Wave 3 browser direct transport

Owner: Agent A. Owned files: browser sender `src/relay-sender.js`, shared direct framing/connection `src/direct-link.js`, encrypted browser receiver `src/share.js`, transport unit tests, this report. Agent B owns the adaptive controller (`src/send-window.js`), and Agent C owns live transport verification and benchmark scripts. Existing entry pages use the shared sender without additional wiring.

Browser sending now offers WebRTC SDP in the authenticated OFFER and uses negotiated ordered data channel ID 1, matching CLI framing. The same AES-GCM ciphertext travels on both routes. Direct setup starts while waiting for a receiver, with gathering bounded to 250 ms. Transfers start on relay and upgrade when direct opens; previously unacknowledged ciphertext is replayed without resealing or resetting record counters. Receiver mergers drop replay copies and preserve sequence order. Setup failures retain relay fallback. Loss after direct carries data fails actionably rather than attempting unsafe replay after unknown delivered progress.

The sender uses Agent B's bounded adaptive window (1–12 MiB, 4 MiB initially), admitting a full chunk before encryption/send. ACKs release retained ciphertext. Native buffering is independently backpressured with bounded drain deadlines. Cancellation closes established and pending direct offers. Numeric share codes and private links retain CLI/browser interoperability.

## Explicit bounds

| buffer | bound |
| --- | --- |
| sender replay ciphertext | 16 MiB and 128 records |
| sender response queue | 4 MiB and 256 events |
| shared record merger | 16 MiB and 256 records |
| direct record assembler | 1 MiB record plus one 64 KiB piece |
| direct native outbound bufferedAmount | 4 MiB |
| relay native outbound bufferedAmount | 4 MiB |
| direct helper pending sends | 16 MiB and 256 records |
| browser receive processing queue | 32 MiB and 512 records |
| receiver ACK/signaling replay | 128 KiB and 128 records |
| remote/local trickled candidates | 64 candidates, 4 KiB per candidate |
| SDP | 64 KiB |

The processing queue accounts all records released by a merger, including earlier out-of-order records, and bounds text events as well as ciphertext. If unused direct negotiation exceeds receiver ACK replay limits, it is abandoned while relay remains usable. These limits apply to transport buffers; staging/destination buffering follows the sink policy and is verified separately.

Production emits no transport diagnostics by default. Tests may supply `hooks.onTransport`, or explicitly install `globalThis.__CD_TRANSFER_TEST_OBSERVER__`, to inspect route-byte counters, queue maxima and window accounting. Observations contain no payload or capabilities.

## Validation and measured observations

`npm test` passed 64 tests in 766.56553 ms. `npm run typecheck` and `npm run build` pass. Ten focused transport tests prove exact real AES-GCM relay fallback, queued admission processing, native WebSocket drain, unsolicited response rejection, assembler/header bounds, merger byte/count limits, direct native/pending-send caps, and candidate caps.

Agent C observed the following live local Chromium/CLI transfers on 2026-10-09. All payload SHA-256 hashes matched. Reported route payload counts include retransmitted copies and therefore can sum above unique file size.

| direction | unique payload | direct payload bytes | relay payload bytes | completion |
| --- | --- | --- | --- | --- |
| browser → browser | 16 MiB | 16,777,216 | 262,144 | 2.219 s |
| browser → CLI | 16 MiB | 15,728,640 | 5,242,880 | 0.708 s |
| CLI → browser, decrypt delayed 10 ms/record | 64 MiB | 48,234,496 | 26,738,688 | 4.020 s |

These establish actual encrypted CHUNK bytes on direct paths in both directions and successful relay-to-direct upgrades, rather than inferring direct use from an open channel. Agent C's final matrix/report covers blocked connections, slow receivers, queue maxima, and payload integrity. Loopback results measure local protocol/CPU behavior; internet throughput is not inferred.
