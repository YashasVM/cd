from e2e import adb,ADB,W
import subprocess,xml.etree.ElementTree as E,re,sys,time
adb('shell','uiautomator','dump','/sdcard/cd-window.xml')
subprocess.check_call(ADB+['pull','/sdcard/cd-window.xml',str(W/'window.xml')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
nodes=list(E.parse(W/'window.xml').iter('node'))
if len(sys.argv)==1:
 for n in nodes:
  text=n.get('text','')
  if text: print(text if len(text)<120 else text[:40]+'...', n.get('bounds'))
else:
 matches=[n for n in nodes if n.get('text')==sys.argv[1]]
 if not matches: raise SystemExit('Text not found: '+sys.argv[1])
 b=list(map(int,re.findall(r'\d+',matches[0].get('bounds'))))
 adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
 print('Tapped',sys.argv[1])
