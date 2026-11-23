# Paired HTTP stream feasibility, 2026-11-16

This is an isolated, loopback-only transport diagnostic. It is not a CD feature,
a deployment, an encrypted transfer, or evidence of beating croc. No production
source was edited. The driver launches ephemeral Miniflare with a SQLite Durable
Object binding and random per-role bearer tokens. It retains no payload in DO
storage. Its setup endpoint and volatile admission state are diagnostic scaffolding,
not production authentication or recovery logic.

## Findings

A POST's native `request.body.pipeTo()` into an `IdentityTransformStream` can feed
a separate GET response in the same DO. This avoids the previously observed
HTTP/1 echo stall: the uploading connection need not read its own streaming
response while still sending its body. The POST awaits pipe completion; it does
not return a premature success response that might cancel an outstanding upload.

The paired control uses actual hibernatable DO WebSocket callbacks and binary
forwarding, a 1 MiB message cap and a 32 MiB receiver queue cap. Both transports
use the same preloaded random bytes, Node clients, 768 KiB producer pieces,
separate fresh rooms, and full output SHA-256 checks outside transfer timing.
Received data stays in client RAM. HTTP honors Node's writable backpressure;
WebSocket sender buffered bytes are capped at 4 MiB. These APIs have different
buffering and framing, so this is an architectural transport ceiling, not a
fully isolated CPU comparison.

Three 64 MiB alternating pairs are in `paired-64m.json`:

| Pair | HTTP ms | WebSocket ms | WS / HTTP |
| --- | ---: | ---: | ---: |
| 0, cold | 341.39 | 413.55 | 1.21 |
| 1 | 89.38 | 207.35 | 2.32 |
| 2 | 70.24 | 164.84 | 2.35 |

All six complete outputs verified. Median HTTP time is 89.38 ms and WebSocket
207.35 ms, a 2.32 ratio. Large cold-to-warm changes make this a preliminary
feasibility signal. This excludes CD encryption, ACK windows, code lookup,
admission setup, disk I/O, save completion, WAN latency and croc. Do not publish
it as a CD product speedup. No warmup was excluded from the reported cohort.

Reproduce from this directory, using the parent's installed dependencies:

```sh
STREAM_MIB=1 STREAM_RUNS=1 STREAM_TRANSPORTS=http,websocket \
  STREAM_OUTPUT=paired-semantic-smoke.json node probe.mjs
STREAM_MIB=64 STREAM_RUNS=3 STREAM_TRANSPORTS=http,websocket \
  STREAM_OUTPUT=paired-64m.json node probe.mjs
```

The driver records source/runner hashes and Node version. The JSON result's
tokens are deliberately omitted. `wrangler.jsonc` has no deployment routes.

## Free-tier constraint: upload segmentation is required

Cloudflare's current limits specify a 100 MB incoming HTTP body cap for domains
on Free or Pro; this depends on the domain plan, not Workers pricing. Streaming
does not remove the HTTP body limit. Responses have no enforced body-size cap.
The HTTP request can remain active while its client is connected; a streaming
response also keeps its DO active. Workers Free retains its request, CPU,
memory and duration quotas. See [official Worker limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits).

Therefore an unlimited one-POST file upload must not ship. A possible production
design would cap each ciphertext upload body at 32 MiB (or at most 64 MiB),
concatenate ordered authenticated segments into one continuous GET response,
and preserve the existing 24 MiB-or-smaller unacknowledged-data window. Segment
boundaries must count wire bytes, not original plaintext, because compression
and record framing change sizes. A 32 MiB cap is below both decimal 100 MB
and the relevant default 100 MiB internal outbound limit.

The primitive is documented as forwarding byte chunks unchanged, with optional
fixed-length validation available through `FixedLengthStream`. See
[official transform-stream API](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#identitytransformstream).

## Required production protocol and security work

This is a design sketch, not implemented or approved production code:

1. Negotiate a new transport capability through authenticated encrypted CD
   OFFER/ACCEPT. Older Workers and clients keep WebSocket data. Keep code lookup,
   source consent, control, ACK, END and COMPLETE semantics unchanged.
2. Register a random sender-only upload-token hash through the admitted sender
   socket, and bind download authorization to the authenticated receiving role.
   Bind both roles to the transfer ID and a fresh stream-attempt nonce. Tokens
   belong in authorization headers, never query strings or logs. A receiver
   credential must not authorize upload; possession of a routing ID is not proof.
3. Forward exactly the same GCM-encrypted records with their existing sequence
   numbers and direction keys. The receiver parses bounded record headers from
   arbitrary HTTP byte chunks. The server must not decrypt, reconstruct whole
   files or store ciphertext. HTTP segmentation must not reset record nonces.
4. Admit one continuous download and one current upload segment. Require the
   expected integer segment index and exact declared wire length, with a strict
   32/64 MiB cap. Reject duplicates, gaps, stale attempts, completed roots and
   simultaneous replacement requests. A native fixed-length stream can detect
   truncation/overflow without a JavaScript per-byte loop. Broken segments fail
   the attempt; do not append a retry's duplicated prefix to the same stream.
5. Use native pipe backpressure and existing application ACK limits. Optionally
   allow one authenticated next-segment request to wait behind the active native
   pipe, but do not buffer its entire body. Strict request-count/length/idle
   limits and single-use role leases are still required.
6. A pipe finishing or POST 204 is not verified delivery. Only CD's authenticated
   COMPLETE after exact output verification publishes success. All disconnect,
   cancellation, reset and expiry paths must abort both stream ends and free
   role leases. Runtime reset ends a v1 stream; it must not recreate a live stream
   from volatile flags. Existing resume must retain its separate durable contract.
7. Compare real encrypted CLI/browser transfers against unchanged croc, including
   files larger than 100 MB, sequential segment boundaries, throttled receivers,
   WAN RTT/loss, quota exhaustion, tampered/truncated segments, replay, lost
   COMPLETE, and mixed old/new peers. Measure Worker CPU/duration and memory
   under an actual Free account before claiming compatibility with its quotas.

Serial segment requests add an RTT at every boundary. At 1 Gbit/s, 32 MiB takes
about 268 ms to send; a 150 ms boundary RTT would add roughly 56% to that time.
An optional bounded next-request pipeline could hide part of that cost, but it
adds state and replay complexity. Native HTTP throughput alone does not prove
the segmented production design will outperform the existing path on WANs.

## Prototype limitations

The prototype has no durable admission tombstone, idle cleanup or restart
recovery, and its GET/POST bridge is volatile. Authentication checks, single
receiver/sender admission, role separation, origin restrictions and output hashes
are exercised by the driver, but disconnect and slow-consumer safety are not
fully tested. It must remain loopback-only and must not be deployed or copied
into production as-is.
