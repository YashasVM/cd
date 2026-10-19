# Android app handoff (2026-10-19)

Work-in-progress snapshot of the CD Android app rebuild, so it can continue on another machine. Paths in the notes and scripts (`/home/yvm/code/...`, emulator ports, `work/` dirs) refer to the original machine; adjust them.

## What's in this branch

- Everything that was uncommitted in the original checkout: the CLI resume/device/request work, worker rooms, website resume receiver, fixtures, docs, scripts.
- `android/`: the native app, with three parallel workstreams merged by file ownership:
  - **Redesign** (`ui/`, `MainActivity.kt`, `res/`): native mobile layout in the website's palette and fonts. Bottom tabs (Send · Receive · Transfers · Devices), collapsing top bars, transfer screen with QR/code and a speed dial. Debug builds inject fake data via a long-press on the "cd" mark or `adb shell am start -n in.yash0.cd/.MainActivity --es cd.debug all`.
  - **Send** (`Senders.kt`, `SendEngineImpl.kt`, `SendProtocol.kt`, `SenderStore.kt`, `SenderDirect.kt`): foreground phone→computer v2 resumable sending; no service. See `send-notes.md`.
  - **Receive/speed** (`ReceiverService.kt`, `ResumeReceiver.kt`, `Wire.kt`, `Protocol.kt`, `Store.kt`, `ReceiveViews.kt`, `ReceiverNetwork.kt`, network policy): progress published to `TransferBus`, less store churn, cipher reuse, hotspot LAN route. See `receive-notes.md`.
- `TransferBus.kt` is the UI ↔ transport contract.

## State

- `./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` passes on the merged tree. `go build ./...` and `go vet ./cmd/...` pass.
- The merged APK has **not** been run end to end. Each workstream was tested only in its own copy:
  - **Send:** 256 MiB relay send → `cdx receive` matched SHA-256 at about 13 MB/s on an emulator. Pause, resume and cancel instrumentation passed. Kill-and-resume and direct were not finished.
  - **Receive:** the optimisations have no emulator before/after numbers yet. The hotspot LAN fix is unverified on the phone.
  - **UI:** screenshots only, on fake data.

## Open work, in priority order

1. Install the merged APK and run real send and receive on the phone.
2. **Wake-on-demand receiving** (user requirement): no persistent "Ready to receive" notification. Show a notification only during a transfer, and wake via FCM high-priority push (existing optional path, needs the user's Firebase project via `scripts/setup-firebase.sh`). The UI side is stubbed in `ui/ReceiveModeStub.kt` (`// HOOK: backend`); `MainActivity.onStart/onStop` call `ReceiveMode.onForeground/onBackground`. Until then, trusted sends work while CD is open.
3. Finish the remaining verification steps in `receive-notes.md` and `send-notes.md`: kill-and-resume, direct route, before/after throughput.
4. `cdx receive` and the browser v2 receiver don't negotiate WebRTC for v2, so Android direct sends fall back to relay against them.
5. **Separate cdx bug:** `cdx send` dies with `wait for relay peer-joined: ... connection reset by peer` when an idle network drops the relay socket while waiting for a receiver. It needs a keepalive and reconnect during the wait. This was planned as a separate PR from `origin/main` (branch `fix/relay-wait-keepalive`, no commits yet).

`brief.md` is the original multi-agent brief (file ownership, test setup, definition of done).
