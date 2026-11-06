// Alternate independent trials from two immutable frontend builds.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {captureOutput,childExit,stopChild} from './harness.mjs';
const roots={before:process.env.CD_VARIANT_BEFORE,after:process.env.CD_VARIANT_AFTER};
assert.ok(roots.before&&roots.after,'CD_VARIANT_BEFORE and CD_VARIANT_AFTER must identify built checkouts');
const runs=Number(process.env.CD_VARIANT_RUNS||7),mib=Number(process.env.CD_VARIANT_MIB||64),only=process.env.CD_VARIANT_CASE||'browser-browser/direct';
assert.ok(Number.isInteger(runs)&&runs>0);assert.ok(Number.isInteger(mib)&&mib>0);
const output=resolve(process.env.CD_VARIANT_OUTPUT||'/tmp/cd-browser-variants.json'),work=await mkdtemp('/tmp/cd-browser-variants-');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function identity(root,prefix=''){const rows=[];for(const entry of await readdir(join(root,'dist',prefix),{withFileTypes:true})){const path=join(prefix,entry.name);if(entry.isDirectory())rows.push(...await identity(root,path));else rows.push([path,hash(await readFile(join(root,'dist',path)))]);}return rows.sort(([a],[b])=>a.localeCompare(b));}
const report={version:1,runs,mib,case:only,startedAt:new Date().toISOString(),rows:[],builds:{},method:'Alternate before/after independent browser UI trials, reversing order each round. Immutable frontend builds, identical Worker and CLI, same random payload size/entropy class with different hashes per trial. Source readiness, receiver completion, file/directory flush and SHA verification follow bench-browser-paths.mjs. No profiler. Iteration comparison, not a complete croc acceptance run.'};
try{
 for(const [variant,root] of Object.entries(roots))report.builds[variant]={root:resolve(root),assetsSha256:hash(JSON.stringify(await identity(root)))};
 for(let run=0;run<runs;run++)for(const variant of run%2?['after','before']:['before','after']){
  const path=join(work,variant+'-'+run+'.json');
  const child=spawn(process.execPath,['scripts/bench-browser-paths.mjs'],{cwd:roots[variant],env:{...process.env,CD_BROWSER_RUNS:'1',CD_BROWSER_MIB:String(mib),CD_BROWSER_ONLY:only,CD_BROWSER_OUTPUT:path,CD_BROWSER_PROFILE:'0'},stdio:['ignore','pipe','pipe']});
  const diagnostics=captureOutput(child);
  try{
   const code=await childExit(child,90000),trial=JSON.parse(await readFile(path,'utf8'));assert.equal(code,0,diagnostics.stderr);assert.ok(trial.finishedAt&&!trial.error);assert.equal(trial.rows.length,1);const row=trial.rows[0];assert.ok(row.ok);assert.equal(row.bytes,mib*1048576);assert.match(row.sha256,/^[a-f0-9]{64}$/);assert.equal(trial.profiling,false);
   report.rows.push({...row,sourceRun:row.run,run,variant,cdxSha256:trial.cdxSha256});console.error(variant+' #'+(run+1)+': '+row.durableMs.toFixed(1)+'ms');await writeFile(output,JSON.stringify(report,null,2));
  }finally{await stopChild(child)}
 }
 for(const [variant,root] of Object.entries(roots))assert.equal(hash(JSON.stringify(await identity(root))),report.builds[variant].assetsSha256,'frontend changed during comparison');
}catch(error){report.error=error.stack;process.exitCode=1}
finally{await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
