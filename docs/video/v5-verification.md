# V5 verification — 2026-11-01 JST

Base V4 `0ac057c`、作業branch `feat/video-v5`。開始時の最新mainは`367fb02570b4782aa5f51e892718fc473b376c59`。AGENTS.mdなし、README/ADRとV0〜V4を確認。PR #8の既存画像Workflow/Studioとの実装箇所の競合なし。Node24.19.0/npm11.9.0。参考画像は未提供なので一致判定は実施していない。

| Gate                | 最終結果                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / ESLint | 成功、warning 0                                                                                                              |
| 全unit/integration  | 28 files、273/273成功（V4既存252を維持、追加21）                                                                             |
| 通常PostgreSQL18.6  | 専用loopback DB `axfluxo_video_test_v5b`、V5の11/11成功。複数接続の同時更新/409/冪等性、実render/publicationを含む           |
| Chromium製品UI      | 全7/7成功。V3既存6＋V5制作フロー1。実media elementとserver PNGを使用                                                         |
| rollback E2E        | root、desktop/mobile計6/6成功。新入口OFFで5つのDBのversion/record保持とAPI非接続を確認。既存preview/cloud OFFも維持          |
| 静的export          | root・`/axfluxo/`両方成功。最後にroot artifactを生成                                                                         |
| server bundle       | API/render/derivative worker独立build成功                                                                                    |
| Linux runtime       | 非root、network none、read-only、CPU2/RAM1GiB/PID128下で1080p 24frame/1440p 5frameのPNG合成・AAC320k・全frame/decode検証成功 |
| 保存互換            | `axfluxo-developer` v1のversion/store定義に変更なし。既存4DB/Studio/Workflow/backupとV0文書schema/時刻契約に差分なし         |

Linux runtime試験は**既存V4 Docker imageを基盤**に、最終V5のsmoke bundle、新native dependencyと固定fontをreadonly mountして実行した。Dockerfileには同じnative packageとfont/licenseの配布を追加したが、V5 image全体の再build/publishは今回行っていない。ホストffmpeg7.1.5、image内ffmpeg5.1.9の両方で処理した。cloud/DBへのDockerネットワーク接続は使用していない。

## 機能と障害注入

- clip順序・累積frame境界・trim後marker保持/拒否、空行/番号原文の保持、名前数の不一致、fadeの前後frame、短区間の検出。5,001 versionsと100時間の時刻/区間計算を実行し、独自のcount/time上限がないことを確認。
- MP3/WAV/M4Aは実バイトをffprobe検証し、全長proxyと3解像度波形を生成。MP4/MOVはverified videoを音源として実renderし、原本hashが変化しないことを確認。
- 1080/1440のfont raster寸法、長名の1行縮小、preview PNGとworker PNGのバイト一致、font欠損/改変/未収録glyphの拒否。font hashとrendererを固定し、失敗時にfallback描画しない。
- 出力MP4の全frame PTS/frame数/codec/duration/SARと全decode、AAC priming/sample count/hashをV4 validatorで確認。文字PNGのfadeを実frameの画素で比較し、marker境界で文字が切り替わることを確認。
- marker前後を含む音声PCM相関>0.98、RMS比0.95〜1.05を確認。既定mono→stereoの約3dB低下を検出し、V5だけunity複製へ修正。音量操作・音声fade・normalizationなし。
- 数frameの出力でMP4 edit listがaudio durationをms単位に丸める問題を検出し、V5にmovie timescale=240000を追加。B-frameの短segment結合でcontainer avg rateが崩れる問題も検出し、V5 templateだけB-frameを無効化。V4非templateの既存出力設定は維持。
- 750ms debounce、直列queue、flush barrier、IDB document/outboxの原子性、quota途中失敗、2tab CAS、古い保存失敗が新しい編集を再上書きしないこと、古いcloud ackが新しいoutboxを消さないことを確認。
- offline時のlocal保存/outbox維持、cloud 409でproposal/remote双方の保持、2device同revision競合、Idempotency-Key再送、JWT/membership/別owner/失効とaccount切替headerの拒否を確認。認可はfrontend表示で代用しない。

Chromium UIは6段階の移動、素材/cover選択、marker追加、空行修正・番号除去、1440選択、手動flush/sync、server文字PNG表示、offline編集のIDB保持を実行。V3共通editorのpinch/pointercancel/IME/横向き/背景復帰・signed URL復帰・結合clip試験もそのまま再実行。

## 未実施・限界

参考画像との位置/色/一致率評価、実機Safari/OSタブ破棄、WebKit自動実行、R2実接続、複数の物理端末、100時間の実render、最大容量・実機quota枯渇は未検証。多数versionと長時間はmetadata計算の試験で、無制限のRAM/disk/転送容量を保証しない。Aleoにない日本語等は未対応エラーとし、無断の別font使用はしていない。offlineで未生成の文字PNGや未cacheのmediaは新規生成/取得できない。

editorのproxy連結には端末のseek/play切替がある。sample連続性を検証した正規出力はworker生成の全長MP4であり、それを全長previewにも使用できる。editorの縮小CSS背景と最終renderを同一画素とは主張しない。暫定layout値は[V5設計](v5.md)に明記。

001〜004 migration/既存文書は編集せず、005はローカル専用test DBにのみ適用。契約、cloud作成、本番migration、push、merge、deployなし。local/cloud原本、project、conflict、outbox、job/checkpointは保持。ローカル試験serverは終了時に停止する。

生成evidence（git対象外）: `work/v5-unit.log`、`v5-save-tests.log`、`v5-native.log`、`v5-browser-all.log`、`v5-rollback-e2e.log`、`v5-typecheck.log`、`v5-lint.log`、`v5-build-root.log`、`v5-build-base.log`、`v5-build-api.log`、`v5-build-render.log`、`v5-build-derivatives.log`、`v5-docker-smoke.log`。
