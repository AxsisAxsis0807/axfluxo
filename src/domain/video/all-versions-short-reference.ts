// Timing sampled from the supplied 60 fps TREVAS short. Outro rows are
// measured relative to the end so they work at any selected clip duration.
const intro = [
  [0, 0.255, 0],
  [0.1, 0.27, 0.02],
  [0.2, 0.3, 0.15],
  [0.3, 0.36, 0.33],
  [0.5, 0.46, 0.68],
  [0.7, 0.54, 0.89],
  [1.0, 0.6, 1],
  [1.2, 0.61, 1],
  [1.5, 0.64, 1],
  [1.85, 0.67, 1],
  [1.9, 0.81, 1],
  [1.95, 0.89, 1],
  [2.0, 0.91, 1],
  [2.5, 0.95, 1],
  [3.0, 1, 1],
] as const;

// The reference's 1.9-second jump is not a proven template rule. New
// compositions interpolate the surrounding points and use their own audio.
const responsiveIntro = intro.filter(([time]) => time < 1.85 || time >= 2.0);

const outro = [
  [0, 0, 0, 0],
  [0.1, 0, 0, 0.01],
  [0.2, 0.02, 0.025, 0.11],
  [0.3, 0.065, 0.075, 0.27],
  [0.4, 0.135, 0.155, 0.46],
  [0.5, 0.23, 0.265, 0.63],
  [0.6, 0.36, 0.415, 0.755],
  [0.7, 0.52, 0.595, 0.875],
  [0.8, 0.69, 0.79, 0.94],
  [0.9, 0.83, 0.94, 0.985],
  [1.0, 0.9, 0.995, 1],
  [1.2, 0.95, 1, 1],
  [1.4, 1, 1, 1],
] as const;

// The original audio stems are unavailable. The observed tail envelope is
// approximated by a linear gain ramp.
export const SHORT_AUDIO_FADE_SECONDS = 2;

function interpolate(
  rows: readonly (readonly number[])[],
  time: number,
  column: number,
) {
  const next = rows.findIndex((point) => point[0] > time);
  if (next < 0) return rows[rows.length - 1][column];
  if (next === 0) return rows[0][column];
  const a = rows[next - 1];
  const b = rows[next];
  const weight = (time - a[0]) / (b[0] - a[0]);
  return a[column] + weight * (b[column] - a[column]);
}

export function shortReferenceOpacity(seconds: number, duration: number, responsive = false) {
  const time = Math.max(0, Math.min(seconds, duration));
  // Give very short excerpts enough time to show the cover and overlays.
  const introTime = time * (3 / Math.min(3, duration / 3));
  const remaining = (duration - time) * (1.4 / Math.min(1.4, duration / 3));
  return {
    cover: interpolate(responsive ? responsiveIntro : intro, introTime, 1) * interpolate(outro, remaining, 1),
    title: interpolate(outro, remaining, 2),
    clock: interpolate(intro, introTime, 2) * interpolate(outro, remaining, 3),
  };
}
