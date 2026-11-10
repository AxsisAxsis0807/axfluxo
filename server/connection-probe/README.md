# AxFluxo / Blitz 接続試験（外部未実行）

2026-11-10。対象 `test/blitz-connection-probe`、取得時HEAD `0490705`。
このディレクトリーだけの独立試験。動画、VIDEO_*、本体migration 001〜008、既存DBは使用しない。
commit/push、Blitz操作、デプロイ、外部DB操作、課金は今回実行していない。

## 修正理由と動作

旧版は起動前にDB名のprefix・30分以内の絶対期限・DB接続を要求し、作成後にしか
確認できない設定があると起動できなかった。新規DBの名前は推測せず、次の3条件を必須とする。

- `PROBE_DATABASE_NAME` にDB詳細で確認した実名を指定する。
- `PROBE_DEDICATED_DATABASE=new-empty-probe-only` で今回新規作成した空の試験DBと明示確認する。
- URLのDB名と `current_database()` が確認名に一致する。

名前のprefix制約を置き換えたが、DB確認を削除したわけではない。初期化では既存ユーザー
オブジェクト・追加schemaのあるDBを拒否し、`axfluxo_connection_probe` だけを作る。
所有者とversionコメントも照合し、同名の既存schemaを上書きしない。
トランザクションと固定advisory lockで同時セットアップを直列化。同runで再実行しても変更しない。
DB/schema/roleを削除して期限をリセットする自動処理はない。

APIはDB未設定・未接続・未初期化でも起動する。`/health` は `ok` のみ、トップページは
共通操作画面のみ。設定状態・結果はBearer認証後だけ表示する。tokenをURLや永続browser storageへ保存しない。
秘密値・接続URL・DB名・生のdriver例外は応答/ログに出さない。

初期化は試験開始ではない。「30分の試験を一度だけ開始」でDBに期限を保存する。
同じschemaは1 runのみ。再押下・run ID変更・API/worker再起動では延長できない。
`PROBE_EXPIRES_AT` は互換上入力が残っていても使用しない。新規設定は不要。
期限後は結果の読取りのみ。内部HTTP最大3回、DB観測は1回90秒・5秒間隔で最大18行、
worker boot記録最大8行、marker各1KB以下、HTTP body/response各4KB、30 requests/分/processを維持。
workerは起動時の1回だけ状態を読み、DB観測区間中だけ5秒間隔で動く。idle polling/keepaliveはない。

## 公式資料で分かったこと／未確認の区別

- [DB](https://blitz.cloud/docs/databases/): ウィザードのDB名欄は記載なし。
  Databasesページではengine/nameを選べるとある一方、appに追随した命名の記述もある。
  したがってapp名から実DB名を算出せず、作成後のDB詳細の **database name** を使う。
  `DATABASE_URL` は接続時に自動注入される。1 appに最大1 DB、freeは1 DB。
- [GitHubデプロイ](https://blitz.cloud/docs/deploy-from-github/): 接続branchへのpushは自動公開を起動し得る。
  composeの複数partとSettingsのPartsが文書化されているが、今回の単一Dockerfile選択後に
  workerを追加する具体的操作・環境変数のpart別設定は実画面未確認。
  step-before-versionの記述はあるが、iPhoneのSQL console/shell/predeploy欄があるとは案内しない。
- [Environment / Files](https://blitz.cloud/docs/settings-and-files/): 作成後Environmentで変数を設定でき、
  次回restart時に反映。Settings > Filesでkept folderを追加できる。VOLUME宣言も検出対象。
  別appのファイルは互いに見えない。同一app内part間で同じkept folderを共有する可否は未確認。
- [制限](https://blitz.cloud/docs/limits/): freeは512MB、5 apps、10GB、DB 1つ。
  small API+small worker+PostgreSQLなら予約384MBを見込むが、他のapp込みの残量確認が必要。
  EU等の対象地域以外はカードなし7日間という記載。アカウントの実際の残期限を確認する。
  providerの自動停止制限に従い、ログイン・アクセスの自動化で延命しない。

公式資料にも記述の差があるため、以下の画面確認を優先する。今回Blitzへアクセスして検証していない。

## 既存入力をどうするか

| 入力 | 扱い |
| --- | --- |
| PROBE_ROOT=/probe-data | 維持可。ただしkept folder設定とrestart後のhash照合なしでは永続化未確認 |
| PROBE_RUN_ID=b71f0d38-68a2-4e91-a3d4-902e6f7c158b | 維持可。今回未初期化ならこの値で固定 |
| PROBE_DB_TLS=true | 維持。証明書検証を無効化しない |
| PROBE_TOKEN / PROBE_INTERNAL_KEY | 維持可。各32文字以上・互いに別。チャットへ提出不要 |
| PROBE_PUBLIC_ORIGIN=https://axfluxo.axsis.prod.page | 作成後に実際のAPI originと照合。違えば修正 |
| PROBE_EXPIRES_AT | 削除推奨。残しても無視されるので日時の再入力不要 |
| DATABASE_URL | Blitz自動設定を使う。既存AxFluxo DBのURLは絶対に使わない |
| PROBE_DATABASE_NAME | **作成後追加**。DB詳細の実名を端末上でコピー |
| PROBE_DEDICATED_DATABASE | **作成後追加**。新規・空・今回専用と確認後 `new-empty-probe-only` |
| VIDEO_* | 全て不要。probe Dockerfile/entrypointは本体をimportしない |

アプリ名 `axfluxo-probe-20261110` と予定originのホスト名 `axfluxo` は異なる。
公式資料ではapp名がsubdomainになるため、予定originを確定値と扱わない。
既存appのrenameや既存originの変更は行わず、新規試験appの実originを確認する。

## API / worker の環境変数

| 変数 | API | worker | 区分 |
| --- | --- | --- | --- |
| PROBE_ROLE | api | worker | Dockerfile自動設定 |
| PROBE_RUN_ID | 同じUUID | APIと同値 | 作成前必須 |
| PROBE_TOKEN | 秘密値32文字以上 | APIと同値 | 作成前必須（workerはUI認証を提供しない） |
| PROBE_INTERNAL_KEY | 別の秘密値32文字以上 | APIと同値 | 作成前必須 |
| PROBE_ROOT | /probe-data | /probe-data | 既定あり。ディスク確保とは別 |
| PROBE_DB_TLS | true | true | 既定true |
| DATABASE_URL | 自動注入 | 同一試験DBへ接続できる設定が必要 | 自動設定／worker側の注入範囲は確認待ち |
| PROBE_DATABASE_NAME | DB実名 | 同値 | 作成後設定。未設定時は試験拒否 |
| PROBE_DEDICATED_DATABASE | new-empty-probe-only | 同値 | 作成後の専用DB確認 |
| PROBE_PUBLIC_ORIGIN | 実API origin | 不要 | 作成後照合、ブラウザーOrigin制限に使用 |
| PROBE_WORKER_ORIGIN | 管理画面で確認した内部origin | 不要 | worker追加後設定。未確認なら空欄 |
| PROBE_INTERNAL_PORT | 不要 | 8091 | worker既定。内部経路と照合 |
| PORT | Blitz自動 | 使用しない | APIはproviderのPORTを優先 |
| PROBE_EXPIRES_AT | 不要 | 不要 | 旧入力は無視 |
| PROBE_DATABASE_URL | 通常不要 | 通常不要 | DATABASE_URLを上書きする上級設定。使うなら今回専用URLのみ |

`NODE_ENV=test` + localhostに限りDB非TLSをローカル試験用に許容する。
外部でTLSエラーならproviderのTLS対応/CAを確認する。CAが必要なら信頼できるCAを
`NODE_EXTRA_CA_CERTS`で追加できるが、Blitzでの配置方法は未確認。検証をfalseに変更しない。
providerのDB資格情報を使用し、schema/tableへのPUBLIC権限を剥奪する。
コードはrole作成・既存roleへのGRANT・既存schemaへの変更を行わない。
provider loginがsuperuser等かは未確認。最小権限の専用loginを確認し、既存DB共有で代用しない。

## iPhoneでの順序（外部実行の別承認後）

1. まず修正差分を確認してcommit/pushを別承認する。旧commitのまま試験開始しない。
2. 現在のウィザード入力は保持する。branch `test/blitz-connection-probe`、Dockerfile
   `server/connection-probe/Dockerfile.api`、Folder to build空欄(root)、Start command空欄。
   Needs a database ON / PostgreSQL。app名は今回専用の値。既存DBに接続しない。
   上表の作成前必須値を設定。`PROBE_EXPIRES_AT` の更新は不要。
3. 無料枠のDB空き・メモリー・試用残日数を確認。追加課金やカードが必要なら中止。
   外部実行の承認後に初めて「Build it and put it online」を押す。
   自動検出がVIDEO_*を要求しても動画値を流用しない。選択Dockerfileとbuild logを確認する。
4. 作成後はウィザードへ戻らない。DB詳細で、このapp専用の新規PostgreSQLと実DB名を確認。
   appのEnvironmentで `PROBE_DATABASE_NAME` と `PROBE_DEDICATED_DATABASE` を追加。
   実API originに `PROBE_PUBLIC_ORIGIN` を合わせて、EnvironmentのRestart neededから再起動。
   DB接続URL・パスワードは端末外へ送らない。
5. appのSettings > Filesで `/probe-data` がkept folderとして登録されているか確認。
   未登録なら今回の空フォルダーとして追加する。既存ファイルは移行されない。
   VOLUME検出だけを永続性の合格証拠にしない。
6. 実APIのトップページをSafariで開き、token入力→「設定状態を確認」。DB準備中なら手動で後ほど再確認。
   `SETUP_REQUIRED` →「専用DBを一度だけ初期化」→ `ready`。shell/SQL consoleは不要。
   同時押下・再実行は同runで安全。`DB_NOT_EMPTY` 等の拒否を削除/迂回せず接続先を調べる。
7. **worker追加の実画面確認ゲート**：SettingsのPartsを確認する。
   単一part appへ追加できるか、worker Dockerfile指定、環境変数のpart別設定、
   同一DBの注入、内部origin/port、kept folder共有、workerだけのrestartとAPIだけのstopが
   可能か確認する。現時点ではクリック順を確定できない。画面にない項目を探すために作成し直さない。
   必要な情報は下のチェック一覧にまとめた。別appなら共有不可と記録し、DB共有は可能と推測しない。
   同一appの追加ができない場合、APIだけでDB初期化・開始までは可能。worker依存項目は未実施とする。
8. workerが追加できた場合、`Dockerfile.worker`、空Start command、表のworker値を設定。
   idle時のworkerは起動時1回の確認だけで待機。providerで確認した内部originだけをAPIへ追加する。
   `http://worker:8091` などを推測入力しない。秘密値は端末内で同値を設定する。
9. 全設定を整えてから「30分の試験を一度だけ開始」→ `active` と固定期限を確認する。
   「共有試験を開始」→workerだけ再起動→結果を手動更新。
   `row.worker_hash`なしはworker/DB未観測であり、共有不可とは判定しない。
   workerの観測があり `worker_saw_api=false` / `bidirectionalShared=false` なら共有不成立。
10. 「認証付き内部HTTPを試験」（最大3回）。未設定・到達不能・署名検証失敗を区別する。
    公開URLでのpassを内部経路のpassにしない。内部HTTP失敗だけでDB不可と判断しない。
11. 永続性は各partを再起動してboot ID変化とmarker hash保持を比較する。両方確認できなければ未確認。
    「90秒のDB観測区間」を一度開始→workerだけ再起動→APIだけ手動停止。
    worker Runningを確認し、停止時刻を記録。API再開後、同じSafariタブで結果を更新・JSON保存。
    部分停止ができなければこの試験は未実施。アプリ全体の停止で代用しない。
12. 手動停止中のDB書込み結果は **自動sleep試験の合格ではない**。自動sleepの検証は別の承認/観測として扱う。
    自動ログイン・ダミーアクセス・自動リロードは行わない。provider停止制限に達したら終了。

期限前に開始しても再起動で延長されない。期限後は結果取得だけが可能。
試験やschemaの再作成で繰り返し延長する手順にはしない。

## 画面確認をまとめて依頼する項目

秘密値を隠した画面/文面だけでよい。接続URLや秘密値の提出は不要。

- 作成後の実API origin、今回専用DBである表示とDB実名（実名は端末上で設定すればよい）。
- Settings > Partsに「追加」があるか、Dockerfile・part別環境変数・個別restart/stopの有無。
- APIとworkerへの同じDB注入、workerの管理画面上の内部origin/port。
- Settings > Filesのkept folder、同一appの両partが同じvolumeをmountできるか。
- アカウントの残無料期間、予約メモリー/DB/保存容量、DBのTLS仕様・信頼CA・login権限。

資料のcompose対応だけでは、この既存単一part appへの追加可否は確定しない。
このゲートが未解決の間はworker追加完了・共有成功とは報告しない。

## 失敗表示

`DATABASE_URL_MISSING` / `DB_CONFIRMATION_REQUIRED` / `DB_IDENTITY_MISMATCH` は設定段階。
`SETUP_REQUIRED` は未初期化。`DB_NOT_EMPTY` は既存データ保護による拒否。
`PROBE_SCHEMA_UNVERIFIED` / `SESSION_ID_MISMATCH` は既存schema/runの不一致。
`DB_PERMISSION_DENIED` / `DB_TLS_FAILED` は権限/TLS。
`STORAGE_UNAVAILABLE` はmarker読み書き不可（DB接続不可とは別）。workerログもstorageとDBを区別する。
それ以外は秘密保護のため `DB_OR_MARKER_UNAVAILABLE` とし、provider側のDB readyとFiles設定を確認する。
内部HTTPは未設定なら `not-configured`、到達/timeout/不正応答なら `unconfirmed`、
到達して署名等の条件が揃わないなら `fail`。秘密情報を含むログは共有しない。

## 結果保存後の削除（今回未実行）

JSONとproviderの時刻メモを端末へ保存し、両partを停止する。
今回作成した専用app/worker/DBとkept folderだけを管理画面で削除する（削除は別承認）。
app削除はそのファイルを消すため、他appのFilesや既存DBを選ばない。
DBを残してschemaだけ消す必要がある場合は、ローカル管理用 `admin.mjs --drop-probe-schema`
を明示実行する。実DB名と所有schema/versionを再照合し、専用schemaのみDROPする。
CLIの実行手段がないiPhoneでは、未確認のshellを案内せず今回専用DB全体の削除を使う。
`cleanup.mjs --writers-stopped` はローカルmarkerだけの補助ツール。自動実行しない。
外部image/build履歴の削除/保持期間はprovider画面で確認する。

## ローカル検証

`npm ci --ignore-scripts --prefix server/connection-probe` の後、同フォルダーで `npm test`。
PGliteはrootの開発依存。別配置なら `PROBE_PGLITE_MODULE` にmodule pathを渡せる。
ネイティブ試験はローカルの空DB限定で
`AXFLUXO_PROBE_TEST_DATABASE_URL=postgres://...@127.0.0.1:port/axfluxo_probe_local npm test`。
TLS非使用はこのローカル試験だけ。実行結果・制約は `VALIDATION.md` を参照。

## commit/push

変更対象はこのフォルダー内のみ。main、Pages、既存PR、動画MVP、ローカル書き出しは変更しない。
commitもpushも未実行。承認対象はこの試験修正のcommitと
`test/blitz-connection-probe` へのpush。pushはBlitzのbuild/自動公開を起動し得て、
接続済みappがあれば再デプロイ・build枠消費を伴う。GitHub連携なしでも自動更新設定に注意する。
今回はその実設定を操作していないため、pushを無害な保存操作として扱わない。
