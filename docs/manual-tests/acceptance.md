# 検証記録 — 2026-10-23 JST

## 実装・検証した機能

- 新規作品、画像追加、中央固定クロップ（cover/contain・矩形/楕円・回転・ピンチ・適用/取消）、画像差し替え。
- 文字・図形・レイヤーの編集、順序・非表示・ロック、Undo/Redo、数値指定。
- 同梱フォント、行別/box背景、文字縁・影、overflow/shrink、画像の基本効果。
- ページ追加・複製・並べ替え・削除、サイズ設定と明示的な内容比例拡縮。
- IndexedDB自動/手動保存、CAS競合検出とコピー復旧、過去版復旧、完全ZIPバックアップ。
- テンプレートの不変版・複製・編集・削除・再利用、型付き変数と接頭辞/接尾辞。
- PNG/JPEG、ページ順ZIP、JPEG背景合成、進捗/取消、共有APIの機能検出。
- デスクトップ・スマートフォン向けUI、Space/パン/表示ピンチ、画面倍率に依存しない出力。

## 主な設計判断・主要ファイル

設計の理由と代替案は `docs/adr/001-local-editor.md`。

| 役割                             | 主なファイル                                    |
| -------------------------------- | ----------------------------------------------- |
| 正本・schema・履歴・変数         | src/domain/document.ts                          |
| 回転/cover/contain/drag/pinch    | src/domain/crop.ts                              |
| grapheme・折り返し・overflow     | src/domain/text.ts                              |
| 共通プレビュー/出力scene         | src/renderers/scene.ts                          |
| 画面・入力・操作パネル           | src/features/editor/Editor.tsx                  |
| viewport / クロップdraft         | src/features/editor/Canvas.tsx / CropDialog.tsx |
| 保存CAS・直列queue・版管理       | src/services/storage.ts                         |
| 原本/正立画像・magic/decode/hash | src/services/assets.ts                          |
| ZIP安全取込・完全backup          | src/services/backup.ts                          |
| オリジナル2ページサンプル        | src/services/sample.ts                          |
| CI / 手動公開                    | .github/workflows/ci.yml / pages.yml            |

## コマンドと自動検証

Node24.19.0。テストは自作の幾何学画像を使用。

| コマンド             | 結果                                               |
| -------------------- | -------------------------------------------------- |
| npm run typecheck    | 成功（Next typegen + strict TypeScript）           |
| npm run lint         | 成功、警告を含め0件                                |
| npm test             | 単体・保存・ZIP検証29件成功                        |
| npm run build        | 成功、static export `out/`生成                     |
| npm run test:e2e     | desktop / iPhone13サイズのChromiumで10シナリオ成功 |
| npm audit --omit=dev | 実行時依存の既知脆弱性 0件（当日のDBによる）       |
| git diff --check     | 成功                                               |

E2Eで確認した操作:

1. 日本語/英語/改行の編集→自動保存→reload→同じ文字列で再編集。
2. 画像追加→クロップ回転取消で初期値復元→回転適用→1080×1080 PNGの実寸確認とdownload。
3. Chromiumへの2点touch入力でクロップzoomが増加すること。数学的アンカー保持は単体テストで別に検証。
4. 画像原本/正立画像を含むbackupを、保存領域が空の新規ブラウザcontextへ取込→再出力。
5. JPEG白背景合成と非表示レイヤー除外を中心pixel RGBAで確認。Undo/Redo・ロック時の削除禁止。
6. 全2ページZIPのファイル名・順序確認。
7. 複数タブの同revision編集→上書き拒否→コピー復旧で双方の内容を保持。
8. オリジナル2ページsampleの変数変更・PNG出力・template化・別作品作成。元作品の値不変と新規project/page/layer IDを確認。

単体/保存テストでは、回転7角度×縦横画像の四隅包含、contain、drag/pinch、未知schema/NaN/危険キー、履歴分岐、templateの深い分離、文字grapheme、保存競合、queue失敗後の継続、template版競合、ZIPパス/重複/上限/途中切断を検証した。

GitHub Actionsでもクリーンcheckoutから検証する。main merge前に最終HEADのCI成功を確認する。

## 実機テストの結果

**iPhone実機Safari・実機キーボードの試験は未実施。** iPhone13の画面サイズ・タッチ設定でのChromium自動検証は実機Safariの代替としない。

未検証:

- 実機の日本語IME変換中Enter、キーボード開閉・画面回転・safe-area。
- SafariのEXIF方向全8種類、HEICからのOS変換、広色域画像。
- 実機での1080pxプレビュー対出力の視覚比較、フォント全glyph・絵文字。
- iOSの連続download、FilesアプリZIP、Web Share、容量不足の実端末挙動。
- 最大24MP・20ページ・100レイヤー・200MiBでのメモリと操作性能。
- 保存transactionの実端末quota障害・ストレージ回収・端末強制終了。
- 公開ホストでのHTTPS到達とPages environment設定（公開未実行）。

## 既知の制限

現在の自動テストで未解決の再現失敗はない。ただし上記未検証を成功扱いにしない。大容量ZIP圧縮/展開・画像エフェクトはメインスレッド処理で、大きい作品は待ち時間が生じる。画像素材は履歴保護のため自動削除しない。テンプレートライブラリ丸ごとのbackup、カラー絵文字の統一、クラウド同期・AI・SNS・動画は対象外。復旧履歴は端末内であり、外部バックアップの代替ではない。

## 起動・保存・次の作業

起動はREADMEの `npm ci` → `npm run dev`。端末内へ自動保存し、外部保存にはスタジオ「バックアップ」、持ち込みには「バックアップ取込」を使う。保存済み表示と実際のrevisionを一致させる。

次の優先作業はiPhone実機Safariで上の未検証項目を実施し、必要なら性能上限を調整すること。公開する場合は `docs/research/deployment.md` のPages設定と手動workflowを所有者が実施する。初期基盤の確認後に、認証・同期、AI/投稿台帳、SNS公式連携、動画技術実証の順で拡張する。
