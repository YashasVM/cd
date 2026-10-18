# Browser send pipeline measurements

The browser sender now consumes ACKs continuously, adapts its send window to ACK arrival times, and prepares three chunks ahead. The transfer protocol and 256 KiB wire chunks are unchanged. File and ZIP sources read 1 MiB at a time, aligned rechunking uses buffer views, and ZIP CRC32 processes eight bytes per iteration.

## Implementation

- `src/relay-sender.js:92` timestamps messages when the persistent pump receives them. An ignored message drains already queued events before it waits for another event.
- `src/relay-sender.js:240` gives encryption and transport separate promise chains. Every `sealer.seal` call remains serialized. `send(kind, payload)` is the only encrypted-record egress, and records go out in sequence order.
- `src/relay-sender.js:280` starts one ordered consumer for ACK and COMPLETE records. It authenticates records, validates counts, updates progress immediately, and wakes the sender. A COMPLETE preceding a close event finishes authentication before the close is handled.
- `src/relay-sender.js:302` limits queued sends to three 256 KiB chunks. The source can read while earlier encryption and sends run. This is 768 KiB of prepared plaintext plus encrypted records, independent of transfer size. Each built-in source read is bounded to 1 MiB. Views can retain the current and previous source buffers until encryption finishes.
- `src/send-window.js:9` ports `cmd/cdx/window.go`: twice delivery rate times minimum RTT, sampled across at least 100 ms and the minimum RTT, clamped between 8 and 24 MiB. Sent byte and chunk counters are updated before transport submission.
- `src/send-window.js:66` counts full encrypted records against the adaptive window. It also checks outstanding record bytes plus `WebSocket.bufferedAmount` against 32 MiB. Local socket bytes already belong to unacknowledged records, so they are counted twice only for this conservative hard safety limit.
- `src/zip-bundle.js:35` uses slicing by eight for CRC32, with the same incremental checksum API and ZIP output.
- `src/zip-bundle.js:164` reads 1 MiB per Blob slice. `rechunk` yields aligned 256 KiB subarray views and allocates a buffer only for a partial chunk.

The sealer itself is unchanged. Tests decrypt the pipelined output and require consecutive record sequences. Another test holds every ACK and verifies that the sender stops at 31 encrypted chunks in the initial window plus three prepared chunks. The 32nd full record would exceed 8 MiB after its header and GCM tag are included.

## Method

Base: `origin/main` at `9732bbb7062292cc790f89e62520b3c0b8ad1b27`. Implementation branch: `perf/browser-send-pipeline`.

Chromium 152.0.7977.82, headless through `playwright-core`; Node v26.10.0; local Wrangler relay. The benchmark extracts the base commit into a temporary directory inside this worktree and builds its browser assets. Both browser versions use the same relay. All receiver pages use the base browser build, which isolates sender changes and checks compatibility with an already loaded receiver.

A local WebSocket proxy delays each message by one quarter of the requested RTT on each of the sender-to-relay, relay-to-receiver, receiver-to-relay, and relay-to-sender traversals. The configured delays are nominal added RTT, excluding local processing and timer scheduling. HTTP lookup requests are not delayed. Compression is disabled. The local proxy gives connections distinct test IP addresses to avoid measuring relay admission rate limits.

Each size and latency has five adjacent old/new pairs. Pairs alternate which version runs first. Payloads are 64 and 256 MiB. Every download is saved and checked against the source SHA-256. Timing starts at code entry and ends at the download event. `wireSeconds` separately spans the first CHUNK sent through COMPLETE arrival. Download copying and SHA-256 verification happen outside both timings.

The machine is shared with other builds and benchmarks. Raw samples include scheduling and CPU-load outliers. The report retains those samples and reports paired ratios as well as medians.

Reproduce the transfers from this worktree:

```sh
make cdx
npm run build
CD_BSEND_RTT=0,50,150,300 CD_BSEND_OUT=docs/measurements/browser-send-results-2026-10-18.json node scripts/bench-browser-send.mjs
```

Reproduce source, checksum, and encryption microbenchmarks:

```sh
CD_BSEND_MICRO=1 CD_BSEND_OUT=docs/measurements/browser-send-micro-2026-10-18.json node scripts/bench-browser-send.mjs
```

The microbenchmark alternates base and new modules five times on the same Chromium instance. Each sample processes 64 MiB. Encryption experiments use fresh keys and do not send their experimental chunk sizes to a receiver.

## Transfer results

All 80 downloads passed SHA-256 verification. The additional 64 MiB CLI receive passed too. Raw measurements are in [browser-send-results-2026-10-18.json](browser-send-results-2026-10-18.json).

The last column is the median of the five paired throughput ratios, calculated as `old.seconds / new.seconds - 1`. It is not the ratio of the two median throughputs.

| MiB | Added RTT, ms | Base median, MiB/s | New median, MiB/s | Paired change |
| --- | --- | --- | --- | --- |
| 64 | 0 | 30.71 | 27.79 | -7.0% |
| 64 | 50 | 30.29 | 29.70 | -19.1% |
| 64 | 150 | 26.40 | 26.73 | +1.9% |
| 64 | 300 | 15.38 | 19.06 | +19.8% |
| 256 | 0 | 30.03 | 34.18 | +3.2% |
| 256 | 50 | 29.43 | 32.40 | -8.7% |
| 256 | 150 | 36.62 | 31.87 | -14.6% |
| 256 | 300 | 21.63 | 31.33 | +45.2% |

Samples below are MiB/s in pair order, including every outlier.

- 64 MiB, 0 ms: base `[34.97, 32.19, 30.71, 29.00, 27.33]`; new `[28.71, 29.93, 6.78, 27.79, 26.62]`.
- 64 MiB, 50 ms: base `[27.78, 30.29, 24.43, 36.70, 35.86]`; new `[22.04, 9.18, 30.87, 29.70, 31.08]`.
- 64 MiB, 150 ms: base `[8.95, 22.69, 28.13, 26.40, 27.66]`; new `[26.73, 26.50, 27.53, 26.91, 21.38]`.
- 64 MiB, 300 ms: base `[5.03, 15.18, 15.38, 16.24, 16.72]`; new `[19.85, 18.18, 18.12, 19.64, 19.06]`.
- 256 MiB, 0 ms: base `[31.87, 33.38, 18.23, 30.03, 30.03]`; new `[34.32, 34.44, 34.18, 13.06, 15.55]`.
- 256 MiB, 50 ms: base `[29.43, 30.71, 17.89, 19.63, 38.38]`; new `[22.89, 28.05, 34.76, 32.40, 33.14]`.
- 256 MiB, 150 ms: base `[30.83, 35.67, 37.09, 37.31, 36.62]`; new `[18.04, 32.05, 16.60, 31.87, 35.78]`.
- 256 MiB, 300 ms: base `[21.63, 21.61, 21.42, 21.97, 21.80]`; new `[33.11, 29.42, 31.11, 31.33, 31.94]`.

The 300 ms path improves at both sizes. Shorter paths are mixed, with observed regressions in several paired comparisons. These results do not establish a universal browser-send speedup. Short-path performance remains an integration risk.

An initial trial counted the local socket queue twice against the adaptive target itself, reducing effective capacity. The final implementation reserves that extra accounting for the 32 MiB safety check. The table above uses the corrected implementation.

A separate two-pair, 256 MiB loopback profile is in [browser-send-profile-2026-10-18.json](browser-send-profile-2026-10-18.json). It did not reproduce the severe stalls from the main run. Base ArrayBuffer backing-storage peaks were 69.6 and 103.6 MB; new peaks were 98.7 and 78.0 MB. These peaks do not suggest retention of the whole 256 MiB payload. The base sender used 3.35 to 3.45 s of main-thread task time, compared with 2.68 to 2.77 s for the new sender. Transfer time was 5.49 to 5.50 s for the base sender and 5.62 to 5.88 s for the new sender. The profile does not establish the cause of the remaining short-path regression.

## Source and record-size measurements

Five interleaved module pairs, each processing 64 MiB. Times are milliseconds. Raw samples are in [browser-send-micro-2026-10-18.json](browser-send-micro-2026-10-18.json).

| Work | Base median | New median |
| --- | --- | --- |
| File source, default read size | 183.4 | 166.8 |
| File source, explicit 1 MiB reads | 148.2 | 122.3 |
| ZIP source and rechunk | 375.5 | 243.5 |
| CRC32 only | 133.0 | 76.2 |

The default file-source sample improves from 183.4 to 166.8 ms. ZIP generation falls from 375.5 to 243.5 ms, and CRC32 falls from 133.0 to 76.2 ms. These are source-only measurements, not end-to-end transfer gains.

There is no consistent evidence here that larger wire records would improve end-to-end throughput. Sequential sealing of 64 MiB at 256 versus 512 KiB takes 70.8 versus 77.1 ms in the base-module samples, and 81.4 versus 68.0 ms in the new-module samples. The codec is unchanged between those modules, so that disagreement reflects measurement variability. Both costs are small compared with multi-second transfers.

A 256 KiB record adds a 12-byte header and 16-byte GCM tag, just 0.0107% overhead before WebSocket framing. Doubling record size halves call and record counts but saves only 0.0053 percentage points of that byte overhead. A negotiated 512 KiB size could help on other CPU-bound devices, but this experiment does not establish a transfer gain. Existing receivers accept only 64 and 256 KiB chunks, and 1 MiB plaintext would exceed the current 1 MiB maximum record after its header and tag. No experimental sizes were sent on the wire.

## Compatibility and integration

All transfer benchmark receivers use the base browser page. The script also sends 64 MiB to `bin/cdx receive <code>`, built with `make cdx` from unchanged Go source at the base commit, and verifies its output hash.

For the concurrent WebRTC change, preserve the two ordered promise chains and keep transport selection at `socket.send(sealed)` inside `send`. Account for each CHUNK once before sending it. Route SIGNAL records through the same ordered inbound consumer without treating them as ACKs. Include any direct-channel queue in the transport buffer callback supplied to `waitForSpace`.

No deployments, pushes, or pull requests are part of this work.

## Verification and remaining work

- `npm test`: 85 tests pass. The new ACK-consumer tests cover immediate progress while a read blocks, ordering and authentication through the real codec, malformed and regressing ACK counts, early COMPLETE, cancellation, changing source size, completion followed by close, and bounded prefetch.
- `npm run build`: passes.
- `npx tsc`: passes.
- `go test ./...`: passes.
- `make cdx`: passes. The 64 MiB new-browser-to-CLI compatibility transfer passes SHA-256 verification.
- `node scripts/verify-browser.mjs`: passes typed-code browser receive, numeric-link paste and autofill, a three-file ZIP transfer to the CLI, and QR-camera browser receive. All received bytes match.
- `git diff --check`: passes.

Short-path performance regressions remain unresolved. The two-pair profile rules out obvious whole-file buffer retention in that repeat, but it does not identify the cause of the severe stalls in the main run. The report therefore supports the measured 300 ms gains and source-preparation improvements, rather than a claim that all browser sends are faster. WebRTC integration remains with the concurrent implementation agent.
