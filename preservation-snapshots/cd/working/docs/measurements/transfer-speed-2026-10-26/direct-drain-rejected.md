# Direct drain event experiment rejected

The candidate replaced 10 ms WebRTC buffer polling with `bufferedamountlow`, waking at 4 MiB minus one 64 KiB message. It retained the 4 MiB native buffer limit, ciphertext queue cap, 90 second per-record stall deadline, and immediate wake on local close, remote close, error, and connection failure. Ten unit tests, including simulated deadline and closure cases, passed during the experiment. Production and unit-test changes were reverted because the speed improvement did not repeat.

The actual direct-link module ran over local Chromium 155 ordered WebRTC with host candidates and 32 MiB of framed records. Connection establishment and SHA-256 verification were outside timing. Every transfer matched its reference SHA-256. Encryption, application ACKs, storage, and internet traffic were excluded.

Seven alternating measured pairs followed one warmup pair in each batch. Batch 1 median throughput was 65.15 MiB/s before and 69.66 MiB/s with event wake, a 6.9% gain. Batch 2 was 30.70 MiB/s before and 26.34 MiB/s with event wake, a 14.2% regression. The variation is too large to claim a reliable improvement. An earlier three-pair experiment using the existing half-buffer low threshold also regressed.

Reproduce the rejected event candidate with:

```sh
CD_DIRECT_DRAIN_MODULE=docs/measurements/transfer-speed-2026-10-26/direct-link-event-rejected.mjs \
CD_DIRECT_DRAIN_BASELINE=docs/measurements/transfer-speed-2026-10-26/direct-link-before-drain.mjs \
node scripts/bench-direct-drain.mjs
```

Use `direct-link-half-threshold-rejected.mjs` as the candidate module and `CD_DIRECT_DRAIN_RUNS=3` for the earlier threshold experiment. Raw outputs are `direct-drain-paired-1.json`, `direct-drain-paired-2.json`, and `direct-drain-half-threshold-rejected.json`.
