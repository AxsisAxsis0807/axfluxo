#!/usr/bin/env python3
"""Audit evidence invariants; never turn incomplete qualification into PASS."""
import hashlib,json,subprocess
from pathlib import Path
root=Path('docs/unified-worker/evidence/av-oom-v5'); m=json.loads((root/'measurements.json').read_text());errors=[];warnings=[]
def need(condition,msg):
 if not condition:errors.append(msg)
images=json.loads((root/'images.json').read_text())
for r in m['cases']:
 label=r['label'];s=r['summary'];a=s['cgroupAfter'];args=r['arguments']
 actual=int(a['memory.max']);expected=args['memory']//4096*4096
 need(actual==expected,label+': actual memory limit')
 need(a['cpu.max']==('50000 100000' if args['cpu']=='0.5' else '100000 100000'),label+': CPU quota')
 need(a['memory.swap.max']=='0' and a['memory.swap.current']=='0',label+': swap')
 need(int(a['memory.peak'])<=actual,label+': kernel peak limit')
 if r['classification'] in ['COMPLETE','PHASE_COMPLETE']:need(r['eventsDelta']['oom']==0 and r['eventsDelta']['oom_kill']==0,label+': completed but OOM')
 if r['staticOnGate']=='INVALID_NO_STATIC':warnings.append(label+': INVALID for static ON qualification')
 for event in r['argv']:
  argv=event.get('args',[])
  if event.get('event')=='spawn' and event.get('program')=='ffmpeg' and argv and '/segment-' in argv[-1] and 'libx264' in argv:
   for option,value in [('-threads:v','2'),('-preset','medium'),('-crf','18'),('-r:v','60')]:
    need(option in argv and argv[argv.index(option)+1]==value,label+': fixed encoder '+option)
   need('-x264-params' not in argv,label+': no low-lookahead override')
  if event.get('event')=='spawn' and event.get('program')=='ffmpeg' and argv and argv[-1].endswith('/candidate.mp4') and '-c:a' in argv and argv[argv.index('-c:a')+1]=='aac':
   for option,value in [('-b:a','320k'),('-ar','48000')]:need(option in argv and argv[argv.index(option)+1]==value,label+': fixed audio '+option)
 if r.get('outputValidation') and not args.get('phase'):
  v=r['outputValidation'];need(v['width']==1920 and v['height']==1080 and v['fps']==60 and v['frames']==args['seconds']*60,label+': final output contract')
 if r['classification']!='INVALID_SETUP':need(images[args['image'].split(':')[-1]]['Id']==r['image'],label+': immutable image ID')
 if r['classification']=='INVALID_SETUP':warnings.append(label+': excluded setup failure')
 hc=r.get('hostConfig')
 if hc:
  need(hc['NetworkMode']=='none' and hc['CapDrop']==['ALL'],label+': isolation')
  need(hc['MemorySwap']==hc['Memory'],label+': swap request')
  need('no-new-privileges:true' in hc['SecurityOpt'],label+': privilege')
 if r['eventsDelta']['max'] or int(a['memory.peak'])>=actual*.98:warnings.append(label+': memory pressure / near-cap display alert (98% heuristic, NOT a release threshold)')
 for relative,item in r['rawFiles'].items():
  p=Path('work/av-oom-v5')/label/'work/result'/relative
  need(p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'],label+': raw SHA '+relative)
# No production source change, no replacement of historical documentation.
changed=subprocess.check_output(['git','diff','--name-only','de971898af831156c17db09090fa5fd57e52c8f1'],text=True).splitlines()
need(not any(p.startswith(('src/','server/worker/','server/db/','server/api/','infra/')) for p in changed),'production source delta')
need(not any('/av-fade-v4/' in p or p.endswith('_V4.md') for p in changed),'historical evidence delta')
result={'status':'PASS' if not errors else 'FAIL','scope':'evidence consistency only; qualification/production remain separate','caseCount':len(m['cases']),'errors':errors,'warnings':warnings}
(root/'verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(bool(errors))
