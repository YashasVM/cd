# Transfer speed improvement plan

Start with the ordinary browser transfer path. Fresh local tests show that its automatic direct route can finish more slowly than the relay. Profile that difference, remove measured copying and scheduling costs, and verify the changes on two devices. The resumable path has separate, larger limits that require a bounded send window and cheaper durable storage.

Three agents independently audited transport, browser processing, and measurement validity. This document combines their source findings with fresh measurements. Production transfer code is unchanged. The added files are reports, measurement output, and audit helpers.

## What the measurements establish

All rates below use MiB/s. Builds and relay startup are outside transfer timers. Successful transfers passed complete SHA-256 checks. These experiments run on one Linux host with an Intel i5-13420H, Go 1.26.8, and Chromium 152. They measure local processing and artificial latency, not internet capacity.

| Experiment | Result | Meaning |
| --- | --- | --- |
| Ordinary browser transfer, automatic route, 64 MiB | 18.36 MiB/s, 5/5 completed | Actual direct traffic dominates. Includes final download save and sender completion. |
| Same browser transfer, forced relay | 30.57 MiB/s, 5/5 completed | About 1.67 times the automatic route's median rate in this local comparison. |
| CLI relay, committed HEAD | 310.09 MiB/s, 6/6 completed after warm-up | Historical client baseline against the same current local Worker. |
| CLI relay, working tree | 307.10 MiB/s, 6/6 completed after warm-up | About 1% lower median. This test does not establish a material sustained regression. |
| CLI ordinary/resumable, 100 ms added ACK RTT | 18.64 / 2.03 MiB/s | Resume's per-chunk wait limits throughput. |
| CLI ordinary/resumable, 300 ms added ACK RTT | 8.36 / 0.736 MiB/s | Resume's latency penalty grows as predicted by its send loop. |
| Browser OPFS reopen versus persistent worker handle | 17.23 / 198.02 MiB/s | Storage-only experiment. This is not an 11.5 times transfer-speed prediction. |
| Actual browser resume staging API | 12.11 MiB/s | Includes hashing, data commits, and checkpoint transactions. |
| Browser incremental JavaScript SHA-256 | 52.56 MiB/s; 12.56 at 4x CPU throttle | A CPU limit in the resumable path. Ordinary v1 transfers do not use this hasher. |

Sources: [derived summary](transfer-speed-2026-10-18/summary.json), [browser route comparison](transfer-speed-2026-10-18/browser-interleaved-light.json), [warmed CLI comparison](transfer-speed-2026-10-18/cli-head-comparison-warm.json), [latency experiment](transfer-speed-2026-10-18/network.json), and [browser components](transfer-speed-2026-10-18/browser-storage.json).

The browser route comparison alternates route order across five pairs after a warm-up pair. It uses the application's existing byte counters, without wrappers around native sends or per-piece heap sampling. All five pairs favor relay, with paired rate ratios between 1.39 and 1.84. Both endpoints share Chromium and host CPU. The relay is local and has no internet or TLS path. These results justify investigating direct overhead; they do not justify globally preferring relay in production.

An earlier detailed route probe completed four of five automatic trials and all five relay trials. The failed automatic trial timed out before publishing its code. Its cause was not captured. All four completed pairs favored relay, and inbound/outbound record counters agreed. The final helper isolates each pair in its own local Worker to keep code-directory requests and socket joins within production admission limits. The failure remains in [the original artifact](transfer-speed-2026-10-18/browser-interleaved.json).

An initial five-pair CLI comparison had two slow working-tree trials near 148–150 MiB/s. The warmed repeat did not reproduce them, but it does not identify their cause. Keep cold-start variation in subsequent measurements. The historical comparison covers CLI clients on forced relay against the current Worker; it does not compare whole releases, browser versions, or direct paths.

## Regressions and confirmed costs

No controlled historical browser regression has been established. Old benchmark route labels and timer boundaries cannot support that conclusion. The ordinary browser window changed from a fixed 8 MiB at HEAD to 4 MiB initially, with a 1–12 MiB adaptive range. That is a specific regression candidate on high-delay paths and needs an isolated comparison.

The following costs are confirmed in the current source:

- The ordinary browser sender consumes ACKs when its window blocks and at the end. Its controller timestamps processing rather than arrival. A synthetic schedule through the actual controller produces a 130 ms RTT sample instead of 10 ms for the same ACK. This proves sampling bias, not a throughput percentage. See [`relay-sender.js`](../../src/relay-sender.js#L378), [`send-window.js`](../../src/send-window.js#L57), and [the proof](transfer-speed-2026-10-18-browser-proof.mjs).
- Direct browser assembly copies 1,179,704 bytes for one 262,172-byte encrypted record, or 4.50 times the record size. The proof instruments the actual assembler. This copying already exists at HEAD, so it is an improvement opportunity rather than a newly introduced regression. See [`direct-link.js`](../../src/direct-link.js#L45).
- Direct sends poll buffer drain every 10 ms despite configuring a low-buffer threshold. Event-driven waking can remove avoidable waits. The [WebRTC specification](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamountlowthreshold) defines the threshold event. Throughput impact remains unmeasured.
- Both resumable senders wait after every 256 KiB chunk. CLI receivers synchronize staging and checkpoint files before ACK; browser receivers replace their writable staging stream and commit strict IndexedDB metadata. See [`resume.go`](../../cmd/cdx/resume.go#L423), [`resume_storage.go`](../../cmd/cdx/resume_storage.go#L24), and [`resume-browser.js`](../../src/resume-browser.js#L449).
- Browser resume reopens `createWritable({ keepExistingData: true })` for every chunk. The [File System specification](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable) defines preservation through a temporary file. Implementations may optimize physical copying, so quadratic physical disk I/O remains unproven. The growing cost is measurable: median successive 4 MiB storage quarters took about 67, 173, 293, and 364 ms.
- Resume hashes the entire source before publishing a link and hashes data again during transfer. Browser receive also rehashes the completed staging file. The incremental hasher allocates state arrays throughout compression. See [`resume-browser.js`](../../src/resume-browser.js#L40) and [`incremental-sha256.js`](../../src/incremental-sha256.js#L4).

Resume is opt-in. Its penalty does not explain a slowdown in an ordinary transfer.

## Implementation order

### 1. Establish the ordinary-transfer profile and regression gate

Use the new route comparison as a reproducible starting point. Add phase timings for source reads, encryption, native send waits, direct assembly, decryption, sink writes, durable commits, and final save. Keep receive-join-to-completion as the user-visible result. Record first-payload latency and sustained payload goodput separately.

Compare automatic routing and forced relay for CLI-to-CLI, browser-to-browser, and both mixed directions. Use the same fixture, sink, machine state, and timing boundaries. Include cold and warm cases. Run corrected HEAD/current browser comparisons before labeling the adaptive window a regression.

Use at least seven paired trials for an optimization decision. Use at least 20 when reporting a p95. Keep failed attempts in the completion denominator. Record actual accepted payload route bytes, duplicate replay bytes, CPU, peak RSS/heap, queue maxima, and sender idle time. Fix the direct Go microbenchmark's ignored errors and missing payload verification before relying on it.

Repeat the shortlist on two physical devices over LAN and separate internet connections. A shaped network must cover UDP/SCTP as well as WebSockets. Compare payload goodput with independently measured path capacity. For large fixtures, generate and verify bytes as streams so the benchmark itself does not retain the whole file in RAM.

Deliverable: one comparable baseline and a profile that identifies which stage limits ordinary direct and relay transfers. This is the first gate, not a request for additional product features.

### 2. Reduce work in the ordinary browser path

Make each candidate separately so its effect is measurable.

1. Assemble each direct record into one bounded allocation after validating its header. Avoid repeated prefix concatenation and the final full-record copy. Add an aligned-chunk pass-through in `rechunk()` and avoid redundant ciphertext copies where buffer ownership permits. Target at most about 1.1 times the record size in the assembly copy proof, then check actual completion time and GC activity.
2. Consume authenticated ACKs continuously in one ordered receive processor. Separate arrival and processing timestamps. Account for a sent record before an ACK can acknowledge it. Preserve sequence order, replay handling, and bounded queues. Compare against the current implementation with identical window limits, then compare the adaptive controller against the old fixed 8 MiB window.
3. Wake direct sends using `bufferedamountlow`, with cancellation and a deadline. Keep bounded polling for WebSocket. Retain the existing native buffer caps while testing the change.
4. If the profile still shows serial source-read waits, prefetch one or two chunks within a shared byte budget. Parallel encryption needs a separate design: the current sealer increments its sequence after awaiting encryption, so concurrent calls would reuse an AES-GCM nonce. Reserve sequences before dispatch and emit records in order if concurrency is introduced.

The direct-specific assembly and event costs are candidates for the observed route gap. ACK handling affects both routes and must not be presented as its proven cause.

Acceptance: at least 20% median completion improvement in the targeted constrained case, no unexplained slowdown over 5% in other core cases, unchanged successful delivery and integrity, and memory that plateaus as file size grows. These are decision targets, not promised speedups.

### 3. Remove resumable storage and round-trip serialization

First keep one OPFS sync access handle in a dedicated worker. Write at explicit offsets and check short writes. Flush data, complete the authenticated checkpoint transaction, then ACK the durable offset. Close the handle before reopening the completed file for final verification. The [flush contract](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-flush) requires cached modifications to reach underlying storage. Keep a bounded fallback for browsers without this API.

Then add a bounded v2 send window and cumulative durable ACKs in Go and JavaScript. Start with a 4 MiB window and test 1 or 2 MiB durable batches with a short timer. Batch size must fit inside the send window. Flush a final partial batch. Keep received, committed, and acknowledged offsets separate. After interruption, discard or retransmit the uncommitted suffix.

Coordinate the queue limits: the current browser v2 inbox is only 2 MiB, so a 4 MiB plaintext window plus framing cannot fit it unchanged. Budget plaintext, ciphertext, queued records, native buffering, and retained replay bytes together, below the relay's 32 MiB peer budget. Preserve bounds for slow receivers.

Negotiate batching. An old sender waits after its first chunk, so a new receiver that silently waits for a multi-chunk batch would deadlock. A pipelined new sender can work with an old receiver's per-chunk ACKs; a new receiver batches only after the sender advertises that behavior. Test all old/new Go/browser pairings.

The present data-phase ceiling is approximately `0.25 MiB / (ACK RTT + durable work)`. It is at most 2.5 MiB/s at 100 ms even with an arbitrarily fast link. A bounded pipeline removes that one-chunk restriction. It does not remove disk, crypto, or congestion-control limits.

Acceptance milestones on the controlled fast-host latency test: at least 10 MiB/s at 100 ms and 5 MiB/s at 300 ms, with verified bytes and the same recovery guarantees. Test process termination before and after data flush, checkpoint commit, and ACK. Restart must never accept an offset beyond recoverable data. Repeat durability measurements on disk; `/tmp` in this audit is tmpfs.

### 4. Replace the remaining hash and transport limits only where they bind

For browser resume, compare an allocation-reduced scalar hasher with a verified streaming WebAssembly implementation in the worker. Preserve prefix-state cloning, golden vectors, and final persisted-file verification. Measure readiness and total completion, not only the transfer phase. A worker alone moves CPU work off the page; it does not make the hash faster. Full-file WebCrypto needs a full-file buffer and is not a bounded-memory replacement.

For ordinary direct traffic, sweep Pion SCTP receive credit only if profiles show it limiting delivery. The CLI configures 8 MiB even though its application window can reach 24 MiB. At 300 ms, 8 MiB of effective receive credit has a theoretical ceiling near 26.7 MiB/s. Test 8, 16, and 24 MiB with congestion-window, receive-credit, CPU, and memory telemetry before changing defaults.

Investigate route promotion on real paths. The current link promotes whenever direct opens and replays outstanding ciphertext without comparing delivered rate. Any policy change needs safe handoff and replay handling. The local relay advantage is a reason to measure this policy, not sufficient evidence for a universal relay preference.

Bring the v2 encrypted records onto direct transport after pipelining and storage work succeeds. Its current path is relay-only, and the v1 direct assembler rejects version 2. Direct transport alone would retain stop-and-wait's RTT limit. Treat CLI ICE gathering's one-second offer dependency as a separate small-file startup improvement.

## Verification and review artifacts

The application build passed. The focused controller, direct framing, resume staging, hash, and benchmark-helper suites passed 28 tests. [The deterministic proof](transfer-speed-2026-10-18-browser-proof.mjs) reproduced the copy count and synthetic RTT bias. These checks protect the audit's measurements; they do not constitute a performance fix.

Regenerate the summary with:

```sh
python3 docs/measurements/transfer-speed-2026-10-18/summarize.py
```

The [measurement directory](transfer-speed-2026-10-18/) contains runnable CLI and browser comparisons, raw trials, logs, and provenance. The [transport audit](transfer-speed-2026-10-18-transport.md), [browser audit](transfer-speed-2026-10-18-browser.md), and [evidence audit](transfer-speed-2026-10-18-evidence.md) provide deeper source references. Their earlier measurements are explicitly dated; the fresh results in this plan take precedence.

Retained invalid evidence includes an early lightweight route run whose JSON export failed on a BigInt. Its log is excluded from speed claims. The repaired helper produced the complete ten-trial lightweight comparison cited above.
