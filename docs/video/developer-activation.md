# Developer Studio 段階有効化・公開導線・安全性検証

2026-11-03 JST。調査元main `279701a88f21e49ed47b868af41e89ab2e76cab0`。
PR #9はmerge済み、Pages deployと公開E2E118件は成功している。
ただし動画機能の本番有効化とは別で、従来の全flagは未設定＝OFFだった。
`v7.md` / `v7-verification.md`は当時の実装・検証記録として維持する。
PR #8は未マージ（head `6b638020994fd94d78b9a97a1772b6599ff531c5`）。固定入力・上流準備・作業版復帰の実装には触れず、WorkspaceShellの入口だけを変更する。
祖先・repositoryに適用対象AGENTS.mdは見つからなかった。README、ADR 004/005/006と動画実装を確認。

## 表示されなかった原因と変更境界

1. WorkspaceShellの入口は `NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED=true` の時だけ出る。
2. 各editorにも独立したOFF flagがあり、親flagだけでは開かない。
3. Pages workflowはSupabaseの公開設定だけを渡し、動画flag/API originを渡していなかった。
4. Developer Studioが完成動画一覧と結合されており、outputs用backendなしではツール選択へ進みにくかった。
5. 直接URLを開く際に各editorをmountする前の共通認可ガードがなかった。
   All Versionsの初回権限確認失敗時にbrowser sessionのownerへfallbackする処理もあった。

変更は共通認可境界、別タブ入口、既存2editorの選択、サービス設定確認、公開設定の配線に限定。
既存画像Studio/Workflow runner、画像LibraryRef、上限、Undo/Redo、backup・文書形式、
既存4 IndexedDBと`axfluxo-developer` v1のschemaは変更しない。新migrationは作成しない。
初回認可失敗時のowner fallbackを取り除き、ブラウザだけで開発者に昇格させない。

## 認可と静的hostingの境界

Pages上のHTML/JSそのものは公開ファイルで、HTTPレベルの非公開配信ではない。
静的HTMLを401/403で返す保護が必要なら、認証proxy等の別hostingが必要（本作業では作成しない）。
直接URLでも未認証/一般userにはeditor・ローカルproject・素材をmountしない。
サーバーの `GET /v1/developer/me` 成功だけがUIを開く条件であり、flag・email・
user metadata・localStorage・URL queryは権限にならない。

既存APIはJWT署名（ES256/RS256、JWKS）・issuer・audience・exp・iat・sub・roleを検証し、
private DBの `developer_memberships.active` / `expires_at` を毎回確認する。
素材・folder・upload・job・project・outputの各APIにも既存owner検証とRLSがあり、
frontendガードを迂回してAPIを直接呼んでも認可を省略できない。
新しい `GET /v1/developer/services` も同じ認可後のread-only操作で、
schemaの有無、API設定、ownerのquota/budgetだけを返す。秘密、object key、URLは返さない。

既存Supabase Accountとsession storageを再利用。初回・再読込・auth event・前景復帰・onlineで再認可し、
前景では60秒毎にも確認する。refresh失敗・403・接続不能は編集UIを閉じる。
手動再確認や同じownerの一時的な接続失敗ではeditorをhidden/inertにして状態を維持し、権限再確認後に復帰する。
定期的な背景チェックは直前の認可表示を保ち、失敗時に閉じる。確認のたびにナビゲーションを出し入れしてcanvasを動かさない。
同じownerのSIGNED_IN再通知・token更新はserverへ再確認し、未保存editorを作り直さない。
ログアウト・owner切替・権限拒否では旧ownerのeditorをmountし続けない。DBは削除しない。
未送信FNF range/譜面名は従来通りメモリーのみで、再読込時の自動復元はしない。

入口・ツールは44px以上の操作面で別タブを開く。元Workflowをnavigationで置換せず、
未適用画像編集のDOM・文字・編集継続を試験する。戻る時は元のタブへ切り替える。
別のWorkflowを開く必要がある場合も専用リンクは別タブ。

## Phase A / B — まず必要な実設定

| 項目       | 必要な実値・作業                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 認可API    | 実在するHTTPS origin。path/query/credentialsを含めない。TLS reverse proxyの背後で既存standalone Node APIを起動                    |
| JWT        | `VIDEO_JWT_ISSUER`（既存Supabaseのauth/v1）、`VIDEO_JWT_AUDIENCE`。実projectのJWKSと署名方式を確認。HS256を無断で許可しない       |
| private DB | `VIDEO_DATABASE_URL`。専用非superuser loginとAPI role、TLS。service roleやDB秘密鍵をbrowserへ渡さない                             |
| membership | 管理者が正規Supabase user UUIDを確認し、`developer_memberships`へactive/必要なexpiryを登録。GitHub名やuser metadataから推定しない |
| migration  | A/Bの認可は最低001。すべてreview用で自動適用しない。管理者が対象DB・backup・権限を確認して別途適用                                |
| CORS       | `VIDEO_ALLOWED_ORIGINS`に `https://axsisaxsis0807.github.io` 等の**origin**を明示。`/axfluxo/`等のpathを含めない                  |
| 公開auth   | 既存`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`を維持。serverのJWT projectと一致させる                    |

001だけの認可APIでも、正規開発者は編集UIを開ける。
All Versionsは名前・デザイン・手順UIとowner別端末保存、FNFはtemplate・username編集と端末保存を利用できる。
素材が未準備なら音声/動画の選択・trim・波形・全長previewは使えない。
cloud project同期やFNF cloud設定が未準備なら呼ばず、保存済みと表示しない。
server-generated文字画像・fontや全長renderは別のserver準備が必要で、browserだけで代替しない。
schema/実行snapshot・固定font hash・renderer version・60fps/us契約は維持する。

### 公開flag（権限ではない）

| Pages repository variable            | 初期値 / 効果                                     |
| ------------------------------------ | ------------------------------------------------- |
| NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED | false。trueでもserver認可成功まで入口は表示しない |
| NEXT_PUBLIC_ALL_VERSIONS_ENABLED     | false。親flag+認可成功後だけ既存AV UIを開く       |
| NEXT_PUBLIC_FNF_SHOWCASE_ENABLED     | false。親flag+認可成功後だけ既存FNF UIを開く      |
| NEXT_PUBLIC_VIDEO_PREVIEW_ENABLED    | false。親flag+認可+preview設定が必要              |
| NEXT_PUBLIC_VIDEO_API_ORIGIN         | 空。既存の本物のHTTPS API originを指定する        |

Pages workflowへvariablesを渡す配線を追加したが、repository variablesそのものは変更していない。
ON buildでAPI originや公開authが不足/不正なら`prebuild`で失敗し、架空の値で公開を進めない。
OFFでも、与えられた公開設定にuserinfo・query・秘密鍵等を混ぜないよう検査する。flagをOFFにしても公開bundleに埋め込まれる値が秘密になるわけではない。
ON公開前には実APIへ匿名OPTIONS/GETと不正token GETを送り、明示CORS・401・no-storeを確認する。
この検査は実JWTでの正規開発者/一般userのmembershipやDB接続・worker稼働の証明ではなく、その受入確認は別途必要。
テスト内の`.test` API・合成sessionはPlaywrightのrequest mock専用で、本番値として設定しない。
本作業で実際にONにするのはローカル/CIの検証artifactだけ。本番flagは全てOFFのまま。

## Phase C — 原本・書き出し・同期

| サービス               | 追加で必要な準備                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cloud Library / upload | 002、owner quota、非公開R2原本bucket、`CLOUD_R2_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`、probe worker、`CLOUD_UPLOADS_ENABLED`                    |
| proxy / waveform       | 003、derivatives worker、`CLOUD_PREVIEW_ENABLED`とpreview予算設定、Safari proxyのPTS mapping / 実byte検証                                                  |
| render                 | 004、Linux Docker worker、既存seek可能disk・CPU/RAM/PID制限、render並列1、`VIDEO_UNITS_PER_FRAME`、owner予算/quota、`VIDEO_ACCEPTING/VIDEO_RENDER_ENABLED` |
| AV cloud同期           | 005、revision/If-Matchと409両版保持。font/renderer固定・server文字画像の実接続確認                                                                         |
| FNF設定                | 006、`VIDEO_FNF_ACCEPTING`（共通受付flagと両方が必要）。未送信range/譜面名はcloud projectへ保存しない                                                      |
| 完成物                 | 007、専用`VIDEO_OUTPUT_*` bucket/資格情報、`VIDEO_OUTPUTS_ENABLED`、private signed access URL                                                              |

サービス表示は「設定確認済み」であり、workerの稼働やprovider接続、job成功を保証しない。
実接続の合成mediaによるupload→probe→proxy→render→decode/hash確認を行ってから受付をONにする。
フォルダのmetadata移動、原本immutable、参照version/hash固定を維持し、既存画像のcloud移行は明示操作だけ。
quota/予算/価格が不足する場合はrenderを受付可能として表示しない。資源は無断増設しない。

## Phase D — 写真保存・削除・通知

V7の1本ずつ保存・小File共有/巨大MP4のFiles fallbackを使う。
share成功・download開始では保存完了にせず、写真アプリ確認後の明示操作だけで削除ticketを作る。
削除workerは専用output bucketだけのread/delete資格情報と`VIDEO_DELETE_DATABASE_URL`を使う。
`VIDEO_DELETE_BUCKET`は原本bucketと分離し、原本資格情報を注入しない。
`VIDEO_DELETE_ACCEPTING`と`VIDEO_DELETE_WORKER_ENABLED`は実機と実providerの確認後に別々にONにする。
未確認完成物・原本・共有一時物・jobは保持し、期限による削除を追加しない。

Pushは`VIDEO_NOTIFY_DATABASE_URL`、`VIDEO_VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`、
`VIDEO_PUSH_ENABLED`、ホーム画面PWA・明示タップの許可・購読保存が必要。
秘密鍵はworkerのみ。通知失敗でもrender結果を維持する。SWのscope/basePath/無cache契約も維持。

## この作業時点の準備状況

管理環境の現在のsecret/runtime variable/outbound identity bindingsは空で、
実Developer API origin・DB接続・正規開発者UUID・R2・worker/VAPID設定は提供されていない。
repository外のリソースが存在しないと断定したものではなく、利用可能な接続と準備状況を確認できていない。
GitHub Appの利用可能な読み取り範囲から、Actions secrets/variablesの値は取得していない。
公開workflowに以前これらのvariablesを渡す配線がなかったことは確認済み。
実値の代わりにテストfixtureを本番へ設定しない。

このため、実開発者アカウントでの本番ログイン・サーバー認可・実cloud I/Oは未検証。
本番でDeveloper Studioが利用可能になった、という完了扱いにはしない。
まず既存のAPI URL/管理接続先と、登録済みのdeveloper membershipを指定する必要がある。
新しい有料hosting/DB/R2リソースや契約が必要なら、具体的な構成と費用をレビューして別承認を得る。

## 検証と公開方針

- 既存E2EはOFFのroot/basePath regression artifactで全件実行し、削除・skip・期待値緩和をしない。
- ONでは別artifactで、未認証・一般user・metadata/localStorage昇格拒否・直接URL・正規開発者・権限失効・token更新失敗を検証。
- Pages uploadはrepository variablesで改めてbuildしたartifactだけを使う。テスト用ON artifactを公開しない。
- 公開後はAPI未設定のOFFサイトに従来の全E2E、ONまたはAPI設定済みサイトに専用access suiteを実行。OFF回帰をONの期待値へ書き換えない。
- browserの認可応答mock試験と、本物の署名付きJWT/membership/RLSを通すserver統合試験を区別する。
- iPhoneサイズのChromiumは実機Safariではない。写真保存、Push、OSタブ破棄、PWAからの再ログイン、IME/キーボード/横向きは実機未検証。

専用branchとPRのみ。main直接push、自動merge、本番deploy、cloud作成、本番migrationは行わない。
既存`pages.yml`は**mainへのmergeで自動deploy**するため、merge/deployにはユーザー承認が必要。
rollbackは公開flagsをOFFにして再buildし、必要ならAPI受付/workerを独立停止。既存DBと素材は保持する。
結果と変更ファイル一覧は[activation-verification](developer-activation-verification.md)。
