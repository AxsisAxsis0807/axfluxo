# 二層クラウドストレージ Phase 1

2026-11-17。レビュー専用、実サービス未接続、本番未変更。
端末でexportし、Blompを原本/完成物、Drimeを途中物にする最新方針を優先する。
既存Blitz/FFmpeg workerを削除・有効化しない。全体ワークフローの完成ではない。

## 監査基準と競合

`origin/main` / 作業開始HEAD: `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。
最初のremote tracking refは古かったため実fetchで更新しmain一致を確認。
作業branch: `feat/blomp-storage-phase1`。祖先/checkout内にAGENTS.mdなし。

未マージPRは #8, #10, #11, #27, #30–35。取り込み/変更なし。
関連headを `git ls-remote` と実fetchで確認:

| PR  | branch / SHA                                                                        | 影響                                                             |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| #30 | codex/google-drive-phase1 / 7a5417ce98f4ce443a8bf470201f384a1d2a1a4e                | Google Driveはmainに未導入。API追加・OAuth/暗号化/所有者DBを監査 |
| #31 | codex/drive-phases2-6 / 55eed09579832a89f8ca73c605394b2c74c415c4                    | Drive job/復旧。将来参照モデルと容量管理の統合が必要             |
| #32 | chatgpt/drive-cloud-hardening-20261114 / b3dd40fbe87a2b541c29160a7452a398811f7d65   | token・transfer・capacity hardening                              |
| #33 | chatgpt/render-efficiency-audit-20261115 / 6759e30dcc4aea1d9edb230317406b48207d93a0 | render変更。今回触れない                                         |
| #34 | codex/unified-worker-v1 / 81d6c739a797e95386855ad1b78313a88e9b1077                  | runtime/tasks.ts変更。今回触れない                               |
| #35 | codex/unified-resource-audit-v2 / 498bf9d64f1329fbec6b04b6ce7679a0cd094049          | 積重ねPR。storage/authは差分なし、runtimeに差分あり              |
| #11 | codex/local-low-load-encoding / 8c39a54d3b051069aa09b95b8ce653eb4913c756            | 未マージ端末処理案。今回はmainの端末exportを維持                 |

`server/package.json` 以外は追加ファイルのみで既存PRとの直接競合を抑える。
package scriptsは将来merge時に両方残す。関連PRの設計を採用済みと扱わない。

## 既存コードの監査結果

指定されたstorage/config,r2,multipart,outputs、api/main,assets/router,uploads/service、
runtime/tasks、render配下、docs/video/v7.md・v7-verification.mdを確認。

- mainはNext静的export + 独立Node API。JWTはjoseでES256/RS256署名・issuer・audience・exp・iat・subを検証。
- api/app、assets/library、jobsはmembership/owner/RLSを再確認。uploadsはserver UUID key、quota予約、冪等キー、lease、完了後検証を持つ。
- uploads/serviceはpart ETag=MD5を前提とする。Blompにそのまま接続できない。ETagをSHAやMD5と解釈しない。
- R2 endpoint allowlist/region autoとoutputsの物理bucket分離、削除workerの専用資格情報/条件付きDELETEを維持。
- 旧原本参照にはprovider識別がない。設定をBlompに切り替える移行は実施しない。旧namespaceとDB行はそのままR2へ向ける。
- All Versions/FNFは共通local-encode/local-export-runtime/export-queueを利用し、recovery-storeに端末checkpointを保持。サーバーの別job/lease/checkpoint機構も残る。
- Safariの背景継続は保証しない。キュー/中断復旧/最終結合の変更なし。画像編集・Workflow・端末保存・既存認証UIに差分なし。
- CIはunit/型/lint/static build/動画browser/E2E。Pages deployはmain限定。今回workflow追加/dispatchなし。

## 実装と安全境界

`blomp-config.ts` はBLOMP_ENABLED未設定/falseでOFF。true以外の値を拒否。
endpointは文字列完全一致 `https://storage.blomp.com`、region `us-east-1`。
bucketはemail形式も許容するがURL・path・制御文字は拒否。秘密値なし/空白入りは停止。
例は `server/blomp.env.example` のダミーのみ。SDK default credential chainを使わない。

`blomp.ts` はAWS SDK v3 **既存3.1161.0** を利用。依存追加なし。
forcePathStyle=true、SigV4、region redirectなし、SDK retry1回、接続5秒/要求30秒。
自動checksumはWHEN_REQUIRED。Content-MD5/条件付きwriteを暗黙に送らない。
capabilitiesは個別にunverifiedを記録し、運用可と主張しない。

HEAD/Node stream GET/厳密なRange/Multipart開始・一覧・parts・完了・abort/60秒署名を独立提供。
StoredPart型を再利用するがMultipartStorageに偽装しない。MD5前提を満たすまで既存UploadServiceへ渡さない。
一覧paginationに上限を置く。失敗は固定codeのみでraw SDK message/causeを伝播しない。stream途中のエラーも安全化。

新参照はprovider、endpoint/region/bucketのSHA-256 location、server UUID keyを含む。
保存先変更時はlocation不一致で拒否。秘密鍵更新ではlocationを変更しない。
将来account/bucketを再利用する際も同じnamespaceを無断再割当てしない。
originals/outputsの論理prefixは権限境界ではない。trusted server code用でありadapter単体は利用者の認可をしない。
Phase 2でrefをowner/job/version/hash/sizeに結合して永続化する。Drimeはfile ID + workspace/account識別子が必要。

一般Put/Delete APIなし。putTestは同一adapter実行内で生成した一意key/64KiB以内だけ。
deleteTestは同一実行のconnection-tests keyだけ。別実行のkey、任意prefix、原本/完成物は拒否。
random keyの同一実行再試行だけを想定し、運用の上書き保証には使わない。
テストprefixにもアカウント全権キーの権限が及ぶため、将来の削除workerへ渡さない。

## 認証・署名API候補（未公開）

`blomp-signing.ts` はlocalで実行可能な**読取専用policy prototype**。
既存jwtVerifierを再利用し、fileIdだけを受け、server catalogのowner/readable/verifiedを照合。
任意URL/bucket/key/owner/operationはstrict schemaで拒否。署名前後にJWT・権限・refを再確認。
1owner毎60秒10件、Map最大1000ownerのlocal制限。並列instance用の共有制限ではない。
署名URLは60秒のbearer capabilityで、その間の再利用は可能。発行後の即時失効/一回限りURLとは主張しない。
読み取り重複は無副作用、再発行も毎回再認可する。URLをlog/DB/IDB/SWに保存しない。
実HTTP routeは未登録。公開時はno-store、明示origin、TLS、edge/body/request制限を必須にする。

書込署名は公開しない。Phase 2では既存owner/RLS/membership・冪等要求/lease設計を再利用し、
provider独立quota予約、サイズ固定part計画、server key生成、期待SHA、完了応答喪失後のHEAD+実バイトSHA、
quota一度だけ計上、再認証を実装する。容量/仕様不明・無料枠不明なら受付停止。
ETag不透明性、conditional互換性、再送重複の契約を解決してから接続する。

| 実行環境候補            | ローカル実行/制約                                                        | 費用判断                                                     |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 既存standalone Node API | SDK/jose/DB認可を最も再利用できる。Blitz必須ではない                     | 既存無料枠・秘密管理・TLS・稼働条件を所有者確認後に選択      |
| 別の無料serverless Node | 短命署名だけ。動画を通さない。cold start/共有rate limit/DB接続を調査     | 現時点でサービス/料金を確定しない。カード/課金なしが承認条件 |
| Edge runtime            | SDK/Node stream/cryptoの移植確認が必要。今回のNode実装をそのまま配置不可 | 無料枠・上限・超過時停止の確認が必要                         |
| GitHub Pages            | 静的ファイルのみ。秘密保持/署名APIは不可                                 | UIを維持、秘密をNEXT_PUBLICへ入れない                        |

どの案も未契約・未デプロイ。月0円を保証できる実行環境はまだ決定していない。
大容量中継の追加はしない。既存動画エンコードへ戻す判断もしない。

## 実接続ツールとiPhone操作

この作業では**実行していない**。所有者の「接続」と「専用テスト削除」の別承認後のみ実行する。
Node24のprivate実行環境（既に無料で使える環境を優先）をiPhone Safariから開く。
Codespaces等を新規作成する場合も、無料枠/カードなし/課金停止を先に確認し、無断作成しない。

1. Draft PRの差分・監査結果をiPhoneでレビュー。mainへmergeしない。
2. private環境でこのbranchをcheckoutし `npm ci`。Secrets UIの非公開変数にBLOMP_*を直接登録する。
   Endpoint/regionは例と同じ。bucketは管理画面の正式名を確認。キーをチャット、GitHub source、端末browser storageに貼らない。
   provider管理画面へのログイン情報入力と、アプリのlocalStorageへの秘密保存は別。保存先の安全性が確認できるSecrets UIだけを使う。
3. BLOMP_ENABLED=trueは検証プロセスだけに設定。既存CLOUD_UPLOADS等は変更しない。
4. 明示承認後にterminalで下記を1回実行。シェルtrace/debug/ネットワークtraceを有効化しない。

   `npm run verify:blomp --workspace server -- --approved-connect --approved-delete-test`

5. configuration→1024byte PUT認証→HEAD→stream SHA-256→署名GET実取得SHA→専用object DELETE→不在確認の結果だけを確認。
   引数なしはnetwork前に拒否。bucket列挙なし。URL/資格情報を出力しない。失敗exit1。
6. cleanup失敗/プロセスkill時は自動で全prefixを削除しない。管理画面でconnection-tests領域を確認し、個別対象を再承認して整理する。
   対象名は秘密を避けて自動logに出さないため、実行時刻と領域から所有者が確認する。
7. 実行後はprivate環境の変数/プロセスを停止。資格情報の露出が疑われる場合は所有者が失効する。

Secretsの登録先UIは選択した実行環境に依存するため、未選択の環境の画面名を断定しない。
GitHub Actions用Secretsの登録だけではこのNode processへ自動注入されない。今回live workflowは作らない。

## ブラウザ受入（別承認・未検証）

Blomp CORS設定可否・公式サポートに問い合わせる。アプリoriginを正確に限定し、OPTIONS、GET/PUT/HEAD、
Content-Type/Range/必要な署名header、Expose-Headers ETag/Content-Length/Content-Rangeを確認。
credentialsなしの直接転送を優先。CLIの成功はCORSの成功ではない。
実Safariで小容量→Range206→multipart各part ETag→中断/list/resume→期限切れ403→再認可/再発行→完了SHAを検証。
no-corsやブラウザ保護の無効化を使わない。非対応なら受付OFFを維持し、所有者に代替を相談。
代替はCORS対応済み既存R2の継続、端末保存、別サービスの承認後採用。中継案には転送料/帯域/実行時間/無料枠の再評価が必要。

## 容量・大容量・Phase 2

Blomp40GB / Drime20GBは所有者の表示値で独立。60GBプールは作らない。
Blomp使用量APIは未確認。独自台帳は推定で実測ではない。ゴミ箱/未完了multipart/他アプリの消費も確認する。
Drimeのusage APIは資料上存在するが実アカウント値・単位・ゴミ箱計上は未検証。
無料枠/転送/維持条件が不明、残量不足、429が続く場合は新規受付を保留。課金/アカウント分散なし。

Node streamを使用し、実ファイル全量のbuffer化なし。検証ツールだけ最大64KiBの小バイト列。
partはS3標準の5MiB以上（最終除く）/最大5GiB、10000partをローカルで検査するがBlompの実上限とは断定しない。
1/2/5GB実転送は別承認で行う。5GiB metadataテストは実バイト・iPhoneメモリ検証ではない。
Phase 2は並列1–2、Blob.slice、逐次hash、quota予約・実測との照合、uploaded-parts検証を設計し、
iPhone一時disk/最終結合/タブ破棄を実測する。チェックポイントから復旧し、背景処理継続を仮定しない。

運用削除/GC/移行はなし。将来は完成物検証、owner/job/version/ref照合、参照pin/復旧保持、
冪等ticket/容量一度だけ減算、失敗再試行、provider権限分離が揃うまで全件保持。

## rollback

今回のファイルは既存main起動経路からimportされていない。BLOMP_ENABLED=falseで検証を停止し、
作業branchの追加commitをrevertして元のbuildへ戻す。DB migration/素材移動/削除は不要。
検証objectが残ってもrollback名目で一括削除しない。秘密変数の削除/失効は所有者が判断する。
