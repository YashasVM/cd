import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trial } from './bench-croc-matrix.mjs';
import { startDirectRuntime } from './bench-direct-runtime.mjs';
if (!process.argv[2] || !process.argv[3] || !process.argv[4] || !process.env.CD_BENCH_RUNTIME_BUNDLE) throw Error('Usage: CD_BENCH_RUNTIME_BUNDLE=/absolute/worker.js node scripts/bench-relay-reuse.mjs /absolute/baseline /absolute/candidate report.json');
const root = await mkdtemp(join(process.env.CD_BENCH_WORKDIR || process.cwd(), 'cd-paired-'));
const hash = async p => { const h=createHash('sha256'); for await(const b of createReadStream(p))h.update(b); return h.digest('hex'); };
let worker; const rows=[];
try {
 worker=await startDirectRuntime(process.env.CD_BENCH_RUNTIME_BUNDLE,{compression:false});
 for(const mib of [64,256]) {
  const input=join(root,'payload.bin'), file=await open(input,'w');
  try { for(let i=0;i<mib;i++){const b=randomBytes(1048576);let off=0;while(off<b.length)off+=(await file.write(b,off)).bytesWritten;} await file.sync(); } finally { await file.close(); }
  const expected=await hash(input);
  for(let run=-1;run<7;run++) for(const which of run%2===0?['candidate','baseline']:['baseline','candidate']) {
   await delay(5500); // Outside timing; respect unchanged short-code admission.
   const output=await mkdtemp(join(root,'out-'));
   const result=await trial({tool:'cd',route:'relay',input,output,state:join(output,'state'),executable:process.argv[which==='baseline'?2:3],worker,timeout:30000,expected});
   const row={which,mib,run,...result};rows.push(row);
   console.error(JSON.stringify({which,mib,run,ok:result.ok,totalMs:result.totalMs,error:result.error}));
   if(!result.ok)throw Error(result.error);
   await rm(output,{recursive:true,force:true});
  }
 }
}finally{try{await writeFile(process.argv[4],JSON.stringify({scope:'Paired loopback relay diagnostic; not croc or WAN comparison',pacingMs:5500,baseline:process.argv[2],candidate:process.argv[3],warmups:1,runs:7,rows},null,2));}finally{await worker?.stop();await rm(root,{recursive:true,force:true});}}
