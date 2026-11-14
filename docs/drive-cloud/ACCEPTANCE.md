# Phase 2〜6 検証・5パス監査

提出判定: **部分完了**。Phase 2〜6のコードと実行できた隔離試験は完了。WebKit試験は環境不足で起動失敗、実サービス/実機で利用可能かは**未検証**。本番利用・長尺処理・月額500円達成を完了条件として保証しない。

## 対象と作業境界

- 開始時main: `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。
- 開始時作業HEAD: `7a5417ce98f4ce443a8bf470201f384a1d2a1a4e`。作業treeはclean。
- ローカルbranch: `codex/drive-phases2-6`。
- mainのローカル統合: `1efb08f`。PR #28のreference layout/timer/fadeとPR #29を取り込み、#27は統合していない。
- コードcheckpoint: `d67038e505232cec8fd9bf09fd1a07bf1a7f37b4`。41ファイル、4857追加/51削除（開始後main統合分は別）。
- #26/#28/#29はmerged、#27/#30はopen Draftと読み取りで確認。#30の成果を基盤として再利用。
- mainとの全差分は100ファイル、14634追加/87削除。この数には開始点に既にあった未マージのfreebuff/cloud-export/Phase 1が含まれ、全部を今回の新規実装と数えない。
- GitHub mainのcombined status/workflow読取は空だったため、今回CI成功とは断定していない。Actionsは起動していない。

Google/Blitz/本番DB/実Drive/課金操作なし。GitHubはread-onlyで、今回のPush/PR/mergeなし。公開イメージの取得と隔離Dockerのみ実施。native DBはこの作業専用のloopback PostgreSQL 17で、本番ではない。

## 要件との対応（Codeは実装、Testは隔離証拠）

| 要件                            | 主な成果物                                                            | 証拠と限界                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P2.1 provider独立・既存互換     | drive-cloud/transfer.ts, storage.ts, preview.ts / render ObjectReader | Drive-native ID/session/offset、S3 part/ETagへ変換なし。R2 adapter自体は無変更                                               |
| P2.2 OAuth・owner・refresh race | 既存google-drive + drive-cloud/credentials.ts                         | 旧17テスト、共通refresh lease、別owner/RLS、失効。実OAuth未実施                                                              |
| P2.3 設定・scope                | .env.example, OPERATIONS.md                                           | drive.file、既存callback、秘密値なし。Google Cloud設定変更なし                                                               |
| P2.4 folder冪等                 | 既存bootstrap + ensureFolder                                          | 予約済ID100同時create（mock adapter）で1folder、改名/再接続/移動/削除の旧テスト。100件すべての実Google OAuth成功を意味しない |
| P2.5 台帳・権限                 | 011_drive_cloud.sql                                                   | owner/account/file/parent/job/hash/size/namespace/version/revision、追加migration、FORCE RLS/FK/列GRANT、native PG適用成功   |
| P2.6 容量                       | drive_capacity, drive_job_capacity                                    | Google全使用量free、configured cap、reserved peak、DB cap/16MiB余白、disk。100同時受付は安全な202/503となり過剰予約なし      |
| P2.7 メトリクス                 | drive_usage, export trigger, /usage                                   | Drive Cloudの成功output IDごと1回。転送・API・未確認物を分離、月跨ぎでused/reservedを消さない                                |
| P2.8 reconciler                 | DriveCloud.reconcile                                                  | 既知ID/session照会、最終応答喪失/404再開。同名全検索・自動削除・未知の孤立物探索なし                                         |
| P3.1 統合worker                 | runtime/tasks.ts                                                      | 既存runWorkerのawait dispatch。Drive検証/previewも同じ直列loop。旧個別入口を維持                                             |
| P3.2 state/workerReady          | inventory + /batches                                                  | 上传完了≠検証完了≠受付済み。workerが直接read/hash/probe後にcatalogへ登録し、snapshot/予約commit後だけworkerReady             |
| P3.3 resume/retry               | api/jobs.ts, Drive job routes                                         | heldは同じID/予約/pins。retryは新ID/retry_of、累積実行3回まで                                                                |
| P3.4 checkpoint                 | 既存render service/objects                                            | 同job/owner/plan/hash/ready/encoder/profile。跨job再利用は行わず安全再実行。旧job ownerを書き換えない                        |
| P3.5 race/fence                 | 既存slot/job/execution + lock-only function                           | native共通renderテストにSIGKILL/lease/stale worker、Driveのresume/replay/quotaテスト                                         |
| P3.6 shutdown                   | 既存runtime + signal付きtransfer/writer                               | finite HTTP/idle、SIGTERM/child kill、pool close。disabled worker Docker停止も確認                                           |
| P3.7 保全                       | inventory/refs/tickets、no delete provider                            | 元素材・未確認/確認済output・checkpointを保持。旧DB exportの自動purgeも既定OFF                                               |
| P4.1 resumable                  | DriveTransfer.session                                                 | 4MiB、256KiB倍数、308/Range、既知IDとoffset、期限切れ。実Google通信未実施                                                    |
| P4.2 API転送                    | HTTP bridge + bytes client                                            | browserへGoogle token/session URLを配らず、APIの4MiB上限経由。直接Drive CORS成功を仮定しない                                 |
| P4.3 大容量・再選択             | drive-upload.ts / 別IDB                                               | 全体/part SHA、memo先書き、owner/hash/size再照合、server offset正本。1.7GB合成stream/hashでメモリ記録                        |
| P4.4 冪等・異常                 | chunk journal、lease、tests                                           | 応答喪失、再送違い409、順序/非整列/過大body、失効、quota、別owner。実機回線変更は未検証                                      |
| P4.5 worker独立                 | verify→media catalogue→既存queue                                      | workerはGoogle/DBへ直接接続。API HTTP呼出しなしの統合試験                                                                    |
| P4.6 UI境界                     | DriveCloudPanel/MaterialUpload                                        | 送信中の警告、検証中、受付済みを分離。pollは明示操作、keepawakeなし                                                          |
| P4.7 原本保護                   | queue/completed namespace                                             | 完成は別ID。元ファイルを移動/削除しない                                                                                      |
| P5.1 renderer再利用             | 既存executeRender/project/fnf/assemble                                | PR #28維持、旧layout/profilesも保持。#27未統合                                                                               |
| P5.2 品質                       | Drive専用resource profile                                             | 1920×1080/1080×1920、CFR60、H.264 yuv420p、既存AAC。1440pは別ゲート、暗黙の低解像度化なし                                    |
| P5.3 低資源                     | resources.ts、5秒segment                                              | 旧出力既定は不変。新profileのlookahead制限とthreads=1。FNFの実OOMを検出して修正し再試験                                      |
| P5.4 snapshot                   | drive-snapshot.ts / prepared editor projection                        | File/URL/Canvas/関数なし。names/trims/markers/design/FNF prefsを固定しbody hashで受付冪等                                    |
| P5.5 disk                       | admission/verify/preview/render guards                                | 1.7GB入力を1GiBで処理可能としない。推定に加え実freeとruntime ENOSPC/dir-sizeで停止                                           |
| P5.6 publish                    | storeObject + revision read + 既存publish                             | 実remote bytesをsize/hash確認してからfenced publish。export ledgerは同transaction                                            |
| P5.7 中断/計測                  | errors、cgroup、runtime                                               | OOM/ENOSPC/DB/lease分類、abort/子process回収。RAM/CPUの短尺container記録あり                                                 |
| P5.8 見た目                     | 既存reference golden tests                                            | 本物のfont/FFmpeg/60fps timer/fade試験を維持。205.67秒参考との完全一致・長尺本番成功は未宣言                                 |
| P6.1 Local/Cloud                | feature flag / public-config                                          | 未設定のstandalone browserでも安全OFF。既存Local書出し・復旧を維持                                                           |
| P6.2 実編集との接続             | LocalVideoTool、AllVersionsEditor、FnfShowcaseEditor                  | 両モード、詳細designとFNF入力を既存schemaへ投影。素材LibraryのDrive→実previewも接続                                          |
| P6.3 状態と対処                 | DriveCloudPanel/MaterialUpload                                        | 接続/送信/検証/受領/queue/処理/held/完成/保存を分離。再開/新試行/取消/再接続導線                                             |
| P6.4 閉じてよい条件             | workerReady receipt                                                   | 保存・hash・worker access・snapshot/queue commit後だけ。アップロード背景継続を約束しない                                     |
| P6.5 private download           | output/media tickets / serveInventory                                 | GET/HEAD、Range/If-Range、206/416、CORS、revision指定、backpressure。公開Driveリンクなし                                     |
| P6.6 保存確認                   | drive_saved                                                           | output/version/hash一致、opened=trueの本人操作、Files/Photos別。HTTP成功だけでは保存済みにしない                             |
| P6.7 削除                       | flags / no Drive delete                                               | default OFF、確認後も自動削除なし。R2 eraserはdrive-v1を処理しない                                                           |
| P6.8 利用表示                   | /usage、UsageView                                                     | Drive export/転送/API/保存/予約/未確認を区別。料金保証表示なし                                                               |
| P6.9 iPhone/basePath            | mobile Chrome + static E2E                                            | portrait/既存landscape/touch、basePath手順。実iPhone/1.7GB/Files保存は未検証                                                 |
| P6.10 保存互換/rollback         | 既存IDBは無変更、追加memo DB                                          | 既存作品初期化なし、同じflagで新UI/APIを停止。DB/Drive削除をrollbackにしない                                                 |

## 修正した問題

| 検出                                          | 原因・影響                                    | 修正と再確認                                                                                                   |
| --------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 新flagのないbrowser fixtureで画面が起動しない | standalone browserのprocess未定義             | 安全なpublic config reader。期待値を変えずrecovery/queue/trim 15件成功。全browser再実行を別記                  |
| FNF 512MiB container OOM                      | H.264先読み等のbuffer                         | 新Drive専用lookahead8 profile。旧profile不変。1080×1920/60fpsの再試験成功                                      |
| native PGのoffset検証                         | bigintは文字列、embeddedでは数値              | Numberへの表現正規化。0という意味の期待は不変。native再実行成功                                                |
| Drive素材が従来S3 preview/accessへ流れる      | 旧R2専用capability                            | 既存preview workerの狭い読取/保存型を分離し、実生成物をDriveへ保存。private ticketと実waveform/Rangeの統合試験 |
| Phase 1診断と新workerのrefresh競合            | 旧accessのrow-lock内refreshと新leaseの二系統  | 011適用時は同じcredential managerへ統一。010のみの互換を維持。race試験                                         |
| preview再開権限・lease                        | API列GRANT不足 / pending headだけでskipの危険 | owner RLS下の必要列のみ追加、未検証物はhead成功扱いしない。readyはremote hash確認後                            |
| 旧DB exportの期限切れpurge                    | 未確認物を消し得る既存自動処理                | purgeは二つの明示flagを要求し既定OFF。Drive削除経路は追加していない                                            |
| Docker build                                  | HOME下buildxがread-only、npm TLS検査CA        | task内BUILDX_CONFIGとbuild-secret CA。TLS検証は無効化せず再build成功                                           |
| root E2E初回                                  | 認証用公開設定がないbuild                     | ダミーpublishable設定で再build。Supabase HTTPは既存テストがmockし実アカウント操作なし                          |
| browser/root同時runのtrace破損                | root runnerが共通test-resultsを掃除           | 出力先をwork配下へ分離して再実行。コード/期待値は緩めない                                                      |

## 5パス監査

| Pass                   | 確認                                                                                      | 判定・残リスク                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A 仕様・範囲           | 上の各項目、main/PR差分、Phase 1再利用、2folder、予算/品質/phone                          | PASS（コード範囲）。実環境の利用資格/長尺/実機の全面完了とは分ける                                    |
| B security・保全       | JWT/membership/owner/RLS、state/PKCE、token/URL暗号化、TLS gate、SSRF、revision、削除拒否 | PASS（隔離範囲）。静的bundleにserver秘密変数/DB URLなし。実provider/proxy log設定は未検証             |
| C 耐障害・同時実行     | response loss/expiry/parts、100受付、native lease/SIGKILL/fence、resume、quota、month     | PASS（mock/native範囲）。実Drive中断とBlitz worker kill/sleepはG1〜G3で別検証                         |
| D 動画・回帰           | 本物font/FFmpeg、両動画、PR #28、Local/R2/IDB/Studio/Workflow、root/basePath              | 部分合格。Chrome/実FFmpegはPASS。WebKitは環境FAIL、root/basePath計248件PASS。参考長尺完全一致は未検証 |
| E deploy・費用・再現性 | commit/tree、Docker/vars/role/rollback、500円/G0、外部操作なし                            | 保留（実環境・費用）。ローカル再現・外部操作制限はPASS。実月額/契約が未確認のため本番受付OFF          |

## コマンド証拠

最終結果とexit statusは作業コピーの `work/phase26/` に保持する。秘密の実値や実アカウントを使わず、mock/native/local/browser/containerを区別する。全自動テストの成功も実サービスを保証しない。

- `npm test`: 57 files / 472 tests 成功。
- native PostgreSQL 17: Drive 21件、共通render 25件成功。後者は実SIGKILL claimant/fencingを含む。
- `npm run typecheck` / `npm run lint` / `npm run build`: 成功。
- serverのbuild/build:*全9 script: 成功。
- 新Drive UIのmobile幅Chrome 2件: 成功。再読込後のmemoから同じ素材を再選択し、追加uploadを作らないことを確認。
- recovery/queue/trim重点Chrome 15件: 修正後成功。
- 全Chrome video suite: 48件成功。root static E2E: desktop/mobile計124件成功。basePath `/axfluxo/` も124件成功。
- WebKit: 今回Drive関連4件を起動したが実行ファイルなしで4 FAIL（ブラウザ起動前）。取得も403 Domain forbiddenのため動作未検証。成功/skipとは扱わない。
- 合成1.7GB software/native SHA-256: 一致、64KiB buffer、RSS peak 68,468,736 bytes、43.48秒。この値はNode試験でありiPhone性能ではない。
- Docker: 通常buildは検査proxy CAで失敗、secret-mounted CAでAPI image成功。短尺AV/FNFの512MiB/.5CPU、network none試験あり。実Blitzではない。

## 外部ゲートと完了の区分

G0（年齢/日本地域/無料継続/総額/カード・自動請求なし）、G1（実OAuthとDrive）、G2（Blitz TLS/role/worker/disk/sleep）、G3（iPhone/回線断/1.7GB/Files）、G4（長尺1080p60と1440p）、G5（明示削除）は未実施。

Google One 200GBは未契約の検討項目。月440円等の過去値を現行料金と断定しない。500円を満たす根拠はまだない。必要なTLS/DB cap/費用の条件が不明なら新Cloud受付はOFFのままにする。

本報告で言えるのはコードと記載した隔離試験の範囲まで。実サービス/実機利用可能性は未検証。Push/PR作成を含む外部変更は新しい明示承認なしに実施しない。

## 再現コマンドと追加の証拠

| コマンド・条件                                                                         | 最終結果       | 環境・注意                                                                                                                |
| -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                             | PASS 472       | Node 24、embedded PG、Drive/OAuth HTTP mock                                                                               |
| `npm run typecheck` / `npm run lint` / `npm run build`                                 | PASS           | dummy公開Auth設定あり・なし両build。秘密値不要                                                                            |
| `npx vitest run server/tests/drive-cloud.test.ts` + `AXFLUXO_TEST_POSTGRES_URL`        | PASS 21        | loopback隔離PostgreSQL17、テスト専用DB。Googleのみmock                                                                    |
| `npx vitest run server/tests/render/render.test.ts` + 同環境変数                       | PASS 25        | 同じ隔離PGの別DB、実process SIGKILL                                                                                       |
| server `build` / `build:*`                                                             | PASS 全9       | 既存Docker用各entry                                                                                                       |
| `npm run test:video:browser -- --project chromium --output work/phase26/browser-clean` | PASS 48        | Chrome、実メディア・フォント、mock API                                                                                    |
| `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3300/ npm run test:e2e`                          | PASS 124       | desktop/mobile、Supabase HTTP mock                                                                                        |
| `npm run test:video:browser -- --project webkit --grep Drive`                          | FAIL 4         | ブラウザ未導入。WebKit/Safari動作を確認できず                                                                             |
| `npx tsx scripts/check-drive-stream.ts`                                                | PASS           | 1.7GB合成入力、実送信なし                                                                                                 |
| Docker build (`work/phase26/Dockerfile.ca`、CA secret mount)                           | PASS           | d67038e source、image `sha256:fa2c54e5a746cd3237312851c0cc2a89622dbe60ddceeee240185026f7e5f174`                           |
| Docker FNF `.5 CPU / 512MiB / memory-swap=512MiB / network=none`                       | PASS 短尺2出力 | 非root、1080×1920 CFR60、memory peak 536,870,912 bytes。上限近傍であり長尺成功や余裕は未証明                              |
| Docker AV `.5 CPU / 512MiB / network=none`                                             | PASS 短尺2出力 | 1080p60と1440p60診断のみ。1440flag OFFを維持                                                                              |
| Docker API unauthorized / disabled worker stop                                         | PASS           | 非root UID1000、401 AUTH_REQUIRED、SIGTERM exit0/OOM=false。初回API fetchは起動前で接続拒否、起動待ちを入れた再実行で成功 |
| API role `pg_database_size(current_database())`                                        | PASS           | 隔離native PG。実DB capとの対応はG2で未検証                                                                               |

Dockerの最初の10秒停止試験では起動前のfetch失敗と強制停止137があった。起動確認後の再実行ではAPI/disabled workerとも30秒以内にexit0で終了した。この試験はrender実行中のBlitz SIGTERM保証ではない。proxy CA secretはruntimeの `/run/secrets/proxy_ca` に残っていないことも確認した。

## 今回コードcheckpointの変更ファイル

main統合と開始時既存コードを除く41ファイル。加えて、この検証書を文書専用commitで追加する。

```text
.env.example
docs/drive-cloud/OPERATIONS.md
scripts/check-drive-stream.ts
server/README.md
server/api/assets/preview.ts
server/api/jobs.ts
server/api/main.ts
server/api/outputs/router.ts
server/cloud-export/worker.ts
server/db/migrations/011_drive_cloud.sql
server/drive-cloud/config.ts
server/drive-cloud/credentials.ts
server/drive-cloud/preview.ts
server/drive-cloud/resources.ts
server/drive-cloud/router.ts
server/drive-cloud/service.ts
server/drive-cloud/storage.ts
server/drive-cloud/transfer.ts
server/google-drive/router.ts
server/tests/browser/drive-cloud-fixture.tsx
server/tests/browser/drive-cloud.spec.ts
server/tests/drive-cloud.test.ts
server/worker/derivatives/generate.ts
server/worker/derivatives/service.ts
server/worker/jobs/errors.ts
server/worker/render/objects.ts
server/worker/render/process.ts
server/worker/render/service.ts
server/worker/runtime/tasks.ts
src/domain/drive-cloud/schema.ts
src/features/all-versions/AllVersionsEditor.tsx
src/features/developer/CloudExportPanel.tsx
src/features/developer/CloudLibrary.tsx
src/features/developer/DriveCloudPanel.tsx
src/features/developer/DriveMaterialUpload.tsx
src/features/developer/LocalVideoTool.tsx
src/features/fnf-showcase/FnfShowcaseEditor.tsx
src/services/video/api-client.ts
src/services/video/drive-snapshot.ts
src/services/video/drive-upload.ts
src/services/video/public-config.ts
```

初回の全Chrome動画試験は30 PASS / 18 FAILであり、新public flagのブラウザ互換問題を修正した後の全48 PASSで解消した。テスト期待値を成功するように緩めていない。以前のDocker FNF OOMも隠さず、Drive専用profileで修正したものを再試験した。512MiBに余裕がある、長尺も必ず動く、という結論にはしていない。

外部操作ログ: GitHub repository/PR/refsの読取、npmおよび公開Docker imageの取得、localhostだけの隔離DB/HTTP、network-none containerの実行。作業専用API/worker/PostgreSQL containerは検証後に削除。実ユーザーのDB/Drive/IDB/動画は削除していない。ローカルcommit以外の書込み、Push/新PR/merge/Actions/deploy/Blitz保存・再起動/GCP変更/課金は未実施。

最終basePath確認: `NEXT_PUBLIC_BASE_PATH=/axfluxo` とダミー公開Supabase fixture値で `npm run build` 成功。その成果物をlocalhost:3301で配信し、`PLAYWRIGHT_BASE_URL=http://127.0.0.1:3301/axfluxo/ npm run test:e2e -- --output work/phase26/e2e-base-artifacts` は **124 PASS (6.2m)**。rootの124と合わせ248件。Auth HTTPはmockで、実Supabaseアカウントは操作していない。今回の検証専用静的サーバーも終了した。

引継ぎ: 先にG0〜G4の各確認と外部変更の明示承認を得る。最初の再開点は本書とOPERATIONS.mdのレビューであり、本番フラグを即座にONにしない。ローカルコードcheckpoint d67038eは変更せず、この検証書と運用補足だけを最終文書commitに分離した。最終commit SHAは提出返信に記載する。
