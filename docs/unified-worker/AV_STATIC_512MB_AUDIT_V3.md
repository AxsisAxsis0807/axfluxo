# 新All Versions 静止画合成 512MB監査 v3

最終総合判定: **HOLD（512MB・512MiB）**。静止画方式は実際に動作するが、5秒合成ジョブは512,000,000 Bでも536,870,912 BでもOFF/ON各2回OOM。1GB単体・短時間の予備評価は完了。Blitz Small対応、本番運用PASSとは判定しない。

本番Cloud受付・静止画合成のデフォルトはOFFのまま。デプロイ、マージ、新PR、公開、Blitz設定、実データ/本番DB/課金操作なし。v2資料は保持。

## 起点と同一性

2026-11-16にGitHubでPR #35を再確認: open / draft / merged=false、HEAD `498bf9d64f1329fbec6b04b6ce7679a0cd094049`、head `codex/unified-resource-audit-v2`、base `codex/unified-worker-v1` (`81d6c739a797e95386855ad1b78313a88e9b1077`)。指定と差なし。ローカル既存checkoutは `1c88efb614e3d15ef9a8f371e8016076a8c7ef68` だったため保持し、指定SHAから `/workspace/axfluxo-av-v3`、`codex/av-static-512mb-audit-v3` を作成。

測定時HEADは起点SHA、診断変更は未コミットだった。全ケースのバンドルSHA・image ID・入力SHA・実効環境値をJSONに保存。完成コードから再ビルドしたバンドルは測定バンドルと `cmp` 一致、preload/sampleもイメージ内コピーと一致。測定後の診断集計・停止ハーネス変更はレンダーバンドルに入らない。本番レンダラーの差分はゼロ。

OFF/ONとも同じcandidate.mjsを使用。baseline.mjsはpack互換用の同一コピーであり、旧コミット比較ではない。Node 24.19.0、ローカルFFmpeg等のバイナリハッシュは [binary-manifest.json](evidence/av-static-v3/binary-manifest.json)。診断用FROM scratchイメージであり本番Dockerfileイメージではない。

## 呼び出し経路と素材

- 主測定: `resource-audit-fixture.ts render` → `projectFor/snapshotFor`（旧Exportの変換関数を共用）→ `projectPlan` → `prepareGraphics` → `encodeProjectSegment`（Referenceは`encodeReferenceProjectSegment`へ分岐）→ セグメント完全検証 → `assemble` → 完成動画完全検証。
- 旧Cloud Exportの `renderExport` もこのAll Versions共通レンダラーを使う。別エンコードエンジンとして扱わない。
- `unified`診断モードは実DB統合Workerと同義ではない。今回は主測定に使わない。Generic Renderの実DB試験は別証拠。
- A: 5秒、1タイトル、300 frames。B: 15秒、3タイトル、900 frames、境界300/600。C: Bと同じ構成のreference-pasa-v1。すべて1920×1080、CFR60、フェード各9 frames、60-frame segment、複雑なtestsrc2背景、合成48kHz音声。
- 全ケース独立コンテナ、network=none、cap-drop ALL、no-new-privileges、pids=128、swap.max=0。512MB/512MiBは0.5 CPU、1GB/2GiBは1 CPU。CPU実値はcpu.maxで確認。
- 入力は各コンテナで同じ決定的手順から再生成し、ハッシュで同一性を事後検証。生成工程の資源もジョブ全体に含む。原本/ユーザーメディアは使わない。

## 実測

| ケース | 制限 B / CPU | OFF/ON | cgroup memory.peak B | oom_kill増分 | CPU秒¹ | wall秒 | ディスクピーク B² | 結果 |
|---|---|---|---:|---:|---:|---:|---:|---|
| B-A-off | 2147483648 / 1 | OFF | 663,781,376 | 0 | 36.990 | 37.223 | 24,340,632 | COMPLETED |
| B-A-on | 2147483648 / 1 | ON | 612,085,760 | 0 | 28.167 | 28.403 | 24,441,790 | COMPLETED |
| B-B-off | 2147483648 / 1 | OFF | 687,407,104 | 0 | 105.198 | 105.536 | 71,465,929 | COMPLETED |
| B-B-on | 2147483648 / 1 | ON | 698,253,312 | 0 | 95.059 | 103.869 | 72,304,586 | COMPLETED |
| B-C-off | 2147483648 / 1 | OFF | 741,036,032 | 0 | 102.606 | 103.216 | 72,806,690 | COMPLETED |
| B-C-on | 2147483648 / 1 | ON | 752,263,168 | 0 | 86.542 | 88.522 | 73,028,581 | COMPLETED |
| C-A-off-1 | 512000000 / 0.5 | OFF | 512,000,000 | 1 | 11.203 | 22.381 | 22,529,422 | FAILED |
| C-A-off-2 | 512000000 / 0.5 | OFF | 512,000,000 | 1 | 10.813 | 21.594 | 22,506,685 | FAILED |
| C-A-on-1 | 512000000 / 0.5 | ON | 512,000,000 | 1 | 11.055 | 22.061 | 22,498,266 | FAILED |
| C-A-on-2 | 512000000 / 0.5 | ON | 512,000,000 | 1 | 11.382 | 22.736 | 22,521,586 | FAILED |
| D-A-off-1 | 536870912 / 0.5 | OFF | 536,870,912 | 1 | 10.967 | 21.951 | 22,481,151 | FAILED |
| D-A-off-2 | 536870912 / 0.5 | OFF | 536,870,912 | 1 | 10.513 | 21.020 | 22,499,908 | FAILED |
| D-A-on-1 | 536870912 / 0.5 | ON | 536,870,912 | 1 | 9.754 | 19.510 | 22,456,955 | FAILED |
| D-A-on-2 | 536870912 / 0.5 | ON | 536,870,912 | 1 | 10.089 | 20.163 | 22,458,854 | FAILED |
| E-A-off-1 | 1000000000 / 1 | OFF | 662,364,160 | 0 | 39.468 | 39.691 | 24,282,471 | COMPLETED |
| E-A-off-2 | 1000000000 / 1 | OFF | 653,537,280 | 0 | 36.806 | 37.025 | 24,177,904 | COMPLETED |
| E-A-on-1 | 1000000000 / 1 | ON | 651,083,776 | 0 | 31.431 | 31.671 | 24,406,023 | COMPLETED |
| E-A-on-2 | 1000000000 / 1 | ON | 656,060,416 | 0 | 30.447 | 30.675 | 24,354,652 | COMPLETED |

¹ cgroup `cpu.stat` usage_usec差分（sampler等込み）。子孫を含むNodeのwaited CPU秒はJSON summary.cpuSecondsに別記。² 25ms間隔の監査出力ディレクトリ論理サイズ、ログ・合成入力込み。Docker VFSの実ホスト占有とは別。

512MB/MiBのmemory.peakが上限と同値なのは制限到達・OOMであり成功/必要量の推定ではない。8ケースすべてNode終了1、FFmpeg child #4 SIGKILL、oom_kill +1。Docker OOMKilled=falseでも子のOOMを検出。最初の動的フェードsegment-0が未完了、中間静止画へ到達ゼロ。これらONケースはジョブ失敗の有効証拠だが、静止画経路評価として **INVALID_TEST_NO_COMPLETED_STATIC_PATH**。成功に数えない。

1GBの全4ケースは完成、OOMなし、ON各3静止セグメント完了。OFF最大662,364,160 B、ON最大656,060,416 B。各2回平均はOFF657,950,720 B、ON653,572,096 B（差4,378,624 B、約0.67%）。この少数試行から安定したジョブ全体削減効果を一般化しない。2GiBのA単発は削減、B/C単発はONの全体ピークがOFFより増加した。

## どの段階が重いか

5秒・512MB/MiBの失敗は背景/タイトル生成後、先頭の通常フェード合成＋H.264エンコード。C-A-on-1ではcgroup kernel peak512,000,000 B、同段階FFmpeg sampled RSS518,385,664 / PSS515,721,216 / USS513,855,488 B、11 threads。これらプロセス値をcgroup値に足したり同じ指標としない。共有ページ/課金先/サンプリングの差がある。

2GiB A-ONのPNG生成時sampled cgroup最大160,141,312 B、FFmpeg RSS132,263,936 B。静止encodeはsegment1で574,459,904 B、segment2で566,497,280 B、segment3で558,850,048 B。最大全体ピーク612,085,760 Bは末尾動的segment4。PNG生成開始だけを静止経路成功にはしていない。これらは25ms標本の段階最大であり、リセット済みkernel段階peakではない。

C-ON（Reference/15秒）の全体peak752,263,168 B。最大標本はstatic-use segment13、cgroup current752,259,072 B、FFmpeg RSS557,760,512 B、Node RSS181,645,312 B。同標本のmemory.statはanon577,179,648、file169,320,448、kernel5,148,672 B。ファイルキャッシュも全体判定に含める。FFmpeg単体RSSだけからジョブ総量や原因を断定しない。

Node起動/合成入力生成/graphics前後/各encode/検証/mux/最終検証/idleはstages+nodeメモリに記録。フォント・cover decode・Canvas・blur・背景PNG内部はprepareGraphics内の一括段階で、各内部処理の個別kernel peakは未分離。JS heap/externalはCanvas native確保の完全な内訳ではない。x264 lookahead、PNGデコード、filterの個々のallocator帰属は未測定。最適化や解像度・CRF・プリセット・lookahead変更はしていない。

## CPU・ディスク・実行制約

memory.current/peak/max/events/stat/swap.current/swap.max、cpu.stat/maxを前後および標本で取得。Node RSS/heap/external、FFmpeg RSS/PSS/USS/threads、ツリーRSS等、CPU、終了signal、ディスクを保存。cgroup memoryはRSS合計の代用品ではない。

Smallの公表予約0.05 CPUと上限0.5 CPUは別。本試験は上限quotaであり継続的な予約分の処理能力を保証しない。nr_throttled/throttled_usecもJSONに保存。0.05 CPU連続試験は未実施。

開始空き64,132,923,392 B、依存・診断イメージ構築後60,096,602,112 B。Docker storage driverはvfs。コンテナ層複製で途中37,987,614,720 Bまで減少したため、専用コンテナの/workを保存しハッシュを記録してから停止済みだけ削除。画像655.2MB、当時17コンテナのwritable表示591MB（基礎層複製のホスト占有はこの表示に含まれない）。prune/共有volume削除なし。各ケース前2GiB reserve、前後空き量、整理ログを保存。ENOSPC・BLOCKED_DISKは今回発生なし。診断用syntheticファイル/ログはローカル保持、大容量動画はGitに含めない。

## 五周自己監査

| 観点 | 判定 | 根拠/制約 |
|---|---|---|
| 第1周 仕様 | PASS | 新AVの静止経路をB/Eで実行、フェードfallback、1920×1080/60/H.264/CRF18/yuv420p/BT.709と音声を保持。512の失敗をPASS扱いしない |
| 第2周 コード | PASS | strict boolean allowlist、Node実効値、同一bundle/image/input、診断コードのみ。production差分ゼロ |
| 第3周 セキュリティ | PASS | メディア試験network none、合成素材、DBは専用loopbackのみ、秘匿環境非継承。元データ・本番未操作 |
| 第4周 資源 | HOLD | 正しいdecimal/binary制限とCPU/swap下でOOMを反復再現。資源計測自体は成立 |
| 第5周 品質・復旧 | PARTIAL | 全デコード/音声一致、停止後再生成、既存DB復旧試験は合格。静止ONの実Worker全経路・本番画像・長尺は未認証 |

これは異なる観点の自己監査であり、外部独立レビューではない。

## 次の一手

1. まずフェード区間のFFmpeg内訳（PNG入力queue/format変換/filter/x264）を、既存設定固定の段階再生診断で分離。静止区間だけ最適化しても先頭OOMを解消できない。
2. 追加decoder buffer、Canvas native lifetime、PNG/encodeの重複を一候補ずつ検証。今回の11threads観測からfilter並列が原因と決めつけない。encoder/lookahead変更は別案として互換検証が必要。
3. 1GBの実Worker静止ON→checkpoint復旧→30秒以上の順に別検証。Small向け試験は今回OOMのためPhase Fへ進めない。1GBは短時間の予備評価のみ、Medium本番保証なし。

[品質](AV_STATIC_QUALITY_V3.md) / [復旧](AV_STATIC_RECOVERY_V3.md) / [release gates](AV_STATIC_RELEASE_GATES_V3.md) / [machine measurements](evidence/av-static-v3/measurements.json)
