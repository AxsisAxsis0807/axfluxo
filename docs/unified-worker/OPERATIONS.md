# Unified Worker v1 — review only / production OFF

## Architecture and configuration

`worker.mjs` uses the existing awaited `runWorker()` loop. Its `cloud-export` task calls **one** existing `runExportPass()`; it does not start `runExportWorker()`. Probe, Drive verification/preview, Render, Deletion and Notifications keep their existing queues and services. No migration, new queue engine, renderer replacement or media-profile change is included.

| Setting                                         | Meaning                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEO_WORKER_ENABLED=false`                    | Existing master switch. Must be true for any unified task.                                                                                                      |
| `EXPORT_UNIFIED_WORKER_ENABLED=false`           | New legacy Export task only. OFF initializes no legacy pool/config/credentials/workdir.                                                                         |
| `EXPORT_ENABLED`                                | Existing API admission. Independent of consuming accepted jobs.                                                                                                 |
| `EXPORT_UNIFIED_WORKER_CUTOVER_CONFIRMED=false` | New production-only operator attestation. Required before legacy unified task construction. **Not a mutex, live-worker count check or resource certification.** |
| `VIDEO_WORKER_POLL_MS`                          | Unified loop interval; legacy standalone `EXPORT_WORKER_POLL_MS` remains unchanged.                                                                             |
| `VIDEO_WORKER_POOL_MAX`                         | Existing video-role pool limit, validated only if a video pool is needed.                                                                                       |

An export-only runtime requires its existing database/TLS/workdir/resource settings, not unused R2 credentials, Google OAuth, Drive budget or new Render disk limits. Enabled services still validate their own settings. Production Drive resource/TLS gates are unchanged. The existing internal Export DB TLS policy is not applied to Drive in place of its production requirements.

The Export pool retains `axfluxo_export_worker` and max=1. Video pools retain their existing dedicated roles and limits. The adapter neither purges retention nor changes deletion flags. Pool close is registered for startup failure and normal shutdown.

## Work directories and resource limits

Use pre-created sibling roots on a verified disk, for example:

```text
EXPORT_WORK_DIR=/work/export
VIDEO_RENDER_DISK=/work/render
```

When actual Render or Drive media processing is configured, startup resolves real paths and rejects equal, nested or symlink-aliased roots before creating the Export pool. An inactive Render with no configured storage does not impose a directory requirement on Export. Each pass keeps its own `mkdtemp` directory and deletes only that directory; it does not sweep old directories, originals, outputs or checkpoints. Crash remnants must remain until an independently reviewed cleanup policy exists.

Separate roots do **not** create separate physical capacity. `EXPORT_MAX_WORK_BYTES` and `VIDEO_RENDER_MAX_WORK_BYTES` are per-job ceilings, not reservations or evidence their sum fits the disk. Both existing renderers retain live free-space checks (`EXPORT_MIN_FREE_BYTES`, `VIDEO_RENDER_MIN_FREE_BYTES`). The unified loop prevents two of its own stages encoding at once, but other processes, old crash files, API writes or another mount can still exhaust capacity. Verify actual mount capacity and reserve headroom for the API, source verification and retained checkpoints; do not increase limits to make an oversized input pass.

A short synthetic legacy 1080p60 run exceeded 512MiB aggregate RSS in this environment (see REVIEW.md). **This implementation is not approved for the assumed 512MiB account budget.** A 128MiB JS heap does not cap Canvas, buffers, native allocations, FFmpeg, FFprobe or the rest of the account.

No file-size limit is raised. Drive's default configured verification ceiling remains about 768MiB; 1.7GB originals are not unlocked. Long 1080p60, 1440p and real iPhone/provider execution remain separate gates.

## Scheduling and shutdown

The Export task is first in each pass, followed by the existing relative video stage order. Every eligible task gets one awaited turn; a busy Export cannot drain its queue inside one turn. There is no FFmpeg preemption. Queue latency can be the sum of long preceding jobs; this is fairness per turn, not equal wall-clock service or a latency SLA. The existing bounded scheduler backoff applies to thrown task errors (including claim/database errors); durable per-job errors retain the Export queue's existing bounded attempt policy.

The lifecycle's SIGTERM/SIGINT abort stops subsequent task starts, propagates into the current Export pass, waits for media children/heartbeat, and closes pools. Existing media subprocess TERM/KILL escalation and lifecycle shutdown deadline remain in use. Jobs claimed by a transaction already in flight during shutdown are returned through the existing failure path before any rendering.

A worker stop is `EXPORT_WORKER_LOST`, not user cancellation. A live fenced claim returns to queued below the existing three-attempt limit, otherwise fails with that code. A persisted `cancel_requested` still takes precedence in `finishFailure()`. Heartbeat lease loss remains fence loss, and heartbeat disk/transient errors retain their own classifications. If DB writes fail or the lease has expired, the existing lease-expiry recovery is authoritative. Attempts are not reset or refunded. Incomplete output never bypasses validation/fenced publish.

## Approval-dependent cutover (do not execute as part of this PR)

1. Keep the new flag OFF. Obtain production approval after resolving the resource blocker and all external gates below. Confirm the exact approved image/SHA and PR stack/migrations already installed; there is no automatic migration.
2. Inspect actual Blitz process/replica counts, every worker command, autoscaling and restart policy. Include legacy `export-worker.mjs`, `render.mjs`, unified `worker.mjs` and standalone media workers. Repository files cannot establish the real account state.
3. Pause relevant API admission without discarding accepted work. Stop the old media workers with SIGTERM. Wait for exit, children and DB transactions to settle. Disable automatic replacement while switching.
4. Through approved read-only administrative access inspect **both** existing slots, their associated jobs, lease times and attempts. Do not clear a live lease or edit job states to force a switch. If a worker crashed, wait for normal lease expiry and investigate; an expired lease alone does not prove its old FFmpeg process is dead.
5. Verify no old media process remains and exactly one intended unified replica will run. Verify actual memory for API plus worker, disk/mounts, DB roles/TLS and shutdown timing. If uncertain, stop the cutover.
6. Only after completing those checks may an approved operator set `EXPORT_UNIFIED_WORKER_CUTOVER_CONFIRMED=true` and the applicable feature flags on the single intended runtime. The attestation is an operator guard, **not distributed exclusion**; independent Export/Render slots still allow overlapping work across different processes.
7. Use a tiny synthetic source first. Check resource telemetry, actual H.264/CFR60/audio/color validation, fenced completion and MP4 playback before resuming admission. Medium/long sources require separate approval.

Read-only inventory examples (use existing approved access; never copy credentials into logs):

```sql
SELECT token, owner_id, job_id, lease_until FROM axfluxo_export.slot;
SELECT owner_id, id, state, attempts FROM axfluxo_export.jobs
 WHERE state IN ('queued','running','cancel_requested');
SELECT * FROM axfluxo_video.render_slot;
```

Confirm the installed schema/permissions before querying. No production query was run for this change.

## Rollback

1. Pause applicable admissions and safely stop **all** unified replicas. Setting a flag alone does not terminate a running process or job.
2. Verify exit and both slots/jobs/leases exactly as above. Do not overlap old and unified workers, or run a separate Render while Export performs heavy work on this budget.
3. Leave `EXPORT_UNIFIED_WORKER_ENABLED=false` and reset the cutover attestation. After the queue/lease checks, start exactly one existing `export-worker.mjs` using its original dedicated role, TLS policy and validated workdir/resource settings.
4. Leave new Render/Drive work queued and private until an approved worker can service it. The legacy worker must never be used to consume those queues. Do not roll back migrations, delete blobs/Drive objects, reset attempts, weaken fencing or remove checkpoints.
5. Observe recovery and only then restore approved admissions. This binary stop/start path was checked on an isolated loopback DB, not Blitz.

## External release gates

Unverified: Blitz Free eligibility, Japan-region terms, account age/contract, billing/budget, actual replica allowance, account-wide API/worker memory, real disk, restart/sleep/expiry behavior, real Google OAuth/Drive requests, provider resumable semantics, production role/TLS/CA/migration state, physical iPhone Safari upload/reselection/Files save and MP4 playback, long 1080p60 resources, 1.7GB/1440p support. A server-accepted and verified job is distinct from an unfinished browser upload; closing Safari does not guarantee a sleeping/expired worker continues running.

No deployment, merge, production DB/provider/file operation or paid-service activation is part of this PR.
