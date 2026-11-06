# Browser transfer speed audit, 2026-10-18

The default encrypted browser transfer needs continuous ACK processing and fewer buffer copies before larger windows or parallel crypto. The separate, opt-in resumable path has larger confirmed costs: one durable 256 KiB chunk per round trip, an OPFS writer reopened for every chunk, and slow JavaScript SHA-256.

This is a source audit and a plan. Production code is unchanged. No fresh browser throughput benchmark ran in this audit, to avoid competing with the coordinator's measurements.

## Evidence and scope

The checkout starts at `57232025406c6b86e688ffa598319cab7ffd60e8` and contains substantial pre-existing uncommitted work. `resume-browser.js`, `incremental-sha256.js`, and `send-window.js` are untracked additions. `relay-sender.js`, `direct-link.js`, and `sink.js` contain tracked working-tree changes. Findings below describe the working tree, not a deployed release.

SHA-256 fingerprints for all seven browser sources listed in `perf-audit-2026-10-17/provenance.json` match the current checkout. Those existing measurements therefore apply to the inspected source. They remain local Chromium measurements from October 17, not fresh results or internet performance estimates.

Existing three-run median results, in MiB/s, separate storage and CPU costs.

| Existing test | Normal CPU | 4x CPU throttle | Meaning |
| --- | ---: | ---: | --- |
| Incremental JavaScript SHA-256 | 38.84 | 7.86 | Current bounded-memory hash implementation |
| Native full-buffer SHA-256 | 993.79 | 228.90 | A comparison ceiling, not a safe whole-file replacement |
| Record seal plus open | 92.75 | 15.66 | Includes a byte-by-byte verification loop |
| OPFS streaming sink | 139.74 | 50.70 | One open writer, coalesced writes, final verification |
| Resume receiver stage | 7.47 | 3.19 | Actual stage API, hash, OPFS commit, and strict IndexedDB checkpoint |
| OPFS reopen for each chunk | 13.57 | 4.72 | Storage-only isolation of the current writer pattern |
| Worker sync OPFS with flush after each chunk | 172.23 | 91.90 | Storage-only experiment, not a complete resume implementation |

Sources are `perf-audit-2026-10-17/browser.json` and `storage.json`, with test definitions in `scripts/perf-audit.mjs:188-273`. The 12.7x storage-only difference does not predict a 12.7x transfer improvement. The worker experiment also copies its 16 MiB input to the worker and verifies the final file. Real transfer code must remain bounded rather than copy the full file.

Existing 64 MiB browser direct runs report medians of 10.19 MiB/s and 14.96 MiB/s in two separate local batches. Their direct-route byte counters prove encrypted payload used WebRTC. The variation and workload differences prevent treating them as a regression comparison. See `direct-browser.json` and `browser-routes-loaded.json` in that measurement directory.

## Default browser path

### 1. Consume ACKs continuously and measure their arrival time

Confirmed source behavior: `src/relay-sender.js:378-398` decrypts and applies ACKs only when the current window is full, then again at the end. `deliver()` queues early arrivals at lines 107-121. `createSendWindow.acked()` samples `performance.now()` when called, rather than the message's arrival time. Its RTT and delivered-rate samples therefore include application queue delay.

The initial window changed from a fixed 8 MiB in HEAD to an adaptive 4 MiB initial window in the working tree. The maximum is 12 MiB. This is a regression risk on paths whose bandwidth-delay product exceeds the initial window, not a demonstrated throughput regression. The controller's scheduling tests omit real encryption, source read delays, and deferred ACK consumption.

The proof script uses the actual controller with a synthetic schedule. An ACK arriving at 40 ms produces a 10 ms RTT sample when processed immediately. Consuming that same ACK at 160 ms produces 130 ms. This demonstrates the sampling bias. It is not an observed browser trace and does not establish a throughput percentage.

Change: let one ordered receive processor decrypt control records continuously, update ACK state, and wake the producer when capacity becomes available. Preserve one opener per direction and record order. Timestamp messages on arrival. Arrival timestamps require separating sample time from state-application time, because the current controller rejects clocks older than the latest `sent()` call. Preserve byte and record bounds while doing so.

Experiment: compare current behavior against continuous ACK processing with the same 4 MiB initial and 12 MiB maximum window. Log ACK arrival, decrypt completion, consumption, bytes in flight, sender idle time, and window capacity. Use relay and direct routes with 0, 40, 100, and 200 ms added RTT. Compare against the old fixed 8 MiB window only after isolating ACK processing. Accept a change when completion improves without unbounded queues, stalled slow receivers, or misleading RTT samples.

### 2. Remove copies in the sender and direct receiver

Confirmed source behavior: `src/zip-bundle.js:162-179` copies every input into a new rechunk buffer, including a single-file source already yielding exactly 256 KiB. `src/agent-protocol.js:142` copies ciphertext with `slice()` before decryption. `src/direct-link.js:45-56` repeatedly copies the accumulated prefix for every 64 KiB piece, then copies the completed record again.

The proof script instruments `Uint8Array.set()` and `slice()` around the real assembler. A 262,172 byte encrypted record arrives in five pieces and causes 1,179,704 copied bytes, approximately 4.50x the record size. This copy count is exact for that input. It is not a wall-clock benchmark. The assembler algorithm and single-file rechunk copy already exist in HEAD, so these are improvement opportunities rather than new regressions.

Change: pass aligned chunks through `rechunk()` without copying. Assemble into one validated, bounded record allocation after parsing its header. Pass a ciphertext view to WebCrypto where compatible, rather than another owned copy. Keep immutability and ownership clear so buffers cannot change while encryption or decryption is pending.

Experiment: change these sites separately. Keep the existing split-record, merger, malformed-header, and buffer-bound tests. Measure 256 MiB and 1 GiB incompressible transfers at normal and 4x CPU throttle. Record GC time, long tasks, peak heap, and completion time. A lower copy count alone does not prove faster transfers.

### 3. Wake direct sends on buffer events

Confirmed source behavior: `src/direct-link.js:100` sets `bufferedAmountLowThreshold`, but lines 135-138 wait in 10 ms timer increments. The relay sender uses the same polling interval at `src/relay-sender.js:149-155`. These are working-tree additions that bound previously unbounded native sending.

Use `bufferedamountlow` to wake WebRTC sends and retain a deadline and a cancellation path. The [WebRTC specification](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamountlowthreshold) defines the event when the amount crosses the configured threshold. WebSocket still needs a bounded polling approach with the currently used API. Test event-driven waking before changing the 4 MiB cap. A larger cap without evidence increases memory and queue delay.

### 4. Overlap file reads with encryption within a fixed byte budget

The source loop awaits each `Blob.arrayBuffer()`, seal operation, and transport enqueue before beginning the next source read. See `src/zip-bundle.js:152-155` and `src/relay-sender.js:389-395`. A one- or two-chunk read-ahead queue can overlap disk reads with crypto and transport. Keep buffered plaintext inside the same memory budget as in-flight ciphertext.

Measure before adding parallel crypto. `createSealer()` increments its sequence after awaiting encryption at `src/agent-protocol.js:107-115`. Calling the current sealer concurrently would reuse a sequence and AES-GCM nonce. Any concurrent implementation must reserve each sequence before dispatch and emit the resulting records in order. Moving a fully ordered pipeline to a worker is a later option if browser traces show long tasks remain after copy reductions.

## Opt-in resumable browser path

### 1. Keep one worker OPFS access handle open

`src/resume-browser.js:149-161` opens `createWritable({ keepExistingData: true })`, seeks, writes, closes, signs a checkpoint, and waits for a strict IndexedDB transaction for every 256 KiB. All existing bytes are preserved on each reopen. The [File System specification](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable) describes temporary-file copying for this option. Browser implementations can optimize physical copying, so quadratic physical I/O is a hypothesis until disk activity confirms it.

The existing 16 MiB stage timings grow across successive 4 MiB quarters. In run 0, quarters take 288, 442, 646, and 739 ms. Reopening storage is independently much slower than the existing sync-worker experiment.

Use a dedicated worker with one OPFS sync access handle. Write at an explicit offset, check the written count, flush before advancing the checkpoint, commit checkpoint metadata, then acknowledge durable bytes. [The flush contract](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-flush) transfers cached modifications to underlying storage. The handle must close before other code reads the completed file.

Experiment: compare current staging, one sync handle with flush per chunk, and grouped durable commits at 16, 64, 256, and 1,024 MiB. Plot time per equal-size quarter and actual disk bytes written. Keep crash tests before flush, after flush, after checkpoint commit, and before ACK. Retain a bounded fallback where sync handles are unavailable.

### 2. Pipeline data beyond one chunk while keeping durable ACKs

`src/resume-browser.js:449-469` sends one 256 KiB chunk, waits for its ACK, updates its hash, signs its own checkpoint, and waits for another strict IndexedDB commit before reading the next chunk. Receiver ACKs follow durable staging at lines 565-570. The sender has no overlap across network, receiver persistence, and sender checkpoint persistence.

The ideal upper bound with no CPU or storage costs is `0.25 MiB / RTT`: 12.5 MiB/s at 20 ms, 5 MiB/s at 50 ms, 2.5 MiB/s at 100 ms, and 1.25 MiB/s at 200 ms. Actual rates are lower because both sides perform work on the serial path. This is a protocol-derived bound, not a measured network result.

Introduce a bounded send window and cumulative ACKs for committed offsets. Receiving bytes and durable checkpoint offsets remain separate. Group writes and checkpoint commits after a bounded byte count or elapsed time, and accept that interruption may retransmit the uncommitted suffix. Never acknowledge the suffix before its data and checkpoint are durable. The sender must still validate exact counts and byte boundaries.

This requires coordinated CLI and browser behavior. Current senders expect an exact ACK after every chunk, so a receiver cannot silently change ACK cadence with existing peers. Keep compatibility explicit and test every direction before changing defaults. Storage changes can improve throughput first without this wire behavior change.

### 3. Replace the hash implementation while preserving bounded memory

`src/incremental-sha256.js:4` allocates a new schedule array for every 64 byte block and a new eight-element state array in every compression round. Line 7 copies each entire input chunk before hashing it. Every hash runs in the caller's JavaScript context. The new resume path calls it on the page thread.

The sender hashes the entire source before publishing its link at `src/resume-browser.js:363-406`. It then hashes the retained prefix and every newly transferred chunk. A complete fresh or resumed send reads exactly twice the file size, assuming the file remains unchanged. The receiver hashes the retained prefix and incoming suffix, then reads and hashes the completed staged file again at lines 580-584. The final read verifies persisted bytes and should remain unless a replacement preserves that guarantee.

Use a verified streaming SHA-256 implementation with reusable state, ideally WebAssembly in the storage worker. Preserve state cloning for authenticated prefix checkpoints and the existing golden vectors. First compare a scalar-allocation cleanup of the current function against a streaming WebAssembly candidate. A worker alone improves responsiveness but does not eliminate the hash's CPU cost. Full-file WebCrypto requires a full-file buffer and violates the large-file memory requirement.

Experiment: compare digest correctness, hash throughput, startup-to-link delay, end-to-end completion, long tasks, and heap on large files and CPU throttle. Use 1, 2, and 8 MiB read batches independently of the 256 KiB wire size. Optimizing prehash throughput is the first startup change because the current offer authenticates the whole-file digest.

## Lower-priority work

The ordinary OPFS sink already coalesces writes into 512 KiB at `src/sink.js:93-114`. Keep that optimization. ZIP uses stored entries and streams bytes while computing CRC at `src/zip-bundle.js:90-97`. Existing CRC throughput exceeds measured browser network throughput, so compression or CRC replacement is not a first speed change. Compression would need content-specific CPU and byte savings evidence.

The older P2P receiver stages a whole file even when its save picker resolves early, then copies the staged file to the chosen destination at `src/main.js:923-934` and `1036-1048`. A staged-prefix handoff to the selected writer could remove much of that second disk pass. Verify which route still uses this code before prioritizing it. It does not describe the encrypted v1 receiver, which can write directly to its selected sink.

## Reproduction and completion criteria

Run the deterministic proofs from the repository root.

```sh
node docs/measurements/transfer-speed-2026-10-18-browser-proof.mjs
```

Output on this checkout:

```json
{"proof":"actual assembler copy count","inputBytes":262172,"pieceBytes":[65536,65536,65536,65536,28],"copiedBytes":1179704,"copyRatio":4.499732999710114}
{"proof":"synthetic ACK schedule through actual controller","ackArrivalMs":40,"timelyRttMs":10,"deferredRttMs":130}
```

Focused correctness verification passed 23 tests, with zero failures, in 119 ms.

```sh
node --test src/send-window.test.js src/direct-link.test.js src/incremental-sha256.test.js src/resume-browser.test.js
```

Before any speed change lands, compare five or more isolated A/B runs per selected case. Report median, slowest run, integrity, completion rate, peak heap, and actual route bytes. Separate source preparation, payload transfer, durable commit, and final verification time. Cover a normal large single file first, then resume, because the user's primary objective is transfer speed. Require no material slowdown in unmodified paths and unchanged memory and integrity bounds.
