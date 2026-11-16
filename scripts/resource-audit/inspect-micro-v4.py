#!/usr/bin/env python3
"""Check raw pixels and encoder log observations; no allocator attribution."""
import hashlib,json,re,subprocess
from pathlib import Path
root=Path('work/av-fade-v4');out=Path('docs/unified-worker/evidence/av-fade-v4')
def sha(b):return hashlib.sha256(b).hexdigest()
pixels={}
for name in ['background','text-0']:
 png=root/'B2-off-r2/work/result/media'/f'{name}.png'
 decoded=subprocess.check_output(['ffmpeg','-v','error','-threads','1','-i',str(png),'-pix_fmt','rgba','-f','rawvideo','-'])
 raw=(root/'M-full-raw/work'/f'{name}.rgba').read_bytes()
 pixels[name]=dict(ffmpegPngDecodedSha256=sha(decoded),canvasRawSha256=sha(raw),bytes=len(raw),equal=decoded==raw)
rows=[]
for label in ['M-full-encode','M-full-filterloop','M-full-queue1','M-full-raw','M-full-crop','M-full-raw-ready','M-full-crop-ready','M-full-encode-512','M-filterloop-512']:
 p=root/label/'work/result'; log=(p/'stderr.log').read_text(); mp4=p/'micro.mp4'
 summary=json.loads((p/'summary.json').read_text()); complete=summary['exitCode']==0
 rows.append(dict(label=label,outputComplete=complete,processExit=summary['exitCode'],mp4Sha256=sha(mp4.read_bytes()) if mp4.exists() and complete else None,partialFileSha256=sha(mp4.read_bytes()) if mp4.exists() and not complete else None,observations=[line for line in log.splitlines() if 'frames decoded' in line or 'frames encoded' in line or 'options: cabac' in line],lastProgress=[line for line in log.splitlines() if line.startswith(('frame=','out_time=','progress='))][-12:]))
report=dict(rawPixels=pixels,cases=rows,rawIsolationValidity='SAME_PIXELS' if all(x['equal'] for x in pixels.values()) else 'INVALID_RAW_PIXELS_DIFFER',limitations=['No direct allocator tracing','Canvas-prepared and pre-generated-input variants are separate','Microbench is not complete-job/quality/recovery evidence'])
(out/'micro-observations.json').write_text(json.dumps(report,indent=2)+'\n');print(report['rawIsolationValidity'])
