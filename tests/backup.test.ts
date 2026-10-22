import {it,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {safeUnzip} from '../src/services/backup';
it('accepts whitelisted entries and rejects traversal, external references and truncation',()=>{const data={'document.json':strToU8('{"ok":true}'),'manifest.json':strToU8('{}')};expect(Object.keys(safeUnzip(zipSync(data)))).toEqual(['document.json','manifest.json']);for(const name of ['../document.json','/document.json','assets/../../secret','https://example.com/pic','assets/a\\b.png'])expect(()=>safeUnzip(zipSync({[name]:strToU8('bad')}))).toThrow();expect(()=>safeUnzip(zipSync(data).slice(0,30))).toThrow();});
