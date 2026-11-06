import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluateBrowserCroc} from './prof-gates.mjs';

function fixture(){
 const rows=[];
 for(let run=0;run<7;run++)for(const direction of ['browser-browser','browser-cli','cli-browser']){
  for(const route of ['direct','relay'])rows.push({tool:'cd',direction,route,run,ok:true,bytes:67108864,sha256:'a'.repeat(64),readyMs:10,receiverMs:10,durableMs:10,totalMs:20});
  rows.push({tool:'croc-browser',direction,route:'relay',run,ok:true,bytes:67108864,sha256:'b'.repeat(64),readyMs:20,receiverMs:20,durableMs:20,totalMs:40});
 }
 return {runs:7,mib:64,rows,finishedAt:'2026-10-20T00:00:00Z',contended:false,metadata:{cd:{chromium:'same-browser'},'croc-browser':{chromium:'same-browser'}}};
}
test('matching browser gates require every interface and timing to pass',()=>{
 const result=evaluateBrowserCroc(fixture());
 assert.equal(result.complete,true);assert.equal(result.achieved,true);assert.equal(result.comparisons.length,6);
 for(const row of result.comparisons)assert.equal(row.metrics.durableMs.ratio,2);
 const slowerReady=fixture();for(const row of slowerReady.rows)if(row.tool==='cd')row.readyMs=30;
 assert.equal(evaluateBrowserCroc(slowerReady).complete,true);assert.equal(evaluateBrowserCroc(slowerReady).achieved,false);
});
test('missing, duplicated, failed, or unverified trials cannot complete the gate',()=>{
 for(const change of [r=>r.rows.pop(),r=>{r.rows[1]=r.rows[0]},r=>{r.rows[0].ok=false},r=>{r.rows[0].sha256='missing'},r=>{r.rows[0].bytes=4096},r=>{r.rows[0].durableMs=NaN},r=>{r.contended=true},r=>{r.metadata.cd.chromium='other-browser'}]){
  const report=fixture();change(report);assert.equal(evaluateBrowserCroc(report).complete,false);assert.equal(evaluateBrowserCroc(report).achieved,false);
 }
});
test('a partial-size or short run remains diagnostic evidence',()=>{
 const report=fixture();report.mib=1;assert.equal(evaluateBrowserCroc(report).achieved,false);
 assert.throws(()=>evaluateBrowserCroc(fixture(),{threshold:1}),RangeError);
});
