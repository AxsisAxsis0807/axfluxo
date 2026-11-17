# Phase 1 五周監査・検証記録

更新: PR #36追加監査の最新結果は末尾節を参照。明示NodeHttpHandler・deadline強制・factory HTTP経路を追加検証し、既存79＋追加5＝84件が成功。前半の件数/依存/承認状態は初期監査時点の記録。

基準main `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。
実行環境: managed Linux / Node24 / 既存lockfile。実キーなし、実provider未接続。
監査はこの差分の範囲。実サービス受入やiPhone試験の代わりにはしない。

## 第1周 — 最新仕様・範囲

発見: mainの既存UploadServiceはR2専用設定だけでなくETag=MD5にも依存。
未マージDrive/worker PRをmainに含まれると誤認すると基盤を壊す。
対応: Blompを別moduleに隔離。StoredPart型だけ共有し、既存MultipartStorageへの接続は保留。
動画export、Blitz、main API/worker、DB、既存参照を変更しない。provider/location付き新参照を準備。
再確認: 既存source/.github/storage configとの差分なし。受付flag/削除機構へのimportなし。

## 第2周 — セキュリティ・認証・秘密

発見: SDK raw error/stream途中errorには秘密やURLが含まれ得る。発行中にJWT/権限が失効する可能性。
対応: 固定error code、stream例外安全化、署名前後のJWT/catalog再確認。
再監査でJavaScriptの末尾anchorが終端改行を許す点を発見し、bucket/keyの制御文字を明示拒否。関連テストを追加して再実行。
任意key/URL/bucket/owner指定拒否、exact endpoint、region固定、短命署名、local rate制限。
テスト削除は同一adapterが生成した専用keyだけ。運用削除は提供しない。
再確認: JWT実署名/issuer/audience/期限/改竄/他owner/権限失効/SSRF入力/別bucket/ref拒否を追加テスト。
front source/配布物の秘密変数名・ダミー秘密値検査は実行記録参照。実秘密を用いた検出試験は行わない。
public署名APIは未配備。共有rate制限・永続catalog/RLS・HTTP no-storeは公開前の条件。

## 第3周 — 互換性・大容量・容量

発見: Range要求が無視される、HEADサイズ欠損、不正paginationを成功とすると危険。
対応: 206と数値Content-Range、非負safe integerサイズ、pagination進行/上限を検証。
MD5/conditional/checksum/CORS互換性は個別unverified。SDKはWHEN_REQUIRED。
接続/要求/idle timeout、retry1回。streamを優先し、テストuploadだけ64KiB上限。
再確認: 実SDK SigV4/固定host/path style/60秒/署名content-lengthを確認。
1/2/5GiBは署名metadataだけ。小容量バイトだけ隔離SDK transportを通した。
Blomp40GBとDrime20GBは独立、実使用量/無料制限が不明なため運用受付は未接続のまま。

## 第4周 — 復旧・整合性・回帰

発見: PUT/完了応答喪失後の無条件再試行やcleanup失敗の隠蔽は誤報になる。
対応: SDK自動retryを制限。完了喪失は固定errorで返しHEAD/実SHAによるcaller照合を要求。
検証ツールは同一実行objectだけfinally cleanupし、cleanup失敗は明示的失敗。
再確認: SHA不一致/署名URL403/通信切断/timeout/401/403/404/429/5xx/容量507/重複制限を隔離試験。
既存テストを削除/skip/緩和しない。全体回帰の失敗/実行制約は下の結果に分けて記録。

## 第5周 — 無料運用・本番保護・rollback・差分

発見: main pushはPagesを自動配信する。既存削除は物理権限分離必須。
対応: 作業branch/Draft PRのみ。workflow追加/dispatchなし。既存削除へ接続しない。
依存追加/課金/登録/カード/本番DB/デプロイ/mergeなし。
Blomp規約の1年未アクセス条件を記録。転送/API/ゴミ箱/維持条件の不明点は所有者確認が必要。
再確認: staged差分/秘密パターン/新規ファイル/既存機能不変を確認してcommitする。
rollbackは追加commitのrevertまたは検証停止。データ削除や移行を伴わない。

## 実行結果

最終実行結果は以下へ追記する。実行中/失敗/未検証をPASSへ置換しない。

- 新規Blomp 5 suites: **79 PASS**。SDK transportは隔離mock。実サービスの成功ではない。
- 初回全体Vitestは通常sandboxでHTTPのloopback通信が遮断され14件timeout、レンダー系4件も失敗。
  途中で停止し、ローカル通信可能な実行環境で同一suiteを再実行した。初回を成功として数えない。
- 初回Next buildはcompile後のTypeScript showConfig解析で停止。通信可能な実行環境で再実行。
- 初期単独型検査では新規mockの型エラーを検出し修正（SDK overload、TypedArray/Response型）。テスト期待値は緩和していない。
- `npm run verify:blomp --workspace server` は引数なしでBLOMP_APPROVAL_REQUIRED/exit1を確認。接続承認flagを付けていない。
  初回tsx CLIのIPC listenがsandboxで拒否されたため、node --import tsxに変更し同じsandboxで再確認した。

## 回帰・最終確認の詳細

| コマンド/対象                                             | 結果                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 新規 `vitest run server/tests/blomp --maxWorkers=1`       | 最終コードe9240a9相当: 5 suites / **79 PASS**                                                                                                  |
| 全体 `npm test -- --maxWorkers=1`（ローカル通信可能環境） | **469 PASS / 1 suite setup FAIL / 3未実行**。中間コード時点、初期化hookが10秒超過。自分でskip指定していない                                    |
| 認証DB 3件の対象再実行                                    | 初期の対象再実行もsetup timeout。比較用の未変更mainでは3 PASS。動画/型検査終了後の最終候補でも **3 PASS**（10.03秒）。timeout/期待値の変更なし |
| `tsc --noEmit --incremental false`                        | 最終実装でPASS                                                                                                                                 |
| `npm run lint` + 最終変更全Blompファイルのeslint          | PASS、警告なし                                                                                                                                 |
| `npm run build`                                           | static export/postbuild PASS。続けて公開ダミーキーによるモックE2E用buildもPASS                                                                 |
| server `build` / `build:worker`                           | PASS                                                                                                                                           |
| root静的E2E desktop/mobile                                | **124 PASS**（18.3分）、認証はHTTP mock、画像編集/Workflow/ローカル保存を含む。実機Safariではない                                              |
| 動画Chromium全suite                                       | **37 PASS / 7 FAIL**（18.4分）。成功のみを全体合格と扱わない                                                                                   |
| 未変更mainの入口3ケース                                   | **3 FAIL**、同じ完了待ちtimeoutを再現                                                                                                          |
| 未変更mainのWAV波形                                       | **1 PASS**。候補の失敗が確実な既知不具合とは認定できない                                                                                       |
| 未変更mainの復旧/キュー3件                                | **1 PASS / 2 FAIL**。durable queue recoveryと3job queueは同じ失敗、editor restoreは成功                                                        |
| WebKit端末encoder 1件                                     | 実行file不在でlaunch FAIL。本体未実行                                                                                                          |
| WebKit install                                            | 公式downloadの複数hostが403 Domain forbidden。未導入のまま、TLS/制限を回避しない                                                               |
| CLI引数なし                                               | BLOMP_APPROVAL_REQUIRED、exit1、通信なし                                                                                                       |
| client依存graph/静的artifact                              | server/Blomp import・秘密変数名・dummy-secretの混入指摘なし                                                                                    |
| 差分/秘密パターン/flag                                    | 既存source/config/workflow不変、既定OFF、実秘密を取得していない                                                                                |

全体472件の結果と、後から追加・強化した最終79件は異なるrunであり、重複加算して単一run成功と主張しない。
環境は2CPUで、初回は重い検証を並行した。後半の障害切分けは対象を限定して順番に実施した。
この実行条件の変動もあるため、browser失敗の原因をBlomp差分にも環境だけにも断定しない。

## 未検証・受入保留

Blomp実認証、bucket正式名、CORS/OPTIONS、GET/PUT/HEAD/Range/Multipartの実互換、署名の実受理、
MD5/ETag/checksum/conditional、無料枠の実制約/利用量、1/2/5GB実転送。
Drime実PAT/API/大容量/復旧/削除/usage/CORS。実機Safari/背景化/タブ破棄/メモリ・disk。
署名API実行環境・永続catalog/認可・共有rate limit・書込quota/冪等/実SHA公開判定。
Blomp実接続および削除には別承認が必要。Phase 2全体フローは未実装。

## 変更ファイル（15件）

| ファイル                            | 用途                                  |
| ----------------------------------- | ------------------------------------- |
| server/storage/blomp-config.ts      | OFF/設定検証/location識別             |
| server/storage/blomp.ts             | 独立SDK adapter                       |
| server/storage/blomp-signing.ts     | ローカル読取認可prototype             |
| server/storage/blomp-verify.ts      | 一意専用objectでの明示検証            |
| server/scripts/verify-blomp.ts      | 秘密を出さないCLI入口                 |
| server/blomp.env.example            | ダミー設定例                          |
| server/package.json                 | 明示CLI scriptのみ追加                |
| server/tests/blomp/storage.test.ts  | 設定/契約/障害/署名/入力境界          |
| server/tests/blomp/signing.test.ts  | JWT実署名/所有者/認可/再検証          |
| server/tests/blomp/verify.test.ts   | 明示承認/整合性/cleanup障害           |
| server/tests/blomp/sdk.test.ts      | SDK transportで小実バイト往復         |
| server/tests/blomp/boundary.test.ts | frontend依存境界/秘密名の混入検査     |
| docs/storage/phase1.md              | 設計/監査/iPhone手順/Phase 2/rollback |
| docs/storage/drime-research.md      | 公式資料/確認済と不明点               |
| docs/storage/phase1-audit.md        | 5周の発見/修正/再検証記録             |

新規依存関係なし。package-lock、DB、src、既存storage/api/worker、workflowへの差分なし。
最初の実装commit: `31d74f32af87ec35ea07e2546d92bb00acdd3a05`。
追加監査でcatalog row/key双方のowner一致と署名前の参照snapshotを固定し、同一objectが変更された場合も拒否。
SDK client factoryを直接呼ぶ場合も設定を検証・正規化し、テストfilenameのdotを正規表現で明示escapeした。
第2・3・4周の関連テストと型/lintを再実行し、新規79件が成功。最終headはgit log/PRを参照。

## 五周の最終判定

| 周                   | 判定                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 仕様/範囲          | Phase 1の独立基盤として一致。全体フロー/運用接続は未実装                                                                                         |
| 2 security/auth      | 最終79件の隔離範囲で成功。公開API/実credential権限は別受入                                                                                       |
| 3 互換/容量          | SDK/local契約は成功。Blomp/Drimeの実互換・実使用量・大容量は保留                                                                                 |
| 4 復旧/回帰          | 新規79、認証DB対象3、root E2E124は成功。既存動画5件はmainでも失敗、全回帰合格ではない                                                            |
| 5 本番/無料/rollback | main最終確認は1c88efbのまま。既存src/api/worker/storage設定/workflow/lockfile不変。契約/課金/実接続/本番変更なし。追加commitのrevertでrollback可 |

最終コードcommit: `e9240a96418aa1c24014cd49fe74e9d324c9ada4`。
その後のcommitは記録だけ。差分は15件のテキストファイル。新規依存なし。
固定秘密パターン検査とclient artifact検査は指摘なし（網羅的な秘密検出の保証とはしない）。

Draft PRは所有者へ確認依頼中の既存CI実読取について、承認を得てから作成する。
承認待ちの間も、作業branch/commitで実装をレビューできる。テストをskipしてPRを通す変更は行わない。
Phase 1の完了条件のうちDraft PR作成が未完了であり、現時点で完了とは宣言しない。
Blomp/Drimeの実接続・削除試験・本番反映にはそれぞれ別承認が必要。

## PR #36追加監査 — Node HTTP handler（2026-11-17）

監査基準: `7d8343b83b162fb22cd1bbbc385db3dd7e84acb4`。この節より前の79件/15ファイル/依存追加なし/承認待ちは初期監査時点の記録。
PR #36はその後、所有者の限定承認を受けDraft作成済み。今回もmain・本番・実Blomp/Drime・実データを変更しない。

### 原因の切分けと実装修正

導入済み版は `@aws-sdk/client-s3@3.1161.0`、`@smithy/node-http-handler@4.14.1`、`@smithy/types@4.19.0`。
以下の**固定版の型/実装そのもの**を確認した（バージョン一般への推測ではない）。

- `@aws-sdk/client-s3/dist-types/S3Client.d.ts`: requestHandlerはHttpHandlerUserInput。
- `@smithy/types/dist-types/http/httpHandlerInitialization.d.ts`: RequestHandlerParamsはNodeHttpHandlerOptions等を許容。constructor optionsの直接指定は正式な短縮形。
- `@aws-sdk/client-s3/dist-cjs/index.js` のNode runtimeConfig: `NodeHttpHandler.create(config?.requestHandler ?? defaultConfigProvider)`。
- `@smithy/node-http-handler/dist-cjs/index.js` のcreate: handle実装がなければ `new NodeHttpHandler(options)`。

したがって、この固定版で「プレーンオブジェクトなのでhandleが存在せず通信不能」とする原因は確認されなかった。
未修正HEADの隔離コピーでも、新しい対象テストはfactoryのPUT/HEAD/GET・実バイトSHA・SigV4・path-styleを通過し、
最後の `throwOnRequestTimeout: true` 検査だけがundefinedで失敗した。対象1件の比較検証であり、現行suiteの合否には加算しない。

実際に見つかった問題は、requestTimeoutが `throwOnRequestTimeout: true` 未指定だと**警告のみ**になることと、
従来テストがfactoryのnative HTTP経路を通していなかったこと。
修正は明示的な `new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 30000, socketTimeout: 30000, throwOnRequestTimeout: true })`。
既存の数値・HTTPS endpoint固定・region・path-style・SigV4・checksum方針・retry1回は維持する。

### 依存関係とlockfile

`@smithy/node-http-handler@4.14.1` をserverの**直接runtime依存**に宣言した。
従来からS3 SDK経由で同じ版がlock済み。間接依存の偶然のhoistに直接importを依存させないための宣言であり、
新しいpackage実体、解決バージョン、tarball、integrity、子依存の追加/変更はない。
package-lockの変更は `packages.server.dependencies` の1行だけ。`npm ls` と `npm ci --dry-run --offline --ignore-scripts` は成功。
最初のoffline lock生成コマンドはregistry metadataのcache不足でENOTCACHEDとなったため、既存lock済み版を明示追記しdry-runで整合性を検証した。

### factory経路の隔離テスト

追加: `server/tests/blomp/http-handler.test.ts`（5件）。**S3Client/send/NodeHttpHandler.handleをモックに置換しない**。
`blompClient()`が作った実際のNodeHttpHandlerの最下層 `node:https.request` だけをテスト内で捕捉し、
実際のNode HTTPリクエストを127.0.0.1の一時portへ送る。元endpointはHTTPSのまま、任意endpoint許可やTLS検証無効化をproductionへ追加しない。
宛先hostの検査を行い、実HTTPSへのfallbackは提供しない。ダミー資格情報だけで署名する。

- PUT/HEAD/GET、実小容量bytes/SHA-256、host/path、署名scope us-east-1/s3、SigV4形式、factory設定を検査。
- Smithyの公開updateHttpClientConfigでテスト中だけ50msにし、無応答serverに対するrequest deadlineとsocket idle timeoutを個別に検査。1要求のみで再試行なし。
- 401/403のXML本文にダミーsecret/URLを入れ、実SDKで受信・解析後のadapter error/code/causeとconsoleへの非露出を確認。
- connectionTimeout=5000は実handler設定を検査した。接続phaseを5秒待つ通信試験は行っていない。
- deadline試験は応答header前。stream body全体の総時間上限を保証しない。bodyの中断/idle/caller AbortSignalとは区別する。

この試験は**mock HTTPS transportを介したloopback HTTP**であり、TLS handshake/証明書検証・実Blomp到達・API互換・CORSの成功証明ではない。
Supabase/本番API/実Blomp/Drimeへの試験接続なし。テストserverと接続はfinallyで閉じる。
初回通常sandboxはlisten EPERMで失敗したため、ローカル通信可能な環境で再実行した（skipにはしていない）。
新規testの開発中、SDKのx-id queryをpathnameと区別する検査、Errorのcauseが存在しないことの検査を修正。既存79件のテスト/期待値は変更していない。

### 再監査結果と検証

| 周                   | 影響・再確認                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1 仕様/範囲          | handlerの明示化とdeadline強制のみ。保存先/既存受付/export/認証/削除との接続変更なし                               |
| 2 security           | fixed HTTPS/region・path/署名・secret非露出・ダミーのみ・実サービスfallbackなしを84件で再確認                     |
| 3 storage/大容量     | factory-native経路の小バイト送受信を検証。30s deadlineの強制を確認。実サービス/大容量/CORS/無料枠は引き続き未検証 |
| 4 障害/回帰          | **既存79＋追加5＝84件/6 suites PASS**。request/socket timeout・401/403・既存契約を再実行                          |
| 5 本番/依存/rollback | CI/workflow/既存テスト/main/実データ不変。直接依存1宣言、追加package実体0。今回のcommitをrevertすれば旧実装に戻る |

- `npm run typecheck`: PASS。
- `npm run lint`: PASS（警告なし）。
- `npm run build`: PASS（静的export/postbuild）。
- server `build` / `build:worker`: PASS。
- 検証CLIのNode24向けesbuild bundle: PASS。
- lockfileのoffline ci dry-run: PASS。
- 初期HEADのGitHub push CI/PR CI/Pages buildも後にsuccessを確認した。ただし今回修正後SHAのCI成功として扱わない。

残課題: 実Blomp側のS3機能・署名受理・CORS・quota/無料枠、1/2/5GB実転送、実機Safari、TLS実接続、公開認可APIの実行環境。
追加の運用接続/削除/課金/デプロイは行わない。接続試験は引き続き別承認。
