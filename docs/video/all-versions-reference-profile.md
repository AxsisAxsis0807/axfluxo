# All Versions: opt-in reference video profile (NORMAL → SLOWED)

Implemented on branch `feature/all-versions-reference-fade-20261114`.

## Source of measurements

One user-supplied MP4: 910×512, 30fps, 6,170 frames, 205.667s. The cut between NORMAL and SLOWED was observed at source frame #2908 (96.933s). The layout and fades were previously examined across all frames with ten measurement-parameter cross-checks. These do **not** recover the original editor's exact keyframes.

## Backwards compatibility

The historical `provisional-v1` layout and its 9-frame linear fade settings remain available and remain the default for existing projects. Opt in to `reference-pasa-v1` under **Design → Display template**. Switching to this profile sets the defaults to 54 incoming + 42 outgoing frames at 60fps. Users can still edit durations, subject to `FADE_TOO_LONG`.

## Reference composition (coordinates in 910×512 space)

- Cover image: center x=455, size approximately 506×506, centered vertically.
- Blurred background: strong blur of the cover, subject to further visual calibration to InShot's strongest preset.
- Version title: dynamic text (for example `PASA!(NORMAL)`), horizontally centered, vertical center ~y=255.5; dark translucent black band (height ~35) fits text width.
- Clock: white sans-serif `mm:ss`, horizontally centered, near y=448. No background band.
- Background and cover remain unchanged between versions. They do not fade.
- Title and clock are separate layers with **identical fade start/end timestamps** and different opacity curves. Title uses cubic ease-out on entry and cubic ease-in on exit; timer uses a symmetric cosine curve. These are approximations to the observed opacity profiles.
- Source reference fade 50%-opacity measurements: NORMAL title in ~0.166s, out ~96.771s; SLOWED title in ~97.078s, out ~205.471s. Time resolution is limited to 33.33ms by the source MP4.

## Timer behavior

Each version starts at `00:01`. On 60fps output, local frame 65 still displays `00:01` and local frame 66 displays `00:02`. The next version resets to `00:01`. The timer is based on integer frame offsets, not segment-local real-time clocks, preventing drift when segments are split.

The **server renderer** uses a dynamic FFmpeg `drawtext` clock (Noto Sans JP) and separately composites the title (Aleo), with independent easing. The **local export** and browser preview use the same domain timing functions. Note that they are not yet proven pixel-identical because browser/FFmpeg typography and antialiasing differ.

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
