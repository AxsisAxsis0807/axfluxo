# ADR 007 — Phase 4 Workflow / Studio integration

2026-10-29 JST. Baseline: main `367fb02570b4782aa5f51e892718fc473b376c59`, clean initial `work` checkout. Fetched main before implementation; no AGENTS.md in repository or ancestors. Branch `feat/workflow-phase-4`. No formal Phase 4 specification found; use the user's provisional scope. ADR 004–006 remain authoritative for existing contracts.

## Investigation and scope

WorkflowCanvas shares React Flow and touch controls with legacy Workflow. Workspace schema v2 owns independent image-edit v1 documents. The common ImageEditor/useEditorSession reuses Studio image/text/shape/page/layer/Undo tools. Workspace Autosave serializes writes and applyEditor checks graph/editor revisions atomically. Phase 2 runner snapshots immutable sources/applied revisions and uses pure cache; Phase 3 save publishes library versions/receipts separately. Legacy Studio, Workflow and backup entry points remain separate. CI uses root static export; Pages builds /axfluxo and only deploys main.

Existing fixed inputs, copy-before-replace/rebuild, immutable applied revisions, output generation, conflict recovery and old backups already meet much of Phase 4. Gaps: connected library sources cannot open Studio directly; executionEditorInput rejects library output (including save); users cannot return with a saved draft without applying it. An unapplied editor also blocks full-run preflight, so its processed upstream image cannot be prepared in the initial connected graph.

Implement these gaps, clarify UI actions, add regression tests. Reuse library source selector and existing save node rather than adding another node/config/picker. Exclude SNS/OAuth/API, Factory, GC, scheduler redesign and quality modes. Files: editor-input.ts, workspace/input.ts, ImageEditSession.tsx, WorkflowWorkspace.tsx, RunPanel.tsx, tests and documentation. Main risks: reference collisions, cancellation/partial publication, stale result adoption, draft/apply confusion, mobile toolbar space.

## Preparing processed inputs

The selected connected image-edit node exposes an explicit upstream-only command in RunPanel. Compute its input ancestors and clone only those nodes and their internal edges; retain workflow/ancestor IDs and leave the saved graph unchanged. Use the existing snapshot, registry, locks, cancellation, cache and history through RunPanel. The unapplied target, descendants and unrelated branches are excluded, so a downstream save is not executed while preparing input. A save that is itself an ancestor retains its existing explicit execution semantics. No automatic execution occurs on opening Studio. Ancestor graphIdentity remains identical, allowing executionEditorInput to consume the newest valid prepared result using the unchanged authority rules. Retry retains the partial snapshot. Full execution still performs the original complete validation.

This fixes the initial source → processing → unapplied Studio deadlock without weakening runner validation or substituting source bytes for processed output. Test that the subset excludes the target/downstream/unrelated side effects, preserves graph identity and never mutates the graph. Browser coverage prepares resize output before applying Studio and prepares a changed upstream input before copy-and-replace.

## Input/output and persistence

A selected source libraryRef pins library/file/version/hash, never latest. Resolve and validate it through the existing Phase 3 resolver, then copy consumed normalized PNG once into Workspace assets. Derive a UUID from the full canonical library reference, without assuming library keys are UUIDs. Execution output IDs retain their previous mapping. Validate any existing destination against the immutable hash. Publish with abort checks in the IDB request callback; no source version is modified. This same adapter handles library results consumed from the newest valid ancestor run. Existing run authority rules remain.

Studio retains its original AssetRef and input layer ID. Input changes require keep/copy-and-replace/copy-and-rebuild; missing input offers explicit frozen-input resume. Applying creates a new immutable revision/page pointer, not a mutable image. Draft-only return awaits the existing save barrier and does not change applied revision/output. It preserves edits for reopening; it is explicitly not destructive cancellation. Existing apply button remains compatible, and export stays a separate OS download. Save failure/conflict keeps the session open. Uncommitted form/IME input and imports block return. A graph barrier precedes closing the session.

No DB version/store/index/schema changes or migration. Workspace v2, execution v1, Studio v1 and Workflow v1 remain intact; existing ZIP formats remain readable. Rollback uses Phase 3 source against the same DB; retain backups and all rows. No deletion/rebuild/downgrade. Newly copied editor assets use the existing backup mapping.

## Verification

Run typecheck, lint, all unit tests, production build and full desktop/mobile Chromium E2E at root and /axfluxo. Add library-to-fixed-input unit coverage for exact reference, deduplication, missing version/collision/cancellation, and an E2E covering Studio draft-only return, unchanged applied version, reopening/apply/output/save/reuse and changed input protection. Existing tests retain assertions and are not skipped. Physical iPhone Safari portrait/landscape, keyboard/IME, gesture interference, background/close during IDB write and device memory remain manual acceptance items. No deployment or merge.
