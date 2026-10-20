# Controlled CD / croc relay benchmark

This is a local diagnostic, not a WAN, browser, Android, or production speed claim.
`node scripts/bench-croc.mjs` compares separately supplied CD CLI builds with the
official croc 11.5.4 binary. It does not install tools or contact a hosted CD relay.

## Reproduction

Build baseline and candidate with the same Go compiler and flags, then set:

- `CD_BENCH_CLI`: absolute baseline CD executable path.
- `CD_BENCH_CANDIDATE`: optional candidate executable path.
- `CROC_BENCH_BIN`: verified official croc 11.5.4 executable path.
- `CD_BENCH_WORKDIR`: existing directory on the filesystem to measure. The default
  temporary directory may be RAM-backed; inspect its mount before interpreting fsync.
- `CD_BENCH_MIB=64,256`, `CD_BENCH_RUNS=5` (defaults).

Run with a quiet host and the same CPU affinity for the whole process tree, e.g.
`GOMAXPROCS=2 taskset -c 0,1 node scripts/bench-croc.mjs`. Croc sets GOMAXPROCS itself,
so GOMAXPROCS alone does not establish equivalent CPU access. Affinity does not
isolate those CPUs from unrelated processes. Capture stdout JSON and stderr logs.

Wrangler runs explicitly with `--local`, remote bindings disabled, metrics off,
and proxy environment variables removed. `CD_VERIFY_URL` is rejected. Croc uses
explicit loopback relays, no LAN discovery, no compression, forced relay transport,
empty connect/SOCKS options, and isolated configuration with a fresh update cache.
The unchanged CD connection limiter is respected through pacing outside timing.

## What is measured

- The same synthetic random bytes and file size for every tool/build at each size.
- One excluded warmup per configuration/size, then interleaved repeated runs.
- Sender launch through both successful process exits, including source hashing,
  connection setup, encryption, transfer, verification, and normal completion.
- External SHA-256 verification after timing; every destination must match exactly.
- Fresh output and client-state directories, warm source page cache.
- Separate croc configurations with four and one data connections. CD uses one
  relayed WebSocket per endpoint, with no CLI receiver WebRTC path in this scenario.

The receiver-launch timing is supplementary only: CD exposes its invitation after
prehashing, while croc can hash concurrently with connection setup. It is not a
fair replacement for total elapsed time.

## Important differences

CD v2 uses authenticated SHA-256 identity and durable resumable checkpoints.
Croc uses xxhash for this comparison, PAKE-derived authenticated encryption, and
normal file writes without CD's per-batch fsync/checkpoint contract. Neither
compression nor encryption is disabled. Thus these are real default workloads,
not identical durability or cryptographic protocols. A downloaded croc release
may also use a different Go compiler than the local CD build.

A proposed CD receiver batch changes durable progress from each 256 KiB chunk to
1 MiB when the sender's advertised window supports it. ACK still follows stage
Sync and signed checkpoint atomic persistence. It adds no payload buffer, retains
the 4 MiB sender window, handles final partial batches, and can discard/resend up
to one uncommitted 1 MiB batch after interruption. No acknowledged prefix is lost.
This reduces checkpoint cycles structurally; it is not proof of a speed gain.

Official croc references: [release](https://github.com/schollz/croc/releases/tag/v11.5.4),
[CLI](https://github.com/schollz/croc/blob/v11.5.4/src/cli/cli.go),
[update cache](https://github.com/schollz/croc/blob/v11.5.4/src/cli/updatecheck.go),
[transfer implementation](https://github.com/schollz/croc/blob/v11.5.4/src/croc/croc.go).

## Initial cloud result (2026-10-20)

Baseline: `7e0a812`; candidate: `07623c8`, receiver 1 MiB durable ACK batching only.
AMD EPYC 9V74, two-CPU process-tree affinity, Go 1.26.9 for both CD builds;
official croc 11.5.4 release built with Go 1.27.1. Workspace mount is container
overlay; underlying physical storage and power-loss behavior are not established.
Five interleaved measured runs per size/configuration, plus one excluded warmup.
All 48 transfers completed and matched the source SHA-256.

| Size | Configuration | Median total ms | Range ms | MiB/s |
| --- | --- | ---: | ---: | ---: |
| 64 MiB | cd-v2 | 879.2 | 835.9–925.5 | 72.8 |
| 64 MiB | cd-v2-candidate | 638.8 | 602.2–652.3 | 100.2 |
| 64 MiB | croc-4 | 149.2 | 130.4–155.3 | 429.0 |
| 64 MiB | croc-1 | 160.6 | 138.0–188.1 | 398.6 |
| 256 MiB | cd-v2 | 3398.2 | 3141.5–3432.5 | 75.3 |
| 256 MiB | cd-v2-candidate | 2435.0 | 2359.6–2625.5 | 105.1 |
| 256 MiB | croc-4 | 401.6 | 381.8–463.6 | 637.5 |
| 256 MiB | croc-1 | 437.8 | 399.8–506.4 | 584.7 |

Batching lowered median total elapsed time by 27.3% (64 MiB) and 28.3%
(256 MiB) in this environment. It did **not** beat croc. This is not a WAN or
physical-device result, and the differing durability contracts matter.

A preceding exploratory `/tmp` run used tmpfs, where 64 MiB batching was neutral
to slightly slower: baseline median 561.7 ms, candidate 573.9 ms (five runs each).
Its 256 MiB series aborted at the connection allowance boundary, consistent
with rate limiting (the original error payload was not retained); it is
not a complete baseline. The paced overlay run above retains the original limiter.
Raw exploratory samples are in `croc-tmpfs-exploratory-2026-10-20.json`.
These negative results show why checkpoint-count reduction alone is insufficient
evidence of a speedup.

Overlay payload SHA-256 values:
- 64 MiB: `b0881cbbb00c86209250abe7fcdf1bb728bd7db9d1ca328003d9fd32c2f6861e`
- 256 MiB: `7a221a8e1b90d5a5999ecb1a46a1a95f5f2cb49e5408bc890d7509f4a9fbdf6a`

Raw measured samples are retained alongside this document.

## Deferred sender-buffer experiment

A second isolated experiment compared ACK-only `07623c8` against a local sender
WebSocket write-buffer increase from 4 KiB to one encrypted record (262,172 bytes).
Tests proved 65 to 1 connection writes per full chunk with unchanged encrypted
bytes, but throughput did not show a consistent win. It adds approximately
252 KiB per sender connection, so the production change was **not retained**.

Five interleaved runs, same overlay setup, all 48 transfers SHA-256 verified:

| Size | ACK-only median ms (range) | Larger-buffer median ms (range) |
| --- | ---: | ---: |
| 64 MiB | 649.9 (637.6–705.5) | 676.3 (634.1–728.2) |
| 256 MiB | 2410.7 (2215.6–2483.6) | 2291.5 (2213.4–2353.6) |

The 4.1% regression at 64 MiB and 4.9% improvement at 256 MiB have overlapping
ranges. Reduced syscall count alone is not sufficient reason to ship this change.
Raw samples are in `croc-buffer-experiment-2026-10-20.json`.
