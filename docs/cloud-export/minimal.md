# 最小クラウド動画書き出し（All Versions 1:1）

2026-11-11。既存の All Versions レンダラーを再利用した最小経路に、Blitz 実機導入のための
TLS ポリシー・容量/保持・Safari 向け保存方式を追加した。接続試験（`server/connection-probe/`）は独立のまま。

## 対象ツールと出力

- Developer Studio → All Versions（`/developer/all-versions/`）。素材・トリム・Version境界・Version名・カバー画像をそのまま使う。
- 「サーバーで書き出し」で、サーバー側の同じレンダラー（`projectPlan`→`prepareGraphics`→`encodeProjectSegment`→`assemble`→`validateVideo`）を実行する。
- 出力: **1920×1080 / 60fps / H.264(yuv420p, bt709) + AAC 48kHz stereo**、`+faststart`。
- FNF Showcase と端末内書き出しは対象外（端末内は従来どおり）。未対応の編集設定は開始時に拒否し、黙って無視しない。

## 構成

```
iPhone Safari
  │ XHR(Blob送信, 進捗) + ストリーミングSHA-256
  ▼
API (既存 video API に /v1/cloud-export/*)
  │ 1MiB chunk を DB へ / ジョブ登録 / 単発DLチケット
  ▼
PostgreSQL（APIとWorkerが共有する唯一の媒体。共有ディスクを仮定しない）
  ▲
  │ lease/fencing + heartbeat + 24時間の保持掃除
Worker (export-worker.mjs, 同時1ジョブ・同時FFmpeg 1)
  ▼
GET /v1/cloud-export/downloads/<単発トークン>  → Safari が Files へ直接保存（JSメモリ不使用）
```

## API

| method/path | 内容 |
| --- | --- |
| `GET /v1/cloud-export/session` | 受付状態・上限・プロファイル・保持時間（開発者権限必須） |
| `POST /v1/cloud-export/blobs` | 素材の逐次アップロード。`Content-Length`・`X-Content-SHA256`・`X-Blob-Kind` 必須 |
| `POST /v1/cloud-export/jobs` | ジョブ登録（`Idempotency-Key`、JSON 96KiBまで） |
| `GET /v1/cloud-export/jobs/:id` | 状態・進捗 |
| `POST /v1/cloud-export/jobs/:id/cancel` | 取り消し |
| `DELETE /v1/cloud-export/jobs/:id` | 所有者による削除（終了済みのみ。未参照バイトも削除） |
| `POST /v1/cloud-export/jobs/:id/download-ticket` | 120秒・1回限りの保存URLを発行 |
| `GET/HEAD /v1/cloud-export/jobs/:id/output` | 認証付きMP4。Range対応 |
| `GET /v1/cloud-export/downloads/:token` | チケットによる保存。認証ヘッダ不要、1回で失効 |

- 認証は既存 Supabase JWT と `axfluxo_video.developer_memberships`。全クエリが `owner_id` と RLS の両方で所有者を限定する。
- エラーは固定コードのみ（SQL・パス・トークン・素材名を返さない）。
- ダウンロードトークンは 32 バイト乱数、DB には SHA-256 のみ保存、使用時に同一UPDATEで失効。他人のジョブには解決できない。

## 上限と容量（無料DB 1GB前提）

| 項目 | 既定 | 環境変数 |
| --- | --- | --- |
| 1素材 | 64MiB（Blitzでは24MiB推奨） | `EXPORT_MAX_UPLOAD_BYTES` |
| カバー | 8MiB | `EXPORT_MAX_IMAGE_BYTES` |
| 長さ | 900フレーム=15秒（Blitzでは600=10秒推奨） | `EXPORT_MAX_FRAMES` |
| 素材本数 | 20 | `EXPORT_MAX_CLIPS` |
| 所有者合計 | 256MiB | `EXPORT_OWNER_BYTES` |
| 保持 | 24時間 | `EXPORT_RETENTION_HOURS` |
| 出力 | 256MiB | 固定 |
| 同時実行 | 1ジョブ・1FFmpeg | 固定 |

容量の目安（1MiB chunk + 行/TOAST オーバーヘッドを約5%と仮定）:

- 10秒1080p60の出力: 約10–25MiB。素材2本（各10–20MiB）+ 出力で **1ジョブ 40–70MiB**。
- 256MiB/所有者なら同時に3–5ジョブ相当。1GBのDBで3–4人分が上限。24時間で自動削除し、DBが埋まる前に空ける。
- 所有者合計は入力と出力の両方を含む。上限超過は `EXPORT_LIMIT_EXCEEDED` で拒否し、部分データは破棄する。

削除と保持:

- `DELETE /jobs/:id` は終了済み（succeeded/failed/cancelled）のみ。実行中は409。
- 削除は job_blobs → tickets → job → 他ジョブが参照しない blob の順。`axfluxo.export_purge=on` のトランザクションだけが不変トリガを通過できる（RLSで所有者の行に限定）。
- Worker は待機中に `EXPORT_RETENTION_HOURS` を超えた終了ジョブと、1時間放置された未完了アップロードを最大20件ずつ掃除する。
- 既存データを自動で一括削除する処理はない（初回適用時に何も消えない）。

## データベースTLS

Blitz の PostgreSQL 17 は**内部ネットワーク専用で TLS を提供しない**（公式: 「TLS options are not needed」）。
以前の `rejectUnauthorized: true` 固定では接続できないため、明示ポリシーに変更した（`server/db/tls.ts`）。

| `VIDEO_DATABASE_TLS` | 動作 | 用途 |
| --- | --- | --- |
| 未設定 / `disable` | TLSなし | Blitz内部DB（既定） |
| `require` | 暗号化・証明書検証なし | CAを出せない外部DBのみ |
| `verify-full` | 証明書チェーン検証 | 外部DB。`VIDEO_DATABASE_CA` 必須 |

- `VIDEO_DATABASE_CA` は PEM 文字列または読めるファイルパス。`require`/`disable` と併用すると設定エラー。
- 検証を無条件に無効化しない。モードは明示設定で、矛盾は起動時に拒否する（`ConfigurationError`）。

## Safariのメモリ

- **アップロード**: `file.arrayBuffer()` をやめ、`file.stream()` を1MiB前後で読みながら増分SHA-256（`src/domain/cloud-export/sha256.ts`、Node cryptoと一致することを試験）。全量コピーを作らない。
- **保存**: 完成MP4を fetch→Blob で溜めず、単発URLへ遷移して Safari に直接ダウンロードさせる。JSヒープにMP4を保持しない。
- どうしてもチケットが使えない場合のみ、従来のBlob取得にフォールバックする（デスクトップ向け）。
- 初回試験の推奨: 5–10秒、素材各20MiB以下、カバー2MiB以下。`EXPORT_MAX_UPLOAD_BYTES=25165824`、`EXPORT_MAX_FRAMES=600`。

## フロントエンドの公開

- `NEXT_PUBLIC_VIDEO_API_ORIGIN` は**ビルド時に静的バンドルへ埋め込まれる**。未設定だとパネルは表示されない（サーバー側は動作する）。
- 事前確認: `npm run check:video-origin`（未設定・パス付き・http非localhostを拒否）。
- 開発ブランチから iPhone で試す方法（いずれも外部公開のため**別承認**）:
  1. GitHub Actions の `pages.yml` を `workflow_dispatch` でこのブランチに対して実行（`NEXT_PUBLIC_BASE_PATH=/axfluxo`、Pages公開を伴う）。
  2. もしくは同等の静的ホスティングへ `out/` を配布（新規契約はしない）。
- main へのマージや既存PRの変更はしない。`pages.yml` は main push / PR / 手動のみが対象で、このブランチへの push では起動しない。

## blitz.cloud の無料枠（公式料金ページ 2026-11-08 更新）

- 0 EUR・カード不要。**5 apps / 512MB メモリ / 10GB ストレージ / DB 1つ**。
- **期限なしで使えるのは EU・EEA・英国・スイスのアカウントのみ。** それ以外（日本を含む）の新規アカウントは **7日間**（カード不要）で、その後はアプリが停止する。再開には Pro（1アプリ 3 EUR/月〜、アカウント全体 7 EUR/月）が必要。**データは30日間保持され、自動削除されない**。Proの初月は返金対象。無料のProトライアル（14日・1人1回）は別枠。
- したがって「日本から期限なく無料で実運用」はできない。実機検証は7日以内に終えるか、Pro契約（課金のため別承認）を前提にする。
- **バックグラウンドで動く part は1つまで**（APIは公開ポートを持つため対象外、Workerが該当）。
- PostgreSQL 17 は 1DB あたり **1GB ストレージと 128MB メモリを予約**（アプリ用は実質 384MB）。
- 夜間バックアップ7世代。DBは内部名のみで外部公開なし。バージョン固定。
- バックグラウンド part はアカウントに動きがないと停止する。**停止中はジョブが進まない**が、データは消えない。利用者がサイトを開くと再開する（自動延命はしない）。アドレス付きアプリも、30日間サインインがなく訪問者もいなければ停止する。
- 注意: トップページ・FAQには「no time limit」「15 apps / 2GB」など旧仕様の記述が残っている（更新日が古い）。料金ページ（2026-11-08 更新）を正とする。
- 参照: https://blitz.cloud/pricing/ , https://blitz.cloud/terms/ , https://blitz.cloud/docs/databases/

## サーバー設定

API（既存APIプロセスに同居。`EXPORT_ENABLED=true` のときだけ専用DBプールを1本追加）:

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `EXPORT_ENABLED` | ○ | `true` で受付。既定OFF（DB接続も開かない） |
| `VIDEO_JWT_ISSUER` / `VIDEO_JWT_AUDIENCE` | ○ | 既存と同じ |
| `DATABASE_URL` | ○ | Blitzが自動注入 |
| `VIDEO_ALLOWED_ORIGINS` | ○ | 編集画面の完全origin |
| `VIDEO_DATABASE_TLS` | – | Blitzでは未設定（=disable）のまま |
| `EXPORT_OWNER_BYTES` / `EXPORT_RETENTION_HOURS` | – | 256MiB / 24 |
| `EXPORT_MAX_UPLOAD_BYTES` / `EXPORT_MAX_FRAMES` | – | 初回は24MiB / 600 を推奨 |

Worker（`export-worker` ターゲット）:

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `DATABASE_URL` | ○ | APIと同じ |
| `EXPORT_WORK_DIR` | – | Docker既定 `/work` |
| `EXPORT_MIN_FREE_BYTES` | – | Docker既定 256MiB |
| `EXPORT_SESSION_TIMEOUT_MS` | – | 既定20分。超過で子プロセス停止 |
| `EXPORT_RETENTION_HOURS` | – | APIと同値にする |

Docker: `infra/video/Dockerfile` の `api` / `export-worker`。runtime に FFmpeg とフォントを含み、
`export-worker` は `node /app/export-worker.mjs`、heap 128MB、`/work` を使用。
APIとWorkerはDBだけを共有し、ディスクは共有しない。

## migration とロール

1. `007` まで適用済みのDBに `008_cloud_export.sql` と `009_cloud_export_retention.sql` を管理者が明示適用（起動時自動実行なし）。
2. Blitzは1つの `DATABASE_URL` を両partに注入するため、そのログインに両ロールを付与する:
   ```sql
   GRANT axfluxo_export_api, axfluxo_export_worker TO <blitz_db_login>;
   ```
   （単一口グインのため完全な最小権限分離はできない。API/Workerはそれぞれ `SET LOCAL ROLE` で自分のロールだけを使う。
   `node /app/migrate.mjs` はこのGRANTも自動で行う。）
3. 対象ownerが `axfluxo_video.developer_memberships` に active で存在すること。

## デプロイ手順（承認後）

### 1. ブランチを明示する

ウィザードは既定で `main` を選ぶ。`main` にはこのコードがない。
「My own code」でリポジトリを選んだあと、**「Advanced settings」を開き、Branch の一覧から
`freebuff/46d45a7d28e79173a72d4eeb` を選ぶ**（デプロイ後も Settings > Where new versions
come from で変更できる）。ブランチ欄が畳まれていて見えないだけなので、まず Advanced settings を展開する。

### 2. ビルド構成

リポジトリ直下の `compose.yaml` が API と export-worker の2パーツを定義する。
Blitz はこの compose を読み、1アプリ・1アドレスとして提案する（DBサービスは含めない）。
Dockerfile は `infra/video/Dockerfile`。最終ステージ `cloud` が `ENTRYPOINT ["node"]` なので、
パーツごとの start command（`/app/api.mjs` / `/app/export-worker.mjs`）だけで役割が決まる。
Docker の `--target` に依存しない。
Dockerfile は既定フロントエンドのみを使い、`# syntax` ディレクティブと BuildKit secret mount を含めない
（Blitzの初回ビルドは外部フロントエンドの解決直後に `exit code: 1` で停止し、コンテキスト読込まで進まなかった）。

- ウィザードが「We write a recipe for it」と言っても、compose と Dockerfile が読まれれば
  recipe は使われない。もしパーツが提案されない場合は、Dockerfile を明示選択し、
  パーツ設定で start command を入れる。
- API は 8080 で待ち受ける（`PORT` を読む）。API のパスは `/` にする（フロントは Pages 側）。
  Worker はポートを持たないので自動的にバックグラウンド扱いになる。

### 3. 既存DB `axfluxo-db` へ接続

Blitz は **1アプリにつき1DB** で、DBを2つのアプリで共有する構成は想定されていない。
そのため API と Worker は「同じアプリの2パーツ」にして、そのアプリに `axfluxo-db` を接続する。

1. デプロイ後（または Databases ページから）`axfluxo-db` のカードを開き、**Connect to app** で
   このアプリを選ぶ。アプリ側の「Give it a database」からでも同じ。
2. 接続すると全パーツに `DATABASE_URL` が注入される。ホスト名はアカウント内でのみ解決される。
3. DB は内部専用で、手元の `psql` からは接続できない。そのため migration はアプリ内で実行する。
4. `axfluxo-db` が既に別アプリに接続済みの場合、そのアプリを消して DB を残すか、
   そのアプリをこのデプロイ先として使う（新規アプリには付け替えられない）。

「Database: Not needed」という判定は無視してよい。判定は検出器の結果で、実際の接続は
Databases ページから行う。

### 4. migration とロール

`008` と `009` は起動時に自動実行されない。Blitz CLI（AIツールページでAPIキーを発行）で
アプリ内のランナーを1回実行する。

```
blitz run <app> -- node /app/migrate.mjs
```

- `001`〜`009` を順に適用し、`public.axfluxo_schema_migrations` に記録する（再実行はskip）。
- 最後に `axfluxo_video_api` / `axfluxo_export_api` / `axfluxo_export_worker` を
  接続ログインへ GRANT する（Blitz は API と Worker に同じ `DATABASE_URL` を渡すため）。
- ロール作成には `CREATEROLE` 権限が必要。ランナーは権限が無い場合に警告を出す。
  拒否された場合は Blitz のサポートに DB ログインの権限を確認する（未検証）。
- `blitz run` は60秒・64KBまで。空のDBでは十分速い。

### 5. 環境変数

Environment タブで設定する（変更は再起動後に反映）。

| 変数 | 値 |
| --- | --- |
| `VIDEO_JWT_ISSUER` | Supabase の issuer URL |
| `VIDEO_JWT_AUDIENCE` | Supabase の audience |
| `VIDEO_ALLOWED_ORIGINS` | 編集画面のorigin（例 `https://<user>.github.io`、パスは含めない） |
| `EXPORT_ENABLED` | `true`（compose で設定済み） |
| `VIDEO_API_HOST` | 既定 `0.0.0.0` のままでよい |

`DATABASE_URL` は接続時に Blitz が設定するので入力しない。`VIDEO_DATABASE_TLS` は未設定
（=disable）のまま。

### 6. 確認

1. 未認証で `/v1/cloud-export/session` が **401** を返すことを確認（APIに `/health` は無い。401がプロセス生存の確認になる）。続いて認証付きで 200 と `enabled: true` を確認。
   起動に失敗した場合は `API startup failed at <段階>: <設定名>` の1行が追加される（値は出ない）。段階は config / storage / jwt / database / export / router / http / listen。
2. Worker のログに起動行が出ることを確認（秘密値は出ない）。
3. 5秒の素材でジョブ作成 → Worker が処理 → 再訪で状態取得 → チケット保存。
4. 1920×1080/60fps/音声ありを確認し、記録する。

初回は5–10秒。無料枠のメモリで1080p60が収まる保証はなく、OOM時は `EXPORT_OUT_OF_MEMORY` で失敗する（未検証）。

## 検証（Freebuff環境, 2026-11-11）

- `npm run lint` / `npx tsc --noEmit` / `npx next build`: 成功。
- `npx vitest run`: **52ファイル / 423テスト成功**（今回 +12: SHA-256 3、TLS 5、容量/削除/チケット/保持 4）。
- 実FFmpeg E2E: 1920×1080/60fps/120フレーム/AAC、既存 `validateVideo` 通過、Range 206。
- 新規API試験: 容量超過の拒否、終了ジョブ削除（実行中409→取消後200→以後404）、単発チケット（1回目200・2回目404・attachment）、保持掃除（24hでは0件、3h前+1h設定で削除）。
- サーバーバンドル `api.mjs` / `export-worker.mjs` 生成成功。

### 未検証

- Blitz実機（DB接続、TLS不要の実挙動、Parts、無料枠メモリでの1080p60、Worker休止→再開、1GB上限）。
- iPhone実機Safari（24MiB送信、ストリーミングSHAの速度、チケット保存、写真アプリ保存、再訪復帰）。
- Dockerイメージのビルド（この環境にDockerデーモン権限なし）、PostgreSQL 17実サーバー（PGliteのみ）。
- WebKit自動試験、UIの目視確認。

## ロールバック

- `EXPORT_ENABLED=false` で新規受付を停止（既存ジョブの取得・取消・出力取得は維持）。
- Workerを停止してもジョブはDBに残り、再起動で再開する。
- 既存の端末内書き出し・R2経路・migration 001–007 は未変更。
- `axfluxo_export` の削除は管理者が明示的に行う（自動作成・自動削除はしない）。
