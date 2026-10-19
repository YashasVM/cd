# Wave 1: quiet agent workflow

Owner: Agent B. Dependencies: Agent C forwards `sendRequest.progress` through
`holderArgs` and initializes the holder's progress policy. The coordinator adds
package scripts `skill:generate` (`node scripts/generate-sharing-skill.mjs`) and
`skill:check` (same command with `--check`).

Human terminal stderr keeps automatic progress unless `--json` is selected.
Captured output and JSON results require explicit `--progress`. JSON progress
stays on stderr, at most once per second plus completion; stdout stays one
compact result object. Explicit human progress on a pipe uses newline-terminated
lines without cursor controls. Routine transfer messages follow the human
progress policy; JSON output suppresses these messages. Failures and skipped-file
warnings remain actionable.

Owned implementation: `cmd/cdx/main.go`, `progress.go`, `sender.go`, `receive.go`,
`agent.go` and their tests; both sharing skill copies; source skill and generator;
this measurement document. No changes to detached process ownership or transport.

Acceptance checks:

- `go test ./... -timeout 30s` passed (CLI package 0.312s).
- Argument tests cover send and receive with default, JSON, progress, and both flags.
- Progress policy tests cover every terminal/JSON/opt-in combination.
- Explicit progress output tests verify compact JSON and pipe-friendly human lines.
- Existing error-reporting and usage tests pass unchanged.
- `node scripts/generate-sharing-skill.mjs --check` passed. Go tests compare the
  embedded and repository copies to the source, catching drift without Node.

Repeatable output measurement: run `go test ./cmd/cdx -run
TestQuietMachineProgressMeasurement -v`. For two sending samples (10 and 100
bytes of a 100-byte file, 20 ms apart), the previous implicit captured JSON
progress policy emits 149 bytes / 2 lines. The new default emits 0 bytes / 0
lines. Explicit JSON progress retains those 149 bytes / 2 lines. This fixture
measures progress only; whole-transfer output and timing belong to Agent A's
transport benchmarks. Ready and received JSON were already compact and remain
one line each.

Skill measurements (`wc -lc`): 2549 bytes / 58 lines before, 1841 bytes / 39
lines after: 27.8% fewer bytes and 32.8% fewer lines. Edit
`skills/cd-file-sharing/source.md`, then run the generator to update both copies.
A stale copy causes `--check` and the Go embedding test to fail.
