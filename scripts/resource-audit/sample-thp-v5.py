#!/usr/bin/env python3
"""Offline synthetic diagnostic only. Never pass production commands or credentials.

Usage: python3 scripts/resource-audit/sample.py OUTPUT_DIR -- COMMAND [ARGS...]
Preserves all artifacts. Linux /proc sampled at 25ms; cgroup scope is explicit.
"""
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

out = Path(sys.argv[1]).resolve()
if sys.argv[2] != "--" or out.exists():
    raise SystemExit("Require a NEW isolated output directory and -- command")
command = sys.argv[3:]
allowed_entries = {"baseline.mjs", "candidate.mjs", "resource-audit-fixture.ts", "unified-resource-smoke.ts"}
if not command or Path(command[0]).name != "node" or not any(Path(arg).name in allowed_entries for arg in command[1:]):
    raise SystemExit("Only the documented offline Node fixtures are allowed")
if any(arg in {"-e", "--eval", "-p", "--print", "--require", "-r"} for arg in command[1:]):
    raise SystemExit("Inline code and require hooks are not diagnostic fixtures")
out.mkdir(parents=True, mode=0o700)
cg = Path("/sys/fs/cgroup")
cg_files = ["memory.current", "memory.peak", "memory.max", "memory.events",
            "memory.stat", "memory.swap.current", "memory.swap.max", "cpu.stat", "cpu.max"]

def cgroup():
    result = {}
    for name in cg_files:
        try:
            result[name] = (cg / name).read_text().strip()
        except OSError:
            result[name] = None
    return result

def disk():
    total = 0
    for root, dirs, files in os.walk(out):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                pass
    return total

# Explicit allowlist: never inherit DB URLs, provider credentials, NODE_OPTIONS hooks.
env = {k: os.environ[k] for k in ["PATH", "LANG", "LD_LIBRARY_PATH"] if k in os.environ}
env.update(NODE_OPTIONS="--max-old-space-size=128", VIDEO_RENDER_DISK=str(out / "media"),
           RESOURCE_AUDIT_DIR=str(out), HOME=str(out), TMPDIR=str(out), NODE_ENV="test")
static = os.environ.get("VIDEO_RENDER_STATIC_COMPOSITE", "false")
if static not in {"true", "false"}:
    raise SystemExit("VIDEO_RENDER_STATIC_COMPOSITE must be true or false")
env["VIDEO_RENDER_STATIC_COMPOSITE"] = static
(out / "effective-env.json").write_text(json.dumps({"VIDEO_RENDER_STATIC_COMPOSITE": static, "inheritedKeys": sorted(env)}) + "\n")
before = cgroup()
started = time.monotonic()
peaks = {"rss": 0, "pss": 0, "uss": 0, "disk": 0, "threads": 0}
by_program = {}
last_seen = {}
count = 0
with (out / "stdout.jsonl").open("w") as stdout, (out / "stderr.log").open("w") as stderr:
    child = subprocess.Popen(sys.argv[3:], env=env, stdout=stdout, stderr=stderr, start_new_session=True)
    with (out / "samples.jsonl").open("w") as samples:
        while child.poll() is None:
            processes = {}
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    raw = (entry / "stat").read_text()
                    fields = raw[raw.rfind(")") + 2:].split()
                    processes[int(entry.name)] = (int(fields[1]), fields, entry)
                except (OSError, ValueError):
                    pass
            ids = {child.pid}
            while True:
                more = {pid for pid, (parent, _, _) in processes.items() if parent in ids}
                if more <= ids:
                    break
                ids |= more
            rows = []
            for pid in ids:
                try:
                    _, fields, entry = processes[pid]
                    comm = (entry / "exe").resolve().name
                    kind = comm if comm in ["ffmpeg", "ffprobe", "node"] else "other"
                    status = {}
                    for line in (entry / "status").read_text().splitlines():
                        key, _, val = line.partition(":")
                        if key in ["VmRSS", "Threads"]:
                            status[key] = int(val.split()[0])
                    smaps = {}
                    try:
                        for line in (entry / "smaps_rollup").read_text().splitlines():
                            key, _, val = line.partition(":")
                            if key in ["Pss", "Private_Clean", "Private_Dirty", "Private_Hugetlb", "Anonymous", "AnonHugePages", "Swap"]:
                                smaps[key] = int(val.split()[0]) * 1024
                    except OSError:
                        pass
                    row = dict(pid=pid, startTicks=int(fields[19]), kind=kind, rss=status.get("VmRSS", 0) * 1024,
                               pss=smaps.get("Pss", 0), uss=sum(v for k, v in smaps.items() if k.startswith("Private_")),
                               threads=status.get("Threads", 0), cpuTicks=int(fields[11]) + int(fields[12]))
                    row["io"] = (entry / "io").read_text()
                    row["smaps"] = smaps
                    last_seen[pid] = row
                    rows.append(row)
                except (OSError, KeyError, ValueError):
                    pass
            for key in ["rss", "pss", "uss", "threads"]:
                peaks[key] = max(peaks[key], sum(r[key] for r in rows))
            for kind in ["ffmpeg", "ffprobe", "node"]:
                group = [r for r in rows if r["kind"] == kind]
                p = by_program.setdefault(kind, dict(rss=0, pss=0, uss=0, threads=0))
                for key in p:
                    p[key] = max(p[key], sum(r[key] for r in group))
            size = disk()
            peaks["disk"] = max(peaks["disk"], size)
            samples.write(json.dumps(dict(t=time.monotonic() - started, unixNs=time.time_ns(), processes=rows,
                                          cgroup=cgroup(), disk=size)) + "\n")
            count += 1
            time.sleep(0.025)
    code = child.wait()
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
report = dict(schema=1, cgroupScope="entire visible cgroup; NOT isolated unless run in a dedicated container",
              sampleIntervalMs=25, samples=count, peaks=peaks, byProgram=by_program,
              wallSeconds=time.monotonic() - started, cpuSeconds=usage.ru_utime + usage.ru_stime,
              exitCode=code if code >= 0 else None, signal=-code if code < 0 else None,
              cgroupBefore=before, cgroupAfter=cgroup(), diskFinal=disk(),
              limitations=["RSS double-counts shared pages", "sampled peaks miss short spikes",
                           "disk includes diagnostic logs", "PSS/USS zero may mean unavailable",
                           "CPU rusage includes waited descendants; daemonized children unsupported"])
(out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
raise SystemExit(code if code >= 0 else 128 - code)
