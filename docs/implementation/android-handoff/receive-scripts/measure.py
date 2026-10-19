from pathlib import Path
import subprocess,time,json,sys,hashlib,os
from e2e import ENV,ADB,W
label=sys.argv[1]
route=sys.argv[2] if len(sys.argv)>2 else 'relay'
source=W/(label+'.bin')
if not source.exists(): source.symlink_to('cd-recv-256.bin')
env=dict(ENV,CD_DIRECT='1' if route=='direct' else '0',CD_DEVICE_LAN='1' if route=='lan' else '0')
start=time.monotonic()
p=subprocess.Popen([str(W/'cdx-recv'),'send','--to','recv-emu','--json','--progress',str(source)],env=env,stdout=open(W/(label+'.jsonl'),'w'),stderr=open(W/(label+'.err'),'w'))
try: code=p.wait(timeout=600)
except subprocess.TimeoutExpired: p.terminate();code=p.wait()
elapsed=time.monotonic()-start
subprocess.run(ADB+['logcat','-d','-s','CD:I'],stdout=open(W/(label+'.android.log'),'w'))
root=None
phases=[]
for l in (W/(label+'.jsonl')).read_text().splitlines():
 try: j=json.loads(l)
 except json.JSONDecodeError:continue
 root=j.get('transferId',root)
 phases.append({k:v for k,v in j.items() if k in ['phase','route','network','transport','transferId']})
print(json.dumps(dict(label=label,exit=code,seconds=round(elapsed,3),MBpsEndToEnd=round(source.stat().st_size/elapsed/1e6,3),events=phases)))
if code==0:
 result=subprocess.check_output(ADB+['shell','sha256sum','/sdcard/Download/CD/'+label+'.bin'],text=True)
 expected=hashlib.sha256(source.read_bytes()).hexdigest()
 assert result.split()[0]==expected,result
 print('SHA256 MATCH',expected)
(W/(label+'.result.json')).write_text(json.dumps(dict(label=label,exit=code,seconds=elapsed,phases=phases),indent=2))
sys.exit(code)
