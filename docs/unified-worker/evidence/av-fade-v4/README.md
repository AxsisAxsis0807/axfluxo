# v4 evidence index / 再現

最終判定HOLD。証拠整合性チェックのPASSは512MB対応のPASSではない。

- `provenance.json`, `runtime-identity.json`: 起点/remote確認、v3との全runtimeファイル一致、core binary/bundle SHA。追加observerはargv非変更。
- `candidate-A/B.json`, `candidate-A/B.patch`: frozen比較案。B=A+static-use loop。採用保留。本番rendererには未適用。
- `boundary-bundles.json`: shifted境界専用fixture bundle SHA。rendererはbaseline/Bと同じ。通常fixtureと素材条件を分離。
- `measurements.json`: 実cgroup/CPU/swap/ディスク、RSS/PSS/USS/threads、実argv抜粋（argvDefinitionsのSHA参照から復元、1定義/caseにつきJSON1行。人向け表はRESULTS.md）、各段階、OOM、入力/code/image SHA、raw hash。
- `quality-*.json`: 完成MP4/全decode framehash/PTS/PCM/sample count/inputの一致。raw全framehashはlocal保持。
- `timer-templates.json`: Reference指定9frameの既知時計文字列テンプレート検査。OCR/全時刻の独立認識ではない。
- `verification.json`: expected OOMを含む証拠の機械照合。production PASSを出さない。
- `checks.json`, `recovery.json`: 実行チェックと単体実停止・再生成。実DB/FakeStorageは実storageと区別。

大容量成果物・全argv・stderr・25ms目標samples・全MP4/PNGは `/workspace/axfluxo/work/av-fade-v4/` に保存。自作停止containerは/work退避・hash後に削除。共有image/volume/他作業の削除なし。Gitへメディアや全診断ログを含めない。

## 再現の前提

無料の許可済みLinux x86_64 / cgroup v2 / Docker、約2GiB以上のcase前ディスク予約、同じNode24.19.0 / FFmpeg7.1.5 / Canvas・fonts・shared libraries。実本番imageではない。ネットワーク/DB/秘密情報/ユーザーメディアを診断containerへ渡さない。既存workディレクトリを上書きせず、新しいcheckoutを用いる。

baselineは指定SHAの別checkoutでv3 README記載のesbuildコマンド（JS依存bundle、Canvasだけexternal）を実行し、`f3d031760b2b5874636d4c9f5bb31845f1144142fb26dfc129cd15796c09d2de` を要求する。最終fixtureには境界拡張があるため、最終HEADからのbundleを未変更baselineと呼ばない。

```
npm ci --ignore-scripts
# 指定SHA checkoutから得た同一baseline.mjsを新規work/resource-auditへ置く。
cp work/resource-audit/baseline.mjs work/resource-audit/candidate.mjs
python3 scripts/resource-audit/pack-runtime.py
cp scripts/resource-audit/preload-v4.mjs work/resource-audit/runtime-context/rootfs/app/preload-v4.mjs
chmod 644 work/resource-audit/runtime-context/rootfs/app/preload-v4.mjs
sed -i 's@/app/preload.mjs@/app/preload-v4.mjs@' work/resource-audit/runtime-context/Dockerfile
docker build --network=none -t axfluxo-av-fade-v4:baseline work/resource-audit/runtime-context
python3 scripts/resource-audit/fade-v4.py B2-off-r2 --memory 2147483648
python3 scripts/resource-audit/fade-v4.py B2-on-r2 --memory 2147483648 --static true
python3 scripts/resource-audit/quality-v4.py B2-off-r2 B2-on-r2 work/av-fade-v4/quality-initial.json
# 品質一致後に1GB、512MB。すべて新label。
python3 scripts/resource-audit/fade-v4.py B1-on-1 --memory 1000000000 --static true
python3 scripts/resource-audit/fade-v4.py B512-on-1 --memory 512000000 --static true
```

候補は指定SHAを新規 `work/fade-candidate-src` にgit archive展開し、`patch -d work/fade-candidate-src -p1 --batch --forward < docs/unified-worker/evidence/av-fade-v4/candidate-B.patch` でそのコピーだけを変更する。依存node_modulesを参照可能にして同じesbuild引数/相対entry pathでbundle化し、candidate-B.jsonのbundle SHAと照合する。`FROM axfluxo-av-fade-v4:baseline` + `COPY baseline.mjs /app/baseline.mjs` の隔離子imageをcandidate-Bタグに作る。baseline.mjsというファイル名はsampler allowlist用で、案の識別はcaseのimage/code SHA。

```
python3 scripts/resource-audit/fade-v4.py NEW-B2 --memory 2147483648 --static true --image axfluxo-av-fade-v4:candidate-B
# 全decode品質一致 → 1GB → 512MB短時間反復の順。
# 512MBの15秒OOM後はReference/30秒の512MBへ進まない。
python3 scripts/resource-audit/fade-v4.py M-full-filterloop --memory 2147483648 --micro full-filterloop
python3 scripts/resource-audit/stop-v4.py work/av-fade-v4/NEW_RECOVERY
python3 scripts/resource-audit/summarize-fade-v4.py
python3 scripts/resource-audit/verify-fade-v4.py
```

microは `B2-off-r2` で生成済みの同一PNGだけをコピーする。raw-readyは `M-full-raw` の事前生成RGBA、crop-readyは `M-full-crop` の同じalpha bboxを使い、生成Canvasをencodeプロセスから分離する。単発差をallocator固有確保/速度保証にしない。集約/verifyは今回のlabel集合を対象としており、新labelの再現はcase単位JSONも確認する。

shifted境界は最終fixtureの追加引数 `shifted`、15秒3タイトルだけ許可。両rendererで同じfixtureをbundleし、baseline/候補専用imageを別タグに作る。`--boundary` と `--image axfluxo-av-fade-v4:boundary-base` または `boundary-B` を併用する。通常source/bundle SHAと混同しない。
