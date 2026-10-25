# Workflow First Refactor — WFR-0/1 検証記録

2026-10-25 JST。これは**共通エディター抽出の段階報告**。
Workflow First全体の完了報告ではない。WFR-2〜6は未実装。

## 開始点と環境

- 開始main/ローカルHEAD: `26ee040e3c5093807c69b3daa4484aaa10955a9d`。
  GitHubのmainを参照し、`git ls-remote origin refs/heads/main`とfetchで照合。
- 開始作業ツリーはクリーン。適用AGENTS.mdなし。
- ブランチ: `feat/workflow-first-refactor`。PR #4は変更していない。
- Node 24.19.0 / npm 11.9.0 / Linux、システムChromium。
- CIと同じ既存公開Supabase設定で静的ビルド。認証E2Eは既存HTTPモック。
  実メール送信・本番認証変更・Merge・auto-merge・deployは行わない。

## 変更前 baseline

| コマンド          | 結果                                           |
| ----------------- | ---------------------------------------------- |
| npm ci            | 成功、422 packages、lockfile変更なし           |
| npm run typecheck | 成功                                           |
| npm run lint      | 成功、警告0                                    |
| npm test          | 47件成功、5ファイル                            |
| npm run build     | root静的export成功                             |
| npm run test:e2e  | rootで52件成功、desktop/mobile Chromium、4.0分 |

初期のネットワーク権限なし実行ではproxy接続が失敗した。失敗した
インストーラーがまだ動いている間に別のインストールを始めてしまい、
初回チェックでは依存ファイル欠損が出た。全インストーラー終了後に
`npm ci`をやり直して上記baselineを取得した。これを既存アプリの失敗と
数えない。通常sandbox内buildのTypeScript `--showConfig`読取失敗は、
ネットワーク権限付きの実行で解消した。依存・テスト期待値・Next設定を
変更して回避していない。

## 抽出と限定修正

ImageEditor、EditorFields、useEditorSession、LegacyStudioAdapterと最小の
AssetResolverを追加。既存UI・ProjectDocument reducer・Canvas/CropDialog・
crop/text計算・scene・import/decode・フォント・旧保存/ZIPを再利用する。
画面遷移・保存queue・exportダイアログは旧Editorホストに維持する。

限定修正は、非表示Studioの保存キー処理停止、CropDialogの遅延読込結果
破棄、exportのnull Blob検出と生成失敗時のリソース解放。画像DBの変更や
新しいノード・データ形式・実行エンジンの実装ではない。

## 旧データ保全の証拠

以下は開始mainから差分なし: storage.ts、backup.ts、domain/document.ts、
domain/workflow、services/workflow、Workflow UI/ジェスチャー、auth/Account、
limits、CSS、Next設定、scripts、CI、依存/lockfile。
旧DB名・version・store・ZIP許可パスに変更なし。DB削除・初期化・変換・
新DB作成は追加していない。旧Studioの書込は既存saveProjectを呼び、
従来どおりtransaction内CASとtransaction.oncompleteで完了する。

固定v1 fixtureは旧ProjectDocument、Workflowとviewport。
画像レイヤーID参照と画像変数default/valueを異なるUUIDにし、将来の移行で
取り漏らしを検出できる形にした。未知node/schema拒否でも入力は不変。
ブラウザE2Eで旧作品・クロップ・テンプレート・PNG/JPEG/ページZIP・
バックアップ別context復元・CAS・ゲスト・認証・Workflow操作を回帰確認する。

## 段階の境界と未実施

新DB、v2、CAS適用、コピー移行、image-edit、ノード独立保存、作業版/適用版/
Artifact、新バックアップ、Workflow中心WorkspaceShellとfeature flagは未実装。
ADR 003に後続段階の契約を記載した。提案ファイルを既存ファイルとして
扱わず、LegacyStudioAdapterは表示を持たないため.tsにした。

実機iPhoneの端末名/iOS/Safariと実測結果: **機材がなく未実施**。
Playwright WebKit、実IME、VoiceOver、実機quota/メモリ、最大画像の負荷、
実メール確認、公開サイトへの本番デプロイ検証も未実施。
Chromium mobileはiPhone実機Safariの検証ではない。

この段階では既存 `NEXT_PUBLIC_WORKFLOW_ENABLED=false` のrollbackが利用可能。
新Workflow First flagは後続段階で導入する。抽出自体はcommit revertで戻せる。
旧DBを削除しない。Phase 1〜6の全文仕様は改訂していない。
ユーザー判断: この段階PRのレビュー/merge、および後続実装の実機受入。
このPRをmergeしてもWorkflow Firstの完成形にはならない。

最終検証結果・実装HEAD・PR URLは下に追記する。
