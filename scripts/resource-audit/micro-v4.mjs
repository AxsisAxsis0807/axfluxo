// Cause-isolation microbench. Never used as finished-job equivalence evidence.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const mode=process.argv[2];
const input = file => ['-threads','1','-loop','1','-framerate','60','-i','/work/'+file];
const prefix=['-nostdin','-xerror','-filter_complex_threads','1','-filter_threads','1','-progress','pipe:2','-stats_period','0.05'];
const enc=['-c:v','libx264','-crf','18','-preset','medium','-pix_fmt','yuv420p','-threads:v','2','-r:v','60','-fps_mode:v','cfr','-video_track_timescale','60000','-bf','0','-map_metadata','-1'];
const color='format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const fade='format=rgba,setpts=PTS+0/TB,fade=t=in:st=0:d=0.15:alpha=1,fade=t=out:st=4.85:d=0.15:alpha=1,setpts=PTS-0/TB';
let inputs=input('background.png'), graph='[0:v]null[v]', encode=false;
if(mode.startsWith('text-')) inputs=input('text-0.png');
if(mode==='bg-single') inputs=['-threads','1','-framerate','60','-i','/work/background.png'];
if(mode==='text-rgba') graph='[0:v]format=rgba[v]';
if(mode==='text-pts') graph='[0:v]format=rgba,setpts=PTS+0/TB,setpts=PTS-0/TB[v]';
if(mode==='text-fade') graph='[0:v]'+fade+'[v]';
if(mode.startsWith('overlay')||mode.startsWith('full')) {
 inputs=[...input('background.png'),...input('text-0.png')];
 graph=mode.startsWith('full')?'[1:v]'+fade+'[text];[0:v][text]overlay=shortest=1:format=auto':'[0:v][1:v]overlay=shortest=1:format=auto';
 graph+=(mode==='overlay-yuv'||mode.startsWith('full')?','+color:'')+'[v]';
 encode=mode==='full-encode'||mode==='full-filterloop'||mode==='full-queue1'||mode==='full-raw'||mode==='full-crop'||mode==='full-raw-ready'||mode==='full-crop-ready';
}
if(mode==='bg-encode'){ graph='[0:v]'+color+'[v]'; encode=true; }
if(mode==='full-filterloop'||mode==='full-crop') {
 inputs=['-threads','1','-framerate','60','-i','/work/background.png','-threads','1','-framerate','60','-i','/work/text-0.png'];
 graph='[0:v]loop=loop=-1:size=1:start=0,setpts=N/(60*TB)[bg];[1:v]loop=loop=-1:size=1:start=0,setpts=N/(60*TB),'+fade+'[text];[bg][text]overlay=shortest=1:format=auto,'+color+'[v]';
}
if(mode==='full-crop') {
 const {loadImage,createCanvas}=await import('/app/node_modules/@napi-rs/canvas/index.js');
 const canvas=createCanvas(1920,1080),ctx=canvas.getContext('2d'); ctx.drawImage(await loadImage('/work/text-0.png'),0,0);
 const data=ctx.getImageData(0,0,1920,1080).data; let x0=1920,y0=1080,x1=0,y1=0;
 for(let y=0;y<1080;y++) for(let x=0;x<1920;x++) if(data[(y*1920+x)*4+3]) { x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
 graph=graph.replace('[1:v]loop=',`[1:v]crop=w=${x1-x0+1}:h=${y1-y0+1}:x=${x0}:y=${y0},loop=`).replace('overlay=shortest',`overlay=x=${x0}:y=${y0}:shortest`);
}
if(mode==='full-raw-ready') inputs=['background','text-0'].flatMap(name=>['-threads','1','-stream_loop','-1','-f','rawvideo','-pixel_format','rgba','-video_size','1920x1080','-framerate','60','-i','/work/'+name+'.rgba']);
if(mode==='full-crop-ready') { const old=JSON.parse(readFileSync('/work/crop.json','utf8'));graph=old.args[old.args.indexOf('-filter_complex')+1]; inputs=['-threads','1','-framerate','60','-i','/work/background.png','-threads','1','-framerate','60','-i','/work/text-0.png']; }
if(mode==='full-raw') {
 const {loadImage,createCanvas}=await import('/app/node_modules/@napi-rs/canvas/index.js');
 for(const name of ['background','text-0']) {
  const canvas=createCanvas(1920,1080); const ctx=canvas.getContext('2d');
  ctx.drawImage(await loadImage('/work/'+name+'.png'),0,0);
  writeFileSync('/work/'+name+'.rgba',Buffer.from(ctx.getImageData(0,0,1920,1080).data));
 }
 inputs=['background','text-0'].flatMap(name=>['-threads','1','-stream_loop','-1','-f','rawvideo','-pixel_format','rgba','-video_size','1920x1080','-framerate','60','-i','/work/'+name+'.rgba']);
}
if(mode==='full-queue1') inputs=inputs.flatMap(v=>v==='-threads'?['-thread_queue_size','1',v]:[v]);
const args=mode==='init'?['-version']:[...prefix,...inputs,'-filter_complex',graph,'-map','[v]','-an','-frames:v','60',...(encode?[...enc,'-y','/work/result/micro.mp4']:['-f','null','-'])];
writeFileSync('/work/result/micro.json',JSON.stringify({mode,args,inputs:['background.png','text-0.png'].map(f=>({file:f,sha256:createHash('sha256').update(readFileSync('/work/'+f)).digest('hex')}))}));
const child=spawn('ffmpeg',['-v','verbose','-protocol_whitelist','file,pipe',...args],{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/bin',LANG:'C'}});
child.stderr.pipe(process.stderr);
child.on('close',(code,signal)=>{console.log(JSON.stringify({code,signal}));process.exitCode=code??1;});
