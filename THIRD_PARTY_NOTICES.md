# Third-party notices

アプリ自身のライセンスは所有者が未決定です。本ファイルはアプリのライセンスを付与しません。

主要な実行時依存（バージョンはpackage-lock.jsonで固定）:

- Next.js — MIT
- React / React DOM — MIT
- Konva — MIT
- Zod — MIT
- fflate — MIT
- Lucide React — ISC
- @xyflow/react 12.12.0 / @xyflow/system — MIT (`public/licenses/xyflow-*-LICENSE.txt`)
- @dagrejs/dagre 3.1.2 / @dagrejs/graphlib — MIT (`public/licenses/dagre*-LICENSE.txt`)

同梱フォントはすべてSIL Open Font License 1.1。権利者と全文は次のファイルに保持しています。

- Noto Sans JP: public/fonts/noto-sans-jp-LICENSE.txt
- Inter: public/fonts/inter-LICENSE.txt
- Lora: public/fonts/lora-LICENSE.txt

`public/fonts/manifest.json` はfamily、weight、配布ファイル、SHA-256の対応を記録します。フォントは@fontsourceパッケージから取得したものです。アイコン・依存パッケージの配布ライセンス全文は`public/licenses/` と各npmパッケージのLICENSEにも保持されています。第三者のカバーアート、音楽アプリの画面、ユーザー添付画像は標準素材として同梱していません。

動画/クラウド素材の追加依存:

- @noble/hashes 2.4.0 — MIT (`public/licenses/noble-hashes-LICENSE.txt`)。browserの分割SHA-256/part整合用MD5。原本の認証・重複判定はserverで実bytesのSHA-256を使用。
- @aws-sdk/client-s3 / @aws-sdk/s3-request-presigner 3.1161.0 — Apache-2.0。serverのみ。ライセンス全文は各npm packageに含まれます。

## All Versions server graphics (V5)

- Aleo variable font, Google Fonts `ofl/aleo/Aleo[wght].ttf`: SIL Open Font License 1.1. Unmodified font SHA-256 `62b6cb49b7b087b341f0307ea3bc871a9690d8947691206ab025d149b8f6ed6f`; license: `public/licenses/Aleo-OFL.txt` and the bundled server asset directory. Used by the server to rasterize preview/export text; no external font service request at runtime.
- `@napi-rs/canvas` 1.1.0 and platform package: MIT. Server only. License: `public/licenses/napi-rs-canvas-LICENSE.txt`. Existing browser renderer/dependencies are unchanged.

## FNF Showcase graphics (V6)

Noto Sans JP variable font, Google Fonts `ofl/notosansjp/NotoSansJP[wght].ttf`: SIL Open Font License 1.1. Unmodified font SHA-256 `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`; license: `public/licenses/NotoSansJP-OFL.txt` and the bundled server asset directory. Used by the server for the fixed heading/username PNG shared with preview. No runtime font download and no new JavaScript dependency.

## Local audio waveform analysis

- Mediabunny 1.65.1 — Mozilla Public License 2.0 (`public/licenses/mediabunny-MPL-2.0.txt`). Unmodified demuxing, audio packet remuxing and PCM decoding library. Corresponding source is distributed in the npm package and available at https://github.com/Vanilagy/mediabunny/tree/v1.65.1 (https://www.npmjs.com/package/mediabunny/v/1.65.1). No server or runtime CDN is required.
