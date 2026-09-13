# Security policy

## Supported versions

Security fixes are released only for the latest version on the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue containing an unpatched vulnerability, a live share
link, or its URL fragment.

Include the affected commit, reproduction steps, expected impact, and whether
the issue concerns the browser-to-browser path or `cdx` agent transfers. You
should receive an initial response within seven days.

## Security model

Agent transfers are live and end-to-end encrypted. The URL fragment contains
the transfer key and is not sent in HTTP requests. The relay sees a random
transfer identifier, timing, byte counts, and encrypted frames; it does not
store file contents or receive the master key. Anyone who obtains the complete
link while its sender is online can receive the file, so treat the link as a
secret and let it expire after use.

This model does not hide traffic metadata, protect a compromised endpoint, or
provide resumable/offline storage. See [the protocol](docs/agent-transfer-v1.md)
for exact limits and wire behavior.

Browser-to-browser and Android transfers use WebRTC encryption and a random
128-bit rendezvous code. CD's Worker coordinates signaling but does not carry
file bytes. WebRTC may contact public STUN servers for NAT discovery; those
servers can observe endpoint IP addresses but not transfer contents. The `cdx`
path uses only `cd.yash0.in` and does not need STUN or PeerJS infrastructure.
