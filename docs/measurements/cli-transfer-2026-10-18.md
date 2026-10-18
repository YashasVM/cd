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
