#!/usr/bin/env python3
"""Compare completed offline pairs, fully decoding video/audio without raw files."""
import hashlib,json,subprocess,sys
from pathlib import Path
left,right,out=map(Path,sys.argv[1:])
def run(*args): return subprocess.check_output(args)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def inspect(root):
    path=root/'result/media/candidate.mp4'
    probe=json.loads(run('ffprobe','-v','error','-show_streams','-show_format','-show_frames','-of','json',str(path)))
    frames=run('ffmpeg','-v','error','-xerror','-threads','1','-i',str(path),'-map','0:v:0','-fps_mode','passthrough','-f','framehash','-hash','sha256','-')
    audio=run('ffmpeg','-v','error','-xerror','-threads','1','-i',str(path),'-map','0:a:0','-f','s16le','-')
    return dict(mp4Sha256=sha(path),size=path.stat().st_size,probe=probe,frameHashText=frames.decode(),audioPcmSha256=hashlib.sha256(audio).hexdigest(),audioPcmBytes=len(audio))
a,b=inspect(left),inspect(right)
inputsEqual=(left/'result/input.json').read_bytes()==(right/'result/input.json').read_bytes()
r=dict(left=str(left),right=str(right),inputEqual=inputsEqual,leftEvidence=a,rightEvidence=b,
 mp4Equal=a['mp4Sha256']==b['mp4Sha256'],decodedFramesEqual=a['frameHashText']==b['frameHashText'],audioPcmEqual=a['audioPcmSha256']==b['audioPcmSha256'])
if not r['decodedFramesEqual']:
    for metric in ['psnr','ssim']:
        cmd=['ffmpeg','-v','info','-threads','1','-i',str(left/'result/media/candidate.mp4'),'-threads','1','-i',str(right/'result/media/candidate.mp4'),'-filter_complex_threads','1','-lavfi',metric,'-an','-f','null','-']
        result=subprocess.run(cmd,capture_output=True,text=True,check=True)
        r[metric]=result.stderr.splitlines()[-1]
r['status']='PASS_EXACT' if inputsEqual and r['decodedFramesEqual'] and r['audioPcmEqual'] else 'HOLD_DIFFERENCE'
out.write_text(json.dumps(r,indent=2)+'\n'); print(json.dumps({k:v for k,v in r.items() if k not in ['leftEvidence','rightEvidence']}))
