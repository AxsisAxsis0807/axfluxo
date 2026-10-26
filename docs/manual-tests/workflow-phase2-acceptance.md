# Phase 2 最終受け入れ・Merge準備（2026-10-26 JST）

対象は既存の [PR #6](https://github.com/AxsisAxsis0807/axfluxo/pull/6)、branch `feat/workflow-phase-2`。調査開始HEADは `97d60df77fbd8fb46d2534a7afd57443d2f80b12`、fetch済みmain/baseは `15b51bfabce277ff040559a66616c0f255011ab6`。PRはopen/Draft、GitHubのmergeableはtrue、作業ツリーはcleanだった。古いHEADへのreset、Merge、mainへのpush、デプロイ、Phase 3実装は行わない。

この記録は[前回の実装検証](workflow-phase2-results.md)と区別する。Node 24.19.0/npm 11.9.0、AGENTS.mdは祖先・リポジトリ内に存在しない。package.jsonの正式コマンドを今回再実行した。依存バージョン・lockfile・既存DBのversion/store・旧文書形式は変更しない。

## 初期CIの観測と対応

- [CI #59](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40305388566): checks成功。npm ci/typecheck/lint/unit/build/E2Eは各stepがsuccess。
- [Pages #30](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40305388831): build jobはcancelled。ブラウザー依存パッケージ導入が19:11:53〜19:23:12 JSTの約11分19秒、E2E開始19:23:13、15分上限に一致する19:26:18にcancelled。セットアップ後の残時間は約3分で、全E2Eに必要な時間より短かった。ログにassertion failureの記載はない。deploy/verifyはskip。
- 依存導入と全E2Eを含むCI/checksとPages/buildのjob上限を30分へ変更する。Playwrightの各テストtimeout（60秒）、assertion、テスト数、実行対象は緩和しない。deploy/verifyの条件・権限・basePathは変更しない。
- 最終HEADのCI結果・URLはPR #6と本記録の最終結果欄を参照する。PRではPagesのdeployはmain限定条件により実行されない。

## 再現した不具合と最小修正

| 問題・再現条件                                                                                                                  | 原因と修正                                                                                                                                                                         | 回帰証拠                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 同じgraphで再実行した最新nodeがfailed/blocked/queued/running/cancelled/interruptedでも、画像編集入力に古い成功runの出力が現れる | Adapterが履歴走査で旧成功へfallbackしていた。最新の計算上同一ancestor runを基準とし、未確定・不成功ならundefinedで拒否。独立枝継続の確定成功は利用でき、過去の履歴自体は保持       | 6状態の再現テストは修正前に全件失敗、修正後合格                                         |
| 同一ミリ秒・端末時計の逆行で新runが旧runより古く並ぶ                                                                            | timestamp同値時のUUID順は実行順ではない。直近の永続化runを1件だけ読み、serialized host内でcreatedAtを単調増加させる。旧同時刻履歴の順序が曖昧なら自動採用せず、明示的な新runを要求 | 固定/逆行clockと旧同時刻履歴を検証                                                      |
| 画像プレビューを開いたまま欠損出力の別runを選ぶと、以前のrunの画像が残る                                                        | ResultのReact keyがportのみだった。run IDも含めてstate・object URLを分離し、再開時のurl/errorもreset                                                                               | 実ブラウザーで修正前に古いimg残留を再現。欠損結果はエラーとなり、別runのimgを表示しない |
| 旧node ID `__proto__` のsourceが固定snapshot/historyから失われる                                                                | 通常objectへの代入とZod recordのキー除去。参照辞書はnull prototypeで構築し、履歴辞書はown entryを型検証してキーを保持。cache参照はhasOwnで判定。旧IDをrename/変換しない            | 実行成功・元参照・IDB履歴roundtripを検証                                                |
| `-0` が `0` のcacheを誤利用する                                                                                                 | JSON.stringifyによる数値表現衝突。canonical keyで負のゼロを区別                                                                                                                    | 異なるkeyと負のゼロの実出力を検証                                                       |
| undefined/BigInt/循環objectでgraph検証が生のTypeErrorになる                                                                     | serialize前提を安全なGRAPH_INVALIDへ変換。素材・本文・tokenをエラーへ含めない                                                                                                      | 各入力の安全なcodeを検証                                                                |
| 多バイト文字graphが5MiB制限を超えても通る                                                                                       | JS文字数をbyte数として扱っていた。UTF-8 Blob.sizeで判定                                                                                                                            | 文字数は5MiB未満・UTF-8は5MiB超の正当なgraphでGRAPH_LIMITを検証                         |

修正前の失敗は `work/acceptance/unit-repro.log`、`utf8-repro.log`、`run-order-repro.log`、`preview-repro.log` に保持。これらは再現用の選択実行であり受け入れ合格数には加えない。テストの削除、`.skip`、期待値緩和は行わない。既存102件を維持し、unit 13件とブラウザーテスト2件を追加した。

## 今回の正式検証

| コマンド/対象                                | 今回の結果                                                     |
| -------------------------------------------- | -------------------------------------------------------------- |
| npm ci                                       | 成功、既存lockfileから422 packages                             |
| npm run typecheck                            | 成功                                                           |
| npm run lint                                 | 成功、warnings 0                                               |
| npm test                                     | **115/115成功、14 files**                                      |
| npm run build（root）                        | 成功                                                           |
| NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build | 成功                                                           |
| root全E2E（desktop/mobile）                  | **90/90成功、5.3分**                                           |
| /axfluxo/全E2E（desktop/mobile）             | **90/90成功、5.3分**                                           |
| runner flag無効build・同一origin保持         | 成功（1440px/390px）                                           |
| 最終HEAD GitHub CI/Pages build               | commit時は未実行。完了後PR #6本文へHEAD・各run URL・結果を追記 |

全E2Eの期待件数は90件（既存82 + Phase 2関連8）。`PLAYWRIGHT_BASE_URL`をroot/`/axfluxo/`の別固定artifactへ向け、正式な `npm run test:e2e` を実行する。ブラウザーはsystem Chromium。認証はCIと同じ公開Supabase設定でbuildし、E2Eの認証リクエストは既存mockで検証する。実メールや実ユーザー素材を使わない。

ログ: `work/acceptance/npm-ci.log`, `typecheck-final.log`, `lint-final.log`, `unit-final.log`, `build-root.log`, `build-base.log`, `e2e-root.log`, `e2e-base.log`。実行順の違う旧ログを今回の結果へ置き換えない。

## 監査した契約・既存機能

- DAG: strict v1/v2/schema/typeVersion/config、input、edge方向/端子型/cardinality、cycle、200 nodes/1,000 edges、UTF-8 graph上限、安定したKahn順。diamond、fanout、first/second collection順、snapshot clone/freezeを確認する。
- 実行: runnerにReact/UI/搬送依存なし。registryとhost lockを分離。run/node/attempt、stop/continue、failedとblocked、中断後新node禁止、encode/最終transaction競合、reload後interruptedと無断再実行禁止を検証する。
- ブラウザーT10はChrome lifecycle freeze→active、別タブのRUN_BUSYと誤ったinterrupted防止を追加し、mobile構成では844×390へ変更してcancel/reloadする。これはChromiumの挙動であり、iOSのOS破棄・Safariを証明しない。
- 画像: cropGeometry/scene/effectは従来rendererを再利用し、本体を変更しない。Workflow出力はPNG、既存StudioのPNG/JPEGとZIPは既存E2Eで検証。実MIME・元MIMEを区別し、hash/decoder/寸法/容量上限、原本hash不変、10回実行後のcacheとobject URL解放を検証する。
- 参照: 旧assetIdは元DB、v2 AssetRefはWorkspaceから解決。libraryId/fileId/versionId/kind/hashは将来向け明示version契約で、実ライブラリーDB/UIではない。file→imageは拒否し、audio/video編集は行わない。同一versionの分岐・複数Workflow参照、欠損・hash/MIME不一致、消費時のみのidempotentコピーを確認する。
- cache: type/typeVersion/config/input hash/version/font/renderer/output specをkeyへ含める。純粋nodeの再実行は新run/attempt、旧履歴は保持。履歴pin中の出力はcache破棄でも残り、未知・破損履歴はtransactionをabortして保持する。
- save/postは旧文書から削除せずpreflightでunsupported。SNS OAuth/投稿、外部upload、翻訳、正式save、Factory搬送・大量投入UIは未実装で、架空の成功を返さない。
- Auth/guest/logout、旧Studio/Crop、PNG/JPEG/ZIP、Workspace保存・CAS・復旧・コピーmigrationは既存のテストを変更せず全件に含める。

## DB・rollback

既存 `axfluxo` v1 / `axfluxo-workflow` v1 / `axfluxo-workspace` v1のversion/store、AssetRef、原本bytes、コピーmigrationは変更しない。実行DB `axfluxo-execution` v1もversion/store/indexは変更しない。辞書の検証修正と件数制限付き読込は、既存行を変換・削除しない。

旧コピーmigrationのtransaction中断時は原本を残し、source/revision markerで重複copyを防ぐ。新たなdocument migrationは不要。blocked/open/VersionError/versionchange/transaction abort/破損履歴保持を確認する。

runner flag `NEXT_PUBLIC_WORKFLOW_RUNNER_ENABLED=false` で再buildしても文書と履歴を保持する。mainの旧strict clientへcode revertした場合、新nodeを含む文書は読込拒否されるが保持され、再有効化で再読込できる。実行DBは旧mainが開かないため削除不要。本追補前のPhase 2コードも同じDB versionを使えるが、旧Zod parserは特殊IDを読み落とすためその不具合は戻る。DB downgrade/deleteをrollback手順に含めない。

## 実機Safari確認手順・未検証

この環境はLinux Chromiumであり、物理iPhone、Safari、iOSのOSによるタブ破棄、GPU/heap実測、実メール認証は検証できない。実機受け入れ時には以下を実施する。

1. HTTPSの承認済みpreviewで `/axfluxo/` を開く。縦/横画面、44px controls、RunPanelのscroll、タッチ接続、数値/日本語IME/Undo、フォーカス復帰・VoiceOverを確認する。
2. 画像encode中に背景化し、復帰前後とiOSによるタブ再読込の両方を試す。生存runは二重化しないこと、reload後はinterruptedとなり勝手に再実行されないことを確認する。
3. 許容内の大きな画像（20MiB/24MP/長辺8192以下、出力8.5MP/4096以下）で10回実行、原本hash・順序・cache・表示を確認する。memory warning/終了時に保存済み文書を失わないことを確認する。
4. 2タブでrun/cancel/reloadとIndexedDB接続を確認し、低容量時のtransaction失敗が成功表示されないことを確認する。
5. 任意の承認済みテストアカウントでメール確認・guest→login→logoutを確認する。実ユーザー素材/認証情報は検証ログへ含めない。

Pagesローカル確認: CIの公開設定と `NEXT_PUBLIC_BASE_PATH=/axfluxo` でbuildし、同じbasePathで静的serverを起動、`PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port>/axfluxo/ npm run test:e2e`。PRのPages/buildはartifactの検証のみで、本番deployしない。

## 後続Phaseへの申し送り・判定基準

- Phase 3には、不変version store、参照保持/バックアップ/容量管理とidempotentな正式save operationが必要。副作用nodeをpure retry/cacheへ混ぜない。現行fileとlibraryは参照契約、collection実装は画像2要素、実行はserial、未消費中間結果/履歴のZIP・削除UIは未実装である。
- 新nodeはdomain schema/typeVersion/port定義とregistryへ明示追加する。複数port、imageとtext、原文と翻訳文の別text portはこの契約を拡張できるが、翻訳処理は今回は実装しない。generic text/file collections、手動確認nodeのpaused/承認状態、投入queue/backpressureには別途契約が必要。
- 現行の単調run時刻はhostのglobal serializationを前提とする。将来複数workerへ拡張するならtransaction内の順序採番が必要。再投入/resetは新runを基本とし、無制限の循環edgeをDAGへ入れない。搬送アニメーションを実行完了条件にしない。
- 最終判定は、最終HEADのCI/buildと今回の全自動検証が成功したうえで、物理iPhone受け入れを別途必要とする「条件付きMerge可能」を基準とする。未完了CIや修正未検証が残る間はMerge可能とは判定しない。実際のMerge/デプロイは実施しない。

ローカル最終結果: npm ci/typecheck/lint/unit **115/115**、root/basePath/runner-off build、root E2E **90/90**、/axfluxo E2E **90/90**、runner flag roundtrip成功。旧コピーmigrationの最後のmarker書込でQuotaExceededErrorを注入し、全storeのrollback・原本保持・再開後に1 copy/1 markerだけ生成されることも追加確認した。

GitHub最終HEADのCI・Pages buildが成功するまではMerge判定を保留する。完了時の正確なHEAD・run URL・結果・最終判定は [PR #6本文](https://github.com/AxsisAxsis0807/axfluxo/pull/6) に追記する。この文書はpush前の観測結果を記録し、未実施のCI結果を事前に成功と書かない。実機Safari・実メール・OS/GPU/heap実測は未検証。Merge・デプロイは行っていない。
