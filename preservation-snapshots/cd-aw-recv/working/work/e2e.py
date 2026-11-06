#!/usr/bin/env python3
import subprocess,os,json,time,pathlib,sys
W=pathlib.Path(__file__).parent
ADB=['/home/yvm/Android/Sdk/platform-tools/adb','-s','emulator-5554']
ENV=dict(os.environ,XDG_CONFIG_HOME=str(W/'emu-config'),CD_STATE_DIR=str(W/'emu-state'),CD_RELAY_URL='ws://127.0.0.1:8787/ws/v1',CD_PUBLIC_URL='http://127.0.0.1:8787',CD_DEVICE_ADVERTISE_HOST='10.0.2.2')
def adb(*args): return subprocess.check_output(ADB+list(args),text=True)
def send(label,lan=False,direct=False):
 env=dict(ENV,CD_DEVICE_LAN='1' if lan else '0',CD_DIRECT='1' if direct else '0')
 source=W/(label+'.bin')
 if not source.exists(): source.symlink_to('cd-recv-256.bin')
 return subprocess.Popen([str(W/'cdx-recv'),'send','--to','recv-emu','--json','--progress',str(source)],env=env,stdout=open(W/(label+'.jsonl'),'w'),stderr=open(W/(label+'.err'),'w'))
if __name__=='__main__':
 p=send(sys.argv[1],lan='lan' in sys.argv,direct='direct' in sys.argv)
 start=time.monotonic()
 try: status=p.wait(timeout=180)
 except subprocess.TimeoutExpired: p.terminate();status=p.wait()
 print('status',status,'seconds',time.monotonic()-start)
 print((W/(sys.argv[1]+'.err')).read_text()[-1500:])
 if status==0: print(adb('shell','sha256sum','/sdcard/Download/CD/'+sys.argv[1]+'.bin'))
 sys.exit(status)
