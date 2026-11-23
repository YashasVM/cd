const fs = require("node:fs");
const path = require("node:path");
const ARTIFACT_NAME = "fresh-transfer-results";
const RESULT_FILE = "cd-fresh-performance.json";
const COMMENT_MARKER = "<!-- cd-transfer-report -->";
const resultShaMarker = sha => `<!-- cd-transfer-result-sha:${sha} -->`;

function validateResult(value) {
  if (!value || value.schema !== 1 || !/^[a-f0-9]{40}$/.test(value.commit ?? "") ||
      !Number.isInteger(value.runs) || value.runs < 3 || value.runs > 20 ||
      !Number.isSafeInteger(value.input?.bytes) || value.input.bytes < 64 * 1048576 ||
      !/^[a-f0-9]{64}$/.test(value.input?.sha256 ?? "") ||
      !Array.isArray(value.rows) || value.rows.length > 40) throw new Error("Invalid fresh transfer artifact");
  const seen = new Set();
  for (const row of value.rows) {
    const key = `${row.run}/${row.route}`;
    if (!['auto', 'relay'].includes(row.route) || !Number.isInteger(row.run) || row.run < 0 || row.run >= value.runs || seen.has(key)) throw new Error("Invalid transfer trial");
    seen.add(key);
    for (const n of [row.receiveMs, row.transport?.maxGapMs, row.transport?.direct, row.transport?.relay]) {
      if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER)) throw new Error("Invalid transfer metric");
    }
    if (row.ok !== undefined && typeof row.ok !== 'boolean') throw new Error("Invalid transfer status");
  }
  return value;
}

function readResult(directory) {
  if (!directory) return undefined;
  const file = path.join(directory, RESULT_FILE);
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Transfer artifact must be a regular file below 256 KiB");
  return validateResult(JSON.parse(fs.readFileSync(file, 'utf8')));
}
const SAME_THRESHOLD_PCT = 0.5;
const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : undefined;
};
const trimFixed = (value, digits = 1) => Number(value.toFixed(digits)).toString();
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${trimFixed(bytes / 1024, 1)} KiB`;
  if (bytes < 1073741824) return `${trimFixed(bytes / 1048576, 1)} MiB`;
  return `${trimFixed(bytes / 1073741824, 2)} GiB`;
}
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 999.5) return `${(ms / 1000).toFixed(2)} s`;
  if (ms === 0 || ms >= 10) return `${Math.round(ms)} ms`;
  return `${trimFixed(ms, 1)} ms`;
}
const formatSpeed = speed => Number.isFinite(speed) ? `${speed.toFixed(1)} MiB/s` : '—';
const formatCount = (count, total) => Number.isFinite(count) ? `${count}/${total}` : '—';
function formatPercentChange(value, baseline, { mode = 'plain', formatAbs } = {}) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return '—';
  if (baseline === 0) {
    if (value === 0) return '=';
    return formatAbs ? `+${formatAbs(value)}` : '—';
  }
  const pct = (value / baseline - 1) * 100;
  const rounded = Math.round(pct * 10) / 10;
  const signed = `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
  if (Math.abs(pct) < SAME_THRESHOLD_PCT) return rounded === 0 ? '=' : `= (${signed})`;
  if (mode === 'speed') return pct > 0 ? `↑ ${signed}` : `↓ ${signed}`;
  if (mode === 'time') return pct < 0 ? `${signed} faster` : `${signed} slower`;
  return signed;
}
function formatCountChange(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return '—';
  if (value === baseline) return '=';
  const diff = value - baseline;
  return `${diff > 0 ? '+' : ''}${diff}`;
}
const STATUS_BADGE = { PASS: '✅ PASS', FAIL: '❌ FAIL', INFO: 'ℹ️ INFO', 'NOT CHECKED': '⚠️ NOT CHECKED' };
function summarize(result, route) {
  const rows = result.rows.filter(row => row.route === route);
  const measured = fn => rows.length && rows.every(row => Number.isFinite(fn(row)) && fn(row) >= 0);
  const timing = measured(row => row.receiveMs) && rows.every(row => row.receiveMs > 0);
  return {
    rows,
    ms: timing ? median(rows.map(row => row.receiveMs)) : undefined,
    speed: timing ? median(rows.map(row => result.input.bytes / 1048576 / (row.receiveMs / 1000))) : undefined,
    gap: measured(row => row.transport?.maxGapMs) ? Math.max(...rows.map(row => row.transport.maxGapMs)) : undefined,
    direct: measured(row => row.transport?.direct) ? median(rows.map(row => row.transport.direct)) : undefined,
    relay: measured(row => row.transport?.relay) ? median(rows.map(row => row.transport.relay)) : undefined,
    verified: rows.length ? rows.filter(row => row.ok && row.received?.bytes === result.input.bytes && row.received?.sha256 === result.input.sha256).length : undefined,
    evidence: rows.length ? rows.filter(row => Number.isSafeInteger(row.transport?.direct) && row.transport.direct >= 0 && Number.isSafeInteger(row.transport?.relay) && row.transport.relay >= 0 && row.transport.direct + row.transport.relay >= result.input.bytes).length : undefined,
  };
}
function evaluateRoute(current, baseline, comparable, route) {
  const now = summarize(current, route), base = comparable ? summarize(baseline, route) : {};
  const sizeLabel = formatBytes(current.input.bytes);
  const metricStatus = (value, passes) => !Number.isFinite(value) || now.rows.length !== current.runs
    ? 'NOT CHECKED'
    : passes === undefined ? 'INFO' : passes ? 'PASS' : 'FAIL';
  const metrics = [
    {
      label: 'Throughput (median)',
      prior: formatSpeed(base.speed),
      current: formatSpeed(now.speed),
      change: formatPercentChange(now.speed, base.speed, { mode: 'speed' }),
      limit: '≥ 8 MiB/s each',
      status: metricStatus(now.speed, now.rows.every(row => row.receiveMs > 0 && current.input.bytes / 1048576 / (row.receiveMs / 1000) >= 8)),
    },
    {
      label: 'Receive time (median)',
      prior: formatDuration(base.ms),
      current: formatDuration(now.ms),
      change: formatPercentChange(now.ms, base.ms, { mode: 'time' }),
      limit: 'Info',
      status: metricStatus(now.ms, undefined),
    },
    {
      label: 'Worst payload gap',
      prior: formatDuration(base.gap),
      current: formatDuration(now.gap),
      change: formatPercentChange(now.gap, base.gap),
      limit: '≤ 5 s each',
      status: metricStatus(now.gap, now.gap <= 5000),
    },
    {
      label: 'Direct payload (median)',
      prior: formatBytes(base.direct),
      current: formatBytes(now.direct),
      change: formatPercentChange(now.direct, base.direct, { formatAbs: formatBytes }),
      limit: route === 'auto' ? '≥ 4 MiB each' : '0 B each',
      status: metricStatus(now.direct, now.rows.every(row => Number.isSafeInteger(row.transport?.direct) && (route === 'auto' ? row.transport.direct >= 4194304 : row.transport.direct === 0))),
    },
    {
      label: 'Relay payload (median)',
      prior: formatBytes(base.relay),
      current: formatBytes(now.relay),
      change: formatPercentChange(now.relay, base.relay, { formatAbs: formatBytes }),
      limit: route === 'relay' ? `${sizeLabel} each` : 'Info',
      status: metricStatus(now.relay, route === 'relay' ? now.rows.every(row => row.transport?.relay === current.input.bytes) : undefined),
    },
    {
      label: 'Payload evidence',
      prior: formatCount(base.evidence, baseline?.runs ?? current.runs),
      current: formatCount(now.evidence, current.runs),
      change: formatCountChange(now.evidence, base.evidence),
      limit: `${current.runs}/${current.runs}`,
      status: metricStatus(now.evidence, now.evidence === current.runs),
    },
    {
      label: 'Verified (size + SHA-256)',
      prior: formatCount(base.verified, baseline?.runs ?? current.runs),
      current: formatCount(now.verified, current.runs),
      change: formatCountChange(now.verified, base.verified),
      limit: `${current.runs}/${current.runs}`,
      status: metricStatus(now.verified, now.verified === current.runs),
    },
  ];
  const enforced = metrics.filter(m => m.status !== 'INFO');
  const routeStatus = enforced.some(m => m.status === 'FAIL')
    ? 'FAIL'
    : enforced.some(m => m.status === 'NOT CHECKED') ? 'NOT CHECKED' : 'PASS';
  return {
    route,
    title: route === 'auto' ? 'Auto (WebRTC + relay)' : 'Relay (WebSocket)',
    summaryLabel: route === 'auto' ? '**Auto** (WebRTC + relay)' : '**Relay** (WebSocket)',
    now,
    base,
    speedChange: metrics[0].change,
    status: routeStatus,
    metrics,
  };
}
function renderComment({ current, baseline, errors, currentRun, baselineRun }) {
  const comparable = Boolean(baseline && baseline.input.bytes === current.input.bytes && baseline.runs === current.runs && baseline.topology === current.topology);
  const sizeLabel = formatBytes(current.input.bytes);
  const routes = ['auto', 'relay'].map(route => evaluateRoute(current, baseline, comparable, route));
  const headline = errors.length
    ? `❌ **Failed: ${errors.length} transfer ${errors.length === 1 ? 'gate' : 'gates'}** · ${sizeLabel} × ${current.runs} runs per route`
    : `✅ **All transfer gates passed** · ${sizeLabel} × ${current.runs} runs per route`;
  const lines = [
    COMMENT_MARKER,
    resultShaMarker(currentRun.sha),
    '## Transfer performance',
    '',
    headline,
    '',
    '| Route | Main speed | PR speed | Change | Receive time | Worst gap | Status |',
    '| --- | ---: | ---: | :---: | ---: | ---: | :---: |',
  ];
  for (const r of routes) {
    const prSpeed = Number.isFinite(r.now.speed) ? `**${formatSpeed(r.now.speed)}**` : '—';
    lines.push(`| ${r.summaryLabel} | ${formatSpeed(r.base.speed)} | ${prSpeed} | ${r.speedChange} | ${formatDuration(r.now.ms)} | ${formatDuration(r.now.gap)} | ${STATUS_BADGE[r.status]} |`);
  }
  if (comparable) {
    lines.push('', '> **Legend:** `↑` faster than `main` · `↓` slower than `main` · `=` unchanged (within ±0.5%) · Gates: `≥ 8 MiB/s`, gap `≤ 5 s` on every run.');
  } else if (baseline) {
    lines.push('', '> ℹ️ Baseline differs in input size, repetitions, or topology — percentage comparisons are unavailable. Gates: `≥ 8 MiB/s`, gap `≤ 5 s` on every run.');
  } else {
    lines.push('', '> ℹ️ No successful default-branch baseline artifact is available yet — percentage comparisons are unavailable. Gates: `≥ 8 MiB/s`, gap `≤ 5 s` on every run.');
  }
  if (errors.length) {
    lines.push('', '**Failed gates**', ...errors.map(error => `- ${error}`));
  }
  lines.push('', `<details${errors.length ? ' open' : ''}>`, '<summary>Full breakdown & gate checks (Auto + Relay)</summary>');
  for (const r of routes) {
    lines.push('', `#### ${r.title}`, '', '| Metric | Main | This PR | Change | Gate | Status |', '| --- | ---: | ---: | ---: | ---: | :---: |');
    for (const m of r.metrics) {
      lines.push(`| ${m.label} | ${m.prior} | ${m.current} | ${m.change} | ${m.limit} | ${STATUS_BADGE[m.status]} |`);
    }
  }
  lines.push('',
    '**Notes**',
    `- ${current.runs} repetitions per route, ${sizeLabel} per transfer. Time covers receive entry through download save; SHA-256 and size are checked afterward.`,
    '- Each PASS/FAIL checks every repetition, including metrics displayed as medians. `INFO` has no enforced limit; `NOT CHECKED` means measurements are missing.',
    '- Auto measures WebRTC and relay payload usage. LAN and AI-provider usage are not measured by this fixture.',
    '- Loopback Chromium/Worker measurements do not certify WAN or physical-phone speed. Speed deltas are observations; CI enforces the 8 MiB/s floor, 5 s gap limit, direct-route use, and full-file integrity.',
    '',
    '</details>',
    '',
    '---');
  const headPart = currentRun.sha === current.commit
    ? `PR head \`${currentRun.sha.slice(0, 7)}\``
    : `PR head \`${currentRun.sha.slice(0, 7)}\` (tested \`${current.commit.slice(0, 7)}\`)`;
  const baselinePart = baseline
    ? `Baseline [\`${baselineRun.sha.slice(0, 7)}\`](${baselineRun.url}) (${baselineRun.matchesBase ? 'matches PR base' : 'latest default-branch run; differs from PR base'})`
    : 'Baseline: none yet';
  lines.push(`${headPart} · [Speedtest run](${currentRun.url}) (\`${currentRun.conclusion}\`) · ${baselinePart}`);
  lines.push('', '_Updated in place by a trusted default-branch workflow. Artifact contents are validated as data and never executed._');
  return lines.join('\n');
}

const SPEEDTEST_COMMAND_RE = /^\s*\/speedtest\s*$/i;
const ALLOWED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const BASELINE_WORKFLOWS = ["speedtest.yml", "ci.yml"];

function isSpeedtestCommand(body) {
  return typeof body === "string" && SPEEDTEST_COMMAND_RE.test(body);
}

async function artifactsForRun(github, owner, repo, runId) {
  return github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });
}

function findResultArtifact(artifacts) {
  return artifacts.find((artifact) => artifact.name === ARTIFACT_NAME && !artifact.expired);
}

async function findBaselineRun(github, owner, repo, defaultBranch, baseSha, workflowIds = BASELINE_WORKFLOWS) {
  const seenWorkflows = new Set();
  for (const workflowId of workflowIds) {
    if (workflowId === undefined || workflowId === null || seenWorkflows.has(workflowId)) continue;
    seenWorkflows.add(workflowId);
    // One page each for the exact base and the newest runs; paging through
    // every successful main run costs up to ten requests to keep 20.
    const listRuns = async (filters) => {
      try {
        const { data } = await github.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: workflowId,
          branch: defaultBranch,
          status: "success",
          per_page: 20,
          ...filters,
        });
        return data.workflow_runs.filter((run) => run.event === "push" || run.event === "workflow_dispatch");
      } catch (error) {
        if (error?.status === 404) return [];
        throw error;
      }
    };
    const [baseRuns, recentRuns] = await Promise.all([
      baseSha ? listRuns({ head_sha: baseSha }) : Promise.resolve([]),
      listRuns({}),
    ]);
    const orderedRuns = [
      ...baseRuns,
      ...recentRuns.filter((run) => run.head_sha !== baseSha),
    ].slice(0, 20);

    for (const run of orderedRuns) {
      const artifacts = await artifactsForRun(github, owner, repo, run.id);
      if (findResultArtifact(artifacts)) return run;
    }
  }
  return undefined;
}

async function reactToComment(github, owner, repo, commentId, content, core) {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) return;
  try {
    await github.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch (error) {
    core?.info?.(`Could not add ${content} reaction to comment ${commentId}: ${error?.message ?? error}`);
  }
}

async function resolveCommand({ github, context, core }) {
  const deny = (reason) => {
    core.info(reason);
    core.setOutput("authorized", "false");
  };
  const issue = context.payload.issue;
  const comment = context.payload.comment;
  if (!issue?.pull_request || !comment) {
    deny("Ignoring comment outside a pull request.");
    return;
  }
  if (!isSpeedtestCommand(comment.body)) {
    deny("Comment does not match /speedtest command.");
    return;
  }
  if (!comment.user?.login || comment.user.type === "Bot") {
    deny("Ignoring /speedtest command from a bot or unknown user.");
    return;
  }
  const { owner, repo } = context.repo;
  const { data: perm } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: comment.user.login,
  });
  if (!ALLOWED_PERMISSIONS.has(perm?.permission)) {
    deny(`User ${comment.user.login} has permission "${perm?.permission ?? "none"}"; write access is required for /speedtest.`);
    return;
  }
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: issue.number,
  });
  if (pull.state !== "open") {
    deny(`PR #${issue.number} is ${pull.state}; skipping /speedtest.`);
    await reactToComment(github, owner, repo, comment.id, "confused", core);
    return;
  }
  await reactToComment(github, owner, repo, comment.id, "eyes", core);
  core.setOutput("authorized", "true");
  core.setOutput("pull_number", String(pull.number));
  core.setOutput("head_sha", pull.head.sha);
  core.setOutput("base_sha", pull.base.sha);
  core.setOutput("comment_id", String(comment.id));
}

async function resolveBaseline({ github, context, core }) {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository?.default_branch ?? "main";
  const baseSha = process.env.BASE_SHA ?? "";
  const baselineRun = await findBaselineRun(github, owner, repo, defaultBranch, baseSha, BASELINE_WORKFLOWS);
  core.setOutput("baseline_artifact", baselineRun ? "true" : "false");
  core.setOutput("baseline_run_id", baselineRun ? String(baselineRun.id) : "");
  core.setOutput("baseline_sha", baselineRun?.head_sha ?? "");
  core.setOutput(
    "baseline_matches_base",
    baselineRun && baseSha && baselineRun.head_sha === baseSha ? "true" : "false",
  );
}

async function resolve({ github, context, core }) {
  const source = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  if (source.event !== "pull_request") {
    core.setOutput("publish", "false");
    return;
  }

  let pullNumber = source.pull_requests?.[0]?.number;
  if (!pullNumber) {
    let associated;
    try {
      associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
        owner,
        repo,
        commit_sha: source.head_sha,
        per_page: 100,
      });
    } catch (error) {
      // A force-pushed or deleted PR head can disappear before this workflow runs.
      if (
        error.status === 422 &&
        error.response?.data?.message === `No commit found for SHA: ${source.head_sha}`
      ) {
        core.info(`Skipping CI result for unavailable commit ${source.head_sha}.`);
        core.setOutput("publish", "false");
        return;
      }
      throw error;
    }
    const matchingPulls = associated.filter(
      (pull) =>
        pull.state === "open" &&
        pull.head.sha === source.head_sha &&
        pull.head.ref === source.head_branch,
    );
    if (matchingPulls.length !== 1) {
      core.info(
        `Expected one open pull request for ${source.head_repository?.full_name ?? "unknown repository"}:${source.head_branch ?? "unknown branch"} at ${source.head_sha}; found ${matchingPulls.length}.`,
      );
      core.setOutput("publish", "false");
      return;
    }
    pullNumber = matchingPulls[0].number;
  }
  if (!pullNumber) {
    core.info("No open pull request is associated with the completed CI run.");
    core.setOutput("publish", "false");
    return;
  }

  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull.state !== "open" || pull.head.sha !== source.head_sha) {
    core.info(`Skipping stale CI result ${source.head_sha}; PR head is ${pull.head.sha}.`);
    core.setOutput("publish", "false");
    return;
  }

  const sourceArtifacts = await artifactsForRun(github, owner, repo, source.id);
  const sourceArtifact = findResultArtifact(sourceArtifacts);
  const baselineRun = await findBaselineRun(
    github,
    owner,
    repo,
    context.payload.repository.default_branch,
    pull.base.sha,
    [source.workflow_id, ...BASELINE_WORKFLOWS],
  );

  core.setOutput("publish", "true");
  core.setOutput("pull_number", String(pullNumber));
  core.setOutput("pr_artifact", sourceArtifact ? "true" : "false");
  core.setOutput("pr_run_id", String(source.id));
  core.setOutput("pr_sha", source.head_sha);
  core.setOutput("pr_conclusion", source.conclusion ?? "unknown");
  core.setOutput("baseline_artifact", baselineRun ? "true" : "false");
  core.setOutput("baseline_run_id", baselineRun ? String(baselineRun.id) : "");
  core.setOutput("baseline_sha", baselineRun?.head_sha ?? "");
  core.setOutput(
    "baseline_matches_base",
    baselineRun?.head_sha === pull.base.sha ? "true" : "false",
  );
}

async function upsertComment(github, context, pullNumber, body, options = {}) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && comment.body?.includes(COMMENT_MARKER),
  );
  if (
    options.preserveResultSha &&
    existing?.body?.includes(resultShaMarker(options.preserveResultSha))
  ) {
    return;
  }
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }
}

async function upsertCommentForCurrentHead(
  github,
  context,
  core,
  pullNumber,
  expectedSha,
  body,
  options,
) {
  const { owner, repo } = context.repo;
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (pull.state !== "open" || pull.head.sha !== expectedSha) {
    core.info(`Skipping stale CI result ${expectedSha}; PR head is ${pull.head.sha}.`);
    return false;
  }

  await upsertComment(github, context, pullNumber, body, options);
  return true;
}


async function publish({ github, context, core }) {
  const pullNumber = Number(process.env.PR_NUMBER);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0 || !/^[a-f0-9]{40}$/.test(process.env.PR_SHA ?? '')) throw new Error('Invalid report target');
  const currentRun = {
    sha: process.env.PR_SHA,
    conclusion: process.env.PR_CONCLUSION,
    url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.PR_RUN_ID}`,
  };
  let current, baseline, invalid = false;
  try { current = readResult(process.env.PR_RESULT_DIR); } catch { invalid = true; }
  try { baseline = readResult(process.env.BASELINE_RESULT_DIR); } catch { core.info('Ignoring invalid baseline artifact'); }
  let body, passed = false;
  if (!current) {
    body = [
      COMMENT_MARKER,
      '## Transfer performance',
      '',
      `⚠️ **${invalid ? 'Invalid' : 'Missing'} performance artifact** for head \`${currentRun.sha.slice(0, 7)}\`. [Speedtest run](${currentRun.url}) concluded \`${currentRun.conclusion}\`.`,
      '',
      'No pass or regression result is available. The run may have failed before benchmarking, or artifact upload was unavailable for this fork run.',
    ].join('\n');
  } else {
    const { transferGateErrors } = await import('../../scripts/fresh-transfer-gates.mjs');
    const errors = transferGateErrors(current);
    passed = errors.length === 0;
    body = renderComment({ current, baseline, errors, currentRun, baselineRun: baseline ? {
      sha: process.env.BASELINE_SHA, matchesBase: process.env.BASELINE_MATCHES_BASE === 'true',
      url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.BASELINE_RUN_ID}`,
    } : undefined });
  }
  const written = await upsertCommentForCurrentHead(github, context, core, pullNumber, currentRun.sha, body, !current ? { preserveResultSha: currentRun.sha } : {});
  const triggerCommentId = Number(process.env.TRIGGER_COMMENT_ID);
  if (Number.isSafeInteger(triggerCommentId) && triggerCommentId > 0) {
    await reactToComment(github, context.repo.owner, context.repo.repo, triggerCommentId, written && passed ? 'rocket' : 'confused', core);
  }
}
module.exports = {
  validateResult,
  readResult,
  renderComment,
  summarize,
  resolve,
  resolveCommand,
  resolveBaseline,
  findBaselineRun,
  isSpeedtestCommand,
  publish,
  upsertCommentForCurrentHead,
  formatBytes,
  formatDuration,
  formatSpeed,
  formatPercentChange,
};
