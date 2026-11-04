export type TrimRange = { start: number; end: number };
export function trimRanges(items: TrimRange[], duration: number): TrimRange[] {
  const result: TrimRange[] = [];
  for (const item of items
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start,
    )
    .sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, Math.min(duration, item.start));
    const end = Math.max(start, Math.min(duration, item.end));
    if (end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else result.push({ start, end });
  }
  return result.length ? result : [{ start: 0, end: duration }];
}
export function clampToTrim(time: number, ranges: TrimRange[]) {
  if (ranges.some((r) => time >= r.start && time <= r.end)) return time;
  return ranges
    .flatMap((r) => [r.start, r.end])
    .reduce(
      (nearest, edge) =>
        Math.abs(edge - time) < Math.abs(nearest - time) ? edge : nearest,
      ranges[0].start,
    );
}
/** Bind to a preview element only; encoding owns a different media element. */
export function bindTrimPlayback(video: HTMLVideoElement, ranges: TrimRange[]) {
  let frame = 0;
  const start = ranges[0].start,
    end = ranges.at(-1)!.end;
  const seek = () => {
    if (video.readyState === 0) return;
    const target = clampToTrim(video.currentTime, ranges);
    if (Math.abs(target - video.currentTime) > 0.00001)
      video.currentTime = target;
  };
  const tick = () => {
    if (video.currentTime >= end) {
      if (video.loop && !video.paused) video.currentTime = start;
      else {
        video.pause();
        if (Math.abs(video.currentTime - end) > 0.000001)
          video.currentTime = end;
      }
    } else {
      const previous = ranges.find(
        (r, i) =>
          video.currentTime >= r.end &&
          video.currentTime < (ranges[i + 1]?.start ?? end),
      );
      if (previous)
        video.currentTime = ranges[ranges.indexOf(previous) + 1]?.start ?? end;
      else seek();
    }
  };
  const animate = () => {
    tick();
    if (!video.paused) frame = requestAnimationFrame(animate);
  };
  const play = () => {
    if (video.currentTime >= end - 0.001) video.currentTime = start;
    else seek();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(animate);
  };
  video.addEventListener("loadedmetadata", seek);
  video.addEventListener("play", play);
  video.addEventListener("seeking", seek);
  video.addEventListener("timeupdate", tick);
  seek();
  if (!video.paused) play();
  return () => {
    cancelAnimationFrame(frame);
    video.removeEventListener("loadedmetadata", seek);
    video.removeEventListener("play", play);
    video.removeEventListener("seeking", seek);
    video.removeEventListener("timeupdate", tick);
  };
}
