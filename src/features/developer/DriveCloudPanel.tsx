"use client";
import {
  publicVideoOrigin,
  publicBasePath,
} from "../../services/video/public-config";
import { sha256File } from "../../domain/cloud-export/sha256";
import { useMemo, useRef, useState, useEffect } from "react";
import { z } from "zod";
import type { LocalProjectData } from "../../services/video/local-project";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import {
  driveCloudStatus,
  driveUploadView,
  type DriveUploadView,
} from "../../domain/drive-cloud/schema";
import {
  batchViewSchema,
  type BatchView,
} from "../../../server/contracts/video";
import { uploadDriveFile } from "../../services/video/drive-upload";
import { driveSnapshot } from "../../services/video/drive-snapshot";
const ticketSchema = z.object({
  url: z.string(),
  versionId: z.string(),
  sha256: z.string(),
  size: z.number(),
  expiresIn: z.number(),
});
const stateText: Record<string, string> = {
  queued: "キュー待ち",
  held: "保留（環境・容量・接続を確認）",
  running: "処理中",
  cancel_requested: "取消確認中",
  cancelled: "取消済み",
  failed: "失敗",
  interrupted: "中断",
  succeeded: "完成",
};
function value<T>(r: { ok: true; data: T } | { ok: false; code: string }) {
  if (!r.ok) throw Error(r.code);
  return r.data;
}
export default function DriveCloudPanel({
  project,
  prepared,
}: {
  project?: LocalProjectData;
  prepared?: () => ReturnType<typeof driveSnapshot>;
}) {
  const client = useMemo(() => {
    const origin = publicVideoOrigin(),
      session = currentVideoSessionSource();
    if (!origin || !session) return null;
    try {
      return createVideoApiClient({ baseUrl: origin, session });
    } catch {
      return null;
    }
  }, []);
  const [status, setStatus] = useState<z.infer<typeof driveCloudStatus> | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState(
      "Cloudは未確認です。ローカル編集・書き出しは引き続き使用できます。",
    ),
    [uploads, setUploads] = useState<DriveUploadView[]>([]),
    [cover, setCover] = useState<DriveUploadView | undefined>(),
    [batch, setBatch] = useState<BatchView | null>(null),
    [usage, setUsage] = useState<unknown>(),
    [tickets, setTickets] = useState<
      Record<string, z.infer<typeof ticketSchema>>
    >({}),
    [opened, setOpened] = useState<Record<string, boolean>>({});
  const frozen = useRef<LocalProjectData | null>(null),
    operation = useRef<string | null>(null),
    pending = useRef<ReturnType<typeof driveSnapshot> | null>(null),
    stop = useRef<AbortController | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => () => stop.current?.abort(), []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const messages: Record<string, string> = {
        DRIVE_CLOUD_HELD:
          "契約・料金・実行環境の確認待ちです。Cloud受付は停止中です。",
        DRIVE_RECONNECT_REQUIRED: "Google Driveへの再接続が必要です。",
        DRIVE_QUOTA_EXCEEDED:
          "空き容量が不足しています。原本や未確認出力は削除されていません。",
        DRIVE_FOLDER_RECOVERY_REQUIRED:
          "専用フォルダの移動・削除を確認し、元の親フォルダへ戻してから再試行してください。",
        DRIVE_PROFILE_HELD:
          "この解像度のCloud提供は検証待ちです。選んだ出力設定は変更していません。",
        DRIVE_DB_HELD: "DB容量の確認待ちです。新規受付を停止しました。",
        DRIVE_DISK_HELD:
          "Workerの一時作業領域が不足しています。画質を下げず保留しました。",
        DRIVE_VERIFY_DISK_TOO_SMALL:
          "選んだ素材が現在のWorker検証容量の設定上限を超えています。送信前に設定・実容量を確認してください。画質や原本は変更していません。",
        DRIVE_WORKER_NOT_READY:
          "Drive上の素材をWorkerが検証中です。まだSafariを閉じてよい段階ではありません。",
        DRIVE_SOURCE_IMPORT_REQUIRED:
          "このプロジェクトの素材はDriveで検証済みではありません。元のR2・ローカル素材を削除せず、Drive素材ライブラリで同じファイルを再登録してから書き出してください。",
        DRIVE_TRANSFER_BUSY:
          "転送処理中です。少し待って状態を再確認してください。",
      };
      setNote(
        messages[code] ??
          "処理を完了できませんでした。接続・権限・保留理由を確認して再試行してください。ローカルの作品は保持されています。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!client) return;
    value(await client.me());
    const s = value(await client.request("/v1/drive/status", driveCloudStatus));
    setStatus(s);
    setNote(
      s.enabled && s.connected
        ? "Driveの接続情報があります。送信時に認可と空き容量を確認します。"
        : "Cloudは未提供または未接続です。接続設定と運用条件の確認が必要です。",
    );
  }
  const available = Boolean(client && status?.enabled && status.connected);
  return (
    <section aria-label="Google Drive Cloud書き出し">
      <h2>Google Drive Cloud書き出し</h2>
      <p>
        Cloud用省メモリエンコード（1080p・60fps）。ローカルの出力設定は各出力画面で選択できます。
      </p>
      <p>
        アップロード中にSafariを閉じると停止する可能性があります。素材の検証とジョブ受付が確定した後だけ、サーバー処理へ移ります。
      </p>
      <p role="status">{note}</p>
      {!client && (
        <p>
          API設定またはログインが必要です。ローカル書き出しをご利用ください。
        </p>
      )}
      <button disabled={!client || busy} onClick={() => void run(check)}>
        Cloud利用条件・接続を確認
      </button>
      <a href={publicBasePath() + "/developer/video/"}>Google Drive接続設定</a>
      {status && (
        <p>
          {status.priceConfirmed
            ? `確認された月額見積: ${status.monthlyEstimateYen}円（確定請求の保証ではありません）`
            : "月額・契約条件は未確認です。受付OFF。"}
        </p>
      )}
      {status?.maxVerifiableBytes !== undefined && (
        <p>
          Workerが検証できる1素材の設定上限: {(status.maxVerifiableBytes / 1024 ** 2).toFixed(0)} MiB。
          実際の空きディスクと動画処理用の追加容量は別途確認します。
        </p>
      )}
      <button
        disabled={!project || !available || busy}
        onClick={() =>
          void run(async () => {
            if (!client || !project) return;
            if (
              status?.maxVerifiableBytes !== undefined &&
              (project.sources.some((s) => s.file.size > status.maxVerifiableBytes!) ||
                (project.coverFile && project.coverFile.size > status.maxVerifiableBytes))
            )
              throw Error("DRIVE_VERIFY_DISK_TOO_SMALL");
            const owner = value(await client.me()).ownerId;
            frozen.current = {
              ...project,
              sources: project.sources.map((s) => ({ ...s })),
              ranges: project.ranges.map((r) => ({ ...r })),
            };
            pending.current = null;
            operation.current = null;
            if (!frozen.current.sources.length) throw Error("MEDIA_REQUIRED");
            stop.current = new AbortController();
            const done: DriveUploadView[] = [];
            for (const source of frozen.current.sources) {
              setNote(
                "元素材をDriveへ送信中。Safariを閉じると停止する可能性があります。",
              );
              done.push(
                await uploadDriveFile(
                  client,
                  owner,
                  source.file,
                  (offset, total) =>
                    setNote(
                      `Driveへ送信中 ${Math.floor((offset / total) * 100)}%。Safariを開いたままにしてください。`,
                    ),
                  stop.current.signal,
                ),
              );
            }
            setUploads(done);
            if (frozen.current.mode === "all-versions") {
              if (!frozen.current.coverFile) throw Error("COVER_REQUIRED");
              setCover(
                await uploadDriveFile(
                  client,
                  owner,
                  frozen.current.coverFile,
                  () => setNote("カバー画像を送信しています。"),
                  stop.current.signal,
                ),
              );
            }
            setNote(
              "Driveへ送信しました。Workerによる全体ハッシュ・素材検証の確認が必要です。「検証確認・ジョブ送信」を押してください。",
            );
          })
        }
      >
        素材をDriveへ送信・再開
      </button>
      <button disabled={!busy} onClick={() => stop.current?.abort()}>
        この画面の送信を停止
      </button>
      <button
        disabled={!available || busy || (!prepared && !uploads.length)}
        onClick={() =>
          void run(async () => {
            if (!client) return;
            if (prepared) {
              pending.current = prepared();
              operation.current =
                "drive-job:" +
                (await sha256File(new Blob([JSON.stringify(pending.current)])));
              const accepted = value(
                await client.request(
                  "/v1/drive/batches",
                  batchViewSchema.extend({ workerReady: z.literal(true) }),
                  "POST",
                  pending.current,
                  operation.current,
                ),
              );
              setBatch(accepted);
              setNote(
                "サーバー受領済み。編集内容と検証済みDrive素材を確定しました。Safariを閉じてもジョブは保持されます。処理が進むのはWorker稼働中または復旧後です。",
              );
              return;
            }
            if (!frozen.current) return;
            const checked: DriveUploadView[] = [];
            for (const u of uploads)
              checked.push(
                value(
                  await client.request(
                    "/v1/drive/uploads/" + u.id,
                    driveUploadView,
                  ),
                ),
              );
            setUploads(checked);
            const image = cover
              ? value(
                  await client.request(
                    "/v1/drive/uploads/" + cover.id,
                    driveUploadView,
                  ),
                )
              : undefined;
            setCover(image);
            pending.current ??= driveSnapshot(frozen.current, checked, image);
            operation.current ??=
              "drive-job:" +
              (await sha256File(new Blob([JSON.stringify(pending.current)])));
            const accepted = value(
              await client.request(
                "/v1/drive/batches",
                batchViewSchema.extend({ workerReady: z.literal(true) }),
                "POST",
                pending.current,
                operation.current,
              ),
            );
            setBatch(accepted);
            setNote(
              "サーバー受領済み。Drive保存・素材検証・ジョブ受付が確定しました。Safariを閉じてもジョブは保持されます。Workerの実稼働・停止復旧は別途検証が必要です。",
            );
          })
        }
      >
        {prepared
          ? "現在の編集内容をDrive Cloudへ送信"
          : "検証確認・ジョブ送信"}
      </button>
      <button
        disabled={!client || busy}
        onClick={() =>
          void run(async () => {
            if (!client) return;
            const result = value(
              await client.request(
                "/v1/drive/batches",
                z.object({ items: z.array(z.object({ id: z.uuid() })) }),
              ),
            );
            setRecent(result.items.map((i) => i.id));
          })
        }
      >
        最近のCloudジョブを表示
      </button>
      {recent.map((id) => (
        <button
          key={id}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (client)
                setBatch(
                  value(
                    await client.request(
                      "/v1/drive/batches/" + id,
                      batchViewSchema,
                    ),
                  ),
                );
            })
          }
        >
          ジョブ {id}
        </button>
      ))}
      <button
        disabled={!client || busy || !batch}
        onClick={() =>
          void run(async () => {
            if (client && batch)
              setBatch(
                value(
                  await client.request(
                    "/v1/drive/batches/" + batch.id,
                    batchViewSchema,
                  ),
                ),
              );
          })
        }
      >
        ジョブ状態を確認
      </button>
      {batch && (
        <div>
          <p>バッチID: {batch.id}</p>
          {batch.jobs.map((job) => (
            <div key={job.id}>
              <p>
                {stateText[job.state] ?? job.state}（試行{job.attempt}）
              </p>
              {["resume", "retry", "cancel"].map((action) => (
                <button
                  key={action}
                  disabled={
                    busy ||
                    (action === "resume"
                      ? job.state !== "held"
                      : action === "retry"
                        ? !["failed", "cancelled", "interrupted"].includes(
                            job.state,
                          )
                        : !["queued", "held", "running"].includes(job.state))
                  }
                  onClick={() =>
                    void run(async () => {
                      if (!client) return;
                      value(
                        await client.request(
                          `/v1/drive/jobs/${job.id}/${action}`,
                          z.unknown(),
                          "POST",
                          {},
                          crypto.randomUUID(),
                        ),
                      );
                      setBatch(
                        value(
                          await client.request(
                            "/v1/drive/batches/" + batch.id,
                            batchViewSchema,
                          ),
                        ),
                      );
                    })
                  }
                >
                  {action === "resume"
                    ? "同じジョブを再開"
                    : action === "retry"
                      ? "新しい試行を作成"
                      : "処理を取消"}
                </button>
              ))}
            </div>
          ))}
          {batch.outputs.map((output) => (
            <div key={output.id}>
              <p>完成動画: {output.id}</p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!client) return;
                    const ticket = value(
                      await client.request(
                        `/v1/drive/outputs/${output.id}/ticket`,
                        ticketSchema,
                        "POST",
                        {},
                        crypto.randomUUID(),
                      ),
                    );
                    const target = new URL(ticket.url, publicVideoOrigin());
                    if (
                      target.origin !== new URL(publicVideoOrigin()!).origin ||
                      !target.pathname.startsWith("/v1/drive/download/")
                    )
                      throw Error();
                    setTickets((t) => ({
                      ...t,
                      [output.id]: { ...ticket, url: target.href },
                    }));
                  })
                }
              >
                保存用リンクを発行・再発行
              </button>
              {tickets[output.id] && (
                <>
                  <a href={tickets[output.id].url}>
                    MP4をダウンロードして「ファイル」へ保存
                  </a>
                  <label>
                    <input
                      type="checkbox"
                      checked={opened[output.id] ?? false}
                      onChange={(e) =>
                        setOpened((v) => ({
                          ...v,
                          [output.id]: e.target.checked,
                        }))
                      }
                    />
                    iPhoneの「ファイル」で対象MP4を開き、再生できることを自分で確認しました
                  </label>
                  <button
                    disabled={busy || !opened[output.id]}
                    onClick={() =>
                      void run(async () => {
                        if (!client) return;
                        const t = tickets[output.id];
                        value(
                          await client.request(
                            `/v1/drive/outputs/${output.id}/saved`,
                            z.object({
                              saved: z.literal(true),
                              deleted: z.literal(false),
                            }),
                            "POST",
                            {
                              versionId: t.versionId,
                              sha256: t.sha256,
                              destination: "files",
                              opened: true,
                            },
                            crypto.randomUUID(),
                          ),
                        );
                        setNote(
                          "ファイルへの保存確認を記録しました。Drive上の動画は削除されません。写真ライブラリへの保存とは別の記録です。",
                        );
                      })
                    }
                  >
                    本人の保存確認を記録
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        disabled={!client || busy}
        onClick={() =>
          void run(async () => {
            if (client)
              setUsage(
                value(await client.request("/v1/drive/usage", z.unknown())),
              );
          })
        }
      >
        今月の利用・容量を確認
      </button>
      {usage !== undefined && <UsageView usage={usage} />}
      <p>
        自動削除はOFFです。元素材と保存未確認の完成動画を保持し、容量不足時は受付を止めます。
      </p>
    </section>
  );
}
function UsageView({ usage }: { usage: unknown }) {
  const parsed = z
    .object({
      capacity: z
        .object({
          used_bytes: z.coerce.number(),
          reserved_bytes: z.coerce.number(),
          limit_bytes: z.coerce.number(),
        })
        .nullable(),
      monthly: z.array(
        z.object({
          kind: z.string(),
          bytes: z.coerce.number(),
          operations: z.number(),
        }),
      ),
      temporary: z.array(
        z.object({
          namespace: z.string(),
          files: z.number(),
          bytes: z.coerce.number(),
        }),
      ).optional(),
      unconfirmed: z.number(),
    })
    .safeParse(usage);
  if (!parsed.success) return <p>利用情報を確認できませんでした。</p>;
  const u = parsed.data,
    mib = (n: number) => (n / 1024 ** 2).toFixed(1) + " MiB";
  return (
    <div>
      <p>
        今月のエクスポート容量:{" "}
        {mib(u.monthly.find((m) => m.kind === "export")?.bytes ?? 0)}
      </p>
      <p>未確認の完成動画: {u.unconfirmed}件</p>
      {u.temporary && (
        <p>
          Drive中間生成物: {u.temporary.reduce((n, item) => n + item.files, 0)}件／
          {mib(u.temporary.reduce((n, item) => n + item.bytes, 0))}
          （参照・再試行・checkpoint確認前の自動削除は行いません）
        </p>
      )}
      {u.capacity && (
        <p>
          保存中 {mib(u.capacity.used_bytes)}／予約中{" "}
          {mib(u.capacity.reserved_bytes)}／設定上限{" "}
          {mib(u.capacity.limit_bytes)}
        </p>
      )}
      <p>
        今月の転送（再送・検証読取を含む）:{" "}
        {mib(
          u.monthly
            .filter((m) => ["upload", "download"].includes(m.kind))
            .reduce((n, m) => n + m.bytes, 0),
        )}
        ／Drive Cloud API操作:{" "}
        {u.monthly.find((m) => m.kind === "api")?.operations ?? 0}回
      </p>
    </div>
  );
}
