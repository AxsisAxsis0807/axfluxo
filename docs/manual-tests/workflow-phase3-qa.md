# Phase 3 independent QA — 2026-10-28 JST

Baseline: PR #7, Draft, feature HEAD `73e2ec56850cacb0e9059255e2d29219f288ff6b`; main `a53fe323c72642ec79a9bea9d5aec224443c90af`. Local initial branch `work` at main, clean tree; no AGENTS.md found. Fetched current refs and created the existing feature branch locally without reset. PR had one commit, no discussion/reviews; baseline CI/checks and Pages/build succeeded (CI run 40499838262). No main write, merge, deployment or Phase 4 work.

## Findings and fixes

1. Restore compared existing immutable versions using only hashes and IDs. A row whose width differed from the archive was silently reused and the restored Workflow published successfully. The new regression failed against the baseline. Compare all immutable metadata and Blob MIME/size, reject conflicts atomically, retain the existing row and Workflow. This does not repair already corrupted bytes or claim that metadata comparison rehashes resident Blobs inside IDB transactions; the resolver still validates bytes before use.
2. Restored original image dimensions were checked only after decode. An oversized compressed image could allocate a decoder surface before rejection. Inspect the existing PNG/JPEG/WebP header before decoding, keep decoded limits, and release the decoded source after validation. A forged 9000px original with a matching archive hash is rejected before its decoder runs.
3. Library restore callbacks did not explicitly catch synchronous IDB errors. Route callback exceptions through the transaction failure function. Injected QuotaExceededError rolls back files/versions/restore marker while preserving an unrelated existing Workflow.

## Additional tests

Eight added unit cases cover immutable metadata conflict, oversized original header, unavailable retry ancestry, restore quota rollback, cancellation immediately after library commit, backup budget rejection, aborted migration and an old-tab migration block. The last case proves a committed asset/receipt remains, records original run/node/attempt, and retry reuses the exact reference without another save. Existing tests retain pre-commit cancellation, history failure, pure-cache separation, original hash protection, v1/v2 ZIP compatibility, duplicate restore, missing versions, import/folder operations and migration preservation.

Browser additions exercise 844×390 touch operation with 13 distinct images, a 197-character unbroken filename, pagination, viewport/overflow bounds and reload persistence; and duplicate inspector access while the original thumbnail is visible. Existing tests are retained without skips or assertion relaxation.

## Storage and rollback limits

Workspace v1→v2 is an additive native versionchange transaction; existing Studio/workflow/execution DB versions remain unchanged. Fake IndexedDB migration and injected abort/quota checks do not establish actual iOS low-storage behavior. Multi-tab CAS/host locking is exercised by existing browser regressions; real OS process termination during upgrade is unverified.

Save and execution history use different DBs. Cancellation/crash/history failure after the library commit can leave a committed result associated with an unsuccessful run; the durable receipt supports retry reuse. Retry ancestry outside the latest 100 history entries fails explicitly without guessing. Backups omit execution history/cache/receipts, so restored images are retained but the original execution's retry journal does not transfer. Soft-deleted versions/pins are retained; no physical GC. Library backup limit: 100 files/versions/folders and 40MiB of normalized+original data; outer ZIP 200MiB/500 entries/5MiB JSON. ZIP assembly is in memory and this is not an iOS memory guarantee. Conflicting mutable metadata is rejected rather than overwritten.

Rollback must retain all DBs and v2 ZIPs and use a v2-aware build with Workflow-first or runner flags disabled. Do not downgrade/delete the DB or run an old workspace-v1 client against upgraded data. Reverting only the QA fixes restores the validation gaps above. Feature flag roundtrip builds are not part of this QA's confirmed results unless explicitly recorded below.

## Physical device acceptance — not executed

Linux Chromium, including mobile emulation/touch and landscape, is not iPhone Safari. Physical Safari landscape/portrait, software keyboard/IME, VoiceOver, safe areas, OS tab eviction, actual quota exhaustion and GPU/heap behavior remain manual. Authentication uses existing mock E2E; no real email/account acceptance or external asset upload.

## Results and timeout investigation

Final measured results are appended after the test runs. Historical Phase 3 passes are not counted as this QA's results. A successful rerun alone is not a timeout fix.

Additional UI finding: the 197-character unbroken filename produced scrollWidth 1305px inside an 820px-wide library panel at 844×390. The added touch/pagination test failed against the baseline. Apply inherited `overflow-wrap:anywhere` within the library panel so filenames and details remain inside the available width.

Duplicate diagnosis: a deterministic added test generates the original thumbnail before duplication. The settings button on the copy is then covered by the selected original, whose higher React Flow z-index and taller thumbnail-bearing card overlap the copy positioned only +40,+40 away. Playwright's trace repeatedly reports the original `.react-flow__node ... selected` article intercepting pointer events until the 60s timeout. Select the copy after the duplicate bundle is committed so its button is raised above the original. This is a reproduced defect, not a claim based on rerun success. The earlier PR's intermittent test did not explicitly render/wait for a thumbnail, and its historical local trace is unavailable in this checkout; identity with that earlier timeout is unproven. Keep that historical observation open while validating this regression and the unchanged original test.

## Final automated results

| Check                          | Result                                                    |
| ------------------------------ | --------------------------------------------------------- |
| npm ci, unchanged lockfile     | Success, 422 packages                                     |
| TypeScript typecheck           | Success                                                   |
| ESLint                         | Success, zero warnings                                    |
| Unit tests                     | 140/140, 15 files (132 baseline + 8 added)                |
| Root production build          | Success                                                   |
| /axfluxo/ production build     | Success; copied source files compared to the feature tree |
| Root full E2E                  | 98/98, 5.2 minutes (94 baseline + 4 added project cases)  |
| /axfluxo/ full E2E             | 98/98, 5.0 minutes                                        |
| Added boundary E2E after fixes | 4/4, desktop/mobile                                       |
| git diff --check               | Success                                                   |

The earlier baseline root run also passed 94/94. The deliberate added boundary reproduction failed 4/4 before fixes (two overflow and two pointer-interception failures); these failures are evidence, not final acceptance results. Formal full suites keep all existing tests and assertions; no `.skip`, deletion or expectation relaxation.

Auth/guest/Studio/Crop/PNG/JPEG/ZIP and Phase 2 runner/cache/cancel/recovery remain part of both complete browser suites and the unit suite. Browser auth uses mocks. Root/basePath full suites execute sequentially on system Chromium, using separate fixed production artifacts.

Feature HEAD CI, Draft and review state are checked after push and reported on PR #7/the final handoff; the baseline CI result above is not evidence for a later commit. Provisional judgment is CONDITIONAL PASS only if the final local and GitHub gates pass: physical Safari acceptance and the identity of the historical intermittent timeout remain open. Keep Draft; no merge or deployment.

Evidence is retained under work/: typecheck-final.log, lint-final.log, unit-final.log, build-root-final.log, build-base-final.log, e2e-root-final.log, e2e-base-final.log, repro-version.log, e2e-boundaries-repro.log, e2e-boundaries-fixed.log and boundary-repro-final/ (traces). These generated files are not committed.
