export const SHOWCASE_SPECTRUM = {
  count: 104,
  pitch: 7.04,
  stroke: 1.6,
  baseline: 528,
  minHeight: 2.5,
  maxHeight: 42,
  opacity: 0.88,
} as const;

const sampleRate = 48_000;
const step = sampleRate / 60;
const windowSize = 2048;
const fftSize = 4096;
const floorDb = -72;
const stride = SHOWCASE_SPECTRUM.count + 2;
const clamp = (v: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, v));
const window = Float64Array.from(
  { length: windowSize },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1)),
);
const gain = window.reduce((sum, value) => sum + value, 0);
const bitReverse = Uint16Array.from({ length: fftSize }, (_, i) => {
  let result = 0;
  for (let width = fftSize; width > 1; width >>= 1, i >>= 1)
    result = (result << 1) | (i & 1);
  return result;
});
const cosine = Float64Array.from({ length: fftSize / 2 }, (_, i) =>
  Math.cos((-2 * Math.PI * i) / fftSize),
);
const sine = Float64Array.from({ length: fftSize / 2 }, (_, i) =>
  Math.sin((-2 * Math.PI * i) / fftSize),
);
const spectrumBins = Array.from(
  { length: SHOWCASE_SPECTRUM.count + 1 },
  (_, i) =>
    (20 * (10_000 / 20) ** (i / SHOWCASE_SPECTRUM.count) * fftSize) /
    sampleRate,
);
const edges = [20, 80, 160, 320, 1000, 4000, 10_000].map(
  (hz) => (hz * fftSize) / sampleRate,
);
const smoothing = (ms: number) => 1 - Math.exp(-1000 / (60 * ms));
// Channel order is RMS, peak, then the six frequency ranges in edges.
// The normalized mid ranges help describe both reference recordings.
const exposureWeights = [0.11, 0.04, 0.04, 0.02, 0.015, 0.45, 0.31, 0.015];
const exposureFloors = [0.025, 0.06, 0.02, 0.012, 0.012, 0.018, 0.016, 0.01];
const rise = smoothing(38);
const fall = smoothing(185);
const smooth = (previous: number, value: number) =>
  previous + (value - previous) * (value > previous ? rise : fall);

export type ShowcaseFeatures = {
  frames: Uint8Array;
  /** Audio-relative frame number. All consumers use the same quantized values. */
  sample(seconds: number): { bars: Uint8Array; exposure: number; glow: number };
};

function transform(re: Float64Array, im: Float64Array) {
  for (let size = 2; size <= fftSize; size *= 2) {
    const half = size / 2;
    const spacing = fftSize / size;
    for (let start = 0; start < fftSize; start += size) {
      for (let j = 0; j < half; j++) {
        const a = start + j,
          b = a + half,
          phase = j * spacing;
        const x = re[b] * cosine[phase] - im[b] * sine[phase];
        const y = re[b] * sine[phase] + im[b] * cosine[phase];
        re[b] = re[a] - x;
        im[b] = im[a] - y;
        re[a] += x;
        im[a] += y;
      }
    }
  }
}

export function showcaseAnalyzer(totalSamples: number) {
  const frameCount = Math.ceil(totalSamples / step);
  if (
    !Number.isSafeInteger(totalSamples) ||
    totalSamples < 1 ||
    frameCount * stride > 32 * 1024 * 1024
  )
    throw Error(
      "曲紹介の音声解析に必要なメモリを確保できません。範囲を短くしてください。",
    );
  const frames = new Uint8Array(frameCount * stride);
  const left = new Float32Array(windowSize);
  const right = new Float32Array(windowSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const power = new Float64Array(Math.ceil(edges.at(-1)!) + 1);
  const bands = new Float64Array(6);
  const previousBands = new Float64Array(6);
  const exposureReference = new Float64Array(exposureWeights.length);
  let exposureInitialized = false;
  const bars = new Float64Array(SHOWCASE_SPECTRUM.count);
  let position = 0;
  let index = 0;
  let base = 0.08;
  let exposure = 0.5;
  let glow = 0;

  function energy(low: number, high: number) {
    let sum = 0;
    for (let bin = Math.max(1, Math.floor(low)); bin < high; bin++) {
      const weight = Math.min(high, bin + 1) - Math.max(low, bin);
      sum += weight * power[bin];
    }
    return sum;
  }

  function analyze() {
    re.fill(0);
    im.fill(0);
    let squares = 0;
    let peak = 0;
    for (let i = 0; i < windowSize; i++) {
      const n = (position + i) % windowSize;
      const l = left[n],
        r = right[n];
      squares += (l * l + r * r) / 2;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      re[bitReverse[i]] = l * window[i];
      im[bitReverse[i]] = r * window[i];
    }
    transform(re, im);
    // A complex FFT packs two real stereo channels. Mirror magnitudes recover
    // the mean channel power, including anti-phase signals.
    for (let k = 1; k < power.length; k++) {
      const mirror = fftSize - k;
      power[k] =
        (re[k] ** 2 + im[k] ** 2 + re[mirror] ** 2 + im[mirror] ** 2) /
        (gain * gain);
    }
    const start = index * stride;
    const rms = Math.sqrt(squares / windowSize);
    for (let i = 0; i < bars.length; i++) {
      const low = spectrumBins[i],
        high = spectrumBins[i + 1];
      // Share sub-bin bands via interpolated power. Wider bands aggregate
      // power with square-root bandwidth compensation.
      const bin = Math.max(1, (low + high) / 2);
      const p =
        high - low < 1
          ? power[Math.floor(bin)] * (1 - (bin % 1)) +
            power[Math.ceil(bin)] * (bin % 1)
          : energy(low, high) / Math.sqrt(high - low);
      const db = 10 * Math.log10(Math.max(1e-15, p));
      const target = clamp((db - floorDb) / -floorDb) ** 1.6;
      bars[i] = smooth(bars[i], target);
      frames[start + i] = Math.round(bars[i] * 255);
    }

    let flux = 0;
    for (let i = 0; i < bands.length; i++) {
      const v = Math.sqrt(energy(edges[i], edges[i + 1]));
      bands[i] = v;
      flux += Math.max(0, v - previousBands[i]);
      previousBands[i] = v;
    }
    const activity =
      0.44 * rms +
      0.1 * peak +
      0.1 * bands[0] +
      0.09 * bands[1] +
      0.07 * bands[2] +
      0.13 * bands[3] +
      0.05 * bands[4] +
      0.02 * bands[5];
    const audible = clamp(rms / 0.014);
    base += (activity - base) * 0.013 * audible;
    const scaled = activity / Math.max(0.025, base);
    const transient = clamp(flux / Math.max(0.05, base * 2.2));
    let relativeEnergy = 0;
    for (let i = 0; i < exposureWeights.length; i++) {
      const level = i === 0 ? rms : i === 1 ? peak : bands[i - 2];
      if (!exposureInitialized) exposureReference[i] = level;
      const normal = Math.max(exposureReference[i], exposureFloors[i]);
      relativeEnergy += exposureWeights[i] * clamp(level / normal - 1, -1, 2);
      exposureReference[i] += (level - exposureReference[i]) * 0.013;
    }
    exposureInitialized ||= audible > 0.15;
    const light = clamp(
      0.5 + audible * (0.48 * relativeEnergy + 0.055 * transient),
    );
    exposure = smooth(exposure, light);
    glow = smooth(
      glow,
      audible *
        clamp(
          0.1 * scaled +
            0.44 * transient +
            (0.18 * bands[0]) / Math.max(0.04, base),
        ),
    );
    frames[start + bars.length] = Math.round(exposure * 255);
    frames[start + bars.length + 1] = Math.round(glow * 255);
    index++;
  }

  function push(l: number, r: number) {
    left[position % windowSize] = Number.isFinite(l) ? l : 0;
    right[position % windowSize] = Number.isFinite(r) ? r : 0;
    position++;
    // Center each Hann window on the output frame. The negative half-window
    // and samples after the selected range are zeros, never neighboring audio.
    if (index < frameCount && position === index * step + windowSize / 2)
      analyze();
  }

  return {
    add(l: Float32Array, r: Float32Array) {
      if (l.length !== r.length || position + l.length > totalSamples)
        throw Error("音声解析のサンプル範囲が一致しません。");
      for (let n = 0; n < l.length; n++) push(l[n], r[n]);
    },
    finish(): ShowcaseFeatures {
      if (position !== totalSamples)
        throw Error("音声解析が選択区間の終端に達していません。");
      while (index < frameCount) push(0, 0);
      return {
        frames,
        sample(seconds) {
          const frame =
            clamp(Math.round(seconds * 60), 0, frameCount - 1) * stride;
          const bars = frames.subarray(frame, frame + SHOWCASE_SPECTRUM.count);
          return {
            bars,
            exposure: 1 + (frames[frame + bars.length] / 255 - 0.5) * 0.28,
            glow: frames[frame + bars.length + 1] / 255,
          };
        },
      };
    },
  };
}
