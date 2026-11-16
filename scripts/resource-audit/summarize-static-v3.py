#!/usr/bin/env python3
"""Compact v3 evidence; no media, secrets or sampled RSS/cgroup conflation."""
import hashlib,json,sys
from pathlib import Path
root,out=map(Path,sys.argv[1:]); out.mkdir(parents=True,exist_ok=True)
rows=[]
def counters(s): return {k:int(v) for k,v in (line.split() for line in s.splitlines())}
for p in sorted(root.glob('*/case.json')):
    c=json.loads(p.read_text()); r=p.parent/'result'; item={k:v for k,v in c.items() if k not in ['hostConfig','state']}
    item['state']={k:c.get('state',{}).get(k) for k in ['Status','ExitCode','OOMKilled','Error','StartedAt','FinishedAt']}
    item['hostLimits']={k:c.get('hostConfig',{}).get(k) for k in ['Memory','MemorySwap','NanoCpus','NetworkMode','PidsLimit','CapDrop','SecurityOpt']}
    item['label']=p.parent.name
    if (r/'summary.json').exists():
        s=json.loads((r/'summary.json').read_text()); item['summary']=s
        item['cgroupPeakBytes']=int(s['cgroupAfter']['memory.peak'])
        item['oomDelta']={k:v-counters(s['cgroupBefore']['memory.events']).get(k,0) for k,v in counters(s['cgroupAfter']['memory.events']).items()}
        item['cpuDelta']={k:v-counters(s['cgroupBefore']['cpu.stat']).get(k,0) for k,v in counters(s['cgroupAfter']['cpu.stat']).items()}
        events=[json.loads(x) for x in (r/'node.jsonl').read_text().splitlines()] if (r/'node.jsonl').exists() else []
        spawns={x['pid']:x for x in events if x.get('event')=='spawn'}
        phasePeaks={}
        for line in (r/'samples.jsonl').open():
            sample=json.loads(line)
            for process in sample['processes']:
                spawn=spawns.get(process['pid'])
                if not spawn: continue
                phase=spawn['branch']+':'+str(spawn['output'])
                peak=phasePeaks.setdefault(phase,dict(cgroupCurrentSampledPeak=0,ffmpegRssSampledPeak=0,ffmpegPssSampledPeak=0,ffmpegUssSampledPeak=0,threads=0,diskSampledPeak=0))
                peak['cgroupCurrentSampledPeak']=max(peak['cgroupCurrentSampledPeak'],int(sample['cgroup']['memory.current']))
                for key,target in [('rss','ffmpegRssSampledPeak'),('pss','ffmpegPssSampledPeak'),('uss','ffmpegUssSampledPeak'),('threads','threads')]: peak[target]=max(peak[target],process[key])
                peak['diskSampledPeak']=max(peak['diskSampledPeak'],sample['disk'])
        item['sampledProcessPhases']=phasePeaks
        item['nodeMemoryPeaks']={k:max(e['memory'][k] for e in events) for k in ['rss','heapTotal','heapUsed','external','arrayBuffers']} if events else None
        item['mediaEvents']=[e for e in events if e['event'] in ['spawn','close','startup','exit']]
    for name in ['input.json','result.json','effective-env.json','effective-node.json']:
        if (r/name).exists(): item[name]=json.loads((r/name).read_text())
    for name in ['segments.jsonl','stages.jsonl']:
        if (r/name).exists(): item[name]=[json.loads(x) for x in (r/name).read_text().splitlines()]
    if (r/'stderr.log').exists(): item['stderr']= (r/'stderr.log').read_text()[-16384:]
    item['rawEvidenceHashes']={str(f.relative_to(p.parent)):hashlib.sha256(f.read_bytes()).hexdigest() for f in [p,r/'summary.json',r/'node.jsonl',r/'samples.jsonl',r/'segments.jsonl',r/'stages.jsonl'] if f.exists()}
    rows.append(item)
(out/'measurements.json').write_text(json.dumps(dict(schema=3,cases=rows,limitations=['Per-process/stage peaks are sampled, not reset kernel stage peaks.','Shared file mappings may be charged outside a process cgroup: RSS sum differs from cgroup memory.','Raw logs and synthetic media are retained locally under work/av-v3; hashes are committed.']),indent=2)+'\n')
for p in root.glob('quality-*.json'):
    q=json.loads(p.read_text())
    for side in ['leftEvidence','rightEvidence']:
        probe=q[side]['probe']; frames=probe.pop('frames')
        q[side]['videoTimestamps']=[{k:f.get(k) for k in ['pts','pts_time','pkt_duration','pkt_duration_time','duration','duration_time']} for f in frames if f['media_type']=='video']
        q[side]['audioDecodedProbeSamples']=sum(f.get('nb_samples',0) for f in frames if f['media_type']=='audio')
    (out/p.name).write_text(json.dumps(q,indent=2)+'\n')
print('cases',len(rows))
for r in rows: print(r['label'],r['status'],r.get('cgroupPeakBytes'),r.get('oomDelta'))
