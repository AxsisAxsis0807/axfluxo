#!/usr/bin/env python3
"""Measure local MP4s after export. Requires FFmpeg, NumPy, Pillow and Matplotlib."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image, ImageFilter


def command(*args):
    return subprocess.check_output(args)


def inspect(label, path, output):
    probe = json.loads(command("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)))
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
    w, h = video["width"], video["height"]
    size = min(w, h)
    x, y = (w - size) // 2, (h - size) // 2
    duration = float(video.get("duration", probe["format"]["duration"]))
    fps = 30  # Fixed measurement cadence, separate from the original PTS checks.
    video_filter = f"crop={size}:{size}:{x}:{y},fps={fps},scale=512:512"
    decoder = subprocess.Popen([
        "ffmpeg", "-v", "error", "-threads", "2", "-i", str(path), "-map", "0:v:0", "-an",
        "-vf", video_filter, "-pix_fmt", "gray", "-threads", "1", "-f", "rawvideo", "-"
    ], stdout=subprocess.PIPE)
    result, variance_samples = [], []
    bar_rows = slice(238, 261)
    bar_centers = np.round((177.44 + np.arange(104) * 7.04) * (512 / 1080)).astype(int)
    steady_index = []
    row_mask = np.ones(512, dtype=bool)
    for a, b in [(231, 266), (309, 346), (416, 442) if h > w else (445, 478)]:
        row_mask[a:b] = False
    while True:
        buf = decoder.stdout.read(512 * 512)
        if not buf:
            break
        if len(buf) != 512 * 512:
            raise ValueError("incomplete decoded comparison frame")
        frame = np.frombuffer(buf, dtype=np.uint8).reshape((512, 512))
        region = frame[row_mask]
        blurred = np.asarray(Image.fromarray(frame).filter(ImageFilter.GaussianBlur(6)))[row_mask]
        bar_region = frame[bar_rows, 78:434]
        stripe = frame[bar_rows].astype(np.float32)
        line = stripe[:, bar_centers] - (stripe[:, bar_centers - 1] + stripe[:, bar_centers + 1]) / 2
        height_proxy = np.max(np.sum(line > 20, axis=0))
        index = len(result)
        result.append((index / fps, float(frame.mean()), float(region.mean()),
                       int(region.min()), int(region.max()), float(np.quantile(blurred, .99)),
                       float(bar_region.mean()), int(height_proxy)))
        if 3 <= index / fps < duration - 2:
            variance_samples.append(bar_region.copy())
            steady_index.append(index)
    if decoder.wait():
        raise ValueError("video decode failed")
    data = np.asarray(result)
    if not steady_index:
        steady_index = list(range(len(data)))
    steady = data[steady_index]
    if len(variance_samples) > 1:
        # Remove static cover texture via temporal differences and spatial
        # background via a local average. Estimate the periodic line spacing.
        stack = np.asarray(variance_samples, dtype=np.float32)
        columns = np.abs(np.diff(stack, axis=0)).mean(axis=(0, 1))
        highpass = columns - np.convolve(columns, np.ones(17) / 17, "same")
        periods = np.arange(2.8, 4.3, .005)
        axis = np.arange(len(columns))
        powers = np.abs(np.exp(-2j * np.pi * axis[None, :] / periods[:, None]) @ highpass) ** 2
        period = float(periods[np.argmax(powers)])
        contrast = float(np.max(powers) / max(1e-12, np.median(powers)))
    else:
        period = contrast = None
    raw = command("ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ar", "48000",
                  "-ac", "2", "-f", "f32le", "-")
    stereo = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)
    pcm = stereo.mean(axis=1)
    window = np.hanning(2048)
    padded = np.pad(pcm, 1024)
    fft_axis = np.fft.rfftfreq(4096, 1 / 48000)
    edges = [20, 80, 160, 320, 1000, 4000, 10000]
    bins = [(fft_axis >= a) & (fft_axis < b) for a, b in zip(edges[:-1], edges[1:])]
    audio_rows, previous = [], np.zeros(2049)
    for t in data[:, 0]:
        pos = round(t * 48000)
        s = padded[pos:pos + 2048]
        if len(s) < 2048:
            s = np.pad(s, (0, 2048 - len(s)))
        magnitudes = np.abs(np.fft.rfft(s * window, 4096))
        flux = float(np.maximum(0, magnitudes - previous).sum())
        previous = magnitudes
        audio_rows.append([np.sqrt(np.mean(s * s)), np.max(np.abs(s)), flux,
                           *[np.sqrt(np.sum(magnitudes[band] ** 2)) for band in bins]])
    audio_data = np.asarray(audio_rows)
    correlations = {}
    labels = ["rms", "peak", "flux"] + [f"{a}-{b} Hz" for a, b in zip(edges[:-1], edges[1:])]
    for i, key in enumerate(labels):
        values = audio_data[steady_index, i]
        luma = steady[:, 2]
        correlations[key] = float(np.corrcoef(luma, values)[0, 1]) if len(values) > 2 and luma.std() and values.std() else None
    pts = json.loads(command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
                             "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(path)))
    timestamps = np.array([float(frame["best_effort_timestamp_time"]) for frame in pts["frames"]])
    intervals = np.diff(timestamps)
    hashes = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            hashes.update(part)
    stats = {
        "filename": path.name, "sha256": hashes.hexdigest(), "bytes": path.stat().st_size,
        "ffprobe": probe, "decoded_video_frames": len(timestamps),
        "video_pts_increasing": bool(np.all(intervals > 0)),
        "frame_interval_seconds": [float(np.min(intervals)), float(np.max(intervals))],
        "decoded_audio_48k_samples_per_channel": len(stereo),
        "decoded_stereo_sample_peak": float(np.max(np.abs(stereo))),
        "stripe_height_proxy_512_median": float(np.median(steady[:, 7])),
        "masked_luma_median": float(np.median(steady[:, 2])),
        "masked_luma_max": data[int(np.argmax(data[:, 2])), [0, 2]].tolist(),
        "masked_luma_min": data[int(np.argmin(data[:, 2])), [0, 2]].tolist(),
        "blurred_p99_max": data[int(np.argmax(data[:, 5])), [0, 5]].tolist(),
        "period_candidate_px_512": period, "period_power_over_search_median": contrast,
        "masked_luma_same_time_correlations": correlations,
    }
    np.savetxt(output / f"{label}.csv", np.column_stack((data, audio_data)), delimiter=",",
               header="seconds,whole_luma,masked_luma,min_pixel,max_pixel,blurred_p99,bar_roi_mean,stripe_height_proxy," + ",".join(labels), comments="")
    (output / f"{label}.ffprobe.json").write_text(json.dumps(stats, indent=2))
    print(label, stats["decoded_video_frames"], stats["video_pts_increasing"], period, flush=True)
    return data, audio_data, duration, steady


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("files", nargs="+", help="Specify label=path for each local MP4")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    fig, plots = plt.subplots(7, 1, figsize=(12, 19), layout="constrained")
    for value in args.files:
        label, path = value.split("=", 1)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", label):
            parser.error("labels may contain letters, digits, hyphens and underscores")
        data, audio, duration, steady = inspect(label, Path(path), args.output)
        t = data[:, 0]
        rel = data[:, 2] / max(1e-6, np.median(steady[:, 2]))
        for ax, x, y in zip(plots, (t, t, t, t, t - duration, t, t),
                            (data[:, 2], rel, data[:, 5], rel, rel, audio[:, 0], data[:, 7])):
            ax.plot(x, y, label=label, linewidth=1.1)
    for ax, title in zip(plots, ("Masked cover luminance", "Relative cover luminance",
                                "Blurred cover p99 (glow proxy, not a measured compositor setting)",
                                "Intro", "Outro (0 = end)", "Audio RMS near each sampled frame",
                                "Visualizer stroke-height proxy (rows at 512px)")):
        ax.set_title(title)
        ax.set_xlabel("Seconds")
        ax.grid(alpha=.2)
        ax.legend(ncols=3, fontsize=7)
    plots[3].set_xlim(0, 3.5)
    plots[4].set_xlim(-2, 0)
    fig.savefig(args.output / "showcase-comparison.png", dpi=135)


if __name__ == "__main__":
    main()
