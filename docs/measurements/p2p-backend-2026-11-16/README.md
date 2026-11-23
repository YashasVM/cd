# Backend performance and product comparisons, 2026-11-16

Baseline repository revision: `11136c008b01e282b1528c23861384e63dd050aa`.
The accompanying source changes preserve the five-digit share-code flow and
wire encryption, integrity checks, ACK windows and memory limits. No production
deployment or paid Cloudflare resource was created.

## Changes supported by evidence

- CLI WebRTC assembly allocates a validated record once instead of repeatedly
  growing fragment buffers and copying the finished record. Allocated bytes fell
  72.5% for 256 KiB records and 81.9% for 768 KiB records. See
  [raw assembly results](../cli-assembly-2026-11-16/README.md).
- Browser direct sends wake on native buffer-drain events instead of polling
  every 10 ms, retaining queue caps and cancellation/error/deadline handling.
  Direct-network throughput improvement is unmeasured in this environment.
- The browser ZIP IEEE CRC32 stage was 1.48 times faster in seven alternating,
  independently verified Chromium pairs. This is checksum CPU throughput,
  not whole-transfer speed. See [browser evidence](../browser-backend-2026-11-16/README.md).
- Warm v1 relay forwarding uses one attachment deserialization instead of four
  and zero socket scans instead of one. Hibernation rebuilds the role cache.
  [The handler microbenchmark](../relay-handler-2026-11-16/README.md) mocks host
  APIs and does not measure network bandwidth.
- CLI and both browser transfer paths use Cloudflare STUN by default. Hosted
  signaling, share codes and fallback remain on Cloudflare Workers/Durable
  Objects; [free-tier quotas still apply](../../cloudflare-free-tier.md).

## Native results

All **120/120** trials completed with verified output. The following are median
total milliseconds from sender launch through receiver completion plus explicit
file/directory fsync; lower is faster. Five repetitions per cell. Full timing
spreads, receiver-only timings, manifests and binary/source hashes remain in
`croc-matrix.json`. These are same-host results, not WAN throughput.

| Payload | Requested route | CD | croc defaults | croc no compression |
| --- | --- | ---: | ---: | ---: |
| random-4k | auto | 62.8 | 563.1 | 559.2 |
| random-4k | relay | 69.8 | 116.3 | 125.1 |
| random-1m | auto | 1064.0 | 566.5 | 562.3 |
| random-1m | relay | 67.3 | 114.4 | 113.0 |
| random-64m | auto | 1287.7 | 727.9 | 690.9 |
| random-64m | relay | 388.3 | 243.8 | 311.6 |
| compressible-64m | auto | 1283.0 | 875.7 | 752.7 |
| compressible-64m | relay | 322.1 | 453.2 | 233.0 |

CD wins some small-file cases and loses several medium/bulk cases. Neither
the all-case 1.5x nor 2x speed gate passes (`pass1_5=false`, `pass2=false`).
Those flags describe the performance comparison; no output-verification failure
occurred in this final cohort. Automatic CD transfers of at least 1 MiB used
authenticated local **TCP**, as recorded in `directProtocol`; these rows are
not WebRTC speed evidence. The 4 KiB and forced-relay rows used the relay.
The remaining native SDP-gathering delay is included in the automatic timings.

## Native comparison method

`croc-matrix.json` is the final native product run: five repetitions per tool,
payload and route, seeded randomized block order, one Linux host, local relays,
disk output and RAM-backed relay control state. Each output's complete SHA-256
and size match the input manifest. Receiver completion and file/directory fsync
are measured separately; verification runs after timing. Input/page caches are
allowed. Trial pacing occurs outside transfer timing and respects code admission
limits. CD uses its default striping policy and automatic transport selection;
croc is tested with its default compression and with `--no-compress`.

Automatic mode permits local discovery and fallback. It is not a forced WebRTC
test. Forced relay disables CD direct transport and uses croc's explicit
`--transport relay --no-local`. Native implementations and local relay stacks
differ. None of these numbers measures WAN speed, production Cloudflare limits,
physical storage durability guarantees, cross-device behavior or concurrency.

The croc release is upstream **11.6.5**, downloaded from its official GitHub
release and checked against its published checksum:

```text
croc_v11.6.5_Linux-64bit.tar.gz
01bbbb4eafe12c01ddb84ddebf556c35ea9989a976f4abc7e72933c2a6e5e61e
```

The raw report also fingerprints both executable binaries and benchmark sources.
Reproduce with Go 1.26.11, Node 24 and the pinned croc binary:

```sh
npm ci && npm run build
node scripts/bench-croc-matrix.mjs --croc /absolute/path/to/croc \
  --runs 5 --cases random-4k,random-1m,random-64m,compressible-64m \
  --routes auto,relay --storage disk --disk-dir /absolute/output-parent \
  --seed cd-2026-11-16 --output /absolute/croc-matrix.json
```

The first attempt exceeded share-code lookup limits. Its incomplete rows and
HTTP 429 failures remain in `croc-matrix-admission-failure.json` and `.log`.
That attempt was interrupted, not used as winning evidence. The final runner
spaces CD trial starts at least 5.5 seconds apart, outside timing, and starts a
fresh local Worker. Production lookup protection was not relaxed.

The next attempt exposed a benchmark validation error: compressed encrypted
wire bytes were compared against the larger original plaintext size. All ten
compressed CD outputs passed manifest/SHA verification before this incorrect
counter check rejected them. That complete attempt is retained in
`croc-matrix-compression-accounting-failure.json` and `.log`, not counted as a
passing cohort. The corrected validator requires safe, nonnegative, nonzero
ciphertext telemetry and validates the complete plaintext separately. Regression
tests cover compressed counters, invalid counters and forced-relay leakage.

## Correctness validation

The tested implementation is source commit
`2b3a5ae6abad4e91fcbf90b57234c9e51f93a58d`. The following passed:

- `npm test`: 221 tests, zero failures/skips.
- `go test ./...`: full CLI and device suites, with per-command `umask 022`.
- Direct/link/assembly Go race tests.
- `npm run typecheck` and `npm run typecheck:sdk`.
- `npm run build` and `npm run deploy:dry`.
- `npm run verify:security`: actual Worker/DO admission, rate-limit, origin,
  numeric-code, expiry and race regressions.
- `npm run verify:agent`, `npm run verify:browser`, and
  `npm run verify:terminal`: real CLI/browser transfers and numeric-code entry,
  verified bytes, multi-file delivery, QR flow and code release.
- `npm run verify:v2`: actual resumable relay, authentication, hibernation,
  replay, recovery and session-limit checks.

The existing Go permissions fixture assumes a nonrestrictive umask. With this
environment's initial `0077`, its requested mode `0644` became `0600` and its
insecure-permissions assertion failed. The unchanged suite passes with `0022`;
both logs are retained in the CLI evidence directory. No permission check was
removed or weakened.

`validation.json` records the final outcomes. A separate rebuild with
`go build -buildvcs=false -trimpath` reproduced the exact tested CLI binary
SHA-256, `5d37ff50a2940644c4d8965ba4369eedeeb21b6ad58d43514afdb155a0290be1`.
The final native runner/helper hashes and browser runner hash match the
committed source. `wrangler whoami` reported no authenticated Cloudflare
account, so neither production nor staging was deployed.

## ToffeeShare and browser connectivity

`browser-fresh.json` is a separate six-transfer CD correctness/performance
cohort: three automatic and three forced-relay transfers of the same random
64 MiB input between two Chromium processes. All six full outputs verified.
Measured receive/save rates were 12.22–16.45 MiB/s, all through the local
Wrangler WebSocket fallback. These are neither production Cloudflare rates
nor a measured before/after improvement. The development proxy negotiated
`permessage-deflate` despite the deployment configuration's opt-out; the raw
socket extensions are retained. There is no production compression claim.

The existing `fresh-transfer-gates.mjs` correctly returns failure because each
automatic trial carried zero direct bytes. `browser-performance-gate.json`
retains all three direct-route failures. The receive-rate and stall checks
passed; the required P2P acceptance gate did not. This environment does not
provide a green direct-browser performance sign-off.

`p2p-browser-smoke.json` exercises the real public ToffeeShare service and CD's
numeric-code browser flow with the same independently generated random file.
It retains full output verification, actual ICE candidates, per-peer data
channel counters, binary WebSocket counters, script hashes and failures.

This machine's managed Chromium sets `WebRtcIPHandling` to
`disable_non_proxied_udp`. ICE gathering produced no candidates; the policy was
preserved. CD completed through its WebSocket fallback. ToffeeShare produced
its share link and receiver Download interface, but no download started before
the 30-second deadline. Its failed row is retained and comparison ratios are
null. This cannot establish which product is faster at P2P transfer.

An initial simultaneous local Worker startup failed with an address conflict;
that separate setup failure is preserved in `p2p-browser-setup-failure.json`.
The successful startup smoke was run serially afterwards. Any pre-hardening
smoke retained alongside the final report is diagnostic, not a repeated cohort.

```sh
CD_P2P_MIB=1 CD_P2P_RUNS=1 CD_P2P_TIMEOUT_MS=30000 \
  CD_P2P_OUTPUT=/absolute/p2p-browser-smoke.json \
  node scripts/bench-p2p-browser.mjs
```

For a useful product comparison, run at least five repetitions on permitted
direct-capable endpoints. The manual `P2P comparison benchmarks` workflow
provides a checksum-pinned CLI matrix and an optional real ToffeeShare test.
Raw JSON and failed trials are uploaded without asserting a global winner.

## Scope of claims

These changes reduce specific implementation costs. They do **not** prove
that CD is the fastest or best P2P product, or that all bottlenecks are gone.
Internet capacity, endpoint CPU and disk, browser SCTP, packet loss, NAT and
fallback availability remain material. The one-second bounded native SDP
gathering wait can dominate an immediately joined medium-file handoff when STUN
does not respond; it remains visible in automatic-route timings rather than
being excluded from the comparison.

A broader acceptance run needs separate machines and operating systems,
multiple network regions, real phones, representative directories and already
compressed files, 1–10 GiB bulk files, and controlled bandwidth/RTT/loss/NAT
conditions. Measure setup, verified saved completion, CPU/RSS, failures and
actual payload routes for all three products. A result applies only to its
recorded conditions. Five-digit code security is unchanged; sensitive transfers
still require a private link as documented in `SECURITY.md`.
