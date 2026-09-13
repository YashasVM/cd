# Agent sharing test matrix

CD uses its own encrypted live relay and needs no cloud storage or token.

| Case | Expected result |
|---|---|
| `cdx send notes.txt` | One complete `https://cd.yash0.in/s/<id>#v1.<key>` URL on stdout; process waits for completion |
| `cdx send notes.txt --json` | One object containing schema `version`, `url`, `filename`, and numeric `size` |
| Missing or non-regular file | Nonzero exit and no stdout invitation |
| Unicode filename | Decrypted browser offer preserves the exact safe basename |
| Receiver before sender | Relay closes with sender-unavailable status |
| Wrong receiver secret | Relay rejects admission without exposing the sender |
| Duplicate sender or receiver | Relay rejects the second role occupant |
| Silent upgraded sockets | Join deadline closes them and releases the room cap |
| Large or multi-chunk file | ACK window bounds queued data and exact bytes arrive |
| Sender exits early | Browser reports that the live transfer is unavailable |
| Receiver verifies counts | Sender exits 0 only after the encrypted completion receipt |
| Mobile browser | Orange CD receiver asks for consent and exposes a download after verification |
| Browser/Android P2P code | 128-bit base64url code; full link stores it only in `#p2p.<code>` |
| Malicious P2P manifest | Receiver rejects traversal names, bad counts, oversized files, and byte mismatches |
| Missing completion ACK | Sender fails instead of reporting a successful transfer |

`npm run verify:agent` automates the protocol, relay, CLI, and exact-byte cases.
The browser deep-link path and Android build/lint/unit checks are automated;
an actual two-device transfer remains a release QA check.
