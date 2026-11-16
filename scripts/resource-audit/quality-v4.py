#!/usr/bin/env python3
"""Full decode/PTS/PCM equality. Raw frame hashes retained locally; compact evidence committed."""
import hashlib,json,subprocess,sys
from pathlib import Path
left,right,destination=sys.argv[1:]; root=Path('work/av-fade-v4')
def sha(b): return hashlib.sha256(b).hexdigest()
def inspect(label):
 directory=root/label/'work/result'; path=directory/'media/candidate.mp4'
 def run(*args): return subprocess.check_output(args)
 probe=json.loads(run('ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)))
 frames=run('ffmpeg','-v','error','-xerror','-threads','1','-i',str(path),'-map','0:v:0','-fps_mode','passthrough','-f','framehash','-hash','sha256','-')
 pcm=run('ffmpeg','-v','error','-xerror','-threads','1','-i',str(path),'-map','0:a:0','-f','s16le','-')
 (directory/'quality-framehash.txt').write_bytes(frames)
 lines=[l for l in frames.decode().splitlines() if not l.startswith('#')]
 pts='\n'.join(','.join(l.split(',')[:5]) for l in lines)
 audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
 result=dict(label=label,mp4Sha256=sha(path.read_bytes()),bytes=path.stat().st_size,decodedFrameHashSha256=sha(frames),frames=len(lines),ptsDurationSha256=sha(pts.encode()),audioPcmSha256=sha(pcm),audioBytes=len(pcm),audioSamples=len(pcm)//(2*audio['channels']),probe=probe,input=json.loads((directory/'input.json').read_text()))
 return result
l,r=inspect(left),inspect(right); checks={k:l[k]==r[k] for k in ['mp4Sha256','decodedFrameHashSha256','frames','ptsDurationSha256','audioPcmSha256','audioSamples','input']}
result=dict(left=l,right=r,checks=checks,status='PASS_EXACT' if all(checks.values()) else 'HOLD_DIFFERENCE',scope='full synthetic job only; no production approval')
Path(destination).write_text(json.dumps(result,indent=2)+'\n');print(left,right,result['status'])
raise SystemExit(0 if all(checks.values()) else 1)
