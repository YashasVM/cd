# Transfer speed audit: CLI transport

The largest proven transport constraint is opt-in resumable v2: one 256 KiB chunk waits for a durable ACK before the sender sends another. Default v1 already pipelines 8–24 MiB and upgrades from the relay to WebRTC. A regression in default v1 throughput has not been established by a controlled comparison.

This audit reads the existing working tree at HEAD `57232025406c6b86e688ffa598319cab7ffd60e8`. No production code changed and no competing network benchmark ran. SHA-256 fingerprints of all seven inspected Go transport files match `perf-audit-2026-10-17/provenance.json`, so those measurements apply to the inspected source. That report records heavy competing host load and a failed Go profiling attempt.

## 1. Pipeline resumable transfer and batch durable commits

Evidence: `cmd/cdx/resume.go:423` sends one chunk, then `:439` waits for its exact ACK. `:583` calls `stage.Sync()`, updates the authenticated prefix, and persists the checkpoint. The receiver does this before every ACK at `:614`. `cmd/cdx/resume_storage.go:24` creates and syncs a temporary checkpoint, renames it, then syncs its directory. Each 256 KiB chunk therefore serializes network latency with staging, metadata, and directory durability work.

The existing three-trial, verified local delay experiment in `perf-audit-2026-10-17/network.json` reports these median v2 rates:

- No added ACK round trip: 6.951 MiB/s.
- 100 ms added ACK round trip: 2.035 MiB/s.
- 300 ms added ACK round trip: 0.723 MiB/s.

Default v1 medians in that invocation were 14.790, 18.779, and 7.977 MiB/s. Host load invalidates precise relative speedup claims, but the repeated v2 latency trend agrees with its stop-and-wait design. The disk-backed no-added-delay invocation reports 8.591 MiB/s for v2 and 16.642 MiB/s for v1.

The model `throughput <= 0.25 MiB / (ACK RTT + durable commit time)` gives an upper bound of 2.5 MiB/s at 100 ms and 0.833 MiB/s at 300 ms before CPU or storage work. These limits apply regardless of available network bandwidth.

Implement a bounded send window and cumulative durable ACKs. Start experiments with a 4 MiB window and 1, 2, or 4 MiB durable batches, plus a short commit timer for slow transfers. Keep separate received and committed offsets. Only the committed offset may advance the authenticated checkpoint or resume ACK. Commit the final partial batch before END/COMPLETE. A 4 MiB window removes the protocol's one-chunk RTT restriction, giving a modeled 16x larger byte budget, not a promised 16x measured speedup.

Negotiate batching with the peer. An old v2 sender waits after its first chunk, so a new receiver must retain per-chunk durable ACKs unless the sender advertises pipelining. A new sender can pipeline against an old receiver while accepting its existing per-chunk ACKs. Migrate both Go and browser senders and receivers together, with mixed-version verification.

Verify fresh and resumed transfers with actual SHA-256 and process termination between staging sync, checkpoint sync, rename, directory sync, and ACK. Check that restart truncates uncommitted tails and never resumes past durable bytes. Measure fsync count and p95 commit duration on actual disk, not only `/tmp`. This change preserves ADR 0001's rule that ACKs never claim uncommitted retained bytes.

Origin: resume files and ADR 0001 are untracked working-tree additions. This is a speed limitation of the new optional path, not evidence that existing plain `cdx send` became slower.

## 2. Measure direct selection and remove its startup dependency

Default v1 unconditionally promotes to direct once the data channel opens, at `cmd/cdx/link.go:179`. It first replays all unacknowledged relay ciphertext at `:184`, then sends all subsequent records directly. The switch considers readiness, not measured delivery rate. A reachable direct path may perform worse than a fast relay on a CPU-limited device or poor UDP path. No controlled CLI comparison here proves that it currently does.

Run interleaved forced-relay and verified-direct trials with identical endpoints, payload, CPU load, RTT, loss, and filesystem. Count unique payload, duplicate replay bytes, time to first payload, time to direct upgrade, and steady throughput. Test 8 MiB through 1 GiB and 0%, 0.1%, and 1% packet loss. Treat route selection as a candidate optimization only if this comparison reproduces slower direct delivery. Avoid adding parallel streams before measuring the single-stream bottleneck.

There is also a definite startup dependency: `cmd/cdx/sender.go:457` blocks the file offer on `<-offerSDP`, while `cmd/cdx/direct.go:140` waits up to one second for ICE gathering. Gathering starts while waiting for the recipient, which usually hides the delay for a human. Immediate CLI receivers and unreachable STUN can expose it. The sender does not trickle its late candidates, so merely reducing the deadline could reduce direct success.

Send an initial offer without waiting for complete gathering, then convey authenticated candidates with an explicitly compatible signaling change. First measure 250 ms gathering against one second as a smaller experiment. Require unchanged direct success across LAN, IPv4/IPv6 NAT, and unavailable STUN. This primarily improves small-file completion and direct-upgrade latency, not steady large-file bandwidth.

Origin: direct promotion, replay, and the one-second gathering deadline were already present in commit `66f4e47`. Working-tree edits to these functions add error types and byte counters, not a new route policy.

## 3. Raise the effective window only where measurements show it binds

Default v1 application flow control is already adaptive at 8–24 MiB, `cmd/cdx/window.go:13`. The receiver ACKs every 1 MiB, `cmd/cdx/receive.go:328`. Increasing the application window alone does not overcome other layers.

The CLI configures Pion's maximum SCTP receive buffer to 8 MiB at `cmd/cdx/direct.go:39,99`. A flow-control model bounds a sender targeting that CLI receiver to roughly 80 MiB/s at 100 ms or 26.7 MiB/s at 300 ms. The application window permits 240 and 80 MiB/s respectively. Actual rates can be lower because SCTP congestion control, peer receive credit, loss, CPU, and storage also limit delivery. This configured limit is especially relevant to CLI-to-CLI or browser-to-CLI on high-bandwidth, high-latency links. A browser receiver has its own SCTP receive window.

Sweep 8, 16, and 24 MiB receive buffers under a shaped gigabit path at 20, 100, and 300 ms. Capture SCTP congestion window, receiver credit, buffered amount, application in-flight bytes, CPU, and RSS. Change defaults only when the receiver credit is the observed bottleneck. Retain total byte budgets below relay limits and verify slow receivers. Do not disable congestion control or authentication.

Origin: the 8 MiB receive buffer is already present in `66f4e47`; the adaptive application window comes from `e1e08bb`.

## 4. Add direct transport to v2 after the durable pipeline works

`cmd/cdx/resume.go:195` always writes encrypted v2 records to the relay WebSocket. Its session has no direct path. Thus v2 bypasses v1's LAN/internet peer-to-peer upgrade as well as its send window. This matters particularly for same-network large transfers.

After pipelining works, let a transport accept already sealed records and reuse v2's existing per-session nonce binding and sequence validation. The current v1 assembler explicitly accepts only version 1 at `cmd/cdx/direct.go:285`; do not pass v2 through it unchanged. Preserve identical ciphertext replay, deduplication, and authenticated session boundaries. Validate CLI/browser interoperability, interruption, fresh-session restart, and relay fallback. Direct transport alone will retain the per-chunk RTT ceiling if stop-and-wait remains.

## 5. Profile allocations after network and storage limits are removed

`cmd/cdx/direct.go:280` appends pieces into a growing assembler buffer, copies a complete encrypted record at `:295`, and `cmd/cdx/protocol.go:200` allocates plaintext during AES-GCM open. A 256 KiB plaintext record is 262,172 bytes with header and tag, so 64 KiB pieces require five data-channel messages, including a 28-byte tail. These are concrete allocation and dispatch costs, but no usable Go CPU profile currently proves they dominate.

Capture CPU and allocation profiles on idle-loopback direct transfers and real LAN transfers. If assembly dominates, allocate one bounded record buffer from the validated header and transfer ownership rather than append-grow-copy. If crypto output allocation dominates, reuse buffers with explicit lifetimes. Sweep compatible piece sizes while retaining old-client support. Verify byte-for-byte output, record ordering, and rejection of oversized frames. Keep end-to-end encryption.

First repair the benchmark at `cmd/cdx/direct_bench_test.go:11`: setup, send, and receive errors are ignored, waits for channel open are unbounded, and no payload validation occurs. Its throughput results cannot establish reliable capacity until errors fail the run and received bytes match a known digest.

## Delivery order and acceptance

1. Establish one interleaved, hash-verified baseline for the current working tree and HEAD. Include v1 relay/direct and v2 relay, time to first byte, steady throughput, completion, CPU, RSS, and actual route bytes. Test at least one real pair of devices.
2. Fix the measured v2 RTT constraint with a bounded pipeline and durable batching. Use 100 ms and 300 ms ACK-delay cases as the primary regression gate.
3. Reduce direct startup delay, then tune direct selection or SCTP receive credit only where the baseline identifies a limit.
4. Bring v2 onto direct transport and profile remaining copies. Require every speed claim to name its endpoints, RTT, payload, filesystem, route, and successful digest checks.

The existing delay matrix and source inspection support the first implementation priority. They do not establish internet throughput or justify a universal advertised speedup.
