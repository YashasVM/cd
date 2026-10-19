# CD Android app — rebuild brief (2026-10-19)

Owner/orchestrator: Claude (parent thread). You are one of three parallel agents.

## Product goal (from the user)
The CD Android app (Kotlin + Jetpack Compose, originally written by another agent) should:
1. **Receive with resume**: trusted-device (paired CLI) receiving and pasted/scanned private v2 links; interrupted transfers continue from verified, retained progress.
2. **Send files directly from the phone, in the foreground** ("without running in the background"): pick files (or share them into CD from another app) → CD shows a private resumable link + QR (and a short code if the protocol supports it) → `cdx receive <link>` or the cd.yash0.in website receives it. No always-on background service needed for sending; if the app is closed/killed mid-send, reopening it and tapping Resume continues from the receiver's checkpoint.
3. **Be fast.** The user suspects the current code doesn't work and is slow. Measure, then make it fast.
4. **Look like the website** (cd.yash0.in: `index.html`, `src/style.css` in the repo) — frontend agent only.

## Repo layout
- Main repo (READ-ONLY for you, do not edit, do not git commit/stash/reset/checkout anything): `/home/yvm/code/cd`
  - Go CLI: `cmd/cdx` (resume v2 sender/receiver: `resume.go`, `resume_protocol.go`, `resume_direct.go`, device pairing: `devices.go`, `device_transport.go`)
  - Worker/relay: `worker/index.ts`, `wrangler.jsonc` (`npx wrangler dev` runs it locally)
  - Website: `index.html`, `src/*.js`, `src/style.css`; browser v2 receiver is `src/resume-browser.js`
  - Docs: `docs/adr/0001-authenticated-resume.md`, `docs/adr/0002-paired-android-receiving.md`, `docs/implementation/android-*.md`, `CONTEXT.md`
  - Shared protocol fixtures: `fixtures/` (Kotlin unit tests read them)
- The Android app lives in an UNTRACKED dir `android/`. Each agent works in its OWN copy:
  - backend-send agent: `/home/yvm/code/cd-aw-send/android`
  - backend-receive agent: `/home/yvm/code/cd-aw-recv/android`
  - frontend agent: `/home/yvm/code/cd-aw-ui/android`
  (`../fixtures` is symlinked so unit tests work.) The orchestrator merges copies back by FILE OWNERSHIP below — stay inside your owned files, and make only small, additive, clearly-commented edits to shared files.
- Build: `cd <your copy>/android && ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` (JDK 17 + SDK already set up via local.properties).
- Tools: `~/Android/Sdk/platform-tools/adb`, `~/Android/Sdk/emulator/emulator`. KVM available. Existing AVD `wl35` (API 35 x86_64). Run your own instance read-only on your assigned port, headless:
  `~/Android/Sdk/emulator/emulator -avd wl35 -read-only -no-window -no-audio -no-snapshot -port <PORT> &` then `adb -s emulator-<PORT> ...`
  Ports: receive = 5554, send = 5556, frontend = 5558. Never touch another agent's emulator. Kill yours when done.
- Local relay: `cd /home/yvm/code/cd && npx wrangler dev --port <WPORT> --persist-to /tmp/cd-wrangler-<agent>` ; use `adb -s emulator-<PORT> reverse tcp:<WPORT> tcp:<WPORT>`. Ports: receive 8787, send 8788, frontend (if needed) 8789. Build cdx into a private path: `cd /home/yvm/code/cd && go build -o /tmp/cdx-<agent> ./cmd/cdx` (check `cmd/cdx/main.go` for how to point it at a local relay URL / env var).
- Do NOT deploy anything, do NOT push, do NOT touch production (cd.yash0.in) except read-only GETs.

## The UI <-> transport contract
`app/src/main/java/in/yash0/cd/TransferBus.kt` (already written by the orchestrator). The UI reads `TransferBus.transfers` / `TransferBus.receivingStatus` and calls `TransferBus.sender.start/pause/resume/cancel`. Transport code publishes `TransferView`s (with `done`, `bytesPerSecond`, `phase`, `route`, `link`, `code`). Don't rename fields; if you truly need a new field, add it with a default value and say so in your final report. `Status.text` in ReceiverService is legacy — receive agent should route it through `TransferBus.status(...)`.

## File ownership
- **Frontend agent (Claude)**: `MainActivity.kt`, new `ui/` package (`app/src/main/java/in/yash0/cd/ui/*.kt`), `res/**` (themes, fonts, drawables, icons), and `AndroidManifest.xml` *only* for adding the `ACTION_SEND`/`ACTION_SEND_MULTIPLE` `*/*` intent filters + `ACTION_VIEW`. May add Compose deps (e.g. `material-icons-extended`, google fonts / bundled Inter + mono font) to `app/build.gradle.kts` dependencies block only.
- **Backend-send agent (GPT)**: new files `Sender*.kt` / `Send*.kt`, `SendEngine` implementation installed into `TransferBus.sender` (from an `Application` subclass or a lazy init the UI can call — coordinate by documenting it), additive helpers in `Protocol.kt`/`Wire.kt` (prefer copying into your own file if unsure), new unit tests. 
- **Backend-receive agent (GPT)**: `ReceiverService.kt`, `ResumeReceiver.kt`, `DirectReceiver.kt`, `Wire.kt`, `Protocol.kt`, `BackpressureQueue.kt`, `DurableFiles.kt`, `DurableAckPolicy.kt`, `ReceiveScheduler.kt`, `StorageBudget.kt`, `Store.kt`, `TransferFiles.kt`, network policy files, their tests, gradle perf settings (R8/minify for release, okhttp, etc.).
- If you must change a file you don't own, keep the change minimal and list it explicitly (path + why + diff summary) in your final report.

## Definition of done (backend agents)
- Unit tests + lint pass in your copy.
- Real end-to-end on the emulator against a local `wrangler dev` relay and a locally built `cdx`, with SHA-256 of source == destination. Include an interruption+resume test (kill the app or the CLI mid-transfer, then resume and verify it continued from > 0, not from 0).
- Before/after throughput numbers (MB/s) for at least: relay route, and LAN/direct route if applicable, using ≥256 MiB files. Explain what the bottlenecks were and what you changed.
- Final report: what was broken, what you changed (file list), measurements, open risks. Be honest about anything not verified.

## Disk rule (IMPORTANT)
`/tmp` is a small tmpfs with a per-user quota that was already exhausted once. Put ALL large files (test payloads, received copies, cdx binaries, wrangler persist dirs, logs) under your own `/home/yvm/code/cd-aw-<agent>/work/`, NOT /tmp. Launch the emulator with `ANDROID_TMP=/home/yvm/code/cd-aw-<agent>/work/emu-tmp` so its qcow2 overlays don't land in /tmp. Delete multi-hundred-MB payloads when done.
