# 最小クラウド動画書き出し（All Versions 1:1）

2026-11-10。既存のV0–V7動画基盤と接続試験（`server/connection-probe/`）は変更せず、
**All Versions の合成レンダラーをそのまま再利用**した最小のクラウド書き出し経路を追加した。
接続試験コードは独立したまま参考にしていない。

## 対象ツールと出力

- ツール: Developer Studio → All Versions（`/developer/all-versions/`）。
- 操作: 既存の素材選択・開始/終了トリム・Version境界（marker）・Version名・カバー画像をそのまま使用。
- 「サーバーで書き出し」で、その編集内容をサーバー側の同じレンダラーでMP4化する。
- 出力: **1920×1080 / 60fps / H.264(yuv420p, bt709) + AAC 48kHz stereo**、`+faststart`。
- FNF Showcase（縦1080×1920・crop・見出し焼き込み）は本最小版の対象外。既存の端末内書き出しは従来どおり。

対応していない編集設定を黙って無視しない。素材・区間・境界・名前・カバーのどれかが欠ける、
Version名の行数が境界数と一致しない等の場合は開始できない（理由をUIに表示）。

## 構成

```
iPhone Safari
  │  XHR (Blob送信, 進捗, 宣言サイズ+SHA-256)
  ▼
API (既存 video API に /v1/cloud-export/* を追加)
  │  4MiB上限のchunkを1MiBずつDBへ (axfluxo_export.blob_chunks)
  │  ジョブ登録 (axfluxo_export.jobs)
  ▼
PostgreSQL（APIとWorkerが共有する唯一の媒体。共有ディスクを仮定しない）
  ▲
  │  lease/fencing token + heartbeat (axfluxo_export.slot)
Worker (export-worker.mjs, 同時1ジョブ・同時FFmpeg 1)
  │  素材をDBから検証付きで取得 → 既存 renderPlan/projectPlan/graphics/encode/assemble/validateVideo
  │  完成MP4をchunkでDBへ → 全検証後にpublish
  ▼
GET /v1/cloud-export/jobs/:id/output  (Range対応, 認証必須)
```

- 素材と完成物はDBに保存する。R2は必須にしない（既存R2コードは未変更で残る）。
- APIとWorkerの間に内部HTTPは不要。WorkerはSafari/APIの接続状態に依存しない。
- 出力は`succeeded`になるまで公開しない。leaseを失ったWorkerは書き込めない（DBトリガでも強制）。

## API

| method/path | 内容 |
| --- | --- |
| `GET /v1/cloud-export/session` | 受付状態・上限・出力プロファイル（要開発者権限） |
| `POST /v1/cloud-export/blobs` | 素材の逐次アップロード。`Content-Length`・`X-Content-SHA256`・`X-Blob-Kind: video\|image` 必須 |
| `POST /v1/cloud-export/jobs` | ジョブ登録。`Idempotency-Key`必須、JSONは96KiBまで |
| `GET /v1/cloud-export/jobs/:id` | 状態・進捗フレーム・完成物情報 |
| `POST /v1/cloud-export/jobs/:id/cancel` | 待機中は即時取消、実行中は取消要求 |
| `GET/HEAD /v1/cloud-export/jobs/:id/output` | MP4のストリーム配信。`Range`対応（206/416） |

- 認証は既存Supabase JWT（Authorization: Bearer）と既存`developer_memberships`。
- 全クエリが`owner_id`条件とRLSの両方で所有者を限定する。他人のジョブ・素材は404。
- 同一owner+冪等キーは同一結果。内容が違えば409。同一ハッシュの素材は再送せず再利用する。
- エラーは固定コードのみ（SQL・パス・トークン・素材名を返さない）。

## 上限（既定）

| 項目 | 既定 | 環境変数 |
| --- | --- | --- |
| 1素材 | 64MiB | `EXPORT_MAX_UPLOAD_BYTES` |
| カバー画像 | 8MiB | `EXPORT_MAX_IMAGE_BYTES` |
| 出力フレーム数 | 900（15秒@60fps） | `EXPORT_MAX_FRAMES` |
| 素材本数 | 20 | `EXPORT_MAX_CLIPS` |
| 出力サイズ | 256MiB | コード固定 |
| chunk | 1MiB | コード固定 |

## サーバー設定

API（既存`server`のAPIプロセスに同居）:

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `EXPORT_ENABLED` | ○ | `true`で受付。既定OFF（DB接続も開かない） |
| `VIDEO_JWT_ISSUER` / `VIDEO_JWT_AUDIENCE` | ○ | 既存APIと同じ |
| `VIDEO_DATABASE_URL` または `DATABASE_URL` | ○ | 既存と同じ検証 |
| `VIDEO_ALLOWED_ORIGINS` | ○ | 既存。書き出し元の完全origin |
| `EXPORT_MAX_UPLOAD_BYTES` ほか | – | 上表 |

Worker（`export-worker`ロールのDockerターゲット）:

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `VIDEO_DATABASE_URL` または `DATABASE_URL` | ○ | APIと同じDB |
| `EXPORT_WORK_DIR` | – | 既定`/tmp/axfluxo-export`。Dockerターゲットは`/work` |
| `EXPORT_MIN_FREE_BYTES` | – | 既定512MiB、Dockerターゲットは256MiB |
| `EXPORT_MAX_WORK_BYTES` | – | 既定2GiB |
| `EXPORT_SESSION_TIMEOUT_MS` | – | 既定20分。超えたら子プロセスを停止し失敗 |
| `EXPORT_WORKER_POLL_MS` | – | 既定1000ms |
| `VIDEO_ALEO_FONT` | – | 既存レンダラーと同じ。Dockerは`/app/assets/Aleo.ttf` |

## migration とロール

`server/db/migrations/008_cloud_export.sql`（**明示承認時の管理者のみ適用。起動時自動実行しない**）。

- schema `axfluxo_export`（blobs / blob_chunks / jobs / job_blobs / slot）。
- NOLOGINロール `axfluxo_export_api` / `axfluxo_export_worker` を作成。
- 001の`axfluxo_video.developer_memberships`を正として参照する（新しい会員テーブルは作らない）。
- 適用後、各ログインにロールを付与する:
  ```sql
  GRANT axfluxo_export_api TO <api_login>;
  GRANT axfluxo_export_worker TO <worker_login>;
  ```
- 書き出しを有効化する前に、対象ownerの`developer_memberships`がactiveであること。

## blitz.cloud で必要な設定（未実施・承認待ち）

1. DB（PostgreSQL）を1つ用意し、`axfluxo_video`と`axfluxo_export`のmigrationを管理者が適用する。
2. Partsを2つ作る。
   - API: branch `test/blitz-connection-probe`（実装後は対象ブランチ）、Dockerfile `infra/video/Dockerfile`、target `api`。`EXPORT_ENABLED=true`。
   - Worker: 同じDockerfile、target `export-worker`。コマンド追加設定は不要。
3. 両方に同じ`DATABASE_URL`（または`VIDEO_DATABASE_URL`）が注入されることを確認する。注入されない場合は明示的に設定する。
4. APIに`VIDEO_JWT_ISSUER`・`VIDEO_JWT_AUDIENCE`・`VIDEO_ALLOWED_ORIGINS`（GitHub Pagesのorigin）を設定する。
5. DBログインに上記ロールを付与する。
6. キューはDBのため、APIとWorkerの起動順は問わない。APIがsleepしてもWorkerは処理を継続する（未検証）。

- 内部通信ポート・kept folderは本経路では不要（ディスク共有を仮定しない）。
- 課金・外部DB作成・デプロイは本作業では行っていない。

## 検証（Freebuff環境, 2026-11-10）

実行環境: Node 26.13.0（プロジェクト要件は24.x）、FFmpeg 7.0.2（静的ビルドを`~/.local/bin`に配置）、PGlite 0.5.14。

- `npm run lint` / `npx tsc --noEmit` / `npx next build`: 成功。
- `npx vitest run`: **50ファイル / 410テスト成功**（新規15件を含む）。
- `server/tests/cloud-export.test.ts`（14件）:
  - 宣言サイズ+SHA-256で受信しchunk保存、同一ハッシュの再送を再利用
  - ハッシュ不一致/サイズ過大/不正kindの拒否と未完了データの削除
  - 受付OFF、エラー秘匿、owner分離（RLS）、名前数・上限・所有者検証
  - 冪等キーの再送一致/内容相違409、待機中取消
  - lease同時1件、期限切れ回収、旧tokenのfence拒否、実行中取消
  - Range（200/206/416/HEAD）と完成前アクセス拒否
- `server/tests/cloud-export-render.test.ts`（1件, FFmpeg実処理）:
  - 合成1080p60素材+PNGカバー → アップロード → キュー → Worker → **1920×1080/60fps/120フレーム/AAC**のMP4
  - 既存`validateVideo`（全フレーム・音声サンプル・decoderエラー）通過、`ftyp`確認、Range一致
- サーバーバンドル: `api.mjs` / `export-worker.mjs` のesbuild出力成功。

### 未検証

- blitz.cloud上の実デプロイ、API/WorkerのDB同時接続、Workerのsleep/停止挙動、実DB容量・メモリ・CPUでの1080p60実行時間。
- iPhone実機SafariでのBlob送信（大容量・画面ロック・バックグラウンド）、写真アプリへの保存、再訪時の状態復帰。
- Dockerイメージのビルド（この環境ではDockerデーモンに権限がない）。
- WebKit自動試験（この環境ではブラウザ取得不可）。UIの目視確認も未実施。
- 15秒を超える長尺、複数回の連続書き出し、DB容量の枯渇挙動。
- PostgreSQL 17実サーバーでの実行（PGliteのみ）。

## ロールバック

- `EXPORT_ENABLED=false`でAPIを再起動すると新規受付とアップロードを停止する（既存ジョブの取得・取消・出力取得は維持）。
- Workerを停止してもジョブはDBに残る。再起動で再開する（lease失効後の回収）。
- 既存の端末内書き出し・画像Studio/Workflow・R2経路・migration 001–007は変更していない。
- DBの`axfluxo_export`を削除する場合は、既存ジョブと出力の参照を確認してから管理者が行う（自動作成・自動削除はしない）。
