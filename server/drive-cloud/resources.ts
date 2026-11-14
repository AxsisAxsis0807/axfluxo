export const DRIVE_RENDER_PROFILE = "drive-cfr60-crf18-lookahead8-v1";
import { AsyncLocalStorage } from "node:async_hooks";
const mediaThreads = new AsyncLocalStorage<number>();
export const singleThreaded = <T>(work: () => Promise<T>) =>
  mediaThreads.run(1, work);
/** Explicit Drive-only buffering profile. Legacy defaults, dimensions, CFR60 and CRF18 remain unchanged. */
export function threadArguments(program: string, args: string[]) {
  if (program !== "ffmpeg" || mediaThreads.getStore() !== 1) return args;
  const result = [...args];
  for (let i = 0; i < result.length - 1; i++)
    if (
      /^-(threads(?::[av])?|filter_threads|filter_complex_threads)$/.test(
        result[i],
      )
    )
      result[i + 1] = "1";
  if (result.includes("libx264"))
    result.splice(
      result.length - 1,
      0,
      "-x264-params",
      "rc-lookahead=8:sync-lookahead=0",
    );
  return [
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    ...result,
  ];
}
