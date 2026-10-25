# Workflow First WFR-6 — PR #5受け入れ検証

記録日: 2026-10-25 JST。対象はPR #5のWFR-1〜5実装の検証と最小修正。
大きな新機能・再構築・DB形式変更・Merge・本番デプロイは行わない。
実機iPhone Safariは利用できず、実装側検証と実機受入を分ける。

## 開始状態・検証計画

- GitHubで確認した対象: PR #5、open、draft=false、未Merge。
  branch `feat/workflow-first-refactor`、開始HEAD `0327e19d5e85037e67652baa229ce6288a701045`。
- base main `26ee040e3c5093807c69b3daa4484aaa10955a9d`。
  local/FETCH_HEAD一致、作業ツリーclean、適用AGENTS.mdなし。
- 開始HEADの [CI #50](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40199832649)、
  [Pages PR #25](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40199832555) は両方success。
- PR変更ファイル63、ADR 003/004、WFR-5結果、実機手順、既存unit/E2E、
  保存・画像取込・Canvas解放経路、依存/配信設定を確認してから作業。
- Node 24.19.0、npm 11.9.0、Linux/system Chromium。
- 順序: 保存と画像取込中離脱→ノード隔離/復旧→旧機能/配信回帰→モバイル/資源解放。
  保存試験は新しい一時browser contextとfake-indexeddbのみで行い、既存ユーザーDBを変更しない。
  root/basePath/flag無効の静的buildを別directoryへコピーし、試験中に上書きしない。
- 開始時のtypecheck/Lint/unit75件は成功。以下は修正後の再検証結果を示す。

## A. 検証した機能

| 項目                          | 検証と証拠                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow中心の初期画面/旧入口 | 新しいcontextからWorkspace、旧Studioへ切替、保存して戻る。既存共有エディター/旧canvas回帰も維持                                                             |
| Phase 1操作                   | 追加/削除/接続/解除、fanout、型・循環制約、移動、パン/ピンチ、1→2→1指、Undo/Redo、詳細、復旧を既存E2Eで確認                                                 |
| 画像編集の完全導線            | 新規A→JPEG/PNG読込→文字/図形→適用→戻る→B→reload→A再開。DBと実UIの両方で復元/独立性を確認                                                                    |
| 取込中の離脱                  | デコードを保留し、戻るボタンとブラウザ戻るでセッション維持、状態は取込中。タブcloseのbeforeunloadを実際に確認して取消。取込解放後に適用・再開して画像を確認 |
| ノード保全                    | 独立複製、削除Undo、未適用作業版、出力更新必要、選択ページ、上流未生成、入力変更時の限定差し替えを既存新UI E2Eで確認                                        |
| 保存/復旧                     | CAS両対象の原子的適用、quota/abort、保存世代、blocked/versionchange、保存再試行、2タブ競合の別コピー、破損/未知版、ZIP参照/hash検証をunitと既存E2Eで確認    |
| 画像整合性                    | JPEG原本の入力bytes SHA-256とDB内原本hashが一致し、描画BlobはPNG。別PNGとの共存とreload後の不変を確認                                                       |
| 失敗からの回復                | 不正PNG・20,000pxヘッダー・decode失敗で既存文書/画像DBが不変。正常PNGを再取込して保存/reloadに成功                                                          |
| 資源                          | Canvas確保/描画/encode失敗と正常時の解放をunitで確認。実ブラウザで3回開閉後、Konva Canvasが0、追跡対象Object URLが0。OS全体のメモリ測定ではない             |
| モバイル                      | Chromium iPhone 13 emulation、パネル、タッチ接続/移動/ピンチ、focus、縦横相当viewport変更時の文書不変。物理キーボード/実IME/Safari背景挙動とは区別          |
| 旧機能                        | 旧Studio、template/variables/pages/crop/text/shape/layers、PNG/JPEG/ZIP、認証callback/guest、Workflow v1を既存試験から削除せず実行                          |

補助性能観測: 専用の一時desktop browser contextで文章ノード1個から200個の
新UUIDノードを作成し、そのcontextのDBだけへfixtureを保存して再読込した。
200ノードDOM表示まで2,835ms、自動整列からDB保存完了まで1,843msの1回観測。
Chromium 1440×1000、画像/辺なし、他テスト並行中。予算適合や実機性能の保証ではない。
生成fixtureはユーザー作品へ書き込んでいない。実施方法は追加・200件clone・reload・
DOM件数・自動整列・DB位置更新完了をawaitして計時（ログwfr6-graph-smoke）。

## B. 最小修正・変更ファイル

修正/追加テストcommit: `9b757764f949623a7bee8600423381f4b397d980`。

- `src/services/assets.ts`: `importImage`の一時Canvasが、getContext失敗・drawImage例外・
  toBlob(null)で解放処理を通らないことをコード確認。try/finallyでサイズを0に戻し、
  Canvas確保不能を明示エラーにした。正常時の画像/原本/hash/寸法/保存形式は維持。
  DB書込前に失敗する経路で、既存作品の上書きや消失は伴わない。
- `tests/image-import.test.ts`: 上記3失敗経路と正常時のCanvas/decoder URL解放、JPEG原本/PNG描画の区別を4件追加。
- `tests/e2e/workflow-first-acceptance.spec.ts`: 上記の混合素材完全導線と不正/過大/decode失敗復旧をdesktop/mobileで4件追加。
- `tests/e2e/workflow-first-safety.spec.ts`: 元の取込保留試験を強化し、ブラウザ戻るとtab close警告/取消後の保存再開を追加。
- `docs/manual-tests/workflow-first-iphone.md`: WFR-0/1時点の古い説明を修正し、現行UIでの21項目、前提URL/SHA、期待結果、停止条件を記載。
- この結果記録とREADME: WFR-6の判断材料へのリンク。ADRやWFR-1〜5の履歴は書き換えない。

追加テストを作る過程で、Nextのroute-announcerとアプリ通知を同じalert locatorが指したため、
セッション内に限定した。取込中reloadを取り消した後のPlaywright navigation待ちが
完了しない検証方法は、`close({runBeforeUnload:true})`とdialog取消で実際のタブcloseを
検証する方法へ補正した。期待値・timeoutの緩和や既存試験の削除/skipは行っていない。

9b75776のGitHub通常CI #52は成功したが、Pages PR #26は既存mobile端子タップ試験1件が
失敗（他81件成功）。CI artifactのtraceを取得し、全体表示直後の端子座標取得時は
viewportがidentity、その直後にtranslate(140.025px,18px)/scale(0.458128)へ変わって
いたこと、誤タップにより素材入力の詳細が開いていたことを確認した。
試験待機補正commit: `a35c7ef959d44d2dd7fca2e02e967bae46b6cb28`。
`workflow-review.spec.ts`で座標計測前のtrial actionabilityを待ち、最初のタップで
clickconnectingになることも明示検証する。アプリの接続処理・期待接続数は変更しない。

root全件初回は81/82件成功で、固定入力再開試験の隠しfile input注入が
ノード追加のinert障壁終了前に行われていた。取込ボタンのtrial actionabilityを待って
からファイルを渡すよう補正した（通常利用で押せない状態をテストが直接操作していた）。
basePath全件初回は82/82件成功。補正後の反復と最終全件結果を以下へ記録する。

## C. コマンド・最終結果

runtime修正HEADは9b75776、試験待機補正HEADは
`a35c7ef959d44d2dd7fca2e02e967bae46b6cb28`。build後の変更は試験/文書のみ。

| 検証                                                   | 結果                                                   |
| ------------------------------------------------------ | ------------------------------------------------------ |
| npm run typecheck                                      | 成功                                                   |
| npm run lint                                           | 成功、warnings 0                                       |
| npm test                                               | 79件成功、11ファイル（既存75+追加4）                   |
| npm run build                                          | root成功                                               |
| NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build           | 成功                                                   |
| NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false npm run build | 成功、独立した旧入口成果物                             |
| 新規受け入れ/強化した取込保留の先行E2E                 | desktop/mobile計6件成功                                |
| 待機補正した入力再開/タッチ接続反復                    | desktop/mobile各3回、計12件成功                        |
| root 全E2E                                             | 82件成功、desktop41 + mobile41、8.1分                  |
| /axfluxo/ 全E2E                                        | 82件成功、desktop41 + mobile41、8.1分                  |
| scripts/check-workflow-first.mjs                       | 全項目成功（旧JPEGコピー/PNG寸法/focus/flag rollback） |
| git diff --check                                       | 成功                                                   |
| GitHub通常CI/Pages PR                                  | a35c7efの両check成功                                   |

全E2E: `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3170/ npm run test:e2e`、
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:3171/axfluxo/ npm run test:e2e`。
共通のChromium desktop/mobile二構成。root/basePath/flag無効を別directoryで配信。
判定は実行workspaceの `wfr6-root-final-e2e` / `wfr6-base-final-e2e` /
`wfr6-delivery-unit` / `wfr6-extra` / `wfr6-waits-repeat` ログを用いる。
テスト数だけでなくA欄の操作と保存データを検証し、試験履歴の失敗もB欄へ記録する。

待機補正HEAD a35c7efの [通常CI #54](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40202354893)、
[Pages PR #27](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40202354734) はともにsuccess。
その後の最終記録commitは文書だけであり、最終HEADのcheck結果はPRのChecksと完了報告で確認する。
Pagesのdeploy/verify jobはPRではskipされ、本番deployを実行していない。

## D. データ互換性と影響

DB名/version/storeとserializerは今回変更なし。
旧Studio `axfluxo` v1、旧Workflow `axfluxo-workflow` v1、新 `axfluxo-workspace` v1を維持。
既存ZIPと新ZIPの形式・検証上限・コピー移行/新ID復元を変更しない。
原本JPEGと正規化PNGの区別は維持し、失敗時の一時Canvas解放だけを変更した。

旧保存/auth/document/crop/text/fonts、package/lockfile、Next/basePath、CI設定は
開始mainとの差分なしを再確認済み。v1 fixture/validatorを緩めていない。
コピー移行元のproject/assets不変、flag無効時の旧保存と新DB保持は追加ブラウザscriptでも確認済み。

切り戻しは `NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false npm run build`。
新DBを消さず、自動逆変換しない。旧版ではv2を読めず、新版再有効化か対応backupで回復する。

## E. 未解決・未実施

- 今回検証した範囲で、未解決の重大な保存破損/ノード間混入/旧機能回帰は確認されていない。
- iPhone実機機種/iOS/Safariの実測結果なし。実IME、VoiceOver、ソフトキーボード、
  Safari背景移行/OS強制終了、実端末quotaは未検証。
- Playwright WebKit、最大画像/多数画像での実機ピークメモリ・長時間稼働は未検証。
  Canvas/URL解放の確認だけでiOSのメモリ安全性を保証しない。
- 認証E2Eはmockによりcallback/ゲスト継続を検証。実メールの受信や実ユーザーアカウント操作は未実施。
- 新ZIPの上限、セッション内のみのUndo、JPEG白背景、ノード出力は1ページPNG、
  自動GCなし等のWFR-5制約は維持。DAG/SNS/クラウド同期は追加しない。
- 未確定入力や取込未完了の状態でOSがSafariを強制終了した場合まで永続化を保証しない。
  保存完了の確認とbackupを運用上区別する。

実装側の自動受け入れ検証は完了。実機受入完了を意味しない。

## F. Merge判定

**条件付きMerge候補。**
実装側の最終自動検証と通常CI/Pages PR検証の成功を前提とし、
iPhone Safariの主要操作・保存/再開・IME/キーボード・回転/背景復帰・旧作品保全の
実機受入、およびユーザーの明示承認をMergeの条件とする。
実機の不具合が見つかればMergeを止め、再現条件を記録して最小修正/再検証する。
実装側検証完了と実機受入完了を混同しない。
Merge・自動Merge・本番デプロイは行わず、ユーザーの承認待ちとする。

## G. iPhone実機受け入れ手順

[具体的な21項目の操作・期待結果](workflow-first-iphone.md)を使用する。
PRのSHAと一致した承認済みHTTPS検証buildが前提。公開本番旧版で代用しない。
端末/iOS/Safari/SHA/URL/縦横/結果/再現条件を記録し、データ消失・誤保存表示・
混入・主要タッチ操作不能があればMerge停止とする。検証環境の公開作業や本番設定変更は本作業では実施しない。
