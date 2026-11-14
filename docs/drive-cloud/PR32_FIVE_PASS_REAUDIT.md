# PR #32: Five-pass follow-up audit (code review only)

Review scope: stacked PR #30 (Phase 1), PR #31 (Phase 2–6) and PR #32 (Drive Cloud hardening). The changes in this document are confined to the PR #32 branch. This is **not production acceptance**.

## Pass 1: Specification, upload acceptance and budget guards
- Inspected the user-requested original-vs-worker storage limits and the existing advisory frontend preflight.
- Found that the server-side original upload reservation accepted files larger than the configured worker verification limit.
- Changed `DriveCloud.reserve` to reject an original larger than `min(maxFileBytes,maxWorkBytes-marginBytes)` before metadata or quota reservations.
- Added a database-backed regression test that verifies rejection and zero new reservations/inventory. The capacity gate does not claim actual physical disk has been tested.
- Confirmed production policy remains fail-closed without cost, terms, verified-TLS and worker resource gates.

## Pass 2: Authentication, owner isolation and provider failures
- Rechecked refresh token storage, per-owner connection generation, SQL lease and cross-process locking, provider-401 invalidation and membership requirements.
- Preserved the previous PR #32 fixes: server-only token reuse, generation invalidation, single-flight refresh and rejected-token invalidation.
- Inspected ticket redemption under RLS and the owner-specific Drive inventory lookup. No owner access bypass was demonstrated by this code review.
- Did not weaken JWT, RLS, SQL grants, TLS or ticket expiration.

## Pass 3: Worker, duplicate media and transfer integrity
- Reviewed `DriveTransfer`, `DriveCloud.verify`, `writeDriveObject`, and `driveRenderStorage` with the existing 308 offset/resume and SHA-256 checks.
- Found the render resource lookup could select an unverified/held inventory entry when an original media version had multiple Drive records.
- Restricted render reads to `state='ready'` and made selection deterministic (newest verified first); added regression tests rejecting unverified and held Drive resource reads.
- Preserved existing R2 fallback and immutable remote revision reads. This is a static/native test claim only, not proof of Google provider behavior.

## Pass 4: UI, errors and Safari wording
- Separated a too-large worker-verification-file rejection from the existing exhausted-verification-retries error, including API/UI schema and regression assertion.
- Clarified that a server-accepted job survives closing Safari, but processing can progress only while its Worker is running/recovered. No promise of live Blitz availability.
- Retained explicit manual confirmation after MP4 saved to Files; no automated deletion or browser-wide token storage.

## Pass 5: Diff, CI and deployment gates
- Confirmed dependency chain is #30 -> #31 -> #32. No branch rebasing, production deployment, PR merge, database migration, live Drive operation, payment or deletion was authorized or performed.
- PR #32 originally improved 5-second timeouts for media uploads, token reuse, read-only interim-capacity reporting, render range-specific reservations, actual Drive blob revision retention and guarded frontend preflight.
- An unrelated legacy Cloud Export integration test exceeded its fixed 5-second wall-clock limit on shared CI twice. Kept the >1 MiB media content and all range/HEAD/ownership assertions, adjusting only that one test's wall-time limit to 15 seconds. Subsequent Pages unit tests completed successfully on the earlier revision. All HEAD-specific CI results must be checked independently.
- The latest GitHub Actions CI and Pages test conclusions must be checked for the final PR #32 HEAD; this document makes no claim of a completed success while runs are pending.

## Remaining gates before any merge/deploy
1. Confirm **both** required PR #32 HEAD workflows succeed and check changed-file regression tests.
2. Verify all PR stacking and merged-main conflicts against current main immediately before integration.
3. Test actual Google OAuth and resumable uploads with a small throwaway fixture without modifying existing personal Drive files.
4. Validate actual Blitz Free RAM/disk/DB TLS/worker sleep behavior and full monthly cost within ¥500 before toggling any production Cloud gate.
5. Validate actual iPhone Safari upload, restart, Files save, 1.7GB material, long 1080p60 and optional 1440p separately, keeping Cloud OFF before explicit release approval.
6. Full automatic deletion/GC is **not implemented or authorized**. Cleanup preview is read-only.

## Final decision
**Code corrections: reviewable Draft PR, conditional. Production acceptance: unverified.**
