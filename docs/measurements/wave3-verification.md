# Wave 3 transport verification

Owner: Agent C. Owned files: `scripts/verify-transports.mjs`, benchmark scripts/metrics/tests, `scripts/verify-agent.mjs`, and this report. Dependencies: Agent A encrypted negotiated-channel transport and queue observer; Agent B bounded adaptive window. No production transport files changed by C.

## Reproduce

```sh
npm run build
node --test scripts/bench-metrics.test.mjs
node scripts/verify-transports.mjs
CD_BENCH_ONLY=p2p,tunnel CD_BENCH_RUNS=1 CD_BENCH_MIB=64 node scripts/bench.mjs
```

The matrix defaults to 64 MiB; `CD_TRANSPORT_MIB` accepts 16..64. `CD_TRANSPORT_ONLY` selects named cases. It builds the CLI, starts an isolated local Worker, launches Chromium, verifies SHA-256 of every received payload, waits for successful sender completion, then closes browser contexts and foreground CLI children. The Worker and temporary files are removed in final cleanup. Each process is bounded to 45 seconds; the matrix has eight finite cases.

Instrumentation wraps native sends and counts only successful calls. It recognizes the negotiated `cd-direct` channel and reconstructs record boundaries across pieces, retaining at most twelve header bytes per stream. Completed authenticated CHUNK record plaintext lengths count as payload bytes; encrypted wire bytes remain separate. It also measures incoming payloads, native queues, opt-in engine statistics, and sampled JS heap. Counter tests prove partial records are not counted, throwing sends are not counted, and historical `cd-raw` traffic cannot be mislabeled encrypted direct.

## Final 64 MiB matrix: 8/8 passed

Linux amd64, Go 1.26.8, Node 26.10.0, local Worker and Chromium. Every row verifies 67,108,864 original bytes exactly. Values are one measured acceptance run, not statistically stable internet throughput estimates.

| Case | Readiness | Transfer duration | Direct payload bytes | Relay payload bytes |
| --- | ---: | ---: | ---: | ---: |
| Browser → browser | 319.854 ms | 3.191 s | 67,108,864 | 262,144 |
| Browser → CLI | 263.369 ms | 1.765 s | 66,060,288 | 5,242,880 |
| CLI → browser, 10 ms decrypt delay | 16.835 ms | 3.877 s | 47,185,920 | 28,311,552 |
| Browser → browser, blocked direct | 314.060 ms | 3.423 s | 0 | 67,108,864 |
| Browser → CLI, blocked direct | 264.623 ms | 2.116 s | 0 | 67,108,864 |
| CLI → browser, blocked direct | 23.358 ms | 1.965 s | 0 | 67,108,864 |
| Browser → browser, delayed direct upgrade | 242.591 ms | 5.608 s | 67,108,864 | 262,144 |
| Browser → browser, slow receiver | 241.193 ms | 7.683 s | 67,108,864 | 0 |

Overlapping route totals include ciphertext replay during upgrade; they do not mean additional unique source bytes. The upgrade row delays offer creation by 150 ms and decryption by 10 ms per record, verifies the first payload route is relay, then requires direct payload. The slow receiver delays decryption by 20 ms per record. Blocked cases prevent browser peer creation and set `CD_DIRECT=0` in CLI peers; all finish with zero direct payload and complete relay payload. Successful direct cases require at least 1 MiB of observed payload on that path.

A 16 MiB CLI → browser transfer could finish before the channel opened, even with ICE connected. The matrix correctly failed that requested-direct gate rather than calling negotiation successful transport. Raising the fixture to 64 MiB demonstrated actual encrypted direct payload. Earlier 16 MiB browser → browser and browser → CLI cases also verified actual direct bytes.

## Memory and queue evidence

Across the matrix:

| Measurement | Observed maximum | Enforced bound |
| --- | ---: | ---: |
| Native data-channel buffered bytes | 4,181,104 | 4 MiB + one maximum record (5 MiB) |
| Native WebSocket buffered bytes | 4,063,924 | 4 MiB + one maximum record (5 MiB) |
| Sender retained ciphertext | 4,194,752 | 16 MiB |
| Sender incoming ciphertext / records | 1,004 / 3 | 4 MiB / 256 |
| Record merger pending bytes | 0 | 16 MiB |
| Adaptive in-flight payload | 5,767,168 | 12 MiB |
| RTT samples retained | 22 | 64 |
| Sampled JS heap | 96,568,847 | Observational; no total renderer RSS assertion |

The engine observer is opt-in and reports sizes only, without keys or payload. These assertions verify queue and adaptive-window bounds on real transfers; the sampled heap includes allocations awaiting collection and is not a claim about total browser memory or external backing stores. A's protocol-limit tests cover hostile ordering/assembler limits; B's tests cover delayed/slow receipt controller bounds.

Benchmark `p2p` now means encrypted negotiated direct and requires actual direct payload. `tunnel` blocks direct and requires complete relay payload. `legacy` remains an explicit unsupported failure. Agent verification now reads byte reports rather than quiet progress text, avoiding a false relay label when progress is disabled. Browser engine evidence tests pass 5/5.

The separate 64 MiB benchmark completed 1/1 in each mode: encrypted direct readiness 74.77 ms, transfer 4.0659 s, 15.74 MiB/s, 67,108,864 observed direct payload bytes; forced relay readiness 54.39 ms, transfer 2.3013 s, 27.81 MiB/s, zero direct bytes and 67,108,864 relay payload bytes. Both files matched SHA-256. This local loopback run demonstrates working routes, and does not establish direct as faster than local relay.
