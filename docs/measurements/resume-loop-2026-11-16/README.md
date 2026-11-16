# Transfer improvement loop, 2026-11-16

Starting commit: `ce19da21b9e7bdf5f5bc398be10973358c649064`, draft PR #98. No production changes, merge or deployment in this iteration.

## Correctness

Omarchy has Go 1.26.11 and Chromium 155.0.8059.84. Installed the locked npm dependencies in this worktree. Build, 192 JavaScript tests, type checking and `go test ./...` passed.

The full resume verifier initially timed out waiting for a sender error screen after killing the CLI receiver. The sender now reconnects automatically. The verifier follows reconnection instead of clicking manual retry. The focused check resumed from 262,144 committed bytes and verified all 8,388,685 bytes by SHA-256. See `restart-fixed.json`. Initial failures remain in this directory.

The next full run passed all three uninterrupted paths and killed-CLI restart, then failed the browser's same-page restart. The test started the resumed CLI sender while the previous browser receiver could still reconnect. Moving Receive another before starting that sender passed the focused same-page check. See `same-page-fixed.json`. The subsequent complete run passed all five scenarios in `full-resume-final.json`.

## Measurement work

`scripts/bench-resume-paired.mjs` compares the baseline hash module with the current module in an otherwise identical current UI and relay. It alternates order, generates fresh random bytes for each pair, uses the same bytes within that pair, and saves each trial's report and log, including failures. Each trial uses fresh Chromium contexts and a fresh local relay. The default is seven pairs of 64 MiB plus 77 bytes.

The first small smoke comparison failed before either sender published its link. Those trials are retained under `smoke/`; they establish no speed result. A minimal WebSocket probe showed that Chromium 155 blocks local sockets from a document served by Playwright `route.fulfill`, reporting `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. Narrower route patterns did not fix it. Serving the alternate build through Wrangler's native `--assets` option passed both 1 MiB plus 77 byte trials in `smoke-native-assets/`. These smoke timings overlapped other checks and are excluded from speed comparisons.

All fourteen initial 64 MiB plus 77 byte trials reached download publication but failed `download.saveAs` with `canceled`. This cohort used the nearly full `/tmp` RAM filesystem and remains under `paired-64mib/`. It establishes no transfer-speed result. The receiver reported `File verified. Download started; check your downloads.` after its full staged-file reread, before Chromium canceled the download.

A control with identical fresh 67,108,941-byte input and SHA-256 `01bbb376340f1bcd957fbac74b5ff75e04045c37a0731eaf007f6066b0490d0f` failed on `/tmp` and passed with `TMPDIR=/home/yvm/.cache/cd-loop-tmp` on the SSD. See `tmpfs-same-input.json` and `ssd-same-input.json`. The latter verified the complete saved output. This isolates a temporary-storage-location dependency, not the underlying Chromium cause. At the time, `/tmp` had about 1.6 GiB free and the SSD about 94 GiB free. A new seven-pair cohort uses the SSD for both variants; its results remain separate.

This is a same-host local relay measurement with OS cache allowed. Browser OPFS flush and strict IndexedDB commit ordering remain unchanged. It does not measure physical disk persistence, a physical phone, LAN or WAN throughput. The existing SHA microbenchmark remains separate from end-to-end evidence.

## Completed SSD comparison

All fourteen SSD trials passed full saved-output size and SHA-256 checks. Each pair used fresh random input shared only within that pair. Trial order alternated. The desktop was not exclusively reserved, so unrelated background activity remains a source of noise.

| Timing | Before median | After median | After faster in |
| --- | ---: | ---: | ---: |
| Preparation | 2.397 s | 1.844 s | 7 of 7 pairs |
| Transfer and publication | 6.379 s | 7.124 s | 4 of 7 pairs |
| Total completion | 9.460 s | 8.973 s | 4 of 7 pairs |

Preparation medians improved by an observed 1.30x. Total medians differ by only 1.05x, with a wide spread: before 7.925 to 19.423 s, after 6.646 to 15.266 s. This sample does not establish a reliable overall transfer-speed gain. In particular, the transfer-phase median regressed. Do not turn the hashing microbenchmark into an end-to-end speed claim.

Preparation starts after initial sender page creation, before UI file selection and prehash, and ends when the private link is visible. Transfer includes receiver context creation, initial page load, private-link navigation, encrypted transfer, staged-file verification, download save and sender completion. Exact output size and Node SHA-256 are checked after the timer. File generation and harness input copying occur before timing. OS page cache is allowed.

[All paired rows](paired-ssd-64mib/paired.json), [recomputed statistics](paired-ssd-64mib/summary.json), and [interactive comparison](comparison.html) preserve the observations. The failed RAM-filesystem cohort remains separate in [its complete report](paired-64mib/paired.json).

Reproduce from the repository root, with temporary storage on a volume with sufficient free space:

```sh
npm ci
npm run build
mkdir -p "$HOME/.cache/cd-bench-tmp"
TMPDIR="$HOME/.cache/cd-bench-tmp" node scripts/bench-resume-paired.mjs fb390760baaab971f9b9f92c2a5e5715adf69717 /tmp/cd-resume-paired-report
CD_BROWSER_RESUME_REPORT=/tmp/cd-resume-correctness.json node scripts/verify-browser-resume.mjs
```

## Review ledger

Sol-loop reviewer: `gpt-6.1-sol`, round 1, verdict CHANGES. Usage was not exposed.

- S1, should: report-write failure skipped cleanup. Added nested `try/finally`; a real invalid-path run exited with the expected `ENOENT` and no surviving captured descendants. See `report-failure-cleanup.json`.
- S2, should: timed-out verifier could leave browser and relay descendants. Added graceful signal handling and aborts the comparison if graceful trial cleanup times out. A SIGTERM check captured 14 processes and found no survivors within three seconds of verifier exit. See `signal-cleanup.json`. An initial immediate-after-exit sample briefly observed a descendant that then exited; the checked probe uses the stated bounded deadline.

Round 2 approved the fixed cleanup, native asset serving and restart ordering, with S1 and S2 resolved and no new findings. Round 2 used the exposed `ultra` effort setting; round 1 did not expose effort. The reviewer did not rerun tests or inspect live timing logs. The parent verified the actual trial reports and recomputed all statistics. No model usage figures were returned. Initial complete diff size was not recorded; the first tracked verifier statistic was 30 additions and 5 deletions, excluding the then-untracked benchmark. The final runtime harness diff has 129 additions and 13 deletions across three scripts, including the new 81-line benchmark; evidence artifacts are additional.

## Next iterations

1. Profile Chromium checkpoint derivation, signing, OPFS flush and IndexedDB commit time before choosing the next production change. The SSD transfer-phase spread makes more hashing microbenchmarks a weak next step.
2. Isolate the temporary-storage download failure with a direct OPFS-backed File download control. Changing storage location fixes the observed run, but is not a production-code fix or established root cause.
3. Consider one non-extractable HMAC signer per sender operation or receiver stage if measurements justify it. Bind root ID, role and secret; reject a mismatched root or role. Preserve golden MAC bytes and existing verification callers. Avoid global caches.
4. Validate latency and loss behavior of the existing bounded pipeline. Never ACK bytes before both staged bytes and checkpoint commit.
5. Reuse the existing croc comparison harness with equal durable completion and full-file hashes. Report tool versions, actual routes, hardware, files and failures. Same-host results cannot support a claim of fastest file transfer on Earth.

The user wants that speed claim published on GitHub with proof. The current evidence does not support it. No separate architecture proposal has been supplied.
