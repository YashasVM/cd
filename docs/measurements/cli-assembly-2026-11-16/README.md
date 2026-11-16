# CLI WebRTC record assembly, 2026-11-16

The candidate removes repeated growth copies and the final full-record copy
from `recordAssembler.push` in `cmd/cdx/direct.go`. It validates the record
header before allocating exactly the bounded wire length, copies each 64 KiB
WebRTC fragment into that record, and hands independently owned storage to the
consumer. Record encryption, authentication, sequence validation and wire format
are unchanged. Both ordinary and resumable direct transfers use this assembler.

Baseline: `11136c008b01e282b1528c23861384e63dd050aa` from `YashasVM/cd`.
Candidate: the changes to `direct.go` accompanying this report, with the new
`direct_assembly_bench_test.go` benchmark. The later change of the default STUN
server to Cloudflare is unrelated to this in-process benchmark.

## Results

Five observations per record size and revision; medians below. The benchmark
includes assembled-record storage ownership and excludes encryption, network,
disk, connection establishment and application delivery confirmation.

| Payload | Baseline allocated bytes/record | Candidate allocated bytes/record | Allocation reduction | Allocations/record, before → after |
| --- | ---: | ---: | ---: | ---: |
| 256 KiB | 983,068 | 270,361 | 72.5% | 6 → 2 |
| 768 KiB | 4,390,949 | 794,648 | 81.9% | 11 → 2 |

| Payload | Baseline median ns/record | Candidate median ns/record | Observed component speedup |
| --- | ---: | ---: | ---: |
| 256 KiB | 928,275 | 169,542 | 5.48× |
| 768 KiB | 3,075,269 | 786,362 | 3.91× |

**Timing caveat:** these runs occurred sequentially on a shared Cloud machine
while other development work was active. Baseline and candidate timing samples
vary substantially; the allocation reductions provide stronger evidence than the
timing ratios. This is a component benchmark, not a measurement of file transfer
speed or evidence of superiority to croc, ToffeeShare, or every P2P product.
The generated benchmark `MB/s` numbers must not be presented as network speed.

Environment: Go 1.26.11, linux/amd64, reported CPU AMD EPYC 9V74 80-Core
Processor, Go benchmark suffix `-4` (`GOMAXPROCS=4`).
The baseline log includes first-run dependency download messages; these occur
outside the measured benchmark intervals.

## Reproduce

Use Go 1.26.11 and the same machine/process constraints for both checkouts.
Copy the candidate's new benchmark into a clean checkout of the baseline commit
so the benchmark exercises each revision's actual assembler:

```sh
git worktree add --detach ../cd-baseline 11136c008b01e282b1528c23861384e63dd050aa
cp cmd/cdx/direct_assembly_bench_test.go ../cd-baseline/cmd/cdx/
```

Run this command in each checkout, sequentially, with other workloads stopped:

```sh
GOMAXPROCS=4 go test ./cmd/cdx -run '^$' \
  -bench '^BenchmarkDirectRecordAssembly$' -benchmem -benchtime=1s -count=5
```

The captured before/after runs used identical benchmark code. The final checked-in
benchmark additionally checks that exactly one assembled record is emitted per
iteration; that assertion was added after both captured runs. Reproducing with
the final benchmark copied into both revisions keeps their measurement logic
identical and includes this additional correctness assertion.

## Verification and evidence

- [`before.txt`](before.txt): original assembler, five samples per record size.
- [`after.txt`](after.txt): exact-allocation assembler, five samples per size.
- [`race.txt`](race.txt): passing `go test ./cmd/cdx -run
  'Test(Direct|Link|ResumeAssembler)' -race -count=1`.
- [`go-tests.txt`](go-tests.txt): passing full `go test ./...` with per-command
  `umask 022`.
- [`go-tests-umask077.txt`](go-tests-umask077.txt): initial full-suite failure
  under the environment's inherited `umask 077`. An existing test creates a
  supposedly exposed checkpoint using `os.WriteFile(..., 0644)`; this umask makes
  the actual file mode `0600`, so the test incorrectly expects rejection of a
  private checkpoint. The production permission check was unchanged; rerunning
  with `umask 022` makes that fixture exercise the intended exposed mode.

Focused tests cover input fragment storage reuse, retained-record ownership,
single-byte fragments, every header split, coalesced records, protocol versions
and rejection of oversized record lengths before body allocation. An independent
read-only review found no correctness issue. These checks support the assembler
change; they do not establish broader performance or product-ranking claims.
