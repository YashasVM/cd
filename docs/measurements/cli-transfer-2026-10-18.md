# CLI transfer performance, 2026-10-18

The final CLI uses a 50 ms offer gather bound, one WebSocket write per normal encrypted chunk, and fewer record copies. Median paired results favored the new CLI on this shared machine. The direct-only microbenchmark did not establish a throughput improvement.

Baseline: `origin/main` at `9732bbb`. Implementation branch: `perf/cli-transfer`. Both CLI binaries used `go build -trimpath`. The released v0.3.5 source at `e7a7e5c` was also built and tested in both directions. No deployment, push, or PR was performed.

## Changes

- `cmd/cdx/direct.go:155` returns the offer after host gathering completes or 50 ms. Candidates remain bounded to 64. `cmd/cdx/sender.go:484` advertises optional `direct.trickle` support and refreshes the SDP from candidates gathered while waiting for a receiver.
- `cmd/cdx/sender.go:502` sends later candidates as SIGNAL records only after a receiver explicitly enables `trickle` in its answer. Candidate sends use the transfer loop and stop before END. `cmd/cdx/receive.go:350` accepts negotiated sender candidates, and `cmd/cdx/receive.go:513` advertises support only when the sender offered it.
- `cmd/cdx/link.go:97` gives Gorilla one encrypted 256 KiB chunk of write-buffer space. A regression test observes one client `net.Conn.Write` instead of 65. This adds about 256 KiB of bounded connection memory.
- `cmd/cdx/link.go:170` reads a binary record into one allocation from its bounded header, rejecting truncated, trailing, and oversized data. `cmd/cdx/protocol.go:165` reuses sealing storage only for synchronous relay writes without retained or queued records. Nonce and AAD storage belongs to each sealer or opener. `cmd/cdx/protocol.go:196` authenticates and decrypts owned inbound records in place.
- `cmd/cdx/direct.go:293` allocates each assembled direct record once and transfers ownership to the link. Completed records never share the next assembly buffer.
- `cmd/cdx/link.go:122` timestamps arrival before queueing. `cmd/cdx/sender.go:600` uses that timestamp for ACK measurements. Send timestamps now precede the socket write. ACK reading already ran continuously in a separate relay reader, so that design remains. `cmd/cdx/window.go:41` and `cmd/cdx/stripe.go:108` compact their bounded slices instead of repeatedly dropping capacity.
- `cmd/cdx/stripe.go:212` sets the drain threshold below the current direct cap, and `cmd/cdx/stripe.go:220` waits for drain, ACK, control, loss, or timeout events. The 2 ms polling timer is removed. A real direct-channel test covers a cap below the usual 2 MiB low-water threshold without ACK wake-ups.
- `cmd/cdx/receive.go:335` coalesces disk writes with a 1 MiB writer. Flush errors propagate, and `Flush` precedes the existing `Sync`, publication, and COMPLETE sequence at `cmd/cdx/receive.go:389`. ACK cadence stays at 1 MiB. A canceled receive now prefers the context error over the socket-close error in `cmd/cdx/link.go:302`.
- `cmd/cdx/direct_bench_test.go:13` uses the real benchmark cleanup lifecycle, checks setup and transfer errors, bounds connection waits, and verifies every byte. It also benchmarks the relay path. `cmd/cdx/transfer_perf_test.go:283` benchmarks a verified seal/open round trip.

## End-to-end CLI measurements

`scripts/bench-cli-transfer.mjs` uses the unchanged Worker through `scripts/harness.mjs:startWorker`. It alternates old/new and new/old within five pairs, verifies SHA-256, and includes receiver process startup, transfer, flush, Sync, publication, and receiver exit in elapsed time. Sender exit is checked separately. Payloads are 64 and 256 MiB. Relay mode explicitly sets `CD_DIRECT=0`; default mode sets `CD_DIRECT=1` and `CD_STRIPE=1`. Every default old/old and new/new sample reported a direct connection.

The existing `scripts/bench.mjs` at this base does not itself force `CD_DIRECT=0` for its `relay` label. The new comparison script does. Each group has a fresh local persistence directory to avoid the local 30-connections/minute limiter. Two earlier attempts using shared limiter state stopped at HTTP 429 and are excluded.

Ratios are old seconds divided by new seconds, so values above 1 favor the new CLI. These are paired medians, not ratios of the separate sample medians. All five raw samples remain visible, including regressions. The shared CPU, storage, and network were not isolated.

- 64 MiB relay: median paired ratio **1.109x**.
  Old seconds: `[0.6865, 0.5160, 0.4709, 0.6338, 0.5957]`.
  New seconds: `[0.6923, 0.4651, 0.3857, 0.2951, 0.5772]`.
  Paired ratios: `[0.992, 1.109, 1.221, 2.148, 1.032]`.

- 64 MiB default: median paired ratio **1.237x**.
  Old seconds: `[1.3406, 0.9253, 1.3951, 0.7780, 1.0251]`.
  New seconds: `[1.0837, 1.5801, 0.9817, 0.6843, 0.6071]`.
  Paired ratios: `[1.237, 0.586, 1.421, 1.137, 1.689]`.

- 256 MiB relay: median paired ratio **1.236x**.
  Old seconds: `[1.1745, 1.0394, 1.3073, 2.4705, 2.5479]`.
  New seconds: `[0.7429, 0.8411, 2.4244, 2.1588, 1.8309]`.
  Paired ratios: `[1.581, 1.236, 0.539, 1.144, 1.392]`.

- 256 MiB default: median paired ratio **1.657x**.
  Old seconds: `[1.9900, 2.9771, 4.0471, 2.5245, 3.8747]`.
  New seconds: `[1.8622, 2.0619, 1.3974, 1.3049, 2.3391]`.
  Paired ratios: `[1.069, 1.444, 2.896, 1.935, 1.657]`.

Exact samples, rates in MiB/s, routing flags, and compatibility runs: [cli-pairs.jsonl](cli-transfer-2026-10-18/cli-pairs.jsonl). The complete earlier run before increasing the WebSocket write buffer is retained in [before-write-buffer-pairs.jsonl](cli-transfer-2026-10-18/before-write-buffer-pairs.jsonl). That run did not establish a throughput gain.

## Startup latency

`scripts/bench-cli-startup.mjs` forwards TCP bytes unchanged through a loopback proxy. It timestamps the receiver JOIN and arrival of the first encrypted payload byte after the 12-byte CHUNK header. It does not wait for the entire WebSocket frame or a disk write. Each 1 MiB transfer verifies its exact bytes, with default routing enabled on both CLIs. Five pairs alternate execution order.

- Old milliseconds: `[779.171, 335.698, 328.529, 162.494, 461.939]`.
- New milliseconds: `[62.619, 60.655, 49.605, 51.050, 53.930]`.
- Paired ratios: `[12.443, 5.535, 6.623, 3.183, 8.565]`.
- Separate latency medians: 335.7 ms old and 53.9 ms new. Median paired ratio: 6.623x.

An earlier probe timestamped the CHUNK header and measured medians of 94.0 ms old and 50.8 ms new. Its samples are also retained. STUN response and host load varied between runs, so the startup speedup is not a fixed multiple. The unresponsive-STUN regression is stronger evidence of the bound: the test rejects origin/main after 1.001 s and accepts the new offer in about 55 ms with a host candidate.

Raw startup data: [payload probe](cli-transfer-2026-10-18/startup-pairs.jsonl), [earlier header probe](cli-transfer-2026-10-18/startup-header-pairs.jsonl), and [expected baseline test failures](cli-transfer-2026-10-18/base-regressions.txt).

## Go benchmarks

Linux amd64, Go 1.26.9, Intel Core i5-13420H, 12 logical processors. Five interleaved pairs used precompiled test binaries. Each transport sample moves 64 MiB three times through real channels and verifies the bytes. Codec samples use 500 iterations of a 256 KiB chunk. Go reports decimal MB/s here. The baseline received only benchmark repairs and test helpers, preserved in [baseline-benchmark.patch](cli-transfer-2026-10-18/baseline-benchmark.patch).

- `BenchmarkDirectPathThroughput`: old MB/s `[70.97, 55.39, 52.67, 79.41, 72.02]`; new MB/s `[51.39, 65.34, 71.80, 64.43, 60.32]`.
  Paired speed ratios: `[0.724, 1.180, 1.363, 0.811, 0.838]`; median 0.838x.
  Median allocated bytes/op: 1,366,349,050 old, 1,114,609,578 new. Median allocations/op: 4,420,934 old, 4,364,234 new.

- `BenchmarkRelayPathThroughput`: old MB/s `[352.39, 302.03, 194.44, 355.95, 337.98]`; new MB/s `[367.96, 407.05, 467.78, 643.46, 465.43]`.
  Paired speed ratios: `[1.044, 1.348, 2.406, 1.808, 1.377]`; median 1.377x.
  Median allocated bytes/op: 463,005,506 old, 232,684,024 new. Median allocations/op: 13,842 old, 7,957 new.

- `BenchmarkRecordRoundTrip`: old MB/s `[1101.59, 915.15, 681.11, 1253.36, 932.08]`; new MB/s `[1110.91, 1220.73, 1237.44, 1659.19, 913.50]`.
  Paired speed ratios: `[1.008, 1.334, 1.817, 1.324, 0.980]`; median 1.324x.
  Median allocated bytes/op: 532,625 old, 270,350 new. Median allocations/op: 6 old, 1 new.

- `BenchmarkSealChunk`: old MB/s `[2260.10, 2040.79, 1541.22, 2813.28, 2311.35]`; new MB/s `[1609.51, 1776.15, 1808.47, 2546.36, 1884.90]`.
  Paired speed ratios: `[0.712, 0.870, 1.173, 0.905, 0.815]`; median 0.870x.
  Median allocated bytes/op: 270,386 old, 270,362 new. Median allocations/op: 3 old, 1 new.

The direct-only speed and seal-only speed did not improve in these paired samples. Direct allocation fell about 18%, relay allocation fell about 50%, and verified codec round-trip allocation fell from six allocations to one. The end-to-end results support the combined change; they do not prove every individual optimization improves throughput. Full benchmark output: [go-pairs.txt](cli-transfer-2026-10-18/go-pairs.txt).

## SCTP and threshold sweep

The repaired direct benchmark ran three 64 MiB samples for each combination before the implementation changes. The values below are receive MiB / high MiB / low MiB, followed by MB/s. This sequential exploratory sweep is noisier than the interleaved final comparisons.

- 8MiB high=4MiB low=1MiB: `[125.88, 136.71, 126.82]`; median 126.82.
- 8MiB high=8MiB low=2MiB: `[128.17, 130.67, 129.33]`; median 129.33.
- 8MiB high=16MiB low=4MiB: `[116.72, 131.94, 125.13]`; median 125.13.
- 16MiB high=4MiB low=1MiB: `[126.79, 122.71, 132.92]`; median 126.79.
- 16MiB high=8MiB low=2MiB: `[125.85, 133.42, 127.39]`; median 127.39.
- 16MiB high=16MiB low=4MiB: `[131.87, 99.24, 122.53]`; median 122.53.
- 24MiB high=4MiB low=1MiB: `[41.89, 118.33, 121.70]`; median 118.33.
- 24MiB high=8MiB low=2MiB: `[122.81, 46.98, 110.69]`; median 110.69.
- 24MiB high=16MiB low=4MiB: `[126.97, 136.09, 135.59]`; median 135.59.

No larger setting won consistently. Defaults remain 8 MiB receive, 8 MiB high, 2 MiB low, and 64 KiB direct messages. Browser `src/direct-link.js` also splits records into 64 KiB messages. The advertised plaintext chunk stays at 256 KiB, and receivers still accept legacy 64 KiB chunks. Raw sweep: [sctp-sweep.txt](cli-transfer-2026-10-18/sctp-sweep.txt).

## Compatibility and checks

- Built origin/main and new CLIs transferred 64 and 256 MiB in both directions with SHA-256 verification.
- Built v0.3.5 at `e7a7e5c` and the new CLI transferred 64 and 256 MiB in both directions. All four transfers used a direct connection and verified SHA-256. Exact results: [v035-compat.jsonl](cli-transfer-2026-10-18/v035-compat.jsonl). This checks released source built locally, rather than a downloaded release artifact.
- `node scripts/verify-agent.mjs` passed against the final source. Chromium received 1,572,937 exact bytes from the new CLI over a direct path and received a five-file folder bundle.
- A Playwright probe using the repository harness sent 1,572,937 exact bytes from the unchanged browser sender to the new CLI and checked the browser completion state.
- `go test ./...`, `go vet ./...`, and `go test -race ./cmd/cdx` passed. `npm test` passed all 64 tests. `npm run build` and `npx tsc` passed. The reusable Go benchmark script passed a separate one-pair smoke run. Verification output is retained in [verification.txt](cli-transfer-2026-10-18/verification.txt).
- New regression tests check the browser wire fixture, owned in-place decryption, bounded ICE offer startup, negotiated sender trickling and a legacy receiver without it, fragmented record ownership, frame length rejection, ACK arrival time, drain wake-ups below the default low threshold, and one-write relay records. The two targeted regression tests fail against origin/main as expected.

## Limits and remaining work

- The brief assumed receivers already accept sender SIGNAL records. Origin/main Go and browser codecs actually permit SIGNAL only in the receiver-to-sender direction. New CLI receivers negotiate sender trickling. Old CLIs and browser pages receive no sender SIGNAL records. The existing wire version, key derivation, authenticated header, nonce sequence, replay handling, record limits, and completion counters remain intact.
- The browser was left unchanged. It still receives the initial SDP and sends its answer and candidates. For old receivers, candidates discovered after the shorter SDP snapshot are not forwarded. Relay fallback remains available, but remote direct-connect success with these legacy peers needs NAT and WAN testing.
- Chromium was exercised. Firefox and Safari were not run. Their direct message size remains unchanged.
- No real WAN, high-RTT, loss, or mobile receiver benchmark was performed. The larger receive-window settings remain unselected. Direct-path allocation remains high, and the direct-only microbenchmark gain remains unproven.
- Results are local, noisy, and based on five pairs per case. No production throughput guarantee follows from these numbers.

## Reproduction

Commands below run from the implementation checkout. The extra baseline patch changes tests only and deliberately includes two failing performance regressions. Benchmark commands skip tests.

```sh
git worktree add --detach /tmp/cd-cli-base origin/main
git -C /tmp/cd-cli-base apply --unidiff-zero "$PWD/docs/measurements/cli-transfer-2026-10-18/baseline-benchmark.patch"
(cd /tmp/cd-cli-base && go build -trimpath -o /tmp/cdx-base ./cmd/cdx && go test -c -o /tmp/cd-base.test ./cmd/cdx)
go build -trimpath -o /tmp/cdx-new ./cmd/cdx
go test -c -o /tmp/cd-new.test ./cmd/cdx
npm run build
CD_CLI_BASE=/tmp/cdx-base CD_CLI_NEW=/tmp/cdx-new node scripts/bench-cli-transfer.mjs
CD_CLI_BASE=/tmp/cdx-base CD_CLI_NEW=/tmp/cdx-new node scripts/bench-cli-startup.mjs
CD_GO_BASE_TEST=/tmp/cd-base.test CD_GO_NEW_TEST=/tmp/cd-new.test node scripts/bench-cli-go.mjs
```

`CD_BENCH_MODES=` runs only cross-version compatibility transfers. `CD_BENCH_SIZES` selects the MiB payload sizes, and `CD_BENCH_RUNS` controls the end-to-end and Go pair counts. Startup always runs five pairs to stay below the relay connection limit.


## Round 2: bounded relay probes and metadata ZIP sizing

This round starts at `762105b` and keeps all work in `/home/yvm/code/cd-sp-cli` on `perf/cli-transfer`. The main checkout was untouched. The new policy starts on direct, limits relay probes, backs up missing relay ciphertext on direct, and stops probing after a backup. The ZIP offer size now depends on metadata rather than payload bytes. Direct messages are 60 KiB.

The final policy measures the authenticated relay OFFER/ACCEPT round trip and compares it with ICE's direct RTT before probing. An unknown or slower relay gets no striped data. A faster relay gets bounded probes only under direct queue pressure. Pure transport measurements wait for direct to open before timing, because CLI startup sends a variable amount of data over relay. The conservative policy gives up some of old striping's fast-relay throughput. Individual end-to-end samples remain noisy, so this is not a universal performance guarantee.

### Verified findings and changes

- `cmd/cdx/stripe.go:25`, `:80`, and `:117` replace the initial 50% relay allocation and 200 ms epochs with zero initial relay capacity, eight MiB of ACKed data per epoch, a smoothed delivery rate, and a 5% deadband. Zero capacity disables relay assignments. The allowance is at most four encrypted chunks, 1 MiB plus 112 bytes, while direct retains its full 8 MiB high-water mark. Probes require the direct buffer to exceed its 2 MiB low-water mark. A rate dip reduces capacity temporarily; a stable direct baseline permits another bounded probe. Only a real backup or relay failure stops probing permanently.
- `cmd/cdx/link.go:59`, `:285`, and `:365` measure OFFER/ACCEPT only after authenticating the relay ACCEPT. `cmd/cdx/stripe.go:213` compares this with the selected ICE pair's RTT. Relay must be more than twice as fast. An unknown or slower relay uses the same synchronous direct writer as `CD_STRIPE=0`, avoiding queue/goroutine overhead when probing cannot help. Consent time can inflate this conservative estimate, particularly with browser receivers. This does not change the wire format or require new peer support.
- `cmd/cdx/stripe.go:152`, `:173`, and `:181` schedule a backup deadline that includes the direct-buffer delivery time ahead of the probe, plus at least 100 ms or twice both path RTTs. A drain event alone cannot identify a late relay copy because cumulative ACKs first wait for earlier direct records. A deadline wake-up prevents an empty data queue from waiting forever for an ACK held behind a missing relay record. The final guard arms that timer only after direct drains, avoiding repeated expired timers while direct itself is stalled. `cmd/cdx/stripe.go:341` forces a backup before control records, including END. Backups reuse ciphertext and stop new relay assignments, since their ACKs cannot prove that the original copies drained. Relay failure still moves retained records to direct.
- The unused list of direct record release offsets and mutable direct-cap field are removed. The data queue shrinks from 512 to 128 records; the control queue holds 256. A full 24 MiB replay window, bounded candidate set, and control overhead must fit even while the direct writer stalls, so the main loop can still read the error that ends the transfer. A new enqueue regression fails at 128 control slots and passes at 256. Its [expected failure](cli-transfer-2026-10-18/round2/control-queue-expected-failure.txt) and [passing run](cli-transfer-2026-10-18/round2/control-queue-success.txt) are retained. `cmd/cdx/transfer_perf_test.go:307` exercises real direct delivery without ACK wake-ups, then injects an undelivered final relay record and verifies delivery before END. `cmd/cdx/stripe_test.go:13`, `:43`, `:217`, `:249`, and `:270` cover zero capacity, idle ACK samples, deadband, rate backoff/reprobe, and delayed versus forced backups. `cmd/cdx/link_test.go` verifies authenticated relay RTT measurement.
- `cmd/cdx/direct.go:29` sends 60 KiB messages. Go's `recordAssembler` and `src/direct-link.js:createRecordAssembler` both use the authenticated record header's length and accept arbitrary message boundaries. The browser still sends its existing 64 KiB pieces. Pion SCTP defaults to 65,536-byte messages, while WebRTC's fallback for peers omitting a maximum is 65,535; the normal Go SDP advertises a larger maximum. Thus the previous 65,536-byte pieces were not observed to fail with current Go peers, but 60 KiB stays below both fallback boundaries. Paired delayed tests found no piece-size throughput loss.
- `cmd/cdx/bundle.go:234` calculates stored payload lengths, 30-byte local headers, 46-byte central headers, timestamp extras, 16/24-byte descriptors, ZIP64 central extras, and ZIP64 end records. It rejects overlong names and signed-size overflow before offering a stream. Actual archive generation, CRCs, change detection, and extraction stay with `archive/zip`.
- `cmd/cdx/bundle_test.go:160`, `:176`, `:202`, and `:229` check constant-time sizing of a 20 GiB entry, empty files and archives, Unicode byte lengths, 65,534/65,535/65,536 entries, ZIP64 size and subsequent-offset boundaries, and invalid lengths. ZIP64 tests use the actual standard-library `CreateRaw`/`SetOffset` output and account for omitted payload bytes, so they need no multi-GiB allocation or write. Existing tests still compare actual archive bytes with the offered size and extract/CRC-check the contents.
- `cmd/cdx/link.go:88` documents why 32 MiB remains sufficient. Relay records and direct records share the same 24 MiB application window; relay backlog is not added to that window. There can be less than one extra 256 KiB chunk, record headers, bounded signals, and END. Copies are rejected before consuming pending space. `cmd/cdx/link_test.go:385` holds an entire maximum window plus an overshooting chunk out of order and checks room for a maximum-size control record and bounded candidates. The browser's unchanged 32 MiB bound remains compatible.

The first regression command was `go test ./cmd/cdx -run 'TestStriperStartsDirectOnly|TestStriperAdjustNeedsDeliveredBytes|TestBundleMetadataSizeDoesNotReadPayload' -count=1`, before production changes. It failed with initial relay/direct caps `8388608/8388608`, idle samples moving share to `1`, and ZIP sizing still processing payload after 100 ms. All three pass now.

### CLI process striping comparison

`scripts/bench-cli-stripe.mjs` alternates `[direct, old, new]` and `[new, old, direct]` across five triples. `old` is the round-1 binary at `762105b` with `CD_STRIPE=1`; `new` is this round with `CD_STRIPE=1`; `direct` is this round with `CD_STRIPE=0`. All modes enable direct, and every sample asserts that it opened. Each 128 MiB receive checks SHA-256 `f2816846466d4f4004cedefd1b33e55307ccb57a3019267c11033b0899b6f60a`, receiver exit, and sender exit. Elapsed time starts when the receiver is spawned and includes flush, sync, publication, and shutdown.

The `fast` proxy forwards TCP unchanged. The `slow` proxy preserves byte order through a FIFO and adds 50 ms plus 8 MiB/s serialization per TCP leg. Each sender-to-receiver relay traversal crosses two legs, giving about 100 ms propagation one way and about 200 ms round trip. Proxy queueing pauses each source at 2 MiB. Worker persistence is fresh for every triple, avoiding connection-limiter interference.

`scripts/bench-cli-netem.sh` uses `unshare -Urn`, a private veth address, and a loopback qdisc with 20 ms delay and a 200 Mbit/s rate. A UDP filter shapes direct traffic while HTTP/WebSocket traffic remains unshaped by tc. The relay proxy can still add its own limits. No root command or host qdisc change is needed. Local and namespace runs used the same binaries and scripts. Other users' workloads remain uncontrolled.

Ratios below are paired elapsed-time ratios. Values above one favor new. All raw samples, including outliers, are retained.

- Local direct path, fast relay. Median direct/new **1.057x**; median old/new **0.554x**.
  Direct seconds: `[1.3738, 1.6167, 1.6519, 1.9101, 1.6341]`.
  Old seconds: `[0.7859, 0.8476, 0.9300, 0.9508, 0.8697]`.
  New seconds: `[1.4595, 1.5288, 1.1290, 1.1183, 1.5689]`.
  Direct/new pairs: `[0.9413, 1.0575, 1.4632, 1.7080, 1.0416]`. Old/new pairs: `[0.5385, 0.5544, 0.8238, 0.8502, 0.5543]`.

- Local direct path, slow relay. Median direct/new **0.962x**; median old/new **4.322x**.
  Direct seconds: `[2.5408, 2.3323, 2.4720, 2.4766, 2.4535]`.
  Old seconds: `[11.0311, 10.4491, 11.0603, 11.3511, 11.0717]`.
  New seconds: `[2.9511, 2.4240, 2.5593, 2.6042, 2.4423]`.
  Direct/new pairs: `[0.8610, 0.9622, 0.9659, 0.9510, 1.0046]`. Old/new pairs: `[3.7380, 4.3108, 4.3217, 4.3587, 4.5333]`.

- Direct path with netem, fast relay. Median direct/new **0.946x**; median old/new **0.524x**.
  Direct seconds: `[4.2752, 4.2103, 4.6755, 5.7968, 4.7067]`.
  Old seconds: `[1.9992, 2.3335, 1.2523, 2.6809, 2.7386]`.
  New seconds: `[4.5470, 4.4522, 5.0815, 4.8903, 4.8061]`.
  Direct/new pairs: `[0.9402, 0.9457, 0.9201, 1.1854, 0.9793]`. Old/new pairs: `[0.4397, 0.5241, 0.2464, 0.5482, 0.5698]`.

- Direct path with netem, slow relay. Median direct/new **0.992x**; median old/new **0.995x**.
  Direct seconds: `[7.6639, 8.1900, 10.8122, 7.7938, 12.7447]`.
  Old seconds: `[7.3461, 10.0764, 8.1480, 7.2894, 8.9103]`.
  New seconds: `[7.8879, 8.5208, 8.1894, 7.8579, 8.0335]`.
  Direct/new pairs: `[0.9716, 0.9612, 1.3203, 0.9918, 1.5864]`. Old/new pairs: `[0.9313, 1.1826, 0.9949, 0.9276, 1.1091]`.

These process measurements include variable relay traffic before direct opens, so they cannot alone isolate the striping policy. The pre-open comparison below removes that confound. Old striping can remain much faster with a fast relay. This trades some fast-relay throughput for bounded slow-relay damage. All outliers remain in the raw data.

Raw final results: [local triples](cli-transfer-2026-10-18/round2/stripe-local.jsonl) and [netem triples](cli-transfer-2026-10-18/round2/stripe-netem.jsonl). Earlier policies and noisy trials are retained as [first exploration](cli-transfer-2026-10-18/round2/stripe-exploratory.jsonl) and [before stopping after backups](cli-transfer-2026-10-18/round2/stripe-before-stop-after-backup.jsonl). The first test-proxy implementation failed authentication; replacing its independent timers with a byte-order-preserving FIFO eliminated that failure in the completed runs. Those incomplete pre-FIFO runs are excluded, not presented as product results.

### Striping after direct has opened

`cmd/cdx/stripe_bench_test.go:24` adds `BenchmarkStripedWindowThroughput`. It measures the encrypted OFFER/ACCEPT relay round trip, opens both direct channels, and only then starts the timer. It transfers 128 MiB with an 8 MiB application window and a 1 MiB cumulative ACK cadence, hashes every received byte with SHA-256, and waits for the final ACK. `scripts/bench-cli-stripe-open.mjs` interleaves five triples using identical benchmark source copied onto round 1. The local slow-relay case adds 100 ms one way and an 8 MiB/s cap to the WebSocket forwarding queue. The namespace fast-relay case uses 20 ms/200 Mbit/s UDP netem and unthrottled WebSockets.

This removes the variable pre-direct relay traffic present in CLI process measurements. The source itself also shows that a rejected relay uses the same synchronous data writer as `CD_STRIPE=0`. The fast-relay samples confirm about 14 MiB of payload crossing relay instead of being backed up onto direct.

- local-slow. Median direct/new **0.968x**; median old/new **8.144x**.
  Direct seconds: `[1.3483, 1.2806, 1.4105, 1.3709, 1.2472]`.
  Old seconds: `[11.3544, 10.5112, 11.3547, 11.0726, 11.0104]`.
  New seconds: `[1.3943, 1.4005, 1.3581, 1.3596, 1.2879]`.
  Direct/new pairs: `[0.9670, 0.9144, 1.0386, 1.0083, 0.9684]`. Old/new pairs: `[8.1433, 7.5056, 8.3608, 8.1441, 8.5493]`.

- netem-fast. Median direct/new **1.129x**; median old/new **0.407x**.
  Direct seconds: `[6.5487, 6.5867, 6.5098, 7.1919, 6.9118]`.
  Old seconds: `[1.9066, 1.7864, 2.3752, 2.5873, 2.6238]`.
  New seconds: `[5.9243, 5.8352, 5.8365, 5.8501, 5.8372]`.
  Direct/new pairs: `[1.1054, 1.1288, 1.1154, 1.2294, 1.1841]`. Old/new pairs: `[0.3218, 0.3061, 0.4070, 0.4423, 0.4495]`.

The direct-bottleneck median gain is 12.9%. The slow-relay median is within 3.2% of direct-only throughput on this shared machine, while old striping takes about eight times as long. Individual samples still vary, including when new and direct-only take the same synchronous path. The source equality supports the slow-relay fallback more strongly than any single timing sample.

The fast-relay pre-open pairs were refreshed after the final drain/timer guard. The CLI process pairs precede that guard, so they characterize the policy before this stall-only correction; the slow-relay synchronous path is unchanged. The final control-queue correction increases constructor capacity without changing the measured application window or path selection.

Raw results, benchmark output, probe state, and relay-byte counts: [pre-open triples](cli-transfer-2026-10-18/round2/stripe-open.jsonl). Earlier [early-backup trials](cli-transfer-2026-10-18/round2/stripe-open-early-backup.jsonl) and [before synchronous fallback](cli-transfer-2026-10-18/round2/stripe-before-synchronous-fallback.jsonl) are retained. They exposed two issues: a startup rate dip permanently disabled a useful relay, and drain events alone could falsely classify a probe before preceding direct records were ACKed. The final policy uses temporary rate backoff, conservative RTT admission, and a deadline that accounts for preceding direct data.

### ZIP preparation latency

`scripts/bench-cli-bundle.mjs` prepares a folder containing one sparse 20 GiB file and measures process start to the first share-link line, without transferring the payload. Five pairs alternate order against the same local Worker. The real source is sparse; the old size calculation still generated and CRC-processed every zero-filled byte. Actual time on this CPU was below one second, rather than the review's estimated ten seconds.

- Old seconds: `[0.7875, 0.7804, 0.7562, 0.7624, 0.7562]`.
- New seconds: `[0.0362, 0.0316, 0.0312, 0.0296, 0.0289]`.
- Paired ratios: `[21.7561, 24.7154, 24.2603, 25.7545, 26.1913]`; median **24.715x**.

Raw samples: [bundle pairs](cli-transfer-2026-10-18/round2/bundle-pairs.jsonl). Metadata sizing is O(number of entries); filesystem traversal still needs each entry's metadata. A very large number of files can still delay the code.

### Delayed SCTP sweep and selected defaults

The installed Pion source confirms an initial cwnd of 4,380 bytes, `SetSCTPMinCwnd`, `SetSCTPFastRtxWnd`, and `SetSCTPCwndCAStep`. `setCWND` also clamps loss recovery to the configured minimum. `scripts/bench-cli-sctp.mjs` copies the package into isolated build directories and tests 8/16/24 MiB receive/high-water buffers with 2/4/6 MiB low-water buffers, and cwnd floors of zero, 256 KiB, and 1 MiB. Every exploratory configuration runs three verified 64 MiB direct benchmarks through the same 20 ms/200 Mbit/s namespace. No source file in the working package is rewritten by this script.

The following samples are decimal MB/s, as reported by Go. This sweep is sequential and exploratory.

- Receive/high/low 8/8/2 MiB, minimum cwnd 0 bytes: `[18.2800, 17.2600, 18.2700]`.

- Receive/high/low 8/8/2 MiB, minimum cwnd 262144 bytes: `[11.1900, 18.5200, 7.2700]`.

- Receive/high/low 8/8/2 MiB, minimum cwnd 1048576 bytes: `[19.3100, 19.1200, 19.4400]`.

- Receive/high/low 16/16/4 MiB, minimum cwnd 0 bytes: `[18.6500, 18.5400, 18.0100]`.

- Receive/high/low 16/16/4 MiB, minimum cwnd 262144 bytes: `[19.2400, 19.2500, 19.3500]`.

- Receive/high/low 16/16/4 MiB, minimum cwnd 1048576 bytes: `[19.7300, 20.8100, 20.0100]`.

- Receive/high/low 24/24/6 MiB, minimum cwnd 0 bytes: `[19.1900, 18.6800, 18.7300]`.

- Receive/high/low 24/24/6 MiB, minimum cwnd 262144 bytes: `[20.5300, 20.6200, 20.8100]`.

- Receive/high/low 24/24/6 MiB, minimum cwnd 1048576 bytes: `[20.6000, 20.5100, 20.3800]`.

Five interleaved triples then compare old 64 KiB messages, new 60 KiB messages, and 60 KiB messages with a 1 MiB minimum cwnd. All keep 8/8/2 MiB buffers.

- old MB/s: `[18.3200, 18.2400, 18.0900, 18.3400, 18.3400]`.

- piece60 MB/s: `[18.3400, 17.9800, 18.3300, 18.2700, 18.3900]`.

- cwnd1m MB/s: `[19.7400, 19.6900, 19.8400, 19.8300, 20.1800]`.

- piece60/old speed ratios: `[1.0011, 0.9857, 1.0133, 0.9962, 1.0027]`; median **1.001x**.

- cwnd1m/piece60 speed ratios: `[1.0763, 1.0951, 1.0824, 1.0854, 1.0973]`; median **1.085x**.

Selected defaults remain 8 MiB receive, 8 MiB high, 2 MiB low, and the normal cwnd/loss-recovery behavior. Only message pieces change to 60 KiB. The 1 MiB cwnd floor did help the tested loss-free path by about 8.5%, but also forces that window after loss. No lossy or congested WAN validation justifies shipping that floor. Larger buffers did not establish a paired gain worth their extra memory. Fast-retransmit and congestion-avoidance settings remain unset.

Raw results: [SCTP sweep](cli-transfer-2026-10-18/round2/sctp-sweep.jsonl) and [paired piece/cwnd results](cli-transfer-2026-10-18/round2/sctp-pairs.jsonl). The reusable Node sweep driver also passed a one-configuration reproduction smoke run. Direct benchmarks compare every received byte against a deterministic payload. The end-to-end triples independently verify SHA-256.

### Compatibility and verification

- `go test ./...`, `go vet ./...`, `go test -race ./cmd/cdx`, `npm test`, `npm run build`, and `npx tsc` pass. npm reports 64 tests. Logs are under [round2](cli-transfer-2026-10-18/round2/), including [Go tests](cli-transfer-2026-10-18/round2/go-test.txt), [race tests](cli-transfer-2026-10-18/round2/go-race.txt), and [npm tests](cli-transfer-2026-10-18/round2/npm-test.txt). Vet and tsc produced no diagnostics.
- Released v0.3.5 source at `e7a7e5c` was built locally and passed both directions at 64 and 256 MiB, with SHA-256 and a direct connection in all four runs. [Raw compatibility results](cli-transfer-2026-10-18/round2/v035-compat.jsonl).
- The round-1 binary at `762105b` also passes both directions at 64 and 256 MiB. [Raw round-1 compatibility results](cli-transfer-2026-10-18/round2/round1-compat.jsonl).
- `node scripts/verify-agent.mjs` checks Chromium receiving 1,572,937 exact bytes from CLI over direct and a five-file folder bundle. The browser source stays at origin/main, so it also represents an already-loaded receiver without sender-trickle support. `node scripts/verify-browser.mjs` checks browser-to-CLI file contents and completion, plus the existing browser receive flows. [Forward browser log](cli-transfer-2026-10-18/round2/browser.txt), [reverse browser log](cli-transfer-2026-10-18/round2/browser-reverse.txt).
- Protocol version, encryption, nonce allocation, 64/256 KiB plaintext chunk compatibility, authentication, record limits, replay handling, and browser code remain unchanged in this round. No new runtime dependency was added. No push, PR, or deployment was performed.

### Remaining risks and unfinished validation

The strict universal "never meaningfully worse than direct-only" target remains unproven on a shared host. The final process median with netem direct and fast relay is 5.4% lower throughput than direct-only, while the comparison that waits for direct to open shows a 12.9% gain. Thus the end-to-end no-regression target is not established by this run; it must not be claimed as achieved. Process timing includes variable relay traffic before direct connects; the pre-open benchmark measures the policy separately. Old striping can be much faster with a fast relay. The new policy prioritizes bounded slow-relay damage. Human consent, an unknown RTT, or a higher RTT despite greater bandwidth can suppress a useful relay. Control records can end probing conservatively. Cumulative ACKs still cannot identify which path delivered a backed-up record.

There is no real WAN, NAT, Firefox, Safari, mobile, packet-loss, or congestion validation in round 2. A forced congestion-window floor and larger receive buffers are deliberately left unselected. New browser changes developed in other worktrees need integration verification with this CLI. ZIP size constants mirror the current Go standard library; the boundary tests should catch format changes when the toolchain changes.

### Reproduction for round 2

Run from this worktree. Build round 1 and released source into directories below `.perf-round2` using `git archive`, not by modifying the user's checkout. Build current CLI and test binaries after the copies are prepared. The scripts accept absolute binary paths.

```sh
mkdir -p .perf-round2/round1 .perf-round2/v035
git archive 762105b cmd/cdx go.mod go.sum | tar -x -C .perf-round2/round1
git archive e7a7e5c cmd/cdx go.mod go.sum | tar -x -C .perf-round2/v035
cp cmd/cdx/stripe_bench_test.go .perf-round2/round1/cmd/cdx/stripe_bench_test.go
go -C .perf-round2/round1 build -trimpath -o ../cdx-old ./cmd/cdx
go -C .perf-round2/round1 test -c -o ../old.test ./cmd/cdx
go -C .perf-round2/v035 build -trimpath -o ../cdx-v035 ./cmd/cdx
go build -trimpath -o .perf-round2/cdx-new ./cmd/cdx
go test -c -o .perf-round2/piece60.test ./cmd/cdx
CD_GO_BASE_TEST="$PWD/.perf-round2/old.test" CD_GO_NEW_TEST="$PWD/.perf-round2/piece60.test" node scripts/bench-cli-stripe-open.mjs
CD_CLI_BASE="$PWD/.perf-round2/cdx-old" CD_CLI_NEW="$PWD/.perf-round2/cdx-new" CD_BENCH_MIB=128 node scripts/bench-cli-stripe.mjs
CD_CLI_BASE="$PWD/.perf-round2/cdx-old" CD_CLI_NEW="$PWD/.perf-round2/cdx-new" CD_BENCH_MIB=128 bash scripts/bench-cli-netem.sh node scripts/bench-cli-stripe.mjs
CD_CLI_BASE="$PWD/.perf-round2/cdx-old" CD_CLI_NEW="$PWD/.perf-round2/cdx-new" node scripts/bench-cli-bundle.mjs
node scripts/bench-cli-sctp.mjs
CD_GO_BASE_TEST="$PWD/.perf-round2/old.test" CD_GO_NEW_TEST="$PWD/.perf-round2/piece60.test" CD_GO_CWND_TEST="$PWD/.perf-round2/r8-c1048576/bench.test" node scripts/bench-cli-sctp-pairs.mjs
CD_CLI_BASE="$PWD/.perf-round2/cdx-v035" CD_CLI_NEW="$PWD/.perf-round2/cdx-new" CD_BENCH_MODES= node scripts/bench-cli-transfer.mjs
```

The measured round-1 CLI had SHA-256 `abd157efd0a01d7221dbfd6a77416086cccdb067209ded217f6b0673317d3b21`. The CLI process-run hashes are retained in `round2/binaries.txt`; the final build after the drain/timer and control-queue guards is recorded in `round2/final-binary.txt`. The released-source compatibility binary had SHA-256 `33090b0ca44ddc1c1bb17a72597f5592780f0a548494d8a1558f40bc1e89987b`.
