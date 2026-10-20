# CD and croc comparison

The question is which CLI completes the same transfer sooner, and why the answer differs by payload and path.

This report measures the existing checkout without changing transfer code. The checkout already contains uncommitted TCP and chunk-size improvements. A private built executable freezes the tested implementation. Installed tools are left intact.

Data objects: one row per transfer, with tool, payload bytes, storage, allowed route, observed route, trial index, readiness, native receiver completion, completion with file and directory flush, total completion, SHA-256, and failure details.

Scenarios: local relays on the same PC; physical PC to Ubuntu LAN; diagnostic WebRTC with TCP disabled. Warm input cache. Independent serial suites. Rotate tool order. Treat incompressible random bytes and repeated-byte payloads separately.

Presentation: filterable benchmark report. Achromatic ledger, seed 123028957. Blue-grey ground and CD's measured series in blue give the report its face. The unique element is the actual route under each CD result. No stock imagery or invented data.

Evidence limits: local-relay results are not hosted-service internet throughput. Numeric CD code and croc PAKE are not a security-equivalence comparison. Physical LAN timing includes SSH receiver launch. Three or seven repetitions do not establish universal speed. SHA-256 is checked outside timing; file and directory flush are included for both tools.

## Experiments

- Installed croc is 10.7.0; final reference is the upstream 11.5.5 release. The staged archive matched its upstream checksums file. Neither installed executable was replaced.
- Initial rapid 11.5.5 trials exhausted relay admission limits. Those runs are retained as admission-limited diagnostics and excluded from winning claims. The private benchmark relay raises both source and room admission limits, and secrets start with random bytes. Production relay settings are untouched.
- Browser baseline completed 18/18 verified 64 MiB transfers.
- 768 KiB negotiation needs a browser minimum send window of at least two chunks, because ACKs occur at 1 MiB. A regression test covers large chunks through the actual encrypted browser send engine. Legacy 64/256 KiB peers retain their negotiated limits.
- Native File.stream did not produce a consistent end-to-end gain and was reverted.
- A synchronous OPFS worker removed the measured asynchronous storage writes but did not reduce total completion enough to justify the new lifecycle. The prototype was removed.
- The storage probe measured 86 writes and 773–1138 ms in the 768 KiB experiment. Batching into approximately 4 MiB reduces this to 15 writes and 225–233 ms in a 64 MiB smoke transfer. The final multi-trial end-to-end comparison remains the acceptance evidence.
- Automatic direct discovery can finish successfully over relay before ICE opens. The performance runner now records that actual route instead of misclassifying a verified automatic fallback as data-transfer failure. The strict transport verification runner continues to require real direct payload.
