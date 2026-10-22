import 'fake-indexeddb/auto';
import {describe,it,expect} from 'vitest';
import {saveProject,get,ConflictError,all,SaveQueue} from '../src/services/storage';
import {newProject} from '../src/domain/document';
describe('IndexedDB CAS',()=>{it('does not silently overwrite another tab and preserves recovery revisions',async()=>{const d=newProject();await saveProject(d,null);const a={...d,revision:1,name:'tab A'};await saveProject(a,0);await expect(saveProject({...d,revision:1,name:'tab B'},0)).rejects.toBeInstanceOf(ConflictError);expect((await get<typeof d>('projects',d.id))?.name).toBe('tab A');expect((await all('revisions')).length).toBeGreaterThan(0);});it('serial queue survives errors in previous writes',async()=>{const q=new SaveQueue();const result:number[]=[];await expect(q.enqueue(async()=>{throw Error('quota');})).rejects.toThrow('quota');await q.enqueue(async()=>{result.push(1);});expect(result).toEqual([1]);});});
