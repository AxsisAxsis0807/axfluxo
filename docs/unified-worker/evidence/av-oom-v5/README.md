# AV OOM v5 evidence

This directory contains compact synthetic-only evidence. Historical v4 files are unchanged. New raw media/samples live under `/workspace/axfluxo/work/av-oom-v5/CASE/work/result/`; build copies are under `work/av-oom-v5-build/`. These ignored local artifacts are **not remotely backed up by Git** and will not necessarily survive a workspace reset. `measurements.json` gives raw-file locations, sizes and SHA-256. No MP4, PNG input or unbounded raw log is committed.

- `RESULTS.md`: every executed case, including invalid setup and static-path-invalid diagnostics. Each labelled row is one fresh container; labels identify repetitions.
- `measurements.json`: actual cgroup limits/peak/events/stat/swap/CPU, process RSS/PSS/USS and sampled lifetimes, I/O, stages, segments, argv, file/code/image identity and raw evidence hashes. Whole-cgroup charge includes the diagnostic Python sampler; descendant process RSS/PSS/USS exclude that sampler. B7 additionally records per-PID Anonymous/AnonHugePages with its separately hashed sampler. It contains no unrelated workload. Never add process RSS to cgroup memory.
- `build.json`, `runtime-manifest.json`, `runtime-comparison.json`: immutable source and bundles; actual runtime file hashes and comparison with v4. Images built from scratch have local content-addressed image IDs; no registry RepoDigest is claimed.
- `C1.patch`: isolated background-Canvas reset after awaiting PNG encoding. Candidate B remains the frozen patch at `../av-fade-v4/candidate-B.patch` (SHA-256 `abb470ede22324a6533e3e883d266dd40ffc26b370df4345c65a2ffecf71c320`). Neither is applied to production sources.
- `blitz-public.json`: dated official public-source findings; account creation **2026-11-07** is known. Exact rule introduction date, exception applicability, current plan and actual reservation inventory remain **アカウント適用未検証**.

## Reproduce

`python3 scripts/resource-audit/build-v5.py` performs the local packaging and child-image steps below in a fresh work directory after `npm ci --ignore-scripts`. It is a diagnostic-image builder only. The initial manual setup is also spelled out for review.

Use a fresh checkout/work directory, Linux x86_64, Docker/cgroup v2, Node24.19.0, FFmpeg7.1.5, Python3.13 and the lockfile. No credentials, production image, DB, real storage or real user media. Commands which contact npm/GitHub are setup only; workload containers have `network none` and proxy variables explicitly blank.

```sh
npm ci --ignore-scripts
python3 scripts/resource-audit/prepare-v5.py
mkdir -p work/resource-audit
cp work/av-oom-v5-build/baseline.mjs work/resource-audit/baseline.mjs
cp work/av-oom-v5-build/B.mjs work/resource-audit/candidate.mjs
python3 scripts/resource-audit/pack-runtime.py
cp scripts/resource-audit/sample-v5.py work/resource-audit/runtime-context/rootfs/app/sample.py
cp scripts/resource-audit/preload-v4.mjs work/resource-audit/runtime-context/rootfs/app/preload-v4.mjs
chmod 644 work/resource-audit/runtime-context/rootfs/app/sample.py work/resource-audit/runtime-context/rootfs/app/preload-v4.mjs
sed -i 's@/app/preload.mjs@/app/preload-v4.mjs@' work/resource-audit/runtime-context/Dockerfile
docker build --network=none -t axfluxo-av-oom-v5:baseline work/resource-audit/runtime-context
```

Build child images `B`, `C1`, `B-reuse` with `FROM axfluxo-av-oom-v5:baseline` and `COPY --chmod=644 baseline.mjs /app/baseline.mjs`, using each frozen bundle. The initial missing COPY read permission is preserved as INVALID_SETUP and is not an OOM repetition. B-reuse changes only the fixture's names and path reuse, not encoder settings. Record resulting image IDs and validate bundle/runtime hashes before comparing data.

```sh
python3 scripts/resource-audit/oom-v5.py B1-NEW --memory 1000000000 --image axfluxo-av-oom-v5:B --static true
python3 scripts/resource-audit/matrix-v5.py
python3 scripts/resource-audit/summarize-oom-v5.py
python3 scripts/resource-audit/quality-v5.py base-15-1GB-r1 B3-1GB-r1 work/av-oom-v5/quality-15.json
```

The runner creates a new labelled container at 0.5 CPU by default, memory/swap explicitly equal (no additional swap), pids128, cap-drop ALL and no-new-privileges. Input x264 settings are unchanged. 1,000,000,000 requested bytes round down to actual 999,997,440 B; decimal 512,000,000 and binary 536,870,912 are separate cases. Runner has a 2GiB disk reserve check and archives `/work` before deleting only its own stopped container. No image/volume pruning.

B7 uses `resource-phase-v5.ts` bundled as `/app/baseline.mjs` in a separate phase image, then `phase-v5.py`. Inputs are the completed B3 synthetic job. FFmpeg fade/static/mux argv are replayed from that job; each phase has a fresh Node process and sampler. PNG/phase prep outside the replay is intentionally excluded. Phase differences are not filter allocator sizes. Pre-copied inputs may be charged outside the replay cgroup, so file-cache charging and initial Node/native state differ from full jobs. B5 clears path maps at version boundaries, preserves files, and does not imply Canvas native buffers were freed. B8's 300-frame segments do not pass a static ON gate when no static segment is traversed.

## Measurement limits

25ms is a target sleep plus scan/serialization cost; true peaks can occur between samples. Kernel `memory.peak` supplements sampling. PID RSS/PSS/USS, cgroup anon/file/kernel and Node memoryUsage are different views. Node heap/external do not expose all Canvas allocations; anon_thp is not automatically waste. PID lifetimes have sampled bounds plus spawn/close events, not kernel allocation tracing. Disk counts logical files including diagnostic logs, not physical blocks or a storage quota. `memory.events.max` reports pressure, not OOM kill.

Host setup/rebuild and scoped verification can overlap the serial container matrix; host co-tenancy is not controlled. Verification timestamps are retained in checks evidence. No wall-time speedup claim is made. Every run uses a newly started container; the host page cache is not dropped, so cold/warm cache is uncontrolled and run order is explicit in execution logs/time. Do not use this evidence for a cold-cache certification, a leak verdict, real Blitz capacity, long-term stability or deployment approval.

Additional ordered follow-up: `supplement-v5.py` fills matched baseline inputs and bounded 15s probes, `identity-v5.py` executes actual plan identity comparison, `filter-compare-v5.py` isolates B8 pre-encode pixels, and `checks-v5.py` records scoped host verification. `stop-v5.py NEW_DIRECTORY png-generating fade-running before-mux mux-running` uses its separately stored hook; mux-running requires a live FFmpeg with a positive-size output and marks an unobserved trigger INVALID. All performance acceptance remains based on the dedicated sampler cases, not recovery monitor processes.

Final counts: 40 resource cases (30 completed full jobs including baselines and rejected B8, 6 standalone phases, 3 OOM failures, 1 INVALID_SETUP); 23 quality comparisons (22 exact, B8 rejected); 4 standalone kill/restart cases. Overall HOLD; see summary.json and self-audit.json. VALID in the static column means the path was traversed, not that the whole case passed.
