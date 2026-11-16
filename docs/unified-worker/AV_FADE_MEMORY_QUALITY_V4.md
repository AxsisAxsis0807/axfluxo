# All Versions fade memory v4 品質

5秒・1タイトル・60frame segment・両端9frame fadeの候補Bは、2GiB/1GB/512MB独立3回について、未変更baseline静止ONと完成MP4・全デコード映像/PTS・48kHz PCM/サンプル数・入力が完全一致した。

完成MP4 SHA-256は `df31d5e1b4be8b8832ac38b43adbe5f5f0fc158b361e0bf953590dadaf1c3d95`、488,611 B、300frames、1920×1080、60/1、H.264/yuv420p/BT.709、PCM 240,640 samples（AAC padding込み）。`evidence/av-fade-v4/quality-Bcand*.json` が今回の実測。v3資料の引用だけではない。

`quality-v4.py` は両出力をすべてデコードし、全framehashテキストとPTS/duration列のSHA、PCM全体のSHA・bytes・samples、probe、入力を比較する。全framehashの原文は各caseの隔離作業ディレクトリに保持する。ハッシュが異なる場合はPASSにせず、事後的なしきい値緩和をしない。

完成MP4/全画素が完全一致する素材では、先頭/末尾9frames、fade→static、各セグメント境界、文字の縁取り/位置/ぼかし、音声と同期のbaseline/candidate差がないことの強い証拠になる。baselineのデザインそのものが正しいという独立証明ではない。完全一致のためその組にPSNR/SSIMは不要。

マイクロベンチは別証拠。先頭60frameのfull-encode/filterloopとbaseline segment0のMP4 SHAは `130a7c2ab784ee4f5620a6fae3254885f45ec9c30ae6ae6da246f48fc51c5ef8` で一致するが、これだけを完成動画・Reference時計・音声・ジョブ全体品質PASSには使っていない。

候補A/Bのsource patchとバンドルSHAを固定している。本番ソースへは採用していない。実ユーザー素材、本番image、実Blitz、任意のタイトル/フォント/長尺、実Workerでの全品質は未認証。

## 複数タイトル・Reference・30秒

今回の独立した2GiB baseline/candidate B比較。すべて完成MP4・全framehash/PTS・PCM・入力が完全一致。

| ケース | frames | MP4 SHA-256 | audio samples |
|---|---:|---|---:|
| 15 | 900 | `b083388426f46d2f78ba7d841d94c10797a8b838bc8848cf6f9895dcc14c792a` | 720896 |
| Reference | 900 | `9d4edba7c145da22acee4a8b7af24638967b4e20f0fc9194ec14d9c6181bd8f2` | 720896 |
| 30 | 1800 | `21708b54a7b32e133e47e9eb6cda0d7cb87da4d23ddeb267993ce86ba2e56fc0` | 1440768 |

Referenceは各タイトルの非線形alpha・時計更新・リセットを含む全900framesの相互比較。指定時計文字列の独立テンプレート検査は別JSONで管理する。30秒は1800frames、24静止segment/PNG生成3/再利用21を実ログと照合する。

## ずらした境界と独立時計テンプレート

15秒の境界を4.25秒/9.10秒（version長255/291/354frame）へ変更し、60frameで割り切れない末尾と各versionのfadeを検査。2GiBのbaseline/candidate BはMP4・全フレーム/PTS・PCMが完全一致（`quality-boundary.json`）。fixtureの素材条件が違うため通常matrixと別bundleとして固定した。

Referenceのframe60/65/66/120/180/360/366/660/666を、既知の00:01〜00:05文字列を同フォント/位置/alphaで描くテンプレートと比較し9/9一致（`timer-templates.json`）。全framehash比較とは独立した指定フレームの検査であり、全時刻のOCR認識ではない。
