from pathlib import Path
import shutil,sys
w=Path(__file__).parent
src=w.parent/'android/app/src/main/java/in/yash0/cd'
original=w/'cd-recv-original/cd'
backup=w/'optimized-src'
changed=[p.name for p in original.glob('*.kt') if (src/p.name).exists() and p.read_bytes()!=(src/p.name).read_bytes()]
if sys.argv[1]=='baseline':
 backup.mkdir(exist_ok=True)
 for name in changed:
  shutil.copy2(src/name,backup/name);shutil.copy2(original/name,src/name)
 for name in ['ReceiveViews.kt','ReceiverNetwork.kt']:
  shutil.move(str(src/name),str(backup/name))
 print('temporary baseline:',','.join(changed))
else:
 for p in backup.glob('*.kt'): shutil.copy2(p,src/p.name)
 print('restored optimized sources')
