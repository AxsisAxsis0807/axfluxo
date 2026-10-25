# ADR 004 — Workflow First v2 through WFR-5

2026-10-25 JST. Supersedes the future-work portions of ADR 003. WFR-0/1's
historical test record is retained; current verification is
[workflow-first-wfr5-results.md](../manual-tests/workflow-first-wfr5-results.md).
This is independent of the separate Phase 1–6 roadmap. No production deployment
or merge is part of this implementation.

## Workspace and compatibility

`WorkspaceShell` is the client-only dynamically loaded root. With
`NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED` unset/true, a fresh session starts in
Workflow. An explicit legacy Studio choice is remembered in sessionStorage for
that tab; it can return through a save barrier. The Workflow stays mounted while
hidden/inert, retaining viewport, selection and its save coordinator. Only the
active workspace mounts Account. No new route or callback URL is introduced.
`NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false` returns directly to the old app;
`NEXT_PUBLIC_WORKFLOW_ENABLED=false` also disables the new entry. Both flags are
build-time flags. Neither removes data or reverse-converts v2 into old stores.

`WorkflowDocument` v1, its validator and `axfluxo-workflow` v1 repository remain.
Unknown v1 node types still fail, including image-edit. Existing image crop/resize
nodes are not replaced, migrated to image-edit, or presented as executed.
The shared React Flow canvas accepts a graph adapter and definitions, preserving
Phase 1 drag/pinch/cancel/port behavior. DOM bounds are scoped to each mounted
canvas so a hidden new workspace cannot change legacy placement or pinch anchors. New nodes also appear in the existing
searchable palette. Inspector connection controls stay >=44 CSS px independently
of canvas zoom. Only the canvas owns touch-action:none.

The legacy Studio's `axfluxo` v1 documents/templates/assets/backups remain on the
old paths. `storage.ts`, ProjectDocument, crop/text domain, auth/Account, package
versions/lockfile, Next/basePath and CI configuration remain unchanged. The old
ZIP algorithm is extracted into `archive.ts` with a format-specific allowlist;
`safeUnzip` still supplies exactly its original whitelist. Image import now checks
PNG/JPEG/WebP header dimensions before decode when available, then performs the
existing decode/signature/animation/size validation. No new dependency is added.

## Data model

New database: `axfluxo-workspace`, version 1.

| Store           | Records                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| workflows       | validated WorkflowDocument v2 and storage CAS revision                                       |
| preferences     | viewport and current artifact pointers                                                       |
| editorDocuments | independent draft ProjectDocument, UUID → AssetRef map, CAS revision, fixed input, updatedAt |
| editorRevisions | immutable applied ProjectDocument + map + fixed input, keyed by a new revision UUID          |
| assets          | immutable normalized PNG, actual Blob MIME, original MIME/Blob, SHA-256, dimensions          |
| artifacts       | generated PNG and small thumbnail, complete render key, applied revision/page, SHA-256       |
| recovery        | successful graph/viewport snapshots; referenced editor records are retained                  |
| migrations      | source v1 ID/revision → imported v2 ID and timestamp                                         |

No Blob, base64, Promise, object URL or runtime error is stored in graph config.
ProjectDocument remains the only editor document model. Its asset UUIDs are
separate from workspace asset record UUIDs and resolved through the external map.
Both default and current values of image variables are collected, not just the
currently visible layer binding. Source images are copied into the new DB.

image-edit typeVersion 1 has one `in:image`, branching `out:image`, explicit
connected/selected/blank mode, name, editorDocumentId, appliedRevisionId and
outputPageId. Unset mode is an error, not blank. Ports use the same cycle/type/
cardinality checks as Phase 1. Missing references and unknown versions fail
without overwriting their rows.

## Persistence and editing

The visual ImageEditor and `useEditorSession` are shared; legacy persistence and
workspace persistence are separate hosts. A workflow session is identified by
workflow/node/editor IDs and checked after async load. Exactly one full editor
is mounted. Session-local Undo, selected layer/page, zoom and Canvas pan are not
claimed as persisted history. Reopening resumes the draft and applied output
page. Graph Undo does not consume editor native input Undo/IME events.

`Autosave` serializes 750ms/maximum-5s writes and tracks generations independently
of stored CAS revisions. Its flush awaits an in-flight write and all newer
snapshots; failures reject the barrier. Draft save changes no applied revision
or output. Invalid/IME/form drafts stay visibly uncommitted. In-flight image
imports prevent apply/exit; apply/export/copy make the editing surface inert.
A development effect remount can resume its coordinator. Browser Back keeps the
session and directs the user to the explicit saved return path.

Apply checks workflow CAS and editor CAS in one readwrite transaction, verifies
asset references, writes the final draft, adds an immutable editor revision, and
updates workflow appliedRevisionId/outputPageId/recovery/viewport. Only
transaction.oncomplete is success. Decode, rendering and hashing happen outside
long write transactions. Quota/abort/conflict stay on screen. Conflict offers
explicit discard/reload or a new independent node/document copy; never automatic
overwrite. Document Undo does not reset the storage CAS revision.

Duplicate makes new node/editor/revision IDs and independent document copies;
immutable image records may be shared. Delete only removes graph connections
and node references. Graph Undo can restore the retained editor. User documents,
revisions and images are not automatically garbage-collected. Generated cache
cleanup is not automatic in this version either.

## Input and output contract

`resolveInput(reference, signal)` resolves only a selected fixed asset, a source
asset copied into the workspace, or a current image-edit output. An unexecuted
image-processing node reports upstream ungenerated; it never substitutes its
upstream source. Initial input records the immutable asset reference/hash and
specific input layer ID.

A changed input offers keep, copy-and-replace-only-input-layer, or copy-and-rebuild.
The original node/draft/applied revision remain intact. Text, shapes and unrelated
images survive replacement. If the designated input layer was deleted, targeted
replacement fails explicitly; rebuild is still available. If live input cannot be
resolved, an existing document can explicitly resume its frozen input; replacement
and rebuild stay disabled until a new valid input is available.

`renderImageEdit(revision,page,signal)` uses the existing scene/crop/text/font
pipeline. Preview/crop/export share AssetResolver, whose legacy lookup remains
the default. Individual node output is one PNG from the chosen applied page;
Studio and session terminal exports retain PNG/JPEG/multipage ZIP. JPEG background
in the session export is white; the legacy Studio retains its full controls.

The render key includes revision UUID, input hash, page, PNG/quality/background,
font manifest and render spec version. Lookup precedes rendering. Full-resolution
exports across old and new paths are serialized, including queued cancellation.
Canvas work cannot always be interrupted mid-operation, so abort/generation and
current DB target checks gate adoption afterward. Node/workspace switch and
explicit cancel invalidate old results. Cancellation also aborts an in-progress
artifact publication transaction before commit. A failed generation preserves documents
and labels retained output as old/update-needed. Output refresh never arranges
or moves nodes. Only small thumbnails are displayed on cards; Stage, Canvas and
object URLs are released on close/failure/cancel.

## Copy migration and backup

v1 Workflow import validates original graph/viewport/images, copies bytes to new
asset UUIDs, remaps graph IDs and atomically publishes the workflow/assets/
viewport/recovery/migration record. A transaction-level migration lookup makes
concurrent retry idempotent. Updated source revision is labeled and creates a
separate copy. Studio project import clones ProjectDocument and all referenced
images into a fresh editor record without touching the original.

New ZIP identifier `axfluxo-workspace`, formatVersion 1/renderVersion 1, is separate
from old Studio ZIP. It includes graph/viewport/drafts/applied revisions/all
retained asset mappings/fixed input/valid current outputs/font and image hashes.
Old outputs that no longer match the applied revision are regenerated; images
already fixed by downstream documents remain backed up as assets.

ZIP EOCD/directory/entry consistency, traversal/duplicates/format whitelist,
entry count, compressed and total expanded 200MiB, JSON 5MiB/depth32, schema,
font version, MIME/decode/dimensions, hashes and references are checked before
publication. Restoring remaps workflow/node/edge/editor/revision/document/page/
layer/asset UUIDs and output pointers. All restored rows are added in one new-DB
transaction, never overwriting an existing work. Failure leaves no half workflow
in the list. Local DB save and OS download are separate operations; download
completion is confirmed in Safari/Files, not asserted by the app.

## Acceptance boundary

WFR-5's implemented UI and data contracts are verified automatically at root and
/axfluxo. Existing tests enter legacy explicitly across tabs/contexts; their
assertions are not skipped, deleted or weakened. The new default is exercised by
separate Workflow First tests. Rollback gets its own disabled-flag static build.
See the current results for exact SHAs, commands and counts.

WFR-6 physical iPhone Safari/IME/VoiceOver, WebKit, maximum-size memory/performance,
real device quota/background termination and real email acceptance are not
claimed complete. There is no DAG scheduler, SNS/OAuth/direct posting or cloud
sync. The existing whole-workflow execution buttons remain disabled.
