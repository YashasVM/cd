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
const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : undefined;
};
const format = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'unavailable';
const delta = (value, baseline) => Number.isFinite(value) && Number.isFinite(baseline) && baseline > 0 ? `${value >= baseline ? '+' : ''}${((value / baseline - 1) * 100).toFixed(1)}%` : 'unavailable';
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
function renderComment({ current, baseline, errors, currentRun, baselineRun }) {
  const comparable = baseline && baseline.input.bytes === current.input.bytes && baseline.runs === current.runs && baseline.topology === current.topology;
  const lines = [COMMENT_MARKER, resultShaMarker(currentRun.sha), '## Transfer performance', '',
    errors.length ? `FAIL: ${errors.length} performance or integrity gate(s) failed.` : 'PASS: all fresh transfer gates passed.', '',
    '| Scenario | Metric | Main baseline | This PR | Impact | Required limit | Status |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for (const route of ['auto', 'relay']) {
    const now = summarize(current, route), base = comparable ? summarize(baseline, route) : {};
    const add = (label, key, limit, passes, digits = 1) => {
      const value = now[key], prior = base[key];
      const status = !Number.isFinite(value) || now.rows.length !== current.runs ? 'NOT CHECKED' : passes === undefined ? 'INFO' : passes ? 'PASS' : 'FAIL';
      lines.push(`| ${route === 'auto' ? 'Auto / WebRTC + relay' : 'Relay / WebSocket'} | ${label} | ${format(prior, digits)} | ${format(value, digits)} | ${delta(value, prior)} | ${limit} | ${status} |`);
    };
    add('Receive time (median ms)', 'ms', 'Informational', undefined);
    add('Throughput (median MiB/s)', 'speed', '>= 8 each trial', now.rows.every(row => row.receiveMs > 0 && current.input.bytes / 1048576 / (row.receiveMs / 1000) >= 8));
    add('Worst payload gap (ms)', 'gap', '<= 5000 each trial', now.gap <= 5000);
    add('Direct payload (median bytes)', 'direct', route === 'auto' ? '>= 4194304 each trial' : '= 0 each trial', now.rows.every(row => Number.isSafeInteger(row.transport?.direct) && (route === 'auto' ? row.transport.direct >= 4194304 : row.transport.direct === 0)), 0);
    add('Relay payload (median bytes)', 'relay', route === 'relay' ? `= ${current.input.bytes} each trial` : 'Informational', route === 'relay' ? now.rows.every(row => row.transport?.relay === current.input.bytes) : undefined, 0);
    add('Payload-evidence repetitions', 'evidence', `= ${current.runs}`, now.evidence === current.runs, 0);
    add('Verified repetitions (size + SHA-256)', 'verified', `= ${current.runs}`, now.verified === current.runs, 0);
  }
  lines.push('', `${current.runs} repetitions per route, ${(current.input.bytes / 1048576).toFixed(0)} MiB per transfer. Time includes receive entry through download save; SHA-256 and size are checked afterward.`,
    'Each status checks every repetition, including metrics displayed as medians. INFO has no enforced limit; NOT CHECKED means measurements are missing. Auto measures WebRTC and relay payload usage. LAN and AI-provider usage are not measured by this fixture.',
    'Loopback Chromium/Worker measurements do not certify WAN or physical-phone speed. Timing changes are observations; CI enforces the 8 MiB/s floor, 5-second gap limit, direct-route use and full-file integrity.', '',
    `PR head: \`${currentRun.sha.slice(0, 7)}\`; tested checkout: \`${current.commit.slice(0, 7)}\`. [Source CI](${currentRun.url}) concluded ${currentRun.conclusion}.`);
  if (baseline) {
    lines.push(`Baseline: [\`${baselineRun.sha.slice(0, 7)}\`](${baselineRun.url}). ${baselineRun.matchesBase ? 'Matches the PR base.' : 'Latest successful default-branch artifact; differs from the PR base.'}`);
    if (!comparable) lines.push('Baseline input size, repetitions or topology differs; percentage comparisons are unavailable.');
  } else lines.push('No successful default-branch baseline artifact is available yet. Percentage comparisons are unavailable.');
  if (errors.length) lines.push('', 'Failed gates:', ...errors.map(error => `- ${error}`));
  lines.push('', '_Updated in place by a trusted default-branch workflow. Artifact contents are validated as data and never executed._');
  return lines.join('\n');
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
  // One page each for the exact base and the newest runs; paging through
  // every successful main run costs up to ten requests to keep 20.
  const listRuns = async (filters) => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: source.workflow_id,
      branch: context.payload.repository.default_branch,
      event: "push",
      status: "success",
      per_page: 20,
      ...filters,
    });
    return data.workflow_runs;
  };
  const [baseRuns, recentRuns] = await Promise.all([
    listRuns({ head_sha: pull.base.sha }),
    listRuns({}),
  ]);
  const orderedRuns = [
    ...baseRuns,
    ...recentRuns.filter((run) => run.head_sha !== pull.base.sha),
  ].slice(0, 20);

  let baselineRun;
  for (const run of orderedRuns) {
    const artifacts = await artifactsForRun(github, owner, repo, run.id);
    if (findResultArtifact(artifacts)) {
      baselineRun = run;
      break;
    }
  }

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
  let body;
  if (!current) {
    body = [COMMENT_MARKER, '## Transfer performance', '', `${invalid ? 'Invalid' : 'Missing'} performance artifact for head \`${currentRun.sha.slice(0, 7)}\`. [Source CI](${currentRun.url}) concluded ${currentRun.conclusion}.`,
      'No pass or regression result is available. CI may have failed before benchmarking, or artifact upload was unavailable for this fork run.'].join('\n');
  } else {
    const { transferGateErrors } = await import('../../scripts/fresh-transfer-gates.mjs');
    body = renderComment({ current, baseline, errors: transferGateErrors(current), currentRun, baselineRun: baseline ? {
      sha: process.env.BASELINE_SHA, matchesBase: process.env.BASELINE_MATCHES_BASE === 'true',
      url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.BASELINE_RUN_ID}`,
    } : undefined });
  }
  await upsertCommentForCurrentHead(github, context, core, pullNumber, currentRun.sha, body, !current ? { preserveResultSha: currentRun.sha } : {});
}
module.exports = { validateResult, readResult, renderComment, summarize, resolve, publish, upsertCommentForCurrentHead };
