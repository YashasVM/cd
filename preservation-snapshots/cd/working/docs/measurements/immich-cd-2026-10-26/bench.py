import hashlib,json,os,re,secrets,shlex,struct,subprocess,tempfile,time,zlib
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parent
REMOTE='yvm@192.168.1.9'
LAN='http://192.168.1.9:2286'
R='/home/yvm/immich-cd-bench-20261026'
def ssh(command):
 return subprocess.check_output(['ssh','-o','BatchMode=yes',REMOTE,command],text=True)
def api(path,body,token=None):
 r=requests.post(LAN+'/api'+path,json=body,headers={'Authorization':'Bearer '+token} if token else {},timeout=60)
 assert r.status_code in (200,201),(path,r.status_code,r.text)
 return r.json()
def chunk(k,b): return struct.pack('!I',len(b))+k+b+struct.pack('!I',zlib.crc32(k+b))
def png(width,height):
 raw=b''.join(b'\0'+os.urandom(width*3) for _ in range(height))
 b=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw,1))+chunk(b'IEND',b'')
 assert b[:8]==b'\x89PNG\r\n\x1a\n'
 return b
for attempt in range(60):
 try:
  if requests.get(LAN+'/api/server/version',timeout=2).status_code==200: break
 except requests.RequestException: pass
 time.sleep(1)
else: raise RuntimeError('Immich not ready')
report={'started':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'rows':[],'immichVersion':requests.get(LAN+'/api/server/version',timeout=10).json(),'cdSha256':hashlib.sha256(Path('/tmp/cdx-immich-bench').read_bytes()).hexdigest()}
public=ssh("rg -a -o 'https://[a-z0-9-]+.trycloudflare.com' "+R+'/tunnel.log | head -1').strip()
probe=requests.get(public+'/api/server/version',timeout=20)
assert probe.status_code==200 and probe.json()==report['immichVersion'], 'public route does not reach test Immich'
report['publicImmich']=public
if os.environ.get('BENCH_ROUTES')=='public':
 previous=json.loads((ROOT/'results.json').read_text())
 report['rows']=[r for r in previous['rows'] if r['route']=='lan']
 report['lanStarted']=previous['started']
credential=Path('/tmp/immich-cd-bench-credentials.private')
fresh=not credential.exists()
password=secrets.token_urlsafe(30) if fresh else credential.read_text()
if fresh:
 credential.touch(mode=0o600)
 credential.write_text(password)
 api('/auth/admin-sign-up',{'email':'bench-admin@example.invalid','password':password,'name':'Benchmark'})
token=api('/auth/login',{'email':'bench-admin@example.invalid','password':password})['accessToken']
users={}
for route in ['lan','public']:
 for method in ['immich','bridge']:
  email=f'{route}-{method}@example.invalid'
  if fresh: api('/admin/users',{'email':email,'password':password,'name':email},token)
  users[route,method]=api('/auth/login',{'email':email,'password':password})['accessToken']
# Credentials stay in private temporary files and never enter saved results.
with tempfile.TemporaryDirectory(prefix='immich-cd-bench-') as tmp:
 tmp=Path(tmp)
 auth={}
 for key,t in users.items():
  f=tmp/('-'.join(key)+'.conf'); f.write_text('header = "Authorization: Bearer '+t+'"\n');f.chmod(0o600);auth[key]=f
  if key[1]=='bridge':subprocess.run(['scp','-q',str(f),REMOTE+':'+R+'/'+key[0]+'.conf'],check=True)
 try:
  for route in os.environ.get('BENCH_ROUTES','lan,public').split(','):
   for size,w,h in [('photo',512,512),('large-photo',2048,2048),('large-file',4096,4096)]:
    for trial in range(3):
     payload=png(w,h); path=tmp/'payload.png';path.write_bytes(payload); digest=hashlib.sha256(payload).hexdigest()
     methods=['immich','cd'] if trial%2==0 else ['cd','immich']
     for method in methods:
      row={'route':route,'size':size,'trial':trial+1,'method':method,'bytes':len(payload),'sha256':digest}
      try:
       if method=='immich':
        response=tmp/'response.json'
        args=['curl','--silent','--show-error','--fail-with-body','--max-time','180','--config',str(auth[route,'immich']),'-F','assetData=@'+str(path),'-F','fileCreatedAt=2026-10-26T00:00:00.000Z','-F','fileModifiedAt=2026-10-26T00:00:00.000Z','-o',str(response),'-w','%{time_total}',(LAN if route=='lan' else public)+'/api/assets']
        start=time.monotonic();timing=subprocess.check_output(args,text=True);row['seconds']=time.monotonic()-start;row['httpSeconds']=float(timing)
        result=json.loads(response.read_text());assert result.get('status')=='created',result
        asset=result['id']; user=users[route,'immich']
       else:
        env={**os.environ,'CD_TRANSPORT_REPORT':'1','CD_STATE_DIR':str(tmp/'cd-state'),'CD_DIRECT':'1' if route=='lan' else '0','CD_LAN':'1' if route=='lan' else '0'}
        log=tmp/'sender.log'
        with log.open('w+') as out:
         start=time.monotonic();sender=subprocess.Popen(['/tmp/cdx-immich-bench','send','--wait',str(path)],env=env,stdout=out,stderr=out,text=True)
         try:
          code=None
          for _ in range(600):
           text=log.read_text();match=re.search(r'^\s*(\d{4,5})\s*$',text,re.M)
           if match:code=match[1];break
           assert sender.poll() is None,'sender exited: '+text
           time.sleep(.05)
          assert code,'sender readiness timeout'
          row['readySeconds']=time.monotonic()-start
          outdir=R+f'/receive/{route}-{size}-{trial}'
          command=f'mkdir -p {outdir}; env CD_TRANSPORT_REPORT=1 CD_DIRECT={env["CD_DIRECT"]} CD_LAN={env["CD_LAN"]} CD_STATE_DIR={R}/cd-state {R}/cdx receive {code} --out {outdir}'
          receiveStart=time.monotonic();received=subprocess.run(['ssh',REMOTE,command],capture_output=True,text=True,timeout=180)
          assert received.returncode==0,received.stderr
          sender.wait(timeout=30);assert sender.returncode==0,log.read_text()
          row['seconds']=time.monotonic()-start;row['receiverSeconds']=time.monotonic()-receiveStart
          diagnostics=log.read_text()+'\n'+received.stderr
          row['transport']=[json.loads(line) for line in diagnostics.splitlines() if line.startswith('{') and '"transport"' in line]
          actual=ssh(f'sha256sum {outdir}/payload.png').split()[0];assert actual==digest
          row['verified']=True
          command=f'curl --silent --show-error --fail-with-body --max-time 180 --config {R}/{route}.conf -F assetData=@{outdir}/payload.png -F fileCreatedAt=2026-10-26T00:00:00.000Z -F fileModifiedAt=2026-10-26T00:00:00.000Z http://127.0.0.1:2286/api/assets'
          importStart=time.monotonic();result=json.loads(ssh(command));row['localImportSeconds']=time.monotonic()-importStart
          assert result.get('status')=='created',result
          row['bridgeSeconds']=row['seconds']+row['localImportSeconds'];asset=result['id'];user=users[route,'bridge']
         finally:
          if sender.poll() is None:sender.kill();sender.wait()
       r=requests.get(LAN+'/api/assets/'+asset+'/original',headers={'Authorization':'Bearer '+user},timeout=90)
       assert r.status_code==200 and hashlib.sha256(r.content).hexdigest()==digest,'original mismatch'
       row['verified']=True
      except Exception as e:
       row['error']=str(e)
      report['rows'].append(row);(ROOT/'results.json').write_text(json.dumps(report,indent=2)+'\n')
      print(json.dumps(row),flush=True)
 finally:
  ssh(f'rm -f {R}/lan.conf {R}/public.conf; rm -rf {R}/receive {R}/cd-state')
report['finished']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());(ROOT/'results.json').write_text(json.dumps(report,indent=2)+'\n')
assert all(r.get('verified') and 'error' not in r for r in report['rows']), 'failed samples present'
