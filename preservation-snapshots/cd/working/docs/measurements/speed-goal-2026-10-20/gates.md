# Performance goal and acceptance gates

The requested target is at least 1.5 times croc performance, preferably 2 times. A finite benchmark matrix can establish this only for its tested conditions. A saturated network or storage device imposes a shared ceiling; no universal multiplier is physically possible.

Compare against croc defaults and compression disabled, reporting both. Test random and compressible data, small and bulk payloads, local relay and negotiated direct routes, and filesystem versus RAM. Time readiness separately from receiver launch to process success. Verify every received payload with SHA-256. Record actual routes and failure counts. The performance gate uses the faster croc variant per workload, so a slower croc setting cannot manufacture a pass. A gate miss remains a miss in the published report.

Do not remove encryption, authentication, sequence validation, integrity checks, final fsync, fallback, or supported protocol behavior to improve a score. Preserve existing uncommitted changes. Keep performance runs serial to avoid competitors in the same session consuming CPU simultaneously. Use short exploratory runs, then at least seven interleaved trials for claimed wins. Record raw trials and spread.

Existing binary retained at /tmp/cd-speed-goal-baseline/cdx. Preexisting changes captured in /tmp/cd-speed-goal-baseline/preexisting.patch and status.txt. Current source base is 57232025406c6b86e688ffa598319cab7ffd60e8 with extensive preexisting edits. Experimental TCP source is c1df17e11edd549cdbfd16b25ad9ae593d4babc6, adapted rather than replacing current files.

LAN baseline from prior task was incomplete because croc public rendezvous timed out; it does not support a comparative claim. Browser/Android paths and internet relays cannot be equated with the new CLI TCP lane.
