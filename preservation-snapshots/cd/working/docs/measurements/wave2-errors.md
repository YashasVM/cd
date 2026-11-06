# Wave 2: typed failures and setup retries

Owner: Agent B. Dependencies: coordinator request journal and readiness transfer
ID; Agent A persists holder failures as `{kind,message,retry}` and reconstructs
`NewFailure` instead of reclassifying log text. Agent C owns request/process
integration verification.

Shared contract: `Failure{Kind, Message, Retry string; Cause error}` implements
`Error` and `Unwrap`. `NewFailure(kind,message,retry,cause ...error)` constructs it.
Guidance values are `never`, `same_request`, `new_transfer`.
`classifyFailure` uses only typed failures, cancellation, filesystem error types,
and network error types. `failureGuidance` survives wrapping. Human messages
remain actionable; compact JSON adds `error.retry`. Plain error wording does not
assign a kind. Existing stable kinds remain unchanged.

All local source/receive validation, malformed invitation, protocol record,
WebSocket close-code, code-directory response, stall and expiration producers in
owned files now emit typed errors. Sender obtains identity from
`invitationForRequest` and includes `TransferID` in readiness. Wrapping the legacy
code-claim fallback preserves the original failure and guidance.

Automatic retries apply only to WebSocket dialing before sending the relay join,
and read-only code lookup GET. Three attempts maximum; backoff is 100–150 ms then
200–250 ms, cancelable through context. HTTP 429/5xx and transient network setup
errors retry. Permanent HTTP errors, missing DNS names, and certificate validation
errors do not retry. Code claim POST, admitted joins, acceptance, and transfer
records are never automatically replayed.

Acceptance and measured results:

- `go test ./... -timeout 30s` passed (1.911s before final close-code cause update).
- Focused contract/retry tests passed (0.715s): opaque wording remains stable,
  untyped wording falls back to `failed`, wrapping preserves cause and guidance,
  compact failure output stays one stdout line, and cancellation aborts backoff.
- Deterministic retry fixtures recover on attempt 3 or exhaust after exactly 3;
  permanent and admitted-disconnect fixtures make exactly 1 attempt.
- HTTP lookup fixture makes 3 GETs (0.33s), stops when the response succeeds, then
  validates malformed content as a protocol failure. A 503 code-claim fixture
  makes exactly 1 POST.
- WebSocket setup fixture returns two 503s then opens on attempt 3 (0.38s); an
  expired close after opening adds no attempts. HTTP401 makes 1 attempt and
  reports `retry=never`. Permanent missing DNS makes 1 attempt.

Reproduce with `go test ./cmd/cdx -run
'Test(RetrySetup|DialRelay|SetupDoes|CodeLookup|Classif|FailureGuidance|ReportFailure|FriendlyRelay)'
-v -timeout 30s`. Timing includes deliberate backoff and varies by jitter;
attempt counts and compact result structure are deterministic. Detached sidecar,
request deduplication, and cross-process behavior are verified by A/C/coordinator.
