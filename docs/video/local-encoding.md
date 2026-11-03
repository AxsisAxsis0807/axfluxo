# Developer Studio: local low-load encoding

This policy supersedes the server-rendering plan for new exports. All Versions Video Maker and FNF Showcase Maker use their existing editor routes and export settings; neither introduces a separate editor or public entry. Existing server APIs, database migrations, workers, storage, jobs, and output management remain available for future use and legacy downloads. New server submissions are disabled in the editors, including server-generated full-length previews.

## Access and configuration

Keep `NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED=true` only in the existing developer deployment. The individual editor feature flags still work. These build flags never grant membership: the existing authenticated `/v1/developer/me` endpoint validates the JWT and developer membership on the server. Studio navigation and both editors require a successful response, and queue start/add recheck the owner. There is no offline membership bypass.

`NEXT_PUBLIC_DEVELOPER_AUTH_API_ORIGIN` optionally selects an **existing compatible authentication/membership API**, separately from the legacy `NEXT_PUBLIC_VIDEO_API_ORIGIN`. It must serve the existing developer membership endpoint; an arbitrary Supabase origin is not a compatible replacement. With the auth endpoint available, no FFmpeg server, rendering worker, job queue, bucket, or rendering cloud account is required for local files. Existing optional cloud assets can be downloaded and hash-verified once before entering the local queue. Local export never uploads media or submits a render job. Authentication itself still requires connectivity.

`npm ci` followed by `npm run dev` or `npm run build` prepares self-hosted, pinned, single-thread FFmpeg WASM, its module worker, the existing fonts, and notices under `public/local-encoding/`. Generated vendor files are ignored by git and lint. No CDN is used at runtime. Static hosting must serve `.js` as JavaScript and `.wasm` as `application/wasm` (the bundled development server handles these). `NEXT_PUBLIC_BASE_PATH` is respected. No cross-origin isolation or SharedArrayBuffer is required.

## Editing and export

- Existing timelines, range/marker editing, names, cover art, blur, text/fades, presets, resolution choices and cloud workflows remain in the editors. Local media inputs feed the same documents and FNF session model.
- All Versions retains 1080p/1440p, 16:9 and 60fps. Local Canvas uses the same font bytes, hash checks, glyph checks and provisional layout as the server renderer. FNF retains its crop/scale geometry, 1080×1920/60fps, heading, username, stable sorting and filename rules.
- Local audio waveforms are generated explicitly in the audio step, in a single WASM worker and bounded 30-second reads. Cloud waveforms remain available. Waveform generation and exports share an origin-wide Web Lock.
- Adding to the queue stores a frozen snapshot, sources and FNF filenames. Later edits do not change queued jobs. Jobs from both editors are processed sequentially by the same owner-scoped queue.
- Each video checkpoint covers at most 120 output frames and never crosses an All Versions boundary. H.264 is encoded once at CRF 18, medium preset, one thread. Checkpoints carry lossless 48kHz stereo PCM; final concatenation copies video and encodes AAC 320kbps once, avoiding AAC priming at every checkpoint.
- A committed checkpoint precedes cursor advancement. Reload, worker termination, pause and OS interruption resume at the last durable cursor. Unfinished checkpoints are retried. Outputs are stored locally and downloaded through an explicit user tap. Downloads are not claimed to be confirmed Photos saves.
- An origin-wide Web Lock prevents simultaneous workers across tabs. Tabs must explicitly start/resume. Cancellation waits for the local worker to stop and obtains the lock before changing state; another active tab must stop first.

## Boundaries and recovery

The processing-time budget is 10 minutes, followed by a 4-minute rest at the next committed checkpoint. Actual encoding/loading work is counted, including across queued videos. The rest deadline and processing budget survive reload. Pause/backgrounding terminates the worker; returning to the foreground never silently resumes. Final concatenation is one indivisible operation and may exceed the remaining budget; the next queued video rests first. The settings do **not** guarantee reduced temperature, prevent iOS suspension, keep a locked screen alive, or continue after Safari closes.

Inputs and the aggregate final-concatenation working set are currently limited to **192 MiB each**. This is a conservative fail-closed bound, not a guarantee against memory pressure. It limits long/high-bitrate videos; split them into shorter outputs. The entire concatenation set and final output currently use WASM memory. Streaming/OPFS muxing and larger inputs are future work; this implementation does not advertise unlimited-length support. Unsupported decoders, unavailable Canvas/fonts, HDR sources (PQ/HLG/BT.2020), storage quota failures and memory failures must fail visibly rather than silently reduce resolution, frame rate or color quality. SDR originals are required. Browser/OS eviction can remove IndexedDB data; keep original source files and save finished outputs promptly. `navigator.storage.persist()` is best-effort and may be refused by Safari.

`axfluxo-local-encoding-v1` is separate from all existing databases. Keys are owner-scoped. Job deletion removes that job's checkpoints/output; originals remain for reuse. Settings and old databases are never reset. Owner scoping prevents accidental mixing, but IndexedDB is not an OS security boundary on a shared browser profile.

## Verification

Automated coverage: durable checkpoint/cursor behavior, interrupted chunks, failed jobs, owner isolation, selected-job deletion, 10-minute/4-minute scheduling and sequential output order. Browser tests exercise the actual single-thread WASM engine, two checkpoint segments, both layouts, H.264/AAC output, 60fps, exact frame count and duration using native ffprobe. Existing editor regressions cover local graphics, editor controls, queue persistence and absence of normal server submission.

Before treating the feature as validated on iPhone/iPad, run this **manual release gate** on physical Safari devices (desktop WebKit emulation is insufficient):

1. Confirm non-developer/expired sessions cannot enter either editor or start a queue; valid developers can use local files with no rendering/cloud storage configuration.
2. Export both layouts with real audio, trim/markers/ranges, duplicate Japanese filenames, usernames, cover art, blur and fades; compare audio continuity, orientation, geometry and text against the preview. Verify 1080p, 1440p and 60fps with an independent media inspector.
3. Observe multiple real 10-minute processing / 4-minute rest cycles. Record device model, iOS version, memory failures, temperature observations, timing and final quality. Do not infer a thermal guarantee from successful cycles.
4. Pause/resume during encoding and rest; background/lock Safari, return, reload, and terminate the tab. Confirm no automatic background continuation and recovery from durable checkpoints. Test OS memory reclamation, storage exhaustion, denied persistent storage and deleted/evicted source data.
5. Queue mixed outputs, open both tools in separate tabs, verify mutual exclusion, cancel a queued/active job, recover failure, and save every finished MP4 with a gesture. Check files in Files/Photos independently.

No automatic merge or deployment is part of this change.

### Results for this change

- `npm test`: 33 files, 309 tests passed (includes 5 local queue/plan tests).
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Chromium browser integration: 6 tests passed (two existing editor regressions, two membership denials, two actual WASM exports). The final engine's two export tests additionally verify local waveform generation, BT.709 metadata and preservation of mono audio level.
- Developer Studio / FNF rollback / diagnostics E2E: 7 desktop tests passed.
- WebKit installation was blocked by the managed environment network policy (`403 Domain forbidden` for the Playwright distribution domains). WebKit and physical iPhone/iPad Safari are **unverified**. The manual release gate above remains open.
