import os,subprocess,time,json,hashlib
adb='/home/yvm/Android/Sdk/platform-tools/adb'
base=[adb,'-s','emulator-5554']
env=dict(os.environ,CD_DEVICE_DIR='/tmp/cd-android-test/devices',CD_STATE_DIR='/tmp/cd-android-test/state',CD_RELAY_URL='ws://127.0.0.1:8795/ws/v1',CD_PUBLIC_URL='http://127.0.0.1:8795',CD_DEVICE_LISTEN='0.0.0.0:8796',CD_DEVICE_ADVERTISE_HOST='10.0.2.2')
command=['/tmp/cdx-android-dev','send','--to','phone','--json','/tmp/cd-android-test/kill-recovery-final.bin']
log=open('/tmp/cd-android-test/kill-final-first.log','w')
first=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT)
partial=0
for _ in range(200):
 listing=subprocess.run(base+['shell','run-as','in.yash0.cd','ls','-l','files'],capture_output=True,text=True).stdout
 parts=[line.split() for line in listing.splitlines() if line.rstrip().endswith('.part')]
 partial=max([int(fields[4]) for fields in parts] or [0])
 if partial>=1048576:break
 if first.poll() is not None:raise RuntimeError('sender ended before interruption; inspect kill-final-first.log')
 time.sleep(.05)
assert partial>=1048576,'did not observe a retained partial file'
first.terminate();first.wait(timeout=15);log.close()
pid=subprocess.run(base+['shell','pidof','in.yash0.cd'],capture_output=True,text=True).stdout.strip().split()[0]
subprocess.run(base+['shell','run-as','in.yash0.cd','kill','-9',pid],check=True,capture_output=True)
print('Interrupted CLI and killed Android process after retained bytes:',partial,flush=True)
# Run exactly the same command; the persisted intent supplies the original root automatically.
log=open('/tmp/cd-android-test/kill-final-second.log','w')
second=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT)
try:code=second.wait(timeout=180)
except BaseException:second.terminate();raise
finally:log.close()
assert code==0,open('/tmp/cd-android-test/kill-final-second.log').read()
subprocess.run(base+['pull','/sdcard/Download/CD/kill-recovery-final.bin','/tmp/cd-android-test/received-kill-recovery-final.bin'],check=True,capture_output=True)
def digest(path):
 h=hashlib.sha256()
 with open(path,'rb') as source:
  while data:=source.read(1048576):h.update(data)
 return h.hexdigest()
original=digest('/tmp/cd-android-test/kill-recovery-final.bin')
assert digest('/tmp/cd-android-test/received-kill-recovery-final.bin')==original
print('Verified 128MiB recovery after both processes stopped; identical rerun succeeded with SHA256:',original,flush=True)
print(open('/tmp/cd-android-test/kill-final-second.log').read(),flush=True)
