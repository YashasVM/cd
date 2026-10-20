// Diagnostic transport ceiling, not a product benchmark or an unencrypted mode.
// Uses private, capability-authenticated rooms and throwaway random data only.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {findChromium,startWorker} from './harness.mjs';
const mib=Number(process.env.CD_CEILING_MIB||64),runs=Number(process.env.CD_CEILING_RUNS||3);
assert.ok(Number.isInteger(mib)&&mib>0&&mib<=256);assert.ok(Number.isInteger(runs)&&runs>0);
const output=resolve(process.env.CD_CEILING_OUTPUT||'/tmp/cd-browser-ceiling.json');
const work=await mkdtemp('/dev/shm/cd-ceiling-');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const payload=randomBytes(mib*1048576),source=join(work,'payload.bin');await writeFile(source,payload);
let browser,worker;const sockets=new Set();
let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;void browser?.close().catch(()=>{})});
const report={version:1,mib,runs,startedAt:new Date().toISOString(),rows:[],method:'Raw browser WebSocket to Node receiver through the real local Worker. Random payload preloaded outside timing, no CD file/record encryption, disk writing or application ACK window. Measures transport overhead only. SHA256 checked after timing. Private authenticated throwaway room; never exposes an unencrypted production transfer option.'};
function client(url){
 const socket=new WebSocket(url);sockets.add(socket);socket.binaryType='arraybuffer';
 const queue=[],waiters=[];let failure=null;
 const push=value=>{queue.push(value);waiters.shift()?.()};
 socket.addEventListener('message',event=>push(typeof event.data==='string'?JSON.parse(event.data):new Uint8Array(event.data)));
 socket.addEventListener('error',()=>{failure=new Error('socket failed');for(const wake of waiters.splice(0))wake()});
 socket.addEventListener('close',()=>{failure=new Error('socket closed');for(const wake of waiters.splice(0))wake()});
 return {socket,opened:new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})}),async next(){
  const deadline=Date.now()+60000;
  for(;;){if(queue.length)return queue.shift();if(failure)throw failure;const remaining=deadline-Date.now();assert.ok(remaining>0,'socket timed out');await new Promise(resolve=>{const timer=setTimeout(resolve,remaining);waiters.push(()=>{clearTimeout(timer);resolve()})})}
 }};
}
try{
 process.env.CD_VERIFY_WRANGLER_CONFIG=process.env.CD_CEILING_CONFIG||fileURLToPath(new URL('./bench-worker.wrangler.jsonc',import.meta.url));
 worker=await startWorker(work);browser=await chromium.launch({executablePath:await findChromium(),headless:true});
 for(let run=0;run<runs;run++)for(const chunkBytes of [262144,786432]){
  if(interrupted)throw new Error('benchmark interrupted');
  const context=await browser.newContext();
  let receiver;
  try{
   const page=await context.newPage();await page.goto(worker.publicBase+'/api/health');
   await page.evaluate(()=>{document.body.innerHTML='<input type="file" id="payload">'});
   await page.locator('#payload').setInputFiles(source);
   await page.evaluate(async()=>{window.payload=new Uint8Array(await document.getElementById('payload').files[0].arrayBuffer())});
   const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(Buffer.from(token,'base64url')).digest('base64url'),url=worker.relayBase+'/'+randomBytes(16).toString('base64url');
   await page.evaluate(async({url,tokenHash})=>{
    window.sender=new WebSocket(url);sender.binaryType='arraybuffer';
    await new Promise((resolve,reject)=>{sender.onopen=resolve;sender.onerror=reject});
    const accepted=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('sender admission timed out')),15000);sender.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('sender admission rejected'))},{once:true});sender.addEventListener('message',event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='accepted'){clearTimeout(timer);resolve()}})});
    sender.send(JSON.stringify({type:'join',protocol:'cd-transfer-v1',role:'sender',receiverTokenHash:tokenHash}));await accepted;
   },{url,tokenHash});
   receiver=client(url);await receiver.opened;receiver.socket.send(JSON.stringify({type:'join',protocol:'cd-transfer-v1',role:'receiver',receiverToken:token}));
   assert.equal((await receiver.next()).type,'accepted');
   const received=[];let bytes=0;
   const receive=(async()=>{while(bytes<payload.byteLength){const frame=await receiver.next();if(!(frame instanceof Uint8Array))continue;received.push(frame);bytes+=frame.byteLength;assert.ok(bytes<=payload.byteLength,'unexpected bytes')}})();
   const started=performance.now();
   const sending=page.evaluate(async({chunkBytes})=>{
    let maxBuffered=0,polls=0;
    for(let offset=0;offset<payload.byteLength;offset+=chunkBytes){const chunk=payload.subarray(offset,offset+chunkBytes);while(sender.bufferedAmount+chunk.byteLength>4*1048576){polls++;await new Promise(resolve=>setTimeout(resolve,10))}sender.send(chunk);maxBuffered=Math.max(maxBuffered,sender.bufferedAmount)}
    return {maxBuffered,polls};
   },{chunkBytes});
   await receive;const milliseconds=performance.now()-started;const senderStats=await sending;
   assert.equal(digest(Buffer.concat(received)),digest(payload));
   report.rows.push({run,chunkBytes,bytes,milliseconds,mibPerSecond:mib/(milliseconds/1000),senderStats,ok:true});
   console.error(chunkBytes+' #'+(run+1)+': '+milliseconds.toFixed(1)+'ms');
  }finally{receiver?.socket.close();await context.close()}
  await writeFile(output,JSON.stringify(report,null,2));
 }
}catch(error){report.error=error.stack;process.exitCode=1}
finally{for(const s of sockets)try{s.close()}catch{}await browser?.close();await worker?.stop();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
console.log(JSON.stringify({output,successful:report.rows.length,error:report.error}));
