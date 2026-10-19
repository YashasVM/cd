# Backend receive running notes

Work copy: /home/yvm/code/cd-aw-recv/android. Never edit /home/yvm/code/cd or deploy.
Phone testing STOPPED by orchestrator. Phone unplugged. Do not run commands against RZCY81Q06XR. Three 256 MiB Downloads/CD payloads created during earlier testing were deleted before stopping. Leave installed app alone.

## Current implementation

Optimized sources restored in android/app/src/main/java/in/yash0/cd. Includes ReceiveViews.kt, ReceiverNetwork.kt and edits to ReceiverService.kt, ResumeReceiver.kt, Store.kt, Protocol.kt, Wire.kt, ReceiveGate.kt, NativeNetworkPolicy.kt, NativeNetworkDetector.kt. Tests: ReceiveViewsTest.kt and NativeNetworkPolicyTest.kt. Gradle memory/worker limits in gradle.properties.

ReceiveViews.load(context) is the startup hook for MainActivity.onCreate; ReceiverService already calls it. UI file not edited. Status.text is a TransferBus.status shim. Views report durable checkpoint bytes, EMA rate and route; notification/progress limited to about 4 Hz. Store progress stays in memory; durable metadata/state mutations still save. Records reuse Cipher/key and avoid copying ciphertext for decrypt. Checkpoint MAC, prefix validation, fsync-before-ack, 1 MiB durable batching and verify-before-publish remain.

Hotspot fix uses a matching noncellular Network socket factory for numeric private endpoints. Explicit API 35 LOCAL_NETWORK callbacks discover tethering networks. Older devices fall back to matching interface/source address. Public traffic still needs an allowed Internet-capable network and mobile opt-in. Final hotspot behavior NOT phone verified; test stopped before it was ready. NativeNetworkPolicy subnet tests added. Keep this limitation explicit.

Latest edits after final-build started: prevent paused tasks being revived by new connecting/verifying state transitions, check null state transition in ResumeReceiver, cancel disallowed control sockets on capability changes, rehydrate checkpoint progress into Store memory. Must run final build/tests/lint again after E2E.

## Verification so far

Original baseline assemble + unit tests + lint passed (work/cd-recv-baseline-build.log).
An intermediate optimized assemble + unit tests + lint passed (work/optimized-build.log), BEFORE latest network/state changes.
Stock original receiver x86_64 APK saved as work/stock-baseline-x86.apk. It is built from original source backup, NOT optimized. Original files are backed up at work/cd-recv-original/cd. Optimized sources also backed up at work/optimized-src, but this backup predates latest edits: DO NOT restore that backup over current sources.

No completed emulator pairing or emulator throughput measurements yet. Earlier emulator attempts were killed by app restarts. Device-control CLI unavailable; use adb/uiautomator. Do not run concurrent uiautomator dumps (causes already-registered accessibility service error).

Earlier phone data, not an emulator baseline: network-only relay test SHA256 matched 256 MiB source. Data phase 14.943 s, end-to-end 20.318 s. Attempted LAN selected relay (not valid LAN number). Attempted WebRTC fell back to relay. Host memory/swap pressure made later timings much slower. No final phone after numbers.

## Commands/artifacts

Use emulator 5554 only. ANDROID_AVD_HOME=/home/yvm/.config/.android/avd ANDROID_TMP=/home/yvm/code/cd-aw-recv/work/emu-tmp. Existing AVD wl35. Prefer -memory 1024 -cores 2 during restart to reduce host load.
Local wrangler port 8787, persist at work/wrangler. Launch from READ-ONLY source repo with npx wrangler dev; do not deploy. adb reverse tcp:8787 tcp:8787.
CLI work/cdx-recv built from /home/yvm/code/cd. 256 MiB random payload work/cd-recv-256.bin, SHA256 d29f493268dfc61f657f661a672866ef788b482c3c5b1841a8df6512b80bd633. Delete payload and received large copies when finished.
work/emu-env.sh defines isolated CLI dirs and local URLs. Pair: source work/emu-env.sh; work/cdx-recv pair --name recv-emu --listen 0.0.0.0:53318 --advertise-host 10.0.2.2 --json > work/emu-pair.jsonl 2>work/emu-pair.err. If previous CLI configuration already saved a pair, use a new name or remove only the isolated test pair config after stopping CLI.
work/open-pair.py delivers the cdpair link without printing credential. work/ui.py dumps UI and can tap exact text e.g. python3 work/ui.py 'Trust device', then 'Allow'. work/measure.py <unique-label> relay|lan|direct sends targeted 256 MiB and verifies published SHA-256. It logs route events and timings. work/e2e.py holds the helper environment. These scripts use emulator-5554.
Unpaired link send needs --resumable, NOT --resume (which requires a transfer ID). Open local http v2 link using explicit activity: adb shell am start -a android.intent.action.VIEW -n in.yash0.cd/.MainActivity -d <link>, then tap Receive file.

## Remaining work

1. Restart local emulator + wrangler; install stock-baseline-x86.apk, pair and enable notifications. Complete 256 MiB relay/LAN/direct baseline checks; only claim actual route from CLI AND receiver logs.
2. Build/install current optimized x86 APK. Repeat measurements with matched source. Keep host-load caveat if timings differ wildly.
3. Test pasted v2 link; SHA256 published download.
4. Kill app mid-transfer (am force-stop), read checkpoint offset using run-as, require >0; reopen app and rerun same targeted send if sender exits. Receiver diagnostic checkpoint-verified-offset=<bytes> proves resumed offset. Verify final SHA256.
5. Final unit tests + lint green. Remove debug instrumentation (rg DEBUG), diff file ownership, write final report with exact changed files, missing verification, numbers. Kill ONLY emulator5554 and own wrangler. Delete large payloads.
