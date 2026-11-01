# V4 verification — 2026-11-01 JST

Base: V3 `beb7275`、最新main `367fb02570b4782aa5f51e892718fc473b376c59`。`feat/video-v4`。AGENTS.mdなし。PR #8のみopen、画像Studio/Workflow runnerとの共通変更ファイルなし。Node24.19.0/npm11.9.0。実クラウド・本番DBは未接続。

| Gate                                    | 結果                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| TypeScript / ESLint                     | 成功、warning 0                                                                             |
| 全unit/integration                      | 26 files / 252 tests成功（V3既存222を維持、V4追加30）                                       |
| 通常PostgreSQL 18.6                     | 専用loopback `axfluxo_video_test_v4c`、25/25成功。複数接続・実SIGKILLを含む                 |
| API / render worker bundle              | 独立esbuild成功。秘密の埋込みなし                                                           |
| Next static export                      | root build成功。既存routeと追加済developer routesを維持                                     |
| Linux Docker                            | 最終image `b97fd50ef5bf` build成功。非root offline smoke 2 mode成功、Compose config検証成功 |
| 既存画像runner/renderer・文書/DB/backup | V3から変更なし。rootのdependencies/lockfileも変更なし                                       |
| diff/format                             | diff --check、追加/変更TypeScript・文書のPrettier成功                                       |

PGliteは単一backend、native PostgreSQLは複数pool/接続。claim競合・重複配送・lease切れ・旧token遅延確定・cancel/失効・retry上限・OOM/disk/quota保留・upload応答消失・upload失敗後のcheckpoint hash再利用・破損checkpoint拒否・公開transaction途中失敗とrollback・owner分離を検証。nativeでは別Nodeプロセスがclaimした後にSIGKILLし、未公開の維持、lease回収→保留、原因確認を模したtest adminの再queue、token更新を検証する。未知のworker lossを自動retryしない仕様を試験に含む。

合成mediaはffmpeg lavfiの幾何画像/sineからローカル生成し、network取得なし。29.97/30/59.94/60fps、VFR、実tkhd rotation matrix、SAR2:1、PQ/HLG 10bit BT.2020→SDRを処理。映像segmentには音声なし。1秒出力のAAC encode/copyをdecode/hash/全frame PTS検証。copyでは元AAC packet payload hashが一致。30秒実mediaを6個の映像segmentとして処理し、音声の開始・各境界前後・末尾のPCM相関>0.98と1800frameを確認。100時間は整数時刻/segment計画の試験であり、100時間の実renderは実行していない。

Docker smokeはnetwork none、UID1000、read-only、capなし、no-new-privileges、CPU2、RAM/swap各1GiB、PID128、seek可能bind disk。image内Debian ffmpeg5.1.9でAll Versions AAC encodeとFNF AAC copy、それぞれ60frameの全decode検証が成功。ホストではffmpeg7.1.5。CPU/RAM/PIDの設定下で実行したが、cgroup OOMを意図的に発生させる試験やPID枯渇負荷試験ではない。OOM分類/保留は障害注入。resource不足に対する増設なし。

初回Docker buildはmanaged環境のvfs layer作成でdiskを使い切り失敗した。今回のbuild cacheだけを識別して整理し、Dockerfileのlayer数を削減した。最終image作成後の最初のcontainer起動もdisk不足で拒否されたが、cache整理後に同imageのsmokeが成功した。volume/原本/DBは削除していない。今回生成した古いローカルimageと未使用build cacheだけを整理した。ローカルPostgreSQLもdisk不足で停止したため、容量回復後に同じclusterを通常起動してWAL recoveryを行った。既存の全test DBを保持したまま、新しい専用V4 DBで試験を再実行。DB reset/再初期化/破壊的修復なし。この事故はproduct workerのENOSPC注入試験とは区別する。

未検証: R2実接続・5GiB超multipart転送・実remote network partition・本番egress policy適用・実cgroup OOM kill・長時間実動画/大容量負荷・HDRの基準display比較。WebKit/実機SafariはV4で実行していない（V4にfrontend差分なし）。公開受付/worker flagは既定OFF。Docker/Compose/Cilium/lifecycleはローカルimage検証またはreview用templateであり、cloud作成/本番migration/merge/deployは行っていない。

Generated evidence (git対象外): `work/v4-unit.log`、`v4-render-native.log`、`v4-typecheck.log`、`v4-lint.log`、`v4-build-root.log`、`v4-build-api.log`、`v4-build-render.log`、`v4-docker-build.log`、`v4-docker-smoke.log`。DB/job/checkpointは保持し、ローカルtest serverは終了時に停止する。
