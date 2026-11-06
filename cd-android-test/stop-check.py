import os,subprocess,time,json,re
adb=['/home/yvm/Android/Sdk/platform-tools/adb','-s','emulator-5554']
agent=['/home/yvm/.t3/userdata/device/bin/agent-device']
flags=['--platform','android','--serial','emulator-5554','--config','/home/yvm/.t3/userdata/device/hosts/25bf8e1a2393f1108d37029b.json','--session','t3-6a2e1bffdf00567f0d1eb987']
env=dict(os.environ,CD_DEVICE_DIR='/tmp/cd-android-test/devices',CD_STATE_DIR='/tmp/cd-android-test/state',CD_RELAY_URL='ws://127.0.0.1:8795/ws/v1',CD_PUBLIC_URL='http://127.0.0.1:8795',CD_DEVICE_LISTEN='0.0.0.0:8796',CD_DEVICE_ADVERTISE_HOST='10.0.2.2')
source='/tmp/cd-android-test/stop-reviewed.bin'
if not os.path.exists(source):
 with open(source,'wb') as f:
  for _ in range(256): f.write(os.urandom(1048576))
logpath='/tmp/cd-android-test/stop-reviewed.log'
log=open(logpath,'w')
child=subprocess.Popen(['/tmp/cdx-android-dev','send','--to','phone','--json',source],env=env,stdout=log,stderr=subprocess.STDOUT)
def partial():
 listing=subprocess.run(adb+['shell','run-as','in.yash0.cd','ls','-l','files'],capture_output=True,text=True).stdout
 return [line.split() for line in listing.splitlines() if line.endswith('.part')]
try:
 for _ in range(600):
  text=open(logpath).read()
  match=re.search(r'"transferId":"([^"]+)"',text)
  files=[f for f in partial() if match and f[-1]=='resume-'+match[1]+'.part']
  if files and int(files[0][4])>=1048576:break
  assert child.poll() is None,'transfer completed before Stop test'
  time.sleep(.05)
 else:raise RuntimeError('no checkpoint before Stop')
 snap=subprocess.run(agent+['snapshot','-i']+flags,capture_output=True,text=True,check=True).stdout
 stop=re.search(r'(@e\d+) \[group\] \"Stop\"',snap)
 assert stop, 'Stop control missing: '+snap
 result=subprocess.run(agent+['click',stop[1]]+flags,capture_output=True,text=True)
 assert result.returncode==0,result.stderr
 time.sleep(1)
 first=partial()
 assert first,'Stop unexpectedly discarded staging'
 a={v[-1]:int(v[4]) for v in first}
 time.sleep(2)
 b={v[-1]:int(v[4]) for v in partial()}
 assert a==b,(a,b)
 destination=subprocess.run(adb+['shell','ls','/sdcard/Download/CD/stop-reviewed.bin'],capture_output=True)
 assert destination.returncode!=0,'paused transfer was published'
 assert child.wait(timeout=15)!=0,'Stop should report paused, not success'
 print('Verified UI Stop retained staging, halted writes, prevented publication, and stopped the CLI retry loop.',flush=True)
finally:
 if child.poll() is None:child.terminate()
 child.wait(timeout=15);log.close()
