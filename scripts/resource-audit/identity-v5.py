#!/usr/bin/env python3
"""Compare actual projectPlan outputs on identical input; not remote checkpoint migration."""
import hashlib,json,os,subprocess
from pathlib import Path
repo=Path.cwd();out=repo/'work/av-oom-v5-identity';out.mkdir(exist_ok=False)
entry='''import {readFileSync} from "node:fs";
import {projectFor,snapshotFor} from "../cloud-export/render";
import {projectPlan} from "../worker/templates/all-versions/render";
import {RENDER_VERSION} from "../worker/render/plan";
import {AV_RENDERER} from "../../src/domain/video/all-versions";
const input=JSON.parse(readFileSync(process.argv[2],"utf8"));
const job="00000000-0000-4000-8000-000000000001";
const snapshot=snapshotFor(input.spec,job,[{blobId:"clip",hash:input.hash,durationUs:15000000}]);
const project=projectFor(input.spec,job,snapshot,{blobId:"cover",hash:input.coverHash});
console.log(JSON.stringify({renderer:AV_RENDERER,worker:RENDER_VERSION,plans:[60,300].map(n=>{const p=projectPlan(project,snapshot,n);return {segmentFrames:n,hash:p.hash,segments:p.segments};})}));
'''
results={};env={k:v for k,v in os.environ.items() if k in ['PATH','LANG']}
for variant in ['baseline','B','C1']:
 src=repo/'work/av-oom-v5-build'/variant; f=src/'server/tests/identity-v5.ts';f.write_text(entry)
 bundle=out/(variant+'.mjs')
 subprocess.run([str(repo/'node_modules/.bin/esbuild'),'server/tests/identity-v5.ts','--bundle','--platform=node','--target=node24','--format=esm','--external:@napi-rs/canvas','--outfile='+str(bundle)],cwd=src,check=True)
 # Canvas external resolves from repo node_modules through the work output location.
 data=subprocess.check_output(['node',str(bundle),str(repo/'work/av-oom-v5/B3-1GB-r1/work/result/input.json')],env=env,text=True)
 results[variant]=json.loads(data)
checks={'B_same_as_baseline':results['B']==results['baseline'],'C1_same_as_baseline':results['C1']==results['baseline'],'segment_partition_changes_identity':results['baseline']['plans'][0]['hash']!=results['baseline']['plans'][1]['hash']}
r={'status':'PASS' if all(checks.values()) else 'FAIL','checks':checks,'results':results,'scope':'actual projectPlan, same synthetic input. Worker encoder/static/namespace augmentation source-reviewed separately; NOT proof of old remote checkpoint migration.'}
(repo/'docs/unified-worker/evidence/av-oom-v5/identity.json').write_text(json.dumps(r,indent=2)+'\n');print(checks);assert all(checks.values())
