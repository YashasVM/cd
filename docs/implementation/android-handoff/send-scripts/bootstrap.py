import subprocess, time, pathlib
W=pathlib.Path('/home/yvm/code/cd-aw-send/work')
A=['/home/yvm/Android/Sdk/platform-tools/adb','-s','emulator-5556']
def call(*args):
    r=subprocess.run(A+list(args),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
    print(' '.join(args),r.stdout.decode().strip(),flush=True)
    r.check_returncode()
    return r.stdout.decode().strip()
subprocess.run(A+['wait-for-device'],check=True,timeout=180)
deadline=time.monotonic()+180
while time.monotonic()<deadline:
    if subprocess.run(A+['shell','getprop','sys.boot_completed'],stdout=subprocess.PIPE).stdout.strip()==b'1': break
    time.sleep(2)
else: raise RuntimeError('Boot timed out')
call('reverse','tcp:8788','tcp:8788')
call('install','-r',str(W.parent/'android/app/build/outputs/apk/debug/app-debug.apk'))
call('install','-r',str(W.parent/'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'))
call('push',str(W/'payload.bin'),'/data/local/tmp/cd-send-payload.bin')
call('shell','run-as','in.yash0.cd','mkdir','-p','files')
call('shell','run-as','in.yash0.cd','cp','/data/local/tmp/cd-send-payload.bin','files/payload.bin')
call('shell','run-as','in.yash0.cd','sha256sum','files/payload.bin')
call('shell','am','instrument','-w','-e','action','controls','in.yash0.cd.test/in.yash0.cd.SendInstrumentation')
