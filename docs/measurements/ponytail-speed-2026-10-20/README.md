# Speed goal, ponytail iteration 1

The goal is at least 1.5× faster than the faster croc mode on every required speed metric and scenario, preferably 2×, with smaller runtime code. The goal remains active. Android is excluded. The full matrix and every miss remain at https://a.yash0.in/cd-bench/.

The reference thread was stopped at the user's request. Its native goal is paused and its thread archived. This iteration preserves its uncommitted changes and uses Prof PR #63. Baseline binaries and the initial dirty patch are retained locally under `/tmp/cdx-ponytail-baseline` and `/tmp/cd-ponytail-preexisting.patch`.

## Retained change

Reuse one ciphertext buffer only after synchronous TCP writes. Keep separate ownership for relay records awaiting a possible direct handoff. WebRTC and relay writes retain their existing allocation policy. The sealer accepts explicit destination storage; the old wrapper was removed and its tests migrated. Sender setup has one readiness callback and one LAN condition. MIME parsing uses the standard string split helper.

The three affected runtime files are six lines and 88 bytes smaller than the preexisting dirty checkout. Tests and measurement artifacts add code and are excluded from this runtime count. `code-size.json` records per-file counts and hashes; `candidate.patch` contains the runtime delta.

Seven alternating trials per binary, reversing order each round, verified every 256 MiB random output. A shared local workerd runtime and byte-preserving frontend proxy serve both binaries. Output is RAM with file and directory fsync; input is warm. Croc 11.5.5 default and disabled-compression modes are measured in every cohort. No competing benchmark process was observed. Other desktop activity was not eliminated.

TCP receiver-plus-flush medians were 232.5 ms before and 197.3 ms after, an observed 1.18× improvement. The faster croc mode in the after cohort took 1003.7 ms, so this completion case is 5.09× faster than croc. Readiness is 17.8 ms versus croc's 10.0 ms and still fails. These are scenario-specific results with trial spread, not a universal speedup. The existing full acceptance matrix measures snapshot 806bb37; this iteration does not replace it.

## Rejected relay experiment

Reusing buffers after relay writes reduced sender allocation in an instrumented 256 MiB profile from a historical 261 MiB to about 3 MiB. It did not establish a reliable end-to-end gain. An initial comparison overlapped another benchmark; its results are provisional. A fresh-runtime comparison improved medians but had broad spread. The steady shared-runtime comparison regressed from 592.1 to 651.6 ms, so relay reuse was removed. Raw files, the rejected patch and heap evidence remain available. Allocation reduction alone is not a speed win.

## Validation and reproduction

Go tests and targeted race tests pass. All ten real 64 MiB transport cases pass, including legacy framing, browser/CLI directions, relay fallback, slow receivers and relay-to-WebRTC upgrade. Every received payload matches SHA-256. Local report verification checks all existing chart combinations plus the four iteration timing rows and three viewport widths.

Build frozen before/after binaries from their corresponding snapshots, then run from the repository root:

```sh
CD_PAIR_ROUTE=auto CD_BENCH_RUNTIME_BUNDLE=/path/to/frozen-worker/index.js node docs/measurements/ponytail-speed-2026-10-20/paired-cli.mjs /path/to/before-cdx /path/to/after-cdx /tmp/tcp-paired.json
node docs/measurements/ponytail-speed-2026-10-20/build-iteration.mjs
node docs/measurements/cd-bench-current-2026-10-20/build-report.mjs
node scripts/verify-bench-report.mjs
```

The paired runner expects the verified croc binary at `/tmp/croc-bench-latest/croc`. Binary and Worker bundle hashes are recorded. It asserts successful transfer counts and unchanged binaries, and samples other benchmark processes every 500 ms. The report builder independently recomputes medians from verified rows.

Remaining bottlenecks include CLI admission/readiness, browser transport and storage, and relay completion. The 100 Mb/s LAN cannot meet the original random-data multiplier with the measured croc baseline: ideal line rate is 10.74 seconds, while 1.5× requires 8.71 seconds. The target has not been weakened or marked achieved. Production CD has not been deployed; only the benchmark report is published.
