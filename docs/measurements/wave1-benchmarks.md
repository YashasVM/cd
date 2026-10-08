# Wave 1 benchmark contract and baseline

Run from a built checkout, on the same machine and network for comparisons:

```sh
npm ci
npm run build
node --test scripts/bench-metrics.test.mjs
CD_BENCH_ONLY=code,foreground,relay,tunnel CD_BENCH_MIB=2 CD_BENCH_RUNS=3 node scripts/bench.mjs > baseline.json
```

Use 64 MiB and five runs of one mode at a time for a throughput baseline, allowing the relay's connection rate limit to recover between invocations. The default three runs of four modes stay below the 30-admission/minute CLI relay limit when run alone. Do not run other verification or benchmark jobs concurrently. `CD_VERIFY_URL` selects an existing deployment; omit it for loopback Wrangler. Browser runs require Chromium (`CHROMIUM_PATH` can select it). `CD_BENCH_CPU_THROTTLE=4` slows only browser receivers.

The script emits one JSON result to stdout, with individual trials, completion rate, successful medians, payload size, target and machine metadata. Any failed requested mode exits nonzero. Payloads are random incompressible bytes, reused within an invocation. Every successful trial checks SHA-256 after receiving the complete file. Failed trials remain in the denominator and never contribute to throughput medians. Startup of the local Worker and CLI compilation are outside measurements.

`code` measures the actual detached command, without `--wait`. Readiness ends at its first share-code line. Parent exit is measured separately, before launching a receiver. A status query must find a waiting holder, and its process must still exist after parent exit. The receiver then completes and `cdx wait` must report verified completion. `foreground` and `relay` both use `send --wait`; the former makes the foreground comparison explicit. Transfer duration begins immediately before receiver spawn and ends when receiver output closes; holder status polling does not inflate throughput.

Both CLI clients receive `CD_DIRECT=0` and `CD_TRANSPORT_REPORT=1`. The benchmark rejects direct bytes or absent telemetry, and requires encrypted relay bytes sufficient to carry the payload. Detached sender telemetry comes from its holder log. `outputBytes` counts sender command plus receiver stdout and stderr, including opt-in telemetry. `stdoutBytes`, `stderrBytes`, and separate `holderLogBytes` distinguish terminal output from background diagnostics. Status and wait command output are control observations and excluded. Path-dependent diagnostics can vary output sizes.

`tunnel` retains its old benchmark name and measures the current encrypted browser relay sender. Direct candidates are prohibited with relay-only ICE policy. Instrumented WebSocket and data-channel binary sends prove which route carries the payload; forcing tunnel additionally requires zero direct bytes. Browser output size is null because there is no command output. Readiness starts at file selection and ends when a share code is visible; transfer timing begins before receiver code entry, which automatically connects numeric codes.

`p2p` and `legacy` remain explicit opt-in probes. They require payload bytes on the raw or legacy data channel, respectively. The current browser sender offers only the relay, so these modes fail with observed route byte counts and guidance instead of silently reporting relay traffic as P2P throughput. The default set is `code,foreground,relay,tunnel`. Browser direct baselines become available when Wave 3 adds that sender transport.

## Observed smoke baseline

Measured on 2026-10-08 with a 2 MiB payload against local Wrangler, before the quiet workflow and folder preparation changes were integrated. These are smoke measurements rather than a performance claim; concurrent development and CPU load can materially change loopback timing.

| mode | completed | median readiness | median parent exit | median throughput | terminal output |
| --- | --- | --- | --- | --- | --- |
| detached `code` | 3/3 | 28.95 ms | 30.21 ms | 34.55 MiB/s | 426 bytes |
| `foreground` | 3/3 | 19.81 ms | — | 33.49 MiB/s | 809 bytes |
| forced CLI `relay` | 3/3 | 36.43 ms | — | 25.10 MiB/s | 799 bytes |
| browser `tunnel` | 1/1 | 69.71 ms | — | 8.72 MiB/s | — |

All CLI sender reports showed 2,097,541 encrypted bytes sent on relay and zero direct bytes; receiver reports showed 148 relay bytes and zero direct bytes. Each detached holder was alive after parent exit. Detached holder logs were 455 bytes each. The browser relay sent 2,097,541 binary bytes and zero raw or legacy bytes. P2P and legacy probes each failed with completion rate 0/1 and those same observed relay bytes, proving the prior labels were invalid for the current UI.

A later run concurrent with a CLI verifier completed all nine CLI trials and two of three browser relay trials; one browser sender timed out becoming ready. The script retained that failure (2/3 completion, nonzero exit). This loaded run should not be used for performance comparisons.

Verification: four benchmark helper tests pass (failure-aware medians, exact output-byte accounting on both streams, fragmented readiness lines with listener cleanup, actionable timeout/EOF). Build succeeds. The coordinator runs repository checks and reruns this contract after integrating the wave.
