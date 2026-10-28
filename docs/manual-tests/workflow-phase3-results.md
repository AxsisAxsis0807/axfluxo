# Phase 3 verification and physical-device acceptance

2026-10-27 JST. Base/current main investigated: a53fe323c72642ec79a9bea9d5aec224443c90af. Feature branch: feat/workflow-phase-3. No merge, main push, deployment, SNS, real-account email or external asset upload.

## Automated scope

T12–T16 unit coverage in `tests/library-phase3.test.ts`: original-byte/hash preservation, same-original dedup/restoring trash visibility, MIME mismatch/corrupt signature/oversize rejection, cancellation before publication and during encode, folder name/move/cycle/missing-parent handling, file move/rename/trash/restore, reference retention, exact shared source and reload document contract, save result AssetRef, source hash unchanged, repeated retry without pure-cache use, quota rollback, interrupted history publication followed by idempotent retry, cancellation during receipt staging, missing save folder/partial run failure, fresh-DB full ZIP restore, same-DB ZIP restore, duplicate ZIP prevention, bad hash/cycles, old v1 restore, pre-aborted restore and v1→v2 preservation/reopening.

Real Chromium browser coverage in `tests/e2e/library-phase3.spec.ts` runs at desktop and iPhone-sized touch viewports: real PNG/JPEG multi-import, serial thumbnail creation, duplicate original, folders/file naming/move/search/sort/trash/restore/reload, invalid MIME/decoder failure, library selection in existing source UI, real branched resize/crop/adjust, saved immutable ref, retry receipt dedup, ZIP restore and reuse of a saved result after reload in a restored Workflow. Graph seeding for the processing portion uses valid existing node schemas; source selection, import, execute, retry, backup and result reuse use the UI.

Existing assertions remain unchanged. Existing browser fixtures and rollback scripts only follow workspace DB version 2 when opening the migrated DB. Phase 2 pure-registry tests still verify that a registry without an injected persistence capability refuses save/post. Production uses the explicitly injected save capability; post stays unsupported.

## Results

Final local command results are recorded below. Branch/HEAD/Draft PR/CI identifiers are reported separately in the submission report. Intermediate failures were fixed without deleting/skipping tests or weakening existing assertions: keep Workspace quota exceptions unchanged, catch library IDB callback failures, add explicit select aria-label, use valid UUID processing fixtures, compare metadata independent of object key insertion order.

## Physical iPhone Safari — not executed

1. Use a review build supporting workspace v2, portrait then landscape. Import two non-sensitive PNG/JPEG photos. Confirm thumbnails, Japanese names/IME, search and name/date sort. Create parent/child folders; rename/move files and folders. Reject moving a folder into itself/descendant. Check 44px targets, scrolling, safe areas, focus return/VoiceOver and Tab/Escape with an external keyboard.
2. Add source→resize and source→crop→adjust→save branches using tap-selected ports. Select a library image and result folder, execute, inspect saved dimensions. Change the UI input after a run; retry must use the original snapshot. Open a second Workflow, select the saved result, execute and reload; exact version refs must persist.
3. Trash a selected input, then rerun its existing Workflow. Version remains available. Restore the file. Reimport the identical original and check no duplicate. Check original hash from a backup without publishing user material or logs.
4. Import a near-limit image and then cancel a multi-file import. Completed items remain; the pending item does not partially publish. Cancel processing, background Safari during encode, return after OS tab eviction; interrupted runs must not replay. Retry any saved result after interruption and confirm no duplicate receipt result.
5. In an isolated test device/origin, exercise low storage and close the tab during IDB writes. No success on failed save; originals and prior workflows remain. Inspect memory with realistic files; Chromium mobile emulation does not establish iOS Safari/GPU/OS memory behavior.
6. Download a library-inclusive ZIP and restore on an independent review origin/device. Check folders/originals, refs, editors and results. Retry the same ZIP, then interrupted restore, corrupt ZIP, old v1 ZIP and conflicting metadata. Rejected restores must preserve existing data.
7. With a user-authorized test account only, verify live email registration/confirmation/login/logout and guest persistence. Automated Auth E2E uses intercepted test responses and sends no real email.

## Limits / Merge decision

Physical Safari/IME/VoiceOver, OS tab eviction, actual device quota pressure and live email auth remain unverified. No benchmark of large real libraries is claimed. Library ZIP bound is 40MiB/100 versions; no streaming ZIP, physical GC, permanent deletion or retry ancestry beyond the recent-history window. Existing metadata conflicts on restore are safely refused. Library and execution history do not share a DB transaction; committed receipts make retry safe across the gap (ADR 006).

Flag-off rebuild/re-enable checks were not repeated in Phase 3. The supported emergency UI rollback is a v2-aware build with `NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false`; runner-only stop uses `NEXT_PUBLIC_WORKFLOW_RUNNER_ENABLED=false`.

Provisional Merge judgment is conditional on final automated results and physical acceptance. Any missing push/Draft PR/permission result will be recorded explicitly; do not infer approval or Phase 4 authorization. Rollback must use a workspace-v2-aware client and retain all stores/formatVersion 2 backups; never reset/downgrade/delete databases.


## Final local results

- npm ci: success with the existing lockfile (422 packages).
- npm run typecheck: success.
- npm run lint: success, zero warnings.
- npm test: **132/132**, 15 files (existing 115 plus 17 new T12–T16 cases).
- Root static production build: success.
- /axfluxo static production build: success, basePath/output export retained.
- Root full E2E: **94/94 pass (8.8m)**. Log: work/e2e-root-complete.log.
- /axfluxo full E2E: **94/94 pass (5.7m)**. Log: work/e2e-base-complete-2.log.
- Additional basePath library desktop/mobile checks: 4/4 pass.
- git diff --check: success. Dependency/lockfile, auth, Studio renderer and hosting/CI configuration are unchanged.

A parallel earlier basePath full run timed out once in the unchanged existing mobile editor-duplicate/reopen test (93/94). Without modifying that test or the product, isolated repetitions passed 3/3, and the final full basePath run above passed all 94. Its cause is **not established**; do not claim the timeout was fixed. Retain the earlier trace at work/test-results-base-complete/workflow-first-duplicate-a-8b8ec-ndependent-editor-documents-mobile/trace.zip for follow-up. Include rapid inspector close/reopen after duplication in physical Safari acceptance. The final pass is reported alongside, not in place of, this observation.

Provisional judgment: automated local checks pass, but keep the PR Draft pending GitHub checks, review, physical Safari acceptance and investigation of the observed intermittent inspector timeout. No merge/deployment was performed. Phase 4 was not started.
