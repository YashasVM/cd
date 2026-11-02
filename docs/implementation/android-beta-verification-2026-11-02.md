# CD Android product repair, 2026-11-02

## Reproduced failure
Native standard receive failed immediately after ACCEPT. CLI sender reported `receiver sent an invalid transfer selection`; Android received room close 4404. The app sent `{}` where the CLI requires a selected chunk size or an empty legacy acceptance. Corrected to the compatible empty payload.

## Implemented
- Standard v1 links/codes receive natively; no browser redirect.
- Keep v1 on encrypted relay because shared direct assembler lacks v1 replay/sequence merging. v2 direct remains.
- Correct receive service startup, persistent pause, process recovery, active queue capacity and history dismissal.
- UI actions reflect resumability; links/commands wrap, scanner geometry follows preview, code lookup shows loading and rejects duplicate submission.
- APK/file MIME, filename extensions and shared publication preserved.
- Android 10–12 code lookup API compatibility repaired.

## Runtime checks on Android 15 x86_64 emulator
- Reproduced old standard failure with exact sender error.
- Standard private-link receive: 29 bytes, saved inside app, SHA-256 matches sender.
- Code/QR-root-link lookup: another 29-byte receive, SHA-256 matches sender.
- Duplicate download: `smoke (1).txt`, extension preserved, hash matches original.
- Paired/trusted receive with screen turned off: 1 MiB file, sender exit 0, SHA-256 matches sender.
- Open action reached Android's application chooser, observed screenshot.

Automation stopped at external chooser: agent-device snapshot helper returned insufficient foreground content twice. No substitute device-control engine used. Physical camera/gallery decoding, Samsung long-idle Doze, and phone-to-CLI send were not end-to-end verified in this run. The emulator screen-off result is not a long-idle physical-phone guarantee.

Final integrated JVM suite passed 58 tests with zero failures; Android lint and the ARM64 build passed.

## Final review
Three parallel reviewers audited transfer protocol, receiver lifecycle/history, and UI controls/scanner. Final review found and fixed network EOF dropping queued completion frames. Added graceful-EOF vs explicit-abort regressions. Build artifact version 0.1.7-beta, versionCode 8.

Final ARM64 build, JVM tests and lint succeeded. Test totals: {'tests': 58, 'failures': 0, 'errors': 0, 'skipped': 0}
