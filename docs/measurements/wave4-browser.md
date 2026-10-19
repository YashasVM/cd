# Wave 4 browser resume measurements

Browser v2 sends are opt-in and carry one named file over the v2 relay. The sender hashes the source in 256 KiB slices before sharing it, then waits for a durable receiver ACK after each 256 KiB chunk. After restart the sender reselects the same file; the receiver reopens its OPFS staging entry, verifies the MAC-protected checkpoint, hashes the committed prefix, and truncates any bytes written after the checkpoint.

The transfer path never builds a whole-file Blob or byte array. It keeps one source chunk and one encrypted record in flight. `__CD_RESUME_TEST_OBSERVER__` reports sender source bytes read, skipped/resumed bytes, receiver bytes committed, and peak per-frame working payload for a browser run. The sender rereads the source once for its immutable whole-file digest and once for the authenticated resume prefix; transferred bytes add one more read. Thus a complete send reads `2 × file size` on a fresh send and `2 × file size` on a resumed send, with the receiver writing only the missing suffix. The page uses the 256 KiB slice size and the serialized durable ACK path, so it has no multi-record in-memory window.

The sender's largest measured payload pair is a 256 KiB source slice plus its 256 KiB encrypted record (about 512 KiB). Receiver instrumentation reports the encrypted frame plus plaintext and hash-update copy, under 1 MiB per chunk. OPFS writes close before the checkpoint update and ACK; OPFS-unavailable browsers show a storage requirement and never fall back to a full-file RAM buffer.

Focused verification: `node --test src/resume-browser.test.js src/resume-protocol.test.js src/incremental-sha256.test.js`. The browser staging tests use a fake OPFS implementation to exercise committed-prefix recovery, crash-tail truncation, corrupted-prefix rejection, safe naming, and wire progress formats. Cross-client relay transfer measurements are recorded by the coordinator's real-browser run.

Live native T3 verification passed browser-to-CLI restart with 8,388,685 bytes,
262,144 explicitly resumed bytes, matching SHA-256, and a peak sender working
payload of 524,352 bytes. Browser-to-browser passed a 50,331,648 byte interruption
and same-page Try again flow with the original private link and source. The
actual downloaded SHA-256 was
355aabf28c5289a31d064799296cea858c5c1f002185cfe5db9f696407efca11,
matching the source. That browser-to-browser run did not sample the exact initial
resume offset. Source identity, checkpoint tamper, corrupt staging, cancellation
write races, and retention rotation are covered by focused behavior tests.
