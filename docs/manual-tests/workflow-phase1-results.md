# Workflow Phase 1 — 検証記録 (2026-10-24 JST)

Node 24.19.0 / npm 11.9.0 / Chromium（desktop と iPhone 13 サイズ・タッチ設定）。変更前ソースは `f8c4712a58d77bd1d56754cb6104b4e4226da527`、取得した origin/main と一致。

## Baseline

- typecheck / lint: 成功。
- unit: 32件成功。
- static build: 成功。
- 既存E2E: 22件成功。認証はCIと同じ公開Supabase URL/publishable keyでビルドし、テスト内のHTTPモックを使用。実アカウントや本番Supabaseは変更していない。
- 初回のsandbox内buildはTypeScript設定出力の解析で失敗し、許可された実行環境で成功。初回の認証E2Eは公開設定不足で失敗し、CIと設定を揃えて再取得した。テスト削除・skip・期待値緩和は行っていない。

## Final validation

最終コードのローカル検証結果。

| コマンド／成果物                             | 結果                            |
| -------------------------------------------- | ------------------------------- |
| npm run typecheck                            | 成功                            |
| npm run lint                                 | 成功（警告0）                   |
| npm test                                     | 45件成功（既存32＋Workflow13）  |
| npm run build (root)                         | 成功、output:export             |
| NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build | 成功、output:export             |
| root E2E                                     | 36件成功（desktop18＋mobile18） |
| /axfluxo E2E                                 | 36件成功（desktop18＋mobile18） |
| git diff --check                             | 成功                            |

## 検証内容

- 型不一致・逆方向・端子欠落・自己接続・重複・入力占有・循環を拒否。collection型も完全一致のみ。
- 同じ画像出力の保存ノード／投稿ノードへの分岐と、位置・設定・別viewportの保存／復元。
- 複製ID一意性、関連edge削除、接続・削除・移動・整列・設定のUndo/Redo。
- 750ms / 最大5秒の保存、保存直列化、保存中追加編集、2タブCAS競合・別コピー・再読込。
- quota時のtransaction abortで既存正常データを保持。DB open失敗、blockedと遅延成功接続のclose、versionchange、未知schemaを安全に拒否。
- wheel/pinch中心の保持、1→2→1指とcancel後の復帰、ヘッダーだけのdragと1回のUndo、接続dragのcancel後にedgeを作らないこと、端子クリック接続、キーボード接続解除。
- PCパネル／モバイルシートでのフォーム入力時にcanvas変換が不変。設定終了後のフォーカス復帰。
- 既存Studio・クロップ・PNG/JPEG・ZIP・ゲスト・メール認証・確認／再送／回復／logoutを既存E2Eで回帰検証。

テスト中に見つかったメニュー重なり、閉じた後のfocus、cancel時の再マウントによる次touchの欠落を修正した。移動のUndo試験は文書位置（transform）を比較し、選択によって変わるz-indexを位置として比較しない。ブラウザへの小数マウス座標の丸めを避け、中心保持試験には実際の整数座標を使用する。

## 未実施・制限

- 実機iPhone Safari、実機IME・VoiceOver・ソフトウェアキーボード・safe area／回転の実機確認は未実施。手順: [workflow-iphone.md](workflow-iphone.md)。Chromium emulationをSafari試験とは呼ばない。
- 容量不足はfake-indexeddbのtransaction障害注入。実機のストレージ回収・強制終了・quota限界と、200ノード時の性能は未検証。
- GitHub Pagesへの本番デプロイ・公開URL検証は行わない。ローカル静的成果物をrootと本番basePathで検証する。
- 実行エンジン・実画像処理・素材ドロワー・SNS連携／投稿・backend追加は対象外。Phase 2は本変更のレビュー、実機受け入れと別途スコープ合意後に着手する。

既存 `axfluxo` DB v1の削除・改名・version変更・一括変換はなし。logoutによるローカル削除なし。rollbackは `NEXT_PUBLIC_WORKFLOW_ENABLED=false` で入口のみ無効化し、新旧DBは保持する。
