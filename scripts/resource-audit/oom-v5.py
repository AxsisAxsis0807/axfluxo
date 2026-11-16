#!/usr/bin/env python3
"""Offline serial, immutable image cases. Archive /work before removing own stopped container."""
import argparse, hashlib, json, re, shutil, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('label'); p.add_argument('--memory',type=int,choices=[512000000,536870912,1000000000,2147483648],required=True)
p.add_argument('--static',choices=['true','false'],default='false'); p.add_argument('--seconds',type=int,choices=[5,15,30],default=5); p.add_argument('--titles',type=int,choices=[1,3],default=1)
p.add_argument('--layout',choices=['provisional-v1','reference-pasa-v1'],default='provisional-v1'); p.add_argument('--image',choices=['axfluxo-av-oom-v5:baseline','axfluxo-av-oom-v5:B','axfluxo-av-oom-v5:C1','axfluxo-av-oom-v5:B-thp'],default='axfluxo-av-oom-v5:baseline')
p.add_argument('--boundary',action='store_true')
p.add_argument('--cpu', choices=['0.5','1'],default='0.5'); p.add_argument('--segment',type=int,choices=[60,300,1800],default=60); p.add_argument('--experiment',choices=['normal','reuse','clear'],default='normal')
a=p.parse_args()
if a.experiment == "reuse" and a.image != "axfluxo-av-oom-v5:baseline": a.image="axfluxo-av-oom-v5:B-reuse"

if a.boundary and (a.seconds!=15 or a.titles!=3): p.error('boundary is only the 15-second three-title render fixture')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}',a.label): p.error('isolated label only')
out=Path('work/av-oom-v5')/a.label; out.mkdir(parents=True,exist_ok=False)
def d(*args): return subprocess.check_output(['docker','--host=unix:///var/run/docker.sock',*args],text=True).strip()
free=shutil.disk_usage(out).free
r=dict(label=a.label,arguments=vars(a),git=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),freeBefore=free,reserveBytes=2147483648,status='RUNNING')
def save(): (out/'case.json').write_text(json.dumps(r,indent=2)+'\n')
if free < r['reserveBytes']: r['status']='BLOCKED_DISK'; save(); raise SystemExit(2)
r['image']=d('image','inspect',a.image,'--format','{{.Id}}'); name='axfluxo-av-oom-v5-'+str(time.time_ns()); r['container']=name
cpu=a.cpu
cmd=['/app/baseline.mjs','render',str(a.seconds),'complex',str(a.titles),str(a.segment),a.layout]
cmd.extend(['shifted' if a.boundary else 'equal',a.experiment])
d('create','--name',name,'--network','none','--cpus',cpu,'--memory',str(a.memory),'--memory-swap',str(a.memory),'--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','axfluxo.offline-audit=oom-v5',*[v for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] for v in ['--env',key+'=']],'-e','VIDEO_RENDER_STATIC_COMPOSITE='+a.static,r['image'],*cmd)
save()
with (out/'container.log').open('w') as log:
 r['startExit']=subprocess.run(['docker','--host=unix:///var/run/docker.sock','start','-a',name],stdout=log,stderr=subprocess.STDOUT).returncode
r['state']=json.loads(d('inspect','--format','{{json .State}}',name)); r['hostConfig']={k:v for k,v in json.loads(d('inspect','--format','{{json .HostConfig}}',name)).items() if k in ['Memory','MemorySwap','NanoCpus','NetworkMode','PidsLimit','CapDrop','SecurityOpt']}
d('cp',name+':/work',str(out/'work'))
r['freeAfter']=shutil.disk_usage(out).free; r['status']='COMPLETED' if r['state']['ExitCode']==0 else 'FAILED'; save()
# No shared images, volumes or unrelated containers are deleted.
if d('inspect','--format','{{index .Config.Labels "axfluxo.offline-audit"}}',name)!='oom-v5' or r['state']['Running']: raise RuntimeError('ownership/state')
r['archiveFiles']={str(f.relative_to(out/'work')):dict(bytes=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for f in (out/'work').rglob('*') if f.is_file()}
d('rm',name); r['removedOwnStoppedContainer']=True; save(); print(a.label,r['status'],flush=True)
