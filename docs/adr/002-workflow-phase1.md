# Workflow Mode Phase 1

## Scope and integration

Workflow is a lazy, client-only feature of the existing Editor. Studio's Konva renderer, crop, auth, asset, ZIP and original storage services are unchanged. Workflow is kept mounted after first entry so changing screens does not discard in-flight autosave edits. No execution engine, image processing, drawer, SNS connection, posting or backend is provided. All nodes say 設定のみ; execution is disabled.

Inspected branch `work`, clean HEAD `f8c4712a58d77bd1d56754cb6104b4e4226da527`, origin `AxsisAxsis0807/axfluxo`. Fetched origin/main was the same SHA; no reset, merge or main push. No AGENTS.md was found in ancestors or repository. Implementation branch: `feat/workflow-phase1`.

## Libraries and licenses (2026-10-24 JST)

- `@xyflow/react` **12.12.0**, MIT. npm peerDependencies: React, React DOM and their type packages >=17; existing React/DOM 19.3.0 satisfies them. Included TS declarations pass existing TypeScript 6.0.3 checks. No React/Next changes and no peer-dependency overrides.
- `@dagrejs/dagre` **3.1.2**, MIT, included TypeScript declarations, no React peer. Uses graphlib 4.0.6. Layout runs in the client over document coordinates.
- Exact direct versions and resolved transitive dependencies are recorded in package-lock.json. License texts for React Flow, system, Dagre and graphlib are in public/licenses.
- Official reference checked before installation: https://reactflow.dev/api-reference/react-flow and https://github.com/dagrejs/dagre/wiki ; npm registry metadata and installed package manifests confirmed version, peers and license.

## Document and commands

`WorkflowDocument` v1 is independent of React Flow. Strict Zod schemas reject unknown schema/node versions, unknown types/fields, invalid positions/configs and duplicate IDs. `parseWorkflow` additionally validates every edge, endpoint, direction, exact type, single-input cardinality and DAG invariants. Outputs may branch. IDs are fresh on duplicate; single-node duplicate has no edges. Node deletion removes incident edges.

Document fields: schemaVersion, workflowId, name, revision, createdAt, updatedAt, nodes and edges. Nodes store id, type, typeVersion, position and config. Edges store id and source/target node/port IDs. Nodes: source (optional local asset ID), image (operation/width), text, save (name), post (draft/direct). All are configuration definitions, without execution capabilities. Port type vocabulary includes image/text/number/file and typed collections; compatibility is equality, without implicit conversion.

No image Blob/base64 or credential field exists in the graph. Source assets are referenced by local ID only. Text configs reject embedded data/token payloads. UI library selected/measured/dragging state is transient. Viewport is separate. History stores document snapshots only (up to 100); drag start→end and layout each commit once; pan/zoom never enters document history. Ctrl/Cmd-Z excludes form/contenteditable targets. Revisions are storage CAS counters, independent of history snapshots.

## Storage and concurrency

Original `axfluxo` DB version 1 (projects/revisions/assets/templates) is untouched. New `axfluxo-workflow` DB version 1 has:

| Store       | Key and value                                      |
| ----------- | -------------------------------------------------- |
| workflows   | id=workflowId; document=validated WorkflowDocument |
| recovery    | id=workflowId:revision; workflowId; document       |
| preferences | id=workflowId; viewport={x,y,zoom}                 |

No unused stores are reserved. No deletion, migration or logout cleanup is added.

Autosave debounces 750ms with 5000ms maximum wait. One save is in flight at a time; later edits coalesce into the next snapshot. A generation counter includes document/viewport edits, and old completions cannot claim a newer edit saved. CAS compares stored revision inside a readwrite transaction, incrementing on success. Workflow, viewport and recovery are committed atomically; five latest successful recovery snapshots are retained per workflow in that transaction. Another tab's stale revision aborts; the UI offers explicit reload/discard or separate copy. History can also be restored as a copy. No silent retry over a conflict.

Quota/transaction/open/blocked failures display unsaved error; retry is explicit. Transaction abort preserves earlier committed data. Connections close on versionchange, and each operation reopens the database; blocked-open rejects and closes a late successful connection. Unknown/corrupt stored documents are rejected without enabling editing or overwriting original rows. No automatic DB deletion is used. Browser termination still cannot guarantee completion of IndexedDB work; beforeunload warns for unsaved work.

## Gestures and accessibility

React Flow owns screen↔document transforms and anchor-preserving zoom. Blank left/middle mouse drag pans; wheel zoom centers on the pointer. Touch blank drag pans, pinch centers on two touch points. Zoom range .25–2; fit and 100% controls are present. Resize changes viewport dimensions, not node coordinates. Only headers drag nodes. React Flow aborts node drag when a second touch arrives; the wrapper commits the current position, handles cancellation/lost capture, and synchronously ends document/window drag listeners on cancel without remounting the canvas (native touchcancel must reach D3 touch bookkeeping). Standard page zoom is not disabled.

Connections support handle drag/click and explicit Japanese endpoint buttons in the inspector. Visible ports have type text and direction arrows, with 44px handle hit areas around smaller visual dots. Node list/settings buttons support keyboard access. Desktop double-click opens details; coarse-pointer tap opens details. Inspector is a side panel or mobile bottom sheet, outside the canvas input boundary. Closing restores the opener's focus. Inputs retain native text undo. CSS includes focus, reduced motion and bottom safe-area padding.

## Rollback

Build with `NEXT_PUBLIC_WORKFLOW_ENABLED=false` to remove the Workflow entry. Do not delete either database or user data. Re-enable with the flag unset/true. Existing Studio remains available without loading the Workflow module. No deployment is performed as part of this change.
