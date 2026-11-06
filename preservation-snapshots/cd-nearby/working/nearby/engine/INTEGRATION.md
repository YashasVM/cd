# Native transfer engine integration

The crate at `nearby/engine` exposes a synchronous Rust API intended to run from Tauri with `tauri::async_runtime::spawn_blocking`.

```rust
let engine = Engine::new(device_name, app_data_dir)?;
let share = engine.share(selected_paths)?;
let offer = engine.inspect_invite(invite_text)?;
let id = engine.receive(invite_text, destination)?;
engine.pause(&id)?;
engine.resume(&id)?;
engine.revoke(&share.id)?;
engine.set_device_name("My laptop".into())?;
let snapshot = engine.snapshot();
```

`share` starts a background TLS server and returns a `nearby:` invitation. The invite contains the peer address, a one-use random access token, and the SHA-256 fingerprint of a per-share self-signed certificate. The receiver pins that fingerprint before any application request is sent. `inspect_invite` performs a read-only authenticated offer request; `receive` starts the actual download after the UI has shown that offer and the user accepts it.

All public data structs derive serde serialization with camelCase field names. `Snapshot.transfers` includes outgoing shares and incoming transfers, with `direction` equal to `send` or `receive`; statuses are `waiting`, `transferring`, `paused`, `completed`, or `failed`. A receiver's `outputPath` is set after successful publication. Files are written below a newly-created destination directory and published without replacing existing files. Interrupted downloads keep their partial bytes for `resume` during the current engine session; restart persistence is not implemented yet. `revoke` immediately invalidates an outgoing invitation. `set_device_name` affects new offers.

The engine uses only direct LAN sockets. It does not use a cloud relay or store shared file contents remotely. The transport is bounded-memory and streams each file in 64 KiB buffers. Paths are represented as normalized relative paths; symbolic links and special files are rejected.

## Platform note

The implementation currently uses the OpenSSL crate for certificate generation and TLS. Desktop targets need OpenSSL development/runtime support available to the Rust build. For production signing, ship the platform's native OpenSSL dependency or replace the TLS backend without changing the public engine API.
