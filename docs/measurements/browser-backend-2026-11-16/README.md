# Browser backend changes, 2026-11-16

Baseline: `11136c008b01e282b1528c23861384e63dd050aa`.
These are local measurements and correctness checks, not a global speed ranking.

## Multi-file checksum stage

Browser multi-file sends create an uncompressed ZIP incrementally. Its IEEE
CRC32 used a dependent table lookup for every byte. The candidate uses
slicing by eight with an 8 KiB lookup table, retaining the same incremental
CRC32, archive format, names, sizes and memory-bounded file streaming.

`crc-browser.json` retains seven alternating pairs in managed Chromium
156.0.8078.79, using the same preloaded random input for both implementations.
Each trial processes 128 MiB in 256 KiB blocks after one untimed warm-up per
implementation. Node's independent native `zlib.crc32` verifies every result.
Input and module SHA-256 fingerprints are in the raw report. Baseline median
CPU time was 332.3 ms; candidate median was 225.1 ms (1.48 times the checksum
throughput). All seven candidate trials were faster. The earlier exploratory
cohort is also retained: 315.5 ms and 212.3 ms medians, or 1.49 times.

These measure CRC32 alone. They exclude disk reading, ZIP assembly, encryption,
networking and receiver storage. Neither multiplier is an end-to-end transfer
speedup or evidence of beating croc or ToffeeShare.

Reproduce from the repository root:

```sh
git show 11136c008b01e282b1528c23861384e63dd050aa:src/zip-bundle.js > /tmp/cd-zip-baseline.js
node scripts/bench-zip-crc.mjs /tmp/cd-zip-baseline.js /tmp/cd-zip-crc.json
```

## Direct channel drain

The direct WebRTC sender formerly polled native buffer capacity every 10 ms.
It now waits for `bufferedamountlow` at the point when a 64 KiB wire piece
fits, maintaining the existing 4 MiB native buffer cap and independently
bounded ciphertext queue. Cancellation, native close/error and the existing
90-second deadline wake blocked sends and release their queue budget.
Wire records, ordering, encryption and five-digit code semantics are unchanged.

No WebRTC throughput gain is claimed here. This environment's managed Chromium
policy sets `WebRtcIPHandling` to `disable_non_proxied_udp`; a standalone
host-only WebRTC probe completed ICE gathering with zero candidates. Existing
auto-route product measurements also sent zero payload bytes through WebRTC.
The policy was left in place. Actual direct performance needs a permitted
direct-capable runner; fallback results must be labeled relay.

Both browser transfer paths now use Cloudflare's documented public STUN
endpoint, `stun:stun.cloudflare.com:3478`, replacing Google/Twilio defaults.
STUN does not provide a TURN relay or guarantee NAT reachability. See the
[free-tier constraints](../../cloudflare-free-tier.md).

## Correctness

`node --test src/direct-link.test.js src/relay-sender.test.js src/zip-bundle.test.js`
passed 36 tests. Coverage includes independent bitwise IEEE CRC32 over empty,
short, unaligned and incremental inputs; ZIP extraction and ZIP64 compatibility;
encrypted relay/direct switching; native drain wakeups; cancellation and
native error/close; negotiated SCTP limits; exact reassembly; and hard queue
bounds. The wider build, suite and product checks are recorded separately.
