#!/usr/bin/env python3
"""Explain B8: compare every pre-x264 filtered frame with 60/300 frame partitions."""
import hashlib,json,re,subprocess,time
from pathlib import Path
root=Path('work/av-oom-v5');out=root/'filter-partition-compare';out.mkdir(exist_ok=False)
results={}
for label in ['B6-off-1GB-r1','B8-300-1GB-r1']:
 d=root/label/'work/result';events=[json.loads(l) for l in (d/'argv-v4.jsonl').read_text().splitlines()]
 calls=[e for e in events if e.get('event')=='spawn' and e.get('program')=='ffmpeg' and re.search(r'/segment-\d+\.mp4$',e['args'][-1]) and 'libx264' in e['args']]
 calls.sort(key=lambda e:int(re.search(r'/segment-(\d+)\.mp4$',e['args'][-1]).group(1)))
 hashes=[];records=[]
 for event in calls:
  original=event['args'];args=[a.replace('/work/result/media/',str((d/'media').resolve())+'/') for a in original[:original.index('-c:v')]]
  args+=['-c:v','rawvideo','-threads:v','1','-f','framehash','-hash','sha256','-']
  started=time.time();data=subprocess.check_output(['ffmpeg',*args]);p=out/(label+'-'+Path(original[-1]).stem+'.framehash');p.write_bytes(data)
  pixels=[line.split(',')[-1].strip() for line in data.decode().splitlines() if line and not line.startswith('#')];hashes+=pixels
  records.append({'sourcePid':event['pid'],'sourceOutput':original[-1],'frames':len(pixels),'raw':str(p),'sha256':hashlib.sha256(data).hexdigest(),'argv':args,'wallSeconds':time.time()-started})
 results[label]={'frames':len(hashes),'pixelSequenceSha256':hashlib.sha256('\n'.join(hashes).encode()).hexdigest(),'hashes':hashes,'segments':records}
a=results['B6-off-1GB-r1'];b=results['B8-300-1GB-r1'];equal=a['hashes']==b['hashes'];first=next((i for i,(x,y) in enumerate(zip(a['hashes'],b['hashes'])) if x!=y),None)
for r in results.values():r.pop('hashes')
r={'status':'PASS_PREENCODE_EXACT' if equal else 'HOLD_PREENCODE_DIFFERENCE','preencodePixelsEqual':equal,'firstDifferentFrame':first,'results':results,'scope':'all 900 filtered pixel frames only; encoder flags removed for raw framehash. Not finished-video quality acceptance.'}
Path('docs/unified-worker/evidence/av-oom-v5/filter-partition-comparison.json').write_text(json.dumps(r,indent=2)+'\n');print(r['status'])
