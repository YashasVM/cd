import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const host='yvm@192.168.1.8', remote='cd-bench-20261020', work=mkdtempSync(tmpdir()+'/cd-lan-bench-');
const payload=randomBytes(64*1024*1024), hash=createHash('sha256').update(payload).digest('hex');
writeFileSync(work+'/payload.bin',payload);
function child(cmd,args,env=process.env){const p=spawn(cmd,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(Error('timeout '+cmd))},180000);p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(cmd+' exit '+code+' '+stderr))});});done.catch(()=>{});return {p,done,get stdout(){return stdout},get stderr(){return stderr}}}
const trials=[];
try{for(let run=0;run<3;run++)for(const mode of ['cdx','croc','croc-no-compress']){
execFileSync('ssh',[host,`mkdir -p ~/${remote}/out; rm -f ~/${remote}/out/payload.bin`]);
const code=`bench-${process.pid}-${run}-${mode}`, flags=['--disable-clipboard','--yes','--overwrite',...(mode==='croc-no-compress'?['--no-compress']:[])];
const begin=performance.now();const sender=mode==='cdx'?child('/tmp/cdx-bench-current',['send','--wait',work+'/payload.bin'],{...process.env,CD_TRANSPORT_REPORT:'1'}):child('croc',[...flags,'send',work+'/payload.bin'],{...process.env,CROC_SECRET:code});
try{let share;while(!share){share=mode==='cdx'?sender.stdout.match(/^(\d{4,5})\s*$/m)?.[1]:/Code is:/.test(sender.stdout+sender.stderr)?code:undefined;if(performance.now()-begin>30000)throw Error('sender readiness timeout '+sender.stderr);await new Promise(r=>setTimeout(r,5));}
const start=performance.now();const cmd=mode==='cdx'?`CD_TRANSPORT_REPORT=1 ~/${remote}/cdx receive ${share} --out ~/${remote}/out`:`CROC_SECRET=${code} ~/${remote}/croc ${flags.join(' ')} --out ~/${remote}/out`;
const receiver=child('ssh',[host,cmd]);await receiver.done;const seconds=(performance.now()-start)/1000;await sender.done;
const actual=execFileSync('ssh',[host,`sha256sum ~/${remote}/out/payload.bin`],{encoding:'utf8'}).split(' ')[0];if(actual!==hash)throw Error('SHA mismatch');
const reports=(sender.stderr+receiver.stderr).split('\n').flatMap(l=>{try{const x=JSON.parse(l);return x.transport?[x]:[]}catch{return []}});
const t={mode,run,seconds,mibPerSecond:64/seconds,readinessSeconds:(start-begin)/1000,sha256Verified:true,reports};trials.push(t);console.error(JSON.stringify(t));
}finally{sender.p.kill();}}
console.log(JSON.stringify({date:new Date().toISOString(),mib:64,runs:3,route:'PC to Ubuntu 192.168.1.8 over LAN; default public rendezvous for both tools; receiver timing includes SSH launch; identical croc 10.7.0 binary at both ends',trials},null,2));
}finally{rmSync(work,{recursive:true,force:true});execFileSync('ssh',[host,`rm -f ~/${remote}/out/payload.bin`]);}
