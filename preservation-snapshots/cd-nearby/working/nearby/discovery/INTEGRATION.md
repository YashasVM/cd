# LAN discovery integration

`cd-nearby-discovery` announces presence on IPv4 multicast group `239.255.77.77:47777` every two seconds. The datagram contains only a random per-process ID, a sanitized display name, and protocol version 1. Peers expire after 10 seconds without an announcement.

```rust
let discovery = cd_nearby_discovery::Discovery::start("Laptop".into())?;
let peers = discovery.peers();
discovery.set_name("Work laptop".into())?;
```

`Discovery` is cloneable; dropping the final clone stops and joins its worker. `Peer` serializes with camelCase fields: `id`, `name`, `address`, and `lastSeen` (Unix milliseconds). `address` is the announcement sender's IP and UDP source port.

Presence is unauthenticated and can be spoofed. A discovered peer is only a convenience for finding a device. Do not treat it as trusted; file transfer still requires the normal invite and acceptance flow.
