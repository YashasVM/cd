# CD Nearby

A native transfer desk for private file handoffs on a local network. Rust handles the files and encrypted connection; Tauri and React provide the desktop interface. No account, cloud storage, or relay is involved.

This is a separate application in `nearby/`. It does not replace `cdx` or change the existing CD website. Nearby invitations use their own protocol and are not compatible with CD's numeric share codes.

## Run

Requires Node.js 22.12+ (or a supported newer release), Rust stable, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). The engine currently uses OpenSSL, so its development libraries and `pkg-config` are also required on Linux. Windows/macOS packaging has not been verified.

```sh
cd nearby
npm ci
npm run desktop
```

A normal Rust installation should put `cargo` on PATH. On this machine, it is available at `/home/yvm/.cargo/bin/cargo`; the global mise shim may require a Rust version selection.

```sh
npm run build                         # type-check and bundle the interface
npm run desktop:build                 # compile the desktop executable
cargo test --workspace                # engine, discovery, and CLI tests
cargo test --workspace -- --skip network_  # checks that do not require sockets
```

`npm run dev` opens an **interface preview** at `http://127.0.0.1:1420`. File transfer and discovery require the native desktop app. The preview never invents peers or transfer progress.

## A handoff

1. On the sending computer, choose files or a folder, or drop them onto the window.
2. Copy the private invitation and send it to the other person through a channel you trust.
3. On the receiving computer, choose **Connect with an invite**, paste it, and review the offer.
4. Choose the destination and select **Accept & receive**.
5. Watch progress in Activity. Pause or resume an interrupted handoff while both apps remain open. A completed download can be revealed in the file manager.

Nearby discovery lists devices running the app on the same IPv4 multicast network. Presence is not identity or permission: an invitation is still required. If discovery is blocked by your network, invitations can still work between reachable devices. This release does not traverse NAT or offer an internet relay.

Closing the desktop window hides it in the tray so transfers can continue. Use **Quit Nearby** in the tray menu to exit.

## Project layout

- `engine/`: standalone Rust transfer library and protocol tests.
- `discovery/`: bounded multicast presence announcements; no secrets are advertised.
- `cli/`: development command-line companion using the same engine.
- `src-tauri/`: native dialogs, clipboard, tray, preferences, and engine commands.
- `ui/`: React interface, shared components, native bridge, and styles.
- `design/`: generated visual reference, design tokens, and verification ledger.

The desktop crate has its own Cargo workspace so core engine tests do not require a webview toolchain.

## Security and transfer semantics

TLS certificates are pinned to the fingerprint carried by the private invite. An additional secret token authorizes access to the offer and file bytes. Anyone holding an invitation may access the handoff, so treat it like a private link. The sender can stop sharing from Activity.

The receiver explicitly accepts each handoff. Discovery does not create a trusted sender, and there is no automatic acceptance. Local partial files allow recovery without storing a copy on a server. See [engine integration notes](engine/INTEGRATION.md) for the current protocol and resume boundaries.

## Verification status

The initial development environment permits filesystem work but denies TCP/UDP socket binding, outbound package downloads, and the shared browser launch. The interface production build and available offline unit tests can run there. Real network transfer tests, a complete native build, and visual browser verification are **required before release**, and remain unverified until those restrictions are lifted. See [verification ledger](design/VERIFICATION.md).
