# Android sender implementation notes

Working copy: /home/yvm/code/cd-aw-send/android. Main /home/yvm/code/cd is read-only. Never deploy. Own emulator 5556 and relay 8788 only. Physical phone and other emulators belong to other agents.

## Implementation and integration

Call `Senders.install(applicationContext)` in MainActivity.onCreate before handling shared URIs or reading sender state. This installs SendEngineImpl into TransferBus.sender and restores saved transfers as paused. No service, worker, wake lock, manifest application change, or background restart.

Sender saves a streaming SHA-256 and app-private source snapshot, invitation master key, sender token, original URI(s), size, fixed expiry. Tries persistable URI permission. Multiple files become a saved ZIP. Reconnect uses fresh session nonce with original link, authenticates receiver proof and prefix SHA-256, and resumes at receiver's cumulative checkpoint. Only chunks use WebRTC, after draining relay ACKs. Relay window is 4 MiB, queue bound 8 MiB, below OkHttp's 16 MiB hard limit. Cipher/header storage and read buffers are reused. V2 has no short code directory; code=null.

## Changed files

New main files under app/src/main/java/in/yash0/cd/: Senders.kt, SendEngineImpl.kt, SendProtocol.kt, SenderStore.kt, SenderDirect.kt.
New test: app/src/test/java/in/yash0/cd/SendProtocolTest.kt.
New emulator-only driver: app/src/androidTest/java/in/yash0/cd/SendInstrumentation.kt and app/src/androidTest/AndroidManifest.xml. The latter is a new test-only manifest registering the custom instrumentation. No existing non-owned files edited, no edits to main repo.

## Verified results

32 unit tests pass; latest completed full assemble/test/lint log before final lifecycle adjustments: work/build-latest.log, BUILD SUCCESSFUL. Sender test compares Go fixture bytes and cross-opens reused cipher/full/partial chunk records with Kotlin receiver; malformed cumulative ACKs rejected.

256 MiB relay E2E completed before first restart. work/relay-e2e.log and relay-result.json. SHA-256 source and received file: 486cc817b95d853d3c357ff283b204c0144bd255e73fe2deb1389493b257e3c0. Sender rate 12,975,624 bytes/s, 12.98 decimal MB/s. Wall 21.305 seconds after link ready, 12.60 MB/s including CLI launch and hash validation. Received payload removed after hash check. No prior Android sender existed (SendEngine.Unavailable), so no honest pre-change throughput baseline.

## Latest adjustments, still need verification

Fixed cancellation race: catch in launch only publishes PAUSED while run scope is active, preventing Cancel being overwritten. Resume now synchronously publishes CONNECTING/PREPARING before launching coroutine, so restored PAUSED does not confuse instrumentation/UI. Added instrumentation action=controls: start tiny file, await WAITING, pause, immediate resume, await WAITING, cancel, wait 500ms, assert CANCELLED persisted and source removed. Last build work/build-final.log may have completed after interruption; check. Main APK is ~71 MiB; instrumentation ~13 KiB. Must install both after current build finishes before running any instrumentation. Avoid starting instrumentation during package replacement: Android can freeze the package and leave instrumentation launch stuck.

## Outstanding

1. Confirm latest build-final.log green; rebuild if latest source changes were not captured. Gradle command below.
2. Restart emulator and relay. Read-only emulator loses all app state after emulator termination, so install both APKs and copy source again. App force-stop within running emulator preserves it.
3. Run instrumentation action=controls, verify terminal cancellation. Fix if needed.
4. Run work/send_e2e.py relay-resume. It starts instrumented sender with direct=false, waits link, launches cdx receiver, force-stops app after >=16 MiB, restarts same sender id, relaunches receiver on same output, verifies hash. Check CLI resumedBytes > 0, final app COMPLETE.
5. Run work/send_e2e.py direct. Verify route DIRECT actually used and matching hash; report actual rate. Browser receiver optional.
6. Rerun checks if fixes were made. Final report with exact files, integration call, measurements, limitations. Stop owned emulator and wrangler, delete large payloads/overlays.

## Commands

Emulator: ANDROID_AVD_HOME=/home/yvm/.config/.android/avd ANDROID_TMP=/home/yvm/code/cd-aw-send/work/emu-tmp /home/yvm/Android/Sdk/emulator/emulator -avd wl35 -read-only -no-window -no-audio -no-snapshot -port 5556 > work/emulator.log 2>&1
Relay from /home/yvm/code/cd: npx wrangler dev --port 8788 --persist-to /home/yvm/code/cd-aw-send/work/wrangler > /home/yvm/code/cd-aw-send/work/wrangler.log 2>&1
Build in android: ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:lintDebug --max-workers=2 -Dorg.gradle.jvmargs='-Xmx1g -Dfile.encoding=UTF-8'
adb=/home/yvm/Android/Sdk/platform-tools/adb; always pass -s emulator-5556.
adb reverse tcp:8788 tcp:8788.
Install app/build/outputs/apk/debug/app-debug.apk and app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk sequentially with adb install -r, wait each success.
Source: work/payload.bin exists (256 MiB); push to /data/local/tmp/cd-send-payload.bin then adb shell run-as in.yash0.cd mkdir -p files, then run-as cp to files/payload.bin. Verify copied SHA-256.
Controls: adb shell am instrument -w -e action controls in.yash0.cd.test/in.yash0.cd.SendInstrumentation
E2E: python /home/yvm/code/cd-aw-send/work/send_e2e.py relay-resume > work/relay-resume-e2e.log 2>&1
Direct: python /home/yvm/code/cd-aw-send/work/send_e2e.py direct > work/direct-e2e.log 2>&1
Driver source: android/app/src/androidTest/java/in/yash0/cd/SendInstrumentation.kt. Standard args action=start/resume, id, source, base (default http://127.0.0.1:8788), direct=true/false. Writes files/send-test-status.json and files/send-test-id in app storage for adb run-as reads. CLI binary work/cdx-send built from main repo; env CD_RELAY_URL=ws://127.0.0.1:8788/ws/v1 and CD_PUBLIC_URL=http://127.0.0.1:8788.

## Environment caveats

Concurrent emulator/Gradle jobs create severe memory/swap pressure. Build may take minutes. Don't kill other agents' processes or emulators. Never use /tmp for large files/logs. T3 device_list/open on second run saw only emulator-5554 despite adb listing all; opening explicit emulator-5556 twice returned 'No device emulator-5556 on host local'. Use explicit adb serial for owned emulator when needed; never accidentally act on 5554.

## Current run update

Controls instrumentation PASSED on fresh emulator after updated APK installation: pause, immediate resume, cancel, retained cancellation and source cleanup. Exact output in work/bootstrap.log (INSTRUMENTATION_CODE: 0).

Important finding: stock `cmd/cdx/resume.go` receiveResumable and `src/resume-browser.js` do not negotiate WebRTC for v2. They ignore offer.direct, so enabling Android direct against them still uses relay. Android receiver does implement the direct v2 route. To measure actual Android sender direct on the laptop, a test receiver built from a private COPY of the Go protocol can negotiate SDP and use existing directPath code; do not change main repo. Report this distinction honestly. Standard cdx relay and resume tests remain required.

The follow-up checks-final.log attempt was stopped by a Gradle daemon stop command from outside this command; rerun final checks after E2E. Latest app APK includes both lifecycle fixes and controls test APK is installed. Current emulator and relay processes restarted and source hash matches.
