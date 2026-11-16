# CLI bulk-transfer hot paths

These component and diagnostic measurements accompany the second performance
iteration after `d71a05152d20c6b211cf24d8f3a491f07d1e4a08`. They are not the final
CD-versus-croc acceptance cohort and do not establish a worldwide speed ranking.

## Relay write framing

Gorilla's default client buffer is 4 KiB. An encrypted 768 KiB application
record becomes 193 WebSocket fragments and corresponding `net.Conn.Write`
calls. A bounded maximum-record client buffer (1 MiB plus the library's frame
header) sends that same record in one frame/write. TLS/TCP can split an actual
network write further; these are neither packet counts nor a syscall guarantee.
All message, authentication, ACK-window and Worker memory limits remain intact.

`client-buffer-microbenchmark.txt` measures real client masking/framing over
loopback TCP. Three samples per variant, 768 KiB ciphertext records, verified
message sizes; the unit test independently verifies complete ciphertext bytes.

| Client buffer | Writes / record | Median ns / record |
| --- | ---: | ---: |
| 4 KiB | 193 | 916,535 |
| 64 KiB | 13 | 259,296 |
| 256 KiB | 4 | 288,962 |

The isolated client benchmark favored 64 KiB, but this was not the complete
application. A separate end-to-end diagnostic held the CLI sources, Worker,
Wrangler runtime and random 64 MiB input fixed. Go `-overlay` changed only
`relayWriteBufferSize`. Six three-run blocks used buffer order
64 KiB, 256 KiB, 1 MiB, 1 MiB, 256 KiB, 64 KiB. Each block also ran both croc
reference configurations. All **54 outputs** verified, including 18 CD outputs.
Every output was explicitly fsynced and SHA-256 verified by the matrix runner.

| Client buffer | CD median receiver + fsync, ms | Range, ms | Median total, ms |
| --- | ---: | ---: | ---: |
| 64 KiB | 325.67 | 253.96–468.51 | 354.31 |
| 256 KiB | 333.83 | 274.29–359.54 | 360.22 |
| 1 MiB | 283.13 | 249.04–309.49 | 312.91 |

The 1 MiB configuration was about 1.15 times faster than 64 KiB in these local
medians. It is the selected default because full-path evidence is more relevant
than a client-only result. This is not a 3.5-times product speedup and does not
establish statistical confidence or a 1.5–2-times win over croc.
`buffer-variants/` retains every raw block, CLI/overlay fingerprints and the
source identity checked before and after every block. Exact overlay Go inputs
are saved as `.go.txt` so they are not compiled as additional project packages.

`bench-relay-buffers.mjs` is the exact diagnostic driver from this Cloud
workspace. It expects `/workspace/work/toolchains` and a pre-selection
`retry.go` constant of `64 * 1024`. For an equivalent new run, adapt its paths
and constant match to your checkout, or use the saved overlay source files.
Do not substitute this diagnostic for the final comparator matrix or deploy
the local benchmark Worker configuration.

## Compatible deflate encoder

The encoding half now uses sumdb-verified, pinned
`github.com/klauspost/compress/flate v1.20.4` (requires Go 1.25; this checkout
uses Go 1.26.11). It still emits RFC 1951 `deflate-v1` records. The strict
standard-library decoder is unchanged, including exact inflated-length, EOF,
truncation and trailing-input checks. Incompressible bytes retain the original
zero-copy raw fallback. Sampling stops as soon as the existing 225-distinct-byte
threshold proves that raw fallback will be selected.

The paired component benchmark processes the same warmed 768 KiB buffers
through both encoders, with identical framing, sampling and 90% threshold.
It excludes file/network/storage time. Both variants allocate zero bytes per
chunk after warmup. `wire/raw` includes CD's compression prefix.

| Corpus | Standard median ns | Optimized median ns | Standard / optimized wire ratios |
| --- | ---: | ---: | --- |
| Repeated Go source | 1,642,185 | 457,857 | 0.05184 / 0.04648 |
| Zeros | 424,312 | 220,285 | 0.001245 / 0.001058 |
| Random, raw fallback | 457.9 | 441.9 | 1.000 / 1.000 |

These are about 3.59-times and 1.93-times faster compression stages, not whole
transfers. Raw random-data processing only samples a prefix: its benchmark
`MB/s` must not be presented as full-file processing or network throughput.

`TestFastDeflateInteroperability` covers empty/short/boundary inputs, repeated
source, random data, low-alphabet ASCII, deceptive low-entropy prefixes and all
byte values, including repeated writer resets and independent standard decoding.
Existing malformed/compression negotiation and encrypted relay tests also pass.
An independent Chromium 156.0.8078.79 `DecompressionStream('deflate-raw')`
verified every emitted compressed fixture byte-for-byte. Its raw SHA-256
results are in `deflate-browser-interop.json`. This checks RFC interoperability;
it is not a browser file-transfer measurement.

Reproduce from the repository root:

```sh
go test ./cmd/cdx -run 'Test(FastDeflate|CompressedChunks|NegotiatedCompression)'
go test ./cmd/cdx -run '^$' -bench '^BenchmarkDeflateEncoder$' -benchmem -benchtime=250ms -count=3
CD_COMPRESSION_INTEROP_FIXTURES=/tmp/deflate-fixtures.json \
  go test ./cmd/cdx -run '^TestFastDeflateInteroperability$'
```

The browser verification helper records the exact Cloud workspace paths; adapt
its fixture/output/import paths when reproducing outside this machine.

## Explicit, bounded receive storage reuse

A 512 MiB random forced-relay CPU/heap diagnostic identified about 522.48 MiB
of sampled allocation in `recordLink.readRelay`, 99% of receiver allocations.
The receiver decrypted those individually owned buffers in place, wrote them
synchronously, and then discarded them.

Only ordinary CLI receiving now opts into a per-link pool of at most eight
buffers, each at most the existing 1 MiB maximum record. Callers explicitly
release a payload after JSON parsing, or after decompression, validation, disk
write and ACK encoding. Deferred release covers errors and END. Default link
callers and resumable sessions retain their original payload lifetimes. Direct
transport and pending out-of-order records are not inserted into a pool that
only the relay reader can consume. Pools never cross transfers.

Tests exercise omitted and repeated releases, preserved default ownership,
out-of-order queued records, reused ciphertext storage, authentication failure,
cancellation, direct-buffer exclusion and the hard 8 MiB retained-storage cap.
The focused race suite passed. No ACK precedes its existing write/durability
requirements, and cancellation still closes the reader via existing cleanup.

A post-change 512 MiB diagnostic estimated about **14.57 MiB** of receive
allocation, about 97.2% less. Heap profiles are sampled estimates. The pool does
not make CPU/network/I/O costs disappear.

Crucially, the two diagnostic wall times were **2.10 s before and 3.91 s after**.
This is not paired speed evidence: receiver kernel file-write CPU changed from
0.29 s to 1.22 s, and both workerd processes also used more CPU in the latter
run. We retain both unfavorable and favorable observations and claim allocation
reduction only. Final unprofiled application comparisons must judge latency.

| 512 MiB diagnostic | Before reuse | After reuse |
| --- | ---: | ---: |
| Entry/dev-proxy workerd CPU | 1.53 s | 2.12 s |
| Actual Worker workerd CPU | 1.48 s | 2.85 s |
| Wrangler Node CPU | 0.02 s | 0.09 s |
| Receiver sampled CPU total | 1.08 s | 1.84 s |

Both full output SHA-256 values matched their independently generated input.
Both profiles used the then-current 64 KiB client write buffer; the 1 MiB
selection came afterwards and needs its own final unprofiled comparison.
`profile-before-reuse/` and `profile-after-reuse/` retain raw Go profiles, CPU
and allocation tables, logs and `/proc` CPU counters. The post-change report
also fingerprints the profiled binary, local diff and relevant source files.
The baseline profile predates those extra fingerprints and has more limited
provenance; neither is acceptance evidence.

`profile-relay.mjs` uses the existing `cdprofile` build tag rather than adding a
production profiling endpoint. Its Go test/profiler startup and shutdown are
inside the diagnostic wall time, which must never be mixed into normal matrix
timings. Its paths describe this Cloud workspace. Both used the same Wrangler
configuration; the baseline's more limited fingerprints do not establish a
fully frozen-source A/B. No favorable-runtime substitution was made.
