# CD design

How CD looks, feels, and behaves — the principles behind
[cd.yash0.in](https://cd.yash0.in) and the exact visual spec that implements
them.

## Principles

### 1. Private by construction, not by policy

The encryption key lives in the URL fragment (`#v1.<key>`). Browsers never
send fragments to any server, so the relay literally cannot see file bytes,
filenames, or keys. Privacy comes from the URL shape itself — no setting to
toggle, no promise to trust.

Privacy rules that follow from this:

- Relay sees only transfer IDs, ciphertext sizes, roles, and timing.
- All peer messages are AES-256-GCM authenticated.
- The receiver join token is HKDF-derived, so a route copied from server logs
  cannot steal the receiver slot.
- The browser trusts the JavaScript served by `cd.yash0.in` — a compromised
  origin breaks everything, and we say so openly instead of hiding it.

### 2. Never store a file

CD is a pipe, not a bucket. The relay forwards bounded encrypted records and
persists no file contents. Rooms are ephemeral (2 hour max lifetime, short
terminal tombstones, no reuse). There are no accounts, no uploads queue, no
cloud detour — "no cloud detour" is the tagline under the logo for a reason.

### 3. One live transfer, explicit consent

One sender and one receiver per room. The receiver sees what is coming
(filename, size) and accepts before a single chunk flows. Nothing downloads
itself. The orange interface is the receiver for both flows, and every
destructive or committing action (connect, cancel, retry) is a visible button.

### 4. Fail loudly, never silently

- CLI exit `0` means the receiver verified every byte. `1` means failure.
  `2` means invalid usage. Status goes to stderr, the URL goes to stdout.
- The sender prints its URL only after the relay admits it — never a dead
  link.
- The end record authenticates total bytes and chunk count, so changed,
  reordered, duplicated, missing, or extra content is detected without
  re-reading the file.
- No resume in v1: a dead transfer fails clearly and restarts with a fresh
  capability URL.

### 5. Bounded everything

Large files must not eat the device. 64 KiB chunks, 1 MiB unacknowledged
window, 2 MiB pending-input cap. The receiver acknowledges a chunk only after
it owns the bytes. Sinks degrade gracefully: File System streaming, then
Origin Private File System staging, then Blob download — capped at 256 MiB on
WebKit, where large blob downloads crash real devices.

### 6. Small surface, flat code

One narrow release contract: one regular file from `cdx` to one browser.
Browser-to-browser WebRTC and Android are separate clients, not dependencies.
Modules stay flat; no package splits that add reader work without improving
the contract. Same-origin throughout — no second domain, no extra service.

### 7. Proven, not claimed

Every release path is exercised end to end: the real CLI, the real Worker,
the built receiver in Chromium, comparing exact downloaded bytes — against
production as well as locally.

## Visual identity

CD looks like the rest of yash0.in: warm paper-on-ember dark, serif brand
voice, mono for machine values. Dark only — there is no light theme.

### Palette

| Token | Hex | Usage |
|---|---|---|
| `bg` | `#0d0503` | Page, status/nav bars, PWA theme + background |
| `text` | `#e4d4b6` | Primary text (warm paper) |
| `accent` | `#e58a57` | Burnt orange. Share codes, progress, active states, links. Reserved for "the thing that matters on screen" |
| `accent-soft` | `#6b2f1c` | Deep ember. Progress gradient start, text-selection background |
| `muted` | `#b3a38c` | Secondary text, descriptions, stats |
| `faint` | `#a28f79` | Kickers, labels, hints, watermark |
| `selection` | `#ffe4bf` | Selected text (on `accent-soft`) |
| `panel` | `#160907` | Cards, share/progress/result panels |
| `block` | `#1b0d09` | Inner blocks (code, QR frame, stat cells, status) |
| `ink` | `#070707` | Code input, QR canvas, pre blocks |
| `button` | `#e58a57` | Primary action; hover `#f4a579` |
| `line` | `rgba(228,212,182,.15)` | Borders, dividers (`#e4d4b6` at 15%) |
| `error` | `#ff5d2a` on `#5a160b` | Error marks; error copy in `#ff8a62` |

Rules:

- Accent is scarce. If everything glows, nothing does — body copy, panels,
  and chrome stay paper-on-ember; orange marks codes, progress, and the one
  primary action per view.
- Primary buttons use dark text on the accent for contrast.
- Errors are the only red on screen (`#ff5d2a` / `#ff8a62`).
- QR codes always sit on near-black (`#070707`) for scan contrast.

### Typography

| Role | Stack | Used for |
|---|---|---|
| Brand | `Georgia, "Times New Roman", serif` | `cd` wordmark, doc headings. Lowercase, weight 400, tight tracking |
| UI | `Inter, system-ui, sans-serif` | Everything humans read: headings, buttons, descriptions |
| Mono | `ui-monospace, SFMono-Regular, Menlo, monospace` | Codes, URLs, sizes, stats, labels, kickers |

Rules:

- Share codes are 25px mono, `user-select: all`,
  wrapping anywhere — built to be copied, not admired.
- Kickers and labels are 9–11px uppercase mono with wide letter-spacing.
- The wordmark is always lowercase `cd` with the `/di·rect/` tagline.

### Shape and motion

- Panels: 6–12px radius, 1px `line` border, flat `#160907` fill, no translucency
  and no heavy shadow — the reference is textured, not glassy.
- Buttons: 5px radius, minimum 44px touch target, lift 1px on hover.
- Progress is high-contrast on purpose: gradient fill (`accent-soft` to
  `accent`) with a gentle glint and a 🦕 rider that bobs above the current
  position. The one playful element marks the one thing users watch.
- One background flourish only: a fixed ember-glow gradient with a sparse dot
  grid, masked to the top 62% of the viewport. Nearby dots ease away from a
  mouse or pen cursor, then return to the grid. Touch leaves them still.
- The brand and transfer panel enter once. Tab panels and new transfer states
  rise a few pixels into place. Buttons respond to hover and press.
- Phone-first: full-width primary actions, 48px+ controls, safe-area padding, no
  horizontal overflow at 320px. `prefers-reduced-motion` disables all motion,
  including cursor response and the dino.

### Voice

Short, dry, lowercase-adjacent. States read `waiting for receiver...`,
results read `Sent. Nice.` / `All here. Nice.` Errors say what happened and
offer one action (`Try again`). No onboarding tour, no marketing adjectives —
the tagline is the whole pitch: `/di·rect/ — no cloud detour`.
