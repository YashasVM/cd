// Raw WebRTC across separate browser contexts, matching the UI benchmark layout.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {findChromium} from './harness.mjs';
const runs=Number(process.env.CD_DIRECT_PAIR_RUNS||7),mib=Number(process.env.CD_DIRECT_PAIR_MIB||64);
assert.ok(Number.isInteger(runs)&&runs>0);assert.ok(Number.isInteger(mib)&&mib>0&&mib<=64);
const pieces=(process.env.CD_DIRECT_PAIR_PIECES||'65536').split(',').map(Number);
assert.ok(pieces.length&&pieces.every(n=>Number.isInteger(n)&&n>0&&n<=262144));
const delays=(process.env.CD_DIRECT_PAIR_DELAY_MS||'0').split(',').map(Number);
assert.ok(delays.length&&delays.every(n=>Number.isInteger(n)&&n>=0&&n<=1000));
const cases=pieces.flatMap(pieceBytes=>delays.map(delayMs=>({pieceBytes,delayMs})));
const output=resolve(process.env.CD_DIRECT_PAIR_OUTPUT||'/tmp/cd-direct-pair.json'),work=await mkdtemp('/dev/shm/cd-direct-pair-');
const payload=randomBytes(mib*1048576),source=join(work,'payload.bin'),expected=createHash('sha256').update(payload).digest('hex');await writeFile(source,payload);
const report={version:1,nativeSharedMemory:process.env.CD_DIRECT_PAIR_SHM==='1',runs,mib,pieces,delays,startedAt:new Date().toISOString(),rows:[],method:'Raw ordered reliable WebRTC across separate browser contexts, negotiated channel 1, specified message size, 4 MiB native buffer and 10 ms drain polling. Host ICE only. Connection setup, payload preload, selected-route stats and SHA256 outside timing. No CD framing, encryption, storage or application ACK window. Diagnostic, not a product speed claim.'};
let browser;
try{
 browser=await chromium.launch({executablePath:await findChromium(),headless:true,...(process.env.CD_DIRECT_PAIR_SHM==='1'?{ignoreDefaultArgs:['--disable-dev-shm-usage']}:{})});
 for(let run=0;run<runs;run++)for(const {pieceBytes,delayMs} of cases.slice(run%cases.length).concat(cases.slice(0,run%cases.length))){
  const contexts=[];
  try{
   const pages=[];
   for(let n=0;n<2;n++){
    const context=await browser.newContext();contexts.push(context);const page=await context.newPage();pages.push(page);
    await page.route('http://127.0.0.1/cd-direct-pair',route=>route.fulfill({contentType:'text/html',body:'<input type="file" id="payload">'}));await page.goto('http://127.0.0.1/cd-direct-pair');
    await page.evaluate(()=>{
     window.peer=new RTCPeerConnection({iceServers:[]});window.channel=peer.createDataChannel('diagnostic',{negotiated:true,id:1,ordered:true});channel.binaryType='arraybuffer';
     window.ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('channel open timed out')),15000);channel.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});channel.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('channel closed'))},{once:true})});ready.catch(()=>{});
     window.gather=async description=>{await peer.setLocalDescription(description);if(peer.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const done=()=>{if(peer.iceGatheringState==='complete'){clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',done);resolve()}};const timer=setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',done);reject(new Error('ICE gathering timed out'))},5000);peer.addEventListener('icegatheringstatechange',done);done()});return peer.localDescription.toJSON()};
    });
   }
   const [sender,receiver]=pages;
   await sender.locator('#payload').setInputFiles(source);await sender.evaluate(async()=>{window.payload=new Uint8Array(await document.getElementById('payload').files[0].arrayBuffer())});
   const offer=await sender.evaluate(async()=>gather(await peer.createOffer()));
   const answer=await receiver.evaluate(async offer=>{await peer.setRemoteDescription(offer);return gather(await peer.createAnswer())},offer);await sender.evaluate(answer=>peer.setRemoteDescription(answer),answer);
   await Promise.all(pages.map(page=>page.evaluate(()=>ready)));
   await receiver.evaluate(bytes=>{window.chunks=[];window.received=0;window.delivery=[];window.receiveStarted=performance.now();window.complete=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('payload timed out')),60000);channel.addEventListener('message',event=>{const chunk=new Uint8Array(event.data);chunks.push(chunk);received+=chunk.length;if(delivery.length===0||received===bytes||Math.floor(received/(4*1048576))>Math.floor((received-chunk.length)/(4*1048576)))delivery.push({bytes:received,at:performance.now()-receiveStarted});if(received>bytes){clearTimeout(timer);reject(new Error('too many bytes'))}if(received===bytes){clearTimeout(timer);resolve()}})});complete.catch(()=>{})},payload.length);
   const readyStarted=performance.now();
   if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));
   const started=performance.now();
   const sending=sender.evaluate(async pieceBytes=>{let maxBuffered=0,polls=0;for(let at=0;at<payload.length;at+=pieceBytes){const chunk=payload.subarray(at,at+pieceBytes);while(channel.bufferedAmount+chunk.length>4*1048576){if(channel.readyState!=='open')throw new Error('channel closed');polls++;await new Promise(resolve=>setTimeout(resolve,10))}channel.send(chunk);maxBuffered=Math.max(maxBuffered,channel.bufferedAmount)}return {maxBuffered,polls}},pieceBytes);
   const [,senderStats]=await Promise.all([receiver.evaluate(()=>complete),sending]);const milliseconds=performance.now()-started,includingDelayMs=performance.now()-readyStarted;
   const checksum=await receiver.evaluate(async()=>{const merged=new Uint8Array(received);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.length}const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',merged))].map(byte=>byte.toString(16).padStart(2,'0')).join('');return {bytes:received,hash,delivery}});
   const route=await sender.evaluate(async()=>{const stats=await peer.getStats(),transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId),pair=transport&&stats.get(transport.selectedCandidatePairId);if(!pair)return null;const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);return {localType:local?.candidateType,remoteType:remote?.candidateType,protocol:local?.protocol,sameAddress:typeof local?.address==='string'&&typeof remote?.address==='string'?local.address===remote.address:null,currentRoundTripTime:pair.currentRoundTripTime,availableOutgoingBitrate:pair.availableOutgoingBitrate}});
   assert.equal(checksum.bytes,payload.length);assert.equal(checksum.hash,expected);assert.ok(senderStats.maxBuffered<=4*1048576);
   report.rows.push({run,pieceBytes,delayMs,milliseconds,includingDelayMs,...checksum,senderStats,route,ok:true});await writeFile(output,JSON.stringify(report,null,2));console.error(pieceBytes+'/'+delayMs+' #'+(run+1)+': '+milliseconds.toFixed(1)+'ms');
  }finally{for(const context of contexts)await context.close()}
 }
}catch(error){report.error=error.stack;process.exitCode=1}
finally{await browser?.close();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
