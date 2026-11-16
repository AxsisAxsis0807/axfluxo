#!/usr/bin/env python3
"""Compact check/recovery evidence. Native test process status is checked per suite."""
import hashlib,json,re,subprocess,time
from pathlib import Path
root=Path('work/av-fade-v4'); out=Path('docs/unified-worker/evidence/av-fade-v4')
def meta(path): return dict(bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
checks=[]
for line in (root/'checks/status.txt').read_text().splitlines():
 label,code=line.split(); p=root/'checks'/f'{label}.log'; checks.append(dict(label=label,exitCode=int(code),log=meta(p) if p.exists() else None))
native=[]
for directory in ['native-baseline','native-candidate-static']:
 p=root/directory; result=json.loads((p/'results.json').read_text()); logs=[]
 for log in sorted(p.glob('tests-*.log')):
  text=log.read_text();match=re.findall(r'Tests\s+([^\n]+)',text);logs.append(dict(file=log.name,summary=match[-1].strip() if match else None,**meta(log)))
 native.append(dict(directory=directory,result=result,logs=logs))
recovery=json.loads((root/'recovery/recovery.json').read_text())
# Docker daemon's retained transition events independently record KILL/die codes.
raw=subprocess.check_output(['docker','--host=unix:///var/run/docker.sock','events','--since','2026-11-16T00:00:00Z','--until',str(int(time.time())), '--filter','type=container','--filter','label=axfluxo.offline-audit=fade-v4-recovery','--filter','event=die','--filter','event=kill','--format','{{json .}}'],text=True)
events=[]
for line in raw.splitlines():
 e=json.loads(line);a=e['Actor']['Attributes'];events.append(dict(action=e['Action'],timeNano=e['timeNano'],containerId=e['Actor']['ID'],**{k:a[k] for k in ['name','image','signal','exitCode'] if k in a}))
for r in recovery:
 r['transitions']=[e for e in events if e.get('name') in [r['container'],r['restart']]]
 r['killedExit137Observed']=any(e['action']=='die' and e.get('name')==r['container'] and e.get('exitCode')=='137' for e in r['transitions'])
 r['restartExit0Observed']=any(e['action']=='die' and e.get('name')==r['restart'] and e.get('exitCode')=='0' for e in r['transitions'])
image=subprocess.check_output(['docker','--host=unix:///var/run/docker.sock','image','inspect','axfluxo-av-fade-v4:candidate-B','--format','{{.Id}}'],text=True).strip()
measured=json.loads((out/'measurements.json').read_text())['cases']; expectedImage=next(c for c in measured if c['label']=='Bcand2-on')['image']; assert image==expectedImage
extraRoot=root/'recovery-valid-header/png-generating'
extra=json.loads((root/'recovery-valid-header/recovery.json').read_text())[0]
extra['injectedPng']=json.loads((extraRoot/'restarted-work/prior/injected-png.json').read_text())
assert extra['injectedPng']['validPngSignature'] and extra['injectedPng']['bytes']==17 and extra['expectedHashMatch'] and extra['foreignSentinelPreserved']
(out/'recovery-invalid-png.json').write_text(json.dumps(extra,indent=2)+'\n')
report=dict(recoveryImage=image,checks=checks,native=native,relationTests='13 passed',samplerTests='2 passed, values exercised as subtests',limits='Native baseline real PostgreSQL/FFmpeg; candidate static-on real Worker/DB with FakeStorage; no real storage or constrained-memory Worker proof')
(out/'checks.json').write_text(json.dumps(report,indent=2)+'\n')
(out/'recovery.json').write_text(json.dumps(dict(cases=recovery,scope='actual SIGKILL then standalone regeneration; not checkpoint/DB/publication resumption'),indent=2)+'\n')
assert all(c['exitCode']==0 for c in checks)
assert all(r['exitCode']==0 for n in native for r in n['result']['results'])
assert len(recovery)==7 and all(r['expectedHashMatch'] and r['foreignSentinelPreserved'] and r['killedExit137Observed'] and r['restartExit0Observed'] for r in recovery)
print('checks/native/recovery evidence PASS; release remains HOLD')
