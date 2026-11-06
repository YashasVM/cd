// Alternate immutable CD and official croc browser builds on the same PC.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdtemp, rm, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureOutput, childExit, stopChild} from './harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cdRoot = resolve(process.env.CD_CROC_CD_ROOT || '/tmp/cd-ponytail-browser-before');
const output = resolve(process.env.CD_CROC_PAIRED_OUTPUT || '/tmp/cd-croc-browser-paired.json');
const runs = Number(process.env.CD_CROC_PAIRED_RUNS || 7), mib = Number(process.env.CD_CROC_PAIRED_MIB || 64);
assert.ok(Number.isInteger(runs) && runs > 0 && Number.isInteger(mib) && mib > 0);
const work = await mkdtemp('/tmp/cd-croc-browser-paired-');
const hash = value => createHash('sha256').update(value).digest('hex');
async function assets(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(join(directory, prefix), {withFileTypes: true})) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) rows.push(...await assets(directory, path));
    else rows.push([path, hash(await readFile(join(directory, path)))]);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
const active = new Set([process.pid]);
const report = {version: 1, startedAt: new Date().toISOString(), runs, mib, rows: [], suites: [], metadata: {}, competition: [],
  method: 'Alternate CD and croc browser suites, reversing order each round. Both UIs run in the same Chromium version with preloaded pages and private local relays. CD tests direct-allowed and forced-relay routes; croc browser uses its supported WebSocket-to-TCP relay route. Each direction uses random payloads of the same size and entropy class, with independent hashes. File/directory flush and external SHA-256 verification follow each driver. Default browser settings, no profiler. Existing native-croc cross-interface gates remain separate.'};
function inspectCompetition() {
  const others = execFileSync('ps', ['-eo', 'pid,args'], {encoding: 'utf8'}).split('\n')
    .filter(line => /^\s*\d+ (?:\S*\/)?node .*scripts\/(?:bench-|verify-)/.test(line))
    .map(line => Number(line.trim().split(' ')[0])).filter(pid => !active.has(pid));
  if (others.length) report.competition.push({at: new Date().toISOString(), pids: others});
}
let monitor;
try {
  report.cdAssets = await assets(join(cdRoot, 'dist'));
  report.cdAssetsSha256 = hash(JSON.stringify(report.cdAssets));
  monitor = setInterval(inspectCompetition, 1000);
  for (let run = 0; run < runs; run++) for (const tool of run % 2 ? ['croc-browser', 'cd'] : ['cd', 'croc-browser']) {
    const path = join(work, `${tool}-${run}.json`), cd = tool === 'cd';
    const env = {...process.env, CD_BROWSER_RUNS: '1', CD_BROWSER_MIB: String(mib), CD_BROWSER_OUTPUT: path,
      CD_CROC_BROWSER_RUNS: '1', CD_CROC_BROWSER_MIB: String(mib), CD_CROC_BROWSER_OUTPUT: path};
    delete env.CD_BROWSER_ONLY; delete env.CD_CROC_BROWSER_ONLY;
    const child = spawn(process.execPath, [cd ? 'scripts/bench-browser-paths.mjs' : 'scripts/bench-croc-browser.mjs'], {cwd: cd ? cdRoot : root, env, stdio: ['ignore', 'pipe', 'pipe']});
    active.add(child.pid); const diagnostics = captureOutput(child);
    try {
      const code = await childExit(child, 240000), trial = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(code, 0, diagnostics.stderr);
      assert.ok(trial.finishedAt && !trial.error);
      assert.equal(trial.rows.length, cd ? 6 : 3);
      assert.ok(trial.rows.every(row => row.ok && row.bytes === mib * 1048576 && /^[a-f0-9]{64}$/.test(row.sha256)));
      const {rows, ...metadata} = trial;
      if (report.metadata[tool]) {
        assert.equal(metadata.chromium, report.metadata[tool].chromium);
        if (cd) assert.equal(metadata.cdxSha256, report.metadata[tool].cdxSha256);
        else assert.deepEqual(metadata.binaries, report.metadata[tool].binaries);
      }
      report.metadata[tool] = metadata;
      report.rows.push(...rows.map(row => ({...row, tool, run})));
      report.suites.push({tool, run, startedAt: trial.startedAt, finishedAt: trial.finishedAt, verified: rows.length});
      console.error(`${tool} round ${run + 1}: ${rows.map(row => `${row.direction}/${row.route} ${row.durableMs.toFixed(1)}ms`).join(', ')}`);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    } finally { await stopChild(child); active.delete(child.pid); }
  }
  assert.equal(report.metadata.cd.chromium, report.metadata['croc-browser'].chromium);
  assert.equal(hash(JSON.stringify(await assets(join(cdRoot, 'dist')))), report.cdAssetsSha256, 'CD frontend changed during measurements');
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  clearInterval(monitor); report.contended = report.competition.length > 0;
  await rm(work, {recursive: true, force: true});
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({output, rows: report.rows.length, contended: report.contended, error: report.error}));
