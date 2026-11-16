#!/usr/bin/env python3
"""Compare live timer crops against independently specified literal clock templates.
This is pixel-template evidence, not OCR, and does not modify the renderer.
"""
import hashlib,json,subprocess,sys
from pathlib import Path
case=Path(sys.argv[1]); out=Path(sys.argv[2]); media=case/'result/media'
frames=[60,65,66,120,180,360,366,660,666]
def ff(*args): return subprocess.check_output(['ffmpeg','-v','error','-threads','1',*args])
select='+'.join(f'eq(n,{n})' for n in frames)
actual=ff('-i',str(media/'candidate.mp4'),'-vf',f"select='{select}',crop=300:70:810:914,format=rgb24",'-fps_mode','passthrough','-f','rawvideo','-')
templates={}
font=Path('server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf').resolve()
for value in range(1,6):
    graph=f"drawtext=fontfile={font}:text='00\\:{value:02d}':fontsize=30:fontcolor=white:x=(w-text_w)/2:y=945-text_h/2:alpha=0.85,format=yuv420p,crop=300:70:810:914,format=rgb24"
    templates[value]=ff('-i',str(media/'background.png'),'-vf',graph,'-frames:v','1','-f','rawvideo','-')
size=300*70*3
assert len(actual)==size*len(frames)
rows=[]
for i,frame in enumerate(frames):
    crop=actual[i*size:(i+1)*size]
    costs={value:sum(abs(a-b) for a,b in zip(crop,template))/size for value,template in templates.items()}
    expected=1+max(0,frame%300-6)//60
    best=min(costs,key=costs.get)
    rows.append(dict(frame=frame,expected=f'00:{expected:02d}',bestLiteral=f'00:{best:02d}',meanAbsolutePixelErrors=costs,match=expected==best,cropSha256=hashlib.sha256(crop).hexdigest()))
report=dict(method='literal drawtext templates, same font/geometry/alpha, independently specified clock strings; codec error retained',fontSha256=hashlib.sha256(font.read_bytes()).hexdigest(),rows=rows,status='PASS' if all(r['match'] for r in rows) else 'HOLD')
out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
