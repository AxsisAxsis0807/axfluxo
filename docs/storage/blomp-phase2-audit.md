# Blomp Phase 2 技術監査

## 基準

2026-11-19。開始と作業終了時のHEADは `006a80a6e2ac64d2baf436f91b2d17f285c65c70`、branchは `feat/blomp-storage-phase1`。Draft #36はopen、mainのbaseは `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`、GitHubはmergeableと報告。該当AGENTS.mdなし。階層内の依存やツール設定は既存のまま。前回の `blomp-verify.ts`、`verify.test.ts`、`blomp-readiness-audit.md` のローカル差分を保持。Node 24.19.0。Phase 1の実接続は1024 B、4.240秒、7項目成功。Phase 2は追加実通信0回。

## 5周の監査記録

| 周 | 確認したファイルと方法 | 発見と重大度 | 修正、再検証、残件 |
| --- | --- | --- | --- |
| 1. 仕様・構造 | `server/api/app.ts` と `main.ts` の入口を追跡。CloudLibrary、Editor、LocalExport、ExportDockとAPIクライアントの契約を照合。既存R2アップロードのMD5と保存先型を比較。 | 高：R2プレビュー・MD5前提への差し替えは素材参照を変更する。中：完成BlobのMIMEにパラメータが付く場合がある。 | 独立したBlomp API・カタログと2ロール、MIME正規化、既存Blobを使う保存操作を追加。R2の経路は従来どおり。画像と小容量の対応動画・音声は端末の既存入力へ。大容量素材の直接取り込みは保留し、ネイティブダウンロードと端末ファイル選択を使う。 |
| 2. 認証・データ保護 | `008_blomp_storage.sql`、`auth.ts`、`jobs.ts`、`blomp/router.ts`、`blomp.ts`、静的配布依存境界。JWT期限切れ、別所有者、署名中の権限失効、任意座標、サイズ上限とRLSを隔離テスト。 | 高：署名が有効な間のabortと、公開時にRLSを迂回する読取経路。中：本文上限を橋渡し層でも課す必要。 | JWT・membershipの再確認、強制RLS、location/owner限定、cancelの署名期限と猶予、4 KiB本文、no-store、秘密境界検査。遅延パートや署名リプレイの実Blomp上の挙動は未検証。本番アダプターは起動しない。 |
| 3. 復旧と整合性 | `blomp/router.ts`、`storage/blomp.ts`、`services/blomp/client.ts`。作成・完了の応答喪失、中断、再選択、複数パート、opaque ETag、破損、abort失敗を隔離で再現。 | 高：応答喪失後の再作成、曖昧な完了・削除後の予約解放。中：ページングやbody読み取りがlease期限に重なる余地。 | exact keyと単一UploadIdで照合し、完了はHEAD優先。lease中の操作を拒否し、SDK操作とストリームを期限で中断。SHA不一致時は保留。未完了の不在確認後にのみ予約を解放。異常終了時に特定不能なアップロードは自動生成・削除せず保留。 |
| 4. 性能・費用 | 1 MiBのハッシュslice、8 MiBのパート、同時1本、XHRの送信サイズ、NodeのSHAストリームと転送予算を確認。PGliteで同一locationの過剰予約と署名予算停止を試験。公式3事業者の資料を比較。 | 高：残量・転送枠不明の受付、署名再発行のコスト、接続が切れても予約済みの容量が必要。 | 共有location行を排他、容量スナップショット期限、測定値／推定値の分離、署名と検証の別予算、外部消費時の受付停止。端末エンコードと並行中は転送を中断。PGlite結果はネイティブPostgreSQLの高並行負荷試験やiPhone実測を代替しない。 |
| 5. 回帰・導入 | 全Vitest、既存Playwright、型、lint、静的ビルド、API/workerビルド。Draft #36基準と関連PRのファイル差分を確認。 | 中：初回lintでReact Hookの関数名とuseMemo引数を検出。初回静的ビルドはTypeScript子プロセスの出力解析に失敗。初回E2Eは認証fixture用公開ダミー値が未設定。高：一部の独立ブラウザバンドルにprocessが存在せず、Blomp設定の参照で既存の端末画面や出力項目を停止させた。 | Hook呼び出しと関数名を修正しlint再検証。静的ビルドを適切なローカル権限で再実行。認証ダミー設定でE2Eを再実行。ビルド時の公開設定を参照し、processが存在しない独立バンドルでは未設定として扱うよう修正。影響ケースを独立した成果物出力先で再実行した。各回の結果は下記。GitHub CIはリモートHEADの履歴。 |

関連PRの共通変更パス。#31は `server/api/main.ts`、`CloudLibrary.tsx`、`LocalVideoTool.tsx`、`api-client.ts`。#30は `main.ts`、`api-client.ts`。#10は `app.ts`、`main.ts`、`CloudLibrary.tsx`、`api-client.ts`。#11はPhase 1からの `package-lock.json`。#35/#34/#33/#32/#27/#8には現時点で共通パスなし。ファイル重複は統合時に再照合する。どのPRも取り込んでいない。

## 変更一覧

- API／アダプター — `server/api/app.ts`、`server/api/main.ts`、`server/api/blomp/router.ts`、`server/storage/blomp.ts`、`server/blomp.env.example`
- 永続化 — `server/db/migrations/008_blomp_storage.sql`
- クライアント／画面 — `src/domain/blomp/storage.ts`、`src/services/blomp/client.ts`、`src/services/video/api-client.ts`、`src/features/developer/BlompLibrary.tsx`、`src/features/developer/CloudLibrary.tsx`、`src/features/developer/LocalVideoTool.tsx`、`src/features/editor/Editor.tsx`、`src/features/video-common/ExportDock.tsx`
- テスト — `server/tests/blomp/integration.test.ts`、`server/tests/blomp/boundary.test.ts`、`server/tests/browser/blomp.spec.ts`
- 記録 — `docs/storage/blomp-phase2.md`、本ファイル
- 保持した前回差分 — `server/storage/blomp-verify.ts`、`server/tests/blomp/verify.test.ts`、`docs/storage/blomp-readiness-audit.md`

## 検証記録

- 中間全Vitestは56ファイル・491件成功。後続の追加テストと差分を含む最終結果は別に記録する。
- 中間の追加統合テストは8件成功。初期のSQL準備不足は先行マイグレーションを適用して解消し、再現条件・テスト期待値を緩めていない。
- typecheck、lint、API・workerビルド、`git diff --check`を通過。静的ビルドは再実行で成功。
- 初回ルートE2Eは1成功、1失敗、1中断、121未実行。fixtureの公開ダミー値を適用して全124件を再実行。
- 新規ChromiumモックE2Eは1件成功。実際のブラウザXHRを捕捉し、中断、再読み込み、同名別バイトの拒否、再開、署名の非永続化を確認。
- iPhone実機、CORS、Range、Multipartの実サービス挙動、容量／料金、本番APIは未検証。独立した合否と手順は `blomp-phase2.md` を参照。

### 最終確認

| 検証 | 結果 |
| --- | --- |
| 全Vitest | 56ファイル、494成功、0失敗、0スキップ。追加の公開設定フォールバック後にBlomp 7ファイル、95成功を個別再確認。 |
| 静的サイトの既存E2E | デスクトップ・モバイル合計124成功、0失敗、0未実行。公開ダミー認証設定とAPI未設定のローカル静的サイト。 |
| 動画ブラウザ全体の初回 | 88件。Chromiumは30成功・14失敗。WebKitは実行ファイル不在で35件起動失敗、9件未実行。WebKitの44件は試験本体未検証。 |
| 影響範囲再実行 | Chromium 15件、14成功・1失敗。既存画面の素材選択・トリム・復旧・キューと新規Blompモックの成功を確認。残る端末エンコーダー試験はファイル生成・音声・保存後に尺2.086秒が2秒上限を超えた。並行試験終了後、同じテスト設定で単独再試験し1件成功（5.7秒）。 |
| 変更前mainでの比較 | 該当する既存9件のうち7成功・2失敗。完了待ちで失敗した復旧キューと3ジョブキューはmainでも再現。 |
| 型・lint・ビルド | 最終コードで成功。APIとworkerをビルドし、別コピーで `/axfluxo` とダミー公開API付きの静的配布を生成。クライアントartifactにBlomp資格情報の変数名・ダミー秘密が含まれないことを確認。テストもCI設定も無効化していない。 |

作業ツリーは22ファイルの未コミット差分（うち前回から保持した3ファイル）。ローカル実装はPARTIAL、実サービス互換性はPARTIALLY VERIFIED、本番実用化はBLOCKED。直接取り込みの上限を超える素材は端末ダウンロード後に選択する。大容量の長時間ストリーム検証、信頼できるプロバイダーチェックサム、Safari実機上の互換性、無料枠とAPI稼働基盤の受入が残る。追加実サービス試験の手順とロールバックは設計記録を参照。
