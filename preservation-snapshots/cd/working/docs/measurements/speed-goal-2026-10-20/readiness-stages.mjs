// Diagnostic only. No transfer/auth/source changes. Node >=22; run from repo root.
// node docs/measurements/speed-goal-2026-10-20/readiness-stages.mjs /tmp/cd-speed-goal-candidate 12
import {spawn} from 'node:child_process';
import {createServer, connect} from 'node:net';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {once} from 'node:events';
import {startWorker, stopChild} from '../../../scripts/harness.mjs';
const binary=resolve(process.argv[2] || '/tmp/cd-speed-goal-candidate'), runs=Number(process.argv[3] || 12);
const root=await mkdtemp('/dev/shm/cd-readiness-');
await writeFile(join(root,'payload.bin'),Buffer.alloc(4096));
process.env.CD_VERIFY_WRANGLER_CONFIG=resolve('scripts/bench-worker.wrangler.jsonc');
const worker=await startWorker(root), workerURL=new URL(worker.publicBase);
let current;
const sockets=new Set();
const proxy=createServer(client=>{
  sockets.add(client); client.once('close',()=>sockets.delete(client));
  const upstream=connect(Number(workerURL.port),workerURL.hostname);
  let requested=false, upgraded=false;
  client.on('data',chunk=>{
    if(!requested){requested=true;current.request=performance.now();}
    else if(upgraded && !current.join)current.join=performance.now();
  });
  upstream.on('data',chunk=>{
    if(!upgraded && chunk.includes(Buffer.from('101 Switching Protocols'))){upgraded=true; current.upgrade=performance.now();}
    if(chunk.includes(Buffer.from('"accepted"')))current.accepted=performance.now();
  });
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
  client.pipe(upstream);upstream.pipe(client);
});
proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
const port=proxy.address().port, rows=[];
try {
 for(let i=0;i<runs;i++)for(const mode of ['version','link','code']){
  current={mode,iteration:i,started:performance.now()}; const row=current;
  const args=mode==='version'?['--version']:['send','--wait',...(mode==='link'?['--link']:[]),join(root,'payload.bin')];
  const child=spawn(binary,args,{env:{...process.env,CD_RELAY_URL:`ws://127.0.0.1:${port}/ws/v1`,CD_PUBLIC_URL:`http://127.0.0.1:${port}`,CD_STATE_DIR:join(root,'state'),CD_DIRECT:'0'},stdio:['ignore','pipe','pipe']});
  child.once('spawn',()=>row.spawned=performance.now());
  let output='',error='';child.stderr.on('data',c=>error+=c);
  await new Promise((res,rej)=>{
   const timer=setTimeout(()=>{child.kill();rej(Error('readiness timeout '+error));},5000);
   child.stdout.on('data',c=>{output+=c;if(output.includes('\n')){row.ready=performance.now();clearTimeout(timer);res();}});
   child.once('error',rej);child.once('exit',code=>{if(!row.ready){clearTimeout(timer);rej(Error('early exit '+code+' '+error));}});
  });
  await stopChild(child);
  for(const socket of sockets)socket.destroy();
  rows.push({mode,iteration:i,readyMs:row.ready-row.started,spawnMs:row.spawned-row.started,
   ...(row.request?{requestMs:row.request-row.started,upgradeMs:row.upgrade-row.request,joinAfterUpgradeMs:row.join-row.upgrade,admissionMs:row.accepted-row.join,outputAfterAdmissionMs:row.ready-row.accepted}:{})});
 }
 const median=values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];};
 const summary=Object.fromEntries(['version','link','code'].map(mode=>{const subset=rows.filter(r=>r.mode===mode);return[mode,Object.fromEntries(Object.keys(subset[0]).filter(k=>k.endsWith('Ms')).map(k=>[k,median(subset.map(r=>r[k]))]))];}));
 const result={binary,runs,method:'Warm serial 4KiB source. Exact stdout first-line event; transparent local TCP proxy adds one connection hop. HTTP request starts after subprocess startup, file stat and token derivation. Admission includes room creation/join and code-shard claim in code mode. No source modifications; no early/unregistered code. Link mode is diagnostic and is not interchangeable with code-mode readiness.',summary,rows};
 await writeFile(resolve('docs/measurements/speed-goal-2026-10-20/readiness-stages.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
} finally {for(const socket of sockets)socket.destroy();proxy.close();await worker.stop();await rm(root,{recursive:true,force:true});}
