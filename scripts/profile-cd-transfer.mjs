// Diagnostic only: Go test profiling adds overhead, so these are not speed gates.
// go test -tags cdprofile -c -o /tmp/cdx-profile ./cmd/cdx
// node scripts/profile-cd-transfer.mjs /tmp/cdx-profile /tmp/cd-profiles
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliEnv,startWorker,stopChild,childExit,captureOutput} from './harness.mjs';
const executable=resolve(process.argv[2]||'/tmp/cdx-profile');
const output=resolve(process.argv[3]||'/tmp/cd-profiles');
await mkdir(output,{recursive:true});
const work=await mkdtemp('/dev/shm/cd-profile-');
let worker,sender,receiver,sent,received;
try{
 process.env.CD_VERIFY_WRANGLER_CONFIG=fileURLToPath(new URL('./bench-worker.wrangler.jsonc',import.meta.url));
 worker=await startWorker(work);
 const mib=Number(process.env.CD_PROFILE_MIB||1024),file=await open(join(work,'payload.bin'),'w');
 try{for(let i=0;i<mib;i++)await file.write(randomBytes(1024*1024));}finally{await file.close();}
 const expected=await hash(join(work,'payload.bin'));
 const env=cliEnv(worker,{CD_DIRECT:'0',CD_TRANSPORT_REPORT:'1',CD_STATE_DIR:join(work,'state')});
 const profileCPU=process.env.CD_PROFILE_CPU!=='0';
 const launch=(role,args)=>spawn(executable,['-test.run=^TestProfileCLI$',...(profileCPU?[`-test.cpuprofile=${join(output,role+'.cpu')}`]:[]),`-test.memprofile=${join(output,role+'.heap')}`,'-test.memprofilerate=65536'],{env:{...env,CD_PROFILE_ARGS:JSON.stringify(args)},stdio:['ignore','pipe','pipe']});
 sender=launch('sender',['send','--wait',join(work,'payload.bin')]);sent=captureOutput(sender);const senderExit=childExit(sender,180000);senderExit.catch(()=>{});
 const deadline=Date.now()+30000;let code;
 while(!code){code=sent.stdout.match(/^(\d{4,5})\s*$/m)?.[1];if(Date.now()>deadline||sender.exitCode!==null)throw Error('sender not ready '+sent.stderr);await new Promise(r=>setTimeout(r,5));}
 await mkdir(join(work,'out'));
 receiver=launch('receiver',['receive',code,'--out',join(work,'out')]);received=captureOutput(receiver);
 assert.equal(await childExit(receiver,180000),0,received.stderr);assert.equal(await senderExit,0,sent.stderr);
 assert.equal(await hash(join(work,'out/payload.bin')),expected);
 await writeFile(join(output,'diagnostics.json'),JSON.stringify({mib,profileCPU,sha256:expected,sender:sent.stderr,receiver:received.stderr,note:'Instrumented profiles; not benchmark timings.'},null,2));
 console.log(JSON.stringify({output,mib,sha256Verified:true}));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:error.stack,sender:{stdout:sent?.stdout,stderr:sent?.stderr,exitCode:sender?.exitCode,signal:sender?.signalCode},receiver:{stdout:received?.stdout,stderr:received?.stderr,exitCode:receiver?.exitCode,signal:receiver?.signalCode}},null,2));throw error;}finally{await stopChild(sender);await stopChild(receiver);await worker?.stop();await rm(work,{recursive:true,force:true});}
async function hash(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
