# CLI queued record overhead

The baseline was the pre-existing dirty working tree on HEAD `0309a0802c032775a4925671eb99383afb2323eb`, not a clean HEAD checkout. Existing `cmd/cdx/link.go` changes added `newTransferTiming` calls in `finish()`. Those changes were preserved and are outside the measured `next()` path. Existing uncommitted sender, receiver, worker, and benchmark changes were also preserved.

The new `BenchmarkLinkNextQueued` constructs a real encrypted empty ACCEPT record, puts it in the inbound queue, and calls `next()` to authenticate and deliver it. Every iteration checks the delivered kind, payload, and error. It resets record sequence state to reuse this immutable empty record. It measures per-record reader overhead, not payload throughput or end-to-end transfer time.

Before the change, `next()` started with `timer := time.NewTimer(timeout)`. To reproduce the baseline, remove only the new ready/one-item fast path before that line, retaining the benchmark and all other working tree changes. Restore the fast path for the candidate. Run the commands captured in the adjacent before/after files serially without other performance jobs.

The final fast path checks already-ready records before queued errors, consumes at most one queued item before entering the timed loop, and starts a timer only when further waiting is required. The regression test covers ready-record precedence over a queued disconnect error.

Median queued-record processing fell from 361.4 to 130.1 ns, a 64.0% reduction. Allocation fell from 296 to 48 bytes and from five to two allocations per operation. No end-to-end transfer speed claim follows from this microbenchmark.

The before/after text files reproduce captured tool output with whitespace normalized, rather than redirecting output during a later rerun.
