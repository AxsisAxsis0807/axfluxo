# タイムラインと端末内自動書き出しキュー

## 調査した構造と問題

基点はmainのa917cc6。親ディレクトリとリポジトリにAGENTS.mdはなかった。PR #15（a197f77、レーン内Canvas波形）、#16（a5784ed、左右のドラッグ・キーボードハンドル）、#18（07a66f1、分割音声解析）の差分とPR説明を確認し、すべてmainへ統合済みであることを確認した。

両端末内ツールはLocalVideoTool → LocalTimeline → Timelineを共有する。クラウドの両エディターもTimelineを共有するが、再生は既存のVideoPreview/PlaybackControllerを使用する。端末内出力はLocalExport → encodeLocal（Canvas/MediaRecorder/Web Audio、専用video要素）であり、サーバー出力とは別系統。既存のローカル保存テンプレート、プロジェクト/IndexedDB、Studio/Workflow、クラウドAPI、パスコードの検証方式は維持する。

問題は最低2pxの波形バーによる無音の誤表示、概要ピークの20,000bin上限、timeupdateによる低頻度表示更新、元の全時間を移動可能なタイムライン、画面のuseEffect終了で中断される出力、予約/進捗率/出力保持上限の欠如だった。

## 音声波形

既存analyzeLocalWaveformへ最大30秒の区間解析を追加した。概要は従来の20ms/bin・最大20,000bin。100px/秒を超えるズームでは可視ソース区間を250ms単位で外側へ丸め、250msのデバウンス後に追加解析する。要求したstepと元音声のsample rate、最大20,000binで実際の粒度を決める。最大倍率でも補間でピークを作らない。AAC/MP3の高精細解析は元トラックのsample rateでWeb Audioを使用し、概要8kHzから引き伸ばさない。PCM/他対応codecは既存AudioBufferSinkの時間範囲指定を利用する。

AAC/MP3はパケットの約200msプリロールと既存の約4秒音声専用リマックスを再利用する。動画を全体展開しない。読み取りキャッシュ2MiB・チャンク4MiB/4.5秒・8ch/96kHzの既存制限を維持する。高精細時のPCMは概要8kHzより大きくなるが、チャンク時間とチャンネル数で制限する。20,000binは概要と各可視区間ごとの上限であり、長時間ファイル全体を高精細で保持する上限ではない。

File単位WeakMapの概要キャッシュに加え、詳細はFileごとに直近4区間のみ保持（1区間最大40,002個程度のnumber）。キャンセルと世代照合で古いファイル・ズーム区間の結果を表示しない。概要解析と追加解析は既存の共通直列デコード枠を使う。概要の完了までは追加要求を出さない。追加解析待ち/失敗時は「概要を表示」と明示する。画面外は解析・描画対象にせず、サブピクセルの小音量も閾値で切り捨てない。

Canvasは振幅が厳密に0ならバーを描かない。それ以外は実振幅に比例させ、最低高さを設けない。中央線は別の薄いstroke。可視領域に余白を加えた範囲だけ描画する。元ピーク間隔より細かく同じバーを繰り返さず、広い表示ではピークを集約して短い過渡音を残す。

音声位置は常に元素材のマイクロ秒。詳細のoriginUsからピークindexを計算する。全バージョンの結合出力は既存localIntervalsの `編集時刻 = 先行素材の採用長合計 + 元時刻 - trimStart` を維持。各素材のタイムラインのバージョンマーカーと波形は同じ元時刻で配置する。ローカルschemaのsampleRate:8000は既存の互換フィールドであり、詳細の時間粒度はlevel.stepUs/originUsを使用する。

## トリム・再生・操作

通常表示のスクロール内容自体を採用範囲に制限する。範囲が表示幅より短ければ左右均等の余白を置く。ネイティブscrollLeftの境界とoverscroll-behavior、独自ポインター操作でマウス/タッチ/ホイール/ピンチ後も境界を維持する。通常のタップ/矢印キー/Home/Endは範囲へclampする。メディアのseekingを監視するのでネイティブvideoコントロールのシークも制限する。

「トリミング範囲を編集」で元の全時間を再表示する。保持部分は明るいレーン、除外部分は暗い背景。既存44pxハンドル・ドラッグ中の開始/終了/長さ表示・キーボード微調整を維持し、除外部分へ境界を広げ直せる。通常表示への切替時は範囲とスクロール境界を再計算する。数値トリム入力も元の全素材範囲を編集でき、無効な出力設定は既存prepareの検証で拒否する。

FNFは既存の独立/重複rangeを維持する。通常プレビューは選択したrange単位で制限し、範囲セレクターで切り替える。全rangeのハンドル編集と予約時の全range出力は維持する。rangeがない場合は素材全体のプレビューとなり、書き出しには有効なrangeが必要。

bindTrimPlaybackはloadedmetadata/seeking/play/timeupdateとrAFで境界を監視する。終了時はpauseして終了時刻へ合わせ、終了後のplayは開始へ戻す。loop=trueなら範囲内でループ。範囲変更時に現在位置も制限する。元ファイルの変更はしない。ブラウザのメディア制御を使うため、リアルタイム停止の粒度はフレーム/イベントの遅延を受ける。

TimelineのrAFはvideo.currentTimeを直接読み、再生ヘッドのDOM位置とスクロールだけ更新する。時計の推測値は蓄積しない。中央付近へ追従し、開始・終了でスクロールが自然にclampされる。手動操作中と終了後1.2秒は追従を休止し、その後はスクロールを徐々に追いつかせる。Reactの可視範囲更新は約80ms間隔、波形はmemoで再生時刻だけの更新から分離。解析はrAFから呼ばない。クラウドVideoPreviewにはローカル専用bounds/mediaを渡さず、既存の操作方式を保護する。

## キュー・ミニバー・スナップショット

ExportQueueはReact外のタブ単位ストア。subscribe/getSnapshotをuseSyncExternalStoreで購読する。LocalExportは予約時だけprepareを呼び、LocalVideoToolのそのレンダー時の設定を固定する。piecesの配列と開始/終了値をコピーし、描画closureはその時点のテキスト・crop・スケール・境界・カバー画像を保持する。既存の解像度（FNF 1080x1920、All Versions 1920x1080）、60fps・音声設定を維持する。

素材はFile参照を保持し、実行時にキュー専用のObject URLを作成する。編集側の素材削除や画面のunmountで元のURLが解放されても予約は影響されない。カバーは予約準備時にロード済みのHTMLImageElementを保持する。作業画面がなくても予約は動作するが、文書全体の再読み込み/通常のaリンクによるページ移動はタブ内メモリを失う。beforeunloadで警告するが、特にiOSでは必ず警告される保証はない。予約/完成ファイルは永続化・復旧対応と表示しない。

pumpは同期的に実行枠を取得し、前ジョブのfinally（Recorder停止、音声切断、video/URLの解放）完了後に次のqueuedを自動開始する。同時エンコード数は1。queued/preparing/rendering/completed/failed/cancelledを区別する。実行中・待機中キャンセル、待機中の並べ替え、失敗の再試行を提供する。取消後に遅れて返った成功は無視し、取消処理が完了するまで実行枠を譲らない。通常失敗はそのジョブに記録して後続へ進む。非表示/画面ロック/ロック失効はキューを停止し、実行中は失敗として再試行可能にする。共有障害時は手動一時停止も可能。

ExportDockはルートlayoutに常駐する小さな進捗バーと非モーダル詳細パネル。モバイルは下部シート、PCは右下パネル。閉じても処理は止めない。safe-areaと末尾余白を設ける。進捗率・ファイル名・状態・待機数、詳細の各ジョブは同じストアから描画する。エンコーダーからの進捗通知は約100msに抑える。セッションとverifierが有効な時だけ表示し、再ロック通知では即時非表示/中断する。セキュリティ境界を広げない。

## メモリ・保存・Safari

最大12件（完了/失敗を含む）の保持上限で予約を原子的に受理/拒否。1ファイル256MiB、完成Blob合計512MiB以内に制限するため、次の1件分256MiBを確保できない時は開始を保留する。最大サイズ到達時のエンコードはエラーにして小さい区間を促す。これはブラウザ全体のメモリ保証ではない。録画チャンク・Blobの内部コピー・デコーダー・Canvas・選択素材の管理領域などは別途必要。

完成Blobは画面を閉じても保持する。保存リンクのObject URLだけをパネルの開閉で再作成/解放する。保存を検知したとして自動削除しない。Files/写真で確認後にユーザーが明示削除する。失敗した保存は同じBlobから再操作可能。完了ジョブの入力/描画closure、キャンセル済み入力は解放し、失敗は再試行のため保持（削除可）。URL・AudioContext・MediaStreamは終了/例外時に解放する。

Safariはユーザー操作によるWeb Audio/メディア再生許可が必要な場合がある。予約ボタンで同期的にAudioContext.resumeを呼び、必要なら既存の再生許可ボタンや詳細の「音声処理を許可・キューを再開」で継続する。通常は次ジョブごとに開始ボタンを押す必要はない。録画は編集プレビューとは別video・Canvas・音声経路。端末負荷が高い時はプレビューの一時停止を案内する。ローカルエンコードを維持し、Supabase/Video API移行は不要。

画面ロック/バックグラウンド/タブ終了/OSの低メモリ終了を越えての継続は保証しない。hiddenで実行中を中断し、待機中を維持して明示再開する。完成ファイルの永続化や中断復旧は今回行わず、IndexedDBの既存データ・スキーマには変更しない。AAC/MP3のチャンク時間誤差など既存音声解析の制限も残る。

## 検証

- 型チェック、全体Lint、本番静的ビルド成功。
- 全40ファイル・326単体/回帰テスト成功。さらに終了境界で反復シークしない回帰テストを追加。キューの4件直列・同時1件・実行中追加・スナップショット・遅延キャンセル結果破棄・後続継続・並べ替え・再試行・保持上限・非表示中断を追加検証。
- Chromium: 既存波形/プレビュー13件成功。新規詳細解析/無音Canvasと既存実音声出力を含む11件成功。実ファイルを使った3件連続予約、画面/パネルunmount後の継続、個別保存、PC/390pxトリム再拡張と停止/再開を確認。
- WAV/MP3/M4A/MP4/MOV、合成363秒/33MiB超MOV、603秒音声は既存回帰テストで確認。実ユーザーファイルそのものではない。
- WebKit取得はcdn.playwright.dev等がネットワークポリシーの403で失敗。ローカルWebKitおよびiPhone実機のSafariは未検証。CIの既存WebKitプロジェクトに新規試験も含まれる。
- 初回sandbox内のffmpeg/ffprobe/ChromiumはEPERM、NextビルドはTypeScript子プロセス出力取得で失敗。許可された制限外実行で上記の成功を確認した。

全体ブラウザ/E2E結果はPRへ追記する。

## 変更ファイル一覧

- `docs/video/local-waveform.md`
- `server/tests/browser/developer-entry-fixture.tsx`
- `server/tests/browser/developer-entry.spec.ts`
- `server/tests/browser/local-encode-fixture.tsx`
- `server/tests/browser/local-encode.spec.ts`
- `server/tests/browser/local-waveform.spec.ts`
- `src/app/layout.tsx`
- `src/features/developer/LocalDeveloperGate.tsx`
- `src/features/developer/LocalTimeline.tsx`
- `src/features/developer/LocalVideoTool.tsx`
- `src/features/video-common/LocalExport.tsx`
- `src/features/video-common/Timeline.tsx`
- `src/services/video/local-encode.ts`
- `src/services/video/local-waveform.ts`
- `docs/video/timeline-export-queue.md`
- `server/tests/browser/timeline-queue-fixture.tsx`
- `server/tests/browser/timeline-queue.spec.ts`
- `src/features/video-common/ExportDock.tsx`
- `src/features/video-common/useWaveformDetail.ts`
- `src/services/video/export-queue.ts`
- `src/services/video/local-export-runtime.ts`
- `src/services/video/trim-playback.ts`
- `tests/video/timeline/export-queue.test.ts`
- `tests/video/timeline/trim-playback.test.ts`
