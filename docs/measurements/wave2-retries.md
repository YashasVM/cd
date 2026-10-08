# Wave 2 retry verification

Owner: Agent C. Owned files: `cmd/cdx/retry_integration_test.go`, `scripts/verify-retries.mjs`, and this report. Dependencies: coordinator request-ID journal and input fingerprint, Agent A transfer-ID state and holder hooks, Agent B typed failures and retry guidance.

The Go tests exercise separate CLI processes against a local fake relay, verifying four concurrent identical requests have one admission, one live holder, and one ready result. A same-size changed payload must return `request_conflict` without another holder. An independent state fixture reuses a share code across two transfers and checks old-ID history and newest-code lookup.

The live runner builds the CLI and starts the local Worker. It verifies invalid request IDs and foreground request rejection; simultaneous requests, exact payload receipt, successful wait, and completed-request replay; changed bytes, paths, and link options; lost caller responses; stale holders; and cancellation. To lose a response reproducibly, it observes the holder child through Linux `/proc`, stops the parent, waits for holder readiness to persist, kills the stopped parent, and retries. The replay must identify the original holder. Receiving that archive checks all 1,000 member names and SHA-256 hashes against the original 64 KiB contents. Cleanup kills remaining holders and checks `/proc` for any live process before stopping the Worker.

```sh
go test ./cmd/cdx -run 'Test(RequestRetryConcurrentProcessesShareOneHolder|ReusedShareCodePreservesIndependentTransferHistory)' -v
npm run build
node scripts/verify-retries.mjs
```

The signal-injection runner requires Linux. Local Worker startup requires installed npm dependencies. Internet throughput, browser behavior, and resumable transfers are outside this gate.

## Measured results

Linux amd64, local Worker, Go 1.26.8, Node 26.10.0. The final run includes coordinator code-directory capability verification (`95ae58c`, `a45ccc5`) and the sender's pre-END payload guard (`5b03d85`). The runner reports compact JSON with per-scenario timing and count information.

| Scenario | Passed assertions | Final run duration |
| --- | --- | ---: |
| Invalid IDs / foreground requests | 4 rejected, no holder | 28.635 ms |
| Simultaneous requests / completion | 4 requests, 1 holder; 1,048,577 exact bytes; successful wait; completed replay preserves private URL and clears consumed code | 1,606.506 ms |
| Changed content / path / link option | 3 `request_conflict` failures, no new holder | 24.478 ms |
| Source mutation after readiness | Changed stream fails before publication; final destination absent; new request verifies 1,048,577 changed bytes | 478.720 ms |
| Lost parent response | Original transfer ID and PID replayed; 1,000 ZIP member names and SHA-256 hashes match 65,536,000 original bytes | 1,608.417 ms |
| Stale holder | `disconnected`, `retry=new_transfer` | 41.836 ms |
| Cancellation | `canceled`, `retry=never` | 42.241 ms |

The four simultaneous ready responses took 31.627, 65.476, 34.864, and 78.178 ms. Lost-response replay took 221.052 ms, including cryptographic source fingerprinting of the 64 MiB tree and verification of its live code directory entry. All 7 final scenarios passed, and cleanup confirmed no live background holders. An earlier complete run before the final directory hardening also passed 7/7; its replay took 140.388 ms. These timings measure local verification behavior, not network throughput guarantees.

Focused subprocess/history tests pass with the final capability verification (1.072 s). Before directory hardening, three race-enabled repetitions passed all six test executions (2.692 s). The full Go suite passed with final directory hardening (2.295 s). The concurrent Go fixture's fake relay omits directory GET; safe retries may consequently clear its unverifiable code, but must preserve the original private URL and one holder. The real Worker runner verifies matching live codes and cleared consumed codes.

The added mutation scenario first reproduced the pre-guard defect: same-length changes after readiness were accepted and published. With the guard, the identical scenario passes by rejecting the receive and keeping the final destination absent. Lost-response injection scans every Go runtime OS thread's `children` file, since holder creation can fork outside the main thread.
