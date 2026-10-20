import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {evaluateBrowserCroc} from '../../../scripts/prof-gates.mjs';
import {median} from '../../../scripts/bench-croc-matrix.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const raw = JSON.parse(readFileSync(root + 'matching-browser-paired.json', 'utf8'));
const gates = evaluateBrowserCroc(raw);
assert.equal(gates.complete, true);
assert.equal(raw.metadata['croc-browser'].sourceCommit, '8a806c36956533f9c003c55f16e31fcf14133f8e');
assert.equal(raw.metadata['croc-browser'].sourceDirty, '');
assert.equal(raw.metadata['croc-browser'].crocVersion, 'croc version 11.5.5');
const metrics = ['readyMs', 'receiverMs', 'durableMs', 'totalMs'];
const sourceViews = ['source-views-cli-relay.json', 'source-views-browser-relay.json', 'source-views-browser-direct.json'].map(file => {
  const trial = JSON.parse(readFileSync(root + file, 'utf8'));
  assert.ok(trial.finishedAt && !trial.error && trial.rows.length === 14);
  assert.ok(trial.rows.every(row => row.ok && row.bytes === 67108864 && /^[a-f0-9]{64}$/.test(row.sha256)));
  const before = trial.rows.filter(row => row.variant === 'before').map(row => row.durableMs);
  const after = trial.rows.filter(row => row.variant === 'after').map(row => row.durableMs);
  assert.equal(before.length, 7); assert.equal(after.length, 7);
  return {file, name: trial.case, beforeMs: median(before), afterMs: median(after), ratio: median(before) / median(after)};
});
const transport = JSON.parse(readFileSync(root + 'candidate-transports.log', 'utf8').trim().split('\n').at(-1));
assert.equal(transport.passed, 10); assert.equal(transport.failed, 0);
const cases = gates.comparisons.map(entry => ({...entry, spread: Object.fromEntries(metrics.map(metric => {
  const [direction, route] = entry.name.split('/');
  const range = tool => {
    const values = raw.rows.filter(row => row.tool === tool && row.direction === direction && row.route === (tool === 'cd' ? route : 'relay')).map(row => row[metric]);
    return {min: Math.min(...values), max: Math.max(...values)};
  };
  return [metric, {cd: range('cd'), croc: range('croc-browser')}];
}))}));
const summary = {...gates, cases, measuredAt: raw.finishedAt, verified: raw.rows.length, cdFrontendSnapshot: '974c6cd', sourceViews,
  crocVersion: raw.metadata['croc-browser'].crocVersion, crocSource: raw.metadata['croc-browser'].sourceCommit,
  chromium: raw.metadata.cd.chromium, cdAssetsSha256: raw.cdAssetsSha256,
  crocBinaries: raw.metadata['croc-browser'].binaries, cdxSha256: raw.metadata.cd.cdxSha256};
writeFileSync(root + 'matching-browser-summary.json', JSON.stringify(summary, null, 2) + '\n');
writeFileSync(root + 'matching-browser-gates.json', JSON.stringify(gates, null, 2) + '\n');
const section = `<section class="panel" id="matching-browser"><h2>CD and croc browser clients</h2>
<p>Matching browser/CLI interfaces, croc 11.5.5. All 63 transfers passed SHA-256 verification. Seven alternating rounds, 64 MiB random input, RAM output, identical Chromium ${summary.chromium}, private local relays.</p>
<p>Croc's official browser supports sends and receives through a WebSocket-to-TCP relay. That baseline is compared with both CD's direct-allowed mode and forced relay. This fills a missing browser baseline; the original native-croc cross-interface gates remain unchanged.</p>
<label>Timing · lower is better <select id="matching-metric"><option value="durableMs">Receiver + flush</option><option value="receiverMs">Receiver completion</option><option value="readyMs">Ready to share</option><option value="totalMs">Total completion</option></select></label>
<div class="table-wrap"><table><caption style="text-align:left;padding:8px 0;color:var(--muted-foreground,#999);font-size:13px">Time (ms): lower is better. Speed ratio (×): higher is better.</caption><thead><tr><th>Direction · CD mode</th><th>CD median</th><th>croc browser median</th><th>croc / CD</th><th>Selected gate</th></tr></thead><tbody id="matching-results"></tbody></table></div>
<div id="matching-chart" aria-label="Completion time comparison, lower is better"></div>
<p id="matching-verdict"></p><p>Ranges below each median show the observed minimum and maximum. Pages load before timing; browser sends include file selection and pressing Send. Receiver timings include automatic consent where required, saving the download, and file/directory fsync. SHA-256 verification is outside timing. Croc uses its default browser compression policy. These are loopback results, not internet or physical-LAN claims.</p>
<p>Readiness has different product semantics: croc prints its generated CLI code before connecting to a relay; CD displays a numeric code after the relay has registered it. Both native readiness events remain measured. Encryption, verification and admission guarantees are preserved.</p>
<p>CD frontend snapshot 974c6cd, measured ${summary.measuredAt}. The source-copy iteration is measured separately. The overall 1.5×–2× goal remains open. Browser-to-browser direct-allowed completion and CLI readiness still miss gates, and the 100 Mb/s LAN requires faster hardware.</p>
<p><a href="/cd-bench/browser-matching-browser-paired.json">Raw paired trials</a> · <a href="/cd-bench/browser-matching-browser-summary.json">Computed results</a> · <a href="/cd-bench/bench-croc-browser.mjs">croc browser driver</a> · <a href="/cd-bench/bench-browser-croc-paired.mjs">Paired driver</a> · <a href="https://github.com/schollz/croc/blob/v11.5.5/web/README.md">Official browser documentation</a> · <a href="https://github.com/schollz/croc/blob/v11.5.5/src/croc/croc.go#L1785">croc readiness source</a></p></section>`;
const fmt = value => value.toLocaleString('en-US', {maximumFractionDigits: 1});
const sourceSection = `<section class="panel" id="source-views"><h2>Single-file source views</h2><p>The retained one-line change skips redundant rechunking for single files. It sends bounded views of each existing 4 MiB read; bundles retain their batching and every wire record retains its negotiated size limit. The three experiments verified all 42 outputs. All ten real 64 MiB transport checks also pass.</p><div class="table-wrap"><table><caption style="text-align:left;padding:8px 0;color:var(--muted-foreground,#999);font-size:13px">Time (ms): lower is better. Speed ratio (×): higher is better.</caption><thead><tr><th>Direction · mode</th><th>Before</th><th>After</th><th>Before / after</th></tr></thead><tbody id="source-view-results">${sourceViews.map(row => `<tr><td>${row.name.replaceAll('-', ' → ').replace('/relay', ' · forced relay').replace('/direct', ' · direct allowed')}</td><td>${fmt(row.beforeMs)} ms</td><td>${fmt(row.afterMs)} ms</td><td>${row.ratio.toFixed(2)}×</td></tr>`).join('')}</tbody></table></div><p>Browser-to-CLI relay and browser-to-browser direct-allowed medians improved. Browser-to-browser relay was 1.4% slower in this comparison. No uniform improvement is claimed, and this change does not meet the remaining 1.5× gates.</p><p>${sourceViews.map(row => `<a href="/cd-bench/browser-${row.file}">${row.name}</a>`).join(' · ')} · <a href="/cd-bench/browser-source-views.patch">Source patch</a></p></section>`;
const style = `<style>#matching-browser{margin-top:12px}#matching-browser label{display:flex;gap:12px;align-items:center;margin:20px 0}#matching-browser select{font:inherit;color:inherit;background:transparent;border:1px solid #8994a366;padding:8px}#matching-browser option{color:#172130;background:#f4f7fc}#matching-browser .table-wrap,#source-views .table-wrap{overflow:auto}#matching-browser table,#source-views table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}#matching-browser th,#matching-browser td,#source-views th,#source-views td{text-align:left;padding:10px 8px;border-bottom:1px solid #8994a344}#matching-browser td small{display:block;font-size:11px;color:#8994a3}#matching-chart{display:grid;gap:10px;margin:24px 0}#matching-chart>div{display:grid;grid-template-columns:170px minmax(30px,1fr) 150px;align-items:center;gap:12px}#matching-chart .tracks{display:grid;gap:4px}#matching-chart .tracks i{display:block;height:10px;background:#2b65d9}#matching-chart .tracks i+ i{background:#8b96a8}#matching-chart small{font-size:11px}@media(max-width:500px){#matching-chart>div{grid-template-columns:110px minmax(20px,1fr) 100px;gap:6px;font-size:11px}}</style>`;
const script = `<script>(()=>{const data=${JSON.stringify(summary).replaceAll('<', '\\u003c')};const fmt=n=>n.toLocaleString('en-US',{maximumFractionDigits:1});const name=row=>{const[direction,route]=row.name.split('/');return direction.replaceAll('-',' → ')+' · '+(route==='direct'?'direct allowed':'forced relay')};const render=()=>{const metric=document.getElementById('matching-metric').value;document.getElementById('matching-results').innerHTML=data.cases.map(row=>{const value=row.metrics[metric],range=row.spread[metric];return '<tr><td>'+name(row)+'</td><td>'+fmt(value.cdMs)+' ms<small>'+fmt(range.cd.min)+'–'+fmt(range.cd.max)+' ms</small></td><td>'+fmt(value.crocMs)+' ms<small>'+fmt(range.croc.min)+'–'+fmt(range.croc.max)+' ms</small></td><td>'+value.ratio.toFixed(2)+'×</td><td>'+(value.pass?'pass':'miss')+'</td></tr>'}).join('');const max=Math.max(...data.cases.flatMap(row=>[row.metrics[metric].cdMs,row.metrics[metric].crocMs]));document.getElementById('matching-chart').innerHTML=data.cases.map(row=>{const value=row.metrics[metric];return '<div><span>'+name(row)+'</span><div class="tracks"><i style="width:'+value.cdMs/max*100+'%"></i><i style="width:'+value.crocMs/max*100+'%"></i></div><small>CD '+fmt(value.cdMs)+' ms<br>croc '+fmt(value.crocMs)+' ms</small></div>'}).join('');document.getElementById('matching-verdict').textContent=data.cases.filter(row=>row.metrics[metric].pass).length+' / 6 combinations meet 1.5× on this metric. '+data.cases.filter(row=>row.pass).length+' / 6 meet all four timing gates. Overall goal achieved: false.'};document.getElementById('matching-metric').onchange=render;render()})();</script>`;
writeFileSync(root + 'matching-browser-section.html', style + section + sourceSection + script);
writeFileSync(root + 'matching-browser.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CD and croc browser benchmark</title>${style}<style>body{margin:0;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground,#172130)}h2{font-size:24px;line-height:1.2}p{color:var(--muted-foreground,#566273)}a{color:var(--accent-foreground,#2b65d9)}#matching-browser{margin:0}</style></head><body>${section}${script}</body></html>`);
console.log(JSON.stringify({verified: summary.verified, complete: gates.complete, achieved: gates.achieved, passingCases: cases.filter(row => row.pass).length}));
