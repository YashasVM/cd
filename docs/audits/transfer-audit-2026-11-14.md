# Transfer audit, 14 November 2026

CD transfers files through an authenticated relay and, where negotiated, directly between peers. This audit assumes concurrent users, untrusted invitations and archive contents, and networks that can drop during a transfer.

## Scope

Reviewed transfer entry points, framing, direct negotiation, flow control, resume persistence, worker admission/security boundaries, archive publication, dependency scans and CI in `YashasVM/cd`, based on main commit `2261b65`. Related checkout `cd-product-ux` was checked on `feat/product-ux` at `cce0469` for current Android Beta behavior. The encryption-speed and SDK checkouts are worktrees of this same repository, not separate products. Unrelated repositories under the user's code directory were excluded.

The original working directory contains uncommitted changes and old code. Findings below were compared with current main to avoid reporting bugs already fixed there. This is a risk-focused review, not a claim that every file or possible vulnerability was checked.

## Fixed in this PR

1. **Direct browser messages could exceed the negotiated peer limit.** `src/direct-link.js` always split encrypted records into 64 KiB messages. A peer advertising a smaller SCTP maximum would reject them. Sending now respects that maximum without increasing the receiver's 64 KiB assembly cap. The legacy raw-channel helper also respects limits below 16 KiB. Behavioral tests enforce a 1,000-byte maximum and reconstruct the exact transmitted record.

2. **CLI resume performed a durable transaction for every 256 KiB.** `cmd/cdx/resume.go` flushed file data, checkpoint data and the checkpoint directory before every ACK. The receiver now negotiates an interval bounded by the offered window and 4 MiB. Modern 4 MiB-window peers need one transaction per 16 chunks. Legacy senders retain the old interval. Every ACK still follows durable persistence. An interrupted transfer may retransmit up to 4 MiB of unacknowledged tail. Tests check authenticated checkpoint contents at each ACK, invalid windows, final bytes and existing interrupted-resume behavior. This reduces operations; no end-user throughput improvement is claimed without a before/after measurement.

3. **The Go toolchain had a reported standard-library vulnerability.** `govulncheck` reported GO-2026-6859 against Go 1.26.10 and identified 1.26.11 as the fixed version. The module, CI, security and release toolchains now use 1.26.11. Rescanning reports no reachable vulnerabilities. Three module advisories remain outside the called code according to the scanner.

## Remaining product bottlenecks

4. **Browser resumable mode is relay-only.** `src/resume-browser.js` sends v2 records over WebSocket without the v1 direct-path integration. The CLI resume receiver also does not answer an offered direct path. Direct-to-direct transfer therefore is not supported in every client/mode. Extending resume requires cross-client signaling, merged record ordering and interruption tests; raising a buffer alone cannot fix this.

5. **Android Beta aborts recoverable ICE disconnections.** `SenderDirect.kt` and `DirectReceiver.kt` treat `IceConnectionState.DISCONNECTED` as terminal alongside `FAILED` and `CLOSED`. A brief outage can require manual resume even when ICE would recover. Fix in the Beta branch with a DISCONNECTED-to-CONNECTED recovery test; keep terminal failures and existing transfer deadlines. Android sources were not edited in this PR.

6. **Android sender startup waits for SDP and ICE.** `SendEngineImpl.kt` waits for `SenderDirect.offer()` before sending the file offer. That method can wait five seconds for description setup and two seconds for gathering; later local candidates are dropped. Slow STUN responses can leave transfers on relay. Asynchronous negotiation and sender candidate trickling require a protocol change and tests across old clients.

7. **Resume integrity adds full file reads.** Browser resume hashes the whole source before publishing, reads it again during transmission and rechecks the completed staged file. These checks protect source identity and integrity. Reducing startup delay needs a protocol that preserves those guarantees.

8. **Android SDK sends in batches.** `CdTransferClient.kt` drains all ACKs after a 4 MiB flight before sending the next batch. Each batch can leave an RTT-sized idle gap. A cumulative rolling window can overlap sending and acknowledgements. This SDK version is explicitly relay-only.

## Verification and reporting

Local `npm test`, TypeScript checking, Go tests, focused race tests, npm dependency audit and the updated Go vulnerability scan passed. The browser performance fixture verified three fresh 64 MiB transfers per route by complete byte count and SHA-256. Direct median was 29.29 MiB/s and forced relay median was 15.71 MiB/s on this machine; worst observed payload gaps were 301.2 ms and 236.8 ms. These loopback results are not WAN or phone measurements and are not a comparison with the previous implementation.

The PR also adds a T3-style transfer performance comment using the existing performance fixture. It records route usage, elapsed receive time, throughput, verified bytes, payload gaps and baseline changes. Privileged publishing uses only default-branch code and treats artifacts as data. The publisher starts operating after it lands on the default branch; baseline comparisons require a successful default-branch artifact.

## Limits

No physical-phone session, hostile NAT matrix, sustained multi-user load test or external penetration test was run. Android findings are static review. A direct path cannot be guaranteed through every NAT or firewall; a working relay fallback remains necessary. No production release or deployment was performed.
