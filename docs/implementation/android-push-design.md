# Optional FCM wake-up for the paired Android receiver

Research notes from before implementation. For the current setup and delivery policy, use [the setup guide](../guides/firebase-setup.md) and [Android push documentation](../../android/docs/push.md).

Design research for an **optional, best-effort** Firebase Cloud Messaging (FCM) nudge that asks an
already-paired Android phone to come back online and connect to its existing relay, so the user does
not have to open the app first.

This file is the only file produced by this task. No `android/**` or `worker/**` source was modified,
no Firebase project was created, and no credentials were requested, stored, or deployed. Everything
below is either (a) read directly from this repository, or (b) taken from current official Android /
Firebase / Cloudflare documentation, linked in §12. Claims that could not be verified are marked
**unverified**.

---

## 1. Recommendation (read this first)

**Ship the smallest thing that can work: one authenticated "wake" bounce, triggered by the sender,
delivered as a high-priority FCM data message, with no payload content and no delivery guarantee.**

Concretely:

1. The Android app, once it has at least one trusted pairing and the user opts in, sends its Firebase
   Installation ID (FID) to the **same Durable Object** (`DeviceRoom`) that already stores the pair,
   authenticated with the existing **receiver join token**. The DO stores it next to the registration.
2. A sender that wants the phone to wake calls one new Worker endpoint, authenticated with the
   existing **sender join token**. The DO verifies it and calls the FCM HTTP v1 send API.
3. The app receives a data-only, high-priority message, checks the priority, and starts (or reuses)
   the existing `ReceiverService` foreground service, which reconnects the relay WebSocket.
4. If any of that is unavailable — no Google Play services, no `google-services.json`, FCM project
   not configured, app force-stopped, user disabled it — **nothing changes** and the current flow
   (LAN first, relay WebSocket, user opens the app) still works.

This is deliberately **not** a general push channel, not a silent always-on daemon, and not a
replacement for the foreground service. FCM here is a *doorbell*, nothing more. §7 explains why
every stronger guarantee ("the phone will always wake") is false and must not be promised.

### Why not more

- The relay is already the durable rendezvous: `DeviceRoom` keeps a 30-day registration and answers
  with `426` for anything that is not a WebSocket. Wake-up is the one missing signal.
- The pairing already gives us two authenticated bearer secrets (the role join tokens), so the
  minimal design needs **no new credential type** — we reuse the hashes the DO already stores.
- The current notification, channel `receiving` (IMPORTANCE_LOW, "Ready to receive", Stop action),
  already exists in `ReceiverService`; the wake path reuses it rather than inventing a second UX.

---

## 2. Where this fits in the existing architecture

Current receive path (from `docs/implementation/android-contract.md` and `android/README.md`):

| Layer | State | Role |
| --- | --- | --- |
| LAN / mDNS | primary, free | `_cdx._tcp`, connects `ws://<LAN IP>:53318/ws/devices/v1/<pairId>` |
| Relay WebSocket | fallback, always available while app runs | `wss://cd.yash0.in/ws/devices/v1/<pairId>` → `DeviceRoom` |
| WebRTC (`cd-direct`) | optional non-local fast path | negotiated after the relay offer |

Every one of those transports needs the receiver process to already be running and connected. When
Android Doze suspends network access and `ReceiverService` is torn down, the sender is stuck until
the user opens the app. That is the exact gap FCM closes — and only that gap.

FCM never carries file data, never carries keys, and never authorizes a transfer. It is a hint that
"a paired sender is trying to reach you"; all real authentication stays in the existing AEAD control
channel.

---

## 3. Goals and non-goals

**Goals**

- Let a paired sender ask a sleeping phone to reconnect, without the user tapping anything.
- Authenticate both the target registration and the wake request with existing pair secrets.
- Default off; degrade to today's behavior with no code change when it is not configured.
- Be honest about what can prevent delivery.

**Non-goals**

- Guaranteed, silent, always-on delivery (impossible on Android; see §7.4).
- Sending any user content, filename, size, digest, or transfer key through FCM.
- A new identity/credential system for the phone.
- Making FCM a requirement to pair or to receive.

---

## 4. Threat model and security requirements

What we are protecting: the pair secret, the two role join tokens, the receiver's FID, and the
"who may ring whose doorbell" decision.

| # | Threat | Requirement |
| --- | --- | --- |
| T1 | A stranger who learned a `pairId` registers their own phone as the target | Target registration MUST require the receiver join token, verified against `receiverTokenHash` in the DO. `pairId` alone is never sufficient. |
| T2 | A sender overwrites / hijacks the receiver's target | The sender token MAY only wake; it MUST NOT set, replace, or read the target. Only the receiver token can write the target. |
| T3 | A stranger spams wake requests | Wake MUST require the sender join token; plus per-IP and per-pair rate limits and a per-pair cooldown. |
| T4 | Token guessing | Timing-safe compare against stored SHA-256 hashes (reuse `equal()`), never compare raw tokens, never store raw tokens. |
| T5 | Token/FID/secret leakage into logs or the send API | Never log tokens, FIDs, or the service-account key. FCM payload contains no secret. FID is stored only in the DO, never sent to the sender. |
| T6 | Stolen service-account key | Live only as a Worker secret (`wrangler secret put`), never in `vars`, never in git, never handed to the CLI or the Android app. Minted bearer tokens are short-lived and cached in memory. |
| T7 | Stale/recycled FID ringing the wrong device | Push target expires and is refreshed only by an authenticated receiver join; FCM `UNREGISTERED`/`INVALID_ARGUMENT` clears it. |
| T8 | Wake used to drain battery or money | Cooldown + hourly cap per pair; `collapse_key` so queued nudges collapse; no high-priority use without a user-visible outcome (§7.2). |

Note this is the same trust root the transfer itself uses. If the pair secret leaks, FCM adds no new
exposure beyond existing message forgery; if it does not leak, FCM cannot be abused without it.

---

## 5. Wire and API sketch

All new endpoints live under the existing Worker route table (`worker/index.ts`), keyed by the same
22-char base64url `pairId` (`[A-Za-z0-9_-]{22}`), and dispatch to `env.DEVICES.getByName(pairId)`.
`DeviceRoom` currently rejects every non-WebSocket request with `426`; we branch for the two POST
routes **before** the upgrade check, and keep `426` for everything else.

Tokens are sent in the JSON body (mirroring the existing `join` message which carries `token`), never
in the URL, because URLs land in logs and analytics. Requests and responses are `application/json`.

### 5.1 Register / refresh the receiver's push target

```
POST /api/devices/v1/<pairId>/push-target
Content-Type: application/json

{ "v": 1, "token": "<receiver join token>", "fid": "<firebase installation id>" }
```

- Requires a **live** registration with a matching `receiverTokenHash`; otherwise `401`.
- If the pair has no registration yet (sender never joined), `409` — the app retries later.
- Stores `{ fid, updatedAt, expiresAt }` under a separate DO key (`push`), not inside
  `registration`, so it is independent of the 30-day join refresh and can expire on its own.
- Response: `204 No Content`.
- Idempotent: re-registering the same FID just refreshes `updatedAt` / `expiresAt`.

Deregister (user turns push off, revokes the pair, or the app detects `UNREGISTERED`):

```
DELETE /api/devices/v1/<pairId>/push-target
{ "v": 1, "token": "<receiver join token>" }
```
→ `204`, target removed.

### 5.2 Sender asks the phone to wake

```
POST /api/devices/v1/<pairId>/push
Content-Type: application/json

{ "v": 1, "token": "<sender join token>", "reason": "offer" }
```

- Requires a live registration with a matching `senderTokenHash`; otherwise `401`.
- `reason` is a small closed enum for telemetry only (`offer`, `resume`, `manual`); unknown values
  are rejected rather than stored.
- Returns `200` with a coarse status the sender may use to decide whether to keep waiting:

```json
{ "v": 1, "status": "nudged" }   // FCM accepted the send
{ "v": 1, "status": "online"  }   // a receiver socket is already attached; no nudge sent
{ "v": 1, "status": "unavailable" } // no live target, or FCM rejected/unavailable
```

`status` must not leak *why* a target is unavailable (no "the FID was deleted yesterday").
Errors: `401` bad/absent token or expired registration, `429` rate limited, `503` FCM transport
unavailable.

### 5.3 What FCM actually receives (Worker → FCM)

```
POST https://fcm.googleapis.com/v1/projects/<FCM_PROJECT_ID>/messages:send
Authorization: Bearer <short-lived OAuth access token>
Content-Type: application/json
```

```json
{
  "message": {
    "fid": "<receiver FID>",
    "android": {
      "priority": "HIGH",
      "ttl": "300s",
      "collapse_key": "cd-wake",
      "direct_boot_ok": true,
      "bandwidth_constrained_ok": false,
      "restricted_satellite_ok": false
    },
    "data": {
      "v": "1",
      "type": "wake",
      "pairId": "<pairId>",
      "issuedAt": "<epoch millis as string>"
    },
    "fcm_options": { "analytics_label": "cd_wake" }
  }
}
```

Notes and constraints:

- FCM HTTP v1 caps the payload at **4096 bytes**; this message is a few hundred. Every `data` value
  is a string (FCM requires it).
- Data-only messages (no `notification` block) are delivered to `onMessageReceived` in the
  background and do **not** auto-show anything — which is what we want, because the app decides.
- `collapse_key` (max 4 active keys) means repeated nudges replace each other instead of queuing.
- `ttl` "300s": a wake is worthless if the phone was offline for an hour; FCM discards it rather
  than delivering stale. Max allowed TTL is 4 weeks.
- `priority: HIGH` is what wakes a Dozing device into a short maintenance window (§7.3). It is also
  what FCM monitors: if high-priority messages do not produce user-visible outcomes, FCM
  deprioritizes them. §7.2 handles that obligation.
- `fid` vs `token`: current docs mark the `token` field of `projects.messages` as deprecated
  ("Use `fid` instead"). The design targets `fid`, but this is a **doc-freshness risk** — the Android
  client and the Worker must agree on which identifier is registered and sent. §9 keeps the choice in
  one place.

### 5.4 Type sketch (TypeScript, `worker/`)

```ts
// In device-room.ts (sketch — not committed).
type PushTarget = { fid: string; updatedAt: number; expiresAt: number };
const PUSH_TTL = 90 * 24 * 60 * 60 * 1000;      // 90 days, refreshed by authenticated joins
const WAKE_COOLDOWN = 30_000;                     // min gap between nudges to one pair
const WAKE_HOURLY_CAP = 20;                       // per pair
```

```ts
// fetch(): branch before the upgrade check
const { pathname } = new URL(request.url);
if (request.method === 'POST' && pathname === '/push-target')  return this.registerTarget(request);
if (request.method === 'DELETE' && pathname === '/push-target') return this.clearTarget(request);
if (request.method === 'POST' && pathname === '/push')          return this.wake(request);
if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
  return new Response('websocket required', { status: 426 });   // unchanged behavior
}
```

The `index.ts` routes mirror the existing device route:

```ts
const targetMatch = /^\/api\/devices\/v1\/([A-Za-z0-9_-]{22})\/push-target$/.exec(url.pathname);
const wakeMatch   = /^\/api\/devices\/v1\/([A-Za-z0-9_-]{22})\/push$/.exec(url.pathname);
// rate-limit per IP with CONNECTION_RATE_LIMITER (or a dedicated PUSH_RATE_LIMITER),
// then forward to env.DEVICES.getByName(id).fetch(new Request(...)) with the path preserved.
```

`registerTarget` / `clearTarget` / `wake` fetch the stored `registration`, hash the supplied token
with the existing `hash()`, compare with `equal()`, and only then touch storage or FCM.

### 5.5 Android side (Kotlin, sketch)

```kotlin
// A data-only wake is parsed into an immutable command; no network I/O in onMessageReceived.
data class WakeCommand(val v: Int, val pairId: String, val issuedAt: Long)

// FirebaseMessagingService.onMessageReceived(RemoteMessage):
//   1. parse data; drop if type != "wake" or v unknown
//   2. if remoteMessage.priority != RemoteMessage.PRIORITY_HIGH -> post a notification, do NOT start FGS
//   3. else -> start ReceiverService (existing FGS) with a "wake" extra; the service does the network I/O
```

Registration of the FID is triggered from `ReceiverService` (or a small `PushBridge`) whenever a
pairing becomes active and push is enabled, reusing the receiver join token from `Pairing.token()`.

---

## 6. Worker / Durable Object FCM sender (OAuth)

This is the part with real external configuration, so it must be isolated and injectable.

### 6.1 Getting a bearer token (no SDK, no npm dependency)

FCM HTTP v1 uses an OAuth 2.0 access token minted from a service account:

1. Load `FCM_SERVICE_ACCOUNT_JSON` (a Worker secret) once per isolate.
2. Build an RS256 JWT: header `{alg:"RS256",typ:"JWT"}`; claims `iss = client_email`,
   `scope = "https://www.googleapis.com/auth/firebase.messaging"`, `aud = token_uri`
   (`https://oauth2.googleapis.com/token`), `iat = now`, `exp = now + 3600`.
3. Import the PKCS#8 private key with WebCrypto:
   `crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])`
   and sign `base64url(header) + "." + base64url(claims)`.
4. Exchange: `POST <token_uri>` with
   `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`.
5. Cache `{ accessToken, expiresAt }` in module scope; refresh ~60 s before expiry.

The service-account key never leaves the Worker isolate and is never logged. It is **not** needed by
the Android app; the app only needs the non-secret `google_app_id` / `gcm_defaultSenderId` values
that the `google-services` plugin generates from `google-services.json`.

### 6.2 Secrets and configuration

| Name | Kind | Where | Notes |
| --- | --- | --- | --- |
| `FCM_SERVICE_ACCOUNT_JSON` | secret | `wrangler secret put` (`.dev.vars` locally) | full service-account JSON with private key; never in `vars`, never committed |
| `FCM_PROJECT_ID` | var or secret | `wrangler.jsonc` `vars` | not sensitive on its own |
| `FCM_ENDPOINT` | var (optional) | `wrangler.jsonc` `vars` | test seam; defaults to the real FCM host |

If `FCM_SERVICE_ACCOUNT_JSON` or `FCM_PROJECT_ID` is absent, `wake()` returns
`{ status: "unavailable" }` — configured-off must not error.

### 6.3 Injection seam for tests

`wake()` should call a small `sendWake(target, payload)` function whose FCM base URL comes from
`FCM_ENDPOINT` (defaulting to `https://fcm.googleapis.com`) and whose token source is swappable. That
lets the whole DO be tested with `VITEST`/`wrangler dev` against a local stub, with no Google
account.

---

## 7. Android constraints (these bound what we may promise)

Verified against current official docs (§12); where behavior depends on OEM/Play-services it is
called out.

### 7.1 What actually runs on the phone

- A data-only message is delivered to `FirebaseMessagingService.onMessageReceived`. If the app is
  not in the foreground, the callback still runs in a background-service context — but it has
  **only a few seconds** and must not do network I/O.
- Therefore the wake handler's only job is: parse, guard, and start the existing foreground service.
  All socket work happens inside `ReceiverService`, which already holds the `connectedDevice` FGS
  type and a wake lock.

### 7.2 The high-priority obligation (do not skip)

High priority is a scarce resource. FCM documents that high-priority messages should **result in a
user-visible notification**, and that messages which do not will be deprioritized (and may be
proxied) — Google's own delivery guidance states FCM begins treating them as normal priority over
time. So the design makes the wake path user-visible:

- On a high-priority wake, the service either connects and updates the existing ongoing
  `receiving` notification ("CD — connected to <name>"), **or**, if it cannot within a short window,
  posts a normal-importance notification ("A paired device is trying to send you a file — tap to
  open CD"). The user always gets something they can act on.
- If the incoming message is not `PRIORITY_HIGH`, the app **must not** call `startForegroundService`
  and must not treat it as a wake; it posts the notification instead. Starting an FGS from a
  background/normal-priority context throws `ForegroundServiceStartNotAllowedException` on
  Android 12+.

This also bounds abuse (§4 T8): a nudge always corresponds to real user-visible work, so we never
burn high-priority budget silently.

### 7.3 Foreground service start from FCM, and Doze

- Starting a foreground service is normally restricted in the background on Android 12+, but there
  is a documented exemption when the start comes from a **high-priority FCM message** (also
  `setExactAndAllowWhileIdle`/alarm and a few others). This is exactly our path, so the FGS start is
  allowed — **provided the priority check in §7.2 passes**.
- Doze "suspends network access, ignores wake locks, and defers jobs and alarms". The FCM high-priority
  message opens a short **maintenance window** in which the app can reach the network. That window is
  the entire opportunity: the service must reconnect the relay promptly (within seconds), not open a
  long-lived transfer session from scratch with retries.
- Samsung (target: S24 Ultra) additionally applies its own battery management. Doze/FCM behavior is
  reliable only when the app is not force-stopped and the user has not restricted the app's battery
  usage. The app should offer a deep link to the system battery-optimization screen and explain the
  tradeoff rather than claiming FCM "just works".

### 7.4 Force-stop and reboot: no silent always-on

- Force-stop puts the package in the **stopped state**: all broadcasts and FCM messages are withheld
  until the user launches the app again. Firebase's own delivery write-up confirms messages are
  dropped for force-stopped apps. **There is no way around this**, and the UI must say so.
- Reboot: a data-only high-priority message with `direct_boot_ok: true` can be delivered before the
  user unlocks, but only to a component marked `directBootAware`; the current `ReceiverService`
  depends on the Keystore vault in `Store`, which is credential-encrypted and unavailable before
  first unlock. So direct boot is **not** useful here; leave `direct_boot_ok` at most as a flag, and
  do not claim post-reboot delivery.
- The ADR already records this posture: push wake-up is separate work and there is no silent
  auto-restart after force-stop/reboot. This design keeps that posture; it does not overturn it.

### 7.5 Notification and permission details

- Channel `receiving` exists with `IMPORTANCE_LOW`. Wake outcome notifications that need attention
  should use a separate channel (e.g. `wake`, `IMPORTANCE_DEFAULT`) so the ongoing-low-importance
  channel stays quiet and the alert is visible.
- `POST_NOTIFICATIONS` is already declared; on Android 13+ the user must grant it. If notifications
  are disabled, high-priority FCM loses its documented justification and should be treated as
  unreliable for this app — surface that in settings rather than pretending.

---

## 8. Opt-in build (keep `assembleDebug` working with no FCM)

The app must build and run today, with no Firebase project and no `google-services.json`.

### 8.1 Options

- **(A) Conditional source set (`src/fcm`) gated on a Gradle property / file presence.** A plain
  extra source directory is only compiled if it belongs to a variant. `src/fcm/` is not a variant
  source set unless a flavor named `fcm` exists, so this alone does not work; the `androidComponents`
  variant-source API can add it, but that is fragile across AGP versions.
- **(B) Product flavor `push` with values `none` / `fcm`.** Standard and robust, but it renames every
  variant (`assembleNoneDebug`, `testFcmDebugUnitTest`, …) and would break the current simple
  `assembleDebug` / test invocations.
- **(C) Optional Gradle module `:push`, included only when configured.** Cleanest for this repo:
  - `settings.gradle.kts`: `if (file("app/google-services.json").exists() || providers.gradleProperty("cd.fcm").isPresent()) include(":push")`.
  - `android/app/build.gradle.kts`: `if (findProject(":push") != null) implementation(project(":push"))`.
  - `:push` owns the `com.google.gms:google-services` plugin, `firebase-messaging`, its own
    `FirebaseMessagingService`, and its manifest entries (the service + `<meta-data>`).
  - `app` owns a tiny interface (`PushBridge`, with a no-op default). It discovers the real
    implementation through a manifest `<meta-data>` value (`in.yash0.cd.PUSH_IMPL`) read with
    `PackageManager` — the same auto-init pattern Firebase itself uses, so no reflection guessing and
    no compile-time dependency in the core module.

**Recommendation: (C).** It preserves `assembleDebug`, keeps all Play-services/Firebase weight out of
the default APK, and gives the "off" path a real, testable no-op.

### 8.2 `google-services.json`

- Required only when `:push` is included; produced by Firebase and contains **non-secret**
  identifiers (project id, `mobilesdk_app_id`, `api_key`). It can be recreated from the project at
  any time.
- Place at `android/app/google-services.json` (the plugin's expected path for the app module), or in
  `:push` with the plugin pointed there.
- **Add it to `.gitignore`.** It is not a private key, but it is environment-specific and there is no
  reason to commit it; the build is opt-in by its presence.

---

## 9. Testing without credentials

The feature must be testable on this machine before any Firebase project exists.

**Android unit tests (JVM, `src/test`)** — no Play services required:

- Wake payload parsing: valid/invalid `type`, unknown `v`, missing fields, oversized values.
- Priority guard: `PRIORITY_NORMAL` → no FGS start, notification posted;
  `PRIORITY_HIGH` → FGS start requested. Inject a fake `startForegroundService` sink.
- Notifications-disabled path → recorded, not treated as a wake.
- Target registration/deregistration request serialization (token in body, never URL);
  Doze/force-stop cannot be unit-tested and must be documented as device-only.

**Worker / DO tests (Vitest + `wrangler dev`)** against a stub FCM:

- `wake` with a missing/incorrect token → `401`; expired registration → `401`.
- `wake` with a valid sender token and a stored target → stub FCM called once; `{"status":"nudged"}`.
- Receiver already attached → `{"status":"online"}`, FCM not called.
- Cooldown: second `wake` within 30 s → `429`; cap exceeded → `429`.
- `push-target` with a sender token → `401` (T2); with an unregistered pair → `409`.
- `push-target` then `DELETE` → `204`, target gone; a subsequent `wake` → `"unavailable"`.
- Non-POST/non-upgrade request to the DO still → `426` (regression guard).
- FCM error mapping: `UNREGISTERED` (404) / `INVALID_ARGUMENT` (400) clears the stored target.

**Shared fixture** `fixtures/device-push-v1.json`, following the `fixtures/device-v1.json` pattern, so
Kotlin and TS tests assert the same request/response shapes (the Android test source set already
points at `../../fixtures`).

**End-to-end** requires a physical Play-services device (the `google_apis` emulator image cannot run
FCM — recorded in `docs/implementation/android-platform-research.md`). Keep this gated behind the
external dependency in §10 and document it as device-only.

---

## 10. Exact external dependencies to flag

Nothing here can be done without user action, and none of it is required to finish/merge the
non-FCM behavior.

1. **Firebase / Google Cloud project** with Cloud Messaging enabled. *(The FCM project answer is
   still pending; do not create it yet.)*
2. **Android app registered** in that project for package `in.yash0.cd`; download
   `google-services.json` into `android/app/` (git-ignored).
3. **Service account** with permission to send FCM (FCM Admin / Firebase Admin), JSON key downloaded
   once.
4. **Worker secrets/config**: `wrangler secret put FCM_SERVICE_ACCOUNT_JSON`, plus `FCM_PROJECT_ID`
   (and optionally `FCM_ENDPOINT` for tests). No new bindings are strictly required — the existing
   `DEVICES` DO is reused; a `PUSH_RATE_LIMITER` namespace is optional.
5. **A physical device with Google Play services** (the S24 Ultra) for end-to-end; an emulator with
   the `google_apis` image cannot exercise FCM.
6. **Client identifier decision**: register and send `fid` (per current docs) or legacy registration
   `token`. Pick one; keep it behind the `PushBridge`/`FCM_ENDPOINT` seam so it is a one-line change.

---

## 11. Open questions

- `fid` vs `token`: confirm against the installed `firebase-messaging` version before writing code;
  docs currently deprecate `token`, but `fid` support is newer and must be verified on-device.
- Should the wake be sender-triggered only (this design) or also sender-*connection*-triggered (a
  paired sender coming online rings the phone automatically)? Start sender-triggered; auto-ring needs
  a stricter abuse budget.
- Is the `WakeCommand` produced by `onMessageReceived` enough for `ReceiverService` to pick the right
  pairing, or does it need to read `Store` first? Keep parsing allocation-only; read storage in the
  service.
- Should `push-target` registration happen while the app is in the foreground only, or also from the
  background service on first authenticated join? Foreground-on-enable is simplest and most private.

---

## 12. Sources (official, current at time of writing)

Android / FCM:

- Message priority and high-priority obligations: https://firebase.google.com/docs/cloud-messaging/android/message-priority
- Receiving messages (`onMessageReceived`, data-only behavior, background limits): https://firebase.google.com/docs/cloud-messaging/android/receive
- Send API reference (`Message`, `AndroidConfig`, `data`, `fid`/`token`, `collapse_key`, `ttl`): https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
- Send with the v1 API / OAuth scope: https://firebase.google.com/docs/cloud-messaging/send/v1-api
- Message types / set-message-type (data vs notification): https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type
- Manage registration tokens / FIDs, `UNREGISTERED` & `INVALID_ARGUMENT`, 270-day expiry: https://firebase.google.com/docs/cloud-messaging/manage-tokens
- Installations management (delete server-side / client-side): https://firebase.google.com/docs/projects/manage-installations
- `google-services.json` and the Gradle plugin: https://firebase.google.com/docs/android/google-services-plugin-and-file
- FCM delivery behavior / high-priority deprioritization: https://firebase.blog/posts/2024/07/understand-fcm-delivery-rates
- Foreground service background-start restrictions (high-priority FCM exemption): https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- Doze and App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby

Cloudflare:

- Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/

Repository (read-only for this task):

- `worker/device-room.ts`, `worker/index.ts`, `wrangler.jsonc`
- `android/app/src/main/java/in/yash0/cd/{ReceiverService,Store,Protocol}.kt`, `AndroidManifest.xml`, `build.gradle.kts`
- `docs/implementation/android-contract.md`, `docs/implementation/android-platform-research.md`, `docs/adr/0002-paired-android-receiving.md`
