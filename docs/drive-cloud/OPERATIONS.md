# Drive Cloud Phase 2〜6: 構成・手動運用

この文書は設定手順であり、操作済みという意味ではない。Push/PR/merge/Actions/Pages/Blitz設定・restart・deploy/本番DB/実Drive操作/課金は今回の許可範囲外。本番Cloudは既定OFF。

## 既存との関係

Supabase Auth、developer membership、RLSを正本とし、Google OAuthは追加のストレージ権限だけに使う。PR #30のstate/PKCE/Cookie/AES-GCM/フォルダIDを再利用。011適用後は診断APIもAPI/Worker共通のrefresh leaseを使い、Google通信はSQL transactionの外で行う。010だけの環境では従来経路を維持する。

新しいjob engineは作らない。元データ検証・プレビュー・render・削除・通知は既存の直列runtimeで実行。renderは既存slot/lease/fencing/compute budget/pins/outbox/renderer/publicationを使う。Drive用のupload sessionはS3 MultipartStorageへ変換しない。render/previewが必要とする読取・保存の狭い型だけを分離し、R2 adapterのコードとmultipart契約は維持する。

`01_Queue` は元データと中間生成物、`02_Completed` は完成MP4。appProperties・file ID・親ID・owner・account・size・SHA-256・remote version/revisionを台帳で管理する。Googleの一覧検索による既存ファイル採用、移動、共有、trash/deleteは行わない。folderはIDと親子関係を毎回確認し、改名は許容、子folderの移動・削除・属性変更は復旧要求。ルート自体の移動は許容。

## 状態と安全性

1. 本人JWT付きPOSTで容量予約と既知のDrive IDを確保する。resumable session URLはowner/object用途に結合して暗号化し、ブラウザへ返さない。
2. SafariはFile全体をBlob/ArrayBufferに展開せず、全体SHA-256をstream計算し、最大4 MiBを1つずつAPIへ送る。APIも最大4 MiBのchunkだけを保持する（ファイル全体ではない）。R2の従来partサイズは変えない。
3. Googleの308/Rangeとsession statusがoffsetの正本。応答喪失・session期限切れは既知のfile IDを照合し、再試行で別IDを増やさない。offset別のhash journalで違う内容の再送を409にする。
4. 全量受領は `verifying`。WorkerがAPIを呼ばず、自分のDB/暗号鍵/OAuth権限でDriveの特定revisionをstream取得し、サイズ/hash/メディアを検証してカタログへ登録して初めて `ready`。
5. 全素材・coverがreadyであること、immutable snapshot、compute budget、Driveピーク容量、DB、一時diskの条件を満たし、job transactionがcommitした場合だけ `workerReady:true`。この後だけ「Safariを閉じてもWorkerが処理できる」と表示する。Workerの無料稼働・sleep保証を意味しない。
6. 完成candidateは既存ffprobe/トラック/frame/size/hash検証を通し、Driveへ保存し、同じremote revisionの全体hashが一致してから既存fenced publishを実行する。API sleepを防ぐkeepaliveはしない。

アップロード中断は元ファイルを再選択して回復する。別DB `axfluxo-drive-transfers` にowner/hash/size/operation/object IDだけを保存し、offsetは必ずサーバーへ照会する。Google token、resumable URL、秘密値、原本bodyは保存しない。開始応答の喪失に備えoperation keyも開始前に保存する。

詳細版All Versions/FNFには既存project/sessionの編集値をそのまま投影するDrive受付を追加。トリム・Version・cover・fade・reference layout・1440p選択・FNF crop/scale/username/rangesを黙って置き換えない。LocalVideoToolの両モードにも追加。素材LibraryにはDrive転送を追加し、既存プレビュー生成Workerでproxy/thumbnail/waveformを実生成する。R2の既存素材・機能は残す。

held→resumeは同じjob ID、pins、予約、checkpointを継承。retryは新job IDとretry_ofで記録し、Driveでは累積実行回数も3回まで。slot→job→execution→budget/refsの順を守り、APIのslot lockにはtokenを更新できない固定SQLのlock-only関数だけを与える。旧workerのpublishは既存DB fenceが拒否する。Drive専用profileを受け付け時にDBへ固定し、worker側と違えばheldにする。

## 出力profileとリソース

Drive専用 `drive-cfr60-crf18-lookahead8-v1` はthreads/filter threads=1、H.264 CRF18、先読み8/sync先読み0、原則5秒segment。旧profileの既定は変更しない。All Versions 1920×1080、FNF 1080×1920、CFR60、yuv420p、既存AAC 48kHz stereo設定を維持する。圧縮判断は旧profileとbit一致を約束しない。profile IDをplan hashとvalidationへ含める。

512MiB / 0.5 CPUの隔離短尺試験では非rootのAPI/worker target（Node heap `--max-old-space-size=128`）と同じruntimeを使用した。Blitzの既定cloud targetは既存互換のためheap512のままなので、512MiB運用では別承認の設定作業でAPI/worker用のheap128を明示し、FFmpegを含むcgroup全体を実測する。短尺FNFは厳密512MiB上限近傍まで使ったため、長尺運用可とは判定していない。既存local/R2のheapやprofileを一括変更しない。

1440p Cloudは既定OFF。短い1440p診断の成功は長尺での提供可否の根拠にしない。360p30等へ自動で落とさない。

Driveの保存容量と一時diskは別。1.7GB素材を1GiBの作業diskで処理可能とは扱わない。原本、全segment、join、candidate、完成物、音声中間物、余白を保守的に見積もり、受入時とworkerの実free/directoryサイズで止める。元データ検証とpreviewにもdisk gateがある。メモリ/ENOSPC/lease/DB障害は既存エラー分類でheld等になり、原本・remote checkpoint・完成物は消さない。

## 容量と利用表示

- configured Drive cap: `used + reserved + new + margin <= limit`。Google aboutの全使用量から得たfreeに対しても未使用予約と余白を確認。他用途・trash・旧版を無料枠から除外したと仮定しない。
- render受付時は出力ピークを予約。各実オブジェクトへ予約を移し、公開/失敗/取消のterminal時に未使用ピークのみを解放。保持中の実ファイルは課金台帳から消さない。heldは予約を継承。
- DBは設定capと `pg_database_size(current_database())`、16 MiB余白を確認。これはWAL/OS/サービス固有quotaを完全に測る保証ではない。G2で実容量との対応を別途確認する。
- 表示する月間指標はDrive Cloudのexport実size（fenced成功したoutput IDごと1回）、転送（再送・検証readを含む）、Drive API操作（OAuth token通信は別）、保存容量、予約、未確認物。集計月はAsia/Tokyo。容量のused/reservedは月初にリセットしない。
- 送信失敗時のupload量は送信試行量であり、プロバイダの請求明細ではない。料金見積は実請求の保証・自動の課金上限ではない。

## ダウンロード・保存・削除

本人が発行した10分のfile-specific ticketを使い、GET/HEAD、単一Range/If-Range、206/416、backpressureで配信する。Googleの公開共有URLや巨大Blob経由は使わない。DBのticket参照と台帳保持がdownload中の参照になる。期限切れ時は新ticketを発行し、再encodeしない。元素材・previewの読取ticketも同じ非公開方式。

iPhoneのFilesでMP4を開き、再生できたことを本人が確認してから、対象output ID/version/hashについて保存先 `files` を明示する。`photos` は別記録であり自動入力しない。HTTP成功やlink発行だけでは保存確認にしない。

Driveの削除API・自動GCは実装していない。未確認/確認済み双方の完成物、原本、checkpointを保持し、容量が尽きたら受付停止。既存R2削除workerもdrive-v1を拒否する。旧temporary-DB export workerの期限切れ自動purgeも既定OFFへ変更した。既存の明示削除APIは消していないが、本番削除の検証は別承認が必要。

## 必要な設定（秘密値を記載しない）

Phase 1: `GOOGLE_DRIVE_ENABLED`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_TOKEN_KEY`, `GOOGLE_DRIVE_PUBLIC_ORIGIN`, `GOOGLE_DRIVE_FRONTEND_URL`。正確なcallbackは `https://axsis.prod.page/api/integrations/google-drive/callback`。scopeはdrive.file。Supabase用設定は既存を維持。

Phase 2〜6:

| 名前                                                                          | 既定・用途                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| NEXT_PUBLIC_DRIVE_CLOUD_UI                                                    | false。静的buildに対するUI flag                                               |
| DRIVE_CLOUD_ENABLED                                                           | false。API/統合workerの受付flag                                               |
| DRIVE_CLOUD_TERMS_CONFIRMED                                                   | false。年齢・地域・無料資格・請求条件等の確認後だけ                           |
| DRIVE_CLOUD_MONTHLY_YEN                                                       | 501（不明なのでOFF）。全サービス合計・税込の固定見積。0〜500確認時のみ        |
| DRIVE_CLOUD_DB_LIMIT_BYTES                                                    | 0（不明なので本番OFF）。実際のDB capを確認後だけ                              |
| DRIVE_CLOUD_LIMIT_BYTES                                                       | 10737418240。追加の保守的なDrive上限であり契約容量ではない                    |
| DRIVE_CLOUD_MARGIN_BYTES                                                      | 268435456                                                                     |
| DRIVE_CLOUD_MAX_FILE_BYTES                                                    | 2147483648。受付上限であり1.7GB実機成功の宣言ではない                         |
| DRIVE_CLOUD_1440_VERIFIED                                                     | false                                                                         |
| VIDEO_DATABASE_TLS / VIDEO_DATABASE_CA                                        | 本番Driveはverify-fullとCAを必須とする。TLSなし/証明書未検証ならOFF           |
| VIDEO_WORKER_ENABLED / VIDEO_RENDER_ENABLED                                   | 統合workerを使う場合のみ明示有効化。旧export-workerとの重処理二重起動をしない |
| VIDEO_RENDER_DISK / VIDEO_RENDER_MAX_WORK_BYTES / VIDEO_RENDER_MIN_FREE_BYTES | 実際の一時領域に合わせて評価する。既存既定を無断変更しない                    |
| VIDEO_UNITS_PER_FRAME / CLOUD_PREVIEW_UNITS_PER_SECOND                        | 既存compute budgetの単位設定。円換算の保証ではない                            |
| EXPORT_RETENTION_PURGE_ENABLED / EXPORT_RETENTION_DELETION_APPROVED           | 双方false。別承認まで自動purgeしない                                          |

APIと独立workerの双方がGoogle refreshを行うため、Drive Cloudを使うworkerにもclient ID/secret/暗号鍵が必要。Blitzの非公開環境変数に直接設定する。ブラウザ/NEXT_PUBLIC/チャット/GitHubへ秘密値を渡さない。workerはSupabase access tokenを必要としない。既存DB login/role/issuer/audience/CORSを維持し、証明書/ロール制約を緩めない。

現在のBlitzがTLS付きDB、必要なrole/RLS、無料worker、容量・年齢・日本地域・請求条件を提供できるかは未検証。もし既存内部DBにTLSがなければ、本指示の条件ではDrive Cloudを有効化できない。TLSを無効にして回避しない。

## Migrationとロールバック（手順だけ）

1. ローカル差分、既存PR #30とmainの関係、migration台帳をレビューする。現在のDBの適用済み番号を確認する。
2. 別承認のリリース作業で、バックアップと非本番検証を先に行う。今回の追加原稿は `011_drive_cloud.sql`。前提001〜010を上書きしない。
3. 管理者は固定SQLのlock-only関数、列GRANT、API/probe/renderのFORCE RLS、匿名/browser roleの権限なしを確認してから手動適用する。起動時自動適用なし。
4. 既存migrate.mjsは未適用の全migrationを対象にする。台帳が正しい場合に限り、別承認後に使用する。今回そのコマンドは本番で実行していない。
5. 新機能を止めるには `NEXT_PUBLIC_DRIVE_CLOUD_UI=false` の静的buildと `DRIVE_CLOUD_ENABLED=false`。workerを安全停止して既存R2運用を維持する。新jobはheld/予約保持となり、Driveファイル・DB/IDB・作品は消さない。
6. 古いbinaryへ戻す前に新Drive jobを停止/保留し、移行前のworkerにDrive jobを処理させない。down migration、DB/Drive削除、IDB初期化をrollbackに使わない。

## iPhoneでの別承認後の小容量確認

まだ未デプロイなので、現在の公開画面に新ボタンがあるとは案内しない。

1. Safariでレビュー結果を確認。G0で16歳・日本地域・無料継続・カード/自動課金なし・税込500円総額を確認する。Google Oneは検討中で、購入しない。無料Driveの空き容量で小容量から試す。
2. Google Cloud Console → プロジェクトaxfluxo → Google Auth Platform → Audience/テストユーザーと、Web clientの既存callback完全一致を確認。変更や追加は別承認後だけ。
3. Blitz → AxFluxo → API/worker partの設定画面を確認。保存がrestart/deployを起動するか確認し、承認前は保存しない。秘密値は非公開欄へ直接入力する。DB TLS/role/free quotaが不明なら有効化しない。
4. 管理担当者が承認済みmigrationとreleaseを実施する。iPhoneの画面だけでSQL/CLIが使えなければ管理環境で実施する。今の作業では未実施。
5. AxFluxoへ既存Supabaseログイン → `/developer/video/` → 開発者権限確認 → Google Drive接続 → ブラウザ確認後もう一度接続 → 同じSafariでGoogleを許可。
6. DriveアプリでAxFluxo/01_Queue/02_Completedを確認し、再接続で増えないことを確認する。既存ユーザーファイルは操作しない。
7. 小さな合成MP4とcoverをLocalVideoToolで選び、既存プレビュー・トリム・名前を編集。Cloud利用条件を確認 → 素材送信 → Worker検証確認 → ジョブ送信。送信中はSafariを閉じない。
8. 「サーバー受領済み」後だけSafariを閉じる試験を行い、戻って「最近のCloudジョブ」「ジョブ状態」を確認。APIをkeepaliveする操作はしない。
9. 完成後、保存リンクを発行 → MP4をFilesへ保存 → Filesアプリで対象MP4を開き再生確認 → AxFluxoの本人確認checkbox → 保存確認を記録。Driveファイルはそのまま保持。
10. 詳細版All Versions/FNFを使う場合は素材LibraryのDrive転送・実preview生成後に選択する。reference layout、fade、crop等を維持してDrive Cloudへ送信する。1440pは検証ゲートを越えるまでOFF。
11. 小容量成功後に限り、G2/G3/G4の別承認を得て中容量、通信断、再選択、1.7GB、長尺1080p60の順へ進む。失敗したら負荷を上げない。削除試験G5はさらに別承認。

実OAuth、Testingの通常7日程度のrefresh期限、実Blitz、iPhone Safari/ITP、長尺・1.7GB実送信/Files保存は未検証。WebKitダウンロードはこの環境で403となる。省メモリcontainer成功はBlitzの実測ではない。
