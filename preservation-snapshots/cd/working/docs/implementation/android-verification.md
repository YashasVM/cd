# Android development verification

The first native receiver targets the Samsung S24 Ultra. Development checks use an Android 15 / API 35 emulator. These checks do not establish Samsung screen-off reliability or performance on a physical phone.

## Checks run

- JavaScript tests, Worker TypeScript checks and a Wrangler deployment dry run pass. No production deployment was performed.
- Go tests, race checks and vet pass for the CLI and device protocol.
- Android assembly, 29 unit tests and lint pass. Shared Go/Kotlin fixtures cover device admission, local challenge proofs, encrypted control messages, transfer records and authenticated checkpoints.
- A real CLI pairs through the local Worker with an independent protocol client. Forged admission and duplicate active peers are rejected, while the original peer continues forwarding. A 75-second stale-peer test permits a legitimate receiver to reconnect while sender heartbeats preserve its slot.
- The native emulator received an 8 MiB transfer with its screen off. Published bytes matched the source SHA-256.
- A 128 MiB transfer survived termination of both the CLI and Android processes. Running the same CLI command recovered the same root and the final published bytes matched the source SHA-256.
- Stop retained staging, halted writes, prevented publication of incomplete bytes, and stopped the CLI retry loop. Explicit Resume completed the same 256 MiB root. Source and downloaded file both hashed to `7ff8065776f988a1ea7f5e5be4b82df962b6a7762df51738931efa0a878ef1a2`.
- Existing resume checks cover relay authentication, nonce replay rejection, restart, changed source rejection, checkpoint tampering and authenticated completion.
- The final native WebRTC build passed a 128 MiB transfer with the screen off. Forced relay passed at 128 MiB. A 128 MiB LAN transfer passed after a CLI interruption, retaining its original root. Each check pulled the published Android file and verified its SHA-256 against the source.
- Stop during an active native P2P transfer retained the partial file, halted writes, prevented publication and stopped the CLI retry loop. Cancel and discard then removed both the staging file and checkpoint while receiving remained off.
- Revoking the laptop on the phone prevented it from submitting or publishing a new transfer while receiving remained enabled.
- Fresh pairing on the final build left CLI trust empty until explicit Android confirmation. A subsequent 128 MiB test killed both processes after a nonzero durable checkpoint, retained the same root, resumed above the saved offset, and verified the published SHA-256.

- After adding optional push and session-limit handling, the rebuilt default APK and CLI passed a 16 MiB LAN transfer with a matching published SHA-256.
- Optional Firebase sources compile against the real SDK, pass the same 29 unit tests and lint without project credentials. Compile-only mode blocks packaging. Default preview APK inspection confirms no Firebase SDK or service.
- Local Worker tests verify role-specific push authorization, private targets, throttling, expiry, fixed Google endpoints, RS256 OAuth signing and invalid-target cleanup with a mock Google transport. Actual Google delivery has not been tested.
- Local Worker tests verify authenticated session exhaustion, stale-session leases, retained nonce history, and successful completion on the 128th session. CLI tests verify actionable failure and creation of a new root on rerun without deleting the old capability.
- The Firebase setup helper passes validation, private-file permissions, idempotent setup and symlink-refusal tests using synthetic credentials.

All test files were synthetic. Tests used a local Worker and an owned emulator. Existing production clients were not replaced.

The S24 ARM64 development APK is `bin/cd-android-preview-arm64.apk`, 37,183,998 bytes, SHA-256 `f7d4a56ae963f4716a1dc84544540951ea09f86808f7f487aa8fc380d3a103bb`. Its DEX files match the tested universal APK byte for byte. Its native payload contains only ARM64 libraries. APK signature verification and 16 KiB ZIP alignment checks pass. The universal test artifact has SHA-256 `e80b43f40a19edfd61e97715f0438801579035aff3c206f3be91aa068f47ab21`.

## Repeat a native transfer check

Build and install the APK, pair through the real Trust screen, and enable receiving. Start a Worker from this checkout. The emulator must reach its relay URL. For a loopback development relay, use `adb reverse tcp:8795 tcp:8795`; use `10.0.2.2` for the computer's LAN endpoint in an Android emulator pairing.

Set the following environment variables to the existing development pairing and relay. The script never injects trust or enables receiving.

```sh
export ANDROID_HOME=/path/to/Android/Sdk
export CD_VERIFY_ANDROID_SERIAL=emulator-5554
export CD_VERIFY_DEVICE_NAME=phone
export CD_DEVICE_DIR=/path/to/test/device-config
export CD_STATE_DIR=/path/to/test/transfer-state
export CD_RELAY_URL=ws://127.0.0.1:8795/ws/v1
export CD_PUBLIC_URL=http://127.0.0.1:8795
export CD_DEVICE_LISTEN=0.0.0.0:53318
export CD_DEVICE_ADVERTISE_HOST=10.0.2.2

CD_VERIFY_ANDROID_ROUTE=local node scripts/verify-android-transfer.mjs
CD_VERIFY_ANDROID_ROUTE=relay node scripts/verify-android-transfer.mjs
CD_VERIFY_ANDROID_ROUTE=webrtc node scripts/verify-android-transfer.mjs
CD_VERIFY_ANDROID_ROUTE=webrtc CD_VERIFY_ANDROID_SCREEN_OFF=1 node scripts/verify-android-transfer.mjs
CD_VERIFY_ANDROID_ROUTE=local CD_VERIFY_ANDROID_INTERRUPT=1 node scripts/verify-android-transfer.mjs
CD_VERIFY_ANDROID_ROUTE=local CD_VERIFY_ANDROID_INTERRUPT=1 CD_VERIFY_ANDROID_KILL_PROCESS=1 node scripts/verify-android-transfer.mjs
```

The script builds the current CLI unless `CD_VERIFY_CLI` selects an existing binary. It creates a unique 128 MiB source, transfers to the existing trusted device, checks the observed route, pulls the published Android file, compares its SHA-256, and removes its test output. The optional interruption waits for a nonzero durable checkpoint, stops the CLI, and reruns the same command. It checks that the root stays the same and the resumed sender begins at or above the saved committed offset. It accepts emulators only. `CD_VERIFY_ANDROID_KILL_PROCESS=1` also kills CD's own debug process, retaining application data and relying on foreground-service recreation. The default leaves Android processes running.

`CD_VERIFY_ANDROID_MIB` changes the test file size between 8 and 512 MiB. `CD_VERIFY_ANDROID_SCREEN_OFF=1` turns the emulator screen off during transfer and wakes it during cleanup. A development-only `CD_DEVICE_LAN=0` suppresses the local data endpoint for testing internet transports. `CD_DIRECT=0` forces encrypted relay transfer. These overrides do not change stored trust.

## Release checks still required

Install on the physical S24 Ultra and test Wi-Fi-only transfers, different internet networks, mobile data opt-in, screen-off receiving, Samsung battery settings, low storage, notification Stop, revocation and reboot behavior. Measure sustained throughput on the same files and network before making a speed comparison with LocalSend.

Push wake-up needs [Firebase project configuration](../guides/firebase-setup.md) and a physical delivery test. Force-stop requires opening the app again. A release signing key and distribution process are also required before publishing a production APK.
