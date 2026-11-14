// Offline synthetic verification. Never reads user files or contacts any provider.
import {createHash} from 'node:crypto';
import {createSha256} from '../src/domain/cloud-export/sha256';
const size=Number(process.argv[2]??1700000000);
if(!Number.isSafeInteger(size)||size<1||size>2147483648)throw Error('Invalid synthetic byte count');
const block=Buffer.alloc(65536,1),software=createSha256(),native=createHash('sha256');
const started=performance.now();let received=0,peak=process.memoryUsage().rss;
while(received<size){const bytes=block.subarray(0,Math.min(block.length,size-received));software.update(bytes);native.update(bytes);received+=bytes.length;if(received%16777216===0)peak=Math.max(peak,process.memoryUsage().rss);}
const expected=native.digest('hex');if(software.digest()!==expected)throw Error('Streaming SHA-256 mismatch');
process.stdout.write(JSON.stringify({syntheticBytes:received,bufferBytes:block.length,sha256:expected,peakRssBytes:peak,seconds:(performance.now()-started)/1000})+'\n');
