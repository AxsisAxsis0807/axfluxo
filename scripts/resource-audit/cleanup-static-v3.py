#!/usr/bin/env python3
"""Archive and remove only stopped v3 containers of our exact diagnostic image.
No image/volume/prune operation. Synthetic artifacts remain in the archive.
"""
import hashlib,json,shutil,subprocess,sys,time
from pathlib import Path
out=Path(sys.argv[1]).resolve(); out.mkdir(parents=True,exist_ok=True)
def docker(*args): return subprocess.check_output(['docker','--host=unix:///var/run/docker.sock',*args],text=True).strip()
image=docker('image','inspect','axfluxo-av-static-v3:local','--format','{{.Id}}')
log=out/'cleanup.jsonl'
for ident in docker('ps','-a','--filter','label=axfluxo.offline-audit=v3','--format','{{.ID}}').splitlines():
    obj=json.loads(docker('inspect',ident))[0]; name=obj['Name'].lstrip('/')
    if obj['Image']!=image or not name.startswith('axfluxo-av-v3-') or obj['State']['Status']!='exited': continue
    dest=out/name
    if dest.exists(): continue
    if shutil.disk_usage(out).free<2*1024**3: raise SystemExit('BLOCKED_DISK: cannot safely archive')
    dest.mkdir()
    subprocess.run(['docker','--host=unix:///var/run/docker.sock','cp',ident+':/work',str(dest/'work')],check=True,stdout=subprocess.DEVNULL)
    record=dict(container=name,image=image,state=obj['State'],freeBefore=shutil.disk_usage(out).free,archivedAt=time.time(),files={str(p.relative_to(dest)):{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in dest.rglob('*') if p.is_file()})
    # Persist evidence before removing the disposable container.
    (dest/'archive.json').write_text(json.dumps(record,indent=2)+'\n')
    subprocess.run(['docker','--host=unix:///var/run/docker.sock','rm',ident],check=True,stdout=subprocess.DEVNULL)
    record.pop('files'); record['freeAfter']=shutil.disk_usage(out).free
    with log.open('a') as f: f.write(json.dumps(record)+'\n')
    print(name,'ARCHIVED_REMOVED',flush=True)
