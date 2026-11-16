#!/usr/bin/env python3
"""Copy compact evidence only; hash raw standalone recovery/media instead of committing it."""
import hashlib,json,shutil
from pathlib import Path
root=Path('work/av-oom-v5');dest=Path('docs/unified-worker/evidence/av-oom-v5')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
index=[]
for p in sorted(root.glob('quality-*.json')):
 r=json.loads(p.read_text());target=dest/p.name;shutil.copyfile(p,target)
 index.append({'file':p.name,'sha256':sha(target),'left':r['left']['label'],'right':r['right']['label'],'status':r['status'],'checks':r['checks'],'leftMp4Sha256':r['left']['mp4Sha256'],'rightMp4Sha256':r['right']['mp4Sha256'],'expectedDiagnosticDifference':r['right']['label'].startswith('B8-')})
(dest/'quality-index.json').write_text(json.dumps({'scope':'matched synthetic jobs only, not real media or production','comparisons':index},indent=2)+'\n')
checks=json.loads(Path('work/av-oom-v5-checks/checks.json').read_text());checks.append(json.loads(Path('work/av-oom-v5-checks/reference-permission-retry.json').read_text()))
(dest/'checks.json').write_text(json.dumps({'scope':'host verification / embedded PGlite / FakeStorage only','records':checks},indent=2)+'\n')
recovery=Path('work/av-oom-v5-recovery')
if (recovery/'recovery.json').exists():
 r=json.loads((recovery/'recovery.json').read_text())
 for case in r:
  directory=recovery/case['point'];case['rawFiles']={str(p.relative_to(directory)):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in directory.rglob('*') if p.is_file()}
  case['rawLocation']=str(directory.resolve())
 (dest/'recovery.json').write_text(json.dumps({'scope':'standalone restart, NOT checkpoint/DB/real-storage recovery','cases':r},indent=2)+'\n')
logs=[Path('work/av-oom-v5-matrix.log'),Path('work/av-oom-v5-phase.log'),Path('work/av-oom-v5-supplement.log'),Path('work/av-oom-v5-filter-compare.log'),Path('work/av-oom-v5-checks-run.log'),Path('work/av-oom-v5-thp.log'),Path('work/av-oom-v5-recovery-run.log')]
(dest/'execution-logs.json').write_text(json.dumps({str(p):{'bytes':p.stat().st_size,'sha256':sha(p),'text':p.read_text()} for p in logs if p.exists()},indent=2)+'\n')
print('quality comparisons',len(index),'matched exact',sum(x['status']=='PASS_EXACT' for x in index))
