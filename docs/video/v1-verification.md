# 動画V1検証記録

2026-11-01 JST。Node 24.19.0 / npm 11.9.0。基準mainはAPIとfetchの両方で `367fb02570b4782aa5f51e892718fc473b376c59` と再確認。V0 `a19f2b6` を引き継ぎ、branch `feat/video-v1`。AGENTS.mdなし。未マージPRはdraft #8のみで、全12変更パスを再確認し、固定入力/上流実行/作業版復帰と変更パスの重複なし。詳細契約は [server/README.md](../../server/README.md)。

| 検証                                                | 結果                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| npm ci（lockfileからクリーン再構築、offline cache） | 成功、443 packages。既存の直接依存versionは変更なし                                                                |
| npm run typecheck                                   | 成功                                                                                                               |
| npm run lint                                        | 成功、警告0                                                                                                        |
| npm test                                            | 19ファイル / 182件成功。既存V0まで157件＋V1追加25件、skipなし                                                      |
| API統合（PGlite実PostgreSQLエンジン）               | 16/16成功。ローカル永続DBでSQL/middleware/JWT/role/RLSを実行                                                       |
| API統合（通常のPostgreSQL 18.6、複数接続）          | 同じ16/16成功。本番postgresDatabase adapterで実行                                                                  |
| サーバー設定試験                                    | 3/3成功。既定受付停止、予算未設定、TLS有効、不正設定のsecret非表示                                                 |
| ブラウザークライアント単体試験                      | 6/6成功。token更新のthrow/error応答、single-flight、401後1回再送、同一body/key保持、状態の区別                     |
| 独立server build                                    | 成功、work/video-server/api.mjs。設定secretを埋め込まない                                                          |
| 独立server HTTP smoke                               | 成功。built serviceをloopback起動し、未認証GETが401/AUTH_REQUIRED                                                  |
| 静的export root                                     | 成功、静的routeのみ（独立した開発者診断画面を含む）                                                                |
| 静的export /axfluxo/                                | 成功、既存basePath契約保持                                                                                         |
| 既存Supabase認証E2E root・/axfluxo/                 | 各PC/スマホChromium合計10/10。認証API mock、実Supabase通信なし                                                     |
| 新規表示E2E Chromium                                | 1/1成功。期限切れ/権限なし/待機/保留/失敗の区別、4DB sentinelと既存認証storage保持、pageerrorなし、raw error非表示 |
| 静的診断画面E2E root・/axfluxo/                     | 各PC/スマホ2/2。API未設定時の保留表示・通信なし・basePath付きroot link                                             |
| 新規表示E2E WebKit                                  | 未実行。公式browser配布先のdownloadが環境の許可host制限で403                                                       |
| git diff --check                                    | 成功                                                                                                               |
| 既存契約差分                                        | V0 schema/4DB/V0 developer DB、Supabase auth、Next設定、Pages workflow、既存文書・backup形式に変更なし             |
| フロント静的bundle                                  | server専用DB設定/role/JWKS verifier/pg driverの混入なし                                                            |

APIの否定系は未認証・不正署名・issuer/audience/expiry/nbf/iat・一般userのmetadata昇格・membership失効/期限切れ・失効後の冪等再送・別ownerのread/retry/cancel/原本・owner_idのbody混入を含む。RLSでowner条件を省いたSELECTも他owner行を返さず、membership昇格/予算上限変更/原本追加/output削除はAPI roleで拒否する。複合FKによる別ownerのoutput/pin参照拒否、原本UPDATE拒否、CASCADE FKなしも実DBで確認した。

冪等性は同owner同keyの再送/同時受付が同一結果であること、別内容/別操作は409、別ownerの同keyは独立することを確認。transaction途中のadapter例外とPostgreSQL trigger例外の両方で、job/pin/outbox/予約/audit/冪等台帳/残高がすべてrollbackする。通常PostgreSQLの複数connectionで予算60単位を2requestが競合し、202が1件/409が1件、予約60を確認した。retry/cancel、受付停止後のread/cancel、DB close/reopen後のjob/outbox/冪等結果の保持も検証した。

通常PostgreSQLはnpmから取得したテスト用バイナリをwork/へ展開し、専用loopback cluster/空の試験DBだけで実行した。既存DB/外部DBへ接続していない。PGliteも新しい一時ディレクトリを使う。migrationは試験DB内のみで、本番適用はしていない。

環境の既定sandboxではChromiumのsocket操作やesbuild install時のspawnSyncがEPERMになった。環境で提供されるnetwork権限をコマンドに適用して実行し、npm ci・browser・root/basePath buildが成功した。V0で記録したNext --showConfig出力取得エラーも、この実行条件では再現しなかった。既存設定や検証条件を緩める回避コードは追加していない。

WebKitはcdn.playwright.dev / playwright.download.prss.microsoft.comが403のため導入できなかった。ブラウザー試験とCI checksのWebKit実行を用意したが、CI自体は未実行。Chromiumの成功をSafari実機の証明にはしない。WebKit/実機Safariの確認、remote JWKS鍵rotation、TLS/実cloud接続、複数host負荷、worker/outbox配送/予算精算/output公開は未検証または次フェーズ。

新規cloud/契約、本番migration、push、merge、deployなし。rollbackはVIDEO_ACCEPTING=falseで新規/再試行受付を停止し、追加table・原本/output・pin/予約/outbox・既存データを保持する。
