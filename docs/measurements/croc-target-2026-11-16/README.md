# Croc performance target: second backend iteration

The source under test is `4b881fdd989ac51417ade92bb84bcc10a1047bd1`, following
the earlier `d71a051` comparison. Five-digit sharing, private-link behavior,
wire encryption/authentication, sequence validation, output publication and
durability checks remain intact. There was no Cloudflare deployment or paid
resource creation.

## Result: automatic mode clears 2x; the all-mode target remains unmet

**All 480 planned transfers completed and verified.** Every recorded output
manifest, byte count and complete SHA-256 matches its input. There are 32
cells, with five repetitions per tool in each cell.

All **16 automatic-policy cells** passed the 2x completion gate against both
croc configurations in receiver time, fsynced completion and total elapsed
time. The smallest descriptive ratio of medians was **2.062x** (RAM-backed
random 256 MiB, croc total time / CD total time). These automatic transfers
include short-file relay and negotiated local TCP upgrades; they do not
establish WebRTC or internet performance.

**Forced relay did not meet the requested all-case margin.** Seven of its
16 cells passed 1.5x; none passed 2x across all three metrics and both croc
modes. For example, the disk random 256 MiB receiver-time ratio was only
0.296x against croc without compression. The original all-four-metric gates
and the new overall completion-only 1.5x/2x gates are all **false**. The
requested statement "1.5–2x faster in every way" is not supported.

The following are median **total milliseconds** from sender launch through
receiver completion plus explicit fsync; lower is faster. Minimum ratio takes
the worst comparison over both competitors and all three completion metrics.
`summary.csv`, `analysis.json` and the complete raw `matrix.json` retain detail.

| Storage | Route | Payload | CD ms | croc ms | croc no-compress ms | Minimum completion ratio |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| disk | auto | random-4k | 73.2 | 561.8 | 565.1 | 7.676x |
| disk | relay | random-4k | 63.7 | 121.7 | 120.6 | 1.892x |
| disk | auto | random-1m | 81.8 | 566.1 | 566.3 | 6.919x |
| disk | relay | random-1m | 100.2 | 117.1 | 120.5 | 1.169x |
| disk | auto | random-64m | 336.2 | 749.0 | 720.6 | 2.144x |
| disk | relay | random-64m | 339.5 | 250.8 | 299.8 | 0.703x |
| disk | auto | random-256m | 575.2 | 1428.1 | 1423.4 | 2.471x |
| disk | relay | random-256m | 1222.0 | 469.9 | 448.7 | 0.296x |
| disk | auto | compressible-4k | 87.3 | 566.2 | 562.7 | 6.446x |
| disk | relay | compressible-4k | 75.7 | 121.4 | 117.4 | 1.551x |
| disk | auto | compressible-1m | 79.2 | 574.3 | 564.9 | 7.129x |
| disk | relay | compressible-1m | 70.0 | 123.2 | 121.4 | 1.735x |
| disk | auto | compressible-64m | 323.0 | 850.2 | 762.0 | 2.359x |
| disk | relay | compressible-64m | 342.5 | 344.5 | 294.4 | 0.852x |
| disk | auto | compressible-256m | 383.1 | 1982.5 | 1318.0 | 3.441x |
| disk | relay | compressible-256m | 628.6 | 1242.6 | 634.0 | 0.989x |
| tmpfs | auto | random-4k | 68.5 | 589.2 | 565.1 | 8.252x |
| tmpfs | relay | random-4k | 60.3 | 115.7 | 114.6 | 1.900x |
| tmpfs | auto | random-1m | 67.2 | 574.3 | 567.2 | 8.441x |
| tmpfs | relay | random-1m | 68.6 | 113.8 | 116.9 | 1.657x |
| tmpfs | auto | random-64m | 224.5 | 641.4 | 708.7 | 2.857x |
| tmpfs | relay | random-64m | 385.6 | 229.2 | 254.4 | 0.593x |
| tmpfs | auto | random-256m | 641.7 | 1323.1 | 1441.3 | 2.062x |
| tmpfs | relay | random-256m | 1346.4 | 484.7 | 513.1 | 0.360x |
| tmpfs | auto | compressible-4k | 95.3 | 571.7 | 574.9 | 5.998x |
| tmpfs | relay | compressible-4k | 60.9 | 116.0 | 113.7 | 1.866x |
| tmpfs | auto | compressible-1m | 78.1 | 567.5 | 562.9 | 7.204x |
| tmpfs | relay | compressible-1m | 71.6 | 121.1 | 116.9 | 1.634x |
| tmpfs | auto | compressible-64m | 179.0 | 819.1 | 654.8 | 3.658x |
| tmpfs | relay | compressible-64m | 184.8 | 379.2 | 213.0 | 1.153x |
| tmpfs | auto | compressible-256m | 365.5 | 1814.7 | 1506.2 | 4.121x |
| tmpfs | relay | compressible-256m | 462.2 | 1105.2 | 497.2 | 1.076x |

A supportable claim is: **"In our recorded same-host automatic-mode benchmark,
CD achieved at least 2.06x the completion speed of croc across these synthetic
file cases."** It must retain the topology, mode and measured-sample qualifiers.
It must not become a promise of 2x for all networks, relay modes or future runs.

CD's automatic-policy trials were 60 local-TCP upgrades and 20 short-file
relay transfers. All 80 forced-relay CD trials remained on the relay. There
was no measured WebRTC performance in this native cohort.


## What changed

The sender previously waited as long as one second for STUN gathering before
offering a file, even when an authenticated local TCP transfer could start
immediately. Modern peers now negotiate a deferred SDP offer: data begins on
LAN/relay while the same full, bounded candidate gathering continues. Delayed
public candidates remain usable. The optional SDP cannot follow END. Old
Workers and clients retain the original initial-SDP behavior; no timeout was
lowered to manufacture a local win. Browser consent and file handling retain
their existing behavior.

The relay client now uses a bounded 1 MiB WebSocket write buffer instead of
Gorilla's 4 KiB default. This avoids fragmenting a 768 KiB ciphertext record
into 193 writes. A full-runtime buffer diagnostic selected 1 MiB over the
smaller buffer favored by the isolated client benchmark. The compression
encoder uses pinned, wire-compatible RFC 1951 output with the independent,
strict standard decoder unchanged. Ordinary CLI receiving explicitly releases
processed relay buffers into a private pool capped at eight 1 MiB records;
other callers retain their old ownership contract.

[Bulk evidence](bulk/README.md) includes all buffer trials, compatible decoder
checks and CPU/heap profiles. Component improvements are not substituted for
the product comparison. In particular, the allocation profile improved by
about 97%, but its unpaired instrumented wall time worsened; both observations
are retained. No profiler is active in the final matrix.

## Comparison method and scope

`matrix.json` uses the existing Wrangler development-proxy runtime and both
tools' native product behavior. It covers random and compressible 4 KiB,
1 MiB, 64 MiB and 256 MiB files, automatic and forced-relay routes, disk and
tmpfs output, and five repetitions of CD, croc defaults and croc without
compression: 480 planned transfers. Seeded randomized tool order reverses
no unfavorable result; every completed output must match its source manifest,
size and complete SHA-256. Random input uses independent bytes per MiB, not
one repeated random block.

Readiness starts at sender process launch. Receive timing starts at receiver
process launch. Receiver exit, explicit file/directory fsync and total elapsed
time are retained separately. External output hashing is after all transfer
timings. Both tools receive identical input bytes within each cell. Input/page
caches are allowed. `sync` and code-admission pacing occur outside timing for
both tools. CD starts are spaced by 5.5 seconds; production code lookup
protection was not relaxed.

The receiver starts immediately after the invitation appears; human typing
time is not simulated. In a manual handoff that takes more than a second,
legacy ICE gathering may already have finished while the person enters the
code, so the startup gain can be smaller than in an automated handoff.

The croc binary is checksum-pinned upstream 11.6.5; the report contains its
binary hash, CD's binary hash, worker/configuration/runtime identities and
benchmark helper hashes. Croc defaults, compression and native multiplexing
were not disabled to create a win. Forced relay uses its explicit
`--transport relay --no-local`, separately from default discovery. Automatic
CD can use TCP, WebRTC or fallback; inspect `directProtocol` before describing
a measurement as WebRTC or P2P.

These are two native endpoints on one Linux host. They do not establish WAN,
cross-device, browser, physical-disk throughput, concurrency, directories or
worldwide superiority. Tmpfs fsync is not physical persistence. Croc's default
local discovery includes a 500 ms wait; a small-file setup advantage must not
be described as a steady-state bandwidth multiplier.

## Completion margins versus invitation display

The original `pass1_5` and `pass2` flags still require all four metrics,
including invitation-display readiness, against both croc configurations.
Their timing boundaries and ratios have not changed.

There is a semantic difference in readiness: CD prints its numeric code after
the relay/directory has admitted a live transfer. The pinned upstream croc
source prints instructions before starting local relay setup and external
relay registration. A separate passive diagnostic saw invitation display at
6.57/6.37/14.37 ms and relay registration at 18.38/22.06/28.01 ms. These are
observations from separate pipes, with debug relay logging, not replacement
comparison timings. No time was added to croc's samples.

`scripts/bench-croc-readiness.mjs` verifies the exact upstream source hashes
and passively observes three senders without ever launching a receiver.
`diagnostics/croc-readiness.json` retains the complete observations. A live
registration claim must not be inferred from the older display metric.

New, separately named `completionPass1_5` / `completionPass2` gates require
receiver completion, fsynced completion and total elapsed time to all beat
**both** croc modes by the specified margin in every configured cell, with
at least five valid, unique repetitions. Missing, failed, interrupted,
duplicate or invalid trials fail closed. These gates do not convert a slower
invitation display into a win, and do not create a worldwide ranking.

```sh
node scripts/verify-croc-completion.mjs matrix.json 1.5
node scripts/verify-croc-completion.mjs matrix.json 2
```

The manual comparison workflow now fails its speed-target step when 1.5x
is not met while retaining raw results. A green checksum transfer alone must
not be presented as a green performance claim.

## Correctness and compatibility

- `npm test`: 243 passing tests, zero failures/skips.
- Full `go test ./...`, with per-command `umask 022`: passed.
- Focused Go race tests for deferred signaling, legacy admission, buffer
  ownership/reuse, compression and framing: passed.
- Main and SDK type checks, web build and deployment dry-run: passed.
- Actual Worker security, CLI/browser, terminal, v2 resume and web SDK
  integration verifiers: passed.
- `verify-legacy-cli.mjs` tested the real prior and current CLI binaries in
  both directions, random and compressible 4 MiB files, automatic and forced
  relay: eight full outputs verified. It uses five-digit codes and current
  Worker admission, not mocked protocol messages.

`validation/` preserves logs and executable hashes. Deferred tests additionally
hold a real public-STUN response until file data is already flowing, then
verify that full SDP wakes a blocked ACK wait. Other tests reject unsolicited
sender signaling, duplicate/conflicting/oversized offers and auth failures;
check cancellation; and ensure no optional SDP follows END. The browser replay
test drops the relay after direct upgrade and verifies all early ciphertext,
deduplication, remaining ACKs, output bytes and unchanged queue caps.

A fresh CLI rebuild reproduced the same SHA-256 as both the final matrix and
the real legacy-interoperability run:
`f58b80deb7b364d3fffef01adbbae4269274b86eda66e518e224ee65769a058b`.
Benchmark helper, Worker and configuration hashes also match the committed
source. `validation.json` records the outcomes and `SHA256.json` catalogs the
evidence. Captured text logs have presentation-only trailing whitespace
removed; raw numerical JSON and binary profiles are unchanged.

## Additional diagnostics are not acceptance evidence

`diagnostics/croc-v2-smoke.json` was a one-run, shared-load development check.
Its favorable and unfavorable results remain visible, but do not replace the
five-run matrix. A separate direct-workerd control records its actual bundle
hash/runtime and also failed the relay target. Its results are not pooled with
the Wrangler cohort. These intermediate dirty-source diagnostics must not be
relabeled as the final committed-source cohort.

`stream-feasibility/` contains an isolated raw transport prototype, never
integrated into CD or deployed. Paired POST-to-GET native streams were about
2.32 times faster than the prototype's raw DO WebSocket path at their medians,
but only 1.21 times faster in the cold pair. It omits CD encryption, ACK windows,
admission and saved output; it is **not** evidence of beating croc.

Cloudflare's Free-domain request body cap is 100 MB even for streaming uploads.
A production design would require bounded authenticated ciphertext segments,
continuous response/backpressure, strict ordering, cleanup, unchanged verified
completion, legacy fallback and measured WAN boundary costs. The prototype is
not a safe shortcut for arbitrary-size files. Its documented missing guarantees
are why it is not enabled to obtain a favorable benchmark.

## Reproduce

Use Node 24, Go 1.26.11, the pinned croc 11.6.5 executable and the committed
source. No old report is used as a timing input.

```sh
npm ci && npm run build
node scripts/bench-croc-matrix.mjs --croc /absolute/path/to/croc \
  --runs 5 --storage disk,tmpfs --disk-dir /absolute/output-parent \
  --seed cd-croc-full-2026-11-16 --output /absolute/matrix.json
node scripts/verify-croc-completion.mjs /absolute/matrix.json 1.5
```

The local benchmark config is never a deployment config. Cloudflare's actual
free quotas and relay costs remain in [the capacity guide](../../cloudflare-free-tier.md).
No paid TURN, external storage or separately hosted relay was introduced.
