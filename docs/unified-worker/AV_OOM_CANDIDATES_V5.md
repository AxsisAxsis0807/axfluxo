# AV OOM candidates v5

**採用なし。本番renderer差分ゼロ、総合HOLD。** 本書は改善仮説を比較するもので、512MB達成策を先に決めたものではない。実測の前後値・反復値は [RESULTS](evidence/av-oom-v5/RESULTS.md)、機械可読の全値・SHA・PID/phaseは [measurements](evidence/av-oom-v5/measurements.json)。

## 試した因子と採否

| 因子 | 隔離変更 / 対照 | 判断基準・限界 |
|---|---|---|
| 既存候補B | baselineの動的/静止PNG入力を1枚decode後filter loopで60fps化。input-scoped threads1、x264設定は維持 | v4の5秒512MB成功だけで実用採用しない。v5の同品質/反復/15秒を別記。パッチは既存v4証拠に固定保存 |
| C1 | Bに対して背景CanvasをPNG encode完了後 `width=height=1` にする1変更 | encode前に縮小しない。loadImage/Buffer/全Canvasを解放できたとは主張しない。改善が反復ばらつきを超えるか、全品質一致かで判断 |
| B4（原因分離） | 15秒3区間で同じタイトル・同じtext/static PNGパスを再使用 | タイトル内容やPNG再生成の寄与を探る。タイミング/境界はB3と同じ。任意の異なるタイトルに適用できる最適化ではない |
| B5（原因分離） | タイトル境界でtext/static Mapをclear、ファイルは保持 | Mapはパス文字列を保持する。Canvas native allocatorへの直接操作ではなく、既存の2ファイルevictionも変わるためfile cacheに交絡する。checkpointを削除しない |
| B6 | static ON/OFF、同じ素材/segment構造 | FFmpeg dynamicとstatic生成/useをPID・argvで識別。ONの静止実通過を確認。OFFを品質低下策として採用しない |
| B8 | segmentFrames60→300、同じタイトル境界 | Encoder寿命を延ばす診断。静止segmentを通らないON試験はINVALID。MP4/全フレーム/PTS/PCMとcheckpoint identityは別審査。資源だけで採用しない |
| B7 | 背景/タイトルPNG生成・静止PNG生成・fade encode・static encode・muxを新規processで個別実行 | 生成済み素材、Node初期状態、page-cache課金先が全ジョブと異なる。差分は個別フィルターの厳密なallocation量ではない |

C1の隔離パッチは [C1.patch](evidence/av-oom-v5/C1.patch)。候補BのSHAは `abb470ede22324a6533e3e883d266dd40ffc26b370df4345c65a2ffecf71c320`。バンドルの4種別再構築はSHA一致を確認した。production renderer、既存API、DB、受付flag、rendererVersionは変更しない。

## その他の案

| 案 | 状況 / 却下・保留理由 |
|---|---|
| title Canvas/Buffer/loadImageの寿命短縮 | C1は背景だけの限定試験。タイトルごとのnative寿命は時系列で観測するが、V8 heap/externalだけから全Canvasの確保量を算出しない。任意素材を含む完全な解放策は未実装 |
| PNG/フィルターqueue・色変換の重複削減 | BはPNG再decodeを回避。さらにformat変換を削ると色やalpha丸めに影響し得るため、証拠なしにgraphを削らない。現段階では未採用 |
| fade事前合成・9フレーム限定prerender | 背景/文字alphaとReference非線形fade・時計を完全維持する全ジョブ比較がないため未採用。9枚1080p PNG等の生成・cache・復旧コストも必要。画質を下げる案として使わない |
| cropped title / raw RGBA | v4 micro証拠は保持。単体segment一致を全AV/Reference/任意文字の保証にしない。全ジョブ・checkpoint互換が未検証のため未採用 |
| 画像生成とencodeの別process | B7は生成済み素材のNode/FFmpeg観測まで。実装するとspawn、font再登録、IPC/PNG中間書込み、abort/child回収、復旧、入力検証、権限負荷が増える。1GB/512MBで全ジョブ・コスト・品質・復旧を測っていないので採用保留。単体phaseから削減量を断定しない |
| THP / memory reclaim | 読み取り観測のみ。anon_thp全量を無駄とみなさず、本番OS設定やdrop_cachesは変更しない |
| CRF/preset/fps/解像度/encoder threads/lookahead変更 | 未実施。固定条件を緩めた512MB達成を宣言しない |

## 品質・checkpoint採用条件

第一優先は最終MP4 SHA一致。差がある案は全デコードフレーム・PTS・長さ・PCM・色・fade・Reference時計・segment境界の個別審査が必要。segment長や出力が変わる候補を旧checkpointへ無条件適用しない。合成同一性だけで、本番の版横断checkpoint再利用や実ストレージの復旧をPASSにしない。[品質/復旧](AV_OOM_QUALITY_RECOVERY_V5.md) と [release gates](AV_OOM_RELEASE_GATES_V5.md) を併読する。

## C1独立反復の結論

1GB（実999,997,440 B）/CPU0.5/static ON/15秒3タイトルの独立3回で、Bのpeakは587,231,232 / 585,961,472 / 590,372,864 B、C1は590,225,408 / 585,392,128 / 597,659,648 B。平均はそれぞれ587,855,189 / 591,092,395 B。C1平均はBより3,237,205 B高く、今回の反復から改善は確認できない。ばらつき/host条件の限界があり、悪化量を普遍的な性能差とも断定しない。C1を採用せず、512MB達成候補として宣伝しない。

B8は完成動画900枚中840枚のデコード画素が異なる。encode前の全900枚は一致し、keyframe位置の変化を実測したため、segment分割によるH.264 encode差として説明できる。PTS/PCM/色は維持しても完全同一性を満たさず、不採用。静止ONの実通過もなく、そのゲートはINVALIDである。

## B7と別process案の限界

背景PNG単体はwall1.505s/CPU0.737s・peak75,931,648 B、title PNG単体はwall1.095s/CPU0.559s・peak39,133,184 B（各新規process1回、起動/font登録を含む）。別process化ではこの起動・初期化とmain/helperの同時生存を全体で測る必要があり、上の値を純粋なspawn overheadとは呼ばない。

生成済み素材を別NodeでencodeしたB7はfade peak496,009,216 B、static peak454,627,328 B。fade最大標本のFFmpeg Anonymous456,781,824 B/AnonHugePages346,030,080 B、Node Anonymous27,774,976 B。staticでもFFmpeg AnonHugePages346,030,080 Bを観測した。どのallocatorのTHPか・どれだけ内部未使用かは不明。差分をfilter固有確保量や全jobで実現する削減量としない。IPC/PNG途中書込み、abort時の子process回収、bounded出力、path/font検証、checkpoint/再試行の追加負荷を実装・検証していないため、別process案は採用保留の仮説である。

## Bの変更前後（同じ1GB/CPU0.5、各対照1回の観測）

| 同一素材条件 | baseline peak B | B peak B | 差 B | 品質 / 判断 |
|---|---:|---:|---:|---|
| 15秒1タイトル | 672,514,048 | 584,351,744 | -88,162,304 | 全MP4/segment/フレーム/PTS/PCM一致 |
| 15秒3タイトル r1 | 713,736,192 | 587,231,232 | -126,504,960 | 同一、ただし十進512MBはOOM |
| 30秒3タイトル | 812,777,472 | 656,797,696 | -155,979,776 | 同一、実用長期保証ではない |
| Reference 15秒 | 656,142,336 | 554,139,648 | -102,002,688 | 時計/非線形fadeを含む全フレーム一致 |
| 境界4.25/9.10秒 | 726,667,264 | 597,389,312 | -129,277,952 | 同一、16segmentを検証 |

全例で温冷cacheは未制御、host共用/計測負荷を含む。差分はこのcaseの全cgroup peak差であり、個別filter/decoder/x264 allocatorの確保量や普遍的な速度/削減保証ではない。Bは既存v4隔離パッチとして保持し、本番採用はHOLD。静止cache参照解放B5は596,541,440 B、B3 r1より低くなく、path Map解放だけの採用根拠にならなかった。
