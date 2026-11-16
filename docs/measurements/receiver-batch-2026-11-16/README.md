# Bounded browser receiver batching, 2026-11-16

Baseline: local commit `81e7e1bb3028da7f3fb4b08ba88a40017301781d`, the tree published as draft PR #100. This is a separate, unmerged experiment. No deployment.

## Candidate and invariants

The earlier receiver profile showed OPFS roundtrip and checkpoint transaction waits. Instead of adding unflushed transactions to both storage backends, collect one bounded batch in the receiver stage and pass it through the existing flushed write path. A four-MiB or larger authenticated advertised window selects two-MiB commits; a one-MiB window selects one-MiB commits; absent/zero windows and smaller valid windows retain per-chunk commits. Invalid windows fail before storage allocation. The selected batch is capped even when a sender advertises a huge safe integer.

Only after the file flush or fallback stream close and signed checkpoint persistence succeed does `append` return a durable commit signal. Only that signal permits an ACK. Buffered bytes are absent from current offsets, checkpoint hashes, retained progress and ACKs. Release drops the buffered tail; cancellation waits for in-flight writes and checkpoints before deleting storage. A failed write or checkpoint latches the stage into failure. Reopening uses the existing truncation and prefix-hash verification. Empty files and final short batches retain whole-file verification.

The worker write guard is now bounded at two MiB. Receiver working-buffer accounting includes the staging batch and Worker clone, plus the prior decrypted/encrypted record accounting. It excludes the separately bounded socket queue and Chromium process/native storage memory; this is not an RSS measurement.

## Validation

All 201 JavaScript tests, type checking and build passed. Focused tests cover legacy senders, one/two-MiB batches, invalid windows, final tails, interruption, cancellation before and during commit, failed checkpoint persistence and truncation of flushed-but-uncheckpointed bytes. A legacy per-chunk checkpoint can resume into a two-MiB batch from an offset unaligned to that batch size.

All five real browser/CLI resume scenarios passed with exact full output hashes, including Worker and writable-stream fallback downloads and both restart paths. The browser receiver restart retained 2,097,152 committed bytes. The real OPFS Worker crash verifier now runs legacy and negotiated two-MiB cases: both flush real bytes, crash before responding, retain offset zero, then recover the same file on the same page after truncation. An independent read-only reviewer approved the production logic, with no test runs by that reviewer. Its two coverage suggestions were added and passed.

The first two integration attempts stopped at verifier assertions that assumed one Worker write per protocol chunk. Both logs are retained. The verifier now checks exact bytes written and bounded writes rather than enforcing that old implementation detail. These failed attempts are not speed observations.

## Measurement method

Each completed path has seven alternating fresh-input 64 MiB plus 77 byte browser-to-browser pairs against the baseline, replacing only `src/resume-browser.js` between the two builds. The expanded Worker input guard is common to both builds; the baseline still writes only 256 KiB records. Use SSD scratch space, no profiling, full output digest/length verification and retained failures. Worker and writable-stream fallback results are separate. Do not pool paths or prior cohorts. Completed local observations are reported below.

Physical Android validation remains unavailable after the prior device artifact upload failures. The published sender-window draft is #100. This receiver candidate is a separate review unit, with no merge or deployment.

## First Worker cohort did not complete

The first seven-pair Worker cohort retained thirteen verified transfers and one baseline timeout waiting for a browser download. No completed timing was retained for that failed trial, and this cohort is ineligible for a speed claim. The baseline timeout lacks receiver/sender status because the verifier only captured save failures after a download event; the verifier now also reports sanitized receiver status, progress and sender error when the event never arrives. The timeout cause remains unproven.

A 203-test verification run overlapped the last pair, completing shortly before the baseline timeout was recorded. This was an avoidable measurement confound. The complete raw cohort is retained unchanged, and a fresh cohort will run without other agent-started tests, builds or device activity. Do not discard the slower candidate pairs or pool successful rows from this cohort with a replacement.

`node scripts/summarize-resume-paired.mjs <cohort>/paired.json` verifies completeness, alternating order, matching fresh input, exact byte counts and hashes, route, disabled profiling, fixed CLI binary where applicable, and agreement with every standalone raw report before computing summaries. Its tests include slower candidate pairs and reject invalid evidence. All 203 JavaScript tests passed.

## Completed Worker recheck

All fourteen fresh recheck transfers passed size and full SHA-256 verification, with no profiling or other agent-started test/build/device work. The reusable summary verifier passed against the standalone raw reports. Transfer/publication medians were 3.589 s before and 3.430 s after, with 5 of seven candidate pairs faster. Total medians were 5.451 s and 5.249 s, with 5 of seven pairs faster. Two candidate pairs were slower and remain in the results. Host load ranged from 3.40 to 5.27.

This is a small, mixed local observation, not a stable speed multiplier. It must be weighed against the extra bounded receiver memory and larger retransmission tail before accepting the change. The earlier failed cohort remains separate. Fallback results follow below.

## Completed fallback cohort and review decision

All fourteen writable-stream fallback transfers passed size and full SHA-256 verification. Source fingerprints match the Worker recheck candidate. The summary verifier passed every standalone raw report. Transfer/publication medians were 20.634 s before and 4.777 s after, with all seven candidate pairs faster. Total completion medians were 22.447 s and 6.602 s, also with all seven pairs faster. Host load ranged from 2.60 to 4.68. No other agent-started tests, builds or device work overlapped these trials.

The fallback result supports proposing this candidate for review. It does not establish the same gain for the OPFS Worker, LAN, WAN, physical phones or competing tools. The fallback closes/reopens its stream at each commit, so reducing commit frequency plausibly explains the path-specific difference; these timings alone do not isolate that mechanism. Preparation code is unchanged. OS cache is allowed, SSD scratch space is used, and timing includes receiver publication and sender completion. Full saved-output hashes are checked outside timing. No power-loss durability test was performed.

Keep the extra bounded batch/Worker-copy memory and up to two MiB of uncommitted receive tail explicit. The sender's outstanding window remains four MiB. Do not present the small mixed Worker result as a universal improvement, and do not drop its two slower candidate pairs. The first failed Worker cohort is retained but excluded from speed summaries.

Review boundary: a separate draft stacked on #100. No automatic merge or deployment. Android device compatibility remains unverified after the tool upload failures.

Final publication check: all 203 JavaScript tests, type checking, build and all five actual browser/CLI resume scenarios passed again after the timing cohorts finished. No validation workload overlapped those completed cohorts. The final logs and exact output hashes are retained beside these notes.
