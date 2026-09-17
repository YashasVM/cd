# Highway identity, device trust, and recipient discovery

Status: PASS with explicit offline limits (researched 2026-09-17)

## Recommendation

Use Clerk as the online account and session authority, and give every app
installation its own signing key. Android should use a non-exportable key in
Android Keystore (prefer StrongBox when available). The Linux target is a
headless Go daemon: its private key and app credential belong in the OS
keyring/libsecret (with restrictive file-permission fallback), not in a browser
cookie or plaintext config. A short-lived browser bootstrap proves the Clerk
identity and causes the backend to issue an app-owned device certificate; the
Clerk token never needs to cross into the daemon. The device public key is registered
against the authenticated Clerk `userId`, and every transfer handshake proves
possession of the private key by signing the fresh transfer transcript.

The server owns the online enrollment and trust decision. It verifies Clerk's
session token, looks up the device record and receiver's active trust grant,
and issues a signed offline admission certificate. A receiver auto-accepts a
sender only when the sender's device signature verifies and a valid cached
certificate grants that sender access. This is an explicit proposal: trust is
receiver-controlled for incoming transfers; bilateral user approval is not
required. The existing transfer protocol's per-record AEAD and receiver
admission remain required; identity is an authorization layer, not a
replacement for transfer encryption (`docs/agent-transfer-v1.md`).

## Clerk and platform facts

- Clerk's Android SDK supports native auth, session management, hosted browser
  auth, and `Clerk.auth.getToken()`. Hosted auth returns to the app through the
  registered `clerk://<package-name>.callback` callback. Production Android apps
  must enable Native API and register the package name/namespace in Clerk's
  Native applications settings. Minimum requirements in the quickstart are
  Android API 24 and Java 17. [Android quickstart](https://clerk.com/docs/android/getting-started/quickstart)
  and [hosted auth](https://clerk.com/docs/android/guides/account-portal/hosted-auth).
- Clerk documents Android/native SDKs and browser frontend SDKs, but this
  repository's Linux target is a headless Go daemon. There is no documented
  Clerk Go-daemon login/session-refresh flow in the sources reviewed here.
  Treat browser-to-daemon bootstrap as an application protocol to design and
  test, rather than claiming it is a Clerk-supported native flow. Recommended
  bootstrap: the daemon generates a high-entropy nonce and key pair, opens an
  HTTPS Clerk page with a one-time bootstrap ID, and polls the backend over
  HTTPS while proving possession of the private key. After browser sign-in,
  the page sends its short-lived Clerk token plus the bootstrap ID and daemon
  public key to the backend; the backend validates the token, binds the
  `userId`, and makes the certificate available to the daemon's authenticated
  poll. This avoids putting a Clerk token in argv, a URL, a clipboard, or a
  loopback request, and the daemon stores only the app credential/certificate
  in the OS keyring. Clerk documents that session tokens are short-lived JWTs
  (60 seconds) and frontend SDKs refresh them while online.
  [How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview)
  and [session tokens](https://clerk.com/docs/guides/sessions/session-tokens).
- The API must validate signature, `exp`, and `nbf` on every online request.
  Clerk supports networkless verification when the backend is configured with
  its JWT public key (`jwtKey`/PEM); otherwise the verifier retrieves JWKS.
  Set `authorizedParties` explicitly. [Manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
  and [`authenticateRequest()`](https://clerk.com/docs/reference/backend/authenticate-request).
- Clerk's Backend API `users.getUserList({ query })` partially matches
  `userId`, email, phone, username, first/last name. Keep this call server-side
  and return a deliberately small recipient projection; never put the Clerk
  secret key in Android or browser code. [getUserList](https://clerk.com/docs/reference/backend/user/get-user-list)
  and [clerkClient](https://clerk.com/docs/reference/backend/overview).
- Clerk's current Hobby plan is free, requires no credit card, and includes up
  to 50,000 monthly retained users per app. It has a fixed seven-day session
  lifetime; custom session lifetime, passkeys, biometric sign-in, MFA, and user
  bans are listed as unavailable on Hobby. Use only included email/social auth
  and the fixed lifetime to honor the no-bill requirement. [Clerk pricing](https://clerk.com/pricing)
- Android Keystore keeps key material non-exportable and can bind it to TEE or
  StrongBox hardware; availability must be checked and StrongBox is optional.
  [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- Web Crypto defines opaque `CryptoKey` objects, supports non-extractable keys,
  and expects persistent browser storage such as IndexedDB, but does not
  guarantee hardware-backed storage or protection from a user/process with
  access to the browser profile. Therefore Linux browser trust is profile
  scoped and best effort; profile deletion or origin reset loses the device
  identity. [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)

## Required configuration

Public values may be shipped to clients; secret values belong only in Worker
secrets or server-side environment configuration. Use names like these (do not
commit values):

```text
VITE_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...                 # Worker secret; never client-side
CLERK_JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----...  # Worker secret/config
CLERK_AUTHORIZED_PARTIES=https://cd.yash0.in,https://<instance>.clerk.accounts.dev
CLERK_FRONTEND_API_URL=https://<instance>.clerk.accounts.dev
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...   # only if syncing user changes
```

Configure Clerk's Native API and Android package/namespace; configure the
chosen email/social providers; keep the production instance on the Hobby plan;
and register the web origin used by the Linux browser. The Android
`clerk://<package-name>.callback` is a native redirect URI, not an
`authorizedParties` value; `authorizedParties` should contain the HTTPS
origins that are allowed to call the backend. In Wrangler, expose
only the publishable key as a public variable; store secret/JWT/webhook values
with `wrangler secret put`. If persistence is implemented in Cloudflare, add a
D1 binding (for devices/trust/search projection) and keep Durable Objects for
the live transfer room. This stays within free hosted tiers only while actual
usage remains under their current limits; Clerk can require an upgrade above
50,000 retained users.

## Authorization contract

The minimum server records are:

```text
devices(device_id, clerk_user_id, public_key, platform, created_at,
        last_seen_at, revoked_at, trust_epoch)
trust_grants(receiver_user_id, sender_user_id, sender_device_id, state,
             created_at, revoked_at, expires_at, version)
```

Implement these authenticated API operations:

1. `POST /api/devices/register` accepts a Clerk-authenticated request and a
   public key plus a proof-of-possession signature over a server nonce. It
   creates a new device identity; re-registering an existing key is idempotent.
2. `GET /api/recipients?q=` authenticates the caller, searches Clerk with
   `users.getUserList`, and returns only stable `userId`, display name, and a
   redacted identifier. Rate-limit and paginate it; do not expose the full
   directory or let a caller choose another user's device IDs directly.
3. `POST /api/trust-grants` lets the receiver grant or revoke incoming access
   for a sender user/device after the receiver authenticates and the target
   device signs a challenge. Store direction and state explicitly; this
   proposal does not require a second, bilateral user grant. Revocation
   increments the receiver's `trust_epoch`.
4. `POST /api/device-certificates` verifies Clerk auth, device signature, and
   the receiver's active grant, then signs a bounded offline certificate
   containing sender/receiver user IDs, device IDs, certificate issue/expiry,
   receiver trust epoch, and the certificate's allowed transfer purpose. This
   is an enrollment/sync operation, not a per-transfer gate.

Auto-accept is therefore a local receiver rule: accept every sender covered by
an unexpired receiver-issued certificate, with no per-transfer prompt. Unknown,
unenrolled, expired, or signature-invalid devices are rejected. A new transfer
does not call `/api/lan-ticket` or any other server endpoint: each peer creates
a fresh random transfer ID, exchanges the cached certificate, and signs a
nonce-bound transcript containing both device IDs, roles, capabilities, and the
transfer ID. Bind the existing AEAD session to that transcript to prevent
replay or cross-user use.

## Offline LAN and revocation limits

Clerk cannot be the sole offline gate: its session token is only valid for
about 60 seconds and refresh requires connectivity. After an online enrollment,
cache the minimum local state (own device key, peer public keys, receiver trust
grant, certificate, and trust epoch) and let the LAN path verify signatures
locally. Use a bounded certificate expiry and a monotonically increasing
receiver revocation epoch. On the next online contact, refresh certificates,
sync revocations, and reject stale epochs. The receiver can issue certificates
for its own enrolled devices while online; the sender only needs its cached
certificate to start a new transfer while disconnected.

Revocation is not instantaneous while both endpoints are offline: a device that
was revoked after its last ticket can continue until that ticket expires or
the receiver obtains the newer epoch. The UI must show the last online sync and
the ticket expiry. Never present offline authorization as proof that the Clerk
account is currently active. A lost Android app installation or reset Linux
browser profile loses its private key and must enroll again; a copied public key
alone cannot impersonate the device.

## No-bill boundary and implementation split

The free design can use Clerk Hobby plus existing Cloudflare Worker/Durable
Object infrastructure, with a free D1/KV-backed identity projection if needed.
It cannot promise unlimited users, paid-only Clerk controls, or zero operating
cost at arbitrary scale. Keep the first implementation independent of live
credentials: define the API/types, signature and ticket codecs, local key
storage adapters, and fake Clerk verifier/tests first. Wiring production only
needs the publishable key, JWT public key, secret key, and Native API/package
configuration above; no secret should enter the repository or client bundle.
