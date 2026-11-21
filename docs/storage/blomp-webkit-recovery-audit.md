# Blomp復旧ブラウザテストの5周監査

開始HEADは `a43d88424fd5f60525553b6d9f6aa9685ab230ef`、ブランチは `feat/blomp-storage-phase1`。ローカルは作業開始時にクリーンで、Draft #36のHEADと一致。Playwrightはlockfileの1.64.1。アプリ本体、CI、Playwright設定、DB、環境設定には変更なし。実Blomp、Drimeへの通信は0回。

## 1. 根本原因と仕様

CIのWebKitは `expect(request.postDataBuffer()).toEqual(original)` で落ち、期待した `mock-media` の10 Bに対し `null` だった。ここで確定するのは、インターセプトから本文を取得できなかったこと。旧テストの `route.fulfill` は実受信先を持たず、WebKitがHTTP本文を送信したかどうかを判定できない。重大度は高（CI停止）。

Playwright #6479はBlob/FileからinterceptのpostDataが欠落した例。#24077はFormData＋Blobであり、今回の生Blobを渡すXHRとは異なる。固定版のWebKit実行ファイルがなく、公式ダウンロード先は当環境で403。CIログで固定版の症状を再確認したが、WebKitの最小ケースや実HTTP本文は未検証。インターセプトの制約という説明は有力な仮説。ChromiumではアプリのXHRが実HTTPで正しい本文を送ることを、新しい受信側で確認した。同じPlaywright 1.64.1で最小の同一origin XHR Blob PUTを実行したところ、interceptが10 B、実受信も10 Bで元データに一致し、HTTP 200だった。

[CI](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/44538984533) · [Playwright #6479](https://github.com/microsoft/playwright/issues/6479) · [Playwright #24077](https://github.com/microsoft/playwright/issues/24077)

## 2. 転送と整合性

`server/tests/browser/blomp.spec.ts` に実HTTP受信側を追加。受信処理には10 Bの上限を設け、元データとバイト列およびSHA-256を照合した時だけ503、次回は200を返す。メタデータAPIでも開始時のサイズとSHA-256を照合する。空入力と同サイズの破損入力が422になり、成功転送件数に入らないことを別テストで確認。重大度は高（本文の検証を失うと偽陽性の可能性）。Chromiumで正常・負のテスト各3回成功。

## 3. 中断・再開・競合

503から中断状態への遷移を待ち、ページを再読み込みして同じセッションの状態を取得。同名・同サイズの別データで拒否され、その間に署名数、送信数、完了数が増えないことを検査。正しいデータで同一IDに再開要求が行われ、保存セッションの作成1回、署名2回、本文2回、完了1回、ダウンロード準備が揃うことを検査した。同期はブラウザ表示・API状態に基づき、待機時間やリトライを追加していない。

## 4. セキュリティと性能

エディターと受信側をそれぞれ127.0.0.1の動的な別ポートに置き、CORSを確認した。初期のモック文書ではChromiumのループバック権限に阻まれたため、エディター文書も実HTTPで配信した。Chromiumのブラウザ経路で503/200と本文を観測し、独立したOPTIONSで受信側のOrigin／Method／Headerのポリシーを検査する。ブラウザ経路で観測されるOPTIONSの回数は固定しない。

メタデータAPIはPlaywrightで応答し、エディターと受信先の正確なURL以外は既存の捕捉処理で遮断。esbuildのメモリ上のテストバンドルで、クライアントモジュール内の固定origin比較を一か所だけ置換。ソースのallowlistとプロダクションビルドは従来どおり。受信側は署名パス・メソッド・Originを検査し、Authorization付きも拒否。署名付きfixture URLのlocalStorage/sessionStorageへの保存がないことを確認。アプリのBlob分割・低メモリ処理と既定OFFは従来どおり。実BlompのCORSやSafari実機の成功判定とは分ける。

## 5. 回帰とCI互換性

既存の `npm run test:video:browser` 設定を利用。Chromiumの対象反復は6成功、0失敗。WebKitは取得先の環境ポリシー拒否（HTTP 403）と実行ファイル不在により未実施。コミット・push後にGitHub ActionsのWebKitで確認が必要。今回コミット・push・PR更新を行っていない。

| 検証 | 成功 | 失敗 | 未実施 |
| --- | ---: | ---: | ---: |
| Chromium 動画全体 | 43 | 3 | 0 |
| WebKit 動画全体 | 0 | 0 | 46 |
| Chromium Blomp反復 | 6 | 0 | 0 |
| 全Vitest | 503 | 0 | 0 |
| 静的サイトE2E（desktop/mobile） | 124 | 0 | 0 |

Chromium全体の失敗は既存のローカルFNF書き出し、波形失敗時のローカル書き出し、復旧キュー。3件を他の試験終了後に再検証し、波形失敗時ケースは成功、ローカルFNFと復旧キューは失敗。復旧キューは変更前mainでも再現記録あり。全体結果は再試験で置き換えない。

型検査、lint、API・workerビルド、Pages用静的ビルド、差分チェックは成功。初回Pagesビルドで負のテストのリクエストヘッダー型に問題が見つかり、文字列の辞書型を明示して再検証した。WebKitの挙動が未確定のため、次に承認されたpushでGitHub ActionsのWebKitを確認する。
