# PR transfer performance report

`Transfer Speedtest` (`.github/workflows/speedtest.yml`) runs
`npm run verify:performance` and uploads
`fresh-transfer-results/cd-fresh-performance.json`, including partial results
when the benchmark fails. It triggers automatically only when a PR or a push to
`main` changes the core browser sending/receiving modules, worker relay code, or
the transfer benchmark scripts themselves (avoiding benchmark runs and bot
comments on unrelated PRs like docs, Dependabot, Android, or CLI changes).

To run the transfer benchmark on demand on any open PR (regardless of changed
files), a repository collaborator with write access can comment:

```text
/speedtest
```

`Transfer Speedtest (Command)` (`.github/workflows/speedtest-command.yml`)
verifies collaborator permission, reacts with 👀, runs the benchmark in a
read-only job pinned to the authorized PR head SHA (`persist-credentials: false`),
and then publishes the comment from a separate job running only trusted
default-branch code (reacting with 🚀 on pass or 😕 on failure).

The benchmark runs three fresh 64 MiB transfers per route. The existing
`scripts/fresh-transfer-gates.mjs` checks full-file size and SHA-256, a minimum
8 MiB/s, a maximum 5-second payload gap, and actual direct or relay payload use.

After an automatic PR `Transfer Speedtest` run completes, `transfer-report.yml`
updates one marked GitHub Actions comment with median receive time, throughput,
direct and relay bytes, worst payload gap, and speed/time changes from the
default branch. The baseline prefers a successful default-branch run at the PR
base commit, then the latest successful run with a retained artifact (checking
`speedtest.yml` first and falling back to historical `ci.yml` runs). Different
input size, repetition count or topology disables percentage comparisons. Timing
differences are observations, not a statistical regression test; the existing
performance gates determine pass/fail.

The comment opens with an at-a-glance summary table (one row per route: automatic
WebRTC plus relay, and forced WebSocket relay) showing `main` speed vs PR speed,
directional speed change (`↑` faster, `↓` slower, `=` unchanged within ±0.5%),
human-readable durations (`s` / `ms`) and payload sizes (`MiB` / `B`), and route
gate status. An expandable details section holds the full per-route metric
breakdown (automatically expanded when any gate fails). Each PASS or FAIL checks
every trial, including metrics displayed as medians. Receive time and
automatic-route relay usage are informational. Missing measurements show
NOT CHECKED.

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

To verify publishing end to end, open a PR after the publisher reaches the
default branch and let its CI run finish. Confirm that the **Transfer Performance
Report** workflow succeeds and that `github-actions[bot]` posts the marked
transfer table on the PR. A successful publisher unit test alone does not prove
that GitHub permissions, artifact downloads and comment posting work together.
