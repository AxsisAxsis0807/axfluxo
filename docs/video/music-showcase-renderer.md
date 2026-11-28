# Music showcase rendering

The device All Versions screen can reserve the existing full mix, a portrait short and one landscape job per version. The full mix still uses its original renderer, no-gap source order, trim/markers, clock, fade and encoder. A single waveform editor in each audio card switches between the full-mix range (shared by its individual versions) and the short range. The short uses the selected audio card and a separate range. Opening the short scope does not alter the full-mix in/out markers. The optional individual outputs share the existing cover and title inputs. Version labels are used in unique filenames. The displayed song title keeps the original capitalization and is laid out once with a constrained width.

## Media and recipe

The base for this work is `be0b7da6ffed8921466a189243945c4cdab6f67a` (PR #58). The start branch was `feat/all-versions-short` with a clean worktree at `a1152f6`. That commit and `2cc0f15` are in the local ancestry, together with the title separator change `ad538d0`.

`buildLocalJobs` freezes the source timing, title, cover and the version-1 showcase profile with each job's recovery index. The full mix stays at index 0, the short follows when present, and individual output jobs follow in source/marker order. Without the new profile, prior recipes rebuild through their original short or mix renderer. The format contract for a new showcase job is timestamped 1080p/60 MP4. A browser without the timed encoding APIs receives an explicit error for that job. The existing fallback remains available for the old jobs. Native AVC/AAC is preferred. The existing timed pipeline can use VP9/Opus in MP4 when the native encoders are unavailable. Playback support for that codec pair depends on the player's device.

`reserveLocalExports` and the existing recovery lease publish the batch before queue execution. The renderer is rebuilt from persisted settings and immutable File bytes. Closures, decoded images and analysis buffers are in memory only. During restoration, jobs from identical snapshots share the same decoded assets. They use the existing single-slot runner, quotas, retry, result storage and download controls. Editor state still lives in the session.

## Measured geometry and renderer decisions

| Property | Portrait | Individual landscape | Basis |
| --- | --- | --- | --- |
| Frame | 1080×1920 | 1920×1080 | Output specification |
| Square origin | (0, 420) | (420, 0) | Provided common coordinate system |
| Surround | Fixed black | Fixed PR #58 blurred cover | Output specification and existing renderer |
| Title (square Y) | 690 | 690 | Prior short geometry and reference estimate |
| Clock (square Y) | 912 | 973 | Prior short geometry and reported landscape estimate |
| Bars (square Y) | 528 | 528 | Reported full-frame variance measurement |
| Display fonts | White 56px Arial bold, 30px Arial clock | Same | Metrics approximation, with platform and script fallback |

A fixed landscape backdrop is prepared once for the batch with the PR #58 cover blur, without the sharp foreground. The artwork, gain and soft-knee glow are confined to the central square. Text and clock draw above them at separate opacities. The portrait uses rectangular artwork; the landscape uses the existing rounded-square radius. The timer is elapsed output time, with decimal seconds floored to the displayed second. Its bitmap is updated when the integer changes. The original two-second linear audio outro is unchanged. The previous portrait fade remains available for older recipes; new output uses the same layer outro and a smoothed approach through the 1.9-second region. The rapid transition at that time in TREVAS has no verified universal trigger.

Bars use 104 samples and a 7.04px center pitch. With a 1.6px stroke, the extent is 726.72px, from x=176.64 to x=903.36. The nominal reference-width pitch is 3.3378px at 512px. The initial height range is 2.5–42px, and the bar opacity is 0.88 times its envelope. The implementation uses symmetric extension around a thin line. Direction, stroke and scale are engineering choices informed by the evidence and still need original-template comparison.

## Audio analysis and effects

`music-showcase-features.ts` uses the existing bounded audio-only PCM path including the WebKit EOF rules. `music-showcase-analysis.ts` reads full-band 48kHz stereo PCM, separate from the edit waveform. Centered 2048-sample Hann windows are zero-padded to 4096; the interval is 800 samples (60Hz). Trim-edge windows are zero-padded, and stereo power is combined without cancelling anti-phase content. Frequency edges are logarithmic from 20Hz to 10kHz. Narrow edges interpolate neighboring FFT bins and wide edges integrate compensated power. The bar floor is −72dB and the Attack/Release candidates are 38/185ms. Browser cancellation is checked between at most 6400 samples of work. Quantized features retain 106 bytes per frame (about 230 KiB for 37 seconds), with a 32 MiB feature limit; they do not retain full PCM. The existing bounded WebKit MP3 decoder may retain its independent Web Audio buffer. One finished feature range per batch is cached only for the same File identity, interval and source duration.

Exposure uses a weighted RMS, peak and six band energies with an adaptive baseline and positive spectral flux. Whole-cover gain is bounded at roughly 0.86–1.14. Glow uses its own low-band and transient combination, a luma soft knee starting at 0.55 and a fixed, separable 1–4–6–4–1 mask at 216×216. Only its intensity is animated. Screen blending has a peak opacity of 0.22 times the cover envelope. The mask expands across neighboring pixels even on browsers without Canvas filters. It is a restrained engineering approximation. The measured Gaussian sigma of 6px at 512px is a comparison statistic and is not used as a compositor parameter. The profile makes no use of the reported 0.23s lag as a timing setting.

The waveform timeline retains its separate peak/detail decoding and native audition. The same sampled response is used by preview and timed encoding, with time relative to the selected interval rather than to wall time. Silence produces baseline bars and zero audio glow. No gain normalization is applied to PCM.

## Reproducing the measurements

Run `python3 scripts/audit-music-showcase.py OUTPUT_DIR LABEL=LOCAL_VIDEO ...` with FFmpeg/FFprobe, NumPy, Pillow and Matplotlib. It records the full MP4 probe and SHA-256, original frame PTS, audio samples and peak, the center-square measurements at a common 30Hz cadence, masked luminance and intensity percentile, a periodicity estimate and audio correlations. These measurements do not infer the original bloom algorithm. The history's raw output and the messaging platform's transcoded copy need separate hashes.

Available previous source files differ from the hashes in the instruction. The local TREVAS source (`c15603d65530310b7772ec1a23ec66a7ab48c5a5d4cbb5b1cb6457fd64d67e22`) and INVOCADO (`59c1273e3c87248e2324d4839091f92c48aeb718d33aa8afbd7ac0cce1a7b8fc`) are the earlier 1080×1920 60fps files. The previous local 37-second KALYPSO file has SHA-256 `be5758af68003bbd0ef972488cbee4a76a5d46c48a861089f8b692bd3b5c70b2` and FFprobe reports 2220 frames at 1080×1920/60fps. This does not identify when the different 512×910 file was converted. The requested BROS MP3, separate PNG and exact DREAM FUNK JPEG were unavailable in the initial workspace inspection. Results on other audio or covers do not establish a same-source match to those files.

## Rollback boundary

Revert the batch of music-showcase changes if needed. Before reverting in an environment with admitted version-1 recipes, finish or save their completed outputs. Older builds do not know how to rebuild the new job indices. This change does not need a database migration or a cloud deployment.
