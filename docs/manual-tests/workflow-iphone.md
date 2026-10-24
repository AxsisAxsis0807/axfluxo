# Workflow Phase 1 — iPhone Safari manual acceptance

Real iPhone Safari testing has **not** been performed in this environment. Playwright mobile uses Chromium with iPhone 13 dimensions/touch emulation and is not Safari evidence.

1. Open the review build in Safari, create a Studio project and import PNG/JPEG. Crop, export PNG/JPEG, backup ZIP, restore it; verify guest editing and email account flows continue working. Never use production credentials in a workflow config.
2. Enter Workflow; add source, image, text, save and post. Search the node list. Confirm all nodes are configuration-only and execution is disabled.
3. Pan blank space with one finger. Pinch around an off-center midpoint and verify the graph point under the midpoint stays anchored. Switch 1→2→1 fingers on blank space and during header drag; release/cancel by OS interruption, then verify a fresh gesture works without node jumps.
4. Drag only the header. Tap a node to open the bottom sheet. Enter Japanese with IME, open/close software keyboard, scroll the sheet, rotate portrait/landscape and confirm canvas position/configs do not jump. Check safe area and browser page zoom outside the canvas.
5. Tap output then input handles; also connect using the sheet endpoint buttons without dragging. Fan the same image into save and post. Try text→image, occupied input, self, duplicate and cyclic links; verify Japanese rejection reasons.
6. Duplicate/delete/move/configure/connect/disconnect/arrange, then Undo and Redo each. A whole drag/layout is one undo. Native textarea Undo must not undo the graph.
7. Save, pan/zoom, wait for 保存済み and reload. Verify positions/config/connections/viewport. Open the same workflow in two tabs; save A then edit B. Verify conflict, explicit reload and copy save preserve the original.
8. Exercise keyboard/focus with an external keyboard and VoiceOver: node list→settings→ports→disconnect→close→opener focus. State/type must remain understandable without colors. Enable Reduce Motion.
9. Where a controlled test device permits, test quota/storage denial and blocked DB upgrade. Verify unsaved error, original data retained, explicit retry, no DB deletion. Use a disposable browser profile, not a user's only copy.
10. Repeat at root and `/axfluxo/` on static review artifacts. Verify JS/CSS/font requests and existing ZIP files.

Record device, iOS/Safari versions, orientation, steps, expected/actual and screenshots; do not replace this record with Chromium screenshots. No SNS integration, real posting, deployment or Supabase production mutation is authorized by this checklist.
