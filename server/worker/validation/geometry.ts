import { RenderError } from "../jobs/errors";
import type { Track } from "../render/process";
export function sourceGeometry(
  v: Pick<Track, "width" | "height" | "side_data_list"> & {
    sample_aspect_ratio?: string;
  },
) {
  const sar = (v.sample_aspect_ratio ?? "1:1").split(":").map(Number),
    ratio = sar[0] > 0 && sar[1] > 0 ? sar[0] / sar[1] : 1,
    rotation =
      v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0;
  let width = Math.floor(((v.width ?? 0) * ratio) / 2) * 2,
    height = v.height ?? 0;
  if (Math.abs(Math.round(rotation / 90)) % 2)
    [width, height] = [height, width];
  return { width, height };
}

export function rotationFilters(v: {
  side_data_list?: { rotation?: number }[];
}) {
  const value =
      v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0,
    rotation = ((Math.round(value) % 360) + 360) % 360;
  if (rotation === 90) return ["transpose=cclock"];
  if (rotation === 270) return ["transpose=clock"];
  if (rotation === 180) return ["hflip", "vflip"];
  if (rotation !== 0) throw new RenderError("INPUT_UNSUPPORTED");
  return [];
}
