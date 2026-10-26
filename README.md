# axfluxo

AxFluxo is a customizable platform for content creation, visual editing, workflow automation, and social media publishing.

## AxFluxo Local Studio（初期版）

画像・文字・図形を重ね、複数ページの作品と再利用用テンプレートを作る、端末内保存の画像エディタです。音楽専用の固定項目はありません。紹介画像の2ページサンプルは、ホームの「2ページのサンプルを試す」から作成できます。サンプル素材はプログラムで描いた独自の幾何学画像です。

### 起動

Node **24.19.0**（`.nvmrc`）とnpmを使用します。

```sh
npm ci
npm run dev
```

開発画面は http://localhost:3000 。本番相当のローカル確認は `npm run build && npm start`。出力先は `out/` です。ゲスト編集は環境変数なしで利用できます。メール認証を使う場合は `.env.example` と [認証設定](docs/research/auth.md) を参照してください。開発サーバーはネットワーク上にもbindするため、信頼できる環境で利用してください。

### 制作の流れ

1. 新規プロジェクトを作り、キャンバス設定でサイズを選択します。
2. 画像・文字・図形を追加します。選択中のレイヤーは数値でも編集できます。スマートフォンはツールバーの「設定」から下部パネルを開けます。
3. 画像の「中央固定クロップ」で形・フレームサイズ・cover/contain・回転を設定します。1指で画像移動、2指で画像拡大縮小。適用まではドラフトで、キャンセルで元に戻ります。
4. 文字はDOM入力欄で編集し、入力欄を離れると1回の変更として確定します。line背景は各行の文字幅、box背景はボックス全体に追従します。
5. ページの追加・複製・並べ替え、レイヤー順序・表示・ロック、Undo/Redoで構成します。スマートフォンのページ操作は未選択状態の設定パネルにもあります。
6. 「書き出し」でPNG/JPEG、現在／全ページを選び、プレビュー生成後に保存します。複数ページは順番付きファイル名のZIPです。JPEGは白（変更可）に合成し、PNGは透明を保持します。

キャンバスのサイズ変更は座標を維持します。「内容も比例拡縮」は同一縦横比を明示した場合のみです。画像の内部回転、レイヤー回転、表示倍率は別に保存します。表示倍率・DPRは出力寸法に影響しません。パンモード、Space＋ドラッグ、2指の表示操作も使えます。

### 保存・復元・バックアップ

- 編集確定後750ms（連続編集時は最大約5秒）でIndexedDBへ自動保存します。「この端末に保存済み」は書き込み完了したrevisionだけに表示します。手動保存は即時キューに入ります。
- `projects` / `revisions` / `assets` / `templates` ストアを使用し、画像原本と正立PNGを文書JSONとは別に保存します。復旧用に過去5世代を保持します。設定画面から過去版を別プロジェクトとして開けます。
- **ブラウザ保存は永久バックアップではありません。** 端末変更、ブラウザデータ削除、容量回収に備え「バックアップ」から `.axfluxo.zip` を外部へ保存してください。スマートフォンは未選択状態の設定パネルからも利用できます。
- ZIPには文書、画像原本、編集用PNG、SHA-256、フォント参照を含みます。「バックアップ取込」で新IDの別作品として復元します。テンプレートライブラリ自体は含みません。必要なテンプレートは作品として開いてバックアップしてください。
- 複数タブの競合はrevision比較で拒否し、「コピーとして保存」で両方を残せます。保存エラー時は編集状態を保持します。
- Undoで必要な素材を失わないよう、初期版では素材を自動削除しません。素材全体の上限に近いときはバックアップと不要プロジェクトの整理が必要です。未参照素材のGCは後続です。

### テンプレートと変数

「テンプレート保存」は版を追加し、過去版を変更しません。テンプレート画面で作成・複製・編集・削除・過去版からの再利用ができます。再利用時はproject/page/layer IDをすべて新規発行します。

変数タブで英字開始のキー、表示名、string/number/image型、任意の既定値、必須を指定できます。文字はテキスト変数と接頭辞／接尾辞で連動し、画像は素材IDで差し替えます。同じ画像変数を使う複数ページでもクロップは独立しています。連動中の文字の直接編集には明示的な解除が必要です。値はplain textで、HTMLや任意式は実行しません。必須不足・文字overflowは出力を止めます（通常文字は明示的に許可可能）。

### 上限・対応環境

PNG / JPEG / 静止WebP。原本20MiB、24MP、長辺8192px。64〜4096px・8.5MPのページ、20ページ、各100レイヤー、素材合計200MiB。ZIP展開200MiB・500entry・文書5MiB・深さ32まで。設定は `src/config/limits.ts` にあります。大容量の圧縮・フィルターは端末負荷が高く、上限いっぱいのiPhone実機性能は未検証です。

HEIC、SVG、アニメーション、動画は未対応です。一般的なEXIF向きはブラウザの画像decode後にCanvasで正立PNG化し、原本を保持します。HDR・広色域の完全一致、未収録文字やカラー絵文字の一致は保証しません。フォント読込失敗は出力を止めます。

### 検証

```sh
npm run typecheck
npm run lint
npm test
npm run build
# 別ターミナルで npm start を起動
# Chromium未導入時: npx playwright install --with-deps chromium
npm run test:e2e
```

CIはNodeを固定し、型・Lint・単体／保存テスト・build・デスクトップ／iPhoneサイズのChromium E2Eを実行します。`PLAYWRIGHT_CHROMIUM_EXECUTABLE` でブラウザの場所を指定できます。実施結果と未検証項目は [検証記録](docs/manual-tests/acceptance.md) を参照してください。iPhoneサイズのエミュレーションと、iPhone実機Safariの検証は区別しています。

### 公開・設計・ライセンス

GitHub Pages向けの自動デプロイを用意しています。公開状況はActionsのdeploy・verify結果を確認してください。[iPhone利用・公開手順](docs/research/deployment.md) と [設計判断](docs/adr/001-local-editor.md) を参照してください。メール認証は任意で利用できます。制作データは引き続き端末内保存です。クラウド同期・AI翻訳・投稿台帳・SNS自動投稿・動画編集は将来フェーズです。

プロジェクト自身のライセンスは所有者の判断待ちです。第三者依存と同梱フォントの権利・ライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載します。

### Workflow Mode（Phase 1）

「Workflow」からノードの配置・設定・接続を編集できます。実行は今後対応です。自動保存はStudioとは別の端末内DBを使い、直近5世代を保持します。接続は端子のドラッグ／タップ、または詳細設定の端子選択で操作できます。詳細は[Workflow設計](docs/adr/002-workflow-phase1.md)と[iPhone試験手順](docs/manual-tests/workflow-iphone.md)を参照してください。入口を無効にする場合は `NEXT_PUBLIC_WORKFLOW_ENABLED=false` で再ビルドしてください。DBやユーザーデータは削除しません。

### Workflow First（WFR-5）

新しいタブではWorkflowから制作を始めます。「画像編集」を追加し、入力方法を選んで
共通エディターを開きます。作業版は自動保存。「保存してWorkflowへ戻る」で適用版を
確定し、「出力画像を更新」で選択ページのPNGを生成します。複数ノードの編集は独立し、
入力変更は固定入力を維持/コピー後に差し替え/コピーして作り直しから選べます。
全体実行エンジンとSNS直接投稿は未実装です。

「旧Studioを開く」から既存作品・テンプレート・旧ZIPを利用できます。
「旧作品を取り込む」は元を変更せず新DBへ独立コピーします。新Workflowの完全バックアップは
専用ZIP形式で、復元は新IDの別作品です。DB保存と端末へのダウンロードは別操作です。

`NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED=false` で再ビルドすると旧入口へ戻ります。
新DBは削除せず、新形式を旧DBへ逆変換しません。新版を再有効化するか対応ZIPで回復します。
実機iPhone Safari/IME/VoiceOverの受入は未実施です。
[設計](docs/adr/004-workflow-first-workspace.md) / [検証記録](docs/manual-tests/workflow-first-wfr5-results.md) /
[実機手順](docs/manual-tests/workflow-first-iphone.md)。

WFR-6ではPR #5の受け入れ検証と画像取込失敗時の一時Canvas解放を実施しています。
[WFR-6検証・Merge判断](docs/manual-tests/workflow-first-wfr6-results.md) と
[実機iPhoneの操作・期待結果](docs/manual-tests/workflow-first-iphone.md) を参照してください。
実機受入は未実施で、Merge・本番公開は承認待ちです。

### Workflow Phase 2 execution

Workflow First has a collapsible RunPanel for start/cancel, failure policy, node status,
result preview, recent history and pinned-input reruns. Source/text/number, resize/crop/
adjust, ordered image collections and applied image-edit output use a UI-independent
runner. Save/post remain unsupported; no SNS operation is performed.

The original Workspace v1 DB and v2 AssetRef remain intact. Execution history/cache/
immutable intermediate outputs use a separate local `axfluxo-execution` v1 DB. Graphs
contain references, not image bytes. A consumed execution result is copied once into
the existing editor input contract; Workspace ZIP includes that fixed editor input,
while execution history/unconsumed results remain local. Back up existing works as usual.

`NEXT_PUBLIC_WORKFLOW_RUNNER_ENABLED=false` hides/disables execution on rebuild while
retaining all documents and data. Existing Workflow First rollback flags still apply.
See [ADR 005](docs/adr/005-workflow-execution.md) for state/order/reference/cache/resource
contracts, DB selection, Phase 3/6 boundaries and rollback, and
[Phase 2 verification](docs/manual-tests/workflow-phase2-results.md) for evidence and
physical Safari checks that remain manual.

Phase 2のMerge前監査・不具合再現・最新の再検証結果は
[最終受け入れ記録](docs/manual-tests/workflow-phase2-acceptance.md)を参照してください。
最新runが未確定・不成功の場合、過去の成功出力は新しい入力として自動採用しません。
