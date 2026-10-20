import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {median} from '../../../scripts/bench-croc-matrix.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const load = name => JSON.parse(readFileSync(root + name, 'utf8'));
const tcp = load('tcp-reuse-steady.json'), relay = load('relay-reuse-steady.json');
const size = load('code-size.json');
const metrics = ['readyMs', 'receiverMs', 'durableMs', 'totalMs'];
function summarize(report) {
  assert.ok(report.finishedAt && !report.error && report.contended === false);
  assert.equal(report.rows.length, 42);
  const groups = {};
  for (const variant of ['before', 'after']) {
    groups[variant] = {};
    for (const tool of ['cd', 'croc', 'croc-no-compress']) {
      const rows = report.rows.filter(row => row.variant === variant && row.tool === tool);
      assert.equal(rows.length, 7);
      assert.equal(new Set(rows.map(row => row.run)).size, 7);
      assert.ok(rows.every(row => row.ok && row.bytes === 268435456 && /^[a-f0-9]{64}$/.test(row.sha256)));
      groups[variant][tool] = Object.fromEntries(metrics.map(metric => {
        const values = rows.map(row => row[metric]);
        assert.ok(values.every(value => Number.isFinite(value) && value > 0));
        return [metric, {median: median(values), min: Math.min(...values), max: Math.max(...values)}];
      }));
    }
  }
  return groups;
}
const tcpGroups = summarize(tcp), relayGroups = summarize(relay);
assert.ok(tcp.rows.filter(row => row.tool === 'cd').every(row => row.reports.every(entry => entry.directProtocol === 'tcp')));
assert.ok(size.lineDelta < 0 && size.byteDelta < 0);
const rows = metrics.map(metric => {
  const before = tcpGroups.before.cd[metric], after = tcpGroups.after.cd[metric];
  const croc = Math.min(tcpGroups.after.croc[metric].median, tcpGroups.after['croc-no-compress'][metric].median);
  return {metric, before, after, crocMs: croc, improvement: before.median / after.median, versusCroc: croc / after.median, pass: croc / after.median >= 1.5};
});
const report = {version: 1, finishedAt: tcp.finishedAt, goal: 'At least 1.5× faster than the faster croc mode on every required speed metric and scenario; prefer 2×. Smaller runtime code. Android excluded.',
  goalAchieved: false, retained: 'Reuse ciphertext storage only after synchronous TCP writes. Remove duplicate sender setup and the old sealing wrapper.',
  rejected: 'Relay buffer reuse cut allocation but failed the steady-runtime timing comparison.', rows, codeSize: size,
  tcp: {file: 'tcp-reuse-steady.json', groups: tcpGroups, verified: 42, binaries: tcp.binaries},
  relay: {file: 'relay-reuse-steady.json', groups: relayGroups, verified: 42, retained: false},
  limits: 'Same-host loopback, 256 MiB random input, RAM output. Seven alternating trials per binary. No universal speed claim. The complete acceptance matrix above remains snapshot 806bb37. Readiness and the 100 Mb/s physical LAN still miss the target. Other host activity was not eliminated; no competing benchmark process was observed.'};
writeFileSync(root + 'iteration.json', JSON.stringify(report, null, 2) + '\n');

const fmt = value => value.toLocaleString('en-US', {maximumFractionDigits: 1});
const names = {readyMs: 'Ready to share', receiverMs: 'Receiver completion', durableMs: 'Receiver + flush', totalMs: 'Total completion'};
const max = Math.max(...rows.filter(row => row.metric === 'durableMs').flatMap(row => [row.before.median, row.after.median, row.crocMs]));
const durable = rows.find(row => row.metric === 'durableMs');
const bars = [['Prior CD', durable.before.median], ['Optimized CD', durable.after.median], ['Faster croc mode', durable.crocMs]];
const section = `<section class="panel" id="ponytail-iteration"><h2>Ponytail iteration · TCP buffer reuse</h2>
<p>Target remains open: at least 1.5× faster on every required speed metric, preferably 2×. This iteration improves TCP completion and makes the affected runtime files ${-size.lineDelta} lines and ${-size.byteDelta} bytes smaller. Tests and measurement files are additional.</p>
<p>256 MiB random input, same-host TCP, RAM output. Seven alternating trials per binary. Every payload passed SHA-256 verification. Lower time is better.</p>
<div class="iteration-bars">${bars.map(([name, value], i) => `<div><span>${name}</span><div class="iteration-track"><div style="width:${value / max * 100}%;background:${i === 1 ? '#2b65d9' : '#8b96a8'}"></div></div><b>${fmt(value)} ms</b></div>`).join('')}</div>
<div class="table-wrap"><table><thead><tr><th>Metric</th><th>Prior CD</th><th>Optimized CD</th><th>Faster croc</th><th>CD vs croc</th></tr></thead><tbody id="ponytail-results">${rows.map(row => `<tr><td>${names[row.metric]}</td><td>${fmt(row.before.median)} ms</td><td>${fmt(row.after.median)} ms</td><td>${fmt(row.crocMs)} ms</td><td>${row.versusCroc.toFixed(2)}× · ${row.pass ? 'pass' : 'miss'}</td></tr>`).join('')}</tbody></table></div>
<p>TCP receiver + flush improved by ${durable.improvement.toFixed(2)}× over prior CD in this experiment. Its optimized median is ${durable.versusCroc.toFixed(2)}× faster than the faster croc mode. Prior CD ranged ${fmt(durable.before.min)}–${fmt(durable.before.max)} ms; optimized CD ranged ${fmt(durable.after.min)}–${fmt(durable.after.max)} ms. These are measured samples, not a general multiplier.</p>
<p>Relay reuse was rejected. Its steady-runtime median changed from ${fmt(relayGroups.before.cd.durableMs.median)} to ${fmt(relayGroups.after.cd.durableMs.median)} ms. Although an instrumented relay experiment reduced sender allocation from a historical 261 MiB to about 3 MiB, it did not establish faster relay completion. The retained optimization reuses storage only after synchronous TCP writes. Encryption, nonce sequencing, handoff copies and final flush remain intact.</p>
<p>${report.limits} Measured ${report.finishedAt}.</p>
<p><a href="/cd-bench/ponytail-iteration.json">Iteration data</a> · <a href="/cd-bench/ponytail-tcp-reuse-steady.json">TCP trials</a> · <a href="/cd-bench/ponytail-relay-reuse-steady.json">Rejected relay trials</a> · <a href="/cd-bench/ponytail-code-size.json">Code size</a> · <a href="/cd-bench/ponytail-candidate.patch">Runtime patch</a></p></section>`;
const style = `<style>#ponytail-iteration{margin-top:12px}#ponytail-iteration .iteration-bars{display:grid;gap:12px;margin:24px 0}#ponytail-iteration .iteration-bars>div{display:grid;grid-template-columns:120px minmax(40px,1fr) 96px;gap:12px;align-items:center}#ponytail-iteration .iteration-track{height:24px;background:#8994a322}#ponytail-iteration .iteration-track>div{height:24px}#ponytail-iteration table{width:100%;border-collapse:collapse}#ponytail-iteration th,#ponytail-iteration td{padding:8px;text-align:left;border-bottom:1px solid #8994a344}#ponytail-iteration .table-wrap{overflow-x:auto}@media(max-width:500px){#ponytail-iteration .iteration-bars>div{grid-template-columns:90px minmax(20px,1fr) 80px;gap:6px;font-size:12px}}</style>`;
writeFileSync(root + 'iteration-section.html', style + section);
writeFileSync(root + 'iteration.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CD performance iteration</title>${style}<style>body{margin:0;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground,#162130)}h2{font-size:24px;line-height:1.2}p{color:var(--muted-foreground,#566273)}a{color:var(--accent-foreground,#2b65d9)}#ponytail-iteration{margin:0}</style></head><body>${section}</body></html>`);
console.log(JSON.stringify({tcpImprovement: durable.improvement, versusCroc: durable.versusCroc, lineDelta: size.lineDelta, goalAchieved: false}));
