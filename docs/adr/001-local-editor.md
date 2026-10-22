# ADR 001 — Local-first document and shared scene adapter

- **正本**: version 1のZod検証済みProjectDocument。React・Konva・Blob・DOM・URLをDomainへ持ち込まず、画像はUUID参照。描画・保存・出力はadapterを通す。
- **変更**: コマンド確定時だけ文書を更新する純粋reducer。時刻はコマンドから渡す。履歴は100操作、画像bytesを含めない。クロップは独立ドラフト、ドラッグは終了時確定。未知schemaVersionを拒否し、旧データを上書きしない。
- **描画**: Next App Router＋ReactはUIを担当し、Konva adapterが少数のCanvas層を管理する。プレビューと出力は同じscene構築関数。export専用Stageを論理px・pixelRatio=1で生成し、終了時破棄する。最初にreact-konva互換条件を調べたが、二重のStage管理と別の出力用ツリーを避けるため、未使用のreact-konva依存は除去した。エンジンはKonva一つのみ。React側で生成・破棄を管理する。
- **CSS**: この初期版は通常のCSSとlucideアイコンを使用。Tailwind/shadcnは推奨候補であり、追加の抽象化を必須にしない。フォントは同梱OFLファイルとハッシュmanifestを固定し、必要な文字列のロードを出力前に待つ。
- **クロップ**: source focusを0〜1で保存。回転逆変換からcover制約を計算し、四隅の包含を単体テスト。containとcoverの基準scaleを分離。楕円coverは外接矩形を覆う保守的計算。原本を破壊しない。
- **効果**: 正立画像→明るさ（乗算）→コントラスト→彩度の独自pixel adapter→Konva blur→crop clip→opacity。blur半径はsource倍率へ変換。CSS filterを出力代用しない。
- **文字**: DOM textareaを使用し、blurで入力をまとめて確定。grapheme単位の折返し・簡易禁則・英単語区切り・明示改行を処理し、同じ行レイアウトを両rendererで使用する。line/box背景、縮小とoverflow警告を実装。部分スタイル・縦書きは後続。
- **保存**: ネイティブIndexedDB、直列SaveQueue、snapshot固定、transaction内CASと参照検証。保存済み表示はrevision一致時だけ。過去5世代は復旧用であり完全backupの代わりではない。保存成功後の履歴整理失敗を、保存失敗と誤報しない。
- **テンプレート**: immutable versionを追加する。保存時に既存最新versionとCASし、再利用は新規ID群とtemplateOriginだけを持つコピー。画像bytesのみ共有する。
- **ZIP**: fflate（MIT）を最小依存として採用。EOCD／directory整合、entry重複、許可名、総展開量、サイズ、深さ、schema、参照、SHA-256、画像decodeを検証。圧縮・展開は現時点でメインスレッド。大型作品のWorker化と負荷測定は後続。
- **公開**: local-onlyの初期版を静的export可能にした。GitHub保存とPR mergeは依頼の範囲。公開デプロイは調査と手動workflowの準備に留め、実行しない。
