# Unified Worker v1 — implementation and five-pass review

**PARTIAL: reviewable implementation, production activation held.**

## Source and scope

- Base: PR #33, branch `chatgpt/render-efficiency-audit-20261115`, SHA `6759e30dcc4aea1d9edb230317406b48207d93a0` (fresh GitHub metadata and remote-ref checks).
- #30 → #31 → #32 → #33 are open Draft PRs; their heads are ancestors of this base. New work uses only `codex/unified-worker-v1` and targets #33's branch.
- Starting tree was clean. No production branch, migration, deployment, merge, real Drive/R2 object or billing operation was performed. Existing workflow deployment is main-only; the new branch is not a deployment target in repository configuration. Actual Blitz settings were not accessed.

## Changed files

| File                                               | Reason and impact                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/worker/runtime/export.ts`                  | Small one-pass adapter, existing Export role/TLS and pool max=1; production cutover attestation; realpath workdir separation; close registration.                                                                                                                                                 |
| `server/worker/runtime/tasks.ts`                   | Register legacy task in existing serial loop; validate only needed storage/Drive/video-pool settings; preserve video service order/roles; close Export on later configuration failure.                                                                                                            |
| `server/cloud-export/worker.ts`                    | Check abort before claim and publish; protect directory creation with failure handling; drain heartbeat and retain its error classification; worker stop uses existing retryable WORKER_LOST rather than CANCELLED; delete only own temp directory. Existing standalone loop/entrypoint retained. |
| `.env.example`                                     | Both new flags default false; clarify admission versus processing.                                                                                                                                                                                                                                |
| `server/tests/unified-export.test.ts`              | OFF/legacy-only/production guard/unused settings/cleanup/directory collisions and aliases.                                                                                                                                                                                                        |
| `server/tests/runtime-tasks.test.ts`               | Existing adapters plus three busy passes through legacy and Render, with dedicated pools and close assertions.                                                                                                                                                                                    |
| `server/tests/runtime.test.ts`                     | Real subprocess SIGINT as well as SIGTERM; import inertness includes legacy worker. Existing seriality/backoff/FFmpeg kill checks retained.                                                                                                                                                       |
| `server/tests/cloud-export.test.ts`                | Real SQL/RLS queue: operator stop retries to three-attempt cap, no output publication, pre-abort no claim, user cancel precedence and foreign-checkpoint preservation.                                                                                                                            |
| `server/tests/export-interruption.test.ts`         | Heartbeat cancellation, lease loss, transient DB/storage and disk-full classifications; no publish.                                                                                                                                                                                               |
| `server/tests/unified-resource-smoke.ts`           | Offline reproducible one-process serial FFmpeg diagnostic; synthetic legacy 1080p60 then existing generic 160x90 AV/FNF fixture. No DB/provider. Not a production full-template benchmark.                                                                                                        |
| `docs/unified-worker/OPERATIONS.md`, this document | Resource limits, release gates, manual cutover and isolated rollback evidence.                                                                                                                                                                                                                    |

There are no renderer/profile/checkpoint/queue-schema/auth/RLS/OAuth/TLS implementation changes. PR #33's direct mux, single finished upload and default-OFF compositors are retained.

## Executed checks

| Command / test                                     | Observed result                                                                                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --cache /workspace/axfluxo/work/npm-cache` | PASS, 491 packages. Initial plain npm ci failed because default cache home is read-only; no dependency/lock changes.                                                                                                                          |
| `npm run typecheck`                                | PASS, repeated after final source changes.                                                                                                                                                                                                    |
| `npm run lint`                                     | PASS, repeated after final source changes.                                                                                                                                                                                                    |
| `npm test -- --maxWorkers=1`                       | PASS, 59 files / 500 tests. Initial plain npm test had 476 pass / 17 skipped because Google Drive beforeAll exceeded its existing 10s deadline under concurrent verification. Isolated Google suite: 17 pass. No assertions/timeouts changed. |
| Final affected-suite run                           | PASS, 23 tests across startup, adapter, heartbeat and runtime suites after final runtime changes.                                                                                                                                             |
| `npm run build` (including prebuild/postbuild)     | PASS. Frontend source is unchanged.                                                                                                                                                                                                           |
| `npm run build:worker --workspace=server`          | PASS on final runtime.                                                                                                                                                                                                                        |
| `npm run build:export-worker --workspace=server`   | PASS on final runtime; standalone entry preserved.                                                                                                                                                                                            |
| `npm run build:render --workspace=server`          | PASS on final runtime.                                                                                                                                                                                                                        |
| Native PostgreSQL17 Export queue                   | PASS, 21 tests; includes stop/cancel/RLS/fencing/retry checks.                                                                                                                                                                                |
| Native PostgreSQL17 old Export with real FFmpeg    | PASS, 1 test, 2s 1080p60/H.264/AAC, private output/Range and validation.                                                                                                                                                                      |
| Native PostgreSQL17 Render                         | PASS, 25 tests including actual killed claimant, expired lease, stale fencing, checkpoint/retry and output checks.                                                                                                                            |
| Native PostgreSQL17 Drive                          | PARTIAL, 29 pass / 1 timeout in Phase1/Cloud shared refresh-lease test. Fresh-DB retry same. **Unchanged PR #33 baseline reproduces 29 pass / same 1 timeout.** Not waived or called PASS.                                                    |
| Chromium video browser suite                       | PARTIAL, 45 pass / 3 fail. Targeted rerun: failed-waveform and durable-queue recovery pass; local FNF completion still fails. No UI or browser-render code changed. See baseline note below.                                                  |
| WebKit Drive browser suite                         | NOT VERIFIED, 2 launch failures: WebKit binary `webkit-2370/pw_run.sh` absent. Not skipped successes.                                                                                                                                         |
| Docker worker build, standard and host networking  | BLOCKED: build-stage APT cannot resolve/reach Debian repository; ffmpeg/ca-certificates unavailable. No TLS validation disabled, Dockerfile changed, or failed build counted as success.                                                      |
| Isolated rollback                                  | PASS: final bundled unified worker starts against loopback test DB, SIGTERM exits 0 with no stderr; then legacy export-worker starts, SIGTERM exits 0 with no stderr. No overlapping workers.                                                 |
| Diff / credentials                                 | `git diff --check` PASS. Reviewed changed files and bounded regex scan for private keys/GitHub/AWS/Google secrets: 0 findings. This is a scoped scan, not a claim of exhaustive secret detection.                                             |

Native tests use only separately named `axfluxo_video_test*` databases on an isolated Docker PostgreSQL17 bound to 127.0.0.1:55433. An initial attempt to run two migration-owning Export suites in the same database failed with an existing-schema error; each was rerun in its own database. This was fixture isolation, not a migration change.

Browser baseline note: unchanged PR #33 also fails the same local FNF completion test, while its targeted durable-queue recovery test passes (1 failed / 1 passed). Do not infer UI regression freedom from unchanged files alone. Full root/static Playwright suites and physical Safari were not run; existing video Chromium coverage was executed as above.

## Five focused review passes

These are five separately focused passes by the implementing agent, not five independent external reviewers or a mathematical safety guarantee.

1. **Specification / compatibility.** Verified stacked ancestry and existing queue/service reuse. Found unused Drive/R2/video resource settings were previously initialized even for an Export-only runtime. Scoped them to selected/active processing. A later check found a storage-disabled Render could still impose workdir setup on Export; directory validation now follows actual media capability. Rechecked OFF, legacy-only, Render-only, both queues, API-off consumption, and dedicated roles in startup/adapter tests. No output/layout/profile change.
2. **Code / execution.** Found legacy `mkdtemp` ran outside attempt handling and heartbeat work was fire-and-forget. Moved directory creation inside protected attempt handling, awaited heartbeat before failure/release/close, and retained fixed-code error paths. Added abort checks before claim and immediately before fenced publish. Typecheck/lint/three worker builds and affected tests pass. Native Render/Export confirm existing recovery paths; no transaction implementation changed.
3. **Security / data integrity.** Audited role, owner/RLS, fence, publish, logs, TLS and no-delete boundaries. Found blanket heartbeat-abort classification could hide cancellation, expired fencing or transient errors. Preserve heartbeat cause; worker signal maps to WORKER_LOST while `finishFailure()` still checks persisted cancellation first. Real SQL verifies cancellation/retry/no output and existing stale-fence tests pass. Workdir checks reject realpath aliases; subsequent path review corrected handling of a literal `..child` directory and added a regression assertion. No security gate relaxed.
4. **Load / capacity.** Verified one awaited Export pass and existing Render turn per loop; scheduler seriality/backoff tests and three busy-pass adapter test pass. No queue preemption or separate media loop. Measured real synthetic process-tree RSS/CPU/disk below. Found >512MiB RSS in legacy and combined diagnostics: **production release blocker**, deliberately not concealed by changing quality/profile/limits. Native Drive and browser failures remain visible. Actual disk capacity is not derived from adding configured ceilings.
5. **Recovery / release readiness.** Verified real SIGTERM/SIGINT and TERM-resistant child escalation, no subsequent task after abort, three-attempt ceiling, persisted cancel precedence, native expired lease/checkpoint/stale fencing, and isolated compiled binary rollback. Added production cutover attestation and explicit actual replica/lease/process checks. Attestation is not distributed exclusion. Final release remains PARTIAL; no production enabling, merge or migration. External GPT/user review is still required.

## Resource observations and limits

Host: Node 24.19.0, FFmpeg installed, cgroup memory allowance 8GiB, CPU quota 2 cores. Diagnostics use `NODE_OPTIONS=--max-old-space-size=128`. Synthetic media only. Every ~25ms an external Python sampler read `/proc/*/stat`, summed RSS for the complete diagnostic process tree (including transient FFmpeg/FFprobe), and sampled files under the isolated diagnostic work root. CPU seconds are cumulative child-process user+system time, wall time monotonic.

| Diagnostic                                                         | Exit | Sampled aggregate peak RSS | CPU / wall     | Sampled work bytes |
| ------------------------------------------------------------------ | ---- | -------------------------- | -------------- | ------------------ |
| Legacy Export: 1s, 1920x1080 CFR60, default quality                | 0    | 833,835,008 B (795.2MiB)   | 6.90s / 10.28s | 166,204            |
| Existing generic Render smoke: 160x90 AV/FNF                       | 0    | 97,234,944 B (92.7MiB)     | 2.77s / 6.02s  | 207,053            |
| Same-process unified serial diagnostic: legacy then generic Render | 0    | 845,488,128 B (806.3MiB)   | 8.98s / 8.60s  | 373,297            |

These are sampled summed RSS, not cgroup physical-memory peak; shared pages can be counted more than once and brief spikes can be missed. No enforced 512MiB/OOM run was achieved because the worker image build was blocked. The legacy result is a concrete reason **not** to certify the account-wide 512MiB budget. The two renderer rows are different output sizes/templates, not a performance comparison. This simple compressible fixture's tiny disk footprint is not a capacity estimate for actual footage. API memory, DB server, real account services and long sources are excluded.

Reproduce the sequential smoke in an isolated, empty directory with valid existing font paths:

```sh
NODE_OPTIONS=--max-old-space-size=128 \
VIDEO_RENDER_DISK=/tmp/axfluxo-unified-synthetic \
VIDEO_ALEO_FONT="$PWD/server/worker/templates/all-versions/assets/Aleo.ttf" \
VIDEO_FNF_FONT="$PWD/server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf" \
npx tsx server/tests/unified-resource-smoke.ts
```

It writes only synthetic files beneath that supplied directory and keeps them for inspection. It has **zero DB connections** and is not evidence about real queue/pool memory. Role/pool construction tests confirm legacy-only one pool of max=1; legacy+Render adds the existing Render pool (default max=1). Other enabled video stages retain their pre-existing pools; total configured video-role maxima plus Export must fit the actual DB allowance. Live production connection peaks were not measured.

## Remaining risks, in order

1. **Critical production gate:** no safe 512MiB account-wide capacity evidence; sampled legacy/unified RSS is materially above that figure. Do not enable on the assumed Free budget.
2. **High:** independent DB slots do not exclude two differently configured processes. Confirm actual old-process exit/replica count/leases before any cutover; the new attestation does not enforce those facts.
3. **High verification gap:** native Drive shared-refresh test times out on both branch and PR #33 baseline; persistent Chromium FNF test failure, unavailable WebKit and blocked Docker image validation remain unresolved. No PASS conclusion.
4. **High external gate:** real Blitz eligibility/pricing/TLS/migrations/resources/sleep, real Google/provider access, iPhone Safari/Files/playback and long 1080p60/1.7GB/1440p remain unverified.
5. **Operational:** long jobs cause long scheduling latency; graceful stop consumes the existing attempt allowance; crash residues may fill real disk. No destructive janitor or unapproved queue/profile rewrite is introduced.

Rollback and pre-release approval steps: [OPERATIONS.md](./OPERATIONS.md). GitHub branch/final SHA/Draft PR/CI are recorded in the PR and final user report, after publication; pending or failed final-SHA CI must never be reported as success.
