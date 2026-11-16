#!/usr/bin/env python3
"""Commit compact evidence without secrets or media filenames.
Usage: summarize.py OUTPUT_JSON MATRIX_DIR [MATRIX_DIR ...]
Raw samples/media stay in their isolated directories/containers.
"""
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys

output = Path(sys.argv[1])
records = []
manifests = []
for directory in map(Path, sys.argv[2:]):
    manifest = json.loads((directory / "manifest.json").read_text())
    manifests.append({k: v for k, v in manifest.items() if k != "results"})
    for item in manifest["results"]:
        record = dict(item)
        root = directory / item["label"] / "result"
        summary = root / "summary.json"
        if summary.exists():
            record["measurement"] = json.loads(summary.read_text())
            record["rawSummarySha256"] = hashlib.sha256(summary.read_bytes()).hexdigest()
            result = root / "result.json"
            record["validation"] = json.loads(result.read_text()) if result.exists() else None
            stages = root / "stages.jsonl"
            record["stages"] = [json.loads(s) for s in stages.read_text().splitlines()] if stages.exists() else []
            node = root / "node.jsonl"
            events = [json.loads(s) for s in node.read_text().splitlines()] if node.exists() else []
            record["nodeMemoryMax"] = {k: max(e["memory"][k] for e in events) for k in events[0]["memory"]} if events else {}
            record["children"] = [{k: v for k, v in e.items() if k not in ["memory", "cpu"]}
                                   for e in events if e["event"] in ["spawn", "close"]]
            media = root / "media"
            record["retainedMediaBytes"] = sum(p.stat().st_size for p in media.rglob("*") if p.is_file())
            record["syntheticSourceSha256"] = hashlib.sha256((media / "synthetic.mp4").read_bytes()).hexdigest() if (media / "synthetic.mp4").exists() else None
            samples = root / "samples.jsonl"
            # Attribute each observed child to its own measured lifetime/phase.
            process_peaks = {}
            if samples.exists():
                for line in samples.read_text().splitlines():
                    row = json.loads(line)
                    for process in row["processes"]:
                        pid = str(process["pid"])
                        peak = process_peaks.setdefault(pid, dict(kind=process["kind"], rss=0, pss=0, uss=0, threads=0, cpuTicks=0))
                        for k in ["rss", "pss", "uss", "threads", "cpuTicks"]:
                            peak[k] = max(peak[k], process[k])
            record["processPeaks"] = process_peaks
        records.append(record)

comparisons = []
for record in records:
    if record.get("version") != "candidate" or not record.get("validation"):
        continue
    baseline = next((b for b in records if b.get("profile") == record["profile"] and b.get("fixture") == record["fixture"]
                     and b.get("repeat") == record["repeat"] and b.get("version") == "baseline"), None)
    if baseline and baseline.get("validation"):
        comparisons.append(dict(candidate=record["label"], baseline=baseline["label"],
                                sameSource=record["syntheticSourceSha256"] == baseline["syntheticSourceSha256"],
                                identicalOutput=record["validation"] == baseline["validation"]))
files = ["server/worker/templates/all-versions/render.ts", "server/worker/templates/all-versions/reference-render.ts",
         "server/worker/templates/fnf-showcase/render.ts", "server/tests/resource-audit-fixture.ts"]
evidence = dict(schema=1, gitHead=subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
                sourceHashes={f: hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in files},
                manifests=manifests, records=records, comparisons=comparisons)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(evidence, indent=2) + "\n")
for mode in ["legacy", "unified", "render", "fnf"]:
    for profile in ["U", "M", "S"]:
        values = []
        for version in ["baseline", "candidate"]:
            group = [r for r in records if r.get("fixture", [None])[0] == mode and r["fixture"][1] == 1
                     and r.get("profile") == profile and r.get("version") == version and "measurement" in r]
            if group:
                ms = [r["measurement"] for r in group]
                values.append(dict(version=version, n=len(ms), success=sum(m["exitCode"] == 0 for m in ms),
                                   cgroupPeakMean=round(statistics.mean(int(m["cgroupAfter"]["memory.peak"]) for m in ms)),
                                   rssMean=round(statistics.mean(m["peaks"]["rss"] for m in ms)),
                                   cpuMean=round(statistics.mean(m["cpuSeconds"] for m in ms), 3),
                                   wallMean=round(statistics.mean(m["wallSeconds"] for m in ms), 3),
                                   diskMean=round(statistics.mean(m["peaks"]["disk"] for m in ms))))
        if values:
            print(json.dumps(dict(mode=mode, profile=profile, values=values)))
print("quality pairs", len(comparisons), "all identical", all(c["sameSource"] and c["identicalOutput"] for c in comparisons))
