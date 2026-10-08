# Wave 3: bounded browser sending window

Owner: Agent B. Owned files: `src/send-window.js`, its tests, and this document.
Dependencies: Agent A owns transport wiring, transport ciphertext/native buffer
caps, cancellation and idle timeouts. Agent C verifies real browser transfers.

API: `createSendWindow({minBytes,maxBytes,initialBytes,initialOffset})` returns
`canSend(nextChunkBytes)`, `sent(cumulativeOffset,atMs)`,
`acked(cumulativeOffset,atMs)` and getters `capacity`, `inFlight`, `size`.
`snapshot()` exposes accounting and bounded sample count. Offsets accept bigint
or safe integers; arbitrary cumulative positions stay bigint. `initialOffset`
defaults to zero. Times use one monotonic clock (default `performance.now()`).
ACK regressions, ACKs beyond sent data, invalid clocks, and oversized send
increments throw before changing state. Duplicate ACKs return false.

Before encrypting/sending each chunk, transport must wait until `canSend` accepts
its entire length. Then call `sent` with the new cumulative offset. A transport
ACK calls `acked`; byte validation here supplements transport chunk-count checks.

Default bounds are 1 MiB minimum, 4 MiB initial, 12 MiB maximum. The adaptive
window targets twice measured delivery rate times minimum positive RTT. Delivery
samples span at least 100 ms and one minimum RTT to avoid ACK compression spikes.
Outstanding data stays accounted when the window shrinks below it; no further
chunk fits until capacity recovers. Zero RTT does not update the target.
Configurable maxima cannot exceed 24 MiB, below the relay's 32 MiB budget.
The 12 MiB default fits Agent A's separate 16 MiB ciphertext retention budget
with framing overhead. Native socket buffers remain separately capped by A.

No payload is retained by the controller. RTT metadata holds at most 64 samples;
new samples coalesce when full. Tests send 100,000 tiny chunks without ACKs and
observe exactly 64 samples, then zero once all bytes are acknowledged.

Reproduce measurements with `node --test src/send-window.test.js`:

- 10 tests pass: complete-chunk admission, shrink/grow, compressed ACKs, zero RTT,
  malformed accounting, sample bound, invalid allocations, and exact counters at
  offset 2^80, plus two receiver/path models.
- Slow receiver model: 64 MiB total, 256 KiB chunks, 1 MiB/s receipt. Three runs
  are identical: 64 s, 1 MiB/s, peak outstanding 4 MiB, peak metadata 16 samples,
  final window 1 MiB. The receiver queue drains fully.
- Delayed fast path model: 256 MiB total, 256 KiB chunks, 128 MiB/s receiver and
  300 ms delivery delay. Adaptive: 7.276 s, 35.183 MiB/s, peak outstanding 12 MiB,
  48 samples. Fixed 8 MiB: 9.723 s, 26.329 MiB/s. Adaptive throughput is 33.6%
  higher with bounded outstanding data.

These are deterministic scheduling models, not browser/network benchmarks or
process RSS measurements. Whole transfer integrity, fallback, native buffering,
and real slow-receiver throughput are measured by Agent C's live matrix.
