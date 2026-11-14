"use client";
import { publicVideoOrigin } from "../../services/video/public-config";
import { useMemo, useRef, useEffect, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import { uploadDriveFile } from "../../services/video/drive-upload";
import {
  driveCloudStatus,
  driveUploadView,
  type DriveUploadView,
} from "../../domain/drive-cloud/schema";
function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string }) {
  if (!r.ok) throw Error(r.code);
  return r.data;
}
export default function DriveMaterialUpload({
  onReady,
}: {
  onReady: () => void;
}) {
  const client = useMemo(() => {
    const baseUrl = publicVideoOrigin(),
      session = currentVideoSessionSource();
    if (!baseUrl || !session) return null;
    try {
      return createVideoApiClient({ baseUrl, session });
    } catch {
      return null;
    }
  }, []);
  const [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("Driveへ保存する素材を選択してください。"),
    [uploads, setUploads] = useState<DriveUploadView[]>([]);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch {
      setNote(
        "完了していません。接続設定・運用条件・空き容量を確認し、同じファイルを再選択して再試行してください。原本は削除していません。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Drive元素材転送">
      <h2>Drive元素材転送</h2>
      <p>
        送信中はSafariを開いたままにしてください。Drive保存後、Workerの検証完了で素材一覧へ反映されます。
      </p>
      <p role="status">{note}</p>
      <input
        type="file"
        multiple
        accept="video/*,audio/*,image/png,image/jpeg,image/webp"
        aria-label="Driveへ保存する素材"
        disabled={busy}
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
      />
      <button
        disabled={!client || busy || !files.length}
        onClick={() =>
          void run(async () => {
            if (!client) return;
            const status = unwrap(
              await client.request("/v1/drive/status", driveCloudStatus),
            );
            if (!status.enabled || !status.connected) throw Error();
            if (
              status.maxVerifiableBytes !== undefined &&
              files.some((file) => file.size > status.maxVerifiableBytes!)
            ) {
              setNote(`選択した素材はWorker検証の設定上限 ${(status.maxVerifiableBytes / 1024 ** 2).toFixed(0)} MiBを超えています。送信せず保留しました。`);
              return;
            }
            const owner = unwrap(await client.me()).ownerId;
            stop.current = new AbortController();
            const result: DriveUploadView[] = [];
            for (const file of files)
              result.push(
                await uploadDriveFile(
                  client,
                  owner,
                  file,
                  (offset, total) =>
                    setNote(
                      "Driveへ転送中 " +
                        Math.floor((offset / total) * 100) +
                        "%",
                    ),
                  stop.current.signal,
                ),
              );
            setUploads(result);
            setNote("送信しました。Workerの検証状態を確認してください。");
          })
        }
      >
        Driveへ送信・再開
      </button>
      <button disabled={!busy} onClick={() => stop.current?.abort()}>
        送信を停止
      </button>
      <button
        disabled={!client || busy || !uploads.length}
        onClick={() =>
          void run(async () => {
            if (!client) return;
            const rows: DriveUploadView[] = [];
            for (const row of uploads)
              rows.push(
                unwrap(
                  await client.request(
                    "/v1/drive/uploads/" + row.id,
                    driveUploadView,
                  ),
                ),
              );
            setUploads(rows);
            if (rows.every((r) => r.state === "ready")) {
              setNote(
                "すべての素材の保存・ハッシュ・メディア検証が完了しました。",
              );
              onReady();
            } else
              setNote(
                "検証中または保留です。まだジョブ受付は確定していません。",
              );
          })
        }
      >
        素材検証の状態を確認
      </button>
    </section>
  );
}
