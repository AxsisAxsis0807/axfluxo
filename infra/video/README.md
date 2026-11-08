# V4 Linux worker templates

これらはreview用です。cloud/DB/cluster/bucketを作成せず、migrationやdeployも行いません。

DockerfileはNode 24.19.0とDebianのffmpeg/libx264/zscale/tonemapを使用。秘密をimageへコピーしません。managed環境では既存proxyとCAを維持し、buildに`--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt`等のcombined CA bundleを渡してください。Docker認証設定は変更しません。通常の非proxy環境ではsecretなしでsystem CAを使用します。配布時にはbase image/ffmpegの対応source・licenseを確認してください（Debian package copyrightはimage内`/usr/share/doc/ffmpeg/copyright`）。この作業でimageの公開はしていません。

Composeは初期並列1、CPU2/RAM4GiB/PID128、非root、capなし、readonly、diskは既存seek可能bind mount、restart=no、内部networkのみ。既定flagはOFF。diskはjob/checkpoint復帰調査のため保持し、tmpfsをmedia diskに使わないでください。ホストdiskのsizeを自動変更する機能はありません。

実運用のegressはDBの明示host/portとR2 account endpointの443だけに制限します。exampleのCilium policyは実在する基盤でのレビュー用で、placeholderを残したまま適用できません。任意URLやInternetへの広い許可を追加しないでください。Composeのinternal networkはDB/R2を含む外部へ到達できないため、承認済みegress制御を用意するまでfail closedです。実行基盤でOOM監視・保留jobの原因調査を行ってください。未知のworker lossは保留し、自動で同条件へ再投入しません。

起動設定、queue・retry・quota・drainは [V4設計](../../docs/video/v4.md) を参照。

オフラインDocker smokeは`server/tests/render/container-smoke.ts`をesbuildで別途bundleし、`/app/smoke.mjs`へreadonly mountして`--entrypoint node ... /app/smoke.mjs`で実行できます。`--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 2 --memory 1g --memory-swap 1g --pids-limit 128`と、UID1000が書ける既存diskの`/work` mountを指定します。cloud/DB接続なしで合成mediaを生成し、segment結合・AAC encode/copy・全frame/decode検証を行います。production ENTRYPOINTを置き換えるのはこのローカル検証時だけです。

`render-lifecycle.example.json`はrender prefixの**未完成multipart partだけ**を7日後に回収する追加review例です。completed object/checkpointのExpiration/Deleteはなく、既存originals用policyを置換しません。未適用です。

V7の[保存・削除・通知](../../docs/video/v7.md)は専用output bucketと専用資格情報を前提にします。
`output-workers.compose.yaml`は既定OFFのレビュー用で、DB login、bucket、VAPIDを作成しません。
削除workerに原本bucket権限を与えず、通知workerにobject storage資格情報を与えないでください。
更新Dockerfileはrender/deletion/notificationsの3entrypointをbundleします。V7でimageの公開・deployはしません。

## Phase 1: portable API and sequential worker (local validation only)

No migration, provisioning or deployment runs at startup. The existing render image
(default target) and compose resource settings remain available. New targets:

```
docker build --target api -f infra/video/Dockerfile -t axfluxo-video-api .
docker build --target worker -f infra/video/Dockerfile -t axfluxo-video-worker .
```

The build context is the repository root. `proxy_ca` is optional. In a proxy
with a private CA, supply `--secret id=proxy_ca,src=<combined-CA-bundle>`; npm
uses the mounted additional trust and apt uses that bundle. Verification stays
on. Build-only CA files are not copied to the runtime. API/worker targets use
`ENTRYPOINT ["node"]`, with `/app/api.mjs` or `/app/worker.mjs` as CMD. For an
individual worker, replace CMD with `/app/probe.mjs`, `/app/derivatives.mjs`,
`/app/render.mjs`, `/app/deletion.mjs` or `/app/notifications.mjs`.
The legacy default target retains `ENTRYPOINT ["node","/app/render.mjs"]`.
Do not append an API filename to that legacy entrypoint.

`blitz/compose.yaml` is an isolated low-resource experiment, **not** evidence
that blitz.cloud accepts this configuration or can render 1080p60. API and
worker have no shared volume; only worker owns `/work`. The worker sets
`TMPDIR=/work` so verification/preview media is not staged in the small `/tmp`
tmpfs. The mounted folder must be writable by UID 1000. All work/admission
flags default OFF. It does not provision a database or inject secrets. The
example deliberately fails API startup until authentication, origin and test DB
settings are provided. It has no external route. A real storage adapter is still
required to enable work; no disk storage or internal upload listener is implemented.

New API/worker targets cap the JS heap at 128 MiB as an experimental setting,
not a measured total memory requirement. Native Canvas, FFmpeg, buffers and
process overhead also consume RAM. The old render heap remains 512 MiB. The
worker example has a 512 MiB container limit; production feasibility, elapsed
time and memory at 1080p60 require measurement. No output profile was changed.
The 25-second example stop grace is a local choice, not a provider guarantee.
