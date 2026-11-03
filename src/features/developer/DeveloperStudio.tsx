"use client";
import { useEffect } from "react";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
import type { DeveloperServices } from "../../../server/contracts/developer-services";
import OutputLibrary from "./OutputLibrary";
export default function DeveloperStudio({
  api,
  services,
}: {
  api: AuthenticatedApi;
  services: DeveloperServices;
}) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = `${base}/developer.webmanifest`;
    document.head.append(link);
    return () => link.remove();
  }, [base]);
  const tools = [
    {
      path: "all-versions",
      name: "All Versions Video Maker",
      enabled: process.env.NEXT_PUBLIC_ALL_VERSIONS_ENABLED === "true",
      text: "16:9・波形・trim・marker・複数version名・デザイン",
    },
    {
      path: "fnf-showcase",
      name: "FNF Showcase Maker",
      enabled: process.env.NEXT_PUBLIC_FNF_SHOWCASE_ENABLED === "true",
      text: "9:16・独立range・譜面名・template・username",
    },
  ];
  return (
    <>
      <main>
        <h1>Developer Studio</h1>
        <p>
          開発者権限をサーバーで確認しました。利用できる編集ツールを選択してください。
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))",
            gap: 16,
          }}
        >
          {tools.map((t) => (
            <section
              key={t.path}
              style={{ padding: 16, border: "1px solid", minWidth: 0 }}
            >
              <h2>{t.name}</h2>
              <p>{t.text}</p>
              {t.enabled ? (
                <a
                  style={{
                    display: "inline-flex",
                    minHeight: 44,
                    alignItems: "center",
                  }}
                  href={`${base}/developer/${t.path}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t.name}を別タブで開く
                </a>
              ) : (
                <p>この編集ツールは停止中です。</p>
              )}
            </section>
          ))}
        </div>
        <section>
          <h2>バックエンドの準備状態</h2>
          <p>
            以下はAPIの設定とDB
            schemaの確認結果です。worker稼働・実機保存・Push配信の成功を示すものではありません。
          </p>
          <ul>
            {(
              [
                ["cloudLibrary", "クラウド素材"],
                ["uploads", "新upload"],
                ["preview", "proxy preview"],
                ["projects", "cloud project同期"],
                ["fnfPreferences", "FNF設定cloud保存"],
                ["renderAcceptance", "All Versions書き出し受付"],
                ["fnfRenderAcceptance", "FNF一括書き出し受付"],
                ["outputs", "完成動画一覧"],
                ["deleteAcceptance", "保存確認後の削除受付"],
                ["push", "通知受付"],
              ] as const
            ).map(([key, label]) => (
              <li key={key}>
                {label}：{services[key] ? "設定確認済み" : "未準備・停止中"}
              </li>
            ))}
          </ul>
        </section>
        {services.cloudLibrary ? (
          <a
            href={`${base}/developer/library/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            クラウド素材ライブラリを別タブで開く
          </a>
        ) : (
          <p>クラウド素材は未準備です。既存画像Libraryを自動移行しません。</p>
        )}
      </main>
      {services.outputs ? (
        <OutputLibrary api={api} />
      ) : (
        <p role="status">
          完成動画の一覧・保存・削除・通知は未準備です。正常動作として表示しません。
        </p>
      )}
    </>
  );
}
