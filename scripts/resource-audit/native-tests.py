#!/usr/bin/env python3
"""Dedicated password-authenticated loopback PostgreSQL17; no production URLs.
Creates and preserves a named container/volume. Stops DB after tests, never removes it.
Usage: python3 scripts/resource-audit/native-tests.py OUTPUT_DIR [REPO ...]
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
name = "axfluxo-audit-db-" + str(int(time.time()))
env = dict(os.environ, POSTGRES_PASSWORD=secrets.token_urlsafe(32))
subprocess.run(["docker", "run", "-d", "--name", name, "--memory", "536870912", "--memory-swap", "536870912",
                "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD", "postgres:17"], env=env, check=True,
               stdout=subprocess.DEVNULL)
try:
    for _ in range(60):
        if subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.5)
    port = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", name], text=True))["5432/tcp"][0]["HostPort"]
    records = []
    repos = [arg for arg in sys.argv[2:] if not arg.startswith("--")] or [str(Path.cwd())]
    suites = ["drive-cloud.test.ts"] if "--drive-only" in sys.argv else ["cloud-export.test.ts", "cloud-export-render.test.ts", "render/render.test.ts", "drive-cloud.test.ts"]
    for index, repo in enumerate(repos):
        for suite_index, suite in enumerate(suites):
            if shutil.disk_usage(Path.cwd()).free < 512 * 1024 ** 2:
                raise SystemExit("Insufficient disk reserve for another isolated database")
            # Every suite installs its own schema; a shared DB is invalid.
            dbname = f"axfluxo_video_test_audit_{index}_{suite_index}"
            subprocess.run(["docker", "exec", name, "createdb", "-U", "postgres", dbname], check=True)
            test_env = dict(os.environ, AXFLUXO_TEST_POSTGRES_URL=f"postgres://postgres:{env['POSTGRES_PASSWORD']}@127.0.0.1:{port}/{dbname}")
            with (out / f"tests-{index}-{suite_index}.log").open("w") as log:
                result = subprocess.run(["./node_modules/.bin/vitest", "run", "server/tests/" + suite, "--maxWorkers=1"],
                                        cwd=repo, env=test_env, stdout=log, stderr=subprocess.STDOUT)
            records.append(dict(repo=str(repo), suite=suite, exitCode=result.returncode))
            (out / "results.json").write_text(json.dumps(dict(container=name, results=records), indent=2))
            print(index, suite, result.returncode, flush=True)
finally:
    subprocess.run(["docker", "stop", name], stdout=subprocess.DEVNULL)
