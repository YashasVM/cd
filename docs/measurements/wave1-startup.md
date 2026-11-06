# Wave 1 startup efficiency

Detached sends used to run `prepareSource` in both the parent and holder. Each directory preparation recursively lists entries and writes zero-filled payloads through the ZIP writer to compute the exact archive size. The parent now checks only named inputs, opens regular files, probes directory readability, and rejects colliding top-level names. The holder performs the full walk and sizing once. Nested filename/read errors still reach the caller through the holder log. The readiness timeout now identifies folder preparation as well as relay setup.

Owner: Agent C. Files: `cmd/cdx/bundle.go`, `bundle_test.go`, `bundle_bench_test.go`, `detach.go`, `detach_test.go`, and this report. The detached progress contract depends on Agent B's `sendRequest.progress` and `progressRequested`.

## Repeatable fixture and measurements

Linux amd64, Intel Core i5-13420H, Go 1.26.8, warm filesystem cache. Each directory contains 100 files; each file contains 4096 zero bytes. Fixture creation is excluded from timing. Three samples, three benchmark iterations per sample; values below are medians.

```sh
go test ./cmd/cdx -run '^$' -bench BenchmarkDetachedPreparation -benchmem -benchtime=3x -count=3
```

| Fixture | Before: two preparations | After: shallow validation + preparation | Allocated before / after | Parent validation |
| --- | ---: | ---: | ---: | ---: |
| 1,000 files / 10 directories | 11.410 ms | 5.186 ms | 11.110 / 5.556 MB | 0.0118 ms |
| 10,000 files / 100 directories | 103.208 ms | 48.543 ms | 114.643 / 57.328 MB | 0.0251 ms |

Preparation takes 54.6% and 53.0% less time, respectively. The holder still owns approximately 57 MB of cumulative allocations for the 10,000-file fixture; this change halves duplicate work rather than redesigning ZIP sizing.

Actual detached readiness includes process startup, preparation, relay admission, state writing, and the parent's ready response. `TestDetachedPreparationReturnsReadyAndReportsNestedErrors` builds the CLI, sends a 10,000-file tree plus an extra regular file to the existing fake local WebSocket relay, requires the parent to exit within five seconds, and verifies the holder stays alive afterward. Run:

```sh
go test ./cmd/cdx -run '^TestDetachedPreparationReturnsReadyAndReportsNestedErrors$' -v -count=3
```

Before (temporarily replacing shallow validation with the old `prepareSource` call): 131.691, 100.822, 130.104 ms; median 130.104 ms. After: 55.703, 61.487, 55.537 ms; median 55.703 ms, 57.2% faster. All three attempts returned readiness in each condition. These are local startup measurements, not internet throughput measurements. Runtime readiness remains dependent on filesystem speed, payload sizing, and relay availability.

## Acceptance coverage

`go test ./...` passes. Existing archive tests verify multi-file/folder content, exact ZIP size, skipped nested symlinks, empty directories, and changed-file failures. New tests cover named input validation, duplicate names, missing paths, stdin rejection, top-level file symlinks, unreadable files/folders, and a nested invalid UTF-8 filename that is rejected by the holder and returned to the parent. Permission coverage skips automatically for privileged runners that bypass read permissions. The actual detached test kills the holder during cleanup.
