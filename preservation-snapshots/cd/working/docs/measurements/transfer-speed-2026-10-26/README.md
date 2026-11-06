# Transfer performance, 26 October 2026

This pass retains measured improvements to browser resumable transfers and CLI record processing. It preserves the substantial uncommitted changes that existed when the pass started. The results describe this working tree, not a released deployment.

## Retained changes

| Change | Before | After | What the measurement establishes |
| --- | --- | --- | --- |
| Browser incremental SHA-256 | 48.83 MiB/s | 76.43 MiB/s | 1.57× hashing throughput in Chromium 155, seven alternating pairs |
| Actual CLI-to-browser resumable receiver completion | 5255.9 ms | 2672.9 ms | 1.97× faster for 32 MiB with native OPFS and strict checkpoints, seven alternating pairs |
| Actual browser-to-CLI resumable receiver completion | 541.0 ms | 359.7 ms | 1.50× faster on local relay with real durable CLI writes, seven alternating pairs |
| Browser resume sender with 30 ms simulated ACK latency | 1246.4 ms | 426.4 ms | 2.92× faster in an encrypted 8 MiB latency model, seven alternating pairs |
| CLI queued authenticated record | 361.4 ns | 130.1 ns | 64% less processing time; allocations fall from 296 to 48 bytes per operation |

The hashing change reuses the SHA-256 schedule and processes complete input blocks directly. It copies the remaining partial block so callers can reuse their input buffers. Regression tests cover offset views, partial blocks, cloned state and repeated digest calls against Node SHA-256.

The actual browser comparison used an 8 MiB plus 77 byte random file and verified all 14 output hashes. File selection through durable completion improved from 832.7 to 653.7 ms, or 1.27×. Share readiness stayed around 291 ms. The candidate's receiver completion ranged from 348.5 to 591.8 ms, so the median gain is not a guarantee for every run. The preserved baseline was served as source modules, while the candidate used the built bundle; both use the current hashing and crypto sources. See the raw samples and methodology in [the resume notes](../resume-pipeline-2026-10-26/README.md).

The resumable sender permits four outstanding 256 KiB records. It retains counts and a digest for each outstanding prefix. Each authenticated ACK advances the sender checkpoint to that exact prefix, while the receiver still closes its staging write and durably persists its checkpoint before acknowledging. Wire formats and receiver durability are unchanged. Tests cover withheld and invalid ACKs, interrupted sessions, cancellation, source failures, resumed offsets, empty files and partial final chunks.

The CLI reader avoids creating a timeout timer when it can immediately deliver a queued record. It checks ready records before queued connection errors and consumes at most one queued item before entering the existing timed wait. This is a reduction in per-record overhead, not a demonstrated whole-file speedup.

The browser receiver now uses a dedicated module worker with one synchronous OPFS handle. Each chunk still completes its entire write and `flush()` before the main thread persists its authenticated checkpoint and sends an ACK. This avoids reopening a writable stream that preserves the growing file on every chunk. Unsupported worker or handle initialization uses the existing writable-stream path. A failed write or flush aborts the session without silently switching storage paths. Interruption closes the handle while preserving committed progress; cancellation waits for pending operations, closes the handle and removes saved data.

The storage-only comparison used a persistent Chromium profile on the home btrfs filesystem. Seven alternating pairs measured 32 MiB writes at 2377.6 ms with repeated writable-stream opens versus 279.7 ms with the flushed worker handle, an 8.50× difference. At 8 MiB, medians were 188.6 and 78.0 ms. These include worker startup and message cloning but exclude encryption, hashing, checkpoints and network. They do not prove physical power-loss durability. Native crash verification separately confirmed that a worker crash after writing and flushing, before replying, leaves the checkpoint unchanged and permits same-page recovery from the prior durable prefix.

The subsequent end-to-end receiver comparison used 32 MiB plus 77 byte files, actual CLI sends, the local v2 relay, native browser OPFS, strict IndexedDB checkpoints and whole-file verification. Seven alternating pairs measured receiver completion at 5255.9 ms before versus 2672.9 ms after, or 1.97× faster. Before samples ranged from 5150.0 to 5644.7 ms; after samples ranged from 2638.4 to 2754.1 ms. Every measured download passed SHA-256 and every candidate used exactly 129 worker write operations. Both variants share the inbox compatibility fix and current crypto/hash sources. Download copying and its independent SHA-256 check occur outside timing. Raw samples, source hashes and filesystem details are in `opfs-receiver-paired.json`.

Cross-client restart verification exposed a pre-existing inbox mismatch. The CLI permits 4 MiB of outstanding resumable payload, while the browser previously capped its pending ciphertext at 2 MiB. The browser now permits a fixed 4 MiB plus 64 KiB and 32 records. Tests reproduce rejection of a valid CLI window under the old cap, verify that window under the new cap, and still reject byte and record overflow. Same-page browser receiver recovery then passed with exact retained-byte and final hash checks, including a check that the worker handled every remaining chunk.

Live verification also reproduced a cancelled browser download. The resumable receiver deleted the OPFS file backing its download URL before the browser had finished reading it. It now uses the existing shared download cleanup helper and retains that file until URL revocation. The existing 60-second cleanup policy remains, with cleanup also occurring on page hide.

## Verification

The new `npm run verify:browser-resume` check drives the built UI, actual Chromium storage, the local Worker and the CLI. It verifies SHA-256 for an 8 MiB plus 77 byte file in browser-to-CLI and browser-to-browser transfers. It also tests the writable-stream fallback with workers unavailable, kills and restarts a CLI receiver, and interrupts a browser receiver before retrying in the same page. The final run recovered 262,144 bytes in the sender-restart scenario and 524,288 bytes in the browser receiver scenario. Worker message counts prove that the supported-browser cases use the new storage path instead of silently falling back.

Final validation passed all 132 JavaScript tests, the complete Go suite, targeted Go race checks, TypeScript checking, the production build and all five live browser resume scenarios. Captured output is adjacent to this report. Independent read-only review found no blocking correctness issue in the retained changes.

An exploratory 16 MiB ordinary-transport check passed browser-to-browser and browser-to-CLI direct transfers. Its numeric-code CLI-to-browser transfer passed the file hash check but finished through relay while the direct channel was still connecting, failing the verifier's requirement that at least 1 MiB use the direct route. That run is not counted as a complete transport-suite pass.

The subsequent 64 MiB run passed all ten ordinary transport scenarios with exact output hashes and route-buffer checks. These cover browser-to-browser, browser-to-CLI, CLI-to-browser, numeric codes, forced relay, delayed direct upgrade and a slow browser receiver. Results are in `transports-live.json` and `transports-live.log`.

The latency model uses real v2 cryptography and sender checkpoint signing, with a substituted network that delays ACK delivery. It excludes receiver storage and does not establish phone, internet or browser transfer throughput. Browser hash measurements exclude network and disk. CLI measurements exclude network and disk.

## Rejected experiments

The WebRTC event-driven drain candidate did not reproduce its initial gain. The first seven-pair batch improved median throughput from 65.15 to 69.66 MiB/s. A second batch regressed from 30.70 to 26.34 MiB/s. The production and test changes were reverted. Both result sets, the baseline and the experiment runner remain for inspection. The half-buffer wake threshold also regressed and was rejected.

Increasing bundle source reads from 256 KiB to 4 MiB also failed repeatability. The first seven-pair 64 MiB cohort suggested a 14.7% gain; the second measured 1130.6 ms before versus 1138.9 ms after. All 28 transfers verified both extracted file hashes. The production and test changes were reverted. [Both cohorts and frozen variants](../bundle-source-2026-10-26/README.md) remain reproducible.

Earlier workspace measurements had already rejected larger WebSocket buffers and relay ciphertext reuse. They were not reintroduced. The existing opt-in streaming Worker remains opt-in because its local timing evidence does not resolve production lifecycle and duration billing behavior.

## Requested Rust compiler comparison

Theo's [tsc-rs](https://github.com/pingdotgg/ts-rust) and Oxc's [tsrs](https://github.com/oxc-project/tsrs) were installed outside the repository. Nine rotating serial checks measured TypeScript 7.0.2 at 80.86 ms, tsc-rs 0.8.0 at 35.71 ms and tsrs 0.18 at 65.08 ms. All passed this project and rejected an intentional error fixture with TS2322 and TS2741. That narrow check is not a general compatibility guarantee.

The project uses `noEmit: true`; its checker emits no runtime code. The fastest replacement saves about 45 ms per developer check and cannot improve file-transfer throughput. Dependencies and the checker were left unchanged. Raw samples and the runner are adjacent to this report.

## Reproduce

Run performance jobs serially. Run from the repository root:

```sh
CD_SHA256_BASELINE=docs/measurements/transfer-speed-2026-10-26/incremental-sha256-before.mjs node scripts/bench-incremental-sha256.mjs
node docs/measurements/resume-pipeline-2026-10-26/bench.mjs /tmp/resume-paired.json
npm run build
node scripts/bench-browser-resume-paired.mjs /tmp/browser-cli-resume-paired.json
node scripts/bench-browser-resume-receiver.mjs /tmp/cli-browser-resume-paired.json
node scripts/verify-resume-opfs-worker.mjs
go test ./cmd/cdx -run '^$' -bench '^BenchmarkLinkNextQueued$' -benchmem -count=3
npm test
go test ./...
npm run typecheck
npm run verify:browser-resume
```

See [the resume benchmark notes](../resume-pipeline-2026-10-26/README.md) for the preserved baseline, exact source hashes and raw latency samples. See [the CLI notes](cli-queued-read.md) for baseline reconstruction and captured benchmark output.

No production deployment, physical phone, carrier network or internet throughput measurement was performed. These results do not establish a universal transfer-speed multiplier.
