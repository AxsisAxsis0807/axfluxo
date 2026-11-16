#!/usr/bin/env python3
"""Serial offline Docker matrix. Keeps containers, input, MP4 and diagnostics.

python3 scripts/resource-audit/run.py OUTPUT_DIR [--quick]
Requires the diagnostic image built by pack-runtime.py. No deployment/provider use.
"""
import os
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import sys
import time

# v3 is an explicit single-case runner with exact decimal/binary limits.
# The historical v2 matrix below is retained, not used as v3 evidence.
if len(sys.argv) > 1 and sys.argv[1] == "--static-v3":
    os.execv(sys.executable, [sys.executable, str(Path(__file__).with_name("static-v3.py")), *sys.argv[2:]])

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
quick = "--quick" in sys.argv[2:]
profiles = {"U": 2147483648, "M": 1000000000, "S": 536870912}
fixtures = [("legacy", 1, "simple", 1, 60), ("unified", 1, "simple", 1, 60),
            ("render", 1, "simple", 1, 60), ("fnf", 1, "simple", 1, 60)]
if not quick:
    fixtures += [(mode, sec, bg, titles, seg) for mode, sec, bg, titles, seg in [
        ("legacy", 5, "complex", 3, 60), ("unified", 5, "complex", 3, 60),
        ("render", 5, "complex", 3, 60), ("fnf", 5, "simple", 1, 60),
        ("legacy", 30, "complex", 3, 300), ("unified", 30, "complex", 3, 300),
        ("render", 30, "complex", 3, 300)]]
if "--extended-only" in sys.argv[2:]:
    fixtures = [f for f in fixtures if f[1] > 1]
    profiles = {k: v for k, v in profiles.items() if k != "S"}
image = subprocess.check_output(["docker", "image", "inspect", "axfluxo-resource-audit:local", "--format", "{{.Id}}"], text=True).strip()
manifest = dict(image=image, baseline="81d6c739a797e95386855ad1b78313a88e9b1077",
                candidateGit=subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
                bundles={name: hashlib.sha256(Path("work/resource-audit/" + name + ".mjs").read_bytes()).hexdigest()
                         for name in ["baseline", "candidate"]}, cpuLimit=1, swap="disabled: memory-swap equals memory",
                profiles=profiles, kind="synthetic offline render; no DB/publish/provider", results=[])
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
prefix = "axfluxo-audit-" + str(int(time.time()))
for profile, limit in profiles.items():
    for fixture in fixtures:
        mode, sec, bg, titles, seg = fixture
        if profile == "S" and sec > 1:
            continue  # the short 512MiB probe must be reviewed before escalation
        # Longer tests follow the 1-second U/M/S observations; never escalate
        # memory or change encoding to mask a failure.
        for version in ["baseline", "candidate"]:
            for repeat in range(1, (2 if sec == 1 else 1) + 1):
                label = f"{profile}-{mode}-{sec}-{bg}-{titles}-{seg}-{version}-{repeat}"
                # Preserve originals, MP4s and checkpoints even under pressure.
                # Docker's backing store may be on the workspace filesystem.
                free = min(shutil.disk_usage(out).free, shutil.disk_usage(Path.cwd()).free)
                reserve = 2 * 1024 ** 3 if sec == 30 else 512 * 1024 ** 2
                if free < reserve + sec * 8 * 1024 ** 2:
                    manifest["results"].append(dict(label=label, status="BLOCKED_DISK", freeBytes=free, requiredFreeBytes=reserve + sec * 8 * 1024 ** 2))
                    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
                    print(label, "BLOCKED_DISK", flush=True)
                    continue
                directory = out / label
                directory.mkdir()
                name = prefix + "-" + label.lower()
                cmd = ["docker", "create", "--name", name, "--network", "none", "--cpus", "1",
                       "--memory", str(limit), "--memory-swap", str(limit), "--pids-limit", "128",
                       "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--label", "axfluxo.offline-audit=v2",
                       image, "/app/" + version + ".mjs", mode, str(sec), bg, str(titles), str(seg)]
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
                with (directory / "container.log").open("w") as log:
                    status = subprocess.run(["docker", "start", "-a", name], stdout=log, stderr=subprocess.STDOUT)
                state = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .State}}", name], text=True))
                copied = subprocess.run(["docker", "cp", name + ":/work/result", str(directory / "result")],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                record = dict(label=label, container=name, profile=profile, version=version, fixture=fixture,
                              repeat=repeat, artifactCopyExit=copied.returncode, dockerStartExit=status.returncode,
                              state={k: state[k] for k in ["ExitCode", "OOMKilled", "Error"]})
                manifest["results"].append(record)
                (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
                print(label, state["ExitCode"], flush=True)
