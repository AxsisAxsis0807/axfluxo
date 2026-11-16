# All Versions OOM root cause audit v5

**総合HOLD。512MBの短時間完成や1GBの合成成功を、本番実用・無料運用のPASSへ読み替えない。** 起点はv4 `de971898af831156c17db09090fa5fd57e52c8f1`、新規branchは `codex/av-oom-rootcause-audit-v5`。本番renderer/API/DB/infraを変更しない。実ユーザー素材・credentials・production DB/ストレージ・実Blitz・本番imageは使わない。

提出物: [全実測ケース](evidence/av-oom-v5/RESULTS.md)、[測定JSON](evidence/av-oom-v5/measurements.json)、[候補](AV_OOM_CANDIDATES_V5.md)、[品質/復旧](AV_OOM_QUALITY_RECOVERY_V5.md)、[release gates](AV_OOM_RELEASE_GATES_V5.md)、[再現手順](evidence/av-oom-v5/README.md)。SHA・環境・rawファイルの存在場所とhashはevidence内に保存する。巨大な素材/動画/生ログはGitに入れない。

## v4から引き継ぐ固定事実

| 条件 / 候補B | 回数 | kernel peak B | Δmax / oom / oom_kill | 結果 |
|---|---:|---|---|---|
| 512,000,000 B / CPU0.5 / swap0、5秒1タイトル | 3独立 | 512,000,000 / 512,000,000 / 511,750,144 | 21/0/0、7/0/0、4/0/0 | 完成。ただし余裕なし |
| 同512MB、15秒3タイトル | 1 | 512,000,000 | 113/1/1 | 2タイトル目dynamic fade segment5でOOM |
| 実999,997,440 B、15秒3タイトル | 1 | 586,657,792 | v4原本参照 | 完成。長期安定証明ではない |
| 実999,997,440 B、30秒3タイトル | 1 | 660,492,288 | v4原本参照 | 完成。長期安定証明ではない |

v4候補BはPNGの繰り返しdecodeを避け、1枚decode後FFmpeg loop filterと `setpts=N/(60*TB)` でdynamic/staticを60fpsへ展開する隔離パッチで、本番rendererは未変更。5秒/15秒/30秒/Reference/境界ずらしの完成MP4 SHA・全フレーム・PTS・PCM一致は合成試験の証拠であり、実素材・実Blitz・本番image・実ストレージの完全検証ではない。

v4の1GB最大標本は15秒でanon約511.5MB/file約68.3MB/kernel約6.6MB、30秒でanon約511.4MB/file約140.0MB/kernel約8.7MB。この増加だけでリークとは断定しない。1GB v4はCPU1であり、v5のCPU0.5結果と同一条件の反復に数えない。v4原本は非上書きで保持する。

## Phase A: 固定・測定・限界

固定Git SHA、候補BパッチSHA、各bundle SHA、各imageの実content-addressed ID、Node/FFmpeg/ffprobe・共有library・Canvas・font SHAを保存。ローカルscratch imageのRegistry RepoDigestは存在しないため、registry manifest digest検証済みとは書かない。診断imageは本番imageと異なる。全runtime manifestは約2500ファイルを含み、元runtimeとの比較も保存する。

Normal fixtureはsynthetic 1920×1080/60fps・同じcoverと音源、fade9frames、segment60frames、全jobのmux/検証まで。入力合成動画の長さが変われば、そのSHA・file cache・準備処理も変わる。B2は15秒1タイトル・15segmentsでB3と同じ時間/画素/segment数を揃える。B4は同じPNGパスを3区間で再使用し、B5は境界でcacheのMap参照だけをclearしてファイルを保持する。

各caseは新規network none / CPU0.5 / swap0 / pids128 / cap-drop ALL / no-new-privilegesコンテナで、render workloadは行列内で直列に実行する。25ms目標のsamplerがcgroup current/peak/events/stat/swap/cpu、PID別RSS/PSS/USS/CPU/I/O・生存期間、disk論理bytesを記録。FFmpeg spawn/close/失敗signalと全segment開始/encode完了を別ログ化。Node memoryUsage時系列はJS heap/external/native全量の等価測定ではない。sampler自体の負荷はcgroupに含み、子process RSSには含めない。

25ms sleepに/proc走査とシリアライズ時間が加わり、瞬間peakは取り逃し得る。kernel `memory.peak` とeventsで補完する。RSS/PSS/USSをcgroupへ加算しない。max増分は圧迫であってOOM killと同義ではない。file cacheはmemory.stat file等を観測するが、コピー済みimage/inputの課金先や共有ページはprocess RSSと異なる。anon_thp全量を無駄とはみなさない。THPはread only、OS設定/drop_cachesは変更しない。

ホストcacheはcold/warm未制御。試験順序・新規container起動・actual CPU/memoryは各case/実行ログに保存。ホストでのsetup/rebuild/型・回帰確認が一部caseに重なる。別プロセスを測定対象cgroupに混ぜてはいないが、ホスト共用とcache課金が残るためwall差を性能保証・厳密な速度改善としない。独立反復は新規container/Node/FFmpegごとで、同一host/素材からの反復である。

## Phase B: 原因を支持/反証/未確定に分ける

初期1GB B2/B3のpeakは584,351,744 / 587,231,232 Bで、B2はタイトル切替なしでも同程度のworking setを持つ。B3初回の最大標本は最初のfade付近でanon514,318,336 / file66,031,616 / kernel6,529,024 B。タイトル2到達を必要とせず高いmemoryを観測したことと、512MB失敗の正確な条件は区別する。

同時PIDでB3 segment5の最大標本を見ると、Node RSS166,412,288/PSS163,934,208 B、FFmpeg RSS506,740,736/PSS504,158,208 B、cgroup current566,906,880 B・anon512,172,032 Bだった。これらのRSS/PSSを足してcgroup使用量とはしない。Nodeのcode/library file-backed private cleanも大きく、RSSをnative heapと呼ばない。

| ケース | タイトル変更主因 | 累積時間主因 | file cache | Node/Canvas native | FFmpeg匿名メモリ | x264寿命 |
|---|---|---|---|---|---|---|
| B1短時間 | 切替が必要、を反証（先頭OOM） | 長さ比較は入力長も交絡 | 準備入力長に伴う差を観測 | 存在を観測、内訳未確定 | fade encodeで大きい | segmentごとに別process |
| B2同15秒1タイトル | 高いpeakにタイトル変更が必須、を反証 | 初回fadeで大きいので経過時間だけとはいえない | 15秒入力のcacheを観測 | タイトル1つでも存在 | 同程度のworking setを支持 | 15segmentを新規encoderで実行 |
| B3 15秒3タイトル | segment5 OOMだけからリークと断定不可 | 時系列/各phaseで評価 | 寄与あり、sole causeとはいえない | 反復/境界の増減だけでleakとしない | dynamic encodeで大きいことを支持 | 1個のencoderが全15秒生き続ける構成ではない |
| B4同PNG再使用 | 再使用だけで十分改善、の支持なし | 境界/時間はB3と同じ | file保持条件は別記 | 新title生成を省く限定対照 | 同経路の大きいpeakは残る | encoderは再作成 |
| B5 Map解放 | path参照解放だけで解決、の支持なし | 同じ境界 | ファイル保持/evictionが交絡 | Map解放≠native release | 大きいpeakが残る | encoderは再作成 |
| B6 static OFF | 全部dynamicでも測定 | 同じ時間/segment | 出力/生成PNGが変わる | 個別allocator未確定 | dynamic/staticをPIDで識別 | 同じsegment単位で比較 |
| B7 phase分離 | 単体title生成を測定 | 全job累積の証拠ではない | 事前コピー課金先が異なる | 生成とencode Node状態を分ける | 単体encodeの匿名ページを観測 | alloc内訳/フィルター差分の厳密帰属は不可 |
| B8 segment300 | 境界は同じ | 1encoder寿命とsegment数も変わる | 出力サイズ/保持が変わる | 未確定 | encode経路が残る | 長い寿命へ変更しても今回peak大差なし。全内部原因の反証ではない |

確定できるのは実条件での成功/失敗、どのPID/segment/経路が生きていたか、anon/file/kernelと出力同一性である。強い仮説はdynamic filter+既存encoderの匿名working setにNode/計測器等が同居し、512MBの余裕を失うこと。PNG cacheだけや「タイトルリーク」だけで説明する支持は乏しい。x264内部allocator/queue、Canvas nativeの詳細、THP内部断片化、任意長尺のleakは未確定。差分を個別フィルターの正確な確保量と解釈しない。

### v5で短時間も不安定になった事実

十進512MBの5秒1タイトルr1は完成したがkernel peak512,000,000 B、max増分35で余裕なし。r2は最初のdynamic segment0でFFmpeg SIGKILL、max/oom/oom_kill増分60/1/1となった。これはv4の3回成功という固定事実を書き換えるものではない。v5の計測器はPID I/O等を追加しており、host/cache/課金先の差もある。失敗をそのどれかに確定帰属する証拠はない。タイトル切替に到達する前でもOOMが起こり得るため、「2タイトル目が必須のタイトルリーク」だけでは今回のOOMを説明できない。

smapsのPrivate_Dirtyにもfile-backed dirty pageが含まれ得るため、RSSやPrivate_DirtyをそのままCanvas/FFmpegの匿名heap量と呼ばない。B7で追加するAnonymous/AnonHugePagesは別途の観測で、全jobとの初期状態の違いも記載する。

v5の十進512MB・15秒3タイトルはsegment0〜9を通過し、3タイトル目のdynamic segment10でOOM、max/oom/oom_kill増分200/2/1となった。v4のsegment5失敗とは別の実測であり、v4の地点を書き換えない。この上限の30秒・Reference・境界ずらしの受入試験は停止し、合格扱いにしない。

v5 15秒512MBで失敗したFFmpeg PID330/segment10に紐づく最大標本はcurrent511,979,520 B、anon506,703,872 / file536,576 / kernel4,485,120 B、anon_thp348,127,232 B。FFmpeg RSS506,093,568/PSS504,377,344/USS502,566,912 B、同時Node RSS156,299,264/PSS153,722,880/USS151,986,176 B。fileがほぼ回収されてもOOMへ進んだという、file cache sole causeへの反証になる。個別PIDのRSS合算やTHP全量の無駄判定はしない。標本は瞬間peakそのものではなく、kernel peak512,000,000 Bとoom_kill増分1を合わせて読む。

### B7単体観測

1GB/CPU0.5、新規process各1回のkernel peakはbackground PNG75,931,648、title PNG39,133,184、static PNG生成119,554,048、fade encode496,009,216、static encode454,627,328、concat/mux66,387,968 B。各対応出力SHAは元ジョブのcomponentと一致した。入力を事前コピーしており、全jobのfile cache課金・Node初期状態と異なる。差をfilter固有allocator量としない。

fade最大標本のFFmpeg Anonymous456,781,824 / AnonHugePages346,030,080 B、Node Anonymous27,774,976 / AnonHugePages2,097,152 B。static encodeでもFFmpeg AnonHugePages346,030,080 Bを観測し、THPの大きな部分がこのFFmpeg process内にあることは支持される。一方、どのallocatorか、実データ対内部未使用の割合は未確定で、全部を無駄と判定しない。

追加の十進512MB B2（15秒1タイトル）は1回完成、peak512,000,000 B・max増分67で余裕なし。B4（同PNGを3区間再使用）はsegment5でOOM、max/oom/oom_kill増分158/2/1。B4では2区間目の新規title/static PNG生成を省いても失敗したため、「異なるタイトル画像生成が必要条件」という説への反証になる。B2の成功も異なる3タイトル条件の成功には数えない。境界で繰り返すdynamic fadeと匿名working setの同居が強い仮説だが、特定allocator/リークの確定ではない。

### 全jobのAnonymous/THP追加観測

[B3-thpの時系列](evidence/av-oom-v5/full-job-native-series.json) は同じB bundleのままsampler項目だけを増やした別imageによる1回の診断。1GB/CPU0.5/15秒3タイトルは完成、peak589,398,016 B。既存3反復とは計測器が異なるため反復平均へ混ぜない。

Node Anonymousはsegment0中65,662,976→47,316,992 B、segment5で47,783,936〜47,788,032 B、segment10で48,078,848 B、最後48,082,944 B。FFmpeg Anonymous最大はdynamic segment0/5/10で456,978,432 / 456,978,432 / 456,974,336 B、AnonHugePagesは各346,030,080 B。segmentごとの範囲/最大値は同一瞬間ではなく、合算してpeakを算出しない。Node AnonymousにはJS heap、stack、runtime等も含み、全部をCanvas nativeと呼ばない。

この単発ではタイトルごとの大きな匿名メモリ積上げは観測されず、各新規FFmpeg processの大きなworking setが繰り返されている。3タイトル/15秒だけで長期leak不存在を証明せず、Canvas/Buffer/loadImage/allocatorの帰属は未確定のままにする。

## 実験終了後の5周自己監査

同じ実装担当による自己監査であり、独立第三者監査ではない。全40資源case・23品質比較・4停止再生成の終了後に実施。機械可読の根拠と残件は [self-audit.json](evidence/av-oom-v5/self-audit.json)。

| 周 | 判定 | 根拠 | 残件 |
|---|---|---|---|
| 1 仕様・差分 | PASS | 本番renderer/API/DB/infra差分0、品質設定維持、B8不採用 | 任意実素材/本番image |
| 2 コード・再現性 | PASS | patch/4 bundle再構築SHA、immutable local image ID、raw SHA、input-scoped flags/PTS、設定失敗/権限失敗も保持 | registry RepoDigestなし、温冷cache未制御、25ms限界、全suite未実施 |
| 3 資源・原因 | HOLD | 十進512MBの5秒は2/3、15秒3タイトルOOM。file回収後も匿名working set大。THP/Native時系列 | 内部allocator、512MB余裕、長期/複数job |
| 4 品質・復旧 | PARTIAL | 完成22組/全segment完全一致、B8差異原因分離、standalone4停止、PGlite/FakeStorage各1件 | native PG/実Worker process/実storage、旧checkpoint混在、公開境界実停止 |
| 5 安全・無料・release | HOLD | 隔離/資格情報なし/自作停止containerのみ、11月7日作成既知、公式条文/予約量 | 正確な導入日/実アカウント適用/実予約量、長期、承認ゲート |

最重要の未解決ゲートに従い総合HOLD。1GBの合成実施範囲はPASSでも無料運用・本番のPASSではない。commit/pushはv5調査branchだけを対象とし、最終SHA/結果/作業ツリー状態は提出メッセージで示す。

## 最終判定

| 対象 | 判定 | 根拠 / 限界 |
|---|---|---|
| 十進512MB 合成一式 | HOLD | 5秒2/3成功、15秒3タイトルOOM。30秒等は停止 |
| 512MB 本番実用 | HOLD | 安全余裕・全受入反復・本番統合なし |
| 512MiB 合成受入 | HOLD | 5秒3/3、15秒1回完成だがpeak上限/max+34。残り未実施 |
| 1GB 候補B 合成 | PASS（実施範囲限定） | 5秒、15秒3タイトル×3、30秒/Reference/境界ずらし各1回。品質同一。長期保証なし |
| Blitz無料運用 | HOLD | 11月7日作成既知。導入日/例外/実プラン/実予約量は適用未検証 |
| production | HOLD | 本番image/実Worker/実storage/長尺/複数job/余裕/承認ゲート未完 |
