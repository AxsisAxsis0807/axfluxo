# AxFluxo：blitz.cloud 最小接続試験（準備済み・外部未実行）

2026-11-09 日本時間。動画・既存AxFluxo DB・既存ディスクを使いません。
無料期間は未確認のままです。有料契約、カード登録、keepaliveは行いません。
このフォルダーだけで実行でき、本体のmigration 001–008・API・worker・frontendは変更しません。

## この試験で区別する結果

| 試験                | 操作・観測                                                                                                      | 合格条件                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 同一appのpart間共有 | APIが専用folderにapi.jsonを書く。worker起動時に読み、worker.jsonを書く。APIが手動で読む。照合するhashはDBに記録 | workerがAPIのbytesを読め、APIがworkerのbytesを読め、同じrun ID/hashで一致                             |
| 永続性              | 判定後、APIとworkerの両partを明示的に再起動し、new boot IDと同じmarker/hashを確認                               | 両markerが残り、再起動後も同じhash。restart前だけでは永続性を合格にしない                             |
| 認証付き内部HTTP    | APIから管理側固定worker originへ小さなcanaryをPOST。未認証、署名付き、同じ署名の再送を各1回                     | 未認証401、署名付き応答のHMAC一致、再送401。公開URLで成功しても内部経路の証明にはしない               |
| API停止中のDB       | APIで90秒区間をarm→workerだけ再起動→APIだけ停止。workerが5秒ごとにDB時刻付きテスト行を書く                      | dashboardで確認したAPI停止区間内に同じworker boot IDのread/write記録が複数あり、workerはRunningのまま |

**共有試験は内部HTTPへ依存しません。** HTTPが不可でも、workerの観測をDBで読めます。
API停止の事実はDB行から推測しません。画面で確認した停止・再開時刻と照合します。
アプリ全体・DB・workerまで停止した試験は「APIのみ停止」の合格にしません。
手動停止試験の合格を、providerの15分sleep試験の合格とは扱いません。

## 既に公式資料で分かること／実測すること

- 別appのファイルは互いに見られない：今回の試験は**同一app内の2 part**だけ。
- 複数part、part名による内部接続、background partとweb partの別sleepは公式説明あり。
  同じ永続folderの共有とbackground内部listenerの到達はこの試験で確認する。
- DBはlinked appのsleep/paused状況でsleepする。API停止時のworker partとの扱いは実測する。
- GitHub連携はpushでbuild/deploy。GitHub Actions方式はproviderによるworkflow commitを伴う。
- 期限表示がないFree画面を確認済み。ただし継続無料／経過措置は確定せず、未確認のまま記録。

参照：
[GitHub・parts・worker](https://blitz.cloud/docs/deploy-from-github/)、
[永続folder](https://blitz.cloud/docs/settings-and-files/)、
[DB](https://blitz.cloud/docs/databases/)、
[無料枠](https://blitz.cloud/docs/limits/)、
[規約](https://blitz.cloud/terms/)。

## 承認後の外部構成案

**論理app 1つ、実行part 2つ、新規専用PostgreSQL 1つ**。既存AxFluxoは使わない。
app/DB名は `axfluxo-probe-<短い試験識別子>`。DB名はこのprefixを必須とし、実接続先の
`current_database()` でも確認する。通常のaxfluxo DBを指定したら起動・setupを拒否する。

| 項目              | API part                               | worker part                               |
| ----------------- | -------------------------------------- | ----------------------------------------- |
| 公開              | probe appの `/`（HTTPS）               | background、公開addressなし               |
| build context     | repo root                              | 同じ                                      |
| Dockerfile        | server/connection-probe/Dockerfile.api | server/connection-probe/Dockerfile.worker |
| target            | 単一stage、指定不要                    | 単一stage、指定不要                       |
| 完全なcommand     | node /app/main.mjs                     | 同じ                                      |
| CMDだけ置換する欄 | /app/main.mjs                          | 同じ                                      |
| role              | imageがPROBE_ROLE=apiを設定            | imageがPROBE_ROLE=workerを設定            |
| port              | providerのPORT優先、既定8080           | 内部8091、PROBE_INTERNAL_PORTで明示       |
| 保存folder        | /probe-data                            | /probe-data                               |
| memory案          | Small予約128MB                         | Small予約128MB                            |
| DB                | 専用probe login、同じ新規probe DB      | 同じ                                      |

既存Docker targetを使わず、FFmpeg・Canvas・既存アプリの依存を入れません。
`package-lock.json`付きのpgだけをインストールします。root依存やlockfileは変更しません。
同一folder設定がpartごとに独立diskになるかどうかを判定するので、共有できると仮定していません。

`compose.yaml` はローカル基準です。providerが同じpart/volume/internal portへ解釈する保証ではありません。
wizardで2 appへ分割されたら、そのまま作成せず構成を見直します。

## 設定値（実値はまだ発行・設定していない）

`settings.example` を参照。API・worker共通：

- PROBE_RUN_ID：今回だけのUUID。再試験では別ID。
- PROBE_EXPIRES_AT：絶対ISO時刻。起動時から30分以内の期限。期限後は新しい試験操作を拒否。
- PROBE_TOKEN：試験画面用のprivate bearer token、32文字以上。
- PROBE_INTERNAL_KEY：別のprivate HMAC key、32文字以上。
- PROBE_DATABASE_URL：新規専用DBのみ。provider注入DATABASE_URLを使う場合は専用名を確認し前者を省略可能。
- PROBE_DB_TLS=true：証明書検証あり。provider DBが非TLSなら勝手にfalseにせず、その結果を記録する。
- PROBE_ROOT=/probe-data。

APIのみ：PROBE_PUBLIC_ORIGIN=<実際のHTTPS origin>、PROBE_WORKER_ORIGIN=<workerの固定内部origin>。
workerのみ：PROBE_INTERNAL_PORT=8091。公開APIのPORTはprovider注入値に従う。
app全体で共通環境変数でもroleは各imageが設定するため、PROBE_ROLEを全体設定へ上書きしない。

tokenはURL、GitHub、ログ、結果JSONへ入れない。iPhoneで入力する画面はpassword欄で、
localStorage/cookieへ保存しない。再読込後は再入力する。

## GitHub変更と自動更新の扱い

適用先候補：新しい **test/blitz-connection-probe** branch。
基準は `db197bd4345ffb35f1630baca2c1c53e1234ef31`。同梱probe-only.patchだけを適用する。
既存の最小動画版36ファイルや接続準備文書をこの試験の必須前提にしない。

承認後に予定するGitHub変更は、このbranchへの手動commit/pushのみ。main、PR、Pages公開は対象外。
現行CIのpush対象はmain/feat/**なのでtest/**へのpushだけでは通常CIを起動しない。
ただし既存の外部webhook連携すべてがないとは断定せず、実行直前に再確認する。

提示された画面では「Build new apps on my GitHub Actions」がON。
**推奨実行案は、この新規app作成時だけOFFにしてprovider側でbuildし、元のONへ戻す**。
これは外部設定変更なので今回まだ行わない。承認対象の操作一覧へ含める。
試験appの自動更新もOFFにして、夜間buildや意図しない更新を避け、試験後削除する。
OFFが反映されない／providerがworkflow commitを提案した場合は、無断で承諾しない。
GitHub Actions方式を選ぶなら、別途 `.github/workflows/blitz-cloud.yml` のprovider commitとActions利用分を
明示的に承認する必要がある。今回の推奨案には含めない。

## iPhoneでの準備確認（外部実行承認後）

Safariでdashboardを開き、作業前にApps/DB/memory/storage/build minutesの使用量を記録する。
Free表示と期限の有無も記録するだけで、無期限無料と断定しない。Pro購入・カード画面へ進まない。

1. Settings → ConnectionsのGitHub欄で、現在のActionsスイッチがONであることを記録する。
   承認済みの場合だけ新規app用buildをOFFにする。GitHubの権限は変更しない。
2. 専用branchを選択して新規probe appを準備。根拠のある画面名は「Host something new」→
   「My own code」→「Advanced settings」。branch、repo root、2つのDockerfileを明示する。
   providerが独自Dockerfile作成/修正を提案しても、この試験ではそのまま承認しない。
3. parts一覧でAPIとworkerが**同じapp**内に並ぶことを確認。workerはbackground、APIだけがaddressを持つ。
   片方しか出ない／2 appになるなら作成内容を変えずに証跡を残す。
4. Files/Advanced settingsで両partの保存先/probe-dataを確認。
   part選択欄、共通volume、実際のmountの表示があれば記録する。表示がないだけで共有不可とも可とも決めない。
5. 新規専用DBだけを接続。DB名、どのappへlinkされたか、DBのRunning/Sleeping表示を記録する。
   接続URLやpasswordをスクリーンショットで公開しない。
6. Environmentへ上記設定を入れる。最後に期限を30分以内で設定し、必要なrestartを行う。
   UIでpartごとの違いを設定できないときもroleはimage側を使う。

### 一度だけのSQL setup

この試験は `setup.sql` の独立schema・2 tableだけを使用。AxFluxo migration 001–008は適用しない。
新規probe DBのowner loginで、明示的に一度だけ次を実行する：

```
node /app/admin.mjs --setup
```

CMD置換方式なら `/app/admin.mjs --setup`。
公式にある「version前の一度の実行step」を使う場合も、常駐partにせず、最初のsetup後に無効化する。
繰り返すと既存schemaのため拒否する設計。通常API/worker起動にはsetupを組み込んでいない。
一度だけの実行stepやDB SQL consoleが画面にない場合は、自動migrationを勝手に追加せず、
承認済みの管理実行方法へ切り替える必要がある。DBは外部psql不可と公式記載がある。

### 試験1：共有と永続性

1. probeのHTTPS addressを別タブで開き、tokenを入力。「1. 小さなファイルの共有試験を開始」。
2. dashboardに戻り、**worker partだけを再起動**。workerのLogsでready/boot IDを確認。
   待機中のDB自動pollingはないため、この明示的な再起動で1回だけ観測する。
3. probeタブで「観測結果を手動更新」。`bidirectionalShared=true` と、
   `row.worker_saw_api`、`apiFile`、`apiSawWorker`のhash一致を確認する。
4. falseなら、APIのmarkerだけはあるか、workerのDB観測行はあるかを分けて記録。
   workerが起動していない／DBが使えないなら「共有不可」ではなく「判定不能」。
5. APIとworkerを両方再起動し、別boot IDと同じmarker/hashを確認する。
   API再読込ではtokenを再入力する。これで再起動を越えた永続性も確認する。

### 試験2：共有不可の場合の内部HTTP

1. Settings → Partsでworkerの内部名/portが分かるか確認。
   PROBE_WORKER_ORIGINはその固定内部addressだけにする。ユーザー入力の任意URLは受け付けない。
2. 「2. 認証付き内部HTTPを試験」を1回押す。state=passなら、未認証拒否・署名応答照合・再送拒否が揃っている。
3. unconfirmedはname解決/port/timeout/不正応答のいずれかで、不可と即断しない。
   workerがRunningか、background設定でlistenerが公開されるか、内部portが認識されるかを設定画面で記録する。
4. 公開addressへ切り替えて成功しても内部通信成功とはしない。workerを公開して回避しない。
   到達できないままなら、その構成は追加調査が必要と判定する。

### 試験3：APIのみ停止中のDB

操作は2つのSafariタブで行い、時計とdashboardの状態を記録する。

1. 試験1のrunが作成済みで、試験全体の期限まで120秒以上あることを確認。
2. 「3. 90秒のDB観測区間を一度だけ開始」を押す。返るarmed_at/window_endはDB時計のUTC。
   JSTはUTCに9時間を足す。画面結果を保存しておく。
3. dashboardでworker partだけ再起動し、Runningと新boot IDを確認してから、API partだけを停止する。
   APIのStopped/Paused表示の時刻を記録。workerとDBは停止しない。
4. 可能なら30秒程度APIを停止したままにし、その間workerがRunningか確認。APIへのアクセスは行わない。
5. API partだけを再開し、token再入力→手動更新。
6. eventsのdb-window行から、**画面で確認したAPI停止区間に入る複数のobserved_at**と同じworker_bootを照合。
   workerのログにもDB成功・失敗の時刻がある。停止区間に記録がないときは合格にしない。
7. intervalは5秒、区間は90秒で終了。同じrunで再armして時間を延長しない。期限後も自動再試行しない。
   手動停止操作に時間がかかり区間を逃した場合は不合格ではなく判定不能とし、再試験は別ID・追加承認で行う。

停止ボタンがapp全体にしかない／workerまで再起動・停止された／DBまでpauseされた場合は、
その事実を記録し、API-only停止を試せたとは報告しない。sleepそのものの確認は別の試験である。

## 上限と生成物

- ファイルはAPI/workerのmarker各1つ、各1KiB以下。専用run UUID配下のみ。
- HTTP body/responseは4KiB上限、内部HTTPは最大3要求/ボタン1回、各3秒timeout。
- 操作のrate limitは30回/分。UIは二重タップ中の重複要求を抑止し、自動更新しない。
- 新規操作の寿命は絶対期限30分以内。workerは起動時1回だけ観測。
  DB試験をarmしてworkerを再起動した場合だけ、残り90秒以内・5秒間隔の測定を行う。
  **待機中のDB keepalive/pollingはしない。** APIへの自動アクセスもない。
- DBはrun 1行＋boot最大8行＋db-window最大18行、合計最大27行/試験。
  実レコードは小さいが、DBエンジン自体のdisk予約は別。
- 期限後、daemonがidleで残ってもproviderの予約枠は解放されない。必ず停止・削除する。
- UI用bearer tokenと内部HMAC keyは承認後に試験専用として設定。実秘密情報は今回発行していない。

## 実行時の外部変更・無料枠・削除（承認対象）

| 対象        | 作成/変更案                                                 | 消費・注意                                                                                             | 削除/復旧                                               |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| GitHub      | test/blitz-connection-probe branchへprobe-onlyのcommit/push | main/PR/Pages変更なし。provider workflow自動commitはOFF案                                              | 試験後このbranchだけ削除可能。mainは触らない            |
| account設定 | 新規app Actions buildをON→OFF→元のON                        | 新規app全体にかかわる設定。未実施                                                                      | 記録した元のONに戻す                                    |
| probe app   | 同一app、API＋workerの2 part                                | plan上は2 app分を想定。将来の自動更新はOFF                                                             | 結果保存→両part停止→probe appだけ削除                   |
| memory      | Small 128MB×2＋PostgreSQL 128MB案                           | 予約合計384MB/512MBの目安。実際の割当と既存使用量を実行前確認                                          | 停止/削除後meterを確認                                  |
| 永続folder  | probe app内の/probe-data、part共有は試験対象                | Dockerの1GB予約とDBの1GB。part別課金/予約なら上限3GBを見込んで確認                                     | app削除で試験ファイル削除。既存volumeへ接続しない       |
| DB          | 新規専用PostgreSQL 1つ、probe schemaと2table                | 無料枠1/1を占有。既存DBがあれば作成しない                                                              | 結果保存→専用probe DBだけ削除。既存DBは操作しない       |
| build       | API/worker用の軽量image、1回の初回buildを予定               | providerの月間build minutesを消費。所要分数は保証しない。Actions OFF案はGitHub build minutesを使わない | appの自動更新OFF、試験後削除。消費済みminutesは戻らない |
| secret設定  | 試験専用token/HMAC、専用DB login                            | カード・有料プラン・R2契約なし                                                                         | probe app/DB削除で専用設定を破棄。既存鍵は変更しない    |
| 試験操作    | worker再起動、API part停止/再開                             | 他appのrestart/stopはしない                                                                            | 試験終了後はprobeを再開しない                           |

無料期間は未確認。期限のない表示だけで継続無料を確定しない。
無料枠が不足している、料金画面へ誘導される、追加支払いが必要な場合は実行しない。

### 明示的にファイル/DBだけ清掃する場合

両partを停止してから、試験コンテナー内で：

```
node /app/cleanup.mjs --writers-stopped
```

PROBE_ROOT/PROBE_RUN_IDに一致するapi.json/worker.jsonだけのfolderを削除。
予期しない名前があれば拒否。DB schemaだけなら：

```
node /app/admin.mjs --drop-probe-schema
```

どちらも承認後のprobe専用環境だけで行う。通常は新規probe app/DBを丸ごと削除する方が明確。
削除の前に結果JSONと必要なログだけをFilesへ保存し、secretの値を含めない。

## ローカル検証と今回の停止地点

`node --test server/connection-probe/probe.test.mjs`：本番DB指定拒否、HMAC/期限/replay、
共有・非共有marker、認証内部HTTP、API HTTP listener停止後のDB記録を検証。
既定はPGliteに実際の専用名DBを作ってSQLを実行。native PostgreSQLで再現する場合は、
空のloopback専用DBを用意してAXFLUXO_PROBE_TEST_DATABASE_URLを指定する。
このローカル検証をblitz.cloud上の合格とは扱わない。

今回は試験コード・Dockerfiles・設定例・手順・承認対象一覧を準備したところで停止する。
GitHub commit/push、外部app/DB作成、外部setup、provider設定変更、接続試験の実行は未承認・未実施。

### 準備時の検証結果

- ローカルNode試験3件成功（9.06秒）。PGliteに実際の専用名DBを作成しSQLを実行。
  共有/nonshared、HMAC/期限/replay、API listener停止後のworker DB観測、期限後の測定停止を検証。
- Chromium・390×844画面で、試験開始、共有結果表示、署名内部HTTP、token非永続化を確認。
  iPhone実機の成功証跡ではない。
- API/workerの専用Dockerfilesをbuild。非root UID1000、readonly root、network none、128MiBで
  marker 106/109 bytesの読み書き、admin/SQL同梱、build CA secretがimageに残らないことを確認。
- Docker COPYに明示的な0644権限を指定し、通常ユーザーでソースを読めることを確認済み。
- rootのlint（警告0）、typecheck、git diff --check成功。既存最小動画版のファイルは変更していない。
- native PostgreSQLでのこの新規probe suite、blitz上の通信/共有/sleep、iPhone実機は未実行。
  既存動画版のPostgreSQL試験結果を、この新規probe suiteの実行結果として流用しない。
- DB観測の準備時間にkeepaliveする処理はなく、期限切れを自動延長する処理もない。

provider管理image/build履歴の保持期間は未確認。app削除後、履歴と利用量の表示も確認する。
試験用秘密値はimageへコピーせず、結果ファイルや公開branchへ含めない。
