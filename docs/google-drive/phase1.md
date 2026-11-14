# Google Drive Phase 1

対象: `freebuff/46d45a7d28e79173a72d4eeb` の `4f954f9e97742947e349bd2c55f468c6cf67301e`。
実装用ブランチ: `codex/google-drive-phase1`。本番デプロイ・DB変更・Google Cloud変更は実施していない。

## 構成と影響範囲

- `server/google-drive/security.ts`: state/PKCE、AES-256-GCM、無効化が既定のサーバー設定。
- `server/google-drive/google.ts`: OAuthとDrive APIへの専用アダプター。S3 MultipartStorageとは独立。
- `server/google-drive/router.ts`: 接続、解除、専用フォルダ、最大256 KiBのテストファイル操作。
- `server/db/migrations/010_google_drive.sql`: 追加テーブル3つとRLS。起動時の自動実行なし。
- `server/api/main.ts`: 既存public/responseフックへ合成。無効時は既存APIへそのまま委譲。
- `src/features/video/GoogleDrivePanel.tsx`: 既存 `/developer/video/` の権限確認後に表示。
- 既存Supabaseログイン、開発者membership、R2/S3、削除worker、動画upload/render経路は保持。

## サーバー環境変数

`.env.example` はダミーのみ。Googleの秘密値を `NEXT_PUBLIC_*` に設定しない。

| 名前                           | 値・用途                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_DRIVE_ENABLED`         | 既定 `false`。手動のDB準備・リリース時にAPI partのみ `true`                                                      |
| `GOOGLE_DRIVE_CLIENT_ID`       | 既存Web applicationクライアントID                                                                                |
| `GOOGLE_DRIVE_CLIENT_SECRET`   | Blitz API partの秘密の環境変数へ直接入力                                                                         |
| `GOOGLE_DRIVE_TOKEN_KEY`       | 暗号学的乱数32バイトを標準Base64にした値。API partの秘密の環境変数                                               |
| `GOOGLE_DRIVE_PUBLIC_ORIGIN`   | `https://axsis.prod.page`（末尾スラッシュなし）                                                                  |
| `GOOGLE_DRIVE_FRONTEND_URL`    | 公開フロントの正確な `/developer/video/` URL（basePathも含める）。ブラウザ確認後の固定戻り先。query/fragmentなし |
| `NEXT_PUBLIC_VIDEO_API_ORIGIN` | 既存フロントの公開API origin。上記と同じoriginにする。秘密値ではない。静的ビルド時に必要                         |

既存 `VIDEO_JWT_ISSUER`、`VIDEO_JWT_AUDIENCE`、`VIDEO_ALLOWED_ORIGINS`、`DATABASE_URL`、DB TLS設定、APIロール・membershipを維持する。`VIDEO_ALLOWED_ORIGINS`には実際のフロントoriginを含める。APIの公開originは `/api/integrations/google-drive/*` をNode APIへ到達させる必要がある。GoogleアカウントOAuthはSupabase認証を置き換えない。

鍵は信頼できる端末のパスワード管理アプリの暗号鍵生成機能、または安全な管理端末で `openssl rand -base64 32` から生成し、Blitzの秘密の環境変数欄へ直接設定する。チャット、GitHub、メモの共有欄に貼り付けない。鍵を紛失すると保存済み更新トークンは復号できない。単一鍵v1であり自動鍵ローテーションは未実装。バックアップと鍵更新は管理者の保守作業として計画し、必要時は再接続する。設定値やOAuth URLのクエリを画面共有・ログ収集しない。

既存の `compose.yaml` / `infra/video/Dockerfile` はAPI bundleと全migrationを梱包するため、追加のサービス・依存パッケージは不要。export-workerへのGoogle秘密値の共有は不要。Blitzの環境変数保存が再起動を伴う場合があるため、未リリースの現行版にはまだ有効化しない。

## API

すべての認証付きAPIは既存Supabase Bearer JWTと有効なdeveloper membershipを必要とする。ownerはJWTのsubから決定し、リクエストbodyのユーザーIDを受け付けない。

| メソッド・パス（prefix `/api/integrations/google-drive`） | 動作                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /connect`                                           | 一回限りの開始URLを返す。Googleトークンは返さない                                                                 |
| `GET /start?state=…`                                      | 10分期限の開始URLを消費し、事前に設定したAPI originのHttpOnly/Secure/SameSite=Lax Cookieを検証してGoogleへ303遷移 |
| `GET /callback?state=…&code=…`                            | Cookie/stateを検証し、一回限りで消費。PKCEでコード交換し、更新トークンを暗号化。専用フォルダ作成                  |
| `GET /status`                                             | 接続フラグとフォルダID。Google側の即時疎通確認ではない                                                            |
| `POST /folders`                                           | トークン更新と専用フォルダの作成・確認・再試行                                                                    |
| `POST /disconnect`                                        | サーバーの更新トークン消去、state無効化。Googleファイルは削除しない                                               |
| `POST /files`                                             | JSON `{operationId: UUID, base64: canonical Base64}`、最大256 KiB。01_Queueへアップロードし、直後に再取得して検証 |
| `GET /files/:fileId`                                      | 所有者DBに登録済みのreadyファイルのみ取得。サイズ・SHA-256一致後にBase64を返す                                    |

接続解除はローカル認可の解除であり、Google側のアプリ許可取り消しは行わない。必要なら利用者がGoogleアカウントのサードパーティ接続管理から取り消す。すでにGoogleへ送信された処理は切断後に完了する可能性があるが、後続操作は切断フラグ・世代チェックで拒否する。

テスト用を含め削除APIは提供しない。不要なテストファイルは表示された明示的なfile IDを確認して利用者がDriveで手動削除する。既存削除機能・workerからDriveは参照しない。

## 認証と並行処理

接続開始前のトップレベル `GET /prepare` でAPI originにHttpOnly/Secure/SameSite=Lax Cookieを設定し、同じ乱数を固定フロントURLのfragmentに返す。フロントはfragmentを履歴から除去し、ブラウザ結合用nonceだけをsessionStorageに一時保存する（Googleの認証トークンではない）。JWT認証付き `POST /connect` がそのnonceのハッシュをstateへ結合し、`GET /start` とcallbackの両方でCookie一致を要求する。開始URLだけを他ブラウザへ転送しても拒否する。第三者Cookieをfetchで送る必要はない。

stateとPKCE verifierは別々の256ビット乱数。DBにはstateのSHA-256、暗号化verifier、CookieのSHA-256のみ保存。コールバックはDB行ロック下で消費し、コード交換前にコミットするので、拒否やGoogleエラーでもリプレイ不可。期限は10分。開始URLは一回だけ開始できる。Cookieがない/別ブラウザ/別タブで上書きされた場合は接続操作からやり直す。

callbackでstateハッシュに一致する期限内・未使用行だけをRLSで探索し、その所有者のmembershipを再確認する。通常APIの全SQLは所有者設定とRLSを使用。更新トークンとPKCE verifierの暗号化にはowner+用途をAADとして指定し、別所有者・用途への流用を拒否する。

アクセストークンはメモリ上の操作スコープだけで使用し、DB・ブラウザ・ログに保存しない。各Drive操作前にrefreshを実行するため期限切れアクセストークンを再利用しない。refreshは接続行ロックで直列化し、更新トークンがローテーションしたら先にコミットして後続API失敗による巻き戻りを防ぐ。`invalid_grant` は接続フラグと暗号化トークンを消去し再接続要求にする。開始/解除は世代UUIDを変更し、古いcallbackの接続復活を拒否する。

Google accountはDrive `about.user.permissionId` で識別する。別Googleアカウントへの再接続は拒否する（元のアカウントを選び直す）。別アカウント移行の管理UIはPhase 1対象外。

Googleへの送信は固定HTTPS endpoint、リダイレクト拒否、各リクエスト5秒期限。生のGoogleエラー・SQL・トークンを返さず、固定エラーコードへ変換する。reverse proxy/APMでもAuthorization、body、Cookie、OAuth URLのquery（code/state）を記録しない設定が必要。

## フォルダ・ファイルの再試行と復旧

初回は `generateIds` で確保した3つのIDをDBへ**先にコミット**し、そのIDで `AxFluxo/01_Queue` と `AxFluxo/02_Completed` を作成する。並行要求もDBの確定IDを使用する。作成レスポンスの喪失・途中失敗でも同じIDで再試行するため新しいフォルダを増殖させない。名前による検索・他ユーザーファイルの採用はしない。appPropertiesで所有者・役割を検証する。フォルダ名の変更は許容する。

- 子フォルダの親IDが違う、ゴミ箱入り、フォルダ種別やappPropertiesが違う場合は `DRIVE_FOLDER_RECOVERY_REQUIRED`。
- ルート自体の移動は許容。子フォルダの親子関係が保たれていれば保存先として利用する。
- 404なら予約IDで作成を試す。完全削除済みID等の再利用がGoogle側で拒否されれば操作を止める。別IDの代替フォルダは自動作成しない。
- 利用者がDriveのゴミ箱から復元、子フォルダを保存済みルートIDの下へ戻し、「専用フォルダを確認」を再実行する。完全削除・権限喪失が復旧不能なら管理者による明示的な移行設計が必要（自動リセットなし）。
- 再接続してもDBのフォルダIDを維持する。解除時もIDとファイル台帳を残す。

ファイルもoperationIdと内容のsize/SHA-256をDBへ固定し、予約済みDrive IDでアップロードする。再試行は**同じoperationIdと同じ内容**を送る。別内容なら409。応答喪失時も新しいファイルIDを作らない。外部のファイル変更・削除・ID競合を検出したら整合性エラーや復旧要求で止め、置換や削除を行わない。UIの同一表示中のテスト再試行は同じoperationIdを使用するが、ページ再読込後の新規テストは新しいファイルになる。

容量不足は507、権限不足は403、レート制限/Google 5xxは503、認可失効は401。バックオフ後の明示再試行を想定し、無限自動再試行なし。小容量のBase64は既存HTTP制限1 MiB以内。大容量動画、multipart/resumable、動画export統合は次Phase。

## iPhoneでの設定・確認順

**このPRは未デプロイ。以下は手動リリース承認後の手順。現在の公開画面に新しいボタンはまだ出ない。**

1. SafariでGitHubのPRを開き、変更・テスト・未検証事項を確認する。この作業ではマージ/デプロイしていない。リリース作業は別途明示的に判断する。
2. SafariでGoogle Cloud Consoleを開く。必要なら「ぁあ」/ページメニュー →「デスクトップ用Webサイトを表示」。プロジェクト `axfluxo` を選ぶ。
3. 「Google Auth Platform」→「対象」/「Audience」でExternal/Testingと、自分の接続用Googleアカウントがテストユーザーとして登録されていることを確認する。必要なら利用者自身が追加・保存する。スコープはdrive.fileのまま。全Drive権限へ拡張しない。
4. 「クライアント」→既存Web applicationを選び、承認済みリダイレクトURIが `https://axsis.prod.page/api/integrations/google-drive/callback` と完全一致することを確認する。secretはチャットやGitHubへコピーしない。
5. SafariでBlitzのAxFluxoアプリを開き、API partと現在のデプロイブランチを確認する。新規branchを自動デプロイ対象に変更しない。設定変更が自動再起動/デプロイになるか確認し、リリース承認まで保存しない。
6. 承認されたリリース担当者が、追加migration `010_google_drive.sql` を既存migration台帳を確認して手動適用する。DBが001〜009適用済みであること、APIログインが `axfluxo_video_api` を継承することを確認する。既存 `node /app/migrate.mjs` は未適用migrationを**すべて**実行するため、対象を確認せず実行しない。iPhoneのBlitz画面だけで管理SQL/CLIが使えない場合は、担当者の安全な管理環境で実施する。本実装は自動適用しない。
7. BlitzのAPI part →「Environment」で上表のGoogle変数を設定する。Client SecretとTOKEN_KEYは秘密/非公開欄に直接入力し、パスワード管理アプリへ保管する。実際の画面名・秘密欄・再起動の挙動はこの作業では未確認。workerに設定しない。
8. 承認後に担当者がコードをリリースし、`NEXT_PUBLIC_VIDEO_API_ORIGIN` が正しいフロントも更新する。外部からcallback/startパスが到達できること、proxyのquery/headerログが無効化されていることを確認する。
9. iPhone SafariでAxFluxoを開き、**既存Supabaseログイン**を行う。有効な開発者権限のアカウントで `/developer/video/` を開き「開発者権限を再確認」→「Google Drive連携」の「接続状態を確認」。
10. 「接続・再接続」をタップ。ブラウザ確認後AxFluxoへ戻るので、「接続・再接続」をもう一度タップする。同じSafariタブでGoogle画面へ進み、テストユーザーのGoogleアカウントを選択してdrive.fileへのアクセスを許可する。Testingの警告・組織ポリシーで進めない場合は設定を確認する。callbackを別ブラウザで開かない。
11. `DRIVE_CONNECTED` の表示後、Safariの戻る操作でAxFluxoへ戻り「接続状態を確認」→「専用フォルダを確認」をタップ。DriveアプリでAxFluxo/01_Queueと02_Completedを確認する。
12. 「テストファイルを保存・取得・検証」をタップ。サイズ・SHA-256の一致とfile IDの表示を確認する。「接続・再接続」後もフォルダが増えていないことを確認する。
13. 必要なら「接続解除」。Driveのフォルダとテストファイルが残ることを確認する。テストファイルを削除するなら表示された対象IDを確認し、Drive側で手動操作する。

External/Testingのdrive.file連携では、Googleのテスト用更新トークンが通常7日で期限切れになるため再接続が必要になる。テストユーザー制限・同意画面・実際のiPhone Safari挙動はGoogle実アカウントで別途確認する。

## 検証

Googleへの通信は全てモック。DBテストは既存testEngineのPGlite PostgreSQLで実際のmigration/API role/RLSを実行する。任意の専用loopback PostgreSQLでは `AXFLUXO_TEST_POSTGRES_URL` による既存testEngineも使用可能だが、今回外部/本番DBは使用していない。

実アカウントの同意・Drive API仕様との相互運用、Google側の実際のPKCEコード拒否、Testing期限切れ、iPhone Safari Cookie/ITP、Blitz secrets・callback公開経路・本番DBロール、マルチ接続PostgreSQLによる負荷/競合テストは未検証。モックテストの成功はそれらの実機検証を代替しない。

### 実行結果

| コマンド                                                                                                | 結果                                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm test`                                                                                              | 最終コードで55ファイル・447件成功。既存認証・R2/S3テストを含む                      |
| `npx vitest run server/tests/google-drive.test.ts tests/storage.test.ts server/tests/cloud/api.test.ts` | 38件成功（Drive 17件を含む）                                                        |
| `npm run test:video:browser -- google-drive.spec.ts --project chromium`                                 | モックAPIで2件成功。ブラウザ上のSHA-256・同一operationId再利用・解除・nonce受け渡し |
| `npm run typecheck`                                                                                     | 成功                                                                                |
| `npm run lint`                                                                                          | 成功                                                                                |
| `npm run build`                                                                                         | フロント静的ビルドとpostbuild成功                                                   |
| `npm run build --workspace server`                                                                      | Node API bundle成功                                                                 |
| `git diff --check`                                                                                      | 成功                                                                                |
| WebKitの同じ画面テスト                                                                                  | 実行ファイル未導入で起動できず。追加取得もCDNが403 `Domain forbidden`。未検証扱い   |

Google実アカウント、Blitz環境変数保存、公開callback、本番DB migration、デプロイは実行していない。上記成功範囲では既存機能への回帰は検出されていない。
