# Phase 4 調査・設計・検証記録

2026-10-29 JST。対象: AxsisAxsis0807/axfluxo。基準main: `367fb02570b4782aa5f51e892718fc473b376c59`。開始時は`work`、変更なし。mainをfetchして同一HEADを確認し、`feat/workflow-phase-4`を作成。リポジトリおよび祖先にAGENTS.mdなし。

## 1. 調査結果と確定スコープ

README、ADR 001–006、Phase 1–3の検証記録、WorkflowCanvas/ノード定義、runner/cache/AssetRef、素材ライブラリー/save、共通ImageEditorと保存・復元・バックアップ、CI/Pagesを調査。正式なPhase 4仕様は見つからず、依頼の暫定仕様を採用。正式仕様との差分はなし（正式仕様自体なし）。設計は[ADR 007](../adr/007-workflow-studio-phase4.md)。

既存実装で利用できるもの:

- Workflow v1とWorkspace v2、React Flowの接続・選択・1指パン・2指ズームと詳細パネル。
- ノード単位の独立した編集文書、画像・文字・図形・ページ・レイヤーとセッション内Undo/Redo。
- 750ms/最大5秒の作業版自動保存、競合検出、適用版の不変revisionと選択ページ、出力キャッシュ。
- 入力変更時の維持／コピー後の入力レイヤー差し替え／コピーして再制作、参照欠損時の固定入力再開。
- Phase 2の固定snapshot・最新の有効な上流実行結果・再実行・キャンセル、Phase 3の固定version・save receipt・ライブラリー再利用。
- 旧Studio/Workflow、旧ZIPとWorkspace ZIP v1/v2の別ID復元。

今回の不足部分だけを補完:

1. ライブラリー素材入力から、事前実行なしでStudioの固定入力を作成。
2. save等の実行結果がlibrary参照の場合も、既存AssetRefへ取り込む。
3. 未適用の画像編集の手前だけを、既存runnerで明示的に実行。下流/無関係な枝を実行せず、初回の加工→Studioを可能にする。
4. 適用版を変更せず作業版を保存してWorkflowへ戻り、再開できる操作。
5. 確定・作業版保存・出力更新・端末書き出し・ライブラリー保存の説明と、ドラフト復帰後の状態表示。
6. 検証/サムネイル用decode画像の使用後解放。

Studio再構築、DB移行、依存追加、SNS/OAuth/外部API、Factory/アニメーション、大規模パレット変更、品質モード、GCは対象外。

## 2. 入出力・データ保護

入力はlibrary/file/version/hashを固定し、latestを追わない。正規化PNGを既存Workspace assetsへ一度コピーし、同じ完全参照は同じ派生UUIDを使用。ライブラリーIDがUUIDでなくても取り込める。実行出力の従来UUIDマッピングは維持。既存コピーのhash不整合は上書きせずエラー。取込のIDBトランザクションはキャンセルでrollbackする。

編集前の固定入力と、作業版、適用済みrevision、生成画像を区別する。新しい戻る操作は作業版のflushとWorkflowの保存barrierを待ち、適用版/ページ/出力を更新しない。保存失敗・競合・未確定フォーム/IME・画像取込中はセッションを保持し、成功扱いしない。既存の確定操作も同じ保存ガードを維持。適用しない操作は編集の破棄ではなく、作業版の保持である。

DBバージョン・store・index・文書/AssetRef/バックアップ形式の変更なし。Studio v1、Workflow v1、Workspace DB v2/文書v2、execution v1を保持。migration不要。rollbackはPhase 3対応クライアント/既存feature flagsとバックアップを使い、DB削除・downgrade・再構築はしない。

## 3. 変更ファイル

| ファイル                                       | 変更                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/services/workflow/editor-input.ts`        | 固定入力adapterを共通化、library出力対応、参照ごとの重複防止、キャンセル時rollback              |
| `src/services/workspace/input.ts`              | 接続されたライブラリー素材入力を直接解決                                                        |
| `src/features/workflow/RunPanel.tsx`           | 選択した画像編集の上流だけを既存runner/lock/history/cacheで実行                                 |
| `src/features/workflow/ImageEditSession.tsx`   | 適用せず作業版保存して戻る操作、操作の説明                                                      |
| `src/features/workspace/WorkflowWorkspace.tsx` | 復帰barrier/フォーカス、作業版状態の再読込、素材入力案内                                        |
| `src/services/workflow/asset-resolver.ts`      | 検証用の一時decode画像を解放                                                                    |
| `src/services/editor/render-image-edit.ts`     | サムネイル描画用の一時decode画像を解放                                                          |
| `tests/workflow-references.test.ts`            | library入力/保存結果/固定version/欠損/衝突/中断のUnitテスト4件                                  |
| `tests/e2e/workflow-phase4.spec.ts`            | 上流準備・往復制作・作業版保持・入力変更保護・別Workflowで再利用・保存失敗の2シナリオ×PC/スマホ |
| `README.md`                                    | Phase 4利用手順                                                                                 |
| `docs/adr/007-workflow-studio-phase4.md`       | 調査、対象/非対象、契約、互換性、rollback設計                                                   |
| `docs/manual-tests/workflow-phase4-results.md` | この記録                                                                                        |

## 4. 自動検証

Node 24.19.0、既存lockfileのnpm ci、system Chromium。build時の認証設定は既存CIと同じ公開値を使用。認証は既存のmock E2Eであり、実メール送信ではない。既存テストの削除・skip・期待値緩和なし。

| 検証                                           | 結果                                  |
| ---------------------------------------------- | ------------------------------------- |
| `npm run typecheck`                            | 成功                                  |
| `npm run lint`                                 | 成功、警告0                           |
| `npm test`                                     | 144/144、15ファイル（既存140＋追加4） |
| root `npm run build`                           | 成功                                  |
| `NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build` | 成功                                  |
| 重点E2E（Phase 4＋既存画像取込中安全性）       | 6/6、PC/スマホ                        |
| root 全E2E                                     | 102/102、PC51＋スマホ51、8.5m         |
| `/axfluxo/` 全E2E                              | 102/102、PC51＋スマホ51、8.4m         |
| `git diff --check`                             | 成功                                  |

rootとbasePathは独立したソースコピー/production artifact/配信ポート/ブラウザcontextで並行実行。basePathコピーのsrc/testsを作業ツリーと比較して一致を確認。既存Studio、認証、画像/PNG/JPEG/ZIP、旧バックアップ、複数タブCAS、Undo/Redo、Workflow First、Phase 2 runner/cache/再実行、Phase 3ライブラリー/save/復元を全回帰に含む。

最初の追加E2Eはテストデータのノード重なりでクリックが遮られた。利用可能なノード一覧から開くようにテスト操作を修正。全回帰の初回では、今回追加した画像取込中のボタン無効化が既存の「適用を試すと完了待ちの案内を表示する」契約を変えていたため失敗。既存テストを変えずにボタンと保存ガードの従来動作を復元。重点6件通過後に全回帰を再実行。初回の中断結果は最終成功の証拠として数えない。追加調査で、未適用編集ノードを含む全体実行の事前検証が上流加工の初回生成を止めることを確認。実行中の回帰を中断し、上流限定実行とそのUnit/E2Eを追加してproduction buildから再検証した。中断した回帰を最終成功として数えない。

開発環境ではnetwork権限なしの初期fetch/npm/buildが失敗。許可されたネットワーク経路とworkspace内npm cacheを使用して成功。basePathの最初のソースコピーは外部node_modulesへのsymlinkをTurbopackが拒否したため、独立したルート内に同じ依存ファイルを配置して成功。アプリの依存/設定/lockfileは変更していない。

## 5. 操作性・性能・実機未検証

ChromiumのiPhone 13設定で390×844と844×390を目視・DOM確認。scrollWidthはそれぞれ390/844で横はみ出しなし。セッション上部3操作は縦画面で44–50px、横画面で44pxの高さを保持。実際のSafariやソフトウェアキーボードの確認ではない。

ライブラリーとStudioのDB契約を保つため、消費した画像だけを固定コピーする。画像bytesをgraphへ追加しない。ノード再描画構造やrunnerの直列処理は変更しない。全解像度のdecode/ハッシュ/PNG生成と既存のメモリー内ZIP、増加し続ける保持素材には従来のメモリー・容量コストが残る。ピークheap/GPU/最大画像の実測や品質モードは今回未実施。

実機iPhone Safariで確認が必要な項目:

- 縦横回転、アドレスバー/セーフエリア、モーダル、タップ選択、1指パン/2指ズームとページスクロールの干渉。
- 日本語IME/ソフトキーボード表示中の入力確定、ボタン到達、フォーカス復帰、VoiceOver。
- 保存/画像処理中のバックグラウンド化、OSのタブ破棄、Filesへのダウンロード、実際の容量不足。
- 大きい画像/多ページの実機メモリー、熱、処理時間。

## 6. 既知の制限と引き継ぎ

最終の自動検証範囲で、新規の確定済み不具合は残っていない。実機Safariの受入は未実施。従来の制限として、Undo履歴はセッション内のみ、ノード複製は接続を複製しないため新入力コピーの接続は手動。作業版の保存は適用やライブラリー保存ではない。ブラウザ終了時の未完了IDB保存は完了保証できないため、保存済み表示と外部バックアップを確認する。

Phase 5以降では実機Safari受入、品質モード/Worker・メモリー測定、保持/GCとバックアップ予算、より大規模なノードUIを別設計する。Phase 3から引き継ぐ、100件を超える再実行祖先の扱い、library/executionのDB間非atomic境界、receipt保持と復元上限を維持する。Factoryや外部サービス機能には今回着手しない。

## 7. 提出

専用ブランチへのcommit/pushとDraft PR 1件のみ。PR作成後停止。mainへのpush・Merge・本番デプロイ・Phase 5移行なし。Draft PRのURLは最終回答とこのブランチのPRを参照。GitHub CIはpush/PRで開始されるため、本記録の成功結果はローカル検証であり、リモートCIの成功を主張しない。

最終検証ログは`work/typecheck.log`、`lint.log`、`unit.log`、`build-root.log`、`build-base.log`、`e2e-focused-final.log`、`e2e-root.log`、`e2e-base.log`に保持。中断/修正前のログも`work/`に保持し、最終結果と区別した。
