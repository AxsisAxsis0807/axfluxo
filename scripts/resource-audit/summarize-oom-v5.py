#!/usr/bin/env python3
"""Compact, auditable v5 measurements. No RSS/cgroup addition; raw logs stay ignored."""
import hashlib,json
from pathlib import Path
root=Path('work/av-oom-v5'); dest=Path('docs/unified-worker/evidence/av-oom-v5')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def rows(p): return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
def kv(s): return {k:int(v) for k,v in (l.split() for l in s.splitlines())}
build=json.loads((dest/'build.json').read_text()); results=[]
for d in sorted(root.iterdir()):
 if not (d/'case.json').exists(): continue
 r=json.loads((d/'case.json').read_text());r['caseEvidence']={f.name:{'bytes':f.stat().st_size,'sha256':sha(f)} for f in [d/'case.json',d/'container.log'] if f.exists()}; directory=d/'work/result'; sp=directory/'summary.json'
 if not sp.exists(): continue
 s=json.loads(sp.read_text()); r['summary']=s
 args=r['arguments']; r['bundleSha256']=build['bundles'][args['image'].split(':')[-1]]
 r['input']=json.loads((directory/'input.json').read_text()) if (directory/'input.json').exists() else None
 r['outputValidation']=json.loads((directory/'result.json').read_text()) if (directory/'result.json').exists() else None
 r['segments']=rows(directory/'segments.jsonl'); r['argv']=rows(directory/'argv-v4.jsonl'); r['stages']=rows(directory/'stages.jsonl')
 b=s['cgroupBefore'];a=s['cgroupAfter']; r['eventsDelta']={k:kv(a['memory.events'])[k]-v for k,v in kv(b['memory.events']).items()}
 r['cgroupCpuSeconds']=(kv(a['cpu.stat'])['usage_usec']-kv(b['cpu.stat'])['usage_usec'])/1e6
 r['classification']='COMPLETE' if r['status']=='COMPLETED' else 'FAILED'
 if not r['input'] and not args.get('phase'): r['classification']='INVALID_SETUP'
 if args.get('phase'):
  r['input']=json.loads((d/'phase-input.json').read_text())
  if r['status']=='COMPLETED':r['classification']='PHASE_COMPLETE'
 node=rows(directory/'node.jsonl'); r['staticUseCount']=sum(x.get('branch')=='static-use' for x in node)
 r['staticOnGate']='VALID' if args['static']=='true' and r['staticUseCount'] else 'INVALID_NO_STATIC' if args['static']=='true' else 'OFF'
 begins=[x for x in r['segments'] if x['event']=='begin'];encoded={x['segment'] for x in r['segments'] if x['event']=='encoded'}
 r['segmentStatus']=[{'segment':x['segment'],'version':x['version'],'status':'VALIDATED' if (i<len(begins)-1 or r['status']=='COMPLETED' or any(t['name']=='concat-audio-mux' for t in r['stages'])) and x['segment'] in encoded else 'ENCODED_VALIDATION_OR_LATER_UNCERTAIN' if x['segment'] in encoded else 'FAILED_PREPARE_OR_ENCODE'} for i,x in enumerate(begins)]
 r['rawFiles']={str(f.relative_to(directory)):{'bytes':f.stat().st_size,'sha256':sha(f)} for f in directory.rglob('*') if f.is_file()}
 r['phasePeaks']=[]; samples=rows(directory/'samples.jsonl')
 if samples:
  m=max(samples,key=lambda x:int(x['cgroup']['memory.current']))
  r['maximumSample']={'t':m['t'],'current':int(m['cgroup']['memory.current']),'stat':kv(m['cgroup']['memory.stat']),'processes':m['processes']}
  life={}
  for x in samples:
   for p in x['processes']:
    v=life.setdefault(str(p['pid']),{'kind':p['kind'],'first':x['t'],'last':x['t'],'rss':0,'pss':0,'uss':0})
    v['last']=x['t']
    for key in ['rss','pss','uss']:v[key]=max(v[key],p[key])
  r['sampledProcessLifetimes']=life
  for event in r['argv']:
   if event['event']!='spawn': continue
   pid=event['pid']; ss=[x for x in samples if any(p['pid']==pid for p in x['processes'])]
   if not ss: continue
   m=max(ss,key=lambda x:int(x['cgroup']['memory.current']))
   r['phasePeaks'].append({'pid':pid,'program':event['program'],'output':event['args'][-1],'sampleTime':m['t'],'current':int(m['cgroup']['memory.current']),'stat':{k:v for k,v in kv(m['cgroup']['memory.stat']).items() if k in ['anon','file','kernel','anon_thp','file_dirty','file_writeback']},'processes':m['processes']})
 # Keep argv and close status; stderr remains hashed raw, except failure tail.
 for event in r['argv']:
  tail=event.pop('stderrTail',None)
  if tail and event.get('event')=='close' and (event.get('code')!=0 or event.get('signal')): event['failureTail']=tail[-1200:]
 r.pop('archiveFiles',None)
 results.append(r)
(dest/'measurements.json').write_text(json.dumps({'schema':5,'cases':results},separators=(',',':'))+'\n')
header='| case | CPU | memory.max B | peak B | Δmax/oom/kill | result / static | last encoded / failed begin | wall / cgroup CPU s | disk logical peak B | input / code / image SHA |\n|---|---:|---:|---:|---|---|---|---|---:|---|\n'
lines=[]
for r in results:
 s=r['summary']; e=r['eventsDelta']; seg=r['segments']; encoded=[x['segment'] for x in seg if x['event']=='encoded']; begun=[x['segment'] for x in seg if x['event']=='begin']; fail=next((i for i in begun if i not in encoded),None)
 lines.append('| '+ ' | '.join(map(str,[r['label'],r['arguments']['cpu'],s['cgroupAfter']['memory.max'],s['cgroupAfter']['memory.peak'],f"{e['max']}/{e['oom']}/{e['oom_kill']}",r['classification']+'/'+r['staticOnGate'],f"{max(encoded) if encoded else '—'} / {fail if fail is not None else '—'}",f"{s['wallSeconds']:.3f} / {r['cgroupCpuSeconds']:.3f}",s['peaks']['disk'],f"{(r['input'] or {}).get('coverHash','—')[:8]},{(r['input'] or {}).get('hash','—')[:8]} / {r['bundleSha256'][:12]} / {r['image'].split(':')[-1][:12]}"]))+' |')
(dest/'RESULTS.md').write_text('# v5 executed cases\n\nAll rows n=1; repeats have distinct labels. CPU 0.5 unless shown otherwise; swap 0, network none. Input column: cover/source media SHA prefixes, then bundle/image ID prefixes. Full SHA, source audio/video hash, flags, argv, PID lifetimes and phase attribution: measurements.json; immutable image mapping: images.json; audio: inputs.json. Disk is sampled logical bytes including logs, not allocated blocks. No cold-cache claim.\n\n'+header+'\n'.join(lines)+'\n')
print('\n'.join(lines))
