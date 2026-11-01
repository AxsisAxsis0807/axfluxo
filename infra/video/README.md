# V4 Linux worker templates

これらはreview用です。cloud/DB/cluster/bucketを作成せず、migrationやdeployも行いません。

DockerfileはNode 24.19.0とDebianのffmpeg/libx264/zscale/tonemapを使用。秘密をimageへコピーしません。managed環境では既存proxyとCAを維持し、buildに`--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt`等のcombined CA bundleを渡してください。Docker認証設定は変更しません。通常の非proxy環境でもsecretは信頼するsystem CA bundleを渡せます。配布時にはbase image/ffmpegの対応source・licenseを確認してください（Debian package copyrightはimage内`/usr/share/doc/ffmpeg/copyright`）。この作業でimageの公開はしていません。

Composeは初期並列1、CPU2/RAM4GiB/PID128、非root、capなし、readonly、diskは既存seek可能bind mount、restart=no、内部networkのみ。既定flagはOFF。diskはjob/checkpoint復帰調査のため保持し、tmpfsをmedia diskに使わないでください。ホストdiskのsizeを自動変更する機能はありません。

実運用のegressはDBの明示host/portとR2 account endpointの443だけに制限します。exampleのCilium policyは実在する基盤でのレビュー用で、placeholderを残したまま適用できません。任意URLやInternetへの広い許可を追加しないでください。Composeのinternal networkはDB/R2を含む外部へ到達できないため、承認済みegress制御を用意するまでfail closedです。実行基盤でOOM監視・保留jobの原因調査を行ってください。未知のworker lossは保留し、自動で同条件へ再投入しません。

起動設定、queue・retry・quota・drainは [V4設計](../../docs/video/v4.md) を参照。

オフラインDocker smokeは`server/tests/render/container-smoke.ts`をesbuildで別途bundleし、`/app/smoke.mjs`へreadonly mountして`--entrypoint node ... /app/smoke.mjs`で実行できます。`--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 2 --memory 1g --memory-swap 1g --pids-limit 128`と、UID1000が書ける既存diskの`/work` mountを指定します。cloud/DB接続なしで合成mediaを生成し、segment結合・AAC encode/copy・全frame/decode検証を行います。production ENTRYPOINTを置き換えるのはこのローカル検証時だけです。

`render-lifecycle.example.json`はrender prefixの**未完成multipart partだけ**を7日後に回収する追加review例です。completed object/checkpointのExpiration/Deleteはなく、既存originals用policyを置換しません。未適用です。
