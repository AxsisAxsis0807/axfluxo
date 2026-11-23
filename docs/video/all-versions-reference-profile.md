# All Versions: reference video profile (NORMAL → SLOWED)

Implemented on branch `feature/all-versions-reference-fade-20261114`.

## Source of measurements

One user-supplied MP4: 910×512, 30fps, 6,170 frames, 205.667s. The cut between NORMAL and SLOWED was observed at source frame #2908 (96.933s). The layout and fades were previously examined across all frames with ten measurement-parameter cross-checks. These do **not** recover the original editor's exact keyframes.

## Backwards compatibility

New projects use `reference-pasa-v1`. Saved projects with an explicit `provisional-v1` selection keep that layout and its fade settings. Local projects saved before layout selection was available use the reference profile. The reference defaults are 54 incoming and 42 outgoing frames at 60fps. On shorter versions the reference fade curves overlap within the existing version window.

## Reference composition (coordinates in 910×512 space)

- Cover image: center x=455, size approximately 506×506, centered vertically.
- Blurred background: strong blur of the enlarged cover, calibrated against the reference stills.
- Version title: dynamic text (for example `PASA!(NORMAL)`), horizontally centered, vertical center ~y=255.5; dark translucent black band (height ~35) fits text width.
- Clock: white sans-serif `mm:ss`, horizontally centered, near y=448. No background band.
- Background and cover remain unchanged between versions. They do not fade.
- Title and clock are separate layers with **identical fade start/end timestamps** and different opacity curves. Title uses cubic ease-out on entry and cubic ease-in on exit; timer uses a symmetric cosine curve. These are approximations to the observed opacity profiles.
- Source reference fade 50%-opacity measurements: NORMAL title in ~0.166s, out ~96.771s; SLOWED title in ~97.078s, out ~205.471s. Time resolution is limited to 33.33ms by the source MP4.

## Timer behavior

Each version starts at `00:01`. On 60fps output, local frame 65 still displays `00:01` and local frame 66 displays `00:02`. The next version resets to `00:01`. The timer is based on integer frame offsets, not segment-local real-time clocks, preventing drift when segments are split.

The **server renderer** uses a dynamic FFmpeg `drawtext` clock (AxFluxo Clock, a regular-weight numeral subset of Noto Sans JP under the SIL OFL) and separately composites the title (Aleo), with independent easing. The editor preview, composition preview and browser export share the Canvas artwork, title and timer drawing. FFmpeg uses the same layout and fade constants. Both load the same timer font. Fallback glyphs and antialiasing can differ across engines.

## Scope and limitations

- Does not change cloud storage, subscriptions, billing, original assets, API authorization, audio encoding, or public deployment.
- Does not prove an exact font match, image border rounding, blur kernel, or color match. The user's altered video background was expressly not treated as a strict reference.
- Keeps all versions dynamic; NORMAL and SLOWED were reference samples, not a hard-coded two-version limit.
- Audio fades remain independent from visual fading. The source MP4 cannot establish whether audio fade was part of the uploaded song or the editor.
- The source is 30fps but AxFluxo output continues at 60fps. Ease curves are calculated continuously in output time.

## Recommended acceptance checks before merging

1. Run `npm run typecheck`, `npm run lint`, and `npm test`.
2. Run the existing browser All Versions suite.
3. Render NORMAL → SLOWED with matching lengths, then visually compare at 0, 0.16, 0.9, 96.55, 96.77, 96.93, 97.08, 97.31, 97.9, 205.3 and 205.47 seconds.
4. Confirm the title and clock disappear and appear at the same boundaries, their intermediate curves differ, and the second clock resets.
5. Confirm old saved projects with `provisional-v1` still parse and retain their layout.
6. Test Safari playback, segmented rendering, failure/retry, and long titles.
7. Compare the local and server output at 60fps, masking background where the source video uses a deliberately different background.
8. Manually adjust font, black-band spacing, cover rounding, background blur, and alpha profiles only after comparing actual encoded MP4s.

Until those checks and visual comparisons pass, call this a **first implementation of the measured reference profile**, not a certified pixel-perfect recreation.
