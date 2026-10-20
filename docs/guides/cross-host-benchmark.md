# Cross-host CD / croc benchmark protocol

This protocol continues the performance work merged in PR #63. It does not claim
that CD already meets the requested 1.5–2× croc target. Loopback results, LAN
results, and internet results must remain separate.

## Baseline and safety

- Baseline CD source: `405551b3ee74b8d650965cc2c29dea7fa7ff3010`.
- Reference croc: official `v11.5.5`; record archive checksum, executable checksum,
  runtime version, and compiler/build metadata on both endpoints. Use identical
  source revisions and build flags for each CD comparison.
- Use only generated test data in fresh per-run directories. Do not use personal
  files, overwrite installed tools, change firewalls, create persistent access,
  or deploy/configure a relay for this test.
- Use existing authorized CD/croc rendezvous and relay endpoints. Begin with a
  small connectivity check, then a representative 64 MiB case. Stop on service
  distress or unexpected failures before expanding traffic.
- Both endpoints must be online. An offline endpoint is a blocked experiment,
  not a failed transfer and not permission to substitute a same-host score.

## Cases and controls

Measure cloud→Omarchy and Omarchy→cloud independently. Start with random 64 MiB
and a compressible 64 MiB file, one excluded warmup per configuration/direction,
then five exploratory measured trials in rotating tool order. The existing formal
goal gate requires seven trials and its complete workload matrix; this smaller
pilot cannot satisfy that gate. Expand to 256 MiB or additional
sizes only when the initial sample is useful and bandwidth is acceptable. Record
bytes transferred, including warmups and failed attempts. Keep cold-start samples
separate rather than silently discarding them.

Croc's default route and compression are the primary real-world comparison.
Measure compression-disabled croc separately. A controlled relay-only comparison
is secondary: CD uses `CD_DIRECT=0`; croc v11.5.5 uses sender flags
`send --no-local --transport relay`. `--no-local` alone does not disable Tailcat.
Do not disable croc's faster paths to manufacture the target. Automatic fallback
must be labeled with its observed route, not assumed to be direct or relay. CD
`direct` means some records used a direct lane, not necessarily the entire file.
Its private-subnet TCP lane is not a public-WAN transport. Croc Tailcat can use
direct UDP or DERP; `--transport derp` is not a direct-only control. Preselecting
`CROC_SECRET` changes public-relay probing/readiness versus generated codes, so
record that choice instead of treating the two startup paths as identical.

Generate each payload once, record its byte length and SHA-256, and use the same
bytes for all tools in that case. Stream independent destination SHA-256 checks
outside timing. Encryption stays enabled. Record CD's protocol mode: ordinary
short codes and private resumable links have different authentication/transport
contracts and must not be conflated. Croc's default hash/compression and CD's
whole-file validation and internal fsync behavior also differ.

## Timing and resource evidence

Capture these events separately at each endpoint:

1. Process launch and sender readiness.
2. Receiver launch and successful receiver exit.
3. Completion of extra output-file and containing-directory fsync, applied to
   both tools when reporting a separate durable-completion metric.
4. Successful sender exit. Whole-session completion requires both endpoints.
5. Independent hash verification, outside transfer timing.

Bytes divided by receiver completion time is average completion throughput, not
isolated wire throughput: current CLI counters have no first/last-payload times.
Use monotonic durations within each process runner. Cross-host wall-clock
subtraction requires measured clock uncertainty. Human/tool command handoff can
add seconds between readiness and receiver launch: report it as coordination
wait, never as network transfer time. Without a common authorized controller,
report endpoint-local durations and an explicitly orchestration-inclusive session
metric; do not compare that metric to a tightly controlled loopback result.

Record actual CD transport counters (`CD_TRANSPORT_REPORT=1`) from both endpoints,
croc route evidence, all failures/timeouts, CPU time, peak RSS, OS/CPU, compiler,
core limits, filesystem/mount type, available memory/storage, network interface
and link context, competing load, and whether the payload cache is warm. Do not
publish private addresses or capability codes in shared reports. A tmpfs mount is
not disk, and container overlay does not establish physical power-loss durability.

Publish raw successful and failed samples, medians and ranges, and each tool's
native completion and stricter durable-completion results. A speed ratio is croc
elapsed/CD elapsed for the same defined case and metric. Never generalize a win
across directions, routes, payload compressibility, storage or untested networks.
A shared saturated link can make a universal 1.5× target physically unattainable.
