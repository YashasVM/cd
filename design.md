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
| `panel` | `#160907` | Code blocks and stat cells |
| `workbench` | `#180a07` | Main transfer surface |
| `workbench-tab` | `#1e0d09` | Integrated tab strip |
| `block` | `#1b0d09` | Secondary controls and small inset details |
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

### Forms & components

Every form below is shown live, rendered with the same tokens as the app.
Send and Receive share one workbench, one tab strip, and one button set —
the orange interface is the receiver for both flows.

#### Mode tabs

One tab strip, two modes. The active tab gets paper text and an orange
underline; the idle tab stays faint.

```preview
<div class="pv-tabs">
  <button class="pv-tab pv-tab-active" type="button">Send</button>
  <button class="pv-tab" type="button">Receive</button>
</div>
```

#### Buttons

One primary action per view (dark text on accent), secondary actions for
copies and scans, a small mono cancel for anything in flight. 5px radius,
44px minimum touch target, lift 1px on hover.

```preview
<div class="pv-row">
  <button class="pv-primary" type="button">Choose files</button>
  <button class="pv-secondary" type="button">Copy code</button>
  <button class="pv-cancel" type="button">Cancel</button>
</div>
```

#### Send form

A drop zone (drag files or pick them), a payload card once files are
chosen, then a share panel with the code, the QR, and copy actions.
Nothing uploads until the receiver joins.

```preview
<div class="pv-drop">
  <span class="pv-drop-mark">+</span>
  <div>
    <strong>Send files</strong>
    <p>Drop files here or choose them below. Keep this tab open until they arrive.</p>
    <button class="pv-primary" type="button">Choose files</button>
  </div>
</div>
<div class="pv-file">
  <span class="pv-kicker">payload</span>
  <div class="pv-file-head"><strong>diwali-photos.zip</strong><em>84.2 MB</em></div>
  <span class="pv-sub">3 files · encrypted in your browser</span>
</div>
```

#### Share code & QR

The code is 25px mono in accent, selectable with one tap. The QR always
sits on near-black (`#070707`) for scan contrast. Copy buttons are
secondary — the code itself is the primary thing.

```preview
<div class="pv-share">
  <div class="pv-code-block">
    <span class="pv-kicker">share this code</span>
    <strong class="pv-code">amber-river-42</strong>
    <p>On the other device, choose Receive and enter this code.</p>
  </div>
  <div class="pv-qr-block">
    <span class="pv-kicker">or scan it</span>
    <span class="pv-qr">QR</span>
  </div>
</div>
<div class="pv-row">
  <button class="pv-secondary" type="button">Copy code</button>
  <button class="pv-secondary" type="button">Copy link</button>
</div>
<p class="pv-status">Waiting for receiver...</p>
```

#### Receive form

One mono input on near-black for the code or link, a primary Connect,
and a scan option for the QR. Invalid codes ring the input in
`#ff8a62` — nothing else on screen turns red.

```preview
<span class="pv-kicker">enter the share code</span>
<div class="pv-code-row">
  <input class="pv-input" type="text" value="amber-river-42" readonly aria-label="Share code preview" />
  <button class="pv-primary" type="button">Connect</button>
</div>
<div class="pv-row">
  <button class="pv-secondary" type="button">Scan code</button>
</div>
<p class="pv-sub">Paste the sender's code or link, or scan their QR code.</p>
```

#### Progress

High-contrast on purpose: gradient fill (`accent-soft` to `accent`)
with a gentle glint and a 🦕 rider bobbing above the current position.
Speed / moved / left stats sit in inset cells below. Cancel is always
visible while moving.

```preview
<div class="pv-topline"><span>uploading</span><strong>62%</strong><button class="pv-cancel" type="button">Cancel</button></div>
<div class="pv-bar"><div class="pv-fill" style="width:62%"></div><span class="pv-dino" style="left:62%">🦕</span></div>
<div class="pv-stats">
  <span><b>speed</b><em>12.4 MB/s</em></span>
  <span><b>moved</b><em>52.2 / 84.2 MB</em></span>
  <span><b>left</b><em>3s</em></span>
</div>
```

#### Results

Success reads `Sent. Nice.` / `All here. Nice.` with an `OK` mark and
one next step. Failure is the only red on screen: an `ERR` mark on
`#5a160b`, the message in `#ff8a62`, one `Try again` action.

```preview
<div class="pv-result">
  <span class="pv-mark">OK</span>
  <div><strong>Sent. Nice.</strong><div class="pv-row"><button class="pv-primary" type="button">Send more stuff</button></div></div>
</div>
<div class="pv-result pv-error">
  <span class="pv-mark">ERR</span>
  <div><strong class="pv-err-text">The sender went away.</strong><div class="pv-row"><button class="pv-primary" type="button">Try again</button></div></div>
</div>
```

#### Waiting & status

Connecting shows a spinner (accent tick on a faint ring) with plain
language underneath. Status lines are 12px mono, muted, with an ember
left rule.

```preview
<div class="pv-connect"><span class="pv-spinner"></span><p>Finding the sender...</p></div>
<p class="pv-status">Waiting for receiver...</p>
```

Form rules:

- Every destructive or committing action (connect, cancel, retry) is a
  visible button — no silent states, no auto-downloads.
- The receiver always sees filename and size and accepts before a single
  chunk flows.
- One primary button per view. If two actions look primary, one of them
  is wrong.
- Phone-first: full-width primary actions, 48px+ controls, safe-area
  padding, no horizontal overflow at 320px.

### Shape and motion

- The transfer workbench uses one warm surface with a copper top rule and an
  integrated tab strip. The idle send and receive controls have no inner card.
  Code and QR blocks keep flat inset surfaces so they remain distinct and easy
  to scan.
- Send and Receive share the same resting panel height at each screen size.
  Their controls sit within that space; transfer details can expand it when
  needed.
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
