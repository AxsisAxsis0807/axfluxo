#!/usr/bin/env python3
"""Serial matrix. Repeated 1GB B3 controls bracket exploratory factors; no deployment."""
import subprocess,json
from pathlib import Path
cases=[
 ('B3-1GB-r1',15,3,'true','B','normal',60,False),
 ('B2-1GB-r1',15,1,'true','B','normal',60,False),
 ('B4-1GB-r1',15,3,'true','B','reuse',60,False),
 ('B5-1GB-r1',15,3,'true','B','clear',60,False),
 ('B6-off-1GB-r1',15,3,'false','B','normal',60,False),
 ('B8-300-1GB-r1',15,3,'true','B','normal',300,False),
 ('C1-1GB-r1',15,3,'true','C1','normal',60,False),
 ('B3-1GB-r2',15,3,'true','B','normal',60,False),
 ('C1-1GB-r2',15,3,'true','C1','normal',60,False),
 ('B3-1GB-r3',15,3,'true','B','normal',60,False),
 ('C1-1GB-r3',15,3,'true','C1','normal',60,False),
 ('base-15-1GB-r1',15,3,'true','baseline','normal',60,False),
 ('B-30-1GB-r1',30,3,'true','B','normal',60,False),
 ('base-30-1GB-r1',30,3,'true','baseline','normal',60,False),
 ('B-ref-1GB-r1',15,3,'true','B','normal',60,False),
 ('base-ref-1GB-r1',15,3,'true','baseline','normal',60,False),
 ('B-shift-1GB-r1',15,3,'true','B','normal',60,True),
 ('base-shift-1GB-r1',15,3,'true','baseline','normal',60,True),
]
for label,seconds,titles,static,image,experiment,segment,boundary in cases:
 cmd=['python3','scripts/resource-audit/oom-v5.py',label,'--memory','1000000000','--seconds',str(seconds),'--titles',str(titles),'--static',static,'--image','axfluxo-av-oom-v5:'+image,'--experiment',experiment,'--segment',str(segment)]
 if '-ref-' in label: cmd+=['--layout','reference-pasa-v1']
 if boundary: cmd+=['--boundary']
 subprocess.run(cmd,check=True)
# Each container is fresh. Stop longer 512MB cases at the first actual 15s failure.
for limit in [512000000,536870912]:
 for rep in range(1,4):
  subprocess.run(['python3','scripts/resource-audit/oom-v5.py',f'B1-{limit}-r{rep}','--memory',str(limit),'--image','axfluxo-av-oom-v5:B','--static','true'],check=True)
 label=f'B3-{limit}-r1'
 subprocess.run(['python3','scripts/resource-audit/oom-v5.py',label,'--memory',str(limit),'--seconds','15','--titles','3','--image','axfluxo-av-oom-v5:B','--static','true'],check=True)
 # No 30s/ref/boundary constrained runs in this root-cause matrix; qualification stays HOLD.
