# Android platform research for the CD Android app

Research-only deliverable for the Android worker (see `docs/implementation/android-contract.md`).
Everything below is either **verified on this machine** (command + observed output recorded) or
**doc-verified** against current official Android/Samsung/Firebase documentation (link given).
Where a claim could not be tested locally it is marked as such instead of asserted.

Verified on 2026-10-18 on the CD development host. This file is the only file changed by this
task; `android/**` was read but not modified, and no SDK, emulator, or system configuration was
changed.

---

## 1. Launcher paths (the headline result)

The Android SDK **is** installed and usable. It is **not** on `PATH` and **no Android env var is
set** in a fresh shell, so every command must use absolute paths or an explicit export.

| Thing | Exact path | Version (observed) |
| --- | --- | --- |
| Android SDK root | `/home/yvm/Android/Sdk` | — |
| adb | `/home/yvm/Android/Sdk/platform-tools/adb` | 1.0.41, `Version 37.0.1-15733141` |
| emulator | `/home/yvm/Android/Sdk/emulator/emulator` | `37.1.11.0 (build_id 15917651)` |
| sdkmanager / avdmanager | `/home/yvm/Android/Sdk/cmdline-tools/latest/bin/` | sdkmanager `19.0` |
| build-tools | `/home/yvm/Android/Sdk/build-tools/` | 34.0.0, 35.0.0, 36.0.0, 37.0.0 |
| platforms | `/home/yvm/Android/Sdk/platforms/` | android-34, 35, 36.1, 37.0, 37.1 |
| system image | `/home/yvm/Android/Sdk/system-images/android-35/google_apis/x86_64` | rev 9, `abi x86_64`, `translatedAbis arm64-v8a` |
| NDK | `/home/yvm/Android/Sdk/ndk/` | 27.0.12077973, 27.1.12297006 |
| cmake | `/home/yvm/Android/Sdk/cmake/3.22.1` | 3.22.1 |
| SDK licenses | `/home/yvm/Android/Sdk/licenses/` | `android-sdk-license` etc. already accepted |
| Java | mise shim on `PATH` → `/home/yvm/.local/share/mise/installs/java/temurin-17` | Temurin `17.0.20.1+1` |
| Gradle wrapper dists | `/home/yvm/.gradle/wrapper/dists/` | 8.6, 8.7, 8.9, 8.13, 9.4.1, 9.5.0 (all extracted) |
| AVD home (non-default) | `/home/yvm/.config/.android/avd` | see §2 |

Evidence (excerpts):

```
$ /home/yvm/Android/Sdk/platform-tools/adb version
Android Debug Bridge version 1.0.41
Version 37.0.1-15733141
Installed as /home/yvm/Android/Sdk/platform-tools/adb

$ JAVA_HOME=/home/yvm/.local/share/mise/installs/java/temurin-17 \
    /home/yvm/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --list_installed
  build-tools;35.0.0                          | 35.0.0        | ... | build-tools/35.0.0
  emulator                                    | 37.1.11       | ... | emulator
  ndk;27.1.12297006                           | 27.1.12297006 | ... | ndk/27.1.12297006
  platform-tools                              | 37.0.1        | ... | platform-tools
  platforms;android-35                        | 2             | ... | platforms/android-35
  system-images;android-35;google_apis;x86_64 | 9             | ... | system-images/android-35/google_apis/x86_64
```

### Gotchas that will otherwise cost time

1. **`ANDROID_HOME`/`ANDROID_SDK_ROOT` are unset, and there is no `local.properties`.**
   `env | grep -i android` returns nothing; `/home/yvm/code/cd/android/local.properties` does not
   exist (`android/.gitignore` ignores it). Builds therefore need
   `ANDROID_HOME=/home/yvm/Android/Sdk`. Confirmed empirically: the Gradle daemon log for the
   existing `android/` build records `ANDROID_HOME` in the configured build environment
   (`~/.gradle/daemon/8.13/daemon-897848.out.log`, entry `2026-10-18T17:52:51.332+0530`), while
   the same log from earlier runs has no `ANDROID_HOME`.
2. **`JAVA_HOME` is empty in a fresh shell.** `java` resolves through a mise `PATH` shim. Gradle
   finds Java via `JAVA_HOME` first, then `PATH`; setting `JAVA_HOME` explicitly is safer.
3. **`adb`, `emulator`, `sdkmanager`, `avdmanager`, `gradle`, `kotlinc` are not on `PATH`.**
   There is no system `gradle` and no standalone `kotlinc`; use `./gradlew` only.
4. **The AVD home is not `~/.android/avd`.** `XDG_CONFIG_HOME=/home/yvm/.config`, so the AVDs live
   in `/home/yvm/.config/.android/avd`. Consequence, verified:

   ```
   $ /home/yvm/Android/Sdk/emulator/emulator -list-avds
   (empty)
   $ ANDROID_AVD_HOME=/home/yvm/.config/.android/avd /home/yvm/Android/Sdk/emulator/emulator -list-avds
   ghw_demo
   openstream-api35
   wl35
   ```

   `avdmanager list avd` finds all three without the variable; the `emulator` binary does not.
   Set `ANDROID_AVD_HOME` (or `HOME=/home/yvm/.config`) for any direct `emulator` invocation.
5. **A second, older SDK exists at `/home/yvm/.local/share/android-sdk`** (build-tools 30.0.3/34.0.0/
   35.0.0; platforms android-32/35). Do not point builds at it; use `/home/yvm/Android/Sdk`.
6. **`ndk/27.0.12077973` is incomplete.**
   `ndk/27.0.12077973` has no `source.properties`; AGP logs
   `[CXX1101] NDK at /home/yvm/Android/Sdk/ndk/27.0.12077973 did not have a source.properties file`.
   `sdkmanager --list_installed` only lists `ndk;27.1.12297006`. If a native `ndkVersion` is ever
   needed, pin `27.1.12297006`.
7. **The machine is memory-tight and a Gradle daemon is already running.** `free -h` showed
   15 GiB total / ~1.4 GiB available with 13 GiB of swap in use, and 12 cores. Building with a
   second concurrent Gradle daemon (e.g. from the Android worker) will contend on the same daemon
   and on memory; serialize builds.

---

## 2. Emulators and devices

Three AVDs, all identical in shape (verified from `config.ini`):

| AVD | Config |
| --- | --- |
| `openstream-api35` | android-35 Google APIs x86_64, 1080×2400, 420 dpi, 2 GB RAM, data 10 G |
| `wl35` | same, data 6 G |
| `ghw_demo` | same, data 6 G |

`avdmanager list avd` reported all three `Based on: Android 15.0 ("VanillaIceCream") Tag/ABI: google_apis/x86_64`.

At the time of writing **`openstream-api35` was already booted** (started by the host's device
tooling, not by this task):

```
$ /home/yvm/Android/Sdk/platform-tools/adb devices -l
List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:2

$ ps -eo args | grep qemu
/home/yvm/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless -avd openstream-api35 -no-window -no-audio -no-snapshot -gpu swiftshader
```

```
$ adb shell getprop ro.build.version.sdk      -> 35
$ adb shell getprop ro.build.version.release  -> 15
$ adb shell getprop ro.product.cpu.abi        -> x86_64
$ adb shell getprop ro.product.manufacturer   -> Google
```

**Caveat:** these are `google_apis` (not `google_apis_playstore`) images. Google Play services are
not fully present, so **FCM cannot be tested on any of these AVDs** (see §7.5).

Boot a headless emulator for testing (do not run this concurrently with another agent's boot of the
same AVD):

```bash
export ANDROID_HOME=/home/yvm/Android/Sdk
export ANDROID_AVD_HOME=/home/yvm/.config/.android/avd
$ANDROID_HOME/emulator/emulator -avd openstream-api35 -no-window -no-audio -no-snapshot -gpu swiftshader &
$ANDROID_HOME/platform-tools/adb wait-for-device
$ANDROID_HOME/platform-tools/adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
```

Prefer the host's device tools (which already manage these AVDs) over a second manual boot.

---

## 3. Minimal, cache-backed build configuration

### 3.1 What is already cached (verified in `~/.gradle/caches/modules-2/files-2.1`)

Plugins / toolchain:

| Artifact | Cached versions |
| --- | --- |
| `com.android.tools.build:gradle` (AGP) | 8.5.0, 8.5.2, 8.7.3, 8.10.1, 9.2.1, 9.3.0 |
| `com.android.application` plugin marker | 8.5.2, 8.7.3, 8.10.1, 9.2.1, 9.3.0 |
| `org.jetbrains.kotlin:kotlin-gradle-plugin` | 2.0.21, 2.1.20, 2.2.0, 2.2.10, 2.2.21, 2.3.0, 2.3.21 |
| `org.jetbrains.kotlin.android` plugin marker | 1.9.24, 2.1.20, 2.3.0 |
| `org.jetbrains.kotlin.plugin.compose` marker + `compose-compiler-gradle-plugin` | 2.0.21, 2.1.20, 2.2.10, 2.3.0, 2.3.21 |
| `com.google.devtools.ksp` | 2.0.21-1.0.27 (only) |
| Gradle distributions (wrapper) | 8.6, 8.7, 8.9, 8.13, 9.4.1, 9.5.0 |
| `com.android.tools.build:aapt2` | 8.5.2-11315950, 8.7.3-12006047, 8.10.1-12782657, 9.2.1…, 9.3.0… |

App dependencies (the set already declared by the in-progress `android/` project):

| Coordinate | Cached versions | Artifact present? |
| --- | --- | --- |
| `androidx.compose:compose-bom` | 2024.09.03, 2024.10.01, **2025.01.01**, 2026.06.00, 2026.06.01 | POM readable |
| `androidx.compose.ui:ui(-android)` | 1.7.0…1.7.7, 1.9.0, 1.9.3, 1.10.6, 1.11.3, 1.11.4 | AAR ok (1.7.7, 1.11.4) |
| `androidx.compose.foundation:foundation(-android)` | 1.7.x, 1.9.3, 1.11.4 | AAR ok |
| `androidx.compose.runtime:runtime(-android)` | 1.7.x, 1.9.x, 1.10.6, 1.11.4 | AAR ok |
| `androidx.compose.material3:material3(-android)` | 1.3.0, **1.3.1**, 1.4.0, 1.5.0-alpha08/17 | AAR ok |
| `androidx.compose.ui:ui-tooling`, `ui-tooling-preview` | 1.7.7, 1.9.3, 1.11.3 | **metadata only, no AAR** |
| `androidx.activity:activity-compose` | 1.8.2, 1.9.0–1.9.3, **1.10.0**, 1.13.0 | AAR ok |
| `androidx.core:core-ktx` | 1.13.0–1.18.0 | AAR ok |
| `com.squareup.okhttp3:okhttp` | 4.9.2, **4.12.0**, 5.4.0 | JAR ok |
| `com.journeyapps:zxing-android-embedded` | 4.3.0 (+ `com.google.zxing:core` 3.4.1) | AAR ok |
| `androidx.lifecycle:lifecycle-service` | 2.8.6, 2.8.7, 2.9.4, 2.10.0 | — |
| `androidx.lifecycle:lifecycle-runtime-ktx` | 2.8.x, 2.9.x, 2.10.0, 2.11.0 | metadata only at each version |
| `androidx.security:security-crypto` | 1.1.0-alpha06 | — |
| `androidx.datastore:datastore-preferences` | 1.0.0, 1.1.1, 1.1.7 | — |
| `androidx.work:work-runtime-ktx` | 2.7.1, 2.9.1, 2.10.0 | — |
| `com.google.firebase:firebase-messaging` | 25.0.1 | library only |
| `com.google.gms:google-services` plugin | **absent** | — |
| `junit:junit` | 4.13.2 | JAR ok |
| `org.json:json` | 20240303 | JAR ok |
| `org.jetbrains.kotlin:kotlin-stdlib` | 2.0.20…2.4.0 | — |

Gradle's dependency metadata store is populated (`~/.gradle/caches/modules-2/metadata-2.106`,
`metadata-2.107`, 4.9 MB + 17 MB of descriptors), so `--offline` resolution works for what is
cached.

Compose BOM → version mapping, read directly from the cached POMs:

- `compose-bom:2025.01.01` → `ui`/`foundation`/`runtime`/`animation`/`material-icons-extended`
  `1.7.7`, `material3 1.3.1`, `ui-tooling(-preview) 1.7.7`
- `compose-bom:2026.06.01` → `ui`/`foundation`/`runtime` `1.11.4`, `material3 1.4.0`

### 3.2 Recommended minimal versions (all cached)

**Primary recommendation — identical to the combination the existing `android/` project already
uses, so the two do not diverge:**

```kotlin
// android/build.gradle.kts
plugins {
    id("com.android.application") version "8.10.1" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}
```

- `gradle/wrapper/gradle-wrapper.properties` → `gradle-8.13-bin.zip` (dist already extracted)
- `compileSdk = 35`, `targetSdk = 35`, `minSdk = 29`, `buildToolsVersion` default,
  Java 17 source/target
- `platform("androidx.compose:compose-bom:2025.01.01")` + `material3`, `foundation`, `ui`,
  `ui-graphics`, `ui-text`; `activity-compose:1.10.0`; `core-ktx:1.15.0`; `okhttp:4.12.0`
- `testImplementation("junit:junit:4.13.2")`, `testImplementation("org.json:json:20240303")`
- `sourceSets["test"].resources.srcDir("../../fixtures")` (matches the contract's shared fixtures)

Why: AGP 8.10.1 requires Gradle ≥ 8.11.1, and 8.13 is present; Kotlin 2.1.20 + the matching
`plugin.compose` 2.1.20 provide the Compose compiler without a separate
`androidx.compose.compiler` dependency; compileSdk 35 matches the only installed system image.

Both version facts were read out of the cached plugin jars rather than assumed:

```
$ unzip -p <...>/com.android.tools.build/gradle/8.10.1/gradle-8.10.1.jar \
    com/android/build/gradle/internal/plugins/VersionCheckPlugin.class | strings -a | grep -E '^[0-9.]+$'
8.11.1                                    # AGP 8.10.1 minimum Gradle version

$ unzip -p <...>/com.android.tools.build/builder/8.10.1/builder-8.10.1.jar \
    com/android/builder/core/ToolsRevisionUtils.class | strings -a | grep -E '^[0-9.]+$'
35.0.0                                    # AGP 8.10.1 default build-tools revision (installed & cached)
```

**More conservative alternative, also fully cached** (used by another local project at
`/home/yvm/code/OpenStream/android`): AGP `8.7.3` + Kotlin `2.0.21` + Gradle `8.9`. Use this only if
AGP 8.10.1 misbehaves; note KSP is only cached for Kotlin `2.0.21`, so if annotation processing is
ever added, this is the combination that can run offline.

**Do not** target compileSdk 36/37 casually: `platforms/android-36.1`, `37.0`, `37.1` are installed
for compilation, but the only system image is android-35, so you cannot run or test a 36/37 device
without installing a new image (an SDK change this task was told not to make).

### 3.3 Offline completeness — honest status

- **Network is available.** Verified: `dl.google.com:443`, `repo1.maven.org:443`,
  `services.gradle.org:443` all accept TCP, and
  `curl -o /dev/null -w '%{http_code}' https://dl.google.com/dl/android/maven2/androidx/compose/compose-bom/2025.01.01/compose-bom-2025.01.01.pom` → `200`.
- **Offline is *mostly* covered but not proven complete.** A Compose app built from the
  coordinates in §3.2 resolves from the cache, but several modules are metadata-only
  (`ui-tooling-android`, `ui-tooling-preview-android` 1.7.7, `lifecycle-runtime-ktx` at every
  cached version). Avoid `debugImplementation("androidx.compose.ui:ui-tooling")` if you want a
  strictly offline debug build, or simply allow the network.
- No `--offline` build was executed by this task: a Gradle daemon for `android/` was live and
  writing to the shared cache, and this task must not modify `android/**`. **This is the one
  claim left unproven here — the Android worker should run the first real
  `./gradlew assembleDebug` and record the result.**

### 3.4 Exact build commands

```bash
export ANDROID_HOME=/home/yvm/Android/Sdk
export JAVA_HOME=/home/yvm/.local/share/mise/installs/java/temurin-17
cd /home/yvm/code/cd/android
./gradlew --no-daemon :app:assembleDebug        # add --offline to prove cache-only
./gradlew :app:testDebugUnitTest               # shared fixture tests
```

---

## 4. `connectedDevice` foreground service and network interaction

Source: <https://developer.android.com/develop/background-work/services/fgs/service-types>,
<https://developer.android.com/develop/background-work/services/fgs/launch>,
<https://developer.android.com/develop/background-work/services/fgs/declare>,
<https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start>,
<https://developer.android.com/develop/background-work/services/fgs/changes>.

Verified requirements for the CD transfer service:

- Manifest: `android:foregroundServiceType="connectedDevice"` on the `<service>`, plus
  `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_CONNECTED_DEVICE` permissions. Since Android 14,
  a missing type throws `MissingForegroundServiceTypeException` and a missing type-specific
  permission throws `SecurityException` when promoting the service.
- `connectedDevice` has **no runtime permission** prerequisite if you declare one of
  `CHANGE_NETWORK_STATE`, `CHANGE_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `NFC`, or
  `TRANSMIT_IR`. Recommended: `CHANGE_WIFI_MULTICAST_STATE` (needed for mDNS multicast lock anyway)
  plus `CHANGE_NETWORK_STATE`. All are install-time **normal** permissions, so there is no
  runtime prompt, and therefore **no while-in-use trap** — the Android 14 rule that blocks
  creating `camera`/`location`/`microphone` services from the background does not apply here.
- Promote with `ServiceCompat.startForeground(service, id, notification, FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)`
  from `onStartCommand`; `Service.onCreate` alone is not enough (Android 12+ requires a prompt
  `startForeground`).
- **Android 15+ timeouts do not apply to `connectedDevice`.** The 6-hours-in-24 limit introduced in
  Android 15 covers `dataSync` and `mediaProcessing` only. `connectedDevice` can run indefinitely.
  However **Android 16** adds: "Background jobs started from a foreground service now must adhere
  to their respective runtime quotas", so do not rely on long-running `JobScheduler`/`WorkManager`
  work spawned from the service — keep the socket loop inside the service itself.
- **Network reachability vs. Doze.** A foreground service keeps the app out of App Standby
  ("the app has a process currently in the foreground… as a foreground service" —
  <https://developer.android.com/training/monitoring-device-state/doze-standby>). It does **not**
  disable device-wide Doze, which "suspends network access", ignores wake locks and defers jobs
  while the device is unplugged, stationary, and screen-off. Practical consequence for CD: a
  long transfer that starts while the phone is idle can stall. Mitigations, in order:
  1. the user is normally holding the phone during a transfer (screen on ⇒ no Doze);
  2. acquire a `WifiManager.WifiLock`/`MulticastLock` for the LAN socket;
  3. only if the core function is blocked, offer `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
     (Google Play prohibits requesting this unless the core function is adversely affected).
     Battery optimization exemption is also one of the documented exemptions for starting a
     foreground service from the background.

Test for Doze behaviour (`dumpsys deviceidle force-idle` / `unforce` / `battery reset`) is listed
in §6.

---

## 5. Notification and Stop

Sources: <https://developer.android.com/develop/background-work/services/fgs/stop-fgs>,
<https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping>,
<https://developer.android.com/about/versions/14/behavior-changes-all>,
<https://developer.android.com/develop/ui/views/notifications/notification-permission>.

- An FGS **must** post a notification. `POST_NOTIFICATIONS` is **not** required to launch the
  service, but it is required for the notification to be visible on Android 13+, so request it
  (and handle denial — the transfer must still work, just with a hidden notification).
- **Android 14 changed `setOngoing(true)`.** "Android 14 has changed the behavior to allow users to
  dismiss such notifications." Still non-dismissible when the phone is locked and when the user
  picks "Clear all"; `CallStyle`, media, and DPC notifications are exempt from the change.
  ⇒ **Do not treat the sticky notification as the Stop control.** Dismissal does not communicate
  intent to the app.
- **Task Manager Stop (Android 13+) is a hard kill.** When the user taps Stop next to the app:
  the whole app is removed from memory, the activity back stack is cleared, and the FGS
  notification is removed. "The system doesn't send your app any callbacks." On next start, check
  `ApplicationExitInfo` with `REASON_USER_REQUESTED` to distinguish this from a crash.
  Test with `adb shell cmd activity stop-app in.yash0.cd`.
- Programme-level `stopForeground(int)` removes the service from the foreground while it keeps
  running; `stopSelf()`/`stopService()` ends it and removes the notification.
- **Design for CD (matches the contract's Pause/Stop distinction):**
  - Notification channel `IMPORTANCE_LOW`; progress via `setProgress`, `setOnlyAlertOnce(true)`,
    `setOngoing(true)`, and `setForegroundServiceBehavior(FOREGROUND_SERVICE_IMMEDIATE)`.
  - Put an explicit **Stop** action on the notification as a `PendingIntent` with
    `getService(...)` and a distinct action string. In `onStartCommand`, `Stop` must do the
    durable checkpoint, then `stopForeground(STOP_FOREGROUND_REMOVE)` and `stopSelf()`, and must
    cancel all automatic retries (contract §"Existing resumable file data": reuse of
    sequence/key pairs is forbidden; retries stop after explicit Pause or Stop).
  - **Pause** is a separate action that keeps staging data and the notification, and only closes
    the socket — it must not be conflated with Stop or with Cancel/discard.
  - Because the Task Manager can kill the app without a callback, the durable checkpoint before
    ACK is what makes resume safe after an unannounced death.

---

## 6. Samsung Galaxy S24 Ultra / One UI background limits

Sources: <https://developer.samsung.com/mobile/app-management.html> (Samsung Developer,
"Samsung Application Management") and
<https://www.samsung.com/us/support/answer/ANS10003442/> ("Sleeping apps on your Galaxy device").

Doc-verified behaviour:

- **Sleeping apps**: "Background applications that have not been used for about 3 days and causing
  poor system health … will go into the sleeping mode. A bucket restriction applies … and features
  such as Job, Alarm, and Foreground-service are restricted."
- **Deep sleeping apps**: "Applications that have not been used for a long period of time
  (currently set to 16 days, but subject to change …) will go into the deep sleeping mode. …
  Inactive applications can't perform any activities, including notifications or updates."
- User-facing controls (Samsung support page): *Settings → Battery and device care → Battery →
  Background usage limits* with **Put unused apps to sleep** (auto), **Sleeping apps**,
  **Deep sleeping apps**, and **Never sleeping apps**.
- **The decisive mitigation, straight from Samsung's developer documentation:** in the section
  "Changes in One UI 6 (with Android 14)" Samsung states that because of their unified policy with
  Google, "Since One UI 6.0, foreground services of apps targeting Android 14 will be guaranteed
  to work as intended so long as they are developed according to Android's new foreground service
  API policy."
  ⇒ **Targeting SDK 34+ with a correctly declared `connectedDevice` FGS is the single most
  important Samsung mitigation.** The S24 Ultra ships One UI 6.1 and later, so it is covered.
- Samsung exposes a deeplink to the "Never sleeping apps" list, useful for onboarding copy:
  ```kotlin
  Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY").apply {
      setPackage("com.samsung.android.lool")
      putExtra("activity_type", 2) // 0 sleeping / 1 deep sleeping / 2 never sleeping
  }
  ```
- Beyond the app-sleep lists, Samsung (like AOSP) also lets the user set *Battery → Restricted* per
  app, which limits background work. Guidance text in the app should name both places.

**Not verifiable locally.** The three AVDs are Google `google_apis` images
(`ro.product.manufacturer = Google`); there is no Samsung target on this host. Everything in this
section is documentation-based, not device-observed. Treat a physical S24 Ultra check (FGS survives
screen-off and a multi-minute idle) as a required manual test before declaring Done.

---

## 7. NSD, local network permission, FCM, and file storage

### 7.1 NSD (`_cdx._tcp`)

Sources: <https://developer.android.com/develop/connectivity/wifi/use-nsd>,
<https://developer.android.com/privacy-and-security/local-network-permission>.

- Use `NsdManager` with service type `_cdx._tcp`, TXT records `pairId=<id>` and `version=1`, and
  `setPort()` from a socket bound to port 0 (never hardcode the port). **The framework's TXT
  support is limited to string values** — keep TXT strictly to `pairId`/`version`, which also
  matches the contract's "no file paths, transfer keys, or pair master secrets in mDNS".
- Acquire a `WifiManager.MulticastLock` before discovering/registering, otherwise multicast is
  dropped on many devices, and declare `CHANGE_WIFI_MULTICAST_STATE` (which doubles as a
  `connectedDevice` FGS prerequisite).
- Resolving a `.local` name requires local network permission on the new model (§7.2), so prefer
  connecting to the IP address returned by `resolveService`.
- Emulator caveat: the AVD is behind emulator NAT, so a host-side CLI mDNS advert is not reachable
  from the guest in the normal direction. For tests use the guest→host loopback alias `10.0.2.2`,
  or `adb reverse tcp:<port> tcp:<port>`; the contract already permits explicit localhost for
  tests/emulator forwarding.

### 7.2 Local network permission (Android 16 opt-in, Android 17 mandatory)

From the LNP page and Android 16 behaviour changes:

| Aspect | Android 16 (target 36) | Android 17 (target ≥ 37) |
| --- | --- | --- |
| Status | Opt-in (`RESTRICT_LOCAL_NETWORK` compat flag) | Mandatory, enforced |
| Permission | temporarily `NEARBY_WIFI_DEVICES` | `ACCESS_LOCAL_NETWORK` (NEARBY_DEVICES group) |
| Default | open | blocked by default |

- Scope per the table on the LNP page: outgoing/incoming TCP, and incoming/outgoing UDP unicast,
  multicast and broadcast all require permission. "These restrictions are implemented deep in the
  networking stack, and thus they apply to all networking APIs. This includes sockets created in
  native or managed code, networking libraries like Cronet and **OkHttp**". `.local` resolution also
  requires it. DNS to a LAN server on port 53 is exempt.
- Two sanctioned paths for targeting SDK 37+:
  - **Path A (recommended, no broad permission):** system-run NSD picker —
    `DiscoveryRequest.Builder("_cdx._tcp").setFlags(DiscoveryRequest.FLAG_SHOW_PICKER)` with
    `NsdManager.registerServiceInfoCallback`; addresses obtained this way are connectable without
    `ACCESS_LOCAL_NETWORK`.
  - **Path B:** declare `ACCESS_LOCAL_NETWORK` in the manifest and request it at runtime; the
    platform also implements a denial-counter reset strategy to allow re-asking with rationale.
- Errors when blocked surface on the socket: `sendto failed: EPERM (Operation not permitted)` or
  `ECONNABORTED`.
- **Actionable for CD now:** with `targetSdk = 35` (recommended in §3.2) the existing `INTERNET`
  permission grants local network access implicitly ("If your app targets SDK 36 or lower, local
  network access is implicitly granted using the INTERNET permission"), and you must **not**
  declare or request `ACCESS_LOCAL_NETWORK`. Structure the discovery/connect layer behind an
  interface so that Path A can be swapped in when the target SDK is eventually raised, and do not
  opt in to `RESTRICT_LOCAL_NETWORK` during development.

### 7.3 FCM high-priority wake — what it can and cannot do

Sources: <https://firebase.google.com/docs/cloud-messaging/android/message-priority>,
<https://developer.android.com/training/monitoring-device-state/doze-standby>,
<https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start>.

- High priority "allow[s] FCM to wake a sleeping device when necessary and to run some limited
  processing (including **very limited** network access)". Normal priority is deferred while the
  device is in Doze.
- `onMessageReceived` runs on a worker thread with "**several seconds**" to process the payload,
  only enough to render a notification; the docs explicitly say not to make additional network
  calls there. For extra work, schedule an **expedited** WorkManager job (high-priority FCM
  processing is exempt from the expedited-job quota for a brief window), or a normal `WorkRequest`
  for normal-priority messages.
- **Deprioritisation:** "If FCM detects a pattern in which messages don't result in user-facing
  notifications, your messages may be deprioritized to normal priority", assessed over 7 days per
  app instance. High-priority notification messages that meet criteria are instead **proxied** by
  Google Play services. Therefore a high-priority push used purely as a silent "wake up and open a
  socket" tickle is exactly the anti-pattern that gets downgraded.
- Starting an FGS from a high-priority FCM is a documented **exemption** from the Android 12+
  background-start restriction — **but**: "The system can downgrade the high priority messages to
  normal priority… If the message's priority is downgraded, your app cannot start a foreground
  service and attempting to start one results in a `ForegroundServiceStartNotAllowedException`."
  The documented guard is to check `RemoteMessage.getPriority() == PRIORITY_HIGH` before trying.
- **Therefore, for CD:** FCM can only ever be an optional *nudge* to open the FGS; it can never
  carry file data or the control channel, and its wake is not guaranteed. The primary design must
  remain the relay WebSocket plus a `connectedDevice` FGS covering the actual transfer, with FCM
  (if adopted later) used only for "a peer is offering you a transfer" and always rendering a
  user-visible notification.
- **Cost/complexity note, verified locally:** `firebase-messaging:25.0.1` is in the Gradle cache, but
  the `com.google.gms:google-services` plugin is **not**, and adding FCM requires a Firebase
  project and `google-services.json` (plus server-side Admin SDK credentials). The `google_apis`
  emulators cannot run FCM at all. Recommendation: **do not add FCM in the first iteration.**

### 7.4 Android v2 resume — safe file storage

Sources: <https://developer.android.com/training/data-storage/shared/media>,
<https://developer.android.com/training/data-storage/shared/documents-files>.

- Do not write to `/sdcard/...` paths. Under scoped storage (API 29+, and CD targets 29+), those
  writes fail.
- **Staging:** keep in-progress bytes in app-private internal storage
  (`context.filesDir` / `noBackupFilesDir`), keyed by `transferId`, so a partial file is private,
  never visible to other apps, and survives process death. Persist the durable checkpoint (offset,
  prefix hash, session nonce binding) before sending each ACK — that is what makes recovery after
  an unannounced kill (Task Manager Stop, OOM, process death) correct.
- **Publish into `Downloads/CD` with `MediaStore.Downloads` and `IS_PENDING`.** The documented
  pattern is exactly a publish-last middleware:
  ```kotlin
  val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, filename)
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CD")
      put(MediaStore.Downloads.IS_PENDING, 1)
  }
  val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
  resolver.openOutputStream(uri)!!.use { /* stream staged bytes, hash as you go */ }
  values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
  resolver.update(uri, values, null, null)   // only after size + SHA256 verified
  ```
  "Only your app can view the file until your app changes the value of `IS_PENDING` back to 0."
  Because the app owns the entry, no storage runtime permission is required on API 29+; keep
  `WRITE_EXTERNAL_STORAGE` with `android:maxSdkVersion="29"` only for legacy devices.
- After flipping `IS_PENDING` to 0, delete the staging file. Verify exact byte count and final
  SHA-256 **before** publish, as the contract requires, so a truncated file is never un-hidden.
- **Alternative / complement (good for "save somewhere specific"):** Storage Access Framework
  `ACTION_CREATE_DOCUMENT` (or `ACTION_OPEN_DOCUMENT_TREE` for a folder), which needs no
  permission, is user-controlled, and produces a durable document URI. If the product wants the
  user to choose the destination, this is the cleaner primitive; if the product wants a fixed
  `Downloads/CD` location, `MediaStore.Downloads` is the right one.
- Accessing a *Download* entry the app did not create requires SAF — another reason to publish
  under the app's own `Downloads/CD` path.

### 7.5 Test-matrix reality check

| Capability | Testable on this host today |
| --- | --- |
| Build/install/run on API 35 | Yes (`openstream-api35`, `wl35`, `ghw_demo`) |
| FGS + notification + Stop + Task Manager Stop | Yes (API 35 AVD, ActivityManager commands below) |
| Doze/stall behaviour | Partially — `dumpsys deviceidle force-idle` works, but GNSS/network realism is limited |
| mDNS between emulator and host CLI | Only via `10.0.2.2` / `adb reverse` |
| Samsung One UI sleeping limits | **No** — no Samsung device/image |
| FCM high-priority wake | **No** — `google_apis` images, no Play services, no Firebase project |
| Android 16/17 local network permission | **No** — only the android-35 system image is installed |

---

## 8. Practical test commands (copy-paste)

```bash
export ANDROID_HOME=/home/yvm/Android/Sdk
export ANDROID_AVD_HOME=/home/yvm/.config/.android/avd
ADB=$ANDROID_HOME/platform-tools/adb
PKG=in.yash0.cd

# device / AVD
$ADB devices -l
$ANDROID_HOME/emulator/emulator -list-avds
$ANDROID_HOME/emulator/emulator -avd openstream-api35 -no-window -no-audio -no-snapshot -gpu swiftshader &

# build + install
cd /home/yvm/code/cd/android
JAVA_HOME=/home/yvm/.local/share/mise/installs/java/temurin-17 ./gradlew :app:assembleDebug
$ADB install -r app/build/outputs/apk/debug/app-debug.apk

# run + logs
$ADB shell am start -n $PKG/.MainActivity
$ADB logcat -c
$ADB logcat --pid=$($ADB shell pidof -s $PKG) AndroidRuntime:E ActivityManager:I CD:V '*:S'

# foreground service / notification / Stop
$ADB shell dumpsys activity services $PKG
$ADB shell dumpsys notification --noredact | grep -A 20 $PKG
$ADB shell cmd activity stop-app $PKG          # simulates Task Manager Stop (whole app killed)

# battery / Doze, and exemption state
$ADB shell dumpsys deviceidle whitelist | grep $PKG
$ADB shell dumpsys deviceidle force-idle && $ADB shell dumpsys deviceidle unforce
$ADB shell dumpsys battery reset

# local-network test wiring (emulator guest -> host)
$ADB reverse tcp:7331 tcp:7331
$ADB shell am start -a android.intent.action.VIEW -d 'cdpair://v1#<payload>'   # pairing QR deep link

# local network permission compat toggles (only relevant if the target SDK is raised)
$ADB shell am compat enable  RESTRICT_LOCAL_NETWORK $PKG
$ADB shell am compat disable RESTRICT_LOCAL_NETWORK $PKG

# FGS data-sync timeout testing (not applicable to connectedDevice, listed for completeness)
$ADB shell am compat enable FGS_INTRODUCE_TIME_LIMITS $PKG
$ADB shell am compat enable FGS_BOOT_COMPLETED_RESTRICTIONS $PKG
```

The host's own device tooling (T3 `device_list` / `device_screenshot` etc.) already knows about
`openstream-api35`, `wl35`, `ghw_demo`; prefer it for boot/shutdown so two owners do not fight over
the same AVD.

---

## 9. Summary of recommendations to the Android worker

1. `ANDROID_HOME=/home/yvm/Android/Sdk` and `JAVA_HOME=…/temurin-17` on every build command;
   `ANDROID_AVD_HOME=/home/yvm/.config/.android/avd` for any direct `emulator` call.
2. Keep the AGP 8.10.1 / Kotlin 2.1.20 / Gradle 8.13 / compileSdk 35 / Compose BOM 2025.01.01
   combination; add nothing that is not in §3.1 without expecting a download (network is up).
3. `connectedDevice` FGS + `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE` +
   `CHANGE_WIFI_MULTICAST_STATE` + `CHANGE_NETWORK_STATE`; no runtime permission, no while-in-use
   trap, no Android 15 timeout.
4. Explicit notification **Pause**/**Stop** actions; never rely on the notification being
   non-dismissible (Android 14 makes it dismissible) or on a Stop callback (Task Manager kills
   silently).
5. Target SDK 34/35 keeps Samsung's One UI 6+ FGS guarantee and keeps local network access
   implicit; do not opt into `RESTRICT_LOCAL_NETWORK`.
6. Stage in internal storage, publish with `MediaStore.Downloads` + `IS_PENDING=0` after verifying
   size and SHA-256.
7. Defer FCM; if adopted, it is a best-effort nudge only, must be user-visible, and cannot be
   tested on the available emulators.
8. First real blocked/cached build (`./gradlew [--offline] :app:assembleDebug`) still needs to be
   run and recorded — it is the only open item in this document.
