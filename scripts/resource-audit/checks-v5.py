#!/usr/bin/env python3
"""Scoped checks with a credential-free environment; append logs without overwriting."""
import hashlib,json,os,subprocess,time
from pathlib import Path
out=Path('work/av-oom-v5-checks');out.mkdir(exist_ok=True)
records=json.loads((out/'checks.json').read_text()) if (out/'checks.json').exists() else []
env={k:v for k,v in os.environ.items() if k in ['PATH','LANG']};env['NODE_ENV']='test'
commands=[('typecheck-final',['npm','run','typecheck']),('lint-final',['npm','run','lint']),('worker-build',['npm','run','build:worker','--workspace','server']),('render-build',['npm','run','build:render','--workspace','server']),('recovery-cache-reference',['node_modules/.bin/vitest','run','server/tests/resource-recovery-v2.test.ts','server/tests/render/av-static-v3.test.ts','server/tests/render/all-versions-reference.test.ts','--maxWorkers=1'])]
for label,cmd in commands:
 p=out/(label+'.log')
 if p.exists():raise SystemExit('Refuse existing log '+str(p))
 started=time.time()
 with p.open('w') as log:r=subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT)
 records.append({'label':label,'command':cmd,'exitCode':r.returncode,'startedUnix':started,'wallSeconds':time.time()-started,'log':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'scope':'host verification; not resource acceptance'})
 (out/'checks.json').write_text(json.dumps(records,indent=2)+'\n');print(label,r.returncode,flush=True)
# Use existing isolated source copies with symlinked pinned dependencies, no DB URL.
for variant in ['baseline','B','C1']:
 label='worker-PGlite-FakeStorage-'+variant;p=out/(label+'.log')
 if p.exists():raise SystemExit('Refuse existing log '+str(p))
 cmd=['./node_modules/.bin/vitest','run','server/tests/projects/projects.test.ts','--maxWorkers=1','-t','v3: static ON']; started=time.time()
 with p.open('w') as log:r=subprocess.run(cmd,env=env,cwd='work/av-oom-v5-build/'+variant,stdout=log,stderr=subprocess.STDOUT)
 records.append({'label':label,'command':cmd,'exitCode':r.returncode,'startedUnix':started,'wallSeconds':time.time()-started,'log':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'scope':'Worker / embedded PGlite / FakeStorage only; no native PostgreSQL or real storage'})
 (out/'checks.json').write_text(json.dumps(records,indent=2)+'\n');print(label,r.returncode,flush=True)
