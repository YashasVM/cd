import json,subprocess
from pathlib import Path
j=json.loads(Path('/home/yvm/code/cd-aw-recv/work/emu-pair.jsonl').read_text().splitlines()[0])
subprocess.run(['/home/yvm/Android/Sdk/platform-tools/adb','-s','emulator-5554','shell','am','start','--user','0','-a','android.intent.action.VIEW','-d',j['qr'],'in.yash0.cd'],stdout=subprocess.DEVNULL)
