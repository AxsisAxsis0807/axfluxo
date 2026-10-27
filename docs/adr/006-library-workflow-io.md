# ADR 006 — Phase 3 material library and committed save

2026-10-27 JST. Investigated current main `a53fe323c72642ec79a9bea9d5aec224443c90af`; fetched before implementation, never reset. Working branch `feat/workflow-phase-3`. No AGENTS.md found. Node 24.19.0/npm 11.9.0; npm ci from existing lockfile. ADR 005 describes historical Phase 2 behavior; this ADR supersedes its library/save boundary only.

## Storage and compatibility

Reuse `axfluxo-workspace`, upgrade 1→2, add only `libraryFiles`, `libraryVersions`, `libraryFolders`, `libraryReferences`, `libraryReceipts`, all with `id` keyPath. No records are rewritten or deleted. Upgrade checks store existence and is one native atomic IDB versionchange transaction; aborted upgrades preserve v1. Existing onblocked/versionchange handling remains. No new DB; `axfluxo` v1, `axfluxo-workflow` v1 and `axfluxo-execution` v1 remain unchanged. Existing workspace documents remain schemaVersion 2; legacy documents remain schemaVersion 1.

Logical files have a name, folder, kind, immutable current version ID, created time and trash flag. Versions contain independent immutable normalized bytes/original bytes, MIME, dimensions, size and both hashes. There is no implicit-latest resolver. The pre-existing Phase 2 LibraryReference meaning (`scope`, libraryId/fileId/versionId/kind/hash) is unchanged. File/audio/video kinds remain expressible in references/file metadata; only image import/edit/backup is implemented. No format conversion of audio/video to images is offered.

Deletion changes only the logical file's trash flag. Every version remains readable for existing workflows and snapshots. References are append-only conservative pins from workflow publication, run snapshots and saved results. No physical deletion/GC API exists; removing an edge, undo or trash cannot invalidate a pinned version. A future collector must account for recovery, histories and receipts before releasing these pins.

## Import and UI

Reuse existing `importImage` decoding/normalization, header and pixel limits, MIME detection, hash validation and canvas cleanup. Additionally compare declared MIME against sniffed original MIME. Normalize images to PNG while retaining original bytes; deduplicate by original SHA-256 inside the same readwrite transaction, including across tabs. Reimporting a trashed identical original restores visibility rather than creating another file. Import each batch sequentially. Abort during decoding is observed before publication; transaction cancellation aborts all pending file/version writes. Already completed batch items remain and the UI reports the count. Quota failure is surfaced; existing Workspace error types are preserved outside the library adapter.

Library is an additive modal with 44px controls, focus return, Tab containment, Escape handling, folder creation/rename/reparenting with cycle checks, file rename/move, search, name/date sort, detail metadata, trash/restore and selection. Thumbnail rendering is serial and generates small temporary previews; views page at 12 items. Object URLs and canvases are released. No conveyor/palette redesign.

The existing source@1 config optionally carries `libraryRef`, mutually exclusive with legacy `assetId`. Legacy selections retain the original store meaning. Node settings open the same library and commit the exact reference. Missing versions/hash/MIME/dimensions fail through the existing resolver. Snapshots pin the selected version, which can fan out and be shared across workflows. No bytes enter graph JSON.

## Save and recovery

`createRegistry(saveCapability?)` remains usable as a pure Phase 2 registry without persistence. Production explicitly injects `saveLibraryOutput`; the existing save@1 gains an additive Workspace-only `out:image` port containing its saved library reference and retains its old `image` input and `name` config. Legacy v1 canvas/connection definitions keep their original single input port. `folderId` is optional. There is no node type replacement, document rewrite or SNS handler.

Save is `pure:false`. Runner never reads or writes the pure cache for this handler. Each success creates a new logical result file and immutable version; source versions are never updated. File/version/reference pin/receipt publish in one workspace transaction with cancellation. The receipt associates the original committed run/node/attempt with its AssetRef. Subsequent attempt outputs associate retries with the same result.

Receipt identity is SHA-256(root retry run ID, node ID, actual input hash, save config). Repeated retries in the same chain reuse the receipt. A new independent run creates a new result; a changed actual input/config creates a distinct result. Retry ancestry is resolved from the existing retained recent history; if unavailable, fail explicitly rather than guessing and duplicating a save.

Execution history is in a separate DB. There is deliberately no claim of cross-DB atomicity: a crash/cancel/history quota after the library transaction commits may leave an interrupted/failed run with a committed result. The receipt is durable, recovery never automatically replays, and retry reuses that result. Cancellation before the commit point rolls back file/version/receipt together. A committed result is not removed if cancellation arrives later. Tests cover history failure followed by retry, quota during receipt staging and cancellation while staging the receipt.

## Backups

Workspace ZIP formatVersion 2 adds the full local library (including trash), immutable versions, original blobs and folder metadata. Workflow refs retain exact IDs. Existing v1 Workspace ZIP, Studio ZIP and legacy workflow formats remain supported through their existing paths. No execution history/cache/receipt journal is exported; saved image versions are included.

Library portion is bounded to 100 files/versions/folders and 40MiB combined normalized+original bytes. Existing outer ZIP limit remains 200MiB/500 entries/5MiB JSON; decode work is sequential. Above the library bound export fails clearly instead of silently omitting assets. This is a bounded in-memory ZIP implementation, not a streaming archive or an iOS memory guarantee.

Restore validates archive policy, schema, IDs, cycles, hashes, decoded MIME/dimensions, exact workflow/version relationships and fonts before publication. All restored workflow/editor/artifact/library records and a backup-content hash marker publish in one workspace transaction. A repeated identical ZIP returns the same restored Workflow; concurrent duplicate restores serialize on the transaction. Existing matching immutable rows are reused. Mutable metadata conflicts are safely rejected instead of overwriting the user's current library; restore on an independent origin/device when deliberately recovering a conflicting older snapshot. No partial restore publishes on validation failure/transaction abort.

## Rollback and handoff

Do not downgrade or delete the workspace database. A pre-Phase-3 client requests workspace v1 and cannot open an upgraded v2 DB. For rollback keep this v2-aware source and rebuild locally with `NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false` to enter legacy Studio, or `NEXT_PUBLIC_WORKFLOW_RUNNER_ENABLED=false` to disable execution only; keep all rows. These flag rebuilds were not re-executed in Phase 3. Retain a formatVersion 2 backup and this implementation commit for re-enabling. Do not import a v2 backup into an older client or translate library refs back into legacy assetIds.

Phase 4+: design physical retention/GC and pagination/indexes before library growth; consider streaming archives and deterministic collision remapping; provide direct retry-root lookup beyond the recent-history window; extend MIME/kind-specific version validators for generic media. Preserve receipt semantics if save evolves, and add queues/backpressure separately from rendering or animation. No Phase 4 work is included.
