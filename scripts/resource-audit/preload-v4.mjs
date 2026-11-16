// Offline v4 observation only; no argv rewriting.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const original = cp.spawn;
cp.spawn = function(program, args, options) {
  const child = original.call(this, program, args, options);
  if (['ffmpeg', 'ffprobe'].includes(program)) {
    const file = join(process.env.RESOURCE_AUDIT_DIR, 'argv-v4.jsonl');
    const write = row => appendFileSync(file, JSON.stringify({t:performance.now(),pid:child.pid,...row})+'\n');
    write({event:'spawn',program,args});
    let tail = '';
    child.stderr?.on('data', b => { tail = (tail+b.toString()).slice(-32768); });
    child.once('close', (code, signal) => write({event:'close',code,signal,stderrTail:tail}));
  }
  return child;
};
syncBuiltinESMExports();
await import('./preload.mjs');
