import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateProf} from './prof-gates.mjs';
const specs={'random-4k':4096,'random-1m':1048576,'random-64m':67108864,'random-256m':268435456,'compressible-256m':268435456};
const tools=['cd','croc','croc-no-compress'];
function row(tool,run,bytes){const ms={cd:10,croc:22,'croc-no-compress':21}[tool];return {tool,run,bytes,ok:true,sha256:'a'.repeat(64),readyMs:ms,receiverMs:ms,durableMs:ms,totalMs:ms};}
function fixture(){
 const native={finishedAt:'2026-10-20',options:{runs:7,cases:Object.keys(specs),storage:['disk','tmpfs'],routes:['auto','relay']},rows:[]};
 for(const storage of native.options.storage)for(const route of native.options.routes)for(const [name,bytes]of Object.entries(specs))for(let run=0;run<7;run++)for(const tool of tools)native.rows.push({...row(tool,run,bytes),case:name,storage,route});
 const browser={finishedAt:'2026-10-20',mib:64,runs:7,rows:[]};
 for(const direction of ['browser-browser','browser-cli','cli-browser'])for(const route of ['direct','relay'])for(let run=0;run<7;run++)browser.rows.push({...row('cd',run,67108864),direction,route});
 const lan={finishedAt:'2026-10-20',options:{mib:128,runs:3},rows:[]};for(let run=0;run<3;run++)for(const tool of tools)lan.rows.push(row(tool,run,134217728));
 return [native,browser,lan];
}
test('all required comparisons must clear every timing gate',()=>{
 const result=evaluateProf(...fixture());assert.equal(result.complete,true);assert.equal(result.achieved,true);assert.equal(result.nativeCases.length,20);assert.equal(result.browserCases.length,6);assert.equal(result.browserCases[0].metrics.durableMs.ratio,2.1);assert.equal(result.lanCase.pass,true);
});
test('a single browser failure prevents achievement',()=>{
 const reports=fixture();reports[1].rows[0].ok=false;const result=evaluateProf(...reports);assert.equal(result.complete,false);assert.equal(result.achieved,false);
});
test('the faster croc setting is used independently for every metric',()=>{
 const reports=fixture();for(const r of reports[0].rows)if(r.tool==='croc-no-compress')r.readyMs=14;const result=evaluateProf(...reports);assert.equal(result.complete,true);assert.equal(result.achieved,false);assert.equal(result.nativeCases[0].metrics.readyMs.ratio,1.4);assert.equal(result.nativeCases[0].metrics.durableMs.ratio,2.1);
});
test('missing required workloads cannot shrink the goal to a passing subset',()=>{
 const reports=fixture();reports[0].options.cases=reports[0].options.cases.filter(name=>name!=='random-1m');const result=evaluateProf(...reports);assert.equal(result.scope,false);assert.equal(result.achieved,false);
});
test('duplicate trials, wrong byte lengths and missing hashes fail completeness',()=>{
 for(const change of [r=>r.run=1,r=>r.bytes=4096,r=>r.sha256='']){const reports=fixture();change(reports[1].rows[0]);assert.equal(evaluateProf(...reports).complete,false);}
});
test('unfinished suites and missing LAN evidence cannot pass',()=>{
 const reports=fixture();delete reports[1].finishedAt;assert.equal(evaluateProf(...reports).achieved,false);assert.equal(evaluateProf(reports[0],reports[1],null).achieved,false);
});
test('fewer than seven native and browser trials remain exploratory',()=>{
 const reports=fixture();reports[1].runs=3;assert.equal(evaluateProf(...reports).scope,false);
});
