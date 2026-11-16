const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validateResult, readResult, renderComment, resolve, publish, upsertCommentForCurrentHead } = require('./transfer-report.cjs');
const sha = 'a'.repeat(40), hash = 'b'.repeat(64), bytes = 64 * 1048576;
function result(ms = 1000) {
  return { schema: 1, commit: sha, runs: 3, topology: 'loopback', input: { bytes, sha256: hash }, rows: Array.from({ length: 3 }, (_, run) => ['auto', 'relay'].map(route => ({
    run, route, ok: true, receiveMs: ms, received: { bytes, sha256: hash }, transport: { direct: route === 'auto' ? bytes : 0, relay: route === 'auto' ? 0 : bytes, maxGapMs: 5 },
  }))).flat() };
}
function mock({ currentSha = sha, comments = [], artifacts = [], state = 'open', fallback = false } = {}) {
  const writes = [], outputs = {};
  const listWorkflowRunArtifacts = () => {};
  const listComments = () => {};
  const listPullRequestsAssociatedWithCommit = () => {};
  const pull = { state, head: { sha: currentSha, ref: 'feature' }, base: { sha: 'c'.repeat(40), ref: 'main' } };
  const context = { repo: { owner: 'test', repo: 'cd' }, payload: { repository: { default_branch: 'main' }, workflow_run: {
    id: 1, workflow_id: 2, head_sha: sha, head_branch: 'feature', event: 'pull_request', conclusion: 'failure', pull_requests: fallback ? [] : [{ number: 3 }],
  } } };
  const github = {
    paginate: async (method, input) => {
      if (method === listWorkflowRunArtifacts) return artifacts.filter(a => a.runId === input.run_id);
      if (method === listComments) return comments;
      if (method === listPullRequestsAssociatedWithCommit) return [{ ...pull, number: 3 }];
      throw new Error('Unexpected API call');
    },
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      repos: { listPullRequestsAssociatedWithCommit },
      actions: { listWorkflowRunArtifacts, listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 8, head_sha: 'c'.repeat(40) }] } }) },
      issues: { listComments, createComment: async input => writes.push({ create: input }), updateComment: async input => writes.push({ update: input }) },
    },
  };
  return { github, context, core: { setOutput: (key, value) => outputs[key] = value, info: () => {} }, writes, outputs };
}
test('validates bounded numeric metrics and fixed trial routes', () => {
  assert.equal(validateResult(result()).rows.length, 6);
  for (const change of [r => r.rows[0].route = '@everyone', r => r.rows[0].receiveMs = '1000', r => r.rows[0].transport.direct = Infinity, r => r.rows.push(r.rows[0]), r => r.runs = 100000]) {
    const r = result(); change(r); assert.throws(() => validateResult(r));
  }
});
test('renders medians, measured provider bytes, deltas and gate failures', () => {
  const body = renderComment({ current: result(2000), baseline: result(), errors: ['0/auto fell below 8 MiB/s'], currentRun: { sha, url: 'https://example.test/pr', conclusion: 'failure' }, baselineRun: { sha, url: 'https://example.test/base', matchesBase: true } });
  assert.match(body, /FAIL: 1/);
  assert.match(body, /Receive time \(median ms\) \| 1000\.0 \| 2000\.0 \| \+100\.0% \| Informational \| INFO/);
  assert.match(body, /Throughput \(median MiB\/s\) \| 64\.0 \| 32\.0 \| -50\.0% \| >= 8 each trial \| PASS/);
  assert.match(body, /WebRTC \+ relay/);
  assert.match(body, /Direct payload \(median bytes\) \| 67108864 \| 67108864 \| \+0\.0% \| >= 4194304 each trial \| PASS/);
  assert.match(body, /LAN and AI-provider usage are not measured/);
});
test('does not compare incompatible scenarios', () => {
  const base = result(); base.topology = 'WAN';
  const body = renderComment({ current: result(), baseline: base, errors: [], currentRun: { sha, url: 'url', conclusion: 'success' }, baselineRun: { sha, url: 'url', matchesBase: false } });
  assert.match(body, /percentage comparisons are unavailable/);
  assert.doesNotMatch(body, /\+0\.0%/);
});
test('does not follow result symlinks or read oversized artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-report-test-'));
  try {
    const file = join(dir, 'cd-fresh-performance.json');
    writeFileSync(join(dir, 'target'), JSON.stringify(result())); symlinkSync(join(dir, 'target'), file);
    assert.throws(() => readResult(dir), /regular file/);
    rmSync(file); writeFileSync(file, ' '.repeat(256 * 1024 + 1));
    assert.throws(() => readResult(dir), /256 KiB/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('resolves a fork PR with no artifact and a successful main baseline', async () => {
  const input = mock({ fallback: true, artifacts: [{ runId: 8, name: 'fresh-transfer-results', expired: false }] });
  await resolve(input);
  assert.equal(input.outputs.publish, 'true'); assert.equal(input.outputs.pr_artifact, 'false');
  assert.equal(input.outputs.baseline_run_id, '8'); assert.equal(input.outputs.baseline_matches_base, 'true');
});
test('ignores stale and closed PR results before resolving artifacts or writing', async () => {
  for (const options of [{ currentSha: 'd'.repeat(40) }, { state: 'closed' }]) {
    const input = mock(options); await resolve(input); assert.equal(input.outputs.publish, 'false');
    assert.equal(await upsertCommentForCurrentHead(input.github, input.context, input.core, 3, sha, 'report'), false);
    assert.equal(input.writes.length, 0);
  }
});
test('updates only a GitHub Actions comment carrying this report marker', async () => {
  const input = mock({ comments: [
    { id: 1, user: { login: 'human' }, body: '<!-- cd-transfer-report -->' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: 'another report' },
    { id: 3, user: { login: 'github-actions[bot]' }, body: '<!-- cd-transfer-report --> old' },
  ] });
  await upsertCommentForCurrentHead(input.github, input.context, input.core, 3, sha, 'new');
  assert.equal(input.writes[0].update.comment_id, 3);
});
test('missing-artifact rerun does not replace an existing result at the same SHA', async () => {
  const input = mock({ comments: [{ id: 3, user: { login: 'github-actions[bot]' }, body: `<!-- cd-transfer-report --><!-- cd-transfer-result-sha:${sha} -->` }] });
  await upsertCommentForCurrentHead(input.github, input.context, input.core, 3, sha, 'missing', { preserveResultSha: sha });
  assert.equal(input.writes.length, 0);
});
test('publishes missing artifact status without claiming a pass', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { PR_NUMBER: '3', PR_SHA: sha, PR_CONCLUSION: 'failure', PR_RUN_ID: '1', PR_RESULT_DIR: '/nonexistent-cd-report', BASELINE_RESULT_DIR: '/nonexistent-cd-base' });
  try {
    const input = mock(); await publish(input);
    assert.match(input.writes[0].create.body, /Missing performance artifact/);
    assert.match(input.writes[0].create.body, /No pass or regression result is available/);
  } finally { process.env = saved; }
});
test('uses the trusted performance gates for complete artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-report-publish-')), saved = { ...process.env };
  writeFileSync(join(dir, 'cd-fresh-performance.json'), JSON.stringify(result()));
  Object.assign(process.env, { PR_NUMBER: '3', PR_SHA: sha, PR_CONCLUSION: 'success', PR_RUN_ID: '1', PR_RESULT_DIR: dir, BASELINE_RESULT_DIR: '/nonexistent-cd-base' });
  try {
    const input = mock(); await publish(input);
    assert.match(input.writes[0].create.body, /PASS: all fresh transfer gates passed/);
  } finally { process.env = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('per-metric status catches a slow trial hidden by a passing median and missing evidence', () => {
  const current = result(); current.rows[0].receiveMs = 10000; delete current.rows[1].transport.maxGapMs;
  const body = renderComment({ current, errors: ['slow trial', 'missing gap'], currentRun: { sha, url: 'url', conclusion: 'failure' } });
  assert.match(body, /Auto \/ WebRTC \+ relay \| Throughput \(median MiB\/s\) \| unavailable \| 64\.0 \| unavailable \| >= 8 each trial \| FAIL/);
  assert.match(body, /Relay \/ WebSocket \| Worst payload gap \(ms\) \| unavailable \| unavailable \| unavailable \| <= 5000 each trial \| NOT CHECKED/);
});
