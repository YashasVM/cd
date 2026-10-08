# Transfer implementation cycle

Coordinator worktree: `/home/yvm/code/cd-cycle`, branch `cycle/integration`.
Starting snapshot `1ecb37b` preserves existing tracked workspace edits, QR files,
and guides. Original checkout and untracked videos remain untouched.
Workers have separate worktrees and own files per assignment. Each wave is
merged locally and must pass its gate before the next wave is assigned.
Paired devices, compression, and infrastructure experiments are excluded.

## Wave 1

- A: `scripts/bench.mjs`, `scripts/harness.mjs`, benchmark test helpers, measurement report.
- B: CLI main/progress/sender/receive/agent files and their tests; canonical sharing skill and generator, both generated copies; measurement report.
- C: CLI detach/bundle files and their tests; directory benchmark; measurement report.
- Coordinator: CLI direct/link diagnostics; package hooks; this record; integrated checks.

Contracts: captured output is quiet by default; `--json` does not enable progress.
`--progress` explicitly enables progress, JSON on stderr when combined with
`--json`. Human terminal progress remains enabled. Detached holder forwards
`request.progress` and sets `progressRequested` and `jsonProgress` independently.

`CD_DIRECT=0` disables CLI direct transport. `CD_TRANSPORT_REPORT=1` reports
one final stderr object `{transport,relayBytes,directBytes}`. Counts are
successfully sent encrypted record bytes, including retransmitted retained
records. `transport=direct` requires nonzero direct sent bytes.

Gate: existing checks pass, detached sends return while holder remains live,
and invalid inputs/setup failures retain useful explanations. Baselines must
separate readiness from completion and state actual transport and integrity.

## Wave 2 contract proposal

Transfer ID is durable identity; numeric share code is a mutable lookup alias.
History is never stored under a reusable alias. Newest code match is selected
for compatibility, while explicit transfer IDs remain unambiguous.

Failures carry stable kind, human message, and explicit retry guidance. Setup
retries are bounded, cancelable, and limited to typed transient failures.
No automatic retry after peer admission or after records have been sealed.

Coordinator request deduplication is local to the state directory. A request ID
maps to a cryptographic fingerprint of inputs and semantics and exactly one
holder reservation. Simultaneous retries serialize via an OS-backed lock.
Different fingerprints fail explicitly. A lost command response can retrieve
the persisted ready result; stale holders must never appear live.

## Later gates

Wave 3: encrypted browser direct transport proves direct payload bytes;
relay starts immediately, with bounded sender windows and receiver queues.
Transport wiring belongs to A; independent window module belongs to B.
C owns interoperability and fault verification.

Wave 4: resolve checkpoint format, receiver authentication, file identity,
retention and fresh session keys in issue #15 before assignments. Checkpoints
must only claim durably written verified progress. Reconnect must authenticate
both roles, verify the retained prefix and immutable source identity, and
start a fresh encryption session before resetting record sequences.

### Baseline verification (before worker merges)

- JS unit tests: 46 passed. TypeScript and production build passed.
- Go tests initially exposed existing local IPv6 route misclassification;
  coordinator fix recognizes a peer address belonging to a local interface.
  Full Go tests and ten repeated local trickle-ICE route tests then passed.
- Agent verification: CLI direct switch, 1,573,512-byte folder bundle,
  40 signaling registrations, and 1,572,937 exact source bytes passed.
- Browser verification: 3,145,805 exact browser-to-browser bytes,
  three-file browser-to-CLI ZIP integrity, and camera QR receive passed.
- CLI loop: 20/20 detached sends and waits verified exact bytes.
- Deploy dry-run passed; no deployment performed.

### Wave 1 gate passed

All worker changes merged. JS tests 50/50, Go, typecheck, agent/browser
verification and deploy dry-run pass. Integrated isolated 2 MiB benchmark:
4/4 transfers completed with exact bytes. Detached readiness 46.55 ms,
parent exit 48.13 ms, holder alive after exit; 41.06 MiB/s, 105 command
output bytes (includes opt-in telemetry; 59 holder-log bytes separately).
Foreground readiness 20.89 ms / 40.93 MiB/s. Forced relay directBytes=0,
26.36 MiB/s. Browser forced relay 6.75 MiB/s, 2,097,541 relay wire bytes.
These single-run local measurements are smoke evidence; repeatable three-run
worker baselines are in `docs/measurements/wave1-benchmarks.md`.

## Wave 2 gate passed

Canonical ID histories and compatible numeric-code lookup are integrated.
Typed failure kinds carry never/same_request/new_transfer retry guidance;
setup retries cap at three attempts within a20-second dial budget.
Request-ID deduplication uses OS locks, private durable reservations, complete
input fingerprints, holder revalidation, streamed digest checks before END,
and ready persistence before output. Reused/expired aliases fall back to the
original capability URL, verified against the current code directory.

All7 live retry scenarios passed, including4 simultaneous requests/one holder,
lost command response followed by exact1000-file archive verification,
changed-source rejection without publication, stale holder and cancellation.
Go full and race tests,50 JS tests,typecheck,existing agent/browser
verification and deploy dry-run pass. Concurrency readiness31.627–78.178ms;
lost-response replay221.052ms for65,536,000 archive source bytes.
Per-worker details and reproduction are in docs/measurements/wave2-*.md.

## Wave 3 ownership and contracts

A owns browser transport wiring (`relay-sender`, `direct-link`, `share`) and
transport unit tests. B owns independent `send-window` module and tests.
C owns benchmark route accounting and transport matrix verification scripts.
Coordinator integrates all and runs existing gates.

Window: default1MiB minimum,4MiB initial,12MiB maximum; cumulativeBigInt
counts and up to64 timing samples, no payload retained. Whole-chunk admission
precedes sending. Direct sender uses channelID1 and exact existing encrypted
records. Relay starts immediately while direct setup happens; gathering bound
250ms overlaps receiver wait. NativeDC/WS buffers cap4MiB, retainedciphertext
16MiB/128records, merger16MiB/256records, assembler~1MiB+64KiB. Receiver
queue32MiB/512 records; ACK replay128KiB/128 records. Opt-in test observer
reports counts only, without payload or capabilities.

### Wave 3 gate passed

All transport/window/staging-bound changes integrated.68JS tests,Go,
typecheck,existingbrowser/agentverification anddeploydryrun passed.
8/8matrix cases verified64MiB exactly: directall3orientations, blocked
all3orientations,relay->directupgrade,slowreceiver. NativeDCmax4,181,104B;
relay4,063,924B;retained4,194,752B;inflight5,767,168B;22timingsamples;
sampledJSheap96,568,847B. All below explicitcaps. Blobfallback also bounded
256MiB even without OPFS. Loopbackdirect15.74MiB/s vsrelay27.81MiB/s:
workingdirect verified, no unsupported speed-improvement claim.

Wave4architecture agreed inADR0001 andissue15 before implementationsplit.
Sendersecret distinct fromreceiver capability; both peers contributefresh
nonces/proofs;checkpointMAC exact canonical fields;durableverifiedprefix;
24hretention;no v1sequence resets. MoreLuna workers added peruser request.
