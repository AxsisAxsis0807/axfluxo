#!/usr/bin/env python3
"""Offline serial, immutable image cases. Archive /work before removing own stopped container."""
import argparse, hashlib, json, re, shutil, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('label'); p.add_argument('--memory',type=int,choices=[512000000,536870912,1000000000,2147483648],required=True)
p.add_argument('--static',choices=['true','false'],default='false'); p.add_argument('--seconds',type=int,choices=[5,15,30],default=5); p.add_argument('--titles',type=int,choices=[1,3],default=1)
p.add_argument('--layout',choices=['provisional-v1','reference-pasa-v1'],default='provisional-v1'); p.add_argument('--image',choices=['axfluxo-av-fade-v4:baseline','axfluxo-av-fade-v4:candidate-A','axfluxo-av-fade-v4:candidate-B','axfluxo-av-fade-v4:boundary-base','axfluxo-av-fade-v4:boundary-B'],default='axfluxo-av-fade-v4:baseline'); p.add_argument('--micro',choices=['init','bg-single','bg-null','text-null','text-rgba','text-pts','text-fade','overlay','overlay-yuv','full-null','bg-encode','full-encode','full-filterloop','full-queue1','full-raw','full-crop','full-raw-ready','full-crop-ready'],default=None)
p.add_argument('--boundary',action='store_true')
a=p.parse_args()
if a.boundary != (a.image in ['axfluxo-av-fade-v4:boundary-base','axfluxo-av-fade-v4:boundary-B']): p.error('boundary requires its separately frozen fixture image')
if a.boundary and (a.seconds!=15 or a.titles!=3 or a.micro): p.error('boundary is only the 15-second three-title render fixture')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}',a.label): p.error('isolated label only')
out=Path('work/av-fade-v4')/a.label; out.mkdir(parents=True,exist_ok=False)
def d(*args): return subprocess.check_output(['docker','--host=unix:///var/run/docker.sock',*args],text=True).strip()
free=shutil.disk_usage(out).free
r=dict(label=a.label,arguments=vars(a),git=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),freeBefore=free,reserveBytes=2147483648,status='RUNNING')
def save(): (out/'case.json').write_text(json.dumps(r,indent=2)+'\n')
if free < r['reserveBytes']: r['status']='BLOCKED_DISK'; save(); raise SystemExit(2)
r['image']=d('image','inspect',a.image,'--format','{{.Id}}'); name='axfluxo-av-fade-v4-'+str(time.time_ns()); r['container']=name
cpu='0.5' if a.memory<1000000000 else '1'
cmd=['/app/baseline.mjs','render',str(a.seconds),'complex',str(a.titles),'60',a.layout]
if a.boundary: cmd.append('shifted')
if a.micro: cmd=['/work/baseline.mjs',a.micro]
d('create','--name',name,'--network','none','--cpus',cpu,'--memory',str(a.memory),'--memory-swap',str(a.memory),'--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','axfluxo.offline-audit=fade-v4',*[v for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] for v in ['--env',key+'=']],'-e','VIDEO_RENDER_STATIC_COMPOSITE='+a.static,r['image'],*cmd)
if a.micro:
 d('cp','scripts/resource-audit/micro-v4.mjs',name+':/work/baseline.mjs')
 for f in ['background.png','text-0.png']:
  d('cp','work/av-fade-v4/B2-off-r2/work/result/media/'+f,name+':/work/'+f)
if a.micro=='full-raw-ready':
 for f in ['background.rgba','text-0.rgba']: d('cp','work/av-fade-v4/M-full-raw/work/'+f,name+':/work/'+f)
if a.micro=='full-crop-ready': d('cp','work/av-fade-v4/M-full-crop/work/result/micro.json',name+':/work/crop.json')
save()
with (out/'container.log').open('w') as log:
 r['startExit']=subprocess.run(['docker','--host=unix:///var/run/docker.sock','start','-a',name],stdout=log,stderr=subprocess.STDOUT).returncode
r['state']=json.loads(d('inspect','--format','{{json .State}}',name)); r['hostConfig']={k:v for k,v in json.loads(d('inspect','--format','{{json .HostConfig}}',name)).items() if k in ['Memory','MemorySwap','NanoCpus','NetworkMode','PidsLimit','CapDrop','SecurityOpt']}
d('cp',name+':/work',str(out/'work'))
r['freeAfter']=shutil.disk_usage(out).free; r['status']='COMPLETED' if r['state']['ExitCode']==0 else 'FAILED'; save()
# No shared images, volumes or unrelated containers are deleted.
if d('inspect','--format','{{index .Config.Labels "axfluxo.offline-audit"}}',name)!='fade-v4' or r['state']['Running']: raise RuntimeError('ownership/state')
r['archiveFiles']={str(f.relative_to(out/'work')):dict(bytes=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for f in (out/'work').rglob('*') if f.is_file()}
d('rm',name); r['removedOwnStoppedContainer']=True; save(); print(a.label,r['status'],flush=True)
