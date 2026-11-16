# Unified Worker Resource Audit v2

Status: **PARTIAL — production admission remains OFF.** This is an offline,
synthetic-resource investigation, not a Blitz deployment approval. A failed
512MiB probe is a failure, even when Docker's top-level `OOMKilled` is false.
The kernel can kill FFmpeg while the diagnostic parent survives.

## Baseline and scope

On 2026-11-16, GitHub PR #34 remained open/draft at
`81d6c739a797e95386855ad1b78313a88e9b1077`, base PR #33
`chatgpt/render-efficiency-audit-20261115` at
`6759e30dcc4aea1d9edb230317406b48207d93a0`. The initially clean local checkout
was on `work`; after fetching, the new branch
`codex/unified-resource-audit-v2` was created from #34. PRs #30–#34 and main
were not updated. The new Draft targets `codex/unified-worker-v1`.

The older 795.2/806.3MiB process-tree RSS numbers and the 160×90 generic smoke
are historical diagnostics, not directly comparable production-template tests.
This audit uses the same 1920×1080, 60fps synthetic input for legacy Export,
the serial runtime adapter, and the new All Versions template pipeline. FNF
uses that same synthetic gameplay source and the 1080×1920 production template.
The unified diagnostic runs `runWorker()` with the real legacy renderer, **not**
the database-backed `workerTasks()` adapter. DB/provider costs are excluded.

## Environment and measurement

- Node 24.19.0; FFmpeg 7.1.5-0+deb13u1, libx264; Linux amd64, cgroup v2.
- Node old-space limit 134,217,728 bytes (128MiB). This does not bound native
  Canvas, Buffers, FFmpeg, libraries, or the whole process RSS.
- Docker CPU quota `100000 100000` (1 core) for every diagnostic profile.
- S: 536,870,912 bytes (512MiB, 536.870912MB).
- M: 1,000,000,000 bytes (1GB, approximately 953.674316MiB).
- U: 2,147,483,648 bytes (2GiB), a relaxed **bounded** reference, not unlimited.
- `--memory-swap` equals `--memory`, meaning zero additional swap allowance;
  verify `memory.swap.max=0` and `memory.swap.current=0` in each result.
- Read `memory.current`, `memory.peak`, `memory.max`, `memory.events`,
  `memory.stat`, `memory.swap.current/max`, `cpu.stat` and `cpu.max`.
- `/proc` tree RSS/PSS/USS, thread counts and CPU ticks sampled nominally every
  25ms. Each sample takes time; actual spacing is larger under contention.
  Child stdout/stderr closes and exit codes/signals are recorded by a diagnostic
  preload. Node `rss`, `heapUsed/Total`, `external`, `arrayBuffers`, CPU and
  stage boundaries are recorded separately.
- Process CPU time uses `RUSAGE_CHILDREN`; whole-container CPU comes from
  `cpu.stat` deltas and also includes the Python sampler.
- Work-tree disk counts are sampled logical sizes, including diagnostic logs;
  they are not filesystem allocated blocks or a disk quota measurement. Media
  files are retained, so final media bytes can also be inspected directly.

RSS sums double-count shared pages. PSS apportions sharing, USS omits it.
Cgroup charging of shared libraries/page cache can belong to another cgroup;
charged memory is not identical to the whole physical working set on a cold
machine. The host cgroup is shared with builds/tests and its historic
`memory.peak` is **not** assigned to an individual fixture. Only fresh
per-container peaks are used for constrained acceptance. Host co-tenancy and
short sampling gaps limit timing/attribution; no universal speedup is claimed.

## Cause and adopted change

The first PR #34 1080p60 synthetic legacy run peaked at 869,904,384 bytes
tree RSS. The FFmpeg segment encoder alone reached 733,151,232 bytes RSS;
Node's maximum was 142,757,888 bytes. During the highest combined sample, Node
was 119,476,224 bytes and FFmpeg 733,151,232 bytes. Heap is not the dominant
observed contributor in this fixture.

An isolated single-variable experiment inserted input-scoped `-threads 1` for
the two generated PNG inputs, leaving x264 threads, lookahead, CRF and filters
unchanged. It reduced tree RSS to 748,818,432 bytes (13.92% in this exploratory
pair); FFmpeg RSS fell to 611,274,752 bytes. Both output files were 62,997 bytes,
SHA-256 `fea4ebbecc079082fb4e84b396c227821fd1eb4265930f55c53e0b259d888ab2`.
Concurrent host work makes that pair unsuitable for a speed claim.

The adopted production changes are only in:

- `server/worker/templates/all-versions/render.ts`: bound every generated PNG
  input decoder, including the already opt-in compositor path.
- `server/worker/templates/all-versions/reference-render.ts`: apply the same
  input decoder bound without altering title/timer graphs or encoder options.

Each `-threads 1` is before the relevant `-i`, not an output encoder option.
PNG decoding is lossless, and the tested complete output hashes are compared;
this is not a claim that changing x264 threading/lookahead is pixel invariant.
No encoder change or new renderer profile is introduced. Existing checkpoint
identity and default-OFF static flags remain intact.

The FNF decoder experiment did not demonstrate a consistent reduction and was
removed from the production diff. Remaining FFmpeg memory has not been fully
apportioned among x264 lookahead, frame/filter queues, decoders and libraries.
No low-lookahead profile, forced GC, reduced blur, font/cache rewrite, stream
rewrite, memory-limit increase or quality reduction is adopted without evidence.

## Phase attribution and gaps

| Required stage                  | Evidence and limit                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Worker startup                  | Node preload startup; offline module/runtime startup only                                     |
| DB connection                   | Not included in the resource fixture; native SQL tests separate                               |
| Material preparation/validation | Explicit stage and FFmpeg/FFprobe process records                                             |
| Cover load                      | Inside Canvas background generation; not individually isolated                                |
| Background                      | New-template `prepareGraphics()` before/after samples                                         |
| Title                           | Inside `encodeProjectSegment()` before FFmpeg spawn; not isolated from all native allocations |
| Segment encode                  | Child PID and its process peak; dominant observed peak                                        |
| Segment validation              | Actual frame timestamps and complete decode, separate children                                |
| Concat/audio mux                | Actual direct concat mux, no joined.mp4, one AAC encode/copy eligibility unchanged            |
| Final validation                | Actual video/audio validation and hash                                                        |
| Storage/publication             | Excluded from offline resource numbers; queue tests separately                                |
| Cleanup                         | Fixture preserves all inputs/outputs; existing production cleanup unchanged                   |
| Idle                            | Node samples for 250ms; no long-lived leak/steady-state certification                         |

Thus cover decode vs blur vs native Canvas buffer lifetimes are still partially
unresolved. No leak finding is inferred from a single job or from RSS not dropping
immediately. Large streamed DB chunks, long-lived pools, provider downloads,
huge covers and real user workloads remain additional release gates.

## Reproduction

Run only in a disposable Linux workspace with synthetic media, sufficient disk,
Docker and the listed local binaries. No production credentials are required or
passed to the diagnostic child. Scripts never enable cloud admission or contact
Drive/R2/Blitz. Diagnostic Docker runs have `--network none`, no host mounts,
non-root UID, dropped capabilities, no new privileges and fixed CPU/swap.

```sh
npm ci --cache work/npm-cache
git worktree add --detach work/pr34 81d6c739a797e95386855ad1b78313a88e9b1077
ln -s "$PWD/node_modules" work/pr34/node_modules
cp server/tests/resource-audit-fixture.ts work/pr34/server/tests/
npx esbuild work/pr34/server/tests/resource-audit-fixture.ts --bundle --platform=node --target=node24 --format=esm --external:@napi-rs/canvas --outfile=work/resource-audit/baseline.mjs
npx esbuild server/tests/resource-audit-fixture.ts --bundle --platform=node --target=node24 --format=esm --external:@napi-rs/canvas --outfile=work/resource-audit/candidate.mjs
python3 scripts/resource-audit/pack-runtime.py
DOCKER_CONFIG="$PWD/work/docker-config" docker build -t axfluxo-resource-audit:local work/resource-audit/runtime-context
python3 scripts/resource-audit/run.py work/resource-audit/reproduction --quick
# After short cases and free-space checks, selected 5/30-second fixtures:
python3 scripts/resource-audit/run.py work/resource-audit/extended --extended-only
python3 scripts/resource-audit/native-tests.py work/resource-audit/native
npx vitest run server/tests/resource-recovery-v2.test.ts --maxWorkers=1
```

The runtime packer uses trusted host FFmpeg/Node/Python and their linked
libraries. It is **not** `infra/video/Dockerfile`: that image's APT step failed
both normally and with host networking. Do not infer production-image or Blitz
success from the diagnostic image. No TLS/security bypass was used.

Outputs: manifest (image/bundle identity, profile, fixture and status), each
container's `summary.json`, `samples.jsonl`, `node.jsonl`, `stages.jsonl`,
`result.json`, child errors and all synthetic media. Containers are retained.
The runner checks disk reserve before each new test and records `BLOCKED_DISK`
instead of deleting inputs, MP4s or checkpoints. Its reserve is a guard, not a
proof about another Docker daemon's backing store.

See the adjacent recovery/release reports and committed evidence for executed
results, limitations, and five-viewpoint audit. Unexecuted requirements remain
unverified; short success never certifies long videos or production operations.

## Executed resource results

The following is the **exploratory** matrix, before removal of the rejected FNF
experiment. Its All Versions input-decoder changes are the adopted changes;
FNF candidate numbers are not final-code results. Image/bundle SHA identities,
per-run ranges, cgroup snapshots, Node maxima, child exits and validation hashes
are in [exploratory evidence](evidence/resource-audit-v2-exploratory.json).
The [final-code attempt](evidence/resource-audit-v2-final-attempt.json) could not
start its first fixture (ENOSPC), then recorded disk-gated cases. It provides
**no final-head performance certification**.

Each mean below is two independent fresh-container synthetic 1-second runs,
including fixture preparation, Node startup, validation and 250ms idle. Host
builds/browser tests co-ran: wall times are observations, not speed guarantees.

| Pipeline, M (1,000,000,000 B) | Baseline cgroup mean B (MiB) | Candidate mean B (MiB) | Observed reduction | Tree RSS mean B before → after |
| ----------------------------- | ---------------------------: | ---------------------: | -----------------: | -----------------------------: |
| A → B: legacy Export          |         755,208,192 (720.22) |   635,183,104 (605.76) |             15.89% |      900,227,072 → 779,206,656 |
| C → D: serial Worker          |         793,882,624 (757.11) |   596,883,456 (569.23) |             24.81% |      938,524,672 → 737,382,400 |
| E → F: new AV template        |         857,882,624 (818.14) |   587,784,192 (560.55) |             31.48% |      896,550,912 → 733,734,912 |

| Pipeline, M | CPU seconds mean before → after | Wall seconds mean before → after | Sampled work+log bytes mean before → after |
| ----------- | ------------------------------: | -------------------------------: | -----------------------------------------: |
| legacy      |                   7.862 → 7.819 |                    9.804 → 9.853 |                      4,544,550 → 4,544,419 |
| serial      |                   7.641 → 7.529 |                    9.118 → 9.281 |                      4,535,681 → 4,548,911 |
| new AV      |                   8.224 → 7.393 |                    9.459 → 8.704 |                      4,536,379 → 4,534,971 |

- U and M exploratory AV comparisons: 24 successful runs / 12 matched pairs.
  Every pair had the same synthetic source and complete validated MP4 hash,
  including video, AAC, timestamps and metadata. No statistical confidence
  interval is inferred from two repetitions.
- FNF experiment: M cgroup mean **843,991,040 → 932,962,304 B**, worse rather
  than better. Four successful baseline/candidate pairs across U/M were byte
  identical, but the change was rejected. Final FNF code equals PR #34.
- S legacy: baseline **0/2**, candidate **0/2**. Every run reached
  **536,870,912 B** and recorded `memory.events: oom=1, oom_kill=1`, child
  SIGKILL and failed rendering. No candidate MP4 validated. No disk/profile
  change or swap was used to convert failure into success. S is **HOLD** for
  the observed Export workload. Other S modes were not completed.
- M short success is not long-video, cold-working-set or real-Blitz acceptance.
- Separate reference-layout quality trial: 5-second complex cover, two titles,
  six segments, fades and live/reset clock; both versions fully validated at
  300 frames, 1920×1080/60, AAC sample count 240,640, file size 725,993 B,
  SHA-256 `bd3f6571ba12f6f059f95348d9a42ad988ef1cbb5517b7c47fdd9ae9489e6f9b`.
  This was an unconstrained host **quality** comparison with a synthetic audio
  source, not the resource matrix's video input or a 1GB capacity test. Re-run:
  `node --import tsx scripts/resource-audit/reference.mjs BASELINE_CHECKOUT NEW_OUTPUT_DIR`.
- The full 5-second resource matrix and every 30-second resource trial were
  blocked by the disk reserve; no long resource result is claimed. The FNF
  multi-range synthetic smoke and real-template tests are functional coverage,
  not long/constrained capacity measurements.

## Environment failures and remaining risks

Host disk repeatedly exhausted during isolated Docker/native tests. Disposable
package/build caches were relocated or reclaimed, dependency resolution was
repaired, and the official frontend build then succeeded. A failed, never-started
diagnostic container/image was removed; no media/checkpoint-bearing container
was removed. The empty dependency-failure DB attempt was archived before removal.
Raw benchmark/media artifacts and other DB containers were retained. The runner
now stops before a new test when the disk reserve is insufficient. Actual
backing-store growth is not bounded by that preflight check.

This leaves incomplete final-head resource, long-video, native-operation stop,
provider, cold-start and production-image verification. Native Drive's existing
refresh-lease timeout and unavailable WebKit are also release blockers. The
reference quality pair and short exploratory savings do not close those gates.
See [recovery](RECOVERY_AUDIT_V2.md), [release gates](RESOURCE_RELEASE_GATES.md)
and [executed checks](evidence/EXECUTED_CHECKS.md).
