# Workflow Phase 2 verification — 2026-10-26 JST

Starting main/HEAD: `15b51bfabce277ff040559a66616c0f255011ab6`, clean branch work; origin AxsisAxsis0807/axfluxo. Fetched latest main (same), then created feat/workflow-phase-2. No AGENTS.md found. Inspected package/lock/engines, v1/v2 schemas, connections/palette/inspector/canvas/workspace/session, Studio/Canvas/CropDialog/cropGeometry/scene/fonts/effects, legacy/Workspace assets/resolvers, persistence/recovery/migration/backup, Account/auth/guest/logout, Next static export/basePath/Pages/CI and ADR 002–004/manual evidence. No dependency changes. No deployment or merge.

## Baseline and environment

Node 24.19.0, npm 11.9.0, Linux, installed system Chromium. Sandboxed networking could not reach the proxy; network/build/browser commands succeeded with the supported permission escalation. npm ci installed 422 packages from the existing lockfile. The first sandboxed Next build compiled but could not spawn TypeScript correctly; permission-enabled build passed. An initial E2E attempt without public auth settings was stopped after auth failures (non-auth desktop regressions passed). A worktree command initially targeted the implementation cwd instead of the baseline cwd, so that first incomplete E2E run is not used as baseline evidence. Corrected baseline used independent clean detached worktrees, CI's public Supabase settings and separate root/basePath servers. Initial dependency symlinks were replaced by physical copies because Turbopack does not compile outside its filesystem root. No tests were skipped or weakened.

| Check                  | Before change                        | Final feature                             |
| ---------------------- | ------------------------------------ | ----------------------------------------- |
| npm ci                 | pass, 422 packages                   | unchanged dependencies/lockfile           |
| typecheck              | pass                                 | pass                                      |
| lint                   | pass, zero warnings                  | pass, zero warnings                       |
| unit                   | 79 pass, 11 files                    | **102 pass, 14 files**                    |
| root static export     | pass                                 | pass                                      |
| /axfluxo static export | pass                                 | pass                                      |
| root E2E               | **82/82 pass**, desktop/mobile, 4.8m | **88/88 pass**, desktop/mobile, 6.2m      |
| /axfluxo E2E           | **82/82 pass**, desktop/mobile, 4.6m | **88/88 pass**, desktop/mobile, 5.8m      |
| runner-disabled export | n/a                                  | pass; document/history roundtrip verified |

Auth E2E intercepts public API requests; actual emails/live-account changes are not exercised. Public config is identical to CI. Chromium's iPhone 13 viewport/touch profile **is not physical iPhone Safari**.

## Automated scope

- T07: diamond/fanout, deterministic tie order, stable first/second collection ports/reversal/index, shared immutable source version, real PNG dimensions/color.
- T08: invalid values/JSON-shaped inputs, unknown schema/type/typeVersion, excessive graph, required input, mismatched ports, duplicate cardinality/cycles, legacy save/post preserved and safely unsupported. v1/v2 fixtures/recovery/ZIP remain in existing suites.
- T09: failed ancestor, blocked descendants without outputs, independent continue and global stop, sanitized exceptions.
- T10: late unabortable encode cancellation, no output/cache publication, no new node start, transactional abort, reload → interrupted run/node/attempt and no automatic replay. Real Chromium encode is delayed until after cancel before callback release.
- T11: config/input/font/renderer changes and canonical property order; fresh retry attempts; fixed snapshots despite UI changes; cache eviction pins history results; ten real runs create only three intermediate image blobs and reuse cache.
- References: legacy ID/v2 refs keep original DB meaning; injected library exact-version adapter, missing version/hash/MIME/dimensions/size errors, file→image refusal, source original hash unchanged, sharing across workflows.
- Renderer: image-edit run hash compared with existing manual applied-revision output on desktop/mobile. Studio/crop/PNG/JPEG/ZIP regressions run unchanged.

Additional final results, fixes and known limits are appended after validation.

## Physical/manual checklist (not executed here)

1. Physical iPhone Safari, portrait/landscape: expand execution panel, start/cancel/retry, scroll history, edit number/crop configs, connect ports. Ensure 44px controls, native number/text Undo/IME, focus return, keyboard/VoiceOver and safe-area visibility.
2. Background during decode/encode; return before/after OS tab eviction. Live work may resume; evicted work must show interrupted, never auto-replay. Validate memory under realistic large images and ten runs on target hardware.
3. Low device storage/quota and browser termination mid-IDB transaction: prior documents/originals remain; failed history save does not report success.
4. Two real browser tabs: running lock prevents second run and false interrupted recovery; after close/reload lock releases and abandoned work is interrupted.
5. Optional live email authentication confirmation/logout/guest persistence in an authorized test account. No real account mutation or email was requested/performed.

## Limits, handoff and rollback

See ADR 005 for full contracts. Serial scheduler; image-only pair collections; applied image-edit connected inputs must match their explicitly applied input hash. Material library UI/DB, generic file/audio/video editing, save/post/SNS, operations with external side effects, factory animation/queues, execution ZIP export and history deletion UI are not implemented. Last 100 runs shown; older records retained. Source/editor document backup stays compatible. Only consumed outputs are copied into v2 assets and included in its backup. Full heap/GPU/iOS memory pressure and physical Safari background behavior remain unverified.

Disable only runner with NEXT_PUBLIC_WORKFLOW_RUNNER_ENABLED=false; new graph records remain readable and stored. Reverting code retains all databases, but older strict validators reject new node types until feature re-enabled. No Workspace DB version upgrade or document migration. Phase 3 must supply immutable version storage/ref retention plus an idempotent committed save before implementing save. Phase 6 can add item queues/backpressure over runner/value/events; no animation coupling.

## Additional final checks and fixes

- The first feature root full run was 87/88: a new test fixture read the initial workflows table before the app's first save completed. The fixture now waits for a saved Workflow selection UUID, rather than merely the initially visible name field. This strengthens synchronization without relaxing rendering assertions. After correction, root and basePath both passed 88/88; the final guard build is verified again below.
- Final review added an atomic cancellation check around run finalization: cancelling as the final run transaction settles must not emit late success. A targeted regression intercepts that transaction and asserts cancelled durable state with no succeeded event.
- Registry preflight rejects old readable width-8192 configs and oversized explicit output pixel area before allocation; those legacy documents remain unchanged/readable. Runtime still checks input-dependent output dimensions before render.
- Same-origin enabled → disabled → enabled builds retain the exact workflow/run rows at 1440px and 390px. Reproduce with `node scripts/check-workflow-runner.mjs` against two root builds served at WORKFLOW_RUNNER_URL / WORKFLOW_RUNNER_OFF_URL (defaults ports 3180/3182). This uses real isolated Chromium storage, with disabled-build responses intercepted under the same browser origin; it is not a production deployment.
- New reference/DB tests cover idempotent editor materialization/stale-ancestor refusal, VersionError retaining a future store, corrupt-history retention and atomic cache-eviction abort.

Final cancellation/limit guard build: **root 88/88 pass (6.2m), /axfluxo 88/88 pass (5.8m)**. Typecheck/lint pass, unit **102/102 across 14 files**, all three static builds pass. No product-code edits follow these checks. Logs: work/e2e-complete-root.log, work/e2e-complete-base.log, work/build-complete-root.log, work/build-complete-base.log, work/build-complete-off.log, work/runner-rollback-complete.log. No live email, physical Safari or production deployment was performed.
