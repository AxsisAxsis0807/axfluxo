type Report = {
  route: "WebCodecs" | "MediaRecorder";
  format?: string;
  state: "running" | "complete" | "failed";
  failure?: string;
};
let report: Report | null = null;
const listeners = new Set<() => void>();
export const getEncodeReport = () => report;
export function subscribeEncodeReport(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setEncodeReport(
  update: Partial<Report> & Pick<Report, "state">,
) {
  if (update.route) report = { ...update, route: update.route };
  else if (report) report = { ...report, ...update };
  listeners.forEach((listener) => listener());
}
export function encodeFailureCategory(error: unknown) {
  if (!(error instanceof Error)) return "原因不明";
  if (error.name === "AbortError") return "中断";
  const message = error.message;
  if (/タイムスタンプ|音声時刻|区間に一致|フレーム時刻/.test(message))
    return "時間軸の検査に失敗";
  if (/256MiB|容量|Quota/.test(message)) return "保存容量・ファイルサイズ上限";
  if (/対応していません|デコードできません/.test(message))
    return "APIまたはコーデックが非対応";
  if (/素材|再生|読み込/.test(message)) return "素材の読み込み・再生に失敗";
  return "エンコーダーまたはMP4作成に失敗";
}
