# 静止画合成 停止・復旧 v3

判定 **PARTIAL**。単体レンダラーの実プロセス停止・再生成は確認した。静止画ONの実Workerでupload失敗後のcheckpoint再利用まで確認したが、PNG生成中などの実停止を同じDB/Workerで一体検証する範囲は未完了。

## 実停止

同じ性能試験image/bundleを使い、network none / 2GiB / 1CPU / swap 0で実行。性能測定には含めない `stop-hook-v3.mjs` を `/work` に追加し、実FFmpegのspawn/closeに同期してSIGSTOP、その後専用コンテナへSIGKILL。各停止後の/work/resultを保存。新コンテナの新Nodeプロセスにその合成作業ディレクトリをコピーして再実行した。

| 停止点 | 同期フックの証拠 | 再実行 |
|---|---|---|
| 事前PNG生成中 | FFmpeg生成プロセスspawn直後、child/Nodeを停止。PNGファイル未生成 | 完成 |
| PNG完成直後 | 生成child正常close、cache登録/呼び出し元resolveより前で停止 | 完成 |
| encode開始時 | 静止PNG入力のFFmpeg spawn直後、child/Node停止 | 完成 |
| 静止segment完成時 | encode child正常close、呼び出し元resolveより前で停止 | 完成 |
| 次segment開始前 | segment1検証後、segment2のspawnを行う直前にNode停止 | 完成 |

5件すべて最終SHA `df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95`、300frames/1080p60、音声240,640samplesで中断なしAと一致。[同期停止JSON](evidence/av-static-v3/recovery-synchronous.json)。停止は実プロセスでありMockではない。ただしcheckpointの続行ではなく新プロセスによる単体再生成。単体fixtureはDB公開をしない。

初期ハーネスの再実行はHOME欠落によりuv_os_homedir ENOENTで失敗した。隔離HOME/TMPDIRを指定して修正し、失敗ログをローカル保持。最初の外部ポーリング方式5件も再実行成功したが、厳密な境界停止の証拠は後の同期方式を採用する。監視遅延を境界保証として扱わない。

追加の不完全PNG注入試験では、中断保存とは別の再実行コピーへPNG header+truncated bytesを配置し、無関係checkpoint sentinelを置いた。新cacheが不完全PNGを信頼せず再生成し、完成動画SHA一致とsentinel不変を要求する。結果は[追加復旧JSON](evidence/av-static-v3/recovery-poison.json)。

## コード監査

- `retainStaticComposite`は生成FFmpegが正常完了した後だけ呼ぶ。失敗途中PNGはメモリmapへ登録しない。新しいprepareGraphicsは新しいmapなので既存PNGを存在だけで信用しない。
- PNG名はversion index別。cacheは最大2、eviction時はmapにある自身のPNGだけ削除。単体cacheテストで古い自身のPNG削除とforeign checkpoint保持を確認。
- Generic Workerは毎回mkdtempでjob work directoryを分離。前jobのPNGを参照するmapを共有しない。finallyのcleanupは自身のwork directoryのみ。fixtureは測定証拠保持のためcleanupせず、これをWorkerのcleanup実行証拠にはしない。
- Generic Workerはplan hashにencoder versionとON時static-base-v1を含める。OFFのcheckpoint識別は維持。readyでowner/job/plan/segment一致のcheckpointだけ選択し、download時size/hashと動画検証を実施。不正なcheckpointはCHECKPOINT_CORRUPTとして停止。
- 認証/RLS/fencing/lease/cancel/retry/publicationの本番コード変更なし。実DB統合のupload失敗/再試行は追加確認済み。PNG生成などのSIGKILL停止点を含む統合試験は未実施。

## Mockと実DBを分離

- `resource-recovery-v2.test.ts`: Promise barrierを使った既存Mock11件PASS。実FFmpeg/SQL停止の代わりにはしない。
- `av-static-v3.test.ts`: cache eviction/foreign sentinel 1件PASS。
- 既存実FFmpeg Reference timer 1件PASS。
- 専用loopback PostgreSQL17（新規audit container、合成fixture、外部DBなし）で既存Cloud Export queue21、1080p60 Export1、Generic Render25件、計47件PASS。native結果とログを保存。
- Generic Render25件は、実claim childをSIGKILLしてlease回復とdead tokenのfencing、破損checkpoint拒否、upload失敗後のhash検証済segment再利用、出力1件、公開transaction rollback、cancel/retry/auth等を含む。これは既存Generic Renderの証拠であり、静止ONの統合成功には置き換えない。

本番DB、実ストレージ、元メディア、既存checkpointは操作していない。DB監査containerは既存scriptのfinallyで停止し、DB volume/dataは保存した。消したのは今回作成した停止済みメディア診断containerだけであり、/work全体とhash/logを先に保存している。

## 追加: 静止ONの実Worker/実DB統合

新規専用loopback PostgreSQL17で `projects.test.ts` のv3ケース **1件PASS（他13件は選択外）**。素材は1秒1タイトル/60frames、12-frame segment（0/4がfade、1/2/3がstatic）。5秒/60-frame segmentの資源測定とは区別し、このケースには512MB資源判定を付けない。FFmpeg・SQL・Workerは実処理、ストレージだけFakeStorage、upload障害は意図的な503注入。mediaProcess spyは元関数を実行する観測で、mock実装に差し替えない。

最初の実行でPNG生成1・静止入力encode3を観測し、ready checkpoint5件/公開0件をSQL確認。upload障害を解除して新lease tokenで再試行、静止PNGの生成/使用encode0、既存checkpointから出力1件/60frames、原本hash不変を確認。ON識別profileを含む同じplanの再利用であり、OFF checkpoint混用はしない。ログは[native-static.log](evidence/av-static-v3/native-static.log)、結果は[native-static-results.json](evidence/av-static-v3/native-static-results.json)。

既存47件とこの新規1件は別集計。実Blitz/実クラウドstorage/本番imageでの保証ではない。
