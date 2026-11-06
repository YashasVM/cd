# Wave 4 authenticated CLI resume

Owner: Agent A. Files: `cmd/cdx/main.go`, new `resume.go`, `resume_storage.go`, their tests, this report. Dependencies: Luna shared v2 protocol/fixtures and relay authorization; browser wire agreement; coordinator live interruption verifier. Existing v1 detached send/status/wait paths remain unchanged.

Commands:

```sh
cdx send --resumable --json ./large.bin
cdx send --resume <transferId> --json ./large.bin
cdx receive --resume '<private #v2 link>' --out ./received.bin --json
```

A plain `receive` with a private `#v2` link also dispatches v2. V2 sends run in the foreground, including captured commands, and ready JSON explicitly includes `version:2` and `mode:"foreground"`. `--detach` and `--request-id` are rejected for v2; existing background `status`/`wait` describe v1 sends. QR output and opt-in progress work. Private links are exposed only after relay admission and durable local capability storage.

Sender capability/checkpoint path: `$CD_STATE_DIR/resume/<transferId>.sender.json` (or the existing default state directory). It contains the master capability, independent random sender token, and sender-token-MAC checkpoint, and is mode 0600. A receiver's adjacent `.cd-<transferId>.checkpoint.json` contains MAC-protected metadata but no master secret; `.cd-stage-*.part` is an exclusive mode-0600 staging file. Checkpoints bind the normalized final destination and staging basename. Sender and receiver expiry must equal the relay's fixed accepted root expiry; readiness persists that authoritative expiry before printing the link.

Each explicit session generates fresh role nonces, verifies the peer proof, and derives separate v2 frame keys bound to both nonces. V1 keys/counters never reset. Each source attempt hashes its entire stream before admission and hashes skipped plus newly streamed bytes again before END. A resumed sender rejects changed filename, exact size, or SHA-256, including same-size changes. Bundles must regenerate identical archive bytes; changed timestamps/order that alter archive bytes reject resume.

The receiver authenticates checkpoint metadata, rejects expired/stale sessions and unsafe/replaced staging entries, rehashes the durable prefix, and truncates uncommitted tail bytes. Every 256 KiB chunk is written and synced, then checkpoint metadata is atomically written and synced, with directory sync before ACK. Sender stop-and-wait bounds in-flight payload to one chunk. Completion verifies the whole SHA-256 and END counts before exclusive publication. The destination is durably published before encrypted COMPLETE; both clients await the relay's completed control before checkpoint/capability cleanup. If interrupted after publication, the retained stage and destination must refer to the same file before recovery can complete.

Receiver cancellation via SIGINT/SIGTERM removes its checkpoint and staging. Network loss or process termination without cleanup retains committed progress. Sender interruption retains its private capability so the foreground send can be explicitly resumed; this is a pause policy rather than destructive sender cancellation. Completed transfers remove receiver staging/checkpoint and sender capability. Startup examines at most 128 private sender records for authenticated expiry cleanup; an expired receiver checkpoint is authenticated before adjacent staging cleanup. Corrupt metadata is never used to delete arbitrary paths.

Acceptance tests cover shared nonce/ciphertext/checkpoint fixtures, durable prefix recovery and tail truncation, checkpoint MAC modification, changed staging bytes, symlinks/path traversal/private metadata permissions, same-size source changes, whole-digest END modification, v2 flags, and explicit foreground policy. Targeted resume checks passed in 0.012 seconds; full Go tests passed in 5.255 seconds before the final expiry-only changes. The coordinator reruns final integrated checks.

Coordinator live result on 2026-10-09: **3/3 scenarios passed**. A 32 MiB + 77 byte transfer interrupted and restarted in **1.876 seconds**, resumed **262,144 verified bytes**, and reported that exact value in receiver JSON `resumedBytes`. SHA-256 matched the source. Same-size changed source and tampered checkpoint scenarios failed actionably without accepting altered content. Measurements use local relay and Linux filesystem durability; internet speed and other filesystem/platform durability behavior are not inferred.
