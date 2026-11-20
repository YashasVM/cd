# Relay handler overhead

Baseline: `11136c008b01e282b1528c23861384e63dd050aa`, `worker/index.ts`.
Candidate: the role cache and single dispatch attachment read in this change.
Runtime: Node v24.22.1 on this Cloud workspace. Five 100,000-frame trials
per variant, alternating execution order; each gets 1,000 warmup frames.

This is a **handler microbenchmark with mocked host APIs**. It invokes the
actual bundled `TransferRoom.webSocketMessage` method; fake sockets clone
attachments with `structuredClone`. `send()` counts forwarding and does not
send any bytes. There is no TCP, TLS, workerd scheduling, quota metering or
WAN measurement. The 256 KiB record is reused and never copied by the mock.
Do not translate these numbers to MiB/s or advertise a product speedup.

| Warm sender-to-receiver handler | Baseline | Candidate |
| --- | --- | --- |
| Attachment deserializations / frame | 4 | 1 |
| `getWebSockets()` calls / frame | 1 | 0 |
| Record forwarding calls / frame | 1 | 1 |
| Median milliseconds / 100,000 invocations | 615.675 | 174.089 |

The deterministic host-call reduction is the evidence for retaining this
small change. Wall times vary with shared host load; full raw trials are in
`handler-microbenchmark.json`. A real transfer benchmark is needed to judge
its effect on end-to-end throughput.

The cache has at most two sockets per warm v1 room. Its entries are created
only by the existing attachment validator, checked for `OPEN` before each
use, and rebuilt lazily from persisted attachments after hibernation. It
does not cache incoming socket authorization. Pending joins cannot become
cached peers until admitted. Bounds, forwarding, code claims, expiry and
v2 protocol behavior are unchanged.

Reproduce from the candidate checkout:

```sh
git show 11136c008b01e282b1528c23861384e63dd050aa:worker/index.ts > /tmp/cd-worker-before.ts
node --test scripts/worker-relay.test.mjs
node scripts/worker-relay-bench.mjs /tmp/cd-worker-before.ts
npm run typecheck
```

Six tests cover identical ciphertext/ACK forwarding, no warm socket scans,
instance reconstruction using existing socket attachments, closed-cache
replacement with an admitted peer only, closed peer rejection, preserved
queue limits, malformed attachment rejection and oversized record rejection.
All passed; TypeScript passed.
