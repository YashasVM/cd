# Verification ledger

Status: implementation in progress; not release verified.

## Evidence collected

- Separate worktree `/home/yvm/code/cd-nearby`, branch `feat/cd-nearby`; app additions confined to `nearby/`.
- Built-in Image Gen produced `design/concept.png` at 1536 × 1024. The reference was inspected with `view_image`.
- `npm run build` passed: TypeScript validation and Vite production bundle.
- Discovery's three initial offline unit tests passed: parsing, self filtering, expiry, and name sanitization.

## Environment blocks (observed, not assumed)

- `npm run dev` fails with `listen EPERM: operation not permitted 127.0.0.1:1420`.
- Rust loopback tests cannot bind sockets: `Operation not permitted (os error 1)`.
- `cargo check --manifest-path src-tauri/Cargo.toml --offline` cannot resolve uncached `tao`, required by Tauri's native runtime.
- Shell DNS/package fetching cannot reach crates.io in this sandbox.
- T3 `preview_open` is rejected: `MCP tool call requires approval, but approval policy is never`. No alternative browser was used to bypass that restriction.

## Required visual comparison

No rendered screenshot exists yet. Fidelity is **not verified**. The required comparison at the concept's 1536 × 1024 viewport must inspect:

| Area | Reference target | Current evidence |
| --- | --- | --- |
| Layout | Quiet sidebar, wide dropzone, separate orbit column | CSS implemented; render pending |
| Typography | Large serif headline, 28px section headings, small deliberate controls | Tokens implemented; render pending |
| Palette | Paper, charcoal, persimmon; thin neutral borders | Tokens implemented; render pending |
| Controls | File/folder actions, invitation actions, activity navigation | Components implemented; interaction check pending |
| Spacing and containers | Open whitespace with one dashed drop target | CSS implemented; render pending |
| Responsive behavior | Top nav and stacked columns on narrow screens | Breakpoints implemented; viewport check pending |
| Copy | Reference strings with honest native/browser status | Source implemented; visible copy comparison pending |

Document intentional deviations in `DESIGN.md`: genuine OS window decoration, crisp text monogram, honest browser/discovery status, and real workflow dialogs.

## Completion gates

- Build the desktop executable and launch it with a working tray.
- Send a file and a nested folder between two engine instances; compare all resulting bytes.
- Interrupt a transfer, verify retained progress, resume, and compare the complete result.
- Reject bad certificate pins/tokens, traversal manifests, and destination collisions.
- Check two discovery instances, device expiry, and errors without a multicast route.
- Exercise desktop file/folder dialogs, native drop, invite clipboard, explicit receive acceptance, pause/resume, revoke, and reveal.
- Inspect the app in the shared browser at desktop and mobile widths, capture screenshot, and compare both screenshot and reference with `view_image`.
- Record remaining limitations accurately; do not infer functional success from a successful build.
