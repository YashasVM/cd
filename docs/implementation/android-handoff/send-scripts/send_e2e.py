import subprocess, time, json, os, hashlib, pathlib, sys
W=pathlib.Path('/home/yvm/code/cd-aw-send/work')
ADB=['/home/yvm/Android/Sdk/platform-tools/adb','-s','emulator-5556']
def adb(*args, **kw):
    return subprocess.run(ADB+list(args), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw).stdout.decode().strip()
def status():
    try: return json.loads(adb('shell','run-as','in.yash0.cd','cat','files/send-test-status.json'))
    except (subprocess.CalledProcessError,ValueError): return {}
def wait_status(predicate, seconds=300):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        s=status()
        if predicate(s): return s
        time.sleep(.25)
    raise RuntimeError('Status timeout '+str(status()))
def instrument(mode, label, direct, id=None):
    adb('shell','run-as','in.yash0.cd','rm','-f','files/send-test-status.json')
    cmd=ADB+['shell','am','instrument','-w','-e','action',mode,'-e','direct',str(direct).lower(),'-e','source','/data/user/0/in.yash0.cd/files/payload.bin']
    if id: cmd += ['-e','id',id]
    out=open(W/f'{label}-instrument.log','w')
    return subprocess.Popen(cmd+['in.yash0.cd.test/in.yash0.cd.SendInstrumentation'],stdout=out,stderr=subprocess.STDOUT)
def receiver(link,label,out):
    env=dict(os.environ,CD_RELAY_URL='ws://127.0.0.1:8788/ws/v1',CD_PUBLIC_URL='http://127.0.0.1:8788')
    log=open(W/f'{label}-receive.log','w')
    return subprocess.Popen([str(W/'cdx-send'),'receive','--json','--progress','--out',str(out),link],cwd=W,env=env,stdout=log,stderr=subprocess.STDOUT)
def verify(out):
    h=hashlib.sha256()
    with open(out,'rb') as f:
        while data:=f.read(1024*1024): h.update(data)
    assert h.hexdigest()==(W/'source.sha256').read_text().strip(), h.hexdigest()
    print('SHA256 OK',h.hexdigest(),flush=True)
def run(label,direct=False,interrupt=False):
    out=W/f'{label}-received.bin'
    app=instrument('start',label,direct)
    ready=wait_status(lambda s:s.get('phase')=='WAITING')
    print(label,'ready',ready['id'],flush=True)
    started=time.monotonic()
    cli=receiver(ready['link'],label,out)
    if interrupt:
        progress=wait_status(lambda s:s.get('done',0)>=16*1024*1024)
        adb('shell','am','force-stop','in.yash0.cd')
        app.wait(timeout=30); cli.wait(timeout=30)
        checkpoints=list(W.glob('*.json'))
        print('interrupted at',progress['done'],'checkpoints', [p.name for p in checkpoints],flush=True)
        time.sleep(1)
        app=instrument('resume',label+'-resume',direct,ready['id'])
        wait_status(lambda s:s.get('phase')=='WAITING')
        cli=receiver(ready['link'],label+'-resume',out)
    cli.wait(timeout=600)
    assert cli.returncode==0, (W/f'{label}{"-resume" if interrupt else ""}-receive.log').read_text()[-3000:]
    result=wait_status(lambda s:s.get('phase')=='COMPLETE',30)
    app.wait(timeout=30)
    verify(out)
    summary=dict(label=label,direct=direct,interrupted=interrupt,result=result,wallSeconds=time.monotonic()-started)
    (W/f'{label}-result.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary),flush=True)
    out.unlink()
if __name__=='__main__':
    label=sys.argv[1]
    run(label,direct='direct' in label,interrupt='resume' in label)
