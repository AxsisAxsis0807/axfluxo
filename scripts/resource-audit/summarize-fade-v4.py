#!/usr/bin/env python3
"""Compact v4 evidence; raw samples/media stay in ignored work/."""
import hashlib,json
from pathlib import Path
root=Path('work/av-fade-v4'); dest=Path('docs/unified-worker/evidence/av-fade-v4'); dest.mkdir(parents=True,exist_ok=True)
def rows(p): return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
def kv(s): return {k:int(v) for k,v in (l.split() for l in s.splitlines())}
records=[]
for directory in sorted(root.iterdir()):
 if not (directory/'case.json').exists(): continue
 r=json.loads((directory/'case.json').read_text()); result=directory/'work/result'
 if not (result/'summary.json').exists(): records.append(r); continue
 s=json.loads((result/'summary.json').read_text()); r['summary']=s
 code=directory/'work/baseline.mjs'
 if code.exists(): r['fixtureCodeSha256']=hashlib.sha256(code.read_bytes()).hexdigest()
 elif r['arguments']['image'].endswith('boundary-base'): r['fixtureCodeSha256']=json.loads((dest/'boundary-bundles.json').read_text())['bundles']['base']
 elif r['arguments']['image'].endswith('boundary-B'): r['fixtureCodeSha256']=json.loads((dest/'boundary-bundles.json').read_text())['bundles']['B']
 elif r['arguments']['image'].endswith('candidate-A'): r['fixtureCodeSha256']=json.loads((dest/'candidate-A.json').read_text())['bundleSha256']
 elif r['arguments']['image'].endswith('candidate-B'): r['fixtureCodeSha256']=json.loads((dest/'candidate-B.json').read_text())['bundleSha256']
 else: r['fixtureCodeSha256']='f3d031760b2b5874636d4c9f5bb31845f1144142fb26dfc129cd15796c09d2de'
 r['argv']=rows(result/'argv-v4.jsonl'); r['stages']=rows(result/'stages.jsonl'); r['segments']=rows(result/'segments.jsonl')
 r['effectiveNode']=json.loads((result/'effective-node.json').read_text()) if (result/'effective-node.json').exists() else None
 r['input']=json.loads((result/'input.json').read_text()) if (result/'input.json').exists() else None
 before=s['cgroupBefore']; after=s['cgroupAfter']; r['oomDelta']={k:kv(after['memory.events'])[k]-v for k,v in kv(before['memory.events']).items()}
 r['cgroupCpuSeconds']=(kv(after['cpu.stat'])['usage_usec']-kv(before['cpu.stat'])['usage_usec'])/1e6
 samples=rows(result/'samples.jsonl')
 if samples:
  peak=max(samples,key=lambda x:int(x['cgroup']['memory.current'])); r['sampledCgroupMax']=dict(t=peak['t'],processes=peak['processes'],disk=peak['disk'],cgroup={k:v for k,v in peak['cgroup'].items() if k!='memory.stat'},memoryStat=kv(peak['cgroup']['memory.stat']))
  # Match phase observations by the actual child PID; do not infer clock alignment.
  node=rows(result/'node.jsonl'); spawn={x['id']:x for x in node if x['event']=='spawn'}
  r['children']=node and [dict(spawn={k:v for k,v in spawn.get(x['id'],{}).items() if k not in ['memory','cpu']},close={k:v for k,v in x.items() if k not in ['memory','cpu']}) for x in node if x['event']=='close' and (spawn.get(x['id'],{}).get('program')=='ffmpeg' or x.get('code')!=0 or x.get('signal'))]
  phase=[]
  for event in r['argv']:
   if event['event']!='spawn' or event['program']!='ffmpeg': continue
   pid=event['pid']; matching=[x for x in samples if any(p['pid']==pid for p in x['processes'])]
   if matching:
    peak=max(matching,key=lambda x:int(x['cgroup']['memory.current'])); proc=[p for p in peak['processes'] if p['pid']==pid][0]
    phase.append(dict(pid=pid,output=event['args'][-1],sampledCgroupCurrent=int(peak['cgroup']['memory.current']),stat={k:v for k,v in kv(peak['cgroup']['memory.stat']).items() if k in ['anon','file','kernel','anon_thp','file_dirty','file_writeback']},process=proc,simultaneousProcesses=peak['processes']))
  r['phaseSamples']=phase
 if not r['argv']:
  r['classification']='INVALID_SETUP'; r['status']='INVALID'
 elif a:=r['arguments'].get('micro'):
  r['classification']='MICROBENCH_ONLY'
 elif r['oomDelta']['oom_kill']:
  r['classification']='OOM_FAILURE'
  if r['arguments']['static']=='true' and not any(x.get('event')=='encoded' and x.get('eligible') for x in r['segments']): r['staticPerformanceValidity']='INVALID_TEST_NO_COMPLETED_STATIC_PATH'
 else: r['classification']='FULL_SYNTHETIC_JOB'
 # Compact immutable raw archive manifest; no large logs/media committed.
 manifest=r.pop('archiveFiles',{})
 r['archiveManifestSha256']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
 r['rawFiles']={str(f.relative_to(result)):dict(bytes=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for f in result.glob('*') if f.is_file()}
 r['argvRawCount']=len(r['argv']); failed={x['pid'] for x in r['argv'] if x.get('event')=='close' and (x.get('code')!=0 or x.get('signal'))}; selected={x['pid'] for x in r['argv'] if x.get('event')=='spawn' and x['program']=='ffmpeg' and (x['args'][-1].endswith(('segment-0.mp4','segment-1.mp4','av-static-0.png','reference-static-0.png','candidate.mp4','micro.mp4')) or r['arguments'].get('micro'))}|failed; r['argv']=[x for x in r['argv'] if x['pid'] in selected]
 r['hostConfig']={k:v for k,v in r.get('hostConfig',{}).items() if k in ['Memory','MemorySwap','NanoCpus','NetworkMode','PidsLimit','CapDrop','SecurityOpt']}
 # Full stage timeline remains hashed in raw evidence; retain first/last occurrence per stage.
 grouped={}
 for event in r['stages']: grouped.setdefault(event['name'],[]).append(event)
 r['stages']=[v for group in grouped.values() for v in ([group[0]] if len(group)==1 else [group[0],group[-1]])]
 for event in r['segments']:
  for key in ['fadeIn','fadeOut','enabled','layout','versionStart','versionEnd','cacheBefore']: event.pop(key,None)
 for event in r['argv']:
  if event.get('event')=='close':
   tail=event.pop('stderrTail','')
   if event.get('code')!=0 or event.get('signal'): event['stderrTail']=tail[-1024:]
 records.append(r)
argv_definitions={}
for record in records:
 for event in record.get('argv',[]):
  if event.get('event')=='spawn':
   payload=dict(program=event['program'],args=event.pop('args')); key=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest(); argv_definitions[key]=payload;event['argvSha256']=key
# One definition/case per JSON line; human-readable metrics are in RESULTS.md.
parts=['{\n  "schema":4,\n  "argvDefinitions":{\n']
parts.append(',\n'.join('    '+json.dumps(k)+':'+json.dumps(v,separators=(',',':')) for k,v in argv_definitions.items()))
parts.append('\n  },\n  "cases":[\n')
parts.append(',\n'.join('    '+json.dumps(r,separators=(',',':')) for r in records))
parts.append('\n  ]\n}\n')
serialized=''.join(parts); assert len(json.loads(serialized)['cases'])==len(records)
(dest/'measurements.json').write_text(serialized)
for r in records:
 s=r.get('summary',{}); print(r['label'],r.get('classification'),s.get('cgroupAfter',{}).get('memory.peak'),r.get('oomDelta',{}).get('oom_kill'),round(s.get('wallSeconds',0),3))
