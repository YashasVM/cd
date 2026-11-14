# PR transfer performance report

CI uploads `fresh-transfer-results/cd-fresh-performance.json` after
`npm run verify:performance`, including partial results when the benchmark fails.
The benchmark runs three fresh 64 MiB transfers per route. The existing
`scripts/fresh-transfer-gates.mjs` checks full-file size and SHA-256, a minimum
8 MiB/s, a maximum 5-second payload gap, and actual direct or relay payload use.

After a pull-request CI run completes, `transfer-report.yml` updates one marked
GitHub Actions comment with median receive time, throughput, direct and relay
bytes, worst payload gap, and time/throughput changes from the default branch.
The baseline prefers a successful default-branch CI run at the PR base commit,
then the latest successful run with a retained artifact. Different input size,
repetition count or topology disables percentage comparisons. Timing differences
are observations, not a statistical regression test; the existing performance
gates determine pass/fail.

The table follows the [T3 Code report example](https://github.com/pingdotgg/t3code/pull/36530#issuecomment-6873608838):
one row per scenario and metric, with main baseline, PR value, impact, required
limit and status. Unlike T3's AI-provider fixtures, CD's scenarios are automatic
WebRTC plus relay and forced WebSocket relay. Each PASS or FAIL checks every
trial, including metrics displayed as medians. Receive time and automatic-route
relay usage are informational. Missing measurements show NOT CHECKED.

The measured transports are WebRTC and the WebSocket relay. This
fixture does not measure a LAN socket path, AI-provider usage, WAN throughput,
or physical-phone speed. It times receive entry through download save and checks
the saved file afterward. These figures do not claim fsync durability.

The reporting workflow runs with permission to write PR comments. It checks out
only trusted default-branch publisher code and the trusted gate module, never PR
code. Downloaded JSON is bounded and validated as data, with no scripts executed
from artifacts. It resolves fork PRs through their current head commit when the
workflow event omits PR numbers, and checks the live head SHA again immediately
before writing. It updates only its own marked GitHub Actions comment.

Missing or invalid artifacts produce an explicit unavailable result, including
failed or fork CI runs. A missing-artifact rerun cannot replace a complete report
at the same SHA. Before a default-branch baseline exists, the table shows current
measurements without percentages.

The `workflow_run` publisher becomes active only after this workflow exists on
the default branch. Its first PR cannot receive this new comment automatically
before that merge. Baselines begin accumulating when the updated CI runs on the
default branch.

Run the publisher tests with:

```sh
node --test .github/scripts/transfer-report.test.cjs
```
