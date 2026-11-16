# 静止画合成 品質 v3

対象は単体新All VersionsレンダラーのA（5秒1タイトル）、B（15秒3タイトル）、C（15秒Reference3タイトル）、1GBのA独立2組と追加F（30秒3タイトル/1GB）ペア。OFF/ONは同じimage/bundle/input。画質パラメーター変更なし。

## 全フレーム・音声

| 素材 | frames | 完成MP4 SHA-256（OFF=ON） | bytes |
|---|---:|---|---:|
| A | 300 | `df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95` | 488611 |
| B | 900 | `b083388426f46d2f78ba7d841d94c10797a8b838bc8848cf6f9895dcc14c792a` | 1414746 |
| C | 900 | `9d4edba7c145da22acee4a8b7af24638967b4e20f0fc9194ec14d9c6181bd8f2` | 1736056 |

1GB Aの4出力もAと同じSHA/size。映像全デコードframehash SHA-256、フレームPTS/duration、48kHz stereo PCMデコードSHA/サンプル数を比較。完成MP4が完全同一なので、この入力ではタイトル位置・背景・カバー・フェード・タイマー・セグメント境界もOFF/ON間で同一。目視だけの判定ではない。PSNR/SSIMはバイト/画素一致時には不要（PSNRは無限大相当、SSIM=1相当）。差異がある場合に計算するスクリプトも用意。

1920×1080、H.264、60/1、yuv420p、BT.709 metadataをprobe保存。300/900 frames、video duration5/15秒。AACのdecoded audioSamplesはA240,640、B/C720,896（AAC frame padding込み）でOFF/ON一致。48kHz換算5/15秒の内容とパディングを区別する。新たな境界音声primingを足していない。`assemble`の既存encode-once/検証仕様は保持。

## 追加F（1GB・30秒）

OFF/ONとも1800frames、audioSamples1,440,768、完成2,678,108 B、MP4 SHA `21708b54a7b32e133e47e9eb6cda0d7cb87da4d23ddeb267993ce86ba2e56fc0`。30セグメントを検証後結合。静止24segment、PNG生成3・再利用21、各バージョン両端のfade6segment。全デコード/PTS/PCMの比較結果は[quality-F.json](evidence/av-static-v3/quality-F.json)。1GBで1組の予備評価であり、512MB長尺の品質/資源PASSではない。

## 適用区間

A-ON: static segment1/2/3、PNG生成1・再利用2、fade dynamic segment0/4。B/C-ON: static1/2/3、6/7/8、11/12/13、PNG生成3・再利用6、dynamic0/4/5/9/10/14。各バージョンで異なるPNGを生成し、最終cacheはindex1/2のみ（容量2のeviction）。全framehash一致により前タイトル混入やフェード境界のOFF/ON差なし。

各セグメントの適用条件、begin/encoded、cache前後、実FFmpegのstatic-generate/useと正常closeを突合。[path-verification.json](evidence/av-static-v3/path-verification.json)。PNG生成だけで完了扱いせず、静止入力を使用したencode完了を要求。

## Reference時計

C-ONの静止区間に対して、既知の文字列00:01〜00:05を同じフォント/位置/alphaで独立描画したテンプレートと画素比較。frame60/65は00:01、66/120は00:02、180は00:03。version2の360/366とversion3の660/666で00:01→00:02を再現。9/9で期待文字列が最小誤差。frame65と66のcrop hashも異なる。結果は[timer-templates.json](evidence/av-static-v3/timer-templates.json)。これはOCRや全frame時刻の独立認識ではなく、指定フレームの表示値テンプレート検査。

最初のOCR試行は細い文字/複雑背景で認識失敗したためPASS根拠に使わない。既存の実FFmpeg Reference試験も合格（timer reset、+66frame tick、fade、static ON middle比較）。通常sandboxのffprobe EPERMで一度失敗、同じ試験を許可済みlocal subprocess実行で再検証し合格。期待値や画質しきい値は緩和していない。

## 限界

完全一致はこの合成入力と診断バイナリに限る。1GBでの複数タイトル/Reference反復、本番Dockerfile、実ユーザーメディア、静止ON実Workerの512MB資源試験は未検証。512MB/MiBでは完成動画なし、品質PASSは付けない。[quality-A/B/C/E1/E2 JSON](evidence/av-static-v3/quality-A.json)に映像stream/全PTS/framehash/音声hashを保存。
