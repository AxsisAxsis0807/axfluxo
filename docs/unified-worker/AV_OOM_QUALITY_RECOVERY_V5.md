# AV OOM quality / recovery v5

**本番HOLD。** 合成完成動画の同一性、standalone停止後の再生成、Workerのcheckpoint再利用、実ストレージの復旧を別々に扱う。完成した動画はfixture自身の全segment検証・assemble・最終検証を通す。OOMで完成していないケースに完成動画の品質PASSを付けない。

## 品質ゲート

同じ素材・Node/FFmpeg/Canvas/fontでbaselineと候補B/C1を比較する。`quality-v5.py` は完成MP4 SHAを第一に比較し、全デコードフレームのSHA列、全PTS/フレーム長、PCM全サンプル、音声sample数、video/audio長・codec・fps・timebase・色メタデータも保存する。framehash生ログはignored workに残し、比較JSONとそのSHAだけをGitへ保存する。

各フレーム比較はfade・時計・全segment境界を包含する。Referenceは別の実行条件として、非線形title alpha、背景、各タイトルでの時計リセットが維持されているかを同じbaselineに対して確認する。全フレーム完全一致は、その固定素材での同一性の証拠であり、任意素材/文字/長尺の目視・機能保証へ拡張しない。

5秒/15秒/30秒/Reference/境界ずらしのv4品質証拠は [v4 QUALITY](AV_FADE_MEMORY_QUALITY_V4.md) に保持する。v5では追加fixture/計測器のbundle SHAが異なるため、新しい比較証拠を区別する。baselineはv5の同じfixture拡張を使い、candidateのrendererのみを隔離パッチで変える。

B8のsegment長変更は診断だけである。最終MP4 SHAが異なるなら、フレーム/PCM/PTSが一致しても個別審査前に採用しない。デコード差がある案は品質同一候補として採用せず、旧checkpointへ無条件に適用しない。static ONを通らないB8を静止経路の品質/性能PASSとはしない。

## checkpoint identityと保護契約

`AV_RENDERER=axfluxo-all-versions-v5.1`、`RENDER_VERSION=axfluxo-render-v4.1` を変更しない。`projectPlan()` はprojectとsegment構造をhashに含める。WorkerはさらにFFmpeg version、renderer version、ON時の `staticComposite: static-base-v1`、namespace/resource profile等をplan identityへ加える。既存checkpointはready・plan hashにより選択され、downloadでsize/hashを検証する。壊れたcheckpointを無条件再利用しない。

候補BはPNG入力のdecode/loop変更に限定し、identityコードは変更していない。しかしソースが同じidentityを生成することと、あらゆる旧checkpointと互換であることは同義ではない。固定合成素材の最終/segment SHA確認と、Workerの再利用試験を区別する。今回のWorker試験も、実ストレージや実本番checkpointの横断移行を証明しない。B5はMapをclearしても既存ファイルを削除しない。C1はPNG encode完了後のCanvas resetだけで、既存checkpointを削除しない。

## 停止と復旧の範囲

`stop-v5.py` は診断専用hookで所定の境界を止め、対象コンテナをSIGKILLし、合成作業ディレクトリだけを新しいコンテナへコピーして再生成する。これは **standalone restartであり、DBのlease/fencingやcheckpoint再開試験ではない**。PNG途中のケースではPNG signatureを持つ切断ファイルも注入し、完成扱いにせず再生成し、foreign checkpoint sentinelを保持する。fade-runningは開始後100msのプロセス停止で、厳密な内部フレーム境界ではない。停止監視のdocker execが追加プロセスを使うため、停止試験の資源値をレンダリング受入判定に流用しない。

既存v4の7停止点は [v4 RECOVERY](AV_FADE_MEMORY_RECOVERY_V4.md) に保持する。PNG生成/完成、encode開始、segment完成、次segment直前、fade途中、mux直前のstandalone証拠を、v5で実Worker+PostgreSQL+実ストレージの全点を通したかのようには報告しない。

Worker/DBの試験では使用エンジンとstorageを明記する。PGliteはnative PostgreSQLの複数connection/実プロセス復旧の代替証明ではない。FakeStorageは実ストレージではない。upload再試行・checkpoint reuse・取消・lease・公開の既存テストが成功しても、本番のネットワーク障害/公開直前直後/停止復旧の完了認証にはしない。

## 未実施のリリースゲート

実ユーザー素材、本番image、実Blitz、実Worker+native PostgreSQL+実ストレージの全停止点、本番checkpointの版横断、公開transactionの前後を実SIGKILLする試験、mux途中の全エラー形態、長尺・複数job・sleep後再開・storage容量枯渇の実環境試験は未検証。実本番操作や資格情報を使わない。実ストレージ試験には別途ユーザー承認が必要。

## 実行済みidentity確認

[identity.json](evidence/av-oom-v5/identity.json) は同一の実入力spec/hashを各隔離sourceの実 `projectPlan()` に渡した結果。baseline/B/C1のrenderer/worker version・plan hash・segment構造は同一で、60→300 frameへの分割変更はplan hashを変更した。これはplan生成の実行確認であり、実ストレージの旧checkpoint混在移行を通した証拠ではない。Worker側のencoder/static/namespace追加identityもソース確認し、ONとOFFやnamespaceを同一視しない。

## B8の差異を分離した結果

60→300 frame分割では完成MP4 SHAと全デコードframe hashが不一致。900枚中840枚が異なり、最初の差はframe20。PTS/長さ/PCM/sample数/色・video/audioメタデータは一致した。input比較の不一致はsegmentFrames60→300に対応し、素材・名前・fade設定を変更したわけではない。

[B8-difference.json](evidence/av-oom-v5/B8-difference.json) と [filter-partition-comparison.json](evidence/av-oom-v5/filter-partition-comparison.json) による追加切り分けで、static OFF/60frameと300frameの実filter argvをx264直前でraw framehashへ出し、全900枚の画素列が完全一致した。完成H.264のkeyframe位置は60frame版が0,60,…840、300frame版が0,250,300,550,600,850。CRF/preset/threads/lookaheadを下げたのではなく、encoder再起動位置と参照履歴の違いに伴うencode差と説明できる。decode完全一致を要求する候補としては不採用で、旧checkpointへ適用しない。静止経路を通らなかったON試験としてもINVALIDである。

## v5停止再生成の実施結果

4点（PNG生成開始＋切断PNG注入、fade開始後100ms、mux直前、live mux中）の全てでtriggerを実際に観測し、SIGKILL後の新規process再生成で最終MP4 SHA `df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95` が一致、foreign checkpoint sentinelも保持した。live muxでは生存中FFmpegと48 Bの書込み済み出力を観測して停止し、切断MP4はffprobe終了1（未完成）、再生成後は完成hash一致。

[recovery.json](evidence/av-oom-v5/recovery.json) / [mux-interruption.json](evidence/av-oom-v5/mux-interruption.json)。各停止は1回の合成standalone試験。再生成は全segmentを作り直しており、DB checkpoint resumeではない。復旧監視processもcgroupに入るため、そのpeakを資源受入に使わない。復旧用には変更していないB診断tagを使用し、資源matrixのper-case immutable-ID記録とは範囲を区別する。

Worker `executeRender` + PGlite + FakeStorageの選択試験はbaseline/B/C1各1件成功（各suiteの他13件は選択外）。upload失敗で未公開のままreadyな5segment checkpointを保持し、新tokenの再試行で再利用・一出力・元入力不変を確認した。native PostgreSQL/実storage/実process SIGKILLはこの統合試験に含まない。

Mock orchestration11件＋cache1件は成功。Referenceの実FFmpeg単体1件は初回ffprobe spawnSync EPERM、実行権限だけを追加した同一assertion/timeoutの再実行で成功。初回ログを保存し、期待値を緩めていない。全repository/browser suiteは今回再実行していない。

## 完成品質の集計

[quality-index.json](evidence/av-oom-v5/quality-index.json) に23比較を収録し、対応する候補完成job22比較は完成MP4/全フレーム/PTS/PCM/色メタデータが完全一致。残る1比較は意図的なB8分割診断で差異検出・不採用。OOMで未完成の3caseとINVALID_SETUPを品質PASSに混ぜない。

[segment-parity.json](evidence/av-oom-v5/segment-parity.json) では、その22組の全対応segment MP4 SHAも一致した。これは固定合成入力でのsegment互換性の証拠であり、実ストレージの旧checkpoint混在再開を完了したという意味ではない。C1の品質比較は15秒3タイトルのみで、他の長さ/Referenceは未認証。C1は資源改善なしで不採用。
