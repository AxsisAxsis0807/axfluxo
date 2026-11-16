#!/usr/bin/env python3
"""One explicitly selected offline v3 case; never deploys or publishes."""
import argparse, hashlib, json, shutil, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('output',type=Path)
p.add_argument('--memory',type=int,choices=[512000000,536870912,1000000000,2147483648],required=True)
p.add_argument('--static',choices=['true','false'],required=True)
p.add_argument('--seconds',type=int,choices=[5,15,30],default=5)
p.add_argument('--titles',type=int,choices=[1,3],default=1)
p.add_argument('--layout',choices=['provisional-v1','reference-pasa-v1'],default='provisional-v1')
a=p.parse_args(); out=a.output.resolve(); out.mkdir(parents=True,exist_ok=False)
def docker(*args,**kw):
    return subprocess.run(['docker','--host=unix:///var/run/docker.sock',*args],check=True,text=True,**kw)
def capture(*args): return docker(*args,stdout=subprocess.PIPE).stdout.strip()
free=shutil.disk_usage(out).free
if free < 2*1024**3:
    (out/'case.json').write_text(json.dumps(dict(status='BLOCKED_DISK',freeBytes=free)))
    raise SystemExit(2)
image=capture('image','inspect','axfluxo-av-static-v3:local','--format','{{.Id}}')
name='axfluxo-av-v3-'+str(time.time_ns()); cpu='0.5' if a.memory < 1000000000 else '1'
record=dict(schema=3, status='RUNNING', sourceBase='498bf9d64f1329fbec6b04b6ce7679a0cd094049',
 git=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 bundleSha256=hashlib.sha256(Path('work/resource-audit/candidate.mjs').read_bytes()).hexdigest(),
 image=image,container=name,memoryBytes=a.memory,cpu=cpu,swap='memory-swap equals memory',
 static=a.static,seconds=a.seconds,titles=a.titles,layout=a.layout,freeBefore=free)
def save(): (out/'case.json').write_text(json.dumps(record,indent=2)+'\n')
save()
docker('create','--name',name,'--network','none','--cpus',cpu,'--memory',str(a.memory),
 '--memory-swap',str(a.memory),'--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true',
 '--label','axfluxo.offline-audit=v3','-e','VIDEO_RENDER_STATIC_COMPOSITE='+a.static,
 image,'/app/candidate.mjs','render',str(a.seconds),'complex',str(a.titles),'60',a.layout,stdout=subprocess.DEVNULL)
with (out/'container.log').open('w') as log:
    result=subprocess.run(['docker','--host=unix:///var/run/docker.sock','start','-a',name],stdout=log,stderr=subprocess.STDOUT)
record['state']=json.loads(capture('inspect','--format','{{json .State}}',name))
record['hostConfig']=json.loads(capture('inspect','--format','{{json .HostConfig}}',name))
docker('cp',name+':/work/result',str(out/'result'),stdout=subprocess.DEVNULL)
record['freeAfter']=shutil.disk_usage(out).free
record['status']='COMPLETED' if record['state']['ExitCode']==0 else 'FAILED'
if a.static=='true' and record['status']=='COMPLETED':
    rows=[json.loads(x) for x in (out/'result/node.jsonl').read_text().splitlines()]
    successful={r['id'] for r in rows if r.get('event')=='close' and r.get('code')==0 and r.get('signal') is None}
    record['completedStaticSegments']=sum(r.get('branch')=='static-use' and r.get('id') in successful for r in rows)
    if not record['completedStaticSegments']: record['status']='INVALID_TEST'
save(); print(json.dumps({k:record[k] for k in ['container','status','memoryBytes','static']}))
