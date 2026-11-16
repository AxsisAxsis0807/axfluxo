#!/usr/bin/env python3
"""Fail-closed path evidence audit of real subprocess completions."""
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); records=[]
for p in sorted(root.glob('*/case.json')):
 c=json.loads(p.read_text()); r=p.parent/'result'; node=r/'node.jsonl'
 if not node.exists(): continue
 events=[json.loads(x) for x in node.read_text().splitlines()]
 closed={x['id']:x for x in events if x.get('event')=='close'}
 successful=lambda e:e.get('id') in closed and closed[e['id']].get('code')==0 and closed[e['id']].get('signal') is None
 spawns=[e for e in events if e.get('event')=='spawn']
 uses=[e for e in spawns if e.get('branch')=='static-use' and successful(e)]
 generates=[e for e in spawns if e.get('branch')=='static-generate' and successful(e)]
 segments=[json.loads(x) for x in (r/'segments.jsonl').read_text().splitlines()] if (r/'segments.jsonl').exists() else []
 encoded=[s for s in segments if s['event']=='encoded']
 expectedStatic=[s for s in encoded if s['eligible'] and s['enabled']=='true']
 effective=json.loads((r/'effective-node.json').read_text())
 errors=[]
 if effective['staticComposite']!=c['static']: errors.append('ENV_MISMATCH')
 if c['static']=='false' and (uses or generates): errors.append('OFF_ENTERED_STATIC')
 if len(uses)!=len(expectedStatic): errors.append('COMPLETION_MISMATCH')
 if c['static']=='true' and not uses: errors.append('INVALID_TEST_NO_COMPLETED_STATIC_PATH')
 if c['status']=='COMPLETED' and len(encoded)!=c['seconds']: errors.append('SEGMENT_COUNT_MISMATCH') # all selected versions are multiples of 5s, 60-frame segments
 record=dict(label=p.parent.name,status=c['status'],errors=errors,completedStaticUses=len(uses),completedPngGenerations=len(generates),reuseCount=sum(bool(s.get('cacheBefore')) for s in expectedStatic),completedDynamicSegments=[s['segment'] for s in encoded if s not in expectedStatic],completedStaticSegments=[s['segment'] for s in expectedStatic],failedChildren=[dict(id=e['id'],program=next((s['program'] for s in spawns if s['id']==e['id']),None),code=e.get('code'),signal=e.get('signal')) for e in events if e.get('event')=='close' and (e.get('code')!=0 or e.get('signal'))])
 records.append(record)
(root/'path-verification.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps(records,indent=2))
