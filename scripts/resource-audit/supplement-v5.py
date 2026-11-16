#!/usr/bin/env python3
"""Matched-input baseline gaps plus bounded 15s failure probes; never longer 512MB work."""
import subprocess

def run(label,memory,seconds,titles,image,experiment='normal'):
 subprocess.run(['python3','scripts/resource-audit/oom-v5.py',label,'--memory',str(memory),'--seconds',str(seconds),'--titles',str(titles),'--static','true','--image','axfluxo-av-oom-v5:'+image,'--experiment',experiment],check=True)
run('base-5-1GB-r1',1000000000,5,1,'baseline')
run('base-B2-1GB-r1',1000000000,15,1,'baseline')
# Baseline creates identical-content PNGs per interval; B4 actually reuses the same PNG paths.
run('base-B4-1GB-r1',1000000000,15,3,'baseline','reuse')
# Same completed 1GB fixtures first. These sandboxed OOM probes cannot affect a production job.
run('B2-512000000-r1',512000000,15,1,'B')
run('B4-512000000-r1',512000000,15,3,'B','reuse')
