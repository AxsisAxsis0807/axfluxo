#!/usr/bin/env python3
"""Build offline v5 bundles from an immutable v4 source; production tree untouched."""
import argparse,hashlib,json,subprocess,tarfile,io
from pathlib import Path
BASE="de971898af831156c17db09090fa5fd57e52c8f1"
parser=argparse.ArgumentParser(); parser.add_argument('--output',default='work/av-oom-v5-build'); parser.add_argument('--evidence',default='docs/unified-worker/evidence/av-oom-v5'); args=parser.parse_args()
repo=Path.cwd(); out=repo/args.output; out.mkdir(parents=True,exist_ok=False); evidence=repo/args.evidence; evidence.mkdir(parents=True,exist_ok=True)
manifest={'source':BASE,'bundles':{}}
for variant in ['baseline','B','C1','B-reuse']:
 root=out/variant; root.mkdir()
 data=subprocess.check_output(['git','archive',BASE])
 with tarfile.open(fileobj=io.BytesIO(data)) as t: t.extractall(root,filter='data')
 (root/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
 if variant!='baseline':
  with (repo/'docs/unified-worker/evidence/av-fade-v4/candidate-B.patch').open() as f:
   subprocess.run(['patch','-p1','--batch','--forward'],cwd=root,stdin=f,check=True)
 fixture=root/'server/tests/resource-audit-fixture.ts'; text=fixture.read_text()
 text=text.replace('boundaryMode = "equal",','boundaryMode = "equal",\n  experiment = "normal",')
 text=text.replace('`Synthetic ${i + 1}`','`Synthetic ${experiment === "reuse" ? 1 : i + 1}`')
 needle='      const versionStart = intervals[version].startFrame;'
 text=text.replace(needle,needle+\
 '\n      if (experiment === "clear" && segment.outputStartFrame === versionStart) { graphics?.texts.clear(); graphics?.staticComposites.clear(); await stage("cache-map-clear-files-preserved"); }')
 fixture.write_text(text)
 if variant=='B-reuse':
  text=text.replace(needle, needle+'\n      if (experiment === "reuse" && version > 0 && segment.outputStartFrame === versionStart) { const t = graphics?.texts.get(0); if (t) graphics!.texts.set(version, t); const c = graphics?.staticComposites.get(0); if (c) graphics!.staticComposites.set(version, c); }')
  fixture.write_text(text)
 if variant=='C1':
  graphics=root/'server/worker/templates/all-versions/graphics.ts'; g=graphics.read_text()
  g=g.replace('return canvas.encode("png");','const png = await canvas.encode("png");\n  canvas.width = 1; canvas.height = 1;\n  return png;')
  graphics.write_text(g)
 # esbuild relative paths are intentional for stable bundled source labels.
 subprocess.run([str(repo/'node_modules/.bin/esbuild'),'server/tests/resource-audit-fixture.ts','--bundle','--platform=node','--target=node24','--format=esm','--external:@napi-rs/canvas','--outfile='+str(out/(variant+'.mjs'))],cwd=root,check=True)
 manifest['bundles'][variant]=hashlib.sha256((out/(variant+'.mjs')).read_bytes()).hexdigest()
 if variant=='C1':
  (evidence/'C1.patch').write_text(subprocess.run(['git','diff','--no-index',str(out/'B/server/worker/templates/all-versions/graphics.ts'),str(graphics)],capture_output=True,text=True).stdout.replace(str(out/'B').lstrip('/')+'/', '').replace(str(out/'C1').lstrip('/')+'/', ''))
(evidence/'build.json').write_text(json.dumps(manifest,indent=2)+'\n')
