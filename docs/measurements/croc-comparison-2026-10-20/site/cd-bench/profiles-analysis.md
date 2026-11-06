# Actual CLI relay allocation profiles

The diagnostic binary is `/tmp/cdx-profile`, built with `go test -tags cdprofile -c -o /tmp/cdx-profile ./cmd/cdx`. Its build ID is `081fa48405320aa8fbe96af0355df15ab9e671bf`. `TestProfileCLI` calls the real CLI `run(args)` and is excluded from production builds. These runs force the local Worker relay and use 256 MiB of random data on tmpfs. Both sender and receiver exit successfully, the receiver output matches SHA-256, and transport reports show zero direct bytes. Diagnostic timing is not benchmark evidence.

Run the working profile with:

```sh
GODEBUG=gctrace=1 CD_PROFILE_CPU=0 CD_PROFILE_MIB=256 node scripts/profile-cd-transfer.mjs /tmp/cdx-profile docs/measurements/speed-goal-2026-10-20/profiles-gc256
```

## Measured allocation cost

The sender allocates 261.37 MiB total. `recordSealer.seal` accounts for 258.68 MiB, or 98.97%. The receiver allocates 259.87 MiB total. `recordLink.readRelay` accounts for 258.80 MiB, or 99.59%. The independent heap-only run in `profiles-heap256` reproduces these totals within 0.2 MiB.

These are the highest measured allocation costs. The code allocates a full ciphertext record in `recordSealer.seal` and a full incoming record in `readRelay`. Receiver decryption already consumes that record in place. Buffer reuse would therefore target the remaining payload-sized allocation on each side. Any receive reuse must explicitly preserve ownership through record reordering and plaintext consumption. Any sender reuse must preserve retained relay records while a direct connection may still adopt them.

## Garbage collection

The sender reports 86 ordinary GC cycles plus one forced profile GC, with 4.021 ms total stop-the-world time and 63.78 ms cumulative concurrent-mark wall time. The receiver reports 94 ordinary cycles plus one forced profile GC, with 10.082 ms total stop-the-world time and 35.32 ms cumulative concurrent-mark wall time. Both last GC trace lines report 1% GC CPU across 12 logical processors. Concurrent mark overlaps application execution, so adding its wall time to transfer time would overstate its cost. Heap allocation is proven; these results do not establish that GC alone explains the relay gap.

Raw data is in `profiles-gc256/diagnostics.json`, the parsed GC totals are in `profiles-gc256/gc-summary.json`, and `sender-alloc-top.txt` / `receiver-alloc-top.txt` contain pprof summaries.

## CPU profile restriction

Enabling Go CPU profiling kills the instrumented process with SIGKILL on this host. It also happens for the trivial `version` and `--help` commands after they print PASS, independently of transfer code. Heap-only profiling succeeds. The failing transfer reports are retained in `profiles/failure.json` and `profiles256/failure.json`; their incomplete CPU and heap outputs are invalid evidence. The process cgroup reports zero OOM events and unlimited memory, and no kernel OOM log accompanies the failures. The cause of SIGKILL is unproven. No CPU-stack ranking is claimed from these runs.
