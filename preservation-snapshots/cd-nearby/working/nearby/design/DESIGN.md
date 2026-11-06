# Nearby design specification

The built-in Image Gen concept is `concept.png` (1536 × 1024). Its brief: a complete CD Nearby desktop transfer desk, warm paper, charcoal typography, persimmon primary actions, serif editorial headings, a quiet sidebar, generous drop area, live device orbit, recent handoffs, and a fine status footer. All UI is implemented as real text and controls, not a screenshot.

## Tokens and structure

- Background #f6f5f1, slightly lighter workspace #faf9f6, text #242621, secondary #757975, border #deded7, accent #e65c35, success #57934e.
- Sidebar 236px at 1440 width; workspace 44px padding. Primary split approximately 60/40. Main drop target 350px high. At narrow widths sidebar becomes a top navigation bar and columns stack.
- Headings: Georgia serif; hero 58px/1.05, section 28px/1.2, modal 30px. Body/system controls: system sans, 14px/1.5, small 12px. Controls always inherit deliberate sizing.
- Icons: Lucide outline, 1.6 stroke, 18–22px for controls, 40px drop target, 25px laptops. Orange typographic `cd` monogram is text, not a raster logo.
- Radius: 12px drop area and forms, 10px buttons, circular orbit nodes. Borders 1px. No card grid or stacked decorative widgets.
- Animation: subtle orbit pulse only during discovery, progress bar width transition, short modal enter; reduced-motion disables animation.

## Allowed primary-screen copy

Nearby; by CD; Transfer; Activity; Settings; This device; My computer (actual device name replaces it); Ready to receive; A little closer.; Big files. Short distances. Straight to their device.; Pair a device; Send something good.; Drop files here; Or choose a file or folder to get started; Choose files; Choose folder; Just your devices. No cloud in between.; In your orbit; Listening; Looking for nearby devices; Open Nearby on another device on this network.; Connect with an invite; Recent handoffs; View activity; Your next handoff starts here.; Completed transfers will appear here.; Local network; Encrypted device-to-device.

## Functional extensions and intentional deviations

The concept's decorative OS traffic lights are omitted: Tauri provides genuine window decorations. The generated textured monogram is replaced by a crisp typographic mark for clarity at all sizes. Orbit satellites are illustrative and never represented as actual peers; real presence appears in a separate list. Discovery failures and browser-only preview are disclosed, replacing Listening/Ready labels so the UI never invents connectivity.

Required workflow states extend the same system: selected-file review and share invite; inspect incoming offer and choose a destination before acceptance; transfer progress with pause/resume and verified completion; activity filter; settings for device name and receive directory. Dynamic data replaces example copy. Native file dialogs and drag/drop select local paths. The standalone browser UI is explicitly a preview, with no simulated successful transfers.

Pairing here means authenticated per-handoff invitation, not persistent trust or automatic acceptance. No invite secret is advertised through LAN discovery. Local source files stay on the sender; only the receiver retains partial data to resume.
