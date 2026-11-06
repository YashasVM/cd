# Review findings ledger (coordinator notes)

## ISP/NAT (opencode beam-free) — done
- Browser senders never offer direct (confirmed). Indian mobile = CGNAT, often endpoint-dependent mapping → STUN hole punching fails; TURN needed. Cloudflare Realtime TURN: Worker mints short-lived creds; $0.05/GB after 1 TB/mo free.
- India IPv6 ~72% (Jio/Airtel mobile ~95%): IPv6 host candidates can connect directly without TURN. Hathway/BSNL IPv4-only.
- Only 2 STUN servers (Google, Twilio).
- Diagnostics: show path (direct same-network / direct internet / relay) + RTT in progress panel; getStats candidate-pair types. pion `route()` in direct.go:248 already classifies.
- ACTION: route badge next to speedometer (integration); TURN = follow-up (needs CF Realtime app + secret; ask user).

## Sinks (opencode nemotron-3-ultra) — done
- share.js:399 / main.js:907 await sink.write serializes decrypt/write (brecv agent covers).
- createPickerSink (sink.js:74) has no write batching vs OPFS sink's 512 KiB FLUSH_BYTES (brecv scope; verify they did it).
- main.js:897 Blob.arrayBuffer() copy in legacy P2P path (minor).
- OPFS createWritable vs worker SyncAccessHandle: bigger change, follow-up.
- zip-unbundle has no CRC check: AES-GCM already authenticates; not a speed item.
