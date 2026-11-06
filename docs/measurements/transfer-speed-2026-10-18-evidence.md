# Transfer-speed evidence and measurement plan

The checkout has confirmed throughput limits, but the available measurements do not establish a historical transfer-speed regression. The largest measured penalty belongs to opt-in resumable transfers. Ordinary browser transfers also have a large measured gap against CLI loopback capacity, whose cause still needs a profile.

This audit read the current source, Git history, benchmark scripts, and the 17 October measurements. It ran only `node --test scripts/bench-metrics.test.mjs`, which passed all five tests. It did not run competing transfer benchmarks or change production code.

## What the existing evidence proves

All 20 SHA-256 source fingerprints in [the measurement provenance](perf-audit-2026-10-17/provenance.json) match the current files. The fingerprints were captured after the measurements, so they identify the recorded checkout but do not independently prove that every individual trial used that exact state. The provenance explicitly records uncontrolled competing load and the failed Go profiling attempt.

| Observation | Evidence | Interpretation |
| --- | --- | --- |
| At 100 ms added ACK RTT, CLI v1 measured 18.78 MiB/s and v2 measured 2.04 MiB/s. At 300 ms, they measured 7.98 and 0.72 MiB/s. | `perf-audit-2026-10-17/network.json`, three verified successes per mode and delay. | Strong evidence that stop-and-wait limits v2. These are paired mode comparisons, not an optimization's before-and-after results. |
| Browser staging measured 13.57 MiB/s when reopening after each chunk, versus 172.23 MiB/s with a worker access handle and flush after every chunk. | `perf-audit-2026-10-17/storage.json`, three successes per mode. | Strong evidence for a storage experiment worth implementing. The 12.7x ratio is an isolated storage result, not a transfer-speed promise. |
| Browser incremental SHA-256 measured 38.84 MiB/s, or 7.86 MiB/s with 4x renderer throttling. | `perf-audit-2026-10-17/browser.json`, three successes per setting. | Strong evidence of a CPU limit in resumable browser paths. This hasher is not on the ordinary v1 transfer path. |
| An early 64 MiB loopback run measured CLI relay at 286.00 MiB/s and browser relay at 32.58 MiB/s. | `perf-audit-2026-10-17/baseline-64.json`, five verified successes per mode. | Evidence of application and runtime overhead worth profiling. Both endpoints share a host. It does not measure internet bandwidth or identify which operation dominates. |
| A later loaded browser run measured direct at 14.96 MiB/s and relay at 9.13 MiB/s. | `perf-audit-2026-10-17/browser-routes-loaded.json`, three successes per mode in one invocation. | Direct improved completion time in this invocation. Comparing 14.96 to the earlier 32.58 would confound route with changing host load. |
| A Btrfs run measured CLI v1 at 16.64 MiB/s and v2 at 8.59 MiB/s with no added delay. | `perf-audit-2026-10-17/network-disk.json`, three successes per mode. | Shows a penalty in that complete v2 path. It does not isolate the cost of `fsync`. |

The v2 sender waits for an ACK after every 256 KiB chunk in [`cmd/cdx/resume.go:423`](../../cmd/cdx/resume.go#L423) and [`src/resume-browser.js:449`](../../src/resume-browser.js#L449). Its ideal data-phase ceiling is `0.25 MiB / RTT`, before encryption, storage, and handshake costs. That is 2.50 MiB/s at 100 ms and 0.83 MiB/s at 300 ms, close to the measured limits. The browser sender also persists its own checkpoint before the next chunk.

The browser receiver reopens a writable file with `keepExistingData`, writes a chunk, closes it, and saves a checkpoint in [`src/resume-browser.js:149`](../../src/resume-browser.js#L149). The measured cost rises across the growing file. The current evidence supports repeated commits as a bottleneck but does not identify the browser's internal copy or filesystem mechanism.

CLI v2 synchronizes the stage before publishing a checkpoint in [`cmd/cdx/resume.go:583`](../../cmd/cdx/resume.go#L583). [`cmd/cdx/resume_storage.go:27`](../../cmd/cdx/resume_storage.go#L27) also synchronizes the checkpoint file and containing directory. Their separate wall-time and syscall costs have not been measured.

## Regressions versus risks

No ordinary transfer is silently routed into v2 by default. The browser checkbox is initially unchecked in [`index.html:86`](../../index.html#L86), and [`src/main.js:345`](../../src/main.js#L345) selects v2 only for that checkbox or a resume link. The CLI branches into v2 only for explicit resume flags in [`cmd/cdx/main.go:510`](../../cmd/cdx/main.go#L510). The v2 penalty therefore does not explain a slowdown reported for ordinary sends.

One ordinary browser change deserves a controlled comparison. HEAD uses a fixed 8 MiB application window, while the working tree uses a 4 MiB initial window, 1 MiB minimum, and 12 MiB maximum in [`src/send-window.js:14`](../../src/send-window.js#L14). A smaller initial or minimum window can reduce throughput on high-delay links, while the larger maximum can help other links. The deterministic model in `wave3-window.md` proves one favorable model, not a net improvement across real routes.

ACK timing also needs investigation. The browser sender consumes ACKs only when its window blocks or after sending finishes in [`src/relay-sender.js:378`](../../src/relay-sender.js#L378). The controller timestamps ACK processing rather than network arrival in [`src/send-window.js:57`](../../src/send-window.js#L57). Queued ACK processing can distort RTT and delivery-rate samples. This is a source-level risk, not a proven throughput regression.

Direct negotiation can delay the first file offer for an immediately joining receiver. CLI transfer awaits `offerSDP` in [`cmd/cdx/sender.go:457`](../../cmd/cdx/sender.go#L457), whose gathering timeout is one second in [`cmd/cdx/direct.go:31`](../../cmd/cdx/direct.go#L31). Browser sending awaits its offer promise in [`src/relay-sender.js:329`](../../src/relay-sender.js#L329), with a 250 ms gathering bound in [`src/direct-link.js:153`](../../src/direct-link.js#L153). Waiting time overlaps a human's code entry, but immediate automation may expose it. The CLI wait predates the current working changes, so it is an existing opportunity, not a newly established regression.

Historical benchmark labels cannot establish a direct-path regression. At HEAD, `scripts/bench.mjs` named browser runs `p2p`, `legacy`, or `tunnel` without counting the payload route. Its `code` case measured `send --wait` on a tiny file instead of a detached transfer. It ran only one relay or browser throughput trial and did not fail the process for a failed browser trial. A comparison must rerun old and new source through the same corrected measurement contract.

Relevant history is reproducible with:

```sh
git log --first-parent --oneline HEAD -- cmd/cdx/sender.go src/relay-sender.js src/share.js scripts/bench.mjs
git show HEAD:scripts/bench.mjs
git show HEAD:src/relay-sender.js
git diff HEAD -- src/relay-sender.js
```

## Measurement gaps that can mislead the next plan

1. The default benchmark misses the normal automatic transport policy. All CLI modes force `CD_DIRECT=0` in [`scripts/bench.mjs:85`](../../scripts/bench.mjs#L85). The default set also omits browser P2P and v2 at line 30. `foreground` and `relay` invoke the same foreground send under the same relay-only environment.
2. A successful `p2p` run needs only 1 MiB of direct payload in [`scripts/bench.mjs:196`](../../scripts/bench.mjs#L196), even for a 64 MiB file. The resulting `encrypted-direct` label can describe a mostly-relay transfer. Counters include replayed copies, so dividing direct bytes by direct-plus-relay bytes does not give the fraction of unique delivered file data. Record the route of each accepted sequence number, replay bytes, and time of the first direct payload separately.
3. Browser duration stops at the download event before `download.saveAs` in [`scripts/bench.mjs:184`](../../scripts/bench.mjs#L184). The probe disables the file picker in [`scripts/bench-metrics.mjs:125`](../../scripts/bench-metrics.mjs#L125). These results cover the OPFS/download path and exclude final save time. They do not represent every sink or complete user wait.
4. Transport verification uses a different duration boundary. [`scripts/verify-transports.mjs:80`](../../scripts/verify-transports.mjs#L80) starts before receiver context creation and page navigation, and ends after saving and sender completion. Its MiB/s is not directly comparable to the regular benchmark's browser MiB/s.
5. Browser tests never await the sender's complete state before accepting a throughput result in `scripts/bench.mjs`. Received-file integrity is checked, but complete sender/receiver protocol agreement should be a separate success condition.
6. Successful medians and completion rate are correctly separate in [`scripts/bench-metrics.mjs:1`](../../scripts/bench-metrics.mjs#L1). Failed requested modes cause a nonzero exit. Preserve that behavior and add failure counts by stage, per-trial phase durations, unrounded values, dispersion, and enough trials before reporting a p95.
7. [`cmd/cdx/direct_bench_test.go:16`](../../cmd/cdx/direct_bench_test.go#L16) ignores setup, send, and receive errors and does not validate the payload. It can report byte throughput without proving those bytes arrived. Repair that contract before using the microbenchmark to justify transport changes.
8. The latency proxy delays complete WebSocket messages in [`scripts/perf-audit.mjs:62`](../../scripts/perf-audit.mjs#L62). It does not impose bandwidth caps, congestion, packet loss, jitter, or real UDP/SCTP behavior. It also bypasses HTTP admission latency. It diagnoses ACK serialization, but cannot rank transport performance on the internet.
9. The browser crypto test combines sealing, opening, and a JavaScript byte-by-byte comparison in [`scripts/perf-audit.mjs:198`](../../scripts/perf-audit.mjs#L198). Its throughput is not a pure AES-GCM number. The storage cases also include final reads, digest verification, and cleanup. Profile the actual pipeline before attributing its bottleneck to crypto.
10. The existing provenance lacks an executable hash, browser build hash, per-trial load, process peak RSS, and device/network route. Its CPU-throttled desktop Chromium is a useful sensitivity test, not a real mobile device measurement.

## Recommended experiment sequence

### Establish a comparable baseline

Freeze the current source and build outputs. Record commit, dirty patch hash, CLI executable hash, browser asset hash, browser version, filesystem, power mode, CPU load, endpoints, RTT, and independent path capacity. Use isolated state directories. Build and warm up before timing. Run one load-producing experiment at a time, with admission limits intact.

Add three explicit timing intervals: command or selection to share readiness; receiver join to first payload; and first payload to verified final destination plus both peers' completion. Also retain receiver-join-to-completion and total user wait. Report all of them, so a startup improvement cannot masquerade as higher sustained throughput.

Use the same measurement code on the old source and the current source. Interleave baseline and candidate in randomized paired runs, rather than running all of one version first. Start with three smoke trials, then use at least seven pairs for an optimization decision. Use at least 20 trials when reporting a p95. Keep failures in completion-rate calculations.

### Profile ordinary transfers first

Run CLI to CLI, browser to browser, CLI to browser, and browser to CLI. For each direction, compare automatic routing with forced relay. Classify runs as relay-only, mixed upgrade, or direct data after upgrade using actual accepted payload records. Add a steady-state direct measurement after setup without presenting it as user-visible completion time.

Use 1 MiB files for setup, 64 MiB files for the first throughput pass, and 512 MiB or larger files for sustained behavior where the sink supports them. Cover 0, 30, 100, and 300 ms RTT under both a 100 Mbit/s and 1 Gbit/s limit. Apply loss and jitter to a smaller shortlist after the no-loss baseline. Validate the final bytes on every success.

Capture browser traces and Go profiles with phase counters for source reads, sealing, queue waits, native buffer drain, decryption, sink writes, and finalization. Measure event-loop delay and process RSS. Repeat the best candidates on two physical devices over LAN and on separate internet connections. A localhost pair cannot establish deployment-region or NAT performance.

### Test the browser window and copy costs

Keep the wire protocol and route fixed. Compare fixed 8 MiB against the current controller and any proposed controller. Timestamp ACK arrival independently from controller consumption. Record flight bytes, window size, minimum RTT, delivery rate, native buffered bytes, and idle periods over time. Test immediate and delayed receiver joins.

Then isolate source slicing, record assembly, encryption scheduling, and OPFS batching. Change one operation per candidate. Keep the current memory bounds and integrity checks during these comparisons.

### Remove resumable serialization

After the ordinary baseline is understood, compare a bounded pipelined v2 sender against the current stop-and-wait sender under the same RTT. Keep cumulative ACKs behind a committed checkpoint. Measure sender checkpoint persistence separately from receiver persistence. Batch durable work only with an explicit maximum recovery distance and crash tests at each write, sync, checkpoint, and ACK boundary.

In browsers, test one persistent worker access handle against the repeated writable-file commits. Verify bytes after closing and reopening storage. Compare bounded-memory hash implementations and move the winner off the main thread. Measure both time to share readiness and full transfer time, since a faster transfer phase can still leave a long prehash delay.

## Decision targets

These are proposed acceptance targets, not measured promises:

- Ordinary transfer changes should improve the targeted constrained case by at least 20% across paired medians. Require no unexplained slowdown greater than 5% in the other core cases, no loss of completion reliability, and bounded memory as payload size grows.
- Require reproducible improvement on the actual automatic route before promoting changes based on a forced-relay or storage microbenchmark alone.
- For an initial v2 pipeline, target at least 10 MiB/s at 100 ms RTT and 5 MiB/s at 300 ms on the existing fast local test host, using the same integrity and crash-recovery guarantees. These are useful milestones above the present 2.04 and 0.72 MiB/s, not estimates for mobile devices or slow disks.
- Evaluate higher window limits against available path capacity. A 12 MiB application window permits at most 40 MiB/s over 300 ms RTT, and 24 MiB permits at most 80 MiB/s, before other costs. At 1 Gbit/s and 300 ms the bandwidth-delay product is about 35.8 MiB, already above the relay's 32 MiB budget. Raising one buffer cannot safely promise full line rate across that case.
- Preserve SHA-256 validation, authenticated records, replay handling, and the rule that a durable ACK cannot exceed committed recoverable data. Performance success includes successful delivery and recovery, not only a faster sender loop.

The existing artifacts justify the order of investigation. They do not justify a whole-codebase rewrite, a universal direct-versus-relay policy, or a claimed historical speed regression without matched reruns.
