#!/usr/bin/env python3
"""Package trusted LOCAL Linux binaries for network-free diagnostic Docker tests.

Not the production image. Requires Linux x86_64, /usr/bin/python3.13, ldd,
ffmpeg, ffprobe, node, npm dependencies and prebuilt baseline/candidate.mjs.
No credentials, network configuration or home directories are copied.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess

repo = Path.cwd()
dest = repo / "work/resource-audit/runtime-context"
dest.mkdir(parents=True, exist_ok=False)
root = dest / "rootfs"
root.mkdir()

def copy(src, target=None):
    src = Path(src)
    dst = root / (target or str(src)).lstrip("/")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst, follow_symlinks=True)

def binary(src, target=None):
    copy(src, target)
    listing = subprocess.check_output(["ldd", str(src)], text=True)
    for library in re.findall(r"(?:=>\s+)?(/[^\s]+)", listing):
        copy(library)

for name in ["node", "ffmpeg", "ffprobe"]:
    binary(shutil.which(name), "/usr/bin/" + name)
binary("/usr/bin/python3.13", "/usr/bin/python3")
copy("/usr/lib/python3.13")
for directory in ["/etc/fonts", "/usr/share/fonts"]:
    if Path(directory).exists():
        copy(directory)
for name in ["canvas", "canvas-linux-x64-gnu"]:
    source = repo / "node_modules/@napi-rs" / name
    copy(source, "/app/node_modules/@napi-rs/" + name)
    for native in source.glob("*.node"):
        binary(native, "/app/node_modules/@napi-rs/" + name + "/" + native.name)
for name in ["baseline.mjs", "candidate.mjs"]:
    copy(repo / "work/resource-audit" / name, "/app/" + name)
for name in ["sample.py", "preload.mjs"]:
    copy(repo / "scripts/resource-audit" / name, "/app/" + name)
for name in ["all-versions", "fnf-showcase"]:
    source = repo / "server/worker/templates" / name / "assets"
    copy(source, "/app/server/worker/templates/" + name + "/assets")
(root / "work").mkdir(mode=0o777)
for path in root.rglob("*"):
    if path.is_dir():
        path.chmod(0o755)
    else:
        path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
root.chmod(0o755)
os.chmod(root / "work", 0o777)
(dest / "Dockerfile").write_text('''FROM scratch
COPY rootfs/ /
WORKDIR /app
ENV PATH=/usr/bin LANG=C HOME=/work TMPDIR=/work
USER 1000:1000
ENTRYPOINT ["python3", "/app/sample.py", "/work/result", "--", "node", "--import", "/app/preload.mjs"]
''')
print(dest)
