# Comprehensive codebase audit

Audit date: 2026-11-11

Base: `origin/main` at `2261b65de0bf6e1cbcec8d7cf98847f18ff04896`

Delegation: 100 distinct read-only Luna tasks through T3 Code using Codex / `gpt-6-luna`. Peak observed queued or running concurrency was 21; the T3 capability listing advertised a batch limit of 20. Failed tasks: 0.

## High-impact fixes

1. **High — Android receive/control loop could die after a network transition.** `ReceiverService.kt:68–70` called `connect` inside the long-lived executor loop without handling `TransientNetworkException`. A network could pass `ReceiverNetwork.allowed`, then disappear before `ReceiverNetwork.client` selected its public network (`ReceiverNetwork.kt:66–75`), throwing from the loop and preventing further pair checks, heartbeats, and receive scheduling. The loop now tolerates only that expected transient exception and continues its normal polling cycle. Added focused unit coverage in `ReceiveGateTest.kt`. The Android unit-test task could not run because this checkout has no Android SDK configured.

2. **High — generated Firebase service-account credentials were not Git-ignored.** `scripts/setup-firebase.sh:249` creates `.firebase/service-account.json` and `.firebase/worker-secrets.json`; before the fix `.gitignore` had no `.firebase/` rule. Running `git add -A` could stage the private key. Added `.firebase/` to [.gitignore](/home/yvm/.t3/worktrees/cd/audit-100-luna-agents-2-d01f668bcfcaf6e0/.gitignore:5). Verified both generated credential paths with `git check-ignore -v`.

3. **Medium, high user-visible cost — repeated filenames froze browser bundling.** `src/zip-bundle.js:33–45` searched earlier collision suffixes again for each duplicate filename. Browser selection calls bundle creation synchronously in `src/main.js:339`. In Node, three runs per size using synthetic zero-byte files all named `same.bin` produced these medians:

   | Files | Before | After |
   |---:|---:|---:|
   | 1,000 | 59.0 ms | 1.2 ms |
   | 4,000 | 931.7 ms | 3.0 ms |
   | 8,000 | 3,806.1 ms | 5.2 ms |

   The allocator now remembers the next suffix per original name. Added a focused collision regression test; ZIP behavior and exact collision names remain covered.

## Confirmed findings left unchanged

- **High — encrypted Android vault corruption prevents app/store construction** (`android/app/src/main/java/in/yash0/cd/Store.kt:77–82`). A truncated vault, failed AES-GCM authentication, or invalid JSON throws during `Store` initialization, before the activity or receiver service can use stored pairs and transfers. Automatic reset would discard user data, so this audit does not reset or overwrite the vault. Recovery UX and a safe backup/restore path need a separate change.
- **Medium — receive queue can accept a record after finish** (`android/app/src/main/java/in/yash0/cd/BackpressureQueue.kt:19`). With a full queue, a producer can be waiting in `offer` when `finish` runs; if a slot opens before the offer timeout, the producer may return success after the consumer has observed completion, leaving the record stranded. Review-only; no stress reproduction was run.
- **Medium — quick unpause can leave receive unavailable** (`android/app/src/main/java/in/yash0/cd/ReceiveControl.kt:19–24`, `ui/ReceiveModeStub.kt:44–49`). Unpausing during the service’s 200 ms stop delay can lose the restart; unpausing while a pasted transfer is queued but no device is paired can also take the no-start path. The transfer remains queued while the UI can say it is connecting. No Android runtime reproduction was available.
- **Medium — partial SDK sample downloads can remain in cache after cancellation** (`android/sdk-sample/src/main/java/com/yashasvm/cd/sample/SampleActivity.kt:114–141`). Cancelling its activity scope rethrows `CancellationException` after the client closes the destination, bypassing the sample’s callback-error cleanup; the incomplete file remains in private cache.
- **Medium — unauthenticated LAN handshakes can occupy server sockets** (`internal/devices/server.go:100–116`). A LAN peer can open WebSocket handshakes and withhold its join; each holds a handler/socket until the five-second deadline. No concurrency limit or reproduction measurement was added in this audit.
- **Medium — CLI pairing secrets are stored as plaintext JSON** (`internal/devices/store.go:88–100`). `Store.Save` serializes the reusable pair secret into a mode-`0600` file. A copied backup or same-user-readable file exposes the secret; transport encryption does not protect the stored copy.
- **Medium — browser harness health checks can hang on a nonresponsive endpoint** (`scripts/harness.mjs:90–102`). `waitForHealth` awaits `fetch` without a per-request timeout, so its retry count cannot advance if a server accepts but never answers. A local reproduction remained pending after 273 ms while the child process remained alive; the rerun exited 0 after explicit socket cleanup and confirmed the finding.
- **Medium — detached CLI state directory permissions can remain too open** (`cmd/cdx/detach.go:106`). `MkdirAll(..., 0700)` does not tighten an already-existing `CD_STATE_DIR` such as mode `0755`; file names are traversable by other local users even though individual state files are private.
- **Medium — benchmark time and throughput disagree with even trial counts** (`scripts/bench-metrics.mjs:3–10`). With two successful 64 MiB trials at 2 s and 4 s, the summary reports 4 s and 32 MiB/s, which imply different durations. Reproduced with the `summarize` helper; no production behavior changes were made.
- **Medium — performance gate does not detect regressions against a baseline** (`scripts/fresh-transfer-gates.mjs:18`). A 64 MiB transfer taking 7.5 s still passes the fixed 8 MiB/s floor; the gate checks the floor, not change from a known-good run.
- **Medium — mixed browser/CLI benchmark rows use different receiver timing endpoints** (`scripts/bench-croc-browser.mjs:109–114`). Browser timing waits through the verified UI state, while the CLI path stops at a different completion event, so `receiverMs` is not directly comparable across those rows.
- **Medium — resume cleanup can skip later expired records indefinitely** (`cmd/cdx/resume_storage.go:248`). When the first 128 scanned directory entries remain unexpired, each cleanup pass scans that same prefix and never reaches later expired records; stale capability files remain on disk. No storage-exhaustion reproduction was run.
- **Medium — stalled CLI sends show stale progress until timeout** (`cmd/cdx/sender.go:661, 689`). If acknowledgements stop after partial progress, progress output is updated only on ACK and then remains frozen until the 90-second stall timeout, misleading terminal and JSON consumers about current activity.
- **Medium — a deadline can leave a detached CLI holder running** (`cmd/cdx/detach.go:123–166`, `cmd/cdx/process_unix.go:10–12`). If the parent receives a signal while waiting for the detached child’s ready line, it can exit without stopping the child, which runs in a separate session. No signal-race reproduction was run.
- **Medium — cancelling an active Android send has no confirmation** (`android/app/src/main/java/in/yash0/cd/ui/TransferScreen.kt:334–342`). A single tap dispatches cancellation; `SendEngineImpl.stop` marks the send cancelled and removes its prepared source. An accidental tap can terminate a transfer and discard its prepared copy; no interaction test was run.
- **Medium — three Android settings expose duplicate switch semantics to accessibility services** (`android/app/src/main/java/in/yash0/cd/ui/Components.kt:303`, `ui/Tabs.kt:322`). Both the row and nested switch declare the same switch role, so screen readers can encounter two controls for one setting. No accessibility-service runtime test was run.
- **Medium — the Android send preparation file can survive process death** (`android/app/src/main/java/in/yash0/cd/SendEngineImpl.kt:173, 213`). If the process is killed while writing `<id>.pending`, its `finally` cleanup cannot run and startup restores only store-backed entries, leaving the orphan bytes consuming private storage. No process-kill reproduction was run.
- **Low — the Go direct-path benchmark can count failed transfers as throughput** (`cmd/cdx/direct_bench_test.go:34–40`). If `receiver.next` or `sender.send` fails, ignored errors still leave `b.SetBytes` counting all 256 chunks, so the benchmark can report bytes not delivered. A one-iteration and focused benchmark run passed, but failure injection was not run.
- **Low — browser ceiling benchmark labels do not select distinct Worker behavior** (`scripts/bench-browser-ceiling.mjs:66`, `worker/index.ts:150`). Running `default`, `0`, and `1` changes a query parameter that the transfer Worker path does not inspect, so the benchmark labels compare the same Worker behavior.
- **Medium — concurrent Worker code claims can orphan a share code and prefix lease** (`worker/index.ts:315, 369–393, 420–436`). Two authorized `/api/codes` claims for the same waiting transfer can both pass the post-derivation check, reserve separate codes, then overwrite the room’s single cleanup reference. The earlier code can remain resolvable and its prefix hold can persist until expiry. The async race was traced but not reproduced concurrently.
- **Medium — same-size symlink replacement can send bytes outside a selected folder** (`cmd/cdx/bundle.go:185–212, 264–269`; caller `cmd/cdx/sender.go:385`). Folder traversal skips symlinks, but bundle entries are opened later by path after receiver acceptance. Replacing an entry with a symlink to an outside file of the same size causes those outside bytes to be streamed because opening follows the symlink and only byte count is checked. The reproduction is a same-size replacement between preparation and open; it was not run in this audit.
- **Medium — some Go-created bundles are rejected by the receiver** (`cmd/cdx/bundle.go:193–200`; `cmd/cdx/unbundle.go:42, 90, 105`). On Unix, a nested filename containing a backslash/control character, a path deeper than 64 components, or an archive with more than 10,000 entries passes sender traversal but fails receiver extraction. A transfer can finish while extraction fails; no cross-platform reproduction was run.
- **Medium — code-mode JSON output includes the private transfer URL** (`cmd/cdx/main.go:36–52`; `cmd/cdx/sender.go:296–300`). A normal `cdx send --json` sets both a numeric `code` and a URL containing `#v1.<key>`, then serializes the whole `readyOutput`. Any script/log retaining JSON output also retains a bearer capability that bypasses the code. No output-capture reproduction was run.
- **P2 — concurrent device claims can overwrite resumable intent for identical sources** (`cmd/cdx/devices.go:382, 470, 592`; `cmd/cdx/device_pending.go:43–71, 138–156`). Processes for the same pair and ordered source list share one pending-record path; separate transfer IDs can overwrite it, and either successful process removes it. If the other process exits before persisting again, automatic resume intent is lost. The cross-process race was traced, not reproduced.

## Reviewed and not promoted

- The reported `StorageBudget` concurrent-reservation issue was not retained: `ReceiverService` uses a volatile `receiving` guard and dispatches one receive task at a time, so the suggested two-active-receive trigger does not match this implementation.

## Checks and limits

- `npm test`: passed, 175 tests. The first run failed because installed dependencies were absent; after `npm ci`, the full run passed.
- `node --test src/zip-unbundle.test.js src/zip-bundle.test.js`: passed, 20 tests.
- `go test ./...`: passed for `cmd/cdx` and `internal/devices`.
- `git check-ignore -v .firebase/service-account.json .firebase/worker-secrets.json`: both paths ignored by `.gitignore:5`.
- `./gradlew :app:testDebugUnitTest --tests 'in.yash0.cd.ReceiveGateTest' --no-daemon`: blocked because `ANDROID_HOME` / `android/local.properties` does not identify an Android SDK.
- Android device behavior, network-loss fault injection, and security findings that require another host/user were not exercised. No performance claims beyond the controlled duplicate-name benchmark are made.

See [the task ledger](comprehensive-audit-ledger.md) for all 100 areas, exact task IDs, terminal statuses, result summaries, and failure status.
