#!/usr/bin/env python3
"""Audit evidence invariants, including expected OOMs; never declares production PASS."""
import json,hashlib,subprocess
from pathlib import Path
out=Path('docs/unified-worker/evidence/av-fade-v4'); cases=json.loads((out/'measurements.json').read_text())['cases']; by={c['label']:c for c in cases}
def kv(s): return {k:int(v) for k,v in (line.split() for line in s.splitlines())}
checks={}
valid=[c for c in cases if c.get('classification') not in ['INVALID_SETUP',None]]
v3=json.loads(Path('docs/unified-worker/evidence/av-static-v3/measurements.json').read_text())['cases'][0]['input.json']
checks['baselineInputMatchesV3']=by['B2-off-r2']['input']==v3
checks['runtimeFilesMatchV3']=json.loads((out/'runtime-identity.json').read_text())['v3SameFiles']
checks['allFinalized']=all(c.get('status')!='RUNNING' for c in cases)
checks['memoryPageFloor']=all(int(c['summary']['cgroupAfter']['memory.max'])==c['arguments']['memory']//4096*4096 for c in valid)
checks['zeroSwap']=all(c['summary']['cgroupAfter']['memory.swap.max']=='0' and c['summary']['cgroupAfter']['memory.swap.current']=='0' for c in valid)
checks['cpuQuota']=all(c['summary']['cgroupAfter']['cpu.max']==('50000 100000' if c['arguments']['memory']<1000000000 else '100000 100000') for c in valid)
checks['containerIsolation']=all(c['hostConfig']['NetworkMode']=='none' and c['hostConfig']['PidsLimit']==128 and c['hostConfig']['CapDrop']==['ALL'] and c['hostConfig']['MemorySwap']==c['arguments']['memory'] for c in valid)
checks['diskReserves']=all(c['freeBefore']>=c['reserveBytes'] for c in valid)
checks['ownStoppedArchived']=all(c.get('removedOwnStoppedContainer') and c.get('archiveManifestSha256') for c in valid)
checks['baselineOomRepeat']=all(by[label]['oomDelta']['oom_kill']==1 for label in ['B512-off-r3','B512-off-r4','B512-on-1','B512-on-2'])
checks['candidateAStaticOomRepeat']=all(by[f'A512-on-{n}']['oomDelta']['oom_kill']==1 and any(x['event']=='encoded' and x['segment']==0 for x in by[f'A512-on-{n}']['segments']) for n in [1,2])
short=[by[f'Bcand512-on-{n}'] for n in [1,2,3]]
checks['candidateBShort3CompleteNoOom']=all(c['status']=='COMPLETED' and c['oomDelta']['oom']==0 and c['oomDelta']['oom_kill']==0 for c in short)
checks['staticActuallyCompleted']=all(c['effectiveNode']['staticComposite']=='true' and sum(x['event']=='encoded' and x['eligible'] for x in c['segments'])==3 and sum(x.get('spawn',{}).get('branch')=='static-generate' and x['close']['code']==0 for x in c['children'])==1 and sum(x.get('spawn',{}).get('branch')=='static-use' and x['close']['code']==0 for x in c['children'])==3 for c in short)
checks['sameBInputCodeImage']=all(c['input']==short[0]['input'] and c['fixtureCodeSha256']==short[0]['fixtureCodeSha256'] and c['image']==short[0]['image'] for c in short)
checks['longerOomNotHidden']=by['Bcand15-512']['oomDelta']['oom_kill']==1 and by['Bcand15-512']['status']=='FAILED'
checks['noLonger512AfterOom']=not any(label in by for label in ['BcandRef-512','Bcand30-512'])
quality=list(out.glob('quality-*.json')); checks['qualityAllExact']=bool(quality) and all(json.loads(p.read_text())['status']=='PASS_EXACT' for p in quality)
checks['productionCodeUnchanged']=subprocess.run(['git','diff','--quiet','4159f194f6e9f37a9f402ed84542df18f04ba22f','--','server/worker','server/api','server/db','src'],check=False).returncode==0
result=dict(checks=checks,status='PASS_EVIDENCE_INVARIANTS' if all(checks.values()) else 'HOLD_EVIDENCE_ERROR',overall='HOLD',reason='candidate B 15-second 512MB OOM; short-job pass is limited, no release approval')
(out/'verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if all(checks.values()) else 1)
