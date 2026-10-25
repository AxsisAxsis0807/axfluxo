# ADR 003 — Workflow First Refactor, staged editor extraction

Date: 2026-10-25 JST. Independent of Phase 2–6. **This change is WFR-0/1;
WFR-2–6 and the complete Workflow First experience are not implemented here.**

## Starting facts

Repository: AxsisAxsis0807/axfluxo. Starting local HEAD and current main confirmed
through GitHub and `git ls-remote`, then fetched:
`26ee040e3c5093807c69b3daa4484aaa10955a9d`. The working tree was clean. No
AGENTS.md was found in `/`, `/workspace`, or the repository. Branch:
`feat/workflow-first-refactor`. Existing PR #4 is not modified or reused.

Node 24.19.0 / npm 11.9.0, `.nvmrc` 24.19.0. Exact dependencies remain Next
16.4.2, React/DOM 19.3.0, React Flow 12.12.0, Dagre 3.1.2, Konva 10.9.0,
Zod 4.6.7 and fflate 0.8.3. No dependency or lockfile changes.

Investigation covered the app entry/layout/CSS, Editor/Canvas/CropDialog,
ProjectDocument/crop/text/scene, storage/assets/backup/fonts/auth/Account,
Workflow UI/domain/storage/autosave, limits, static configuration, scripts, CI,
tests, ADRs and manual/research records. The app entry is client-only dynamic
loading. Editor owns navigation, library, legacy save coordination and editing.
Workflow v1 rejects unknown node types/versions. Its image resize/crop settings
have no execution implementation. Existing DBs are `axfluxo` v1 and
`axfluxo-workflow` v1. The normalized Asset.blob is PNG even when Asset.mime
records the original JPEG/WebP format. Crop calculations and text layout are
shared with scene rendering. The document's actual type is ProjectDocument.

Limits remain 20MiB, 24MP, image side 8192, page side 4096, 8.5MP, 20 pages,
100 layers, and backup 200MiB/500 entries/JSON 5MiB. Source import validates
signature, animation, decoded dimensions and hash; pre-decode dimension header
inspection remains a later performance/security task. Existing safe ZIP paths
and format remain unchanged. Auth callback and static basePath remain unchanged.

Existing mobile code has canvas-scoped touch-action, safe-area and dynamic
viewport sizing. Workflow has the node-origin pinch fix and explicit inspector
connection buttons. A 44px canvas handle shrinks with zoom, so those inspector
buttons remain the accessible alternative. Real iPhone/IME/VoiceOver evidence
is absent in earlier records and remains absent for this stage.

## WFR-1 boundaries implemented

- `ImageEditor.tsx`: existing Studio editing UI, Canvas and CropDialog. Explicit
  document, state and callback contract; no DB opens, app screen state or
  save coordinator lifecycle. `onBack` belongs to its host. The UI is moved,
  not regenerated. Layers, pages, variables, text, crop and template controls
  remain available.
- `useEditorSession.ts`: one mounted editor's ProjectDocument history, selected
  page/layer and UI controls. Domain reducer is reused. Undo history is local
  to a mounted session, not persisted. Canvas continues to own ephemeral pan.
- `EditorFields.tsx`: existing number/text/color controls shared with export.
- `LegacyStudioAdapter.ts`: existing Studio library loading, document/asset
  writes and legacy backup/restore services. It deliberately delegates existing
  behavior and does not convert projects or change the database schema.
- `asset-resolver.ts`: UUID → normalized image Blob and dimensions. The minimal
  result deliberately excludes original MIME and original Blob. Legacy lookup
  is the compatibility default. No injected resolver failure falls back to a
  different mutable legacy asset.
- `createScene`, Canvas, CropDialog, `exportPage`: resolver threading. The same
  lookup resolves image bindings in preview, crop and export. Existing domain
  geometry/text/scene and decoder/fonts remain in use.
- `Editor.tsx`: remains the legacy host during extraction, including app shell,
  save queue, export dialog and account/library/template integration. It does
  not unmount the save coordinator when the visual ImageEditor closes.

The proposed WorkspaceShell is intentionally deferred until WFR-5, rather than
renaming the legacy monolith and claiming the shell split is complete. The
LegacyStudioAdapter is `.ts`, not `.tsx`, because it has no view. A future
ImageEditSession must supply the same ImageEditor contract through its own
repository; using a React key alone is not persistence.

## Subsequent implementation contract (not shipped by this PR)

WFR-2 must add strict WorkflowDocument v2 and `axfluxo-workspace` v1 with stores
workflows/preferences/editorDocuments/editorRevisions/assets/artifacts/recovery/
migrations. Keep v1 validation and both old DBs. Copy imports use new IDs and
idempotent source/revision migration records. Validate all image layer IDs and
both default AND current values of image variables. UUID → AssetRef mappings
live outside ProjectDocument. Missing or unknown data must not be overwritten.

Draft autosave, immutable applied revision and generated Artifact are distinct.
Atomic apply must CAS both workflow and editor record within one transaction;
only transaction completion means saved. Blob decode/render/hash happens outside
write transactions. Coordinator generations must prevent stale saves/outputs
from reporting the newer generation complete. Conflict is explicit reload/copy,
never automatic overwrite. Recovery/history must retain referenced assets and
editor records; no automatic user-document GC.

WFR-3 adds image-edit typeVersion 1, in/image single input and out/image fanout,
explicit connected/selected/blank mode and per-node editorDocumentId. Validate
async load targets. Save barrier before switching nodes. Freeze resolved input
hash/layer and show upstream ungenerated state for unimplemented image
processing. Input change offers keep/copy-and-replace/rebuild. Duplicate editor
records and revisions independently; delete Undo retains records.

WFR-4 adds serialized per-node render with applied revision/page/font/render
spec cache key and generation/cancel checks before adoption. ZIP uses a distinct
manifest and strict path allowlist, bounded expansion/JSON/depth, hashes and
validated new-ID remapping before an atomic restore. Never broaden old safeUnzip
paths to accommodate a new format. No DAG scheduler or SNS execution.

WFR-5 introduces Workflow-first WorkspaceShell with an independent feature flag,
legacy Studio entry, viewport/selection restoration, focus return, full-screen
mobile editor and safe navigation. Keep root/basePath/auth callback contracts.
Disabling it must keep old entry and all DBs; no reverse conversion.

WFR-6 requires regression, forced abort/quota/CAS/stale-generation tests,
root/basePath static artifacts, bounded memory/resource evidence, and separate
real iPhone Safari/IME/VoiceOver acceptance. CI/emulation do not satisfy physical
acceptance. No merge, auto-merge or deployment without explicit authorization.

## Compatibility evidence and rollback for this stage

Original storage and backup codecs, Workflow schema/storage/gesture code, auth,
limits, styles, Next configuration, CI and dependencies have no diff against
starting main. No new DB or migration is introduced. v1 fixture documents and
viewport are committed for future copy-migration tests. The Studio fixture has
three distinct references: layer asset, image-variable default and current
value, to expose incomplete reference collection in future migration tests.

Rollback this extraction by reverting its commits; both existing DBs remain
readable by the old app. Existing `NEXT_PUBLIC_WORKFLOW_ENABLED=false` still
removes the Phase 1 Workflow entry. A Workflow First feature flag is **not yet
introduced**, because the Workflow First entry and new data format are not
shipped in this extraction. Phase 1–6 instruction documents are not rewritten.
