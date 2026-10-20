// Real UI benchmark for all non-Android browser/CLI directions.
// Build frontend first. Each output is SHA-256 checked outside timing.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {browserTransportProbe} from './bench-metrics.mjs';
import {buildCLI,captureOutput,childExit,cliEnv,findChromium,firstLine,startWorker,stopChild} from './harness.mjs';
const output=resolve(process.env.CD_BROWSER_OUTPUT||'/tmp/cd-browser-bench.json');
const runs=Number(process.env.CD_BROWSER_RUNS||3),mib=Number(process.env.CD_BROWSER_MIB||64);
assert.ok(Number.isInteger(runs)&&runs>0);assert.ok(Number.isInteger(mib)&&mib>0);
const work=await mkdtemp('/dev/shm/cd-browser-bench-');
const report={version:1,profiling:process.env.CD_BROWSER_PROFILE==='1',runtime:process.env.CD_BENCH_RUNTIME_BUNDLE?'direct workerd':'wrangler dev',webSocketCompression:process.env.CD_BENCH_NO_COMPRESSION!=='1',startedAt:new Date().toISOString(),runs,mib,rows:[],method:'Preload both pages outside transfer timing. Sender readiness starts at file selection or CLI launch. Receiver timing starts at code entry or CLI launch and ends after browser download save or CLI exit. File and directory fsync added to both; SHA256 checked after timing. Local Worker control and output in tmpfs; not physical persistence. No artificial CPU/decrypt delays.'};
const hash=b=>createHash('sha256').update(b).digest('hex');
let worker,browser;const children=new Set();
const cases=['browser-browser','browser-cli','cli-browser'].flatMap(direction=>['direct','relay'].map(route=>({direction,route})));
try{
 const payload=randomBytes(mib*1048576),input=join(work,'payload.bin');await writeFile(input,payload);const expected=hash(payload);
 const executable=process.env.CD_BROWSER_CDX||await buildCLI('/tmp');
 report.cdxSha256=hash(await readFile(executable));
 process.env.CD_VERIFY_WRANGLER_CONFIG=fileURLToPath(new URL('./bench-worker.wrangler.jsonc',import.meta.url));
 worker=await startWorker(work);
 browser=await chromium.launch({executablePath:await findChromium(),headless:true,args:['--disable-dev-shm-usage']});
 report.chromium=browser.version();
 const selected=process.env.CD_BROWSER_ONLY?.split(',');
 if(selected)assert.ok(selected.every(name=>cases.some(c=>c.direction+'/'+c.route===name)),'unknown browser benchmark case');
 for(let run=0;run<runs;run++)for(const {direction,route} of cases.slice(run%cases.length).concat(cases.slice(0,run%cases.length)).filter(c=>!selected||selected.includes(c.direction+'/'+c.route))){
  const contexts=[],active=[];let senderPage,receiverPage,sender,receiver;const blocked=route==='relay';
  const env=cliEnv(worker,{CD_TRANSPORT_REPORT:'1',CD_DIRECT:blocked?'0':'1',CD_STATE_DIR:join(work,'state-'+run+'-'+direction+'-'+route)});
  const launch=args=>{const child=spawn(executable,args,{env,stdio:['ignore','pipe','pipe']});children.add(child);active.push(child);return {child,out:captureOutput(child)}};
  const row={direction,route,run,bytes:payload.length,ok:false};
  try{
   const page=async()=>{const context=await browser.newContext({acceptDownloads:true});contexts.push(context);await context.addInitScript(browserTransportProbe,{blockDirect:blocked,profile:process.env.CD_BROWSER_PROFILE==='1'});
    if(process.env.CD_BROWSER_PROFILE==='1')await context.addInitScript(()=>{
     window.__benchPhases={};
     const nativeTimeout=window.setTimeout;
     window.setTimeout=function(callback,delay,...args){if(typeof callback!=='function'||delay>20)return nativeTimeout.call(this,callback,delay,...args);const start=performance.now();return nativeTimeout.call(this,(...values)=>{const stat=window.__benchPhases.shortTimer??={calls:0,ms:0,maxMs:0};const elapsed=performance.now()-start;stat.calls++;stat.ms+=elapsed;stat.maxMs=Math.max(stat.maxMs,elapsed);callback(...values)},delay,...args)};
     const measure=(prototype,method,label)=>{if(!prototype?.[method])return;const native=prototype[method];prototype[method]=async function(...args){const start=performance.now();try{return await native.apply(this,args)}finally{const stat=window.__benchPhases[label]??={calls:0,ms:0,maxMs:0};const elapsed=performance.now()-start;stat.calls++;stat.ms+=elapsed;stat.maxMs=Math.max(stat.maxMs,elapsed)}}};
     measure(SubtleCrypto.prototype,'encrypt','encrypt');measure(SubtleCrypto.prototype,'decrypt','decrypt');measure(Blob.prototype,'arrayBuffer','blobRead');measure(ReadableStreamDefaultReader.prototype,'read','streamRead');measure(globalThis.FileSystemWritableFileStream?.prototype,'write','diskWrite');
    });const p=await context.newPage();p.setDefaultTimeout(60000);await p.goto(worker.publicBase);await p.locator('.workbench:not([inert])').waitFor();return p};
   if(direction.startsWith('browser'))senderPage=await page();
   if(direction.endsWith('browser')){receiverPage=await page();await receiverPage.locator('#receive-mode-btn').click();}
   const start=performance.now();let code;
   if(senderPage){await senderPage.locator('#file-input').setInputFiles(input);await senderPage.locator('#sender-code-section:not(.hidden)').waitFor();code=(await senderPage.locator('#share-code').textContent()).trim();}
   else{sender=launch(['send','--wait',input]);code=await firstLine(sender.child.stdout,30000);}
   const receiveStart=performance.now();row.readyMs=receiveStart-start;
   row.receiveStartedAt=performance.timeOrigin+receiveStart;
   const dir=join(work,run+'-'+direction+'-'+route);await mkdir(dir);const target=join(dir,'payload.bin');
   if(receiverPage){const downloadPromise=receiverPage.waitForEvent('download',{timeout:60000});await receiverPage.locator('#code-input').fill(code);const download=await downloadPromise;row.downloadEventMs=performance.now()-receiveStart;const saveStart=performance.now();await download.saveAs(target);row.downloadSaveMs=performance.now()-saveStart;}
   else{receiver=launch(['receive',code,'--out',target]);assert.equal(await childExit(receiver.child,60000),0,receiver.out.stderr);}
   row.receiverMs=performance.now()-receiveStart;
   for(const p of [target,dir]){const fd=await open(p,'r');try{await fd.sync()}finally{await fd.close()}}
   row.durableMs=performance.now()-receiveStart;row.totalMs=performance.now()-start;
   if(sender)assert.equal(await childExit(sender.child,60000),0,sender.out.stderr);else await senderPage.locator('#sender-complete:not(.hidden)').waitFor();
   assert.equal(hash(await readFile(target)),expected,'received hash mismatch');row.sha256=expected;
   row.senderStats=senderPage?await senderPage.evaluate(()=>window.__benchTransport):null;
   row.receiverStats=receiverPage?await receiverPage.evaluate(()=>window.__benchTransport):null;
   row.senderPhases=senderPage?await senderPage.evaluate(()=>window.__benchPhases):null;
   row.receiverPhases=receiverPage?await receiverPage.evaluate(()=>window.__benchPhases):null;
   if(process.env.CD_BENCH_RUNTIME_BUNDLE)for(const stats of [row.senderStats,row.receiverStats].filter(Boolean)){assert.ok(stats.webSocketExtensions.length>0,'missing relay handshake evidence');assert.ok(stats.webSocketExtensions.every(extension=>process.env.CD_BENCH_NO_COMPRESSION==='1'?extension==='':extension.includes('permessage-deflate')),'unexpected WebSocket compression negotiation')}
   row.cliReports=[sender?.out.stderr,receiver?.out.stderr].filter(Boolean).join('\n').split('\n').flatMap(s=>{try{const r=JSON.parse(s);return r.transport?[r]:[]}catch{return []}});
   const directBytes=row.senderStats?.directPayloadBytes??row.receiverStats?.directReceivedPayloadBytes??0;
   const relayBytes=row.senderStats?.relayPayloadBytes??row.receiverStats?.relayReceivedPayloadBytes??0;
   row.directPayloadBytes=directBytes;row.relayPayloadBytes=relayBytes;
   if(blocked){assert.equal(directBytes,0);assert.ok(relayBytes>=payload.length,'relay bytes missing');}
   row.directGate=blocked?null:directBytes>=Math.min(payload.length,1048576);
   row.actualTransport=directBytes>0?(relayBytes>0?'relay + WebRTC':'WebRTC'):'relay';
   row.ok=true;await rm(dir,{recursive:true,force:true});
  }catch(error){row.error=error.stack;row.diagnostics={sender:sender?.out.stderr,receiver:receiver?.out.stderr,senderPage:await senderPage?.locator('body').innerText().catch(()=>''),receiverPage:await receiverPage?.locator('body').innerText().catch(()=>'')};}
  finally{await Promise.all(active.map(async c=>{await stopChild(c);children.delete(c)}));for(const c of contexts)await c.close()}
  report.rows.push(row);await writeFile(output,JSON.stringify(report,null,2));console.error(direction+'/'+route+' #'+(run+1)+': '+(row.ok?row.durableMs.toFixed(1)+'ms':row.error));
 }
}catch(error){report.error=error.stack}
finally{for(const child of children)await stopChild(child);await browser?.close();await worker?.stop();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
console.log(JSON.stringify({output,passed:report.rows.filter(r=>r.ok).length,failed:report.rows.filter(r=>!r.ok).length,error:report.error}));
if(report.error||report.rows.some(r=>!r.ok))process.exitCode=1;
