# Workflow First Refactor — WFR-5 実装・検証記録

仕様基準日/記録日: 2026-10-25 JST。
対象は独立したWorkflow First RefactorのWFR-0〜5。
別ロードマップのPhase 2〜6の全文指示書は変更していない。
WFR-6の実機受入まで完了したという記録ではない。

## 基準・提出先

- 開始main: `26ee040e3c5093807c69b3daa4484aaa10955a9d`。
  GitHub連携、ls-remote、fetchで確認。再開時のfetchでも同SHA。
- 今回の継続開始HEAD: `4e49f2c614302b498bdb90bc5351554eeb065696`。
- 最終テストの表示待機補正: `2742b61`（runtime差分なし）。
- 検証対象の実装HEAD: `18afc1dc498d4677f355a350c04c1302ad668098`。
- ブランチ: `feat/workflow-first-refactor`。
- 新規PR: https://github.com/AxsisAxsis0807/axfluxo/pull/5 。既存PR #4は変更していない。
- mainへの直接commit/push、Merge、自動Merge、本番deployは行っていない。
- 初期作業ツリーはクリーン。適用AGENTS.mdなし。途中の変更は本作業の変更と確認。
- Node 24.19.0 / npm 11.9.0 / Linux / Chromium。
  Next 16.4.2、React 19.3.0、React Flow 12.12.0、Dagre 3.1.2、Konva 10.9.0を維持。
  package.json/lockfileに差分なし。新しい依存はない。

## 制作体験と実装範囲

新しいタブの初期画面はWorkflow。画像編集ノードを追加し、接続入力/選択素材/
空白を明示して共通エディターを開ける。編集途中は作業版だけを自動保存し、
「保存してWorkflowへ戻る」で不変の適用版を作る。再開時は作業版と出力ページを
復元する。編集文書とUndoはノードごとに独立し、編集Undo履歴自体は永続化しない。

個別の「出力画像を更新」で適用版の選択ページからPNGを生成。未適用、出力未生成、
古い出力/更新必要、生成中、生成済みを分ける。端末書き出しはPNG/JPEG/複数ページZIP。
Workflow全体の実行、未実装resize/cropノードの実行、SNS接続/直接投稿、クラウド同期は
追加していない。画像処理の上流は未生成と表示し、元画像で代用しない。

入力画像は新DB内の不変画像/hash/対象レイヤーで固定。上流/選択素材の変更時は、
固定入力を維持、コピー後に入力レイヤーだけ差し替え、コピーして作り直す、を選ぶ。
コピー元とその適用版を保持し、文字・図形・別画像を勝手に変更しない。

旧Studioとテンプレート/旧プロジェクト/旧ZIPは旧入口で継続利用可能。
旧Studio作品を画像編集ノードへ、旧Workflowをv2へ、それぞれ独立コピーとして取り込む。
新形式のバックアップ/復元は旧ZIPとは別操作・別manifestで、復元は新IDの別作品になる。

## ファイルと責務

| ファイル                                                                       | 責務                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| features/workspace/WorkspaceShell.tsx                                          | Workflow中心の入口、旧Studio切替、タブ内の明示選択、flag                       |
| features/workspace/WorkflowWorkspace.tsx                                       | v2グラフ、履歴、詳細、viewport/選択、保存障壁、起動、出力/復旧/移行UI          |
| features/workspace/WorkspaceDialog.tsx / workspace.css                         | モーダル、PC左右構成、モバイル詳細シート、safe-area                            |
| features/editor/ImageEditor.tsx                                                | 既存の編集UI、Canvas/CropDialog、文字/図形/ページ/レイヤー/変数                |
| features/editor/useEditorSession.ts / EditorDraftContext.ts / EditorFields.tsx | 文書履歴・選択・表示状態、未確定入力/IME、native Undoを保持する入力            |
| features/editor/Editor.tsx / LegacyStudioAdapter.ts                            | 旧Studioの既存保存/作品/テンプレート/ZIP経路と安全な移動                       |
| features/workflow/ImageEditSession.tsx                                         | 独立した作業版保存、適用障壁、ページ選択、非同期画像取込、端末書き出し         |
| features/workflow/WorkflowCanvas.tsx / NodeInspector.tsx / NodePalette.tsx     | Phase 1のキャンバス/接続/検索再利用、画像編集定義/名前/サムネイル              |
| domain/workspace/schema.ts                                                     | strictなv2、image-edit、作業版/適用版/固定入力、参照収集                       |
| services/workspace/db.ts / repository.ts / autosave.ts                         | 新DB、CAS、原子的適用、独立複製、復旧保持、保存世代                            |
| services/workspace/migration.ts / input.ts                                     | 元を変えないコピー移行、再試行重複防止、固定入力解決/限定差し替え              |
| services/workspace/backup.ts / services/archive.ts                             | 形式別ZIPポリシー、全検証、新ID対応表、原子的別コピー復元                      |
| services/editor/asset-resolver.ts / render-image-edit.ts / renderers/scene.ts  | 共通画像解決/描画、選択ページ、キャッシュキー、生成直列化/取消/解放            |
| services/image-header.ts / assets.ts                                           | デコード前のPNG/JPEG/WebP寸法検査と従来の取込検証                              |
| tests/workspace*.test.ts / image-header.test.ts                                | strict schema、保存/CAS/abort/quota、移行、取消、ZIP安全性                     |
| tests/e2e/workflow-first*.spec.ts                                              | 新しい制作導線、隔離、複製/Undo、再開、失敗/競合/入力変更/非同期取込           |
| scripts/check-workflow-first.mjs                                               | Palette検索、2ページ目の実PNG寸法、focus復帰、JPEGコピー移行、flag無効時の保全 |
| docs/adr/004-workflow-first-workspace.md                                       | 現行設計・互換性・保存/移行契約                                                |

ProjectDocument、reducer、cropGeometry等のcrop計算、textレイアウト、Canvas、
CropDialog、Konva scene、デコーダー、同梱フォント、既存保存/認証/バックアップを再利用。
重複したStudioDocumentは作っていない。提案されていた責務は実際の境界へ配置し、
表示を持たないLegacyStudioAdapterは.tsとした。

## 新形式・保存・保全

新DB `axfluxo-workspace` v1:
workflows/preferences/editorDocuments/editorRevisions/assets/artifacts/recovery/migrations。
旧 `axfluxo` v1と `axfluxo-workflow` v1に新形式を書き込まない。

作業版、適用版、Artifactは別レコード。文書のrevisionと保存CAS revisionを分け、
成功時だけCASを進める。適用時はWorkflowと編集文書の期待revisionの両方を同じ
transactionで検証し、文書・適用版・グラフ・viewport・復旧版を原子的に確定する。
完了表示はtransaction.oncomplete後。画像デコード/hash/描画は長い書込transactionの外。
750ms/最大5秒、直列化、世代管理、await可能なflushを使用する。

画像取込中は保存済みと見せず、作業面を一時無効化し離脱を保留する。
保存失敗・容量不足・未確定/IME・競合時は画面に残り、明示再試行/再読込/別コピーを提供。
ブラウザ戻るでも編集セッションを捨てない。異なるノードの可変文書を共有しない。
ノード削除後も文書/版/画像を直ちに削除せず、Undo/復旧で戻せる。自動GCは行わない。

移行は元ID/元revisionの記録を持ち、同時再試行でも同じコピーを返す。元の更新時は
別コピー扱いを表示する。旧画像はhash、原本形式、正規化/原本のdecode寸法を検証して
から新DBへコピー。途中失敗で元のDBも既存の新作品も変更しない。

新ZIPは `axfluxo-workspace` / formatVersion 1 / renderVersion 1。
作業版、適用版、固定入力、対応画像、適合する現在出力、viewport、font/hashを含む。
200MiB/500entry/JSON5MiB/depth32、パス/重複/未知形式/余分entry、MIME/decode/hash/
参照を検証して全IDと内部参照を対応表で更新し、単一transactionで別コピーを公開する。
認証情報・Promise・Object URLは含めない。OSへのダウンロード開始とDB保存を分け、
Safari/Filesでの保存完了までアプリが確認したとは表示しない。

## 旧データを維持した証拠

- 旧storage.ts、services/workflowのDB/repository/autosave、document/crop/text、
  auth/Account、fonts、依存/lockfile、Next/CI設定は開始mainから差分なし。
- v1 validatorは未知schema/type/versionとimage-editを引き続き拒否。
  新ノードのためv1 validatorを緩めていない。
- 旧ZIP検証は形式別ポリシーへ抽出したが旧許可パス/制限は同じ。
- 固定v1 fixture、fake-indexeddbで元DB不変/再取り込み重複防止/更新元の別コピーを確認。
- 実ブラウザで旧StudioのJPEGをコピーし、旧project/assets不変、新asset ID、
  JPEG原本とPNG Blobの区別、再開を検証する。
- 既存テストの期待値は削除・skip・緩和していない。旧入口を明示するテスト設定を
  全タブ/別contextへ適用し、画像編集ノードの新試験は新しい初期画面から実行する。

## 検証結果

対象実装は上記 `18afc1d`。root/basePath/flag無効の各buildを別の静的成果物へ
コピーしてから配信し、試験中の成果物を置き換えていない。

| コマンド/検証                                          | 結果                                  |
| ------------------------------------------------------ | ------------------------------------- |
| npm ci（変更前baseline）                               | 成功、422 packages、依存変更なし      |
| npm run typecheck                                      | 成功                                  |
| npm run lint                                           | 成功、warnings 0                      |
| npm test                                               | 75件成功、10ファイル                  |
| npm run build                                          | root成功                              |
| NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build           | basePath成功                          |
| NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false npm run build | 旧入口の独立build成功                 |
| 新しいフォーム/キャンバス回帰の先行E2E                 | desktop/mobile計4件成功               |
| 全E2E root                                             | 78件成功、desktop39 + mobile39、5.8分 |
| 全E2E /axfluxo/                                        | 78件成功、desktop39 + mobile39、7.2分 |
| scripts/check-workflow-first.mjs                       | 下記の追加検証すべて成功              |
| 補正後フォームの反復試験 /axfluxo/                     | desktop/mobile各5回、計10件成功       |
| 旧タッチ接続の反復試験 /axfluxo/                       | mobile 5回すべて成功                  |
| git diff --check                                       | 成功                                  |

全E2Eは `PLAYWRIGHT_BASE_URL` をそれぞれ `/`、`/axfluxo/` へ向けた
`npm run test:e2e`。Chromium desktopとiPhone 13相当viewport/touch emulationで実行。
追加スクリプトは `WORKFLOW_REVIEW_URL` と `WORKFLOW_ROLLBACK_URL` を使い、
画像編集Palette検索、2ページ目128×96 PNGの実ヘッダー、選択ページ再開、focus復帰、
JPEGコピー元不変、取込待機、コピー先の新asset IDと原本JPEG/正規化PNGの区別、
再開、flag無効時の旧Studio保存/再読込と既存v2行の保持を確認した。

既存画像検証のクロップ幾何、透過PNG/JPEG白背景、複数ページ順序を継続。
JPEG白背景は実デコードpixel `[255,255,255,255]` を検査する。
OSをまたぐ全面ピクセル一致や新たな広い閾値による画像差の隠蔽は導入していない。

GitHub最終テスト補正HEAD `2742b619c7bcc62641198a02697d349416483226`:
[CI #48](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40199341997) と
[Pages検証 #24](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/40199342002)
はともにsuccess。Pagesの本番deploy/verifyはskip。
その後の最終記録commitは文書のみで、runtime/テスト変更はない。
文書commitで再起動されるチェックと、この確認済みHEADの結果を区別する。

最終ログ: wfr5-delivery-root-build/base-build/rollback-build、
wfr5-delivery-root-confirmed-e2e/base-e2e/targeted/extra/form-repeat/touch-repeat（実行workspace内）。
ログそのものはアプリ配信成果物やGitへ含めない。

## 検証中に修正した事項

- 背景の自動保存成功で「ブラウザ戻るを保留した案内」が消える競合を、保存エラーと
  画面操作の案内を分けて解消。適用時のWorkflow CAS競合も、最新版の再読込/別コピーへ復帰。
- 一時的に作業面をinertにする前に起動ボタンを記録し、要素の作り直し時はノードIDで
  復帰先を解決。エディターから戻ったfocusを実ブラウザで確認。
- 旧Studio/新セッション双方で非同期画像取込中の離脱・書き出し・別作品起動を保留。
  取込中の保存済み表示や、古いレイヤー配列で新しい編集を上書きする経路を防いだ。
- 旧画像コピーの原本形式/hash/正規化・原本decode寸法を公開前に検証。
- 新規フォーム試験の初回root/mobileで、エディター表示前のisVisible判定が
  設定パネルを開く操作を省略した。セッション表示を待って判定するよう修正し再実行。
  `/axfluxo/`全78件は初回通過、root全78件は待機補正後に通過。
- GitHubの実装18afc1dでは通常CI成功、Pages検証で同フォーム待機と旧タッチ接続が
  失敗。旧タッチ接続はローカル両配信とmobile反復5回で通過し、補正後2742b61の
  GitHubチェックでも成功。Pagesのdeploy/verify jobはPRではskipされた。
- モバイル試験では詳細シートを閉じてから背後のノードを操作し、コピー完了を待って
  新しいエディターを操作する。force click、期待値緩和、skip、timeout延長では解消していない。

- 上流入力が現在利用不能でも、保存済み固定入力を明示選択して再開可能にした。
- Artifact公開transactionの途中で取消された場合もabortし、結果を採用しない。
- 不正な変数フォームは未確定のまま保持し、修正または取消まで保存・移動を保留する。
- 新旧キャンバス共存時のDOM参照を各キャンバス内へ限定し、旧Workflowの配置と
  ピンチ中心座標をdesktop/mobileで確認した。

## 実機・未実施・制限

実機iPhone: 端末/iOS/Safariの実測結果なし。機材がなく未実施。
Chromiumのdesktop/mobileを実機Safari・実IME・VoiceOverの証拠とは扱わない。
Playwright WebKit、実機の背景移行/強制終了/quota/最大容量メモリ、200ノード性能、
実メール受信/本番アカウント操作、本番公開サイト検証も未実施。
WFR-6実機受入は残る。手順: workflow-first-iphone.md。

Undo履歴はセッション内のみ。ローカル保存はアカウント別暗号化ストレージではない。
新しいテンプレートの保存/管理は旧Studio経路で継続し、コピー取り込みで再利用する。
WorkflowセッションのJPEG端末書き出し背景は白（旧Studioの背景/品質指定は維持）。
新ノードの有効出力は1ページのPNG。DAG/SNS/OAuth/クラウド同期/動画音声は対象外。
新ZIPのJSONサイズ等の防御を緩めず、大規模文書では上限エラーになる。
生成キャッシュも含め自動整理は未導入で、容量不足は明示エラーとバックアップで扱う。

## flagとロールバック・判断事項

`NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false npm run build` で旧入口へ戻す。
既存 `NEXT_PUBLIC_WORKFLOW_ENABLED=false` も新旧Workflow入口を無効化できる。
新DBは削除せず、旧DBへの自動逆変換もしない。旧版はv2を読めないため、新版再有効化
または対応した新バックアップで回復する。旧Studio/旧ZIPは引き続き使用できる。
必要ならPRのcommit群をrevertし、DBはそのまま保持する。

ユーザー判断はPRのレビュー/Mergeと、WFR-6実機受入。mainへのMergeや本番公開は
明示承認があるまで行わない。Phase 1の実行範囲を勝手に拡張せず、Phase 1〜6全文は
改訂していない。CI成功のみでiPhone検証済み/全体受入完了とは報告しない。
