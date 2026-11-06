# Browser resume OPFS storage experiment

This investigates the receiver's repeated `createWritable({ keepExistingData: true })`, seek, write, and close for each 256 KiB resumable chunk. The candidate keeps one worker-owned synchronous OPFS handle and flushes after every chunk. The initial comparison is storage-only. A local receiver prototype now uses this path; it has not been deployed.

The benchmark uses an explicit persistent Chromium profile beneath the user's home cache. Its report includes the profile filesystem metadata. The earlier October 17 storage experiment used Chromium's default temporary profile, which can reside on tmpfs on this host. Neither experiment proves physical power-loss durability. Browser API flush completion is the available persistence barrier.

The candidate receives one cloned 256 KiB chunk per main-thread RPC, loops over short writes, flushes, and replies. The main thread waits for that reply before the next chunk. Timings include worker creation, handle acquisition, every message copy, every flush, and final handle close. Random source setup, reopened-file SHA-256 verification, and file removal are outside timing. Memory for the write path stays bounded by one chunk plus its worker clone. Benchmark verification constructs a complete reference separately.

Each file size gets one warmup pair followed by seven measured pairs with alternating mode order. Four MiB segment times show whether write cost grows with the already-written prefix.

Reproduce:

```sh
CD_OPFS_RUNS=7 CD_OPFS_SIZES_MIB=8,32 node scripts/bench-resume-opfs.mjs
```

`CD_OPFS_PROFILE_ROOT` can select another filesystem for the temporary browser profile. The runner deletes its profile and staged files when finished.

## Measured results

Chromium 155.0.8059.84 on an Intel Core i5-13420H, with its temporary profile on btrfs, completed all 28 measured files with SHA-256 verification. These are medians of seven measured trials per mode and size.

| File size | Reopen writable every chunk | Worker write and flush every chunk | Ratio |
| --- | ---: | ---: | ---: |
| 8 MiB | 188.6 ms, 42.42 MiB/s | 78.0 ms, 102.56 MiB/s | 2.42× |
| 32 MiB | 2377.6 ms, 13.46 MiB/s | 279.7 ms, 114.41 MiB/s | 8.50× |

The baseline slows as its retained prefix grows. In one 32 MiB trial its first 4 MiB took 52.5 ms and its last 4 MiB took 497.1 ms. The worker path's 4 MiB segments stayed between 27.3 and 40.2 ms in that trial. This is consistent with repeated prefix copying in the stream path. The benchmark does not directly instrument the browser's internal copy operations.

The magnitude and scaling justify a production prototype with the lifecycle and recovery checks below. They do not establish an end-to-end browser transfer speedup. Source hashing, authenticated checkpoint writes, network transfer, and receiver decryption remain additional costs.

## Production design requirements

The local receiver prototype follows the requirements below. Its helper falls back during initialization when dedicated workers or synchronous handles are unavailable. After initialization, worker and storage failures abort the session while preserving its last authenticated checkpoint.

1. Retain ADR-0001 ordering. Complete the chunk's write and `flush()`, then persist its authenticated checkpoint with strict IndexedDB durability, then ACK that exact offset. An in-memory write or a posted worker message is insufficient.
2. Acquire the exclusive worker handle after existing recovery validates the checkpoint, rehashes its prefix, and truncates bytes beyond its durable offset.
3. Keep one append operation outstanding. Check actual write counts, loop over short writes, and reject zero-byte progress. Propagate quota, write, flush, worker, and checkpoint errors without advancing the checkpoint or ACK.
4. Close the handle before `getFile()` and whole-file publication. On interruption, close it while preserving committed staging and checkpoint data. A stopped worker that retains the exclusive lock would prevent immediate resume in the same page.
5. Cancellation must wait for any serialized append/checkpoint operation, then close and delete staging and checkpoint. Keep close/cancel idempotent across races. A crashed worker releases its handle; recovery must still reject truncated/corrupt prefixes and truncate an uncheckpointed tail.
6. Fall back to the current writable-stream path only when worker or sync-handle initialization is unavailable. Do not silently switch after a partial append or failed flush. Terminate an initialized worker and release resources before fallback.
7. Use a bundled, same-origin module worker. Validate its operation messages at the boundary and keep file handles internal. Test capability absence, worker startup failure, quota failure, short writes, cancellation during append, interruption/reopen, corrupted prefixes, and successful browser downloads.

The [File System Standard](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle) specifies an exclusive lock until close and describes flush visibility. [MDN's flush documentation](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush) states that `flush()` persists writes to disk. The API is available in dedicated workers and secure contexts, so the writable-stream fallback remains necessary.

## Correctness evidence

`node scripts/verify-resume-opfs-worker.mjs` uses a real Chromium dedicated worker, native OPFS, and strict IndexedDB. The worker acquires the actual exclusive handle, writes and flushes 256 KiB, then crashes before replying. The receiver stage rejects the append and keeps its checkpoint offset at zero. Without navigating the page, a normal worker then reopens the same stage, truncates the uncheckpointed bytes, and finishes all 262,163 expected bytes. The result is saved in `opfs-worker-crash-recovery.json`.

The helper unit checks run the actual worker handler with a controlled file handle to exercise partial writes, zero-progress writes, quota/flush failures, and worker crashes. Stage tests hold both the flush response and checkpoint commit to verify that cancellation waits for both, closes the handle, and removes state. A separate close-failure cancellation check proves that cleanup still runs. The built worker is a separate same-origin Vite asset, so the existing `worker-src 'self'` policy permits it.

The new cross-client recovery test exposed an independent queue mismatch. The CLI can send a 4 MiB plaintext window, while the browser inbox previously permitted only 2 MiB. The browser now has a fixed 4 MiB + 64 KiB byte cap and a 32-record cap. The receiver A/B baseline shares this fix so a successful comparison isolates storage changes rather than queue compatibility. Tests prove that sixteen encrypted 256 KiB chunks plus control fit, while seventeen large chunks or thirty-three tiny records still fail.

## Actual receiver comparison

`node scripts/bench-browser-resume-receiver.mjs` completed seven alternating measured pairs after one warmup pair. It sends 32 MiB plus 77 random bytes from the actual CLI through the local v2 Worker to the actual browser receiver module. Each transfer uses native OPFS, strict IndexedDB checkpoint transactions, encrypted v2 records, whole-file verification, and an actual browser download. All sixteen downloads, including warmups, matched SHA-256 `8e9b98c994b17567b390e71b07c886bacc95f2490d0c2345d822636a91939026`.

| Receiver storage | Median completion | Minimum | Maximum |
| --- | ---: | ---: | ---: |
| Reopen writable per chunk | 5255.91 ms | 5149.97 ms | 5644.72 ms |
| Worker handle, flush per chunk | 2672.91 ms | 2638.41 ms | 2754.10 ms |

The median improvement was 1.97×, or 49.1% less elapsed time. Every candidate trial recorded exactly 129 worker write RPCs, one per chunk, so a silent fallback cannot explain the result. Baseline trials recorded zero worker writes.

Both receiver versions ran as source modules over the same built UI origin with identical shared crypto, hashing, protocol, and download helpers. Both share the four MiB inbox compatibility fix. The runner preimports each module before timing, uses context-level routes for dedicated-worker requests, and gives each receiver variant/trial a unique module URL to avoid cached module reuse. An activation assertion caught and rejected early source-harness attempts that fell back or reused the baseline. Those attempts are not included in the accepted output.

Timing starts when the receiver is mounted and ends when it reports verified completion. Sender startup and source hashing are outside timing. The browser's final downloaded copy is saved and SHA-256 checked after timing. The persistent Chromium 155 profile was on btrfs under the user's home cache. The raw report records the filesystem, load averages, receiver source hashes, shared module hashes, CLI binary hash, and relay Worker hashes. Source hashes identify a working tree, not a released build.

This proves a local resumable receiver improvement under the measured workload. It does not measure mobile hardware, other browser engines, internet/carrier routes, browser download destination fsync, or physical power-loss durability. The default v1 transfer path is unchanged by this storage work. No deployment was made.

Accepted report: `opfs-receiver-paired.json`. The preserved baseline is `resume-browser-before-sync-opfs.js.txt`; its only shared setup adjustment is the same fixed inbox cap used by the candidate.
