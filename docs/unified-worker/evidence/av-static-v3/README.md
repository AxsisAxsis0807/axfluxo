# v3 evidence

- `measurements.json`: 18独立ケース（Phase B6 + C4 + D4 + E4）、cgroup前後・CPU・Node・process phase sampled peaks・raw log hash。
- `binary-manifest.json`: image rootfsのファイルSHA/サイズ。機密設定/環境は含めない。
- `path-verification.json`: 適用条件/実FFmpeg正常close/cache再利用の突合。512MB/MiB ONはstatic未到達INVALID。
- `quality-A/B/C/E1/E2.json`: 全framehash/PTS、probe、完成hash、decoded PCM hash。
- `timer-templates.json`: Reference ONの指定9frameに対する既知時計文字列の最小画素誤差。
- `recovery-synchronous.json`, `recovery-poison.json`: 性能試験とは別の実停止・再生成。
- `native-results.json`, `tests-*.log`: 隔離loopback PostgreSQLの既存47件（末尾空白のみ正規化、rawはローカル保持）。
- `cleanup.jsonl`: この監査の停止済みコンテナを/work全保存後に削除した記録。画像/volume/prune操作なし。

Raw logs、全25ms samples、画像/MP4、Docker archiveは`/workspace/axfluxo-av-v3/work/av-v3`に保持。Gitには合成メディアを含めない。各caseのimage/bundle SHAを照合して再現する。実Worker静止ON、本番image、Blitz cgroup、長尺は未検証。

再現:

```sh
npm ci --ignore-scripts
mkdir -p work/resource-audit
node_modules/.bin/esbuild server/tests/resource-audit-fixture.ts --bundle --platform=node --target=node24 --format=esm --external:@napi-rs/canvas --outfile=work/resource-audit/candidate.mjs
cp work/resource-audit/candidate.mjs work/resource-audit/baseline.mjs
python3 scripts/resource-audit/pack-runtime.py
docker --host=unix:///var/run/docker.sock build -t axfluxo-av-static-v3:local work/resource-audit/runtime-context
python3 scripts/resource-audit/run.py --static-v3 work/av-v3/NEW --memory 512000000 --static true
# OFFは別のNEW directory、同じimageで --static false。
# Phase Bは --memory 2147483648、B/Cは --seconds 15 --titles 3、Cは --layout reference-pasa-v1。
# 品質確認前に低メモリ試験へ進まない。各512/512MiB/1GBは独立ケース2回ずつ。
python3 scripts/resource-audit/quality-v3.py OFF_DIR ON_DIR quality.json
python3 scripts/resource-audit/verify-static-v3.py work/av-v3
python3 scripts/resource-audit/summarize-static-v3.py work/av-v3 docs/unified-worker/evidence/av-static-v3
python3 scripts/resource-audit/test-static-v3.py
# 独立停止試験（本番/ユーザーデータ禁止）
python3 scripts/resource-audit/stop-v3.py work/av-v3/NEW_RECOVERY
```

必要な場合だけ、`cleanup-static-v3.py`で今回の正確な診断image/label/prefixと停止状態を検査し、全/workとSHAを保存してから対象containerのみ削除する。既存/稼働中container、image、volumeは削除しない。Docker VFSではルート層複製があり、writable表示だけから空き容量を推定しない。
