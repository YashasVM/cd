# Integrating live transfers

Android and web SDKs are implemented as `0.1.0-preview.1`. This replaces the
proposal in [RFC #85](https://github.com/YashasVM/cd/pull/85). Both SDKs transfer
one file through the existing encrypted v2 relay, without installing or opening
CD. iOS is outside this delivery scope.

These are preview artifacts built locally, not releases on Maven Central or
npm. The public service has no SDK availability SLA. Use a relay running this
repository's v2 implementation. No service is deployed by building the SDKs.

## Ownership and privacy

Your app owns discovery, secret-link delivery, explicit consent, source access,
destination storage, notifications, background execution and posthandling.
The SDK owns admission, encryption, bounded streaming, acknowledgements and
verification. CD's Android app uses the same library's stream engine with its
existing durable storage and direct-path adapters. CD's web app imports the
web package's transport and shared receive engine; its OPFS and DOM adapters
remain in `src/resume-browser.js`.

`appId` is public, unverified attribution. A peer can forge it. Never use it for
authorization, identity verification, privileges or trusted consent. It goes in
the sender's public join and encrypted offer. No permanent API key is required,
and this preview adds no per-app quotas or privileged registration mechanism.

Use the complete `/s/<id>#v2.<key>` invitation. Treat it as a bearer secret and
share it through your own trusted channel. Do not log it, put it in analytics,
or send its fragment to a server. These SDKs never use the numeric-code
key directory. The relay receives routing metadata, public attribution,
addresses, timing and ciphertext sizes. It receives no file key, filename or
plaintext and stores no file contents. Endpoints still need to trust their own
app code and, on the web, the origin serving JavaScript.

The sender must stay online. One receiver can occupy a room at a time; a fresh
SDK operation admits one receiver and ends on rejection, cancellation or loss.
There is no offline delivery, stored hosting, retry loop or automatic reconnect.
A recoverable failure requires a fresh invitation. CD's existing advanced
resume adapters retain their own authenticated checkpoints; the high-level SDK
APIs do not expose persistence or resume in this preview.

## Android installation

Requires Android API 29+, Java 17, Kotlin and an Android Gradle project. The
library has an OkHttp dependency, no Compose, Activity, service, storage,
notification, WebRTC or CD UI dependency.

From the repository root:

```sh
export ANDROID_HOME=/path/to/Android/Sdk
android/gradlew -p android :transfer:publishReleasePublicationToPreviewRepository
android/gradlew -p android :transfer:publishReleasePublicationToMavenLocal
```

The versioned repository is `android/transfer/build/repository/`. Copy that
repository to a location your build can read, then add it to your Gradle
settings. Alternatively enable `mavenLocal()` for a local development install.

```kotlin
// settings.gradle.kts, inside dependencyResolutionManagement.repositories
maven { url = uri("/path/to/transfer/build/repository") }
// host app build.gradle.kts
implementation("in.yash0.cd:transfer-android:0.1.0-preview.1")
```

The release AAR, sources JAR, POM, module metadata and checksums are produced by
the publication task. Maven publication to a remote repository is not configured
or claimed. Keep the MIT license with redistributed artifacts.

## Android API and lifecycle

Import `in.yash0.cd.sdk.*` using Kotlin's backticks around `in`. Create an
immutable source with its size and lowercase SHA-256 computed by streaming it
before sharing. The SDK rechecks the source during the send.

```kotlin
val client = CdTransferClient(appId = "com.example.host")
val outgoing = client.outgoing(
    TransferSource(file.name, file.length(), sha256, file::inputStream),
    onUpdate = { update -> /* post update to your UI */ },
)
// On a host-owned IO executor, never on the main thread:
val verified = outgoing.run { invitation -> /* deliver secret invitation */ }
```

The invitation callback runs only after relay admission. Keep `run` alive until
it returns or throws. `VerifiedFile(size, sha256)` means the receiver committed
the authenticated, exact-length content and returned matching encrypted counts
and hash. Send progress counts acknowledged bytes, not just queued bytes.

```kotlin
val incoming = client.incoming(invitation, onUpdate = ::postToUi)
// On a host-owned IO executor:
val verified = incoming.run { offer ->
    // Marshal the offer to your UI, await an explicit decision.
    // Return null to reject. Only after Accept, return a TransferSink.
    consentUi.awaitDestination(offer)
}
```

`TransferSink.open()` returns an OutputStream to private staging storage.
`commit(VerifiedFile)` publishes or imports it after verification and successful
stream closure. `abort()` removes partial staging on failure. Implement
idempotent stream close and cleanup. The SDK closes streams it opens. Never use
a peer's filename as a destination path. Use an opaque local name and display
the offered name separately. Check free space before accepting large files.
A failed commit prevents receiver COMPLETE and sender success.

`outgoing.close()` or `incoming.close()` cancels, closes the socket and active
stream, and wakes network waits. Operations run once. Call close from the host's
lifecycle owner, and interrupt/join its worker when appropriate. SDK callbacks
run on that worker and must return promptly, or wait under interruptible host
control. Closing a transfer cannot forcibly stop arbitrary host code blocked
inside a callback. The sample releases its consent future on Cancel and
Activity destruction. The SDK installs no service, foreground notification,
worker, alarm, UI or automatic restart.

Updates distinguish CONNECTING, WAITING, AWAITING_CONSENT, TRANSFERRING,
VERIFYING, COMPLETE, REJECTED, EXPIRED, CANCELLED, FAILED and
RECOVERABLE_FAILURE. Failures also throw `TransferException(state, cause)`.
Use the state for UI text; do not log exception chains containing host data.

## Web installation and API

From the repository root:

```sh
npm ci
npm pack ./packages/transfer-web --pack-destination /tmp
# In your host app:
npm install /tmp/yash0-cd-transfer-0.1.0-preview.1.tgz
```

The package exports ESM JavaScript and TypeScript declarations from
`@yash0/cd-transfer`, with no runtime package dependencies. It uses Web Crypto,
WebSocket, File/Blob, AbortController and typed arrays. Secure contexts are
required in browsers. Node 22+ can run protocol integrations with its Web APIs;
the package does not implement a Node filesystem adapter.

```ts
import { CdTransferClient, type TransferSink } from '@yash0/cd-transfer';

const client = new CdTransferClient({
  appId: 'com.example.host', relayOrigin: location.origin,
});
const outgoing = client.outgoing(file, { onUpdate: renderProgress });
const result = await outgoing.run(invitation => shareSecretLink(invitation));

const incoming = client.incoming(invitation, { onUpdate: renderProgress });
const received = await incoming.run(async (offer, signal) => {
  if (!await askUserToAccept(offer, signal)) return null;
  return createPrivateStagingSink(offer, signal); // TransferSink
});
```

`File` is read in 256 KiB slices, hashed before sharing and rechecked while
sending. Receivers do not allocate a whole-file buffer. Supply a sink with
`write(Uint8Array, AbortSignal)`, `commit(VerifiedFile, AbortSignal)` and
`abort()` methods, each synchronous or returning a Promise. Own/copy each
chunk before write resolves. Commit only exposes verified content. Abort must
remove staging and wait for any pending writes before deleting it. Honor the
signal in host IO and consent code. Cancellation cannot undo a host publication
that has already succeeded. If the final relay acknowledgement is lost, the
receiver can have verified content while the sender reports failure; never
promise atomic success across two devices.

Call `operation.cancel()` on explicit Cancel and from your lifecycle handler.
The SDK installs no page listeners. Cancel interrupts pending consent waits and
network waits and passes an AbortSignal to the host. A late sink returned after
cancellation is aborted. Host IO still must settle cooperatively. Operations
run once; `run()` resolves only with a verified result and otherwise rejects
with `TransferError.state`. Web state names are the lowercase, hyphenated
versions of Android states. Progress callbacks report acknowledged sender bytes
or receiver-owned bytes. No callback logs contents or keys.

### Browser relay origins

The current CD relay rejects cross-origin browser WebSocket connections. An
arbitrary third-party website cannot connect directly to `cd.yash0.in`.
Serve your host bundle as assets on its own relay origin, or configure an
operator-controlled same-origin WebSocket gateway. Native Android connections
have no browser Origin header. This PR does not relax the existing origin
checks or deploy production changes. Public `appId` does not bypass them.
The local Chromium test uses real browser Origin headers against the real
Worker, with the host example served on that same origin.

## Host examples

- `android/sample` is a separate application ID, using only `:transfer`. It
  chooses a file through the Android document picker, asks Accept/Reject,
  stages privately, shows state/hash, cancels on Activity destruction and
  stores verified output under an opaque filename in private app storage.
  It deliberately has no background service or cross-restart persistence.
- `examples/transfer-web` is a plain HTML host using only the package API. Its
  OPFS sink exposes a download link after verification. Its README explains
  same-origin local hosting. OPFS is the sample's choice, not an SDK dependency.

Build APKs with `android/gradlew -p android :sample:assembleDebug
:app:assembleDebug`. Only the debug sample permits local HTTP; release hosts
need their own deliberate network-security policy for local development.

## Limits and compatibility

Both high-level APIs support v2 fragment invitations only. Existing v1
crypto/records remain in the extracted modules for CD's legacy paths; this
preview does not claim that v1-only clients can open v2 links. The unchanged
Go/browser v2 record fixture is tested in both implementations.

- Default invitation lifetime: 15 minutes; callers may choose 1 second to
  24 hours. Expiry includes file preparation time. Relay expiry is authoritative.
- One file per operation. Hosts can build an archive before sending. No archive
  extraction is performed by the SDK.
- File sizes are exact integers through `2^53 - 1`, also limited by v2's uint32
  record sequence and the host's storage, memory, network and lifetime. This is
  an encoding limit, not a claim of practical petabyte transfers.
- Filename: 1–255 UTF-8 bytes, no path separators, control characters, `.` or
  `..`. The web client additionally requires NFC filenames.
- Plaintext chunks: 256 KiB. Android send window: 4 MiB. Web sender: four
  chunks, 1 MiB. Web pending inbox: at most 32 records and roughly 4 MiB plus
  record overhead. Android inbox: eight frames, at most 1 MiB each.
- Admission/connection waits are bounded. Inactivity is 90 seconds after
  acceptance. Android permits up to 10 minutes for receiver consent; web's
  legacy transport wait is 90 seconds. Keep host consent responsive and within
  these limits. Server leases and fixed expiry can end a session sooner.
- SDK peers distinguish encrypted rejection. Older v2 senders that do not
  understand the optional rejection hint fail safely before bytes, but may
  display a generic interruption rather than "rejected".

Protocol details and the preview rejection extension are in
[transfer protocol v2](agent-transfer-v2.md). The AES-GCM/HKDF key schedule and
record layout are unchanged. The web example has been checked in Chromium;
Safari/Firefox, Android devices, background execution and large-file device
performance are not certified by JVM/Node tests. Host apps must validate their
own lifecycle, storage and browser support before shipping.

## Verification and preview policy

```sh
npm test
npm run typecheck
npm run build
npm run verify:sdk:web       # real local Worker, web public API
npm run verify:sdk:android   # Android public API plus separate-process web interop
npm run verify:sdk:browser   # Chromium host UI, consent, OPFS and exact bytes
npm run typecheck:sdk
android/gradlew -p android :app:testDebugUnitTest :transfer:testDebugUnitTest \
  :transfer:lintDebug :sample:lintDebug :app:lintDebug \
  :transfer:assembleRelease :sample:assembleDebug :app:assembleDebug \
  :transfer:publishReleasePublicationToPreviewRepository
```

The live tests launch the actual Worker and SQLite-backed Durable Objects,
without deployments. They cover consent before source/sink access, exact
multi-window bytes/hash, empty files, rejection, cancellation, expiry, changed
sources, storage failure, simulated socket loss, fresh recovery and duplicate
receiver refusal. Web/Android interop sends 5 MiB + 731 bytes in both directions
and checks cross-client rejection. Unit tests retain tamper, replay and fixture
coverage. Tests requiring a relay skip in a plain unit run; the `verify:sdk:*`
commands supply it and must pass with no skipped live cases.

Preview versions may change APIs between releases. Only the latest preview is
supported, with best-effort issue triage and no SLA or promised deprecation
window. Before any stable release, define a support window, publish remote
artifacts and run the device/browser interoperability matrix. This PR makes no
commitment to an iOS SDK.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/YashasVM/cd/security/advisories/new),
not a public issue containing a live invitation. See [SECURITY.md](../SECURITY.md)
for the repository policy and expected initial response time.
