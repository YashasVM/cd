import json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
r=json.loads((root/'results.json').read_text())
rows=r['rows']; summaries=[]
for route in ['lan','public']:
 for size in ['photo','large-photo','large-file']:
  groups={m:[x for x in rows if x['route']==route and x['size']==size and x['method']==m and 'error' not in x] for m in ['immich','cd']}
  if any(len(g)!=3 for g in groups.values()):continue
  med=lambda method,key:statistics.median(x[key] for x in groups[method])
  n=groups['immich'][0]['bytes'];im=med('immich','seconds');cd=med('cd','seconds');bridge=med('cd','bridgeSeconds')
  assert im>0 and cd>0 and bridge>=cd
  summaries.append({'route':route,'size':size,'MiB':n/1048576,'immichSeconds':im,'cdSeconds':cd,'bridgeSeconds':bridge,'immichMiBs':n/1048576/im,'cdMiBs':n/1048576/cd,'bridgeScoreImmich100':100*im/bridge,'cdSpeedup':im/cd,'bridgeSpeedup':im/bridge,'cdRoutes':[x['transport'] for x in groups['cd']]})
(root/'summary.json').write_text(json.dumps(summaries,indent=2)+'\n')
for x in summaries:print(f"{x['route']:6} {x['size']:12} {x['MiB']:6.2f} MiB | Immich {x['immichSeconds']:6.2f}s {x['immichMiBs']:5.2f} MiB/s | CD {x['cdSeconds']:6.2f}s {x['cdMiBs']:5.2f} MiB/s | bridge {x['bridgeSeconds']:6.2f}s | score {x['bridgeScoreImmich100']:5.1f}/100")
print('Samples:',len(rows),'Failures:',sum('error' in x for x in rows))
