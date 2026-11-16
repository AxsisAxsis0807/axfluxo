#!/usr/bin/env python3
"""Use an offline-only synchronous hook to freeze Node at a boundary, then SIGKILL container.
Restart is a fresh offline process in a copied synthetic-only work directory;
this deliberately does NOT test DB leases, publication or checkpoint resumption.
"""
import json,subprocess,sys,time
from pathlib import Path
out=Path(sys.argv[1]).resolve(); out.mkdir(parents=True,exist_ok=False)
image='axfluxo-av-fade-v4:candidate-B'
def docker(*args,**kwargs): return subprocess.run(['docker','--host=unix:///var/run/docker.sock',*args],check=True,text=True,**kwargs)
def capture(*args): return docker(*args,stdout=subprocess.PIPE).stdout.strip()
monitor=r'''
import sys,time,json
from pathlib import Path
p=Path('/work/result/stop-marker.json'); deadline=time.monotonic()+180
while not p.exists() and time.monotonic()<deadline: time.sleep(.01)
if not p.exists(): raise SystemExit('TIMEOUT_NO_TRIGGER')
r=json.loads(p.read_text());r['pngs']=[{'name':f.name,'size':f.stat().st_size} for f in Path('/work/result/media').glob('*static*.png')]
print(json.dumps(r))
'''
import shutil, hashlib
if shutil.disk_usage(out).free < 2*1024**3: raise SystemExit('BLOCKED_DISK')
records=[]
allowed_points = {'png-generating','png-complete','encode-start','segment-complete','before-next-segment','fade-running','before-mux'}
if any(point not in allowed_points for point in sys.argv[2:]):
 raise SystemExit('Invalid stop point')
for point in (sys.argv[2:] or ['png-generating','png-complete','encode-start','segment-complete','before-next-segment','fade-running','before-mux']):
 if shutil.disk_usage(out).free < 2*1024**3: raise SystemExit('BLOCKED_DISK')
 name='axfluxo-av-fade-v4-stop-'+str(time.time_ns()); case=out/point; case.mkdir()
 docker('create','--name',name,'--network','none',*[v for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] for v in ['--env',key+'=']],'--cpus','1','--memory','2147483648','--memory-swap','2147483648','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','axfluxo.offline-audit=fade-v4-recovery','-e','VIDEO_RENDER_STATIC_COMPOSITE=true','--entrypoint','python3',image,'/app/sample.py','/work/result','--','node','--import','/app/preload-v4.mjs','--import','/work/stop-hook.mjs','/app/baseline.mjs','render','5','complex','1','60','provisional-v1','audit-stop-'+point,stdout=subprocess.DEVNULL)
 docker('cp',str(Path(__file__).with_name('stop-hook-v4.mjs').resolve()),name+':/work/stop-hook.mjs',stdout=subprocess.DEVNULL)
 docker('start',name,stdout=subprocess.DEVNULL)
 observation=json.loads(capture('exec',name,'python3','-c',monitor,point))
 docker('kill','--signal','KILL',name,stdout=subprocess.DEVNULL)
 docker('cp',name+':/work/result',str(case/'interrupted'),stdout=subprocess.DEVNULL)
 # Restore only our synthetic artifacts to a new container; no foreign paths.
 restart=name+'-restart'
 code="import os; os.execve('/usr/bin/node',['node','--import','/app/preload-v4.mjs','/app/baseline.mjs','render','5','complex','1','60'],{'PATH':'/usr/bin','LANG':'C','HOME':'/work/prior','TMPDIR':'/work/prior','NODE_OPTIONS':'--max-old-space-size=128','NODE_ENV':'test','RESOURCE_AUDIT_DIR':'/work/prior','VIDEO_RENDER_DISK':'/work/prior/media','VIDEO_RENDER_STATIC_COMPOSITE':'true'})"
 # Deliberately poison the incomplete PNG case; preserve the interrupted
 # evidence separately. A fresh cache must regenerate, not trust this file.
 prefix = "from pathlib import Path; p=Path('/work/prior'); (p/'foreign-checkpoint').write_bytes(b'foreign-sentinel'); "
 if point == 'png-generating':
  prefix += "bad=bytes.fromhex('89504e470d0a1a0a')+b'truncated'; (p/'media/av-static-0.png').write_bytes(bad); (p/'injected-png.json').write_text(__import__('json').dumps({'validPngSignature':bad.startswith(bytes.fromhex('89504e470d0a1a0a')),'bytes':len(bad),'sha256':__import__('hashlib').sha256(bad).hexdigest()})); "
 code = prefix + code
 docker('create','--name',restart,'--network','none',*[v for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] for v in ['--env',key+'=']],'--cpus','1','--memory','2147483648','--memory-swap','2147483648','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','axfluxo.offline-audit=fade-v4-recovery','--entrypoint','python3',image,'-c',code,stdout=subprocess.DEVNULL)
 docker('cp',str(case/'interrupted'),restart+':/work/prior',stdout=subprocess.DEVNULL)
 with (case/'restart.log').open('w') as log: docker('start','-a',restart,stdout=log,stderr=subprocess.STDOUT)
 docker('cp',restart+':/work/prior/result.json',str(case/'restart-result.json'),stdout=subprocess.DEVNULL)
 docker('cp',restart+':/work/prior/foreign-checkpoint',str(case/'foreign-checkpoint'),stdout=subprocess.DEVNULL)
 assert (case/'foreign-checkpoint').read_bytes() == b'foreign-sentinel'
 record=dict(truncatedPngInjected=point=='png-generating',foreignSentinelPreserved=True,point=point,container=name,restart=restart,observation=observation,validation=json.loads((case/'restart-result.json').read_text()),scope='standalone restart, NOT checkpoint/DB recovery')
 record['containerStates']={}
 # Preserve both complete /work trees before removing only owned stopped containers.
 for owned, folder in [(name,'killed-work'),(restart,'restarted-work')]:
  docker('cp',owned+':/work',str(case/folder),stdout=subprocess.DEVNULL)
  state=json.loads(capture('inspect','--format','{{json .State}}',owned))
  record['containerStates'][owned]=state
  if state['Running'] or capture('inspect','--format','{{index .Config.Labels "axfluxo.offline-audit"}}',owned)!='fade-v4-recovery': raise RuntimeError('ownership/state')
  docker('rm',owned,stdout=subprocess.DEVNULL)
 record['expectedHashMatch']=record['validation']['sha256']=='df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95'
 assert record['expectedHashMatch']
 records.append(record); (out/'recovery.json').write_text(json.dumps(records,indent=2)+'\n'); print(point,'RESTART_COMPLETED',flush=True)
