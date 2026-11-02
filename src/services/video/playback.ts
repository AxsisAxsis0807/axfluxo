import { secondsToUs } from "./time";
export type PreviewError =
  | "PROXY_NOT_READY"
  | "SOURCE_MISSING"
  | "PLAYBACK_FAILED"
  | "AUTH_EXPIRED"
  | "INVALID_INTERVAL"
  | "PREVIEW_FAILED";
export class PlaybackError extends Error {
  constructor(public readonly code: PreviewError) {
    super(code);
  }
}
export type PtsMapping = {
  sourceFirstPtsUs: number;
  proxyFirstPtsUs: number;
  sourceTimeBase: string;
  proxyTimeBase: string;
};
export const sourceToProxyUs = (sourceElapsedUs: number, mapping: PtsMapping) =>
  sourceElapsedUs + mapping.proxyFirstPtsUs;
export const proxyToSourceUs = (proxyUs: number, mapping: PtsMapping) =>
  Math.max(0, proxyUs - mapping.proxyFirstPtsUs);
export const originalPtsUs = (sourceElapsedUs: number, mapping: PtsMapping) =>
  sourceElapsedUs + mapping.sourceFirstPtsUs;
/** No wall-clock integration: video.currentTime is always authoritative. */
export class PlaybackController {
  private lastUs = 0;
  private pendingUs: number | null = null;
  private renewing: Promise<void> | null = null;
  private generation = 0;
  constructor(
    private media: HTMLVideoElement,
    private renew: () => Promise<{ url: string; mapping: PtsMapping }>,
    public mapping: PtsMapping,
  ) {
    media.playsInline = true;
    media.preload = "metadata";
  }
  currentUs() {
    if (this.media.readyState > 0 && Number.isFinite(this.media.currentTime))
      this.lastUs = proxyToSourceUs(
        secondsToUs(this.media.currentTime),
        this.mapping,
      );
    return this.lastUs;
  }
  seek(us: number) {
    if (!Number.isSafeInteger(us) || us < 0)
      throw new PlaybackError("INVALID_INTERVAL");
    this.lastUs = us;
    this.pendingUs = us;
    if (this.media.readyState >= 1) {
      this.media.currentTime = sourceToProxyUs(us, this.mapping) / 1_000_000;
      this.pendingUs = null;
    }
  }
  loaded() {
    if (this.pendingUs !== null) this.seek(this.pendingUs);
  }
  async playFromGesture() {
    try {
      await this.media.play();
    } catch {
      throw new PlaybackError("PLAYBACK_FAILED");
    }
  }
  pause() {
    this.media.pause();
  }
  async refreshAccess() {
    if (this.renewing) return this.renewing;
    const position = this.pendingUs ?? this.currentUs(),
      generation = ++this.generation;
    this.media.pause();
    this.renewing = (async () => {
      const next = await this.renew();
      if (generation !== this.generation) return;
      this.mapping = next.mapping;
      this.pendingUs = position;
      this.media.src = next.url;
      this.media.load();
    })().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }
  dispose() {
    this.generation++;
    this.media.pause();
    this.media.removeAttribute("src");
    this.media.load();
  }
}
