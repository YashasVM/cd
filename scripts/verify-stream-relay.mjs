// Opt-in standard WebSocket relay experiment. Uses the actual Worker runtime.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWorker,cliEnv,firstLine,captureOutput,childExit,stopChild} from './harness.mjs';
const work=await mkdtemp(join(tmpdir(),'cd-stream-verify-'));
const sockets=[],children=[];
let worker;
const token=()=>randomBytes(32).toString('base64url');
const protocol='cd-transfer-v1';
const credentials=()=>{const receiverToken=token();return {receiverToken,receiverTokenHash:createHash('sha256').update(Buffer.from(receiverToken,'base64url')).digest('base64url')};};
function client(url){
 const socket=new WebSocket(url);socket.binaryType='arraybuffer';sockets.push(socket);
 const events=[],waiters=[];
 const push=value=>{events.push(value);for(const wake of waiters.splice(0))wake();};
 socket.addEventListener('message',event=>push(typeof event.data==='string'?JSON.parse(event.data):new Uint8Array(event.data)));
 socket.addEventListener('close',event=>push({close:event.code}));
 socket.addEventListener('error',()=>push({error:true}));
 return {socket,opened:new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});}),
 async next(predicate=()=>true,ms=15000){const deadline=Date.now()+ms;for(;;){const index=events.findIndex(predicate);if(index>=0)return events.splice(index,1)[0];const remaining=deadline-Date.now();assert.ok(remaining>0,'timed out waiting for socket event');await new Promise(resolve=>{const timer=setTimeout(resolve,remaining);waiters.push(()=>{clearTimeout(timer);resolve();});});}},
 send(value){socket.send(typeof value==='object'&&!(value instanceof Uint8Array)?JSON.stringify(value):value);}};
}
const isType=type=>event=>event.type===type;
const isClose=event=>event.close!==undefined;
async function connect(url){const value=client(url);await value.opened;return value;}
async function sender(url,c){const value=await connect(url);value.send({type:'join',protocol,role:'sender',receiverTokenHash:c.receiverTokenHash});await value.next(isType('accepted'));return value;}
async function receiver(url,c){const value=await connect(url);value.send({type:'join',protocol,role:'receiver',receiverToken:c.receiverToken});return value;}
try{
 process.env.CD_VERIFY_WRANGLER_CONFIG=process.env.CD_STREAM_CONFIG||fileURLToPath(new URL('./bench-worker-stream.wrangler.jsonc',import.meta.url));
 worker=await startWorker(work);
 const roomCap=`${worker.relayBase}/${randomBytes(16).toString('base64url')}?stream=1`;
 const room=()=>`${worker.relayBase}/${randomBytes(16).toString('base64url')}`;
 for(const [senderMode,receiverMode] of [['1','1'],['1','0'],['0','1'],['1',null]]){
  const base=room(),c=credentials(),s=await sender(`${base}?stream=${senderMode}`,c);
  const r=await receiver(base+(receiverMode===null?'':`?stream=${receiverMode}`),c);
  await r.next(isType('accepted'));await r.next(isType('peer-joined'));await s.next(isType('peer-joined'));
  const bytes=randomBytes(768*1024);s.send(bytes);assert.deepEqual(Buffer.from(await r.next(e=>e instanceof Uint8Array)),bytes);
  r.send(Uint8Array.of(7,9,11));assert.deepEqual(await s.next(e=>e instanceof Uint8Array),Uint8Array.of(7,9,11));
  s.socket.close(1000,'verified');assert.equal((await r.next(isClose)).close,4404);
 }
 {
  const base=room(),c=credentials(),s=await sender(base+'?stream=1',c);
  const bad=await receiver(base+'?stream=1',credentials());assert.equal((await bad.next(isClose)).close,4401);
  const duplicate=await connect(base+'?stream=1');duplicate.send({type:'join',protocol,role:'sender',receiverTokenHash:c.receiverTokenHash});assert.equal((await duplicate.next(isClose)).close,4409);
  const r1=await connect(base+'?stream=1'),r2=await connect(base+'?stream=0');
  const admission={type:'join',protocol,role:'receiver',receiverToken:c.receiverToken};r1.send(admission);r2.send(admission);
  const first=await r1.next(e=>e.type==='accepted'||e.close!==undefined),second=await r2.next(e=>e.type==='accepted'||e.close!==undefined);
  assert.equal([first,second].filter(e=>e.type==='accepted').length,1);assert.equal([first,second].filter(e=>e.close===4409).length,1);
  s.socket.close(1000,'done');
 }
 {
  const base=room(),c=credentials(),s=await sender(base+'?stream=1',c),r=await receiver(base+'?stream=1',c);
  await r.next(isType('accepted'));await s.next(isType('peer-joined'));
  s.send(new Uint8Array(1024*1024+1));assert.equal((await s.next(isClose)).close,4403);assert.equal((await r.next(isClose)).close,4404);
 }
 {
  const base=room(),c=credentials(),pending=await connect(base+'?stream=1');
  const value={type:'join',protocol,role:'sender',receiverTokenHash:c.receiverTokenHash};pending.send(value);pending.send(value);
  assert.ok([4406,4400].includes((await pending.next(isClose)).close));
 }
 if(process.env.CD_STREAM_SKIP_EXPIRY!=='1'){
  const pending=await connect(room()+'?stream=1');assert.equal((await pending.next(isClose,30000)).close,4408);
 }
 {
  const pending=await Promise.all(Array.from({length:4},()=>connect(roomCap)));
  const denied=client(roomCap);await assert.rejects(denied.opened);
  for(const value of pending)value.socket.close();
 }
 const payload=randomBytes(1536*1024+17),source=join(work,'payload.bin');await writeFile(source,payload);
 for(const [senderBinary,receiverBinary] of [['/tmp/cd-speed-stream-candidate','/tmp/cd-speed-goal-candidate'],['/tmp/cd-speed-goal-candidate','/tmp/cd-speed-stream-candidate']]){
  const launch=(binary,args)=>{const child=spawn(binary,args,{env:cliEnv(worker,{CD_DIRECT:'0',CD_RELAY_STREAMING:binary.includes('-stream-')?'1':'0'}),stdio:['ignore','pipe','pipe']});children.push(child);return child;};
  const s=launch(senderBinary,['send','--wait','--link',source]),sent=captureOutput(s),sendExit=childExit(s);sendExit.catch(()=>{});
  const invitation=await firstLine(s.stdout),out=join(work,randomBytes(8).toString('hex'));
  const r=launch(receiverBinary,['receive',invitation,'--out',out]),received=captureOutput(r);
  assert.equal(await childExit(r),0,received.stderr);assert.equal(await sendExit,0,sent.stderr);assert.deepEqual(await readFile(out),payload);
 }
 console.log(`verified streaming, automatic receiver mode, both mixed directions, payload bytes, receiver admission race, duplicate sender, unauthorized receiver, repeated join, oversized record, close propagation, ${process.env.CD_STREAM_SKIP_EXPIRY==='1'?'pending expiry skipped':'pending expiry'}, connection cap, and both CLI version directions`);
}finally{for(const child of children)await stopChild(child);for(const socket of sockets){try{socket.close();}catch{}}await worker?.stop();await rm(work,{recursive:true,force:true});}
