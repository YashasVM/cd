// Raw local WebRTC diagnostic. Random throwaway bytes, never a product mode.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {findChromium} from './harness.mjs';
const runs=Number(process.env.CD_DIRECT_CEILING_RUNS||3),mib=Number(process.env.CD_DIRECT_CEILING_MIB||64);
assert.ok(Number.isInteger(runs)&&runs>0);assert.ok(Number.isInteger(mib)&&mib>0&&mib<=64);
const pieces=(process.env.CD_DIRECT_CEILING_PIECES||'4096,16384,65536').split(',').map(Number);
assert.ok(pieces.length&&pieces.every(n=>Number.isInteger(n)&&n>0&&n<=65536));
const output=resolve(process.env.CD_DIRECT_CEILING_OUTPUT||'/tmp/cd-direct-ceiling.json'),work=await mkdtemp('/dev/shm/cd-direct-ceiling-');
const payload=randomBytes(mib*1048576),source=join(work,'payload.bin'),expected=createHash('sha256').update(payload).digest('hex');await writeFile(source,payload);
const report={version:1,runs,mib,pieces,startedAt:new Date().toISOString(),rows:[],method:'Raw browser-to-browser ordered reliable WebRTC with negotiated channel 1, host ICE candidates only, 4 MiB native send-buffer cap and 10 ms drain polling. Connection establishment and source preload outside timing. No CD encryption, storage, framing or application ACK window. SHA256 after timing. Diagnostic only.'};
let browser;
try{
 browser=await chromium.launch({executablePath:await findChromium(),headless:true});
 for(let run=0;run<runs;run++)for(const pieceBytes of pieces.slice(run%pieces.length).concat(pieces.slice(0,run%pieces.length))){
  const context=await browser.newContext();
  try{
   const page=await context.newPage();await page.route('http://127.0.0.1/cd-direct-diagnostic',route=>route.fulfill({contentType:'text/html',body:'<input type="file" id="payload">'}));await page.goto('http://127.0.0.1/cd-direct-diagnostic');await page.locator('#payload').setInputFiles(source);
   await page.evaluate(async()=>{window.payload=new Uint8Array(await document.getElementById('payload').files[0].arrayBuffer());});
   const result=await page.evaluate(async({pieceBytes})=>{
    const sender=new RTCPeerConnection({iceServers:[]}),receiver=new RTCPeerConnection({iceServers:[]});
    const outgoing=sender.createDataChannel('diagnostic',{negotiated:true,id:1,ordered:true}),incoming=receiver.createDataChannel('diagnostic',{negotiated:true,id:1,ordered:true});incoming.binaryType='arraybuffer';
    const opened=channel=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('channel open timed out')),15000);channel.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})});
    const ready=Promise.all([opened(outgoing),opened(incoming)]);
    const gather=async(peer,description)=>{await peer.setLocalDescription(description);if(peer.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const done=()=>{if(peer.iceGatheringState==='complete'){clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',done);resolve()}};const timer=setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',done);reject(new Error('ICE gathering timed out'))},5000);peer.addEventListener('icegatheringstatechange',done);done()});return peer.localDescription};
    try{
     await receiver.setRemoteDescription(await gather(sender,await sender.createOffer()));await sender.setRemoteDescription(await gather(receiver,await receiver.createAnswer()));await ready;
     const chunks=[];let bytes=0,maxBuffered=0,polls=0;
     const complete=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('payload timed out')),60000);incoming.addEventListener('message',event=>{const chunk=new Uint8Array(event.data);chunks.push(chunk);bytes+=chunk.length;if(bytes>payload.length){clearTimeout(timer);reject(new Error('oversized payload'))}if(bytes===payload.length){clearTimeout(timer);resolve()}})});
     const started=performance.now();
     const sending=(async()=>{for(let at=0;at<payload.length;at+=pieceBytes){const chunk=payload.subarray(at,at+pieceBytes);while(outgoing.bufferedAmount+chunk.length>4*1048576){polls++;await new Promise(resolve=>setTimeout(resolve,10))}outgoing.send(chunk);maxBuffered=Math.max(maxBuffered,outgoing.bufferedAmount)}})();
     await Promise.all([sending,complete]);const milliseconds=performance.now()-started;
     const merged=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.length}
     const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',merged))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
     return {milliseconds,bytes,hash,maxBuffered,polls};
    }finally{sender.close();receiver.close()}
   },{pieceBytes});
   assert.equal(result.bytes,payload.length);assert.equal(result.hash,expected);assert.ok(result.maxBuffered<=4*1048576);
   report.rows.push({run,pieceBytes,...result,ok:true});console.error(pieceBytes+' #'+(run+1)+': '+result.milliseconds.toFixed(1)+'ms');await writeFile(output,JSON.stringify(report,null,2));
  }finally{await context.close()}
 }
}catch(error){report.error=error.stack;process.exitCode=1}
finally{await browser?.close();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
