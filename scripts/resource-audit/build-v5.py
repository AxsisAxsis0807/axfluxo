#!/usr/bin/env python3
"""Rebuild v5 diagnostic images in a NEW work directory; never production images."""
import hashlib,json,shutil,subprocess
from pathlib import Path
repo=Path.cwd();evidence=repo/'docs/unified-worker/evidence/av-oom-v5'
def run(*args):subprocess.run(args,check=True)
run('python3','scripts/resource-audit/prepare-v5.py')
bundles=repo/'work/av-oom-v5-build';runtime=repo/'work/resource-audit';runtime.mkdir(parents=True,exist_ok=False)
for old,new in [('baseline','baseline'),('B','candidate')]:shutil.copyfile(bundles/(old+'.mjs'),runtime/(new+'.mjs'))
run('python3','scripts/resource-audit/pack-runtime.py')
context=runtime/'runtime-context';root=context/'rootfs'
for source,target in [('sample-v5.py','sample.py'),('preload-v4.mjs','preload-v4.mjs')]:
 p=root/'app'/target;shutil.copyfile(repo/'scripts/resource-audit'/source,p);p.chmod(0o644)
f=context/'Dockerfile';f.write_text(f.read_text().replace('/app/preload.mjs','/app/preload-v4.mjs'))
run('docker','build','--network=none','-t','axfluxo-av-oom-v5:baseline',str(context))
run('node_modules/.bin/esbuild','server/tests/resource-phase-v5.ts','--bundle','--platform=node','--target=node24','--format=esm','--external:@napi-rs/canvas','--outfile='+str(bundles/'phase.mjs'))
for variant in ['B','C1','B-reuse','phase']:
 d=bundles/('image-'+variant);d.mkdir();shutil.copyfile(bundles/(variant+'.mjs'),d/'baseline.mjs')
 (d/'Dockerfile').write_text('FROM axfluxo-av-oom-v5:baseline\nCOPY --chmod=644 baseline.mjs /app/baseline.mjs\n')
 if variant=='phase':
  shutil.copyfile(repo/'scripts/resource-audit/sample-thp-v5.py',d/'sample.py')
  with (d/'Dockerfile').open('a') as f:f.write('COPY --chmod=644 sample.py /app/sample.py\n')
 run('docker','build','--network=none','-t','axfluxo-av-oom-v5:'+variant,str(d))
d=bundles/'image-B-thp';d.mkdir();shutil.copyfile(repo/'scripts/resource-audit/sample-thp-v5.py',d/'sample.py')
(d/'Dockerfile').write_text('FROM axfluxo-av-oom-v5:B\nCOPY --chmod=644 sample.py /app/sample.py\n')
run('docker','build','--network=none','-t','axfluxo-av-oom-v5:B-thp',str(d))
images={}
for tag in ['baseline','B','C1','B-reuse','phase','B-thp']:
 item=json.loads(subprocess.check_output(['docker','image','inspect','axfluxo-av-oom-v5:'+tag],text=True))[0]
 images[tag]={k:item.get(k) for k in ['Id','RepoDigests','Created','Architecture','Os','RootFS']};images[tag]['config']={k:item['Config'].get(k) for k in ['User','Entrypoint','Cmd','WorkingDir']};images[tag]['registryManifestDigest']=None
(evidence/'images.json').write_text(json.dumps(images,indent=2)+'\n')
manifest={str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.rglob('*') if p.is_file()}
(evidence/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
p=evidence/'build.json';m=json.loads(p.read_text());m['bundles']['B-thp']=m['bundles']['B'];m['fullJobThpSamplerSha256']=hashlib.sha256((repo/'scripts/resource-audit/sample-thp-v5.py').read_bytes()).hexdigest();m['bundles']['phase']=hashlib.sha256((bundles/'phase.mjs').read_bytes()).hexdigest();m['phaseSamplerSha256']=hashlib.sha256((repo/'scripts/resource-audit/sample-thp-v5.py').read_bytes()).hexdigest();p.write_text(json.dumps(m,indent=2)+'\n')
