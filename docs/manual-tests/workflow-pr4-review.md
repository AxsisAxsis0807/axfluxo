# PR #4 最終検証・限定修正 — 2026-10-25 JST

## 調査対象と基準

- 既存Draft PR: https://github.com/AxsisAxsis0807/axfluxo/pull/4
- ブランチ `feat/workflow-phase1`、調査開始HEAD `f4280b75b187e097724eb29eee5ccb2e2f131243`。開始時の作業ツリーはクリーン。
- fetchしたmain: `f8c4712a58d77bd1d56754cb6104b4e4226da527`。mainの上書き・reset・Mergeは行わない。
- 祖先ディレクトリとリポジトリ配下にAGENTS.mdなし。package.json/lockfile、差分26ファイル、既存テスト、認証・保存、Next設定、CI/Pages、既存ADR/手動検証記録を調査。
- 既存PRのCI / Pages PR検証は成功（Actions 40091585191 / 40091585195）。レビュー投稿・インラインスレッドなし。これは修正前HEADの結果であり、追加commitのCI成功とは区別する。
- 元の詳細仕様（本スレッドで提示されたPhase 1全12節）を基準とし、新規アプリ・新規PRは作らない。

## 修正前baselineと再現

typecheck、lint、単体45件、root静的ビルド、既存E2E36件が成功。既存テストを削除・skip・無効化せず、次の不足を追加試験で再現した。

1. **フォーカス中の設定が保存されない**: 文章を入力して5秒以上待っても保存文書は空文字。欄を離すまでonBlur確定しないため、「保存済み」のまま再読込で入力を失えた。
2. **不正設定の表示と保存状態が不一致**: 幅0を入力して検証エラーになっても「保存済み」。訂正後に古いエラーが残る経路もあった。
3. **コピー復旧が未保存編集を捨てられる**: 名前変更直後でも復旧ボタンが有効。保存コーディネータをdisposeして文書を切り替えるため、保存待ち・保存中の追加編集を失う経路があった。
4. **通常の文章を画像扱いする誤判定**: `metadata: base64という単語の説明` を拒否。追加単体テストで再現。
5. **ノード上からのピンチ未対応**: ヘッダー上で2点距離を倍にしてもzoomは1→1。React Flowのノード上pan抑制により、空白上のピンチだけが動いていた。
6. **保存表示でキャンバスが動く**: モバイルの保存表示切替でcanvas topが273→258 CSS pxに変わり、中点保持の試験が失敗。保存状態の文字幅でツールバーが折り返されていた。

7. **親再描画時にノードが消える経路**: 追加touch試験の失敗traceで、選択開始直後のノードが`visibility:hidden`になった。React Flowが返すmeasured寸法をadapterが保持せず、親の再描画で初期化状態が失われていた。

## 実施した限定修正

- 設定欄はDOMを置き換えずに入力を保持し、妥当な変更をその場で文書へ反映して既存の750ms/最大5秒保存へ渡す。入力欄のnative UndoとIME変換を維持する。
- 不正な数値や変換未確定の文字はローカル入力に留め、「入力未確定・未保存」と離脱警告を表示。保存済み文書を不正値で上書きしない。妥当な訂正で入力エラーを解除する。
- 保存エラーと操作エラーの状態を分離し、保存再試行成功後に古いquotaエラーを残さない。
- 復旧コピーへの切替は、現在の文書と入力が保存済みになるまで無効化。競合時の別コピーは従来どおり利用できる（未確定入力がある間は除く）。
- 画像data URI・tokenの拒否は残し、通常の語の部分一致を拒否しない。
- ノードから始まる2本指操作だけを補完し、文書座標とviewportを分離したまま中点固定のpinch→残り1指のpanへ移行する。空白のReact Flow標準操作は維持。native touchend/cancelをD3に届け、ノードのドラッグ位置は1操作で確定する。計算は独立した `src/domain/workflow/viewport.ts` に置く。
- 保存状態の表示幅・高さを固定し、ジェスチャー中のツールバー折返しを防ぐ。
- React Flowの計測寸法はadapter内の一時stateに保持する。文書や保存schema、Undo履歴には入れず、選択・保存状態による再描画でノードを隠さない。

DB名・version・store・保存schema v1は変更しない。既存Studio、Canvas/CropDialog、Konva、auth/asset/backup/storageサービス、package/lockfile、Next設定、CI/Pages workflowに今回の変更なし。Phase 2・SNS・実行エンジン・backendの追加なし。

## 元仕様との照合

| 元仕様                                                                   | 実装状況・証拠                                                                                                       | 判定                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1/2 既存コード統合・Studio/クロップ/PNG/JPEG/ZIP/認証/ゲストを維持       | 元mainから限定追加。既存22件の認証/Studio/出力/ZIP E2Eを両basePathで回帰                                             | 実装済み・自動検証             |
| 3 ライブラリ固定・Konva維持・client遅延読込                              | React Flow 12.12.0 / Dagre 3.1.2、MIT、peer互換の既存ADRとlockfileを確認。依存更新なし                               | 実装済み・構成確認             |
| 4 検索・追加・設定・fit/100%・整列・複製/削除・解除・Undo/Redo・保存表示 | 既存UIを維持し、設定の保存・表示だけ修正。実行は今後対応で無効                                                       | 実装済み・自動検証             |
| 5 スマホpan/pinch/ヘッダードラッグ/端子タップ・ドラッグ                  | CDPの実touchイベントで検証。ノード起点pinchと中点保持、1→2→1・cancel・lost capture後の復帰を追加                     | 不足修正・自動検証（Chromium） |
| 5 PCホイール・左/中ボタンpan・ヘッダー移動・接続                         | 既存E2E＋追加touch/接続試験。補助ブラウザ試験で中ボタン移動45×32px→viewport変化45×32px、resize後の文書座標不変を確認 | 実装済み・自動検証             |
| 6 独立schema/5種類ノード/型・分岐・単一入力・循環・重複・削除edge        | UIと独立したschema/connections。単体と分岐復元E2E。保存/投稿ノードは独立、投稿方式は設定                             | 実装済み・自動検証             |
| 7 履歴・ID・1ドラッグ/整列=1操作・フォームUndo分離                       | 単体＋ドラッグUndo＋設定Undo/Redo＋native入力Undo。pan/pinchは文書履歴に入れない                                     | 実装済み・自動検証             |
| 8 別DB・750ms/5秒・直列/CAS・保存世代・競合・障害・未知schema            | 既存DB v1を保持。単体で世代/直列/CAS/障害、E2Eで2タブ/復元/コピー/quota再試行、復旧切替の保護を追加                  | 実装済み・自動検証             |
| 9 日本語・focus・キーボード・色以外の型表示・responsive/reduced motion   | 日本語UI・型名/方向・明確なfocus・一覧/設定/解除を確認。CSSのsafe area/reduced motionを確認                          | 実装済み、実機補助技術は未検証 |
| 9 44 CSS pxのタップ目標                                                  | ボタン/詳細端子UIは44px。canvas端子は100%で44px、25%では11pxになり、全倍率での目標は満たさない                       | 制約あり（下記）               |
| 10 UI/文書/保存分離・既存Editor全面変更をしない                          | 今回はWorkflow周辺と独立したviewport計算のみ修正。既存Editor変更は追加していない                                     | 適合                           |
| 11 root/basePath/既存テスト維持・実機区別                                | baselineを再取得し、追加回帰試験を実施。既存テスト削除/skip/緩和なし                                                 | 結果は下表                     |
| 12 同じfeature branch/PR・rollback・停止条件                             | 同じPR #4へ追記。入口flagをfalseにしても新旧DBは保持。Merge/デプロイ/Phase 2は実施しない                             | 適合                           |

## 最終検証結果

Node 24.19.0 / npm 11.9.0。desktopとiPhone 13サイズのChromiumを使用。rootと`/axfluxo`の成果物を別の固定ディレクトリ・ポートで配信し、試験中にビルド成果物を置き換えない。

| チェック                                     | 結果                                       |
| -------------------------------------------- | ------------------------------------------ |
| npm run typecheck                            | 成功                                       |
| npm run lint                                 | 成功（警告0）                              |
| npm test                                     | 47件成功（既存45＋通常文字列/ピンチ幾何2） |
| npm run build (root)                         | 成功、static export                        |
| NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build | 成功、static export                        |
| root npm run test:e2e                        | 52件成功（desktop26＋mobile26）            |
| /axfluxo npm run test:e2e                    | 52件成功（desktop26＋mobile26）            |
| git diff --check                             | 成功                                       |

追加E2E8ケースをdesktop/mobile双方で実行する。①フォーカス維持中の自動保存とnative Undo、②不正値/訂正、③保存待ちの復旧保護、④実touchの端子タップ/drag、⑤ノード上pinch中点・1→2→1・lost capture、⑥設定Undo/Redo/再読込、⑦quota保持/再試行/エラー解除、⑧composition未確定の保存表示。compositionイベント試験は実機IME試験ではない。計測寸法の修正後、ヘッダードラッグ・ノード上pinch・capture後復帰をdesktop/mobileそれぞれ3回、計6回連続で成功させた。

## 残存制約・未検証・Merge判断

- **実機iPhone Safariは未実施。** iOSのIME、VoiceOver、ソフトウェアキーボード、safe area/回転、pointer/touch/cancelの実機挙動は、[既存の実機手順](workflow-iphone.md)で受け入れ確認が必要。ChromiumをSafari成功とは扱わない。
- **縮小時のcanvas端子の44px目標は未達。** 全倍率で単純拡大すると隣接端子のヒット領域が重なるため、今回の限定修正では変更しない。100%表示に戻すか、44px以上の詳細端子選択UIでドラッグなし接続できる。仕様の目標との制約として残し、黙って完全適合にはしない。
- quotaはブラウザ/単体でDOMExceptionを注入した試験。実端末のquota限界・OS回収・強制終了・最大200ノードの性能は未検証。
- 認証の回帰は公開設定＋HTTPモック。実メール配信、本番Supabase変更、SNS API、実投稿、公開サイトへのデプロイ確認は行わない。
- **現時点は無条件Mergeを推奨しない。** 最終自動検証と最新commitのCI成功を確認した上で、実機Safariの手動受け入れを推奨し、未実施のまま進める場合は未検証事項と縮小時端子操作の制約を所有者が了承することを条件とする。PRはDraftのまま、Merge・デプロイを行わず承認を待つ。
