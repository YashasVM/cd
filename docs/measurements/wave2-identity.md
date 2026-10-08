# Wave 2 stable local transfer identity

Owner: Agent A. Files: `cmd/cdx/detach.go`, `detach_test.go`, `state.go`, `state_test.go`, this report. Dependencies: coordinator request journal/OS locks and ready-output transfer ID; Agent B typed failures. No transport, compression, paired-device, or infrastructure changes.

State snapshots now live at `<transferID>.json`; a reused numeric code never overwrites another transfer's history. The transfer ID, code, filename, size, holder PID, start time, and log association cannot change after publication. Progress cannot regress and completed history cannot reopen. `status` and `wait` accept numeric codes, explicit transfer IDs, and existing share links. Numeric lookup selects newest start time with descending ID as a deterministic tie breaker. Once `wait` resolves a code, subsequent polling remains pinned to that transfer ID.

Valid legacy `<code>.json` records remain readable and are migrated to the ID path without changing their timestamps. Legacy and canonical copies deduplicate by ID; newer legacy snapshots can still migrate while an older holder is running. Migration never replaces a newer canonical snapshot. Live old holders must not concurrently reuse numeric codes themselves; they predate stable identity and cannot participate in the new locking protocol.

Publication uses a private temporary file, file sync, exclusive initial publication, atomic replacement, and per-ID OS locks. Immutable field conflicts fail instead of rebinding history. Lookup validates canonical base64 IDs, code syntax, filenames, file-key consistency, bounded regular records, version, holder/timestamps, phase, and verified progress. Corrupt managed records are actionable failures. Pruning rechecks snapshots under the same per-ID lock, refuses refreshed state, and deletes only matching records and local `send-<12 hex>.log` files. Empty lock files remain to preserve cross-process lock identity; they contain no transfer data.

Holder PID journaling occurs before source/relay setup. The transfer snapshot and replayable ready journal are written before readiness stdout. Snapshot persistence failure now aborts readiness rather than exposing an unusable code. Structured holder failure sidecars preserve kind, message, and retry guidance across process boundaries; status also retains retry guidance. Human log fallback is never classified by matching words.

Acceptance tests cover two retained histories sharing a code, pinned ID access, deterministic latest lookup, legacy migration and deduplication, live legacy updates, immutable field rejection, invalid/inconsistent records, 40 simultaneous state writes, protected outside logs/reused-code pruning, terminal/progress regression, typed failure sidecars and corruption, and detached startup with a 10,000-file tree plus another file.

Validation command:

```sh
go test -race ./cmd/cdx -run 'TestState|TestHolderFailureSidecar|TestDetachedPreparation' -count=1 -v
go test ./... -count=1
```

Observed 2026-10-09: the targeted race run passed in 2.144 seconds. The detached 10,000-file tree test returned readiness in 56.229427 ms, confirmed its holder remained alive, and checked actionable nested UTF-8 validation errors. All 40 simultaneous writes completed successfully and yielded one valid snapshot. The coordinator performs simultaneous request/lost-response integration tests after merging this owner’s hooks.
