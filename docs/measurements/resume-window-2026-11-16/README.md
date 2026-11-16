# Bounded browser resume window, 2026-11-16

Baseline: `371bf9747643a1dc6ca1ed051402f9b95f6615ba`, the measurement commit stacked on PR #98. No merge or deployment.

## Why this candidate

The 64 MiB browser profile showed repeated checkpoint derivation, but its latency was small beside other work. In the CPU-profiled run, sender and receiver checkpoint derivation totalled 10.3 ms and 11.4 ms respectively. Receiver OPFS Worker write roundtrips totalled 996.5 ms; sender and receiver checkpoint transaction latency totalled 350.3 ms and 222.5 ms. Async latency totals can overlap and are not CPU time. These are instrumented diagnostic observations, not throughput comparisons.

CDP samples also identified the SHA compression and rotation functions as substantial JavaScript work. Their minified names were `C` and `S` in `resume-browser-BKk9RK9y.js`, built from the baseline source. The raw profiles retain sanitized source URLs with capability fragments and query strings removed. No key cache was added.

The CLI receiver already batches durable checkpoints when an authenticated sender advertises its window. The browser previously kept four chunks in flight without advertising that window, and required an ACK for each chunk. This forced per-chunk CLI commits.

The candidate advertises the existing native protocol's four-MiB window and caps the browser flight at sixteen 256 KiB records. Cumulative ACKs must match both the byte and chunk count of an outstanding sent boundary. Removing that acknowledged prefix frees only the covered capacity. Per-chunk ACKs from older receivers still work. Checkpoint MACs, session nonces, encryption, whole-file verification and receiver commit-before-ACK ordering are unchanged.

The browser receiver's existing inbox allows four MiB plus 64 KiB of control overhead and 32 records. Sixteen encrypted chunk records fit that byte budget. Tests observe a full sixteen-record stall without ACKs and sender working-buffer accounting below five MiB. This is not a claim about Chromium process RSS. An interrupted transfer can retransmit up to four MiB of unacknowledged tail, as with the native sender.

## Rejected first candidate

The first candidate advertised only the existing one-MiB flight. A simulated receiver batching the entire offered window exposed a repeated drain-and-refill gap with 30 ms delayed ACKs. All seven paired fixture trials regressed. The patch is retained as `four-record-candidate.patch`, with raw observations in `delayed-ack.json`.

The four-MiB candidate improved all seven pairs of that same encrypted Node fixture; raw observations are in `delayed-ack-sixteen.json`. This fixture verifies every output byte and uses real v2 encryption, but its input is deterministic and its receiver/network are simulated. It does not measure disk, Chromium, LAN, WAN or a physical phone. Do not pool it with real transfer timings.

## Correctness checks

The new cumulative-ACK tests failed before implementation. After advertising the window alone, valid cumulative ACKs still failed. Both red runs are retained alongside the first green run.

All 195 JavaScript tests, build and type checking passed. The eleven focused sender tests cover per-chunk and cumulative ACKs, invalid byte and chunk counts, a repeated logical ACK in a fresh encrypted record, cancellation, interruption, empty files, short tails and resumed prefixes. Additional focused variants cover a full-window ACK and a resumed full-window ACK. Existing Go resume tests passed uncached.

All five real browser/CLI resume scenarios passed with the sixteen-record candidate. The killed CLI receiver resumed from exactly 4,194,304 committed bytes; every final size and SHA-256 matched. See `cd-window-sixteen-full-resume.json` and its log.

## Real paired measurement

Seven alternating pairs of fresh 64 MiB plus 77 byte inputs completed through the actual browser sender, local v2 relay and CLI receiver. Only `src/resume-browser.js` differs between builds. The CLI binary SHA-256 must remain identical across every trial. Temporary storage is on the SSD, profiling is disabled, and each trial records host load. Full output length and SHA-256 are checked outside timing. Unrelated desktop activity is not excluded.

```sh
npm run build
mkdir -p "$HOME/.cache/cd-bench-tmp"
TMPDIR="$HOME/.cache/cd-bench-tmp" CD_BROWSER_RESUME_ONLY=browser-cli node scripts/bench-resume-paired.mjs 371bf9747643a1dc6ca1ed051402f9b95f6615ba /tmp/cd-window-report src/resume-browser.js
TMPDIR="$HOME/.cache/cd-bench-tmp" CD_RESUME_PROFILE=1 CD_BROWSER_RESUME_ONLY=browser-browser CD_BROWSER_RESUME_BYTES=67108941 CD_BROWSER_RESUME_REPORT=/tmp/cd-resume-profile.json node scripts/verify-browser-resume.mjs
```

The candidate source patch is retained as `candidate.patch`. All fourteen trials passed with seven distinct input hashes and an identical CLI binary. The transfer/publication medians were 21.22 s before and 7.06 s after; total completion medians were 29.89 s and 10.77 s. Six of seven pairs improved in both phases. The one-minute host load ranged from 13.79 to 24.61 and unchanged preparation code also varied substantially. These loaded-host observations support further evaluation; they do not establish a stable speed multiplier, LAN/WAN speed or competitor ranking. All rows, including the slower candidate pair, remain in `paired-cli-64mib/paired.json`. `comparison.html` plots every pair.

Sol's independent review approved the code and requested one documentation correction. The ADR now records Android's two-MiB commits for a four-MiB advertised window. The review did not run tests or use ongoing timings as approval evidence.

## Recovered continuation

The original T3 run ended on a provider event-stream failure before committing this candidate. On continuation, the current source SHA-256 matched the measured candidate. Every standalone trial report matched its embedded raw result; all fourteen rows had exact output size, expected digest, local relay route, disabled profiling and the same CLI hash. Alternating order and seven distinct fresh pair digests were checked again.

All 195 JavaScript tests, type checking, build and all five real resume scenarios passed again. The new restart run resumed the CLI receiver from 4,194,304 committed bytes and the browser receiver from 524,288 bytes. Reports are retained as `continuation-full-resume.json` and `continuation-full-resume.log`. Initial tests using `/tmp` failed with a storage quota error; rerunning with SSD scratch space passed without source changes.

Physical Android compatibility remains unverified. The Redmi Note 8 was discovered online through T3 device tools. Only the old `in.yash0.cd` package was installed. The existing Beta APK from `/home/yvm/code/cd-product-ux/android`, checked on branch `feat/product-ux` with application ID `in.yash0.cd.beta`, could not be uploaded. Both the initial install and the prescribed debug retry returned `Artifact transfer was interrupted`. Device work stopped after that retry. The phone was not rebooted, and the old app was not used as Beta validation.

## Independent continuation cohort

A second seven-pair cohort used the same baseline, current candidate, 67,108,941-byte fresh inputs and identical CLI binary. Every one of its fourteen outputs passed size and full SHA-256 verification. One-minute load ranged from 3.85 to 6.07. Transfer/publication medians were 2.648 s before and 2.482 s after, with six of seven pairs improving. Total completion medians were 5.035 s before and 4.325 s after, with five of seven pairs improving. Preparation medians were 1.881 s and 1.848 s; preparation code is unchanged.

This much smaller transfer-phase difference does not reproduce the first cohort's large ratio. Keep the cohorts separate. The results support a bounded-window candidate, not a stable multi-fold speed claim. Raw observations and summary are in `continuation-paired-cli-64mib/`. No production speed or competitor claim is justified by local relay measurements alone. Go tests also passed on continuation.

Publication remains pending because `git push` could not obtain a GitHub username and `gh` returned HTTP 401. The recovered implementation and evidence are saved in local commit `4355850`, followed by the continuation evidence commit. The connected GitHub reader confirmed draft PR #99 remains open with its original measurement-only description; no unpublished production change is represented as published.

Next: compare the candidate against the same baseline on the real browser receiver path, preserving OPFS and per-chunk ACKs. Complete physical Beta validation once device artifact upload works. Existing tests already cover legacy per-chunk ACKs. No merge or deployment.

## Browser receiver control

All fourteen independent browser-to-browser 64 MiB plus 77 byte trials passed full output size and SHA-256 checks. This compares only the sender window; browser receiver per-chunk commits remain unchanged. Before/after transfer medians were 4.927 s and 4.120 s, with 6 of seven candidate pairs faster. Total completion medians were 6.747 s and 5.946 s, with 6 of seven pairs faster. Host load ranged from 3.46 to 6.42. Raw rows and the summary are in `continuation-paired-browser-64mib/`. These timings are local controls, not a general speed claim.
