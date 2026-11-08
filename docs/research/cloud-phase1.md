# Cloud foundation Phase 1

Baseline: `124ba9d205d0388b51b7d77df5d7a744c054c46a` (remote main and work branch,
2026-11-08). Initial worktree clean; no applicable AGENTS.md found. No frontend,
user-data schema, media profile, R2 implementation or existing template removed.

Implemented boundaries:

- Server-only config, PORT priority, explicit host, DB URL fallback/conflict checks.
- Web/Node streaming HTTP bridge, actual-body bounds and finite per-policy timers.
- Existing service functions wired into one sequential runtime; separate role pools.
- Import-safe individual entrypoints retained; shared finite shutdown and child reaping.
- API and worker Docker targets; optional build CA; separate worker-only persistent folder.

Runtime settings, launch commands and rollback are in `server/README.md` and
`infra/video/README.md`. No migration is required or automatically applied.
The new unified entrypoint is opt-in and disabled by default.

## Verification boundaries

All tests use synthetic media, fake auth/storage, PGlite or loopback HTTP. No
production database or provider dashboard is used. Unit tests retain the existing
fencing/lease and publication checks. The new shutdown path preserves committed
checkpoints and leaves interrupted execution to the existing lease mechanism.
It adds no held resume or checkpoint transfer semantics.

Initial parallel test execution encountered resource pressure: one existing
PGlite startup hook exceeded 10s, and Chromium local export had reached 89%
when its existing completion wait expired. Runs are repeated with heavy suites
separated; tests are not weakened or their expectations removed.

A fresh Docker build without `proxy_ca` was attempted and reached npm install,
then failed `SELF_SIGNED_CERT_IN_CHAIN` because this managed environment inspects
TLS. This proves the secret is no longer syntactically mandatory, but does not
prove a clean no-secret Internet build succeeds outside this proxy. CA-assisted
API build succeeded. A subsequent worker build hit the local execution disk
limit; only identified caches from this task were removed. Exact final results
are recorded in the conversation; scratch logs are under ignored `work/`.

WebKit installation was attempted using task-local browser storage. The download
hosts were rejected by the environment's destination policy (HTTP 403 Domain
forbidden). No network settings were changed or restrictions bypassed.

## Not established on blitz.cloud

- API and worker sharing one managed PostgreSQL, especially while API sleeps.
- Internal streaming listener reachability and background classification.
- DB TLS certificates, role creation/grants/SET ROLE/FORCE RLS, connection budget.
- Effective disk quota versus reservations, stop signal/grace and file retention.
- Peak RAM, runtime, output integrity and practicality of 1080p60 on the free worker.
- Finite FFmpeg workload acceptance and iPhone-only full operation.

No automatic login, keep-awake requests, provider SDK, billing or limit bypass is
implemented. 360p30 diagnostics, disk storage, transfer, held resume, tickets/Range
business endpoints and frontend integration remain later-phase work. No external
settings, permissions, Actions, deployments, messages, commits or PRs were changed.

## Recorded checks (2026-11-08)

- Full `npm test`: 48 files, 395 tests passed on the separated rerun.
- Final focused configuration/HTTP/runtime checks: 4 files, 30 tests passed.
- Google Chrome 157.0.8103.38 full browser run: 41 passed, 3 failed. Failures
  were normal FNF local export, failed-waveform FNF local export, and durable
  queued export recovery. All Versions local export and codec checks passed.
- A separate archive of the exact baseline SHA was tested with the same Chrome:
  normal FNF local export passed; failed-waveform FNF and durable export recovery
  failed. Thus two failures also exist in unchanged baseline code in this
  environment. A targeted final-source run also failed all three. Normal FNF
  passed once on baseline, so its cause remains unresolved; do not label all
  three as proven baseline failures or as resolved.
- `src/`, browser test definitions, contracts, migrations and lockfile have no
  Phase 1 diff. Test expectations and output validation were not relaxed.

- The developer-entry browser fixture bundles were rebuilt from baseline and
  Phase 1. After normalizing only the baseline checkout path and removing build
  comments/minifying, both SHA-256 values are
  `34ec4ea7b5587a5e340ee1e3366985213a417b51eea132c9455bedf299a01f81`.
  This supports unchanged browser code, not a claim that the three failures pass.
- Final typecheck, lint, production build and all seven server build scripts
  passed. API, unified worker and legacy render Docker targets built; API/render
  no-secret builds reused the CA-assisted worker's shared build cache. A clean
  no-secret download through this TLS-inspecting proxy remains unverified.
- Both API/worker images passed non-root, bundle/font/license/native Canvas/
  FFmpeg/build-secret-absence checks with networking disabled. API bind, JSON
  authentication response, default CMD and SIGTERM were exercised; worker default
  CMD/SIGTERM and legacy render ENTRYPOINT were verified.
- An existing synthetic container smoke test passed at 512 MiB, 0.5 CPU, no
  networking: All Versions and FNF base modes each produced and validated 60
  frames, including encoded/copied AAC. Its existing fixture is **160x90**, not
  evidence of 1080p60 feasibility. No production profile was lowered.
- WebKit/iPhone Safari and live blitz.cloud checks remain unverified. The full
  browser suite remains 41/44 successful in this environment; the failures are
  retained with baseline comparison evidence, without weakening validation.
