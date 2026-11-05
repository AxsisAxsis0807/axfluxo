# 中央固定タイムラインのトリミングツマミ修正

対象: All Versions Video Maker / FNF Showcase Maker。
調査基点: main `784ae4a4fd89ce98eb68707ce48b4a6669b9bef8`（PR #22マージ済み）。
リポジトリ内・/workspace配下にAGENTS.mdは存在しなかった。

## 再現できた原因とPRとの関係

- `LocalTimeline`は初回の`editing`をfalseにし、保存されたfalseも復元する。共有`Timeline`は`editing &&`で開始・終了buttonを両方生成しなかった。素材読み込み直後の両ツールで実際にDOM不在を再現した。この条件自体はPR #21以前から存在し、iPhone固有の新規CSS不具合とは断定できない。編集モードを有効にすると従来コードでもDOMは生成される。実機で報告された状態がこれと完全に同一かは未確認。
- PR #21の`82f86b2`は、ツマミのleftを`clamp(..., scroll, scroll + width - 44)`へ変更した。表示外の時刻でも画面端に移動してしまい、時刻座標が偽られる。390×844、80px/秒、scrollLeft=320のテストでは開始0秒が本来の-142pxでなく22pxに表示された。両ツールで再現した。
- 元のvisibilityは表示窓でなく仮想トラックのorigin/spanだけを参照し、画面外マーカーと仮想化を混同しやすかった。クリップされたlaneLeft/laneRightからツマミ位置を作っていた点も修正した。
- PR #22のTimeline変更は`tickInterval`導入のみ。保存のArrayBufferチャンク、SHA-256、出力パケット検証は今回変更しない。差分から「#22がツマミを削除した」とする根拠はない。
- ツマミはCanvas描画ではなくDOM button。Canvasはpointer-events:noneで、波形レーン内だけoverflow:hidden。ツマミはその兄弟要素。実行したChromiumでopacity/displayや波形Canvasによる非表示は再現しなかった。WebKit/iPhone固有の追加原因は未確定。

## 修正

- 開始・終了ツマミを通常再生モードでも生成。通常のシーク／再生のtrim制限と、除外範囲へ移動できる編集モードの意味は維持する。
- 位置は`viewportWidth / 2 + (timeUs - originUs) / 1e6 * pxPerSecond`。viewportの端へ時刻を偽って移動させない。viewport overflowで実際の表示範囲だけを表示し、仮想トラック外のbuttonは生成せずscrollWidthの肥大化を防ぐ。半画面padding内ではtrimを外側へ拡張できる。
- 開始は緑の「始」、終了は赤の「終」。通常44×88px、44px未満の短い区間では上下に分けた44×44pxのタッチ領域にして、開始・終了が互いを覆わない。ツマミは波形・Version境界・白い中央ヘッドより前面。白いヘッドの位置は中央固定のまま。
- 既存Pointer Eventsのpointer capture、touch-action:none、キャンセル時の破棄、ピンチによるドラフト取消、px基準のマグネットを維持。ドラフトの時刻出力に領域を確保し、表示開始でレイアウトが跳ねないようにした。
- 開始／終了は1フレーム以上の区間を維持し、端末内All Versionsの編集可能なVersion境界の前後1µsまででクランプ。マウス／タッチ／キーボードで同じ制約を使い、trimドラッグが境界を消さないようにする。FNFの独立range同士の重複仕様は変えない。クラウドプレビューの読み取り専用境界は従来どおりtrim範囲から除外できる仕様を維持する。

## テスト

`server/tests/browser/trim-handles.spec.ts`は本物の`LocalVideoTool`とMP4を使用し、実際のglobals.cssを読み込む。390×844で両ツールを検証する。初期DOM生成、gripの描画サイズ、44px以上のヒット領域、elementFromPointによる重なり確認、0秒／終端の編集、座標、scroll後の画面外位置、ズーム／ピンチ、中央固定、中央時刻への正確な吸着、開始／終了の順序、Version境界の保護、ドラッグ確定後の値とIndexedDB自動保存後のリロード復元を検査する。

ChromiumではCDPのtrusted touchStart/touchMove/touchEndを注入し、1本指でヒットテスト・captureを通したドラッグと操作中の縦スクロール不発を検査する。ピンチとWebKitのドラッグ経路は合成touch PointerEvents。Playwrightの公開WebKit touchscreen APIはtapのみなので、WebKit上でネイティブの連続タッチを検証したとは扱わない。既存のWebKitプロジェクトとCIの`test:video:browser`に自動で含まれる。skipや既存テストの期待値緩和は追加しない。

新規4テストを修正前に実行し、両ツールで初回DOM不在とscroll後の164pxの座標誤差を確認した。追加テスト作成中は、ブラウザーの整数scrollLeftに合わせて吸着先を実際の中央時刻から厳密に算出した。復旧テストでは既存の約20秒のリース終了待ちを待ってから値を検査する。初回CIではWebKitのダブルクリックが縮小1回分になり、2回分の倍率を仮定した吸着テストが失敗した。倍率の期待値を下げず、縮小を2回個別にタップしてそれぞれの倍率更新を明示的に確認してから厳密な吸着先を検査するよう修正した。並行Playwright実行で成果物ディレクトリが競合したため、それらの結果は最終結果とせず1プロセスで再実行する。

## 実機で必要な確認

1. 両ツールに素材を追加し、通常モードでも開始／終了が色・文字付きで見えること。編集モード切り替えとリロード後にも確認。
2. Home/End相当の操作と横ドラッグで0秒／素材終端を中央へ置き、1本指で両ツマミを内外に動かす。縦スクロールに化けず、離した値が保持されること。
3. 波形スクロールとツマミ操作を交互に行い、表示外のツマミが偽の時刻で画面端に残らないこと。
4. ピンチ前後の中央時刻、波形と目盛りの移動、中央への吸着と意図的に引っ張った解除、Version境界の順序を確認。
5. ほぼ1フレームの短い区間で上下の両ツマミを個別に操作できること。
6. 自動保存表示後にSafariを閉じて再開し、最大約20秒のリース待ち後にtrim値とズームが復元すること。
7. 既存の波形の無音・微小音、書き出しキュー、MP4の音声／映像、Files/写真への保存確認、確認済み成果物だけの一時データ削除も実機で確認。

WebKit配布元cdn.playwright.devは実行環境で403 Domain forbidden。iPhone Safari実機は未確認。Chromium成功をSafari実機成功とは記載しない。
