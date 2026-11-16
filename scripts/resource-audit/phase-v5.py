#!/usr/bin/env python3
"""B7: new container/process per phase, replay measured B argv on synthetic artifacts."""
import hashlib,json,shutil,subprocess,time
from pathlib import Path
source=Path('work/av-oom-v5/B3-1GB-r1/work/result'); assets=source/'media'
assert (source/'result.json').exists(), 'Complete B3 before phase replay'
rows=[json.loads(l) for l in (source/'argv-v4.jsonl').read_text().splitlines()]
phases={'background':None,'title':None,'static-generate':'av-static-0.png','fade-encode':'segment-5.mp4','static-encode':'segment-6.mp4','mux':'candidate.mp4'}
def d(*args):return subprocess.check_output(['docker','--host=unix:///var/run/docker.sock',*args],text=True).strip()
image=d('image','inspect','axfluxo-av-oom-v5:phase','--format','{{.Id}}')
for phase,target in phases.items():
 label='B7-'+phase;out=Path('work/av-oom-v5')/label;out.mkdir(exist_ok=False)
 assert shutil.disk_usage(out).free>2*1024**3
 inp=json.loads((source/'input.json').read_text());args=None;sourceArgs=None
 if target:
  event=next(x for x in rows if x['event']=='spawn' and x['program']=='ffmpeg' and x['args'][-1].endswith('/'+target))
  sourceArgs=event['args'];assert sourceArgs[:4]==['-v','error','-protocol_whitelist','file,pipe']
  args=[a.replace('/work/result/media/','/work/assets/') for a in sourceArgs[4:]];args[-1]='/work/result/'+target;inp['argv']=args
 (out/'phase-input.json').write_text(json.dumps(inp));(out/'phase-input.json').chmod(0o644)
 name='axfluxo-av-oom-v5-phase-'+str(time.time_ns())
 d('create','--name',name,'--network','none','--cpus','0.5','--memory','1000000000','--memory-swap','1000000000','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','axfluxo.offline-audit=oom-v5-phase',*[v for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] for v in ['--env',key+'=']],image,'/app/baseline.mjs',phase)
 d('cp',str(assets),name+':/work/assets'); d('cp',str(out/'phase-input.json'),name+':/work/phase-input.json')
 # Concat demuxer reads a text list with absolute paths; rewrite only our synthetic paths.
 if phase=='mux':
  for p in assets.glob('*.txt'):
   q=out/p.name;q.write_text(p.read_text().replace('/work/result/media/','/work/assets/'));q.chmod(0o644);d('cp',str(q),name+':/work/assets/'+p.name)
 with (out/'container.log').open('w') as f: code=subprocess.run(['docker','start','-a',name],stdout=f,stderr=subprocess.STDOUT).returncode
 state=json.loads(d('inspect','--format','{{json .State}}',name));d('cp',name+':/work',str(out/'work'))
 r={'label':label,'status':'COMPLETED' if code==0 else 'FAILED','arguments':{'cpu':'0.5','memory':1000000000,'image':'axfluxo-av-oom-v5:phase','static':'false','phase':phase},'image':image,'phaseInputSha256':hashlib.sha256((out/'phase-input.json').read_bytes()).hexdigest(),'state':state,'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'hostConfig':{k:v for k,v in json.loads(d('inspect','--format','{{json .HostConfig}}',name)).items() if k in ['Memory','MemorySwap','NanoCpus','NetworkMode','PidsLimit','CapDrop','SecurityOpt']},'sourceCase':'B3-1GB-r1','sourceArgv':sourceArgs,'replayInputArgs':args}
 (out/'case.json').write_text(json.dumps(r,indent=2)+'\n')
 assert not state['Running'] and d('inspect','--format','{{index .Config.Labels "axfluxo.offline-audit"}}',name)=='oom-v5-phase'
 d('rm',name);print(label,r['status'],flush=True)
