# CD speed audit, 20 October 2026

The reported workflow is CDX sending to a phone browser through a numeric code. Same-network transfers are fast; mobile-data transfers are slow. This work fixes a reproduced candidate-loss bug, removes repeated browser record copies, and fixes delayed browser ACK processing. It does not establish the phone's actual 5G bottleneck: no carrier-path trace or phone measurement was available. Changes are local and have not been deployed.

## Fixes

- `cmd/cdx/sender.go` now reads the current local SDP when sending the file offer. Previously it used the snapshot taken after the initial one-second gathering window, dropping public candidates discovered while the recipient entered the code. The regression uses a real delayed local STUN responder and verifies that the transmitted offer includes its candidate. `src/direct-link.js` also reads the current SDP when a browser sender constructs its offer. This improves the opportunity to connect across networks; it cannot make every network permit a direct connection. Candidates arriving after the offer still require a future signaling change.
- `src/direct-link.js` assembles each incoming encrypted record into one allocation after validating the header. It no longer repeatedly reallocates and copies the growing prefix. Fragmented headers, multiple records, ownership, and size limits are tested.
- `src/relay-sender.js` processes ACKs concurrently with source reading and sending. Previously a source waiting for delivery progress could stall because ACKs were consumed only when the window filled or the source finished. A test failed before the fix and passes after it. One ordered receive loop still owns decryption. Buffer and window limits remain bounded. Tests also cover empty files, short sources, and source failures. ACK timing still includes decryption and event-loop scheduling; this is not exact network RTT instrumentation.
- `scripts/verify-transports.mjs` now explicitly tests CDX numeric codes with direct transport available and disabled. Existing CLI cases used full links.

## Measurements and verification

Evidence is in [the result directory](transfer-speed-2026-10-20/). The checkout contains substantial pre-existing uncommitted work. These results describe that working tree, not a clean release or a comparison against the published service. Source hashes identify the affected files at the end of verification.

The 128 MiB record-assembly benchmark verifies every reconstructed record. Median time across seven measured trials fell from 230.71 ms to 35.74 ms, about 6.46x faster. This is a Node CPU microbenchmark, not mobile-browser or network throughput. The before/after artifacts retain their original module URL; the pre-change module is preserved as `transfer-speed-2026-10-20/direct-link-before-assembly.mjs`.

All eight original transport cases and both new numeric-code cases completed with SHA-256 verification on 32 MiB files. Cases include forced relay, delayed direct upgrade, and slow browser decryption. Numeric-code direct measured 6.24 seconds, with 24 MiB sent directly and 15 MiB through relay. The sum exceeds the file size because upgrading replays unacknowledged records. Numeric-code forced relay measured 4.77 seconds. The direct test deliberately delays browser decryption by 10 ms per operation, so these timings do not rank direct against relay. They verify route selection, bounds, completion, and exact bytes.

There is no demonstrated end-to-end speedup in the small before/after CLI/browser sample: direct went from 4.48 to 4.97 seconds, forced relay from 3.85 to 3.73 seconds. These are single local runs with changing host load and direct-upgrade timing. Do not publish them as a performance claim.

JavaScript suite: all 96 tests passed, including the seven-test sender suite. Go suite, TypeScript checking, production build, and whitespace checks passed.

Reproduce with:

```sh
npm test
go test ./...
npm run typecheck
npm run build
CD_TRANSPORT_MIB=32 node scripts/verify-transports.mjs
node scripts/bench-assembly.mjs
```

## Remaining work, in priority order

1. **Measure the real mobile route.** Record direct versus relay bytes, connection time, selected ICE candidate type, ACK latency, and delivered throughput for the same large incompressible file over Wi-Fi and 5G. Compare against sender internet upload capacity. Without this, carrier reachability, relay placement, internet uplink bandwidth, and phone processing remain competing explanations. Existing `CD_TRANSPORT_REPORT=1` provides CLI route-byte totals; it does not provide the whole diagnosis. No amount of LAN tuning establishes internet capacity.
2. **Pipeline browser resumable sends.** `src/resume-browser.js` still awaits one ACK and saves a checkpoint per chunk. This limits throughput with latency. Introduce a bounded outstanding window while preserving the distinction between received bytes and durable, verified resume progress. Read ADR-0001 before changing checkpoint guarantees. The current CLI resume implementation differs; older audit statements that both implementations are stop-and-wait are stale. This is opt-in resume work, not the explanation for the reported default code transfer.
3. **Stop reopening browser resume storage per write.** The browser resume storage path opens with `keepExistingData`, writes, and closes repeatedly. Earlier storage-only experiments favor a worker-owned OPFS handle, but a shipping change must retain crash-safe checkpoint semantics, cancellation, bounded memory, and browser fallback. Do not remove durability to make a benchmark faster.
4. **Remove remaining redundant copies.** `rechunk()` copies even already aligned input; `createOpener()` copies the encrypted body before WebCrypto. Test buffer ownership and producer reuse before using views. These are plausible CPU savings, not yet measured transfer wins.
5. **Replace WebRTC drain polling with event-driven waking.** The direct path sets a low-water threshold but polls every 10 ms. Use its low-buffer event with close/error/deadline handling. Keep WebSocket polling bounded where there is no equivalent event. Measure under constrained bandwidth before increasing buffers.
6. **Improve immediate-join startup and late candidates together.** CLI offer gathering can expose a one-second wait for automation. Sending an offer earlier without sender-side trickle signaling can lose public candidates again. Design compatible signaling first; do not simply shorten the timeout.
7. **Retire the legacy PeerJS receive path after establishing compatibility usage.** `src/main.js` retains a separate legacy connection/retry/receive flow. Consolidating supported traffic onto the authenticated transfer engine would remove duplicate state handling. Existing legacy codes must have an explicit migration decision. PeerJS, QR generation, and resume are already dynamically imported, so deleting them is not automatically an initial-page speed win.

Avoid increasing every buffer, removing encryption or integrity checks, removing backpressure, or marketing isolated CPU results as transfer speeds. The most useful deletions are repeated copies and duplicated transport state, after compatibility is established.
