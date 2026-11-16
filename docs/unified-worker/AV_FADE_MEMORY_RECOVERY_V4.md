# All Versions fade memory v4 復旧検証

本書は同一担当の自己監査。v3の実停止・Mock・実DB統合を今回の再実証として扱わない。

本番レンダラー、profile/checkpoint識別、owner/job/plan/lease/fencing、セグメント検証、コピー結合、公開transactionは変更していない。診断は合成入力のみ、network none、DBなし、公開なし。

v3の証拠は `AV_STATIC_RECOVERY_V3.md` を参照。単体再生成5停止点、破損PNG再生成とforeign sentinel保護、実Worker/FakeStorage upload障害後のready checkpoint再利用が記録されている。実ストレージではない。

v4でのPNG生成中・fade encode中・static encode中・segment検証後・concat/mux前・公開transaction前後の全停止点を、実PostgreSQL+Worker+実ストレージと組み合わせる統合検証は未完了。未実行項目をPASSに含めない。

候補を本番経路へ入れる場合は、全フレーム/PTS/PCMが一致してもcheckpoint互換性は別に検証する。既存PNGの存在だけ、旧profile、不一致owner/job/plan、ハッシュ/サイズ/フレーム検証不合格の成果物を再利用しない。元データ・無関係checkpointを削除しない。

## v4今回の実行結果

性能matrixと同じ候補Bの凍結image、network none / 2GiB / 1CPU / swap0で、実プロセスを同期フックで停止し専用containerへSIGKILLを送信。Docker保持イベントで停止側exit137・再生成側exit0を7/7確認した（`evidence/av-fade-v4/recovery.json`）。

| 点 | 実停止の観測 | 再生成 |
|---|---|---|
| PNG生成 | child spawn直後に停止。画像生成内部の何byte目かは未確定 | 完成hash一致 |
| PNG生成完了直後 | FFmpeg正常close後、呼び出し元resolveより前 | 完成hash一致 |
| static encode開始 | 静止PNG入力child spawn後 | 完成hash一致 |
| static segment完成 | child正常close後、後段validationより前 | 完成hash一致 |
| segment検証後 | segment1検証完了後、次segment2 spawn前 | 完成hash一致 |
| fade encode稼働中 | segment0 child spawnから100ms後にSIGSTOP。厳密frame番号ではない | 完成hash一致 |
| concat/mux前 | candidate.mp4を作るchild spawn前 | 完成hash一致 |

すべて5秒300frames、488,611 B、audio240,640samples、SHA `df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95`。中断workを別containerへコピーし、fresh Node/cacheから**再生成**した。DB checkpoint再開ではない。

初回の不正PNG注入に加え、PNG署名8bytes＋途中切れ9bytesの計17bytesを明示生成して、hash/サイズ/署名を保存する追加1件も完了。fresh cacheが壊れたPNGを存在だけで信用せず再生成し、完成hashとforeign sentinel不変を確認（`recovery-invalid-png.json`）。旧harnessのescape文字列表現と実PNG署名を混同しないために追加した。decoderの全破損種類に対する網羅試験ではない。

rootの関係13件はMock復旧11・cache eviction/foreign保護1・実FFmpeg Reference1。専用PostgreSQLでbaseline既存47件（queue21、実Export1、Generic Render25）がPASS。候補Bは実Worker/DBの静止ON upload失敗→新lease→ready checkpoint再利用の1件PASS（他13件選択外）、原本hash不変も検査する。ストレージはFakeStorageで、実ストレージではない。

判定は引き続き**PARTIAL**。PNG/fade/static/検証/concatの単体停止再生成と、実DBの別試験は成立したが、同じ候補Bの実Worker全停止点・公開transaction前後のSIGKILL・実ストレージ・制限メモリ下Workerの一体検証は未完了。所有/plan/profile/fencingの既存照合コードは変更していない。今回のsentinelは合成ファイルであり、実ユーザーcheckpointの独立証明にはしない。
