/** Streaming PCM features: 20 ms hops, no decoded track retained. */
export const BOUNDARY_ALGORITHM = 1;
export const HOP = 0.02;
export type BoundaryCandidate = {
  id: string;
  startUs: number;
  endUs: number;
  timeUs: number;
  confidence: "high" | "medium" | "low";
  reason: "silence" | "low-level" | "acoustic-change" | "manual";
};
export type BoundarySettings = {
  minimumGap: number;
  minimumSpacing: number;
  expectedVersions: number;
};
export const DEFAULT_BOUNDARY_SETTINGS: BoundarySettings = {
  minimumGap: 0.18,
  minimumSpacing: 10,
  expectedVersions: 0,
};
export type BoundaryAnalysis = {
  complete?: boolean;
  sourceKey: string;
  algorithm: number;
  settings: BoundarySettings;
  candidates: BoundaryCandidate[];
  deleted: string[];
};
export const sourceKey = (file: File) =>
  JSON.stringify([file.name, file.size, file.lastModified, file.type]);
type Feature = {
  count: number;
  sum: number;
  peak: number;
  high: number;
  low: number;
};
export class TrackFeatures {
  readonly frames: Feature[];
  constructor(readonly duration: number) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 6 * 3600)
      throw Error("解析は6時間以内の素材に分割して再試行してください。");
    this.frames = Array.from({ length: Math.ceil(duration / HOP) }, () => ({
      count: 0,
      sum: 0,
      peak: 0,
      high: 0,
      low: 0,
    }));
  }
  add(
    channels: Float32Array[],
    sampleRate: number,
    timestamp: number,
    from: number,
    until: number,
  ) {
    for (const channel of channels) {
      let previous = 0,
        low = 0;
      const alpha = 1 - Math.exp((-2 * Math.PI * 400) / sampleRate);
      const first = Math.max(0, Math.ceil((from - timestamp) * sampleRate));
      const last = Math.min(
        channel.length,
        Math.ceil((until - timestamp) * sampleRate),
      );
      for (let i = first; i < last; i++) {
        const value = channel[i];
        const frame =
          this.frames[Math.floor((timestamp + i / sampleRate) / HOP + 1e-7)];
        if (!frame) continue;
        low += alpha * (value - low);
        frame.count++;
        frame.sum += value * value;
        frame.peak = Math.max(frame.peak, Math.abs(value));
        frame.high += (value - previous) ** 2;
        frame.low += low * low;
        previous = value;
      }
    }
  }
  levels() {
    return this.frames.map((f) =>
      f.count ? 10 * Math.log10(Math.max(1e-12, f.sum / f.count)) : -120,
    );
  }
  detect(settings: BoundarySettings): BoundaryCandidate[] {
    if (
      !Number.isFinite(settings.minimumGap) ||
      settings.minimumGap < 0.1 ||
      !Number.isFinite(settings.minimumSpacing) ||
      settings.minimumSpacing < 1 ||
      !Number.isInteger(settings.expectedVersions) ||
      settings.expectedVersions < 0
    )
      throw Error("検出設定を確認してください。");
    if (this.frames.some((f) => !f.count))
      throw Error(
        "音声の一部を解析できません。素材を分割して再試行してください。",
      );
    const db = this.levels();
    const sorted = [...db].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)];
    const music = sorted[Math.floor(sorted.length * 0.75)];
    if (music < -65) return [];
    const threshold = Math.min(
      -30,
      Math.max(-55, Math.min(floor + 8, music - 20)),
    );
    const activity = (start: number, end: number) => {
      const values = db.slice(Math.max(0, start), Math.min(db.length, end));
      return (
        values.length >= 25 &&
        values.filter((v) => v > threshold + 8).length / values.length > 0.7
      );
    };
    const profile = (start: number, end: number) => {
      let sum = 0,
        high = 0,
        low = 0;
      for (
        let i = Math.max(0, start);
        i < Math.min(end, this.frames.length);
        i++
      ) {
        sum += this.frames[i].sum;
        high += this.frames[i].high;
        low += this.frames[i].low;
      }
      return [
        Math.log10(Math.max(1e-9, high / Math.max(1e-12, sum))),
        low / Math.max(1e-12, sum),
      ];
    };
    const difference = (at: number, end = at) => {
      const a = profile(at - 150, at - 25),
        b = profile(end + 25, end + 150);
      return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    };
    const candidates: BoundaryCandidate[] = [];
    const add = (
      start: number,
      end: number,
      confidence: BoundaryCandidate["confidence"],
      reason: BoundaryCandidate["reason"],
    ) => {
      const startUs = Math.round(start * HOP * 1e6),
        endUs = Math.round(end * HOP * 1e6);
      candidates.push({
        id: `${reason}:${startUs}:${endUs}`,
        startUs,
        endUs,
        timeUs: Math.round((startUs + endUs) / 2),
        confidence,
        reason,
      });
    };
    let start = -1,
      lastLow = -1;
    const finish = () => {
      const end = lastLow + 1;
      if (
        start >= 0 &&
        (end - start) * HOP >= settings.minimumGap &&
        activity(start - 150, start) &&
        activity(end, end + 150)
      ) {
        const exact = this.frames.slice(start, end).every((f) => f.peak === 0);
        const changed = difference(start, end) > 0.5;
        // An identical restart after a short break is ambiguous, even at digital zero.
        add(
          start,
          end,
          exact && ((end - start) * HOP >= 0.5 || changed) ? "high" : "medium",
          exact ? "silence" : "low-level",
        );
      }
      start = -1;
      lastLow = -1;
    };
    for (let i = 0; i < db.length; i++) {
      if (db[i] <= threshold + (start >= 0 ? 3 : 0)) {
        if (start < 0) start = i;
        lastLow = i;
      } else if (start >= 0 && (i - lastLow) * HOP > 0.1) finish();
    }
    finish();
    for (let i = 150; i < db.length - 150; i += 25) {
      if (
        activity(i - 150, i - 25) &&
        activity(i + 25, i + 150) &&
        difference(i) > 0.9
      )
        add(i, i, "low", "acoustic-change");
    }
    const rank = { high: 3, medium: 2, low: 1 };
    const accepted: BoundaryCandidate[] = [];
    for (const c of candidates.sort(
      (a, b) => rank[b.confidence] - rank[a.confidence] || a.timeUs - b.timeUs,
    )) {
      if (
        accepted.every(
          (a) => Math.abs(a.timeUs - c.timeUs) >= settings.minimumSpacing * 1e6,
        )
      )
        accepted.push(c);
    }
    // A known count prioritizes evidence; it never synthesizes missing boundaries.
    return accepted
      .slice(
        0,
        settings.expectedVersions > 0 ? settings.expectedVersions - 1 : 2000,
      )
      .sort((a, b) => a.timeUs - b.timeUs);
  }
}

export type BoundaryPlacement = "middle" | "start" | "end" | "before";
export function recommendedBoundary(
  c: BoundaryCandidate,
  placement: BoundaryPlacement,
) {
  return placement === "start"
    ? c.startUs
    : placement === "end"
      ? c.endUs
      : placement === "before"
        ? Math.max(c.startUs, c.endUs - 20_000)
        : c.timeUs;
}
