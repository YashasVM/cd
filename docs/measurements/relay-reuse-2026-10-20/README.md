# Synchronous relay ciphertext reuse

Baseline is merged PR #63, `405551b3`. The candidate changes only the v1 link's
existing ciphertext scratch-buffer ownership: after a successful synchronous
WebSocket write, an unretained record may become the next sealing destination.
Pending-direct replay and asynchronous striped records remain independently
owned. Failed writes do not cache/retry or roll back nonce sequence. The cached
allocation is capped at the existing 1 MiB record ceiling; a usual 768 KiB record
retains 794,624 bytes per eligible link. Receiver ownership is unchanged.

## Verified behavior

Six new regression tests cover reusable storage, payload integrity, capacity,
retained replay, stripe/fallback ownership, concurrent sends, and error/cancel
handling. The implementer's focused suite and independent review passed race
checks. The independent run passed 21 top-level tests. Full local networking tests
are **not** green: Pion relay-loss integration cannot initialize netlink in this
cloud sandbox. Hosted CI supplies separate integration evidence.

A warmed 768 KiB record microbenchmark fell from 794,720 to 96 allocated bytes per
send. This is not a throughput measurement. An identical authenticated 256 MiB
local relay profile, with streamed SHA-256 verification, reduced sender sampled
allocation from 262.65 to 5.21 MiB. Receiver allocation was essentially unchanged
(258.68 to 258.74 MiB in `readRelay`). These are total allocated bytes, not peak RSS.
Encryption, authentication, sequence checks and completion durability are unchanged.

## Controlled before/after result

Intel Xeon Platinum 8573C cloud host, two-CPU process-tree affinity, GOMAXPROCS=2,
Go 1.26.10 for both CD builds, Node 24.19.0, container-overlay source/output,
local direct workerd runtime with WebSocket compression disabled. Physical disk
backing and power-loss guarantees are unknown. Do not compare absolute speeds to
older results from a different cloud CPU.

One excluded warmup per size/build, then seven interleaved repetitions. Each size
uses identical generated random bytes for both binaries. Fresh receiver/state
folders, warm source cache, and independent output SHA-256 outside timing. Total
completion includes both process closes plus receiver file/directory fsync.

| Size | Baseline total median ms (range) | Candidate total median ms (range) | Less elapsed |
| --- | ---: | ---: | ---: |
| 64 MiB | 259.0 (223.1–287.9) | 215.2 (202.6–239.3) | 16.9% |
| 256 MiB | 907.8 (887.9–1656.8) | 796.8 (743.2–1219.5) | 12.2% |

All 32 transfers, including warmups, passed SHA-256 and evidenced relay-only paths.
Ranges overlap and larger-file outliers remain in the raw samples. This is local
before/after CD evidence, **not a croc comparison, WAN/device result, or proof of
statistical confidence**. It does not establish the requested 1.5–2× croc target.

The initial unpaced attempt stopped on a real local short-code lookup HTTP 429.
No incomplete-run speed result is used. The complete rerun spaces starts by 5.5 s
outside timing, respecting unchanged admission limits. The interrupted attempt’s captured status/timing rows, including its failure,
are recorded separately in `paired.json`; the original driver did not save its
full row objects before termination, so per-attempt hashes and endpoint details
for that partial run are unavailable. Its diagnostic log is retained locally. No personal
files, credentials, production service changes, or public listeners were used.

## Reproduce

Build baseline and candidate with identical compiler and flags:
`go build -p 2 -buildvcs=false -trimpath -o /absolute/output ./cmd/cdx`.
Install the locked Node dependencies and build the local-only Worker bundle:

```sh
node_modules/.bin/esbuild worker/index.ts --bundle --format=esm --platform=neutral \
  '--external:cloudflare:*' --outfile=/absolute/worker.js
CD_BENCH_RUNTIME_BUNDLE=/absolute/worker.js CD_BENCH_WORKDIR=/disk/workspace \
  GOMAXPROCS=2 taskset -c 0,1 node scripts/bench-relay-reuse.mjs \
  /absolute/baseline /absolute/candidate /absolute/paired.json
```

The driver uses the reviewed matrix `trial` function, not a separate timing path.
It runs local-only infrastructure and never deploys. Its output records every
attempt and preserves failed rows. The published `paired.json` additionally
records executable hashes, candidate patch hash, environment, and interruption
context. Verbose stderr is omitted from the complete rerun rows; the earlier
interrupted attempt has only its captured partial records, explicitly labeled
as incomplete rather than represented as a complete raw dataset. For instrumentation,
build `go test -tags cdprofile -c` and run `scripts/profile-cd-transfer.mjs` with
the same bundle, `CD_BENCH_NO_COMPRESSION=1`, and `CD_PROFILE_MIB=256`. Profile
instrumentation is not a speed gate.
