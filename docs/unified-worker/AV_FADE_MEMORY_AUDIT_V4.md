# All Versions 先頭fade・512MB調査 v4

## 1. 総合判定

**HOLD。実用的な512MB対応とは判定しない。** 候補Bは5秒1タイトルだけ「512MB短時間合成試験PASS」（独立3回、swap 0、OOM増分0、全画素/PTS/音声一致）。しかし15秒3タイトルは512MBで2タイトル目の先頭fade segment5がOOM。Reference/30秒への512MB拡張は停止した。本番Cloud受付/静止合成デフォルトOFF、未マージ/未デプロイを維持する。

## 2. 起点・コード・同一性

開始checkoutはclean `work` / `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。指定SHAはローカルに未取得だった。リモートv3は指定 `4159f194f6e9f37a9f402ed84542df18f04ba22f` と一致、v4リモートrefは存在しなかった。指定SHAをfetchし `codex/av-fade-memory-audit-v4` を作成。無関係な差分なし。PR #34/#35のopen/draft/merged=falseを読み取り確認。

必読v3資料4冊とmeasurements.jsonを再読。v3は過去条件の証拠として保持・非上書き。今回の未変更baselineバンドルSHAはv3と同じ `f3d031760b2b5874636d4c9f5bb31845f1144142fb26dfc129cd15796c09d2de`。Node24.19.0 / FFmpeg7.1.5 / ffprobe、共有ライブラリ、Canvas、フォントを含むv3 manifest全ファイルが一致。追加はargv/stderr観測専用preload-v4のみ。実argvを書き換えない。

baseline sourceは指定Git SHA。候補A/Bは同SHAの隔離ソースコピーに各patchを適用してbundle化した。patch SHAとbundle SHAは `candidate-A.json` / `candidate-B.json`、実image ID/入力SHAは各caseに固定。候補BはAにstatic-useの単一PNG入力loop変更だけを追加した比較。候補コードは本番ソースへ採用せず、隔離patchとして保存する。実装場所は `/workspace/axfluxo-av-fade-v4-candidate`。最終branchの本番renderer差分はゼロ。

追加のshifted境界fixtureは診断専用。既定equalは従来入力を維持し、15秒3タイトルに限って4.25秒/9.10秒へ境界をずらす。素材・fixture bundleが異なるケースを通常matrixと混同せず、別manifestでbaseline/candidateを揃える。

## 3. 正しい経路と不変条件

`resource-audit-fixture.ts render` → projectFor/snapshotFor → projectPlan → prepareGraphics → encodeProjectSegment（ReferenceはencodeReferenceProjectSegment）→全segment検証→assemble→完成検証。実DB統合Workerではない。別試験としてbaseline実DB47件、candidate静止ONの実Worker+DB/FakeStorage1件（他13件選択外）を実施した。旧Exportの最適化へ変更していない。

provisional-v1は全面背景をfadeせず、RGBA文字のアルファだけをfadeしてoverlayする。先頭9frameのfadeを含む通常60frame segmentを処理。Referenceはcropped titleのgeq非線形alphaとdrawtext時計の別経路で、個別カーブとversionごとの時計リセットを維持する。

1920×1080、CFR60、libx264/CRF18/medium/yuv420p/BT.709、encoder threads2、timescale60000、bf0、音声AAC320k/48kHzの既存条件を固定。既存decoder threads1/filter_complex_threads1の再追加を改善と呼ばない。x264 lookahead等を変更していない。観測ログでrc_lookahead40等を確認したが、それだけから内部確保量の犯人とは断定しない。

## 4. 確認した失敗地点と原因分離

未変更baselineの512,000,000 B/0.5CPU/swap0は先頭動的segment0で独立2回OOM、child SIGKILL / oom_kill+1。Docker OOMKilled=falseでもジョブ失敗として数える。

候補Aは同条件2回ともsegment0を完了し、静止PNG生成後のstatic segment1でOOM。静止encode未完了なので、その512MBケースの静止合成性能はINVALID_TEST。候補Bは5秒でstatic segment1/2/3まで完了・PNG生成1/再利用2、末尾fade/音声mux/全検証も完了。しかし15秒ではsegment0〜4完了後、version1のsegment5でOOM。

失敗segment5の最大標本はcgroup current511,930,368 B、anon506,580,992 / file724,992 / kernel4,403,200 B。FFmpeg sampled RSS507,686,912 / PSS505,194,496 / USS503,480,320 B、7 threads。同時Node RSS158,892,032 B。RSSを足したり、cgroupと等値に扱わない。この標本ではfileをほぼ回収してもanonが支配しており、単なるファイルキャッシュ増加だけでは説明できない。kernel peakは512,000,000 B、OOM増分を伴う。標本は真の瞬間失敗点を取り逃し得る。

### マイクロベンチ（完成動画同等性とは別）

同じ背景/文字PNG、60frame、2GiB/1CPU/swap0で一因子ずつ分離。主なcgroup peak B:

| 診断 | peak B |
|---|---:|
| 背景1枚decode→null | 40,161,280 |
| 背景PNG入力loop→null | 65,044,480 |
| 文字PNG入力loop→null | 62,562,304 |
| +RGBA | 62,427,136 |
| +PTS | 62,693,376 |
| +alpha fade | 70,881,280 |
| 2入力overlay→null | 136,646,656 |
| overlay+yuv420p/色設定→null | 143,773,696 |
| 完全fade/filter→null | 168,787,968 |
| 背景のみ既存x264 | 431,779,840 |
| 完全filter+既存x264 | 590,671,872 |
| 入力queue1 | 586,563,584 |
| 1枚decode後filter loop | 479,666,176 |

PNG非ループの初期化診断（ffmpeg -version）は30,879,744 B。実Node/Canvas常駐の影響はwhole-job段階観測と、生成済みraw/cropを別Nodeでencodeする診断で区別した。生成込みraw766,046,208 B/crop497,852,416 Bに対し、生成済みraw671,637,504 B/crop463,454,208 B。同じPNGのFFmpeg RGBA decodeとCanvas rawは両入力とも画素SHA一致し、全成功micro MP4も先頭baseline segment0と一致した。crop-readyはfilterloopより低いが、任意タイトル/PNG生成を含む全AVジョブの有効性は未検証であり採用しない。

通常PNG loopは各入力73packet read / 64frames decode、filter loopは各1packet / 1frame decode、いずれも出力60framesを実ログで確認。先頭MP4 hashも一致。この構成では繰り返しPNG decodeとその生存期間を避けることが有望という実測根拠になる。

ただしピークの差をRGBA/fade/overlay/x264固有のallocator確保量とはしない。自動format変換、スレッド終了、upstream frame保持、encoderへのbackpressureも変わる。内部allocatorは直接計測していない。別の512MB standalone完全graph再生はSIGKILL前の最終progressがframe=0で、x264初期化ログは出ていた。これは出力進捗であり、内部入力decode/encode枚数ではない。通常baselineの正確な内部frame番号は未確定。確定できたのはencodeを含む経路で大きく増えることと、1枚decode後loopで実ピークが下がることまで。

Node/Canvasはgraphics前後のmemoryUsageと同時RSS/PSS/USSを観測するが、JS heap/externalはnative全量ではない。font/cover decode/blur/Canvas内部を個別kernel peakへ分解していない。raw/crop素材生成を同じNodeに含めた診断はnative寿命が交絡するため、生成済み素材を別プロセスへ渡す追加診断と分ける。

## 5. 候補と変更範囲

| 候補 | 判断 | 根拠 |
|---|---|---|
| queue1 | 却下 | 単発で約4MB差のみ、反復/全ジョブ効果なし。既存threads1と別因子として測定 |
| A: dynamic PNGを1枚decode後loop | 単独採用せず | 先頭fade通過、5秒完成時は品質一致。ただしstatic segment1が512MB OOM |
| B: A + static-useの1枚decode後loop | 採用保留、patch保存 | 5秒512MB×3は完全一致で完成。15秒3タイトルsegment5がOOM、実用512MB不適合 |
| full raw / crop | 原因探索のみ | 素材生成native寿命を含む/除く比較を別記。完成AV全ジョブの改善候補として未認証 |
| encoder/品質/仕様の変更 | 未実施 | lookahead/preset/CRF/fps/解像度等を緩和せず。必要なら別提案・承認対象 |

## 6. 資源・CPU・ディスク・反復

人が読める全case表は [RESULTS.md](evidence/av-fade-v4/RESULTS.md)。正確な全caseは [measurements.json](evidence/av-fade-v4/measurements.json)。実memory.max/current/peak/events/stat/swap、cpu.max/stat、全体CPU秒、sampler wall、ディスク標本ピーク、FFmpeg/Node RSS/PSS/USS/threads、コード/入力/image SHA、spawn/closeと失敗signalを収録。実argv全量・25ms目標samples・メディアは `work/av-fade-v4/CASE/work/result`、Gitには集約とraw hashのみ。

今回の全ジョブ最大kernel peakはbaseline30秒の799,358,976 B。候補Bの最大は1GB/30秒の660,492,288 Bで、標本最大時anon511,365,120 / file140,021,760 / kernel8,650,752 B。1GBの候補B・5秒ON各2回平均535,963,648 B、baseline ON平均624,234,496 B（約88.3MB低い）。5秒512MB×3のwallは45.001/48.861/45.320秒。CPU秒・ディスク・全反復値は一覧に保存。30秒1GBの残量は実上限に対して339,505,152 Bだが、実Worker付帯負荷・長期変動の余裕を保証しない。

1GB要求は実999,997,440 Bへpage切り下げ。512MBと512MiB、2GiBは別値として記録。512系CPU quotaは50000/100000、1GB/2GiBは100000/100000。追加swapなし。予約CPU/メモリやBlitz無料アカウント条件の証明ではない。

全ケース独立・直列のnetwork none / cap-drop ALL / no-new-privileges / pids128 container。ホストcacheはdropせず、冷/温を制御していない。image共有ページの課金先もRSSと一致しない。単発wall差や少数反復を速度/本番安定性の保証にしない。samplerは25ms目標に/proc走査時間が加わり、短時間ピークはkernel memory.peakで補完する。

初期Docker image/container/volumeは0。空きは約64GB、各case前2GiB reserveを確認。ENOSPCなし。自作label/prefixと停止状態を照合し、/work全体・ログ・出力hashを保存後、その停止containerだけ削除。image/volume/他作業/pruneは未操作。作業成果物の退避・hash時間はsampler wall外。disk標本はresultディレクトリの論理サイズであり、microの/work直下の事前入力PNG/RGBAは対象外（退避一式とraw画素hashで保持）、Docker VFS実占有とは別。

初期10起動は観測ファイル権限不足/JS依存bundle不足で開始前失敗。ログを保持しINVALID_SETUPに分類、OOM反復に数えない。修正後baseline bundleはv3と完全一致。通常sandboxのproxy/socket到達制限は承認済み外部実行で解決した。Docker自動proxy注入は認証userinfoなしを真偽値で確認し、後続containerは明示的に空値化。Node/FFmpegは最初から既存の厳格allowlistで環境を構築しており、外部ネットワークも使わない。

## 7. 品質と復旧

[品質](AV_FADE_MEMORY_QUALITY_V4.md) / [復旧](AV_FADE_MEMORY_RECOVERY_V4.md)。マイクロベンチのnull出力や単体segment一致を完成動画・実Worker復旧へ読み替えない。

## 8. 五周自己監査

同じ担当が異なる観点で見直した自己監査であり、外部独立レビューではない。

| 周 | 判定 | 根拠 | 未解決 |
|---|---|---|---|
| 1 仕様・設計 | PASS（調査範囲） | 実コード9ファイル再読、文字alpha/背景区別、既存encoder/音声/Reference式保持、production差分ゼロ | 任意素材/本番imageは未認証 |
| 2 コード・実装 | PASS（調査範囲） | checks.jsonのtypecheck/lint/Worker・Render build/関係13件、candidate typecheck/build、凍結patch/bundle/image、argv/PTS/close、診断fixtureのみ最終変更 | 全候補の本番採用・checkpoint互換承認なし |
| 3 資源・再現性 | HOLD | baseline先頭OOM×2、A static OOM×2、B短時間成功×3だが15秒OOM。cgroup/CPU/swap/ディスク実値 | 実用512MB、長期連続、実Blitz未認証 |
| 4 品質・回帰・復旧 | PARTIAL | 全デコード/PTS/PCM品質JSON、実停止再生成を別証拠化、既存checkpoint保護契約維持 | 全停止点の実Worker+DB+実ストレージ統合未完了 |
| 5 セキュリティ・リリース | PASS（操作範囲） | 合成素材/network none/環境allowlist、自作停止containerのみ整理、PR状態・本番OFF維持 | 本番承認なし、release gates継続 |

## 9. 未検証・次の一手

[Release Gates](AV_FADE_MEMORY_RELEASE_GATES_V4.md)。実本番image/Blitz/実ストレージ、実Workerの候補B資源・全SIGKILL公開境界、連続job/任意長尺/任意素材、同時Worker/0.05CPU予約運用は未検証。内部メモリアロケータの帰属も未確定。

次は安全な隔離環境で1GB実Worker+本番imageの長期連続・Reference・復旧・ディスク余裕を確認し、1GB構成への移行条件を評価する。候補BはPNG再decodeを避ける小さな案として保持できるが、512MB対応としてリリースしない。さらに512MBを追うなら、匿名ページの同時生存（encoderに渡るframe/Node native/THPを含む）を直接プロファイルし、同品質・同profileで一因子ずつ再測定する。仕様変更が必要なら効果/互換性/リスクを提示して採用保留とする。

## 10. 実行チェックと提出範囲

`checks.json` にログSHA/終了コードを保存。rootのtypecheck/lint/Worker build/Render build、関係13件（Mock復旧11・cache1・実FFmpeg Reference1）、sampler allowlist2件、専用PostgreSQLのbaseline47件（21+1+25）、候補Bの実Worker静止ON/upload再試行1件、候補Bのtypecheck/Worker・Render buildがPASS。全リポジトリsuite/フロントエンドbuild/ブラウザsuiteは今回再実行していない。必要な診断・renderer/Worker周辺に範囲を限定した。

最終ブランチは `codex/av-fade-memory-audit-v4`。最終commit SHA・push結果は提出メッセージでremote refとの照合値を示す。本番renderer/API/DB/src、v3資料/証拠、main/既存PR branchの差分・更新はゼロ。新PR/merge/deploy/Cloud受付ON/Blitz/課金操作は実施しない。
