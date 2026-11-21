# AxFluxo 実用化前の5周監査とCodex引継ぎ（2026-11-22）

## 対象と保護ルール

- 基準: PR #36 / `feat/blomp-storage-phase1` / `9369831ffb5e65cca399ab49638c4ebd1fd470c0`
- 小修正の隔離ブランチ: `feat/axfluxo-preflight-audit-fixes`（PR #36へ未マージ）
- 証拠レベル: **確認済みのコード上の問題** / **未検証の実機・実接続リスク** / **最適化候補** を混同しない。
- 無断マージ、本番Pages更新、Blomp実通信・削除、課金、有料プラン変更は禁止。
- iPhone Safari優先、既存のAll Versions・FNF Showcase・復元・保存・ユーザー設定を保持。試験D専用ホストの拡張は保留。
- ユーザーの楽曲ファイルをテストfixtureとしてGitリポジトリへ追加しない。合成MP3/WAV等を作る。

## 第1周: 素材選択と音声メタデータ

**確認済み**
- `src/services/video/local-audio.ts` は再生時間取得のために `loadeddata` のみを待機、30秒で拒否。モバイルSafariでは `loadeddata` が発火しない条件がありうる。
- `LocalVideoTool.tsx` の「動画から音声を抽出」欄は元々音声も許可しながら強制的に `video` として扱うUI不一致。失敗後の同じ動画の再選択も困難。
- 端末のファイルアプリでユーザーMP3を再生できるが、試験サイトで30秒タイムアウトしたという実機観測がある。ただし原因イベントのログは未採取。

**このブランチの小修正**
- `local-audio.ts`: 有限で正の `duration` を `loadedmetadata` / `durationchange` で取得。30秒・形式エラー・空ファイル拒否は保持し、実際の再生/完成出力の検査は後段に残す。
- `LocalVideoTool.tsx`: 動画欄を `video/*` のみにし、ファイル選択値をリセットする。
- `tests/video/local-audio.test.ts`: `loadeddata` が来ない、遅延duration、エラー、タイムアウト、空ファイルの回帰テスト。

**残る検証**
- iPhoneで同一の約106秒MP3を再登録し、読み込み成功 / エラー内容を確認する。登録成功だけで書き出し合格とはしない。
- 画像埋め込みMP3、VBR、WAV/M4A、破損ファイルを正常/異常に振り分ける。

## 第2周: Safari書き出し・動画/音声品質

**確認済み**
- `src/services/video/local-encode.ts` の `mediaReady(media, "loadeddata", signal)` は素材登録後も実行される。登録だけ直しても書き出し開始時に止まるリスク。
- `playForEncode()` にSafariユーザー操作への復旧UIがある。これを消すと音声が無音になるおそれ。
- `local-output.ts` は映像・音声の最初のパケットを検査するが、映像トラック長の厳密な検査は `expectedDuration` が渡された短尺（10秒以下）に限定。音声トラック長の全面的な照合もない。
- MP4初回の映像欠落/短縮は過去に記録されており、短尺復元時のWebM再試行は導入済み。内部原因は未特定。
- Canvas captureStream + MediaRecorder は実時間方式。256MiB出力上限・最大12ジョブなどで長尺/メモリ制限が残る。

**CodexタスクA（最優先）**
1. `local-encode.ts` のメディア準備を音声/動画で分ける。イベント/readyStateを使い、Safariが`loadeddata`を発しないときでも安全に進めるか、具体的な失敗理由を早く出す。メタデータだけで無条件に録画開始しない。
2. `play()`・音声ルーティング・映像フレーム・シーク時刻・キャンセル、タブ移動を壊さない。空/破損ファイルは拒否。
3. `validateLocalOutput` を拡張し、長尺で両ストリームの開始/終了・実パケット・欠落・短縮・A/V同期を検査。重い全量デコードをiPhoneで無条件に行わない。
4. 端末内書き出しに失敗しても元ファイル・予約・前回の成功出力を保持。MP4失敗時WebMは対応環境のみ安全に再試行。
5. 短尺・約2分・10分以上の合成テスト、iPhone Safari実機の音と映像の先頭/中間/末尾・フレーム時刻検査。計測前に高速化成功や安定動作を断定しない。

**合格条件**
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:video:browser`, `npm run test:e2e` に成功。
- 合成MP3/WAV、画像付きMP3、破損ファイル、開始時刻>0のシーク、繰り返し再生/復元/キャンセルを検査。
- FFprobe / FFmpegで映像・音声・長さ・非無音を検証。ブラウザー対応外形式は保存リンクなしの明示エラー。
- Linux WebKit ≠ iOS Safari。実機未完了は `UNVERIFIED` のまま。

## 第3周: 復元・容量・UX

**確認済み**
- `recovery-store.ts` にIndexedDBの所有権リース/ファイルハッシュ/保存領域の検査がある。
- `local-export-runtime.ts` / `export-queue.ts` は1件ずつ処理・ジョブ制限・一時停止を実装。
- Safariによるブラウザー保存領域の消去はあり得る。ユーザーの元素材の保存を必要とする。
- 最大256MiBの完成Blob、キューや保存領域の上限があり、10分以上の連続処理はiPhoneで未測定。

**CodexタスクB**
- 初回復元後の連続書き出し、同素材の再選択、保存失敗、低容量、Safari中断/再表示、2タブ競合、ページ離脱を回帰検査。
- 元素材と完成動画を勝手に削除しない。失敗時の案内を短く正確にし、修復手順を表示。
- 機能維持のままメモリ高水位を測り、大容量の入力で早期に安全な拒否を行う。WebCodecs導入は現状完了後の別フェーズ。

## 第4周: Blomp・クラウド・費用とセキュリティ

**確認済み**
- `server/storage/blomp-config.ts`: `BLOMP_ENABLED` が明示trueでない場合は無効。
- `server/storage/blomp-policy.ts`: multipart / browser transfer / free limitsの確認フラグ等で書き込みを保留する。
- `server/storage/blomp-trial-d-budget.ts`: ファイル2件/各512KiB/総3MiB/最大22要求のガードはあるが、現行API全経路へ実Blomp接続されていない。
- 実Blomp通信は未実施。署名URL・CORS・S3互換・料金/実容量・初回削除成功を断定できない。
- `server/worker/render/encode.ts`: `joined.mp4` と `candidate.mp4` が同時に存在し得るため、一時容量に余地がある。

**CodexタスクC（独立したPR）**
- Blomp書き込みはデフォルトOFF。ガードを全SDK/ブラウザ/OPTIONS/PUT/GET経路に結合し、所有者/上限が同一の永続カウンタで強制されることを模擬サーバーでテスト。
- 期限切れURL・CORS失敗・Content-Length違い・HTML応答・中断再開・重複操作・リダイレクト・権限切れ・容量不足・連続失敗をテスト。
- 実接続・実削除・課金条件の変更は所有者承認後のみ。今回の範囲では絶対に有効化しない。
- 独立して `joined.mp4` の削減可能性をFFmpegで実証する。MP4のfaststart・時刻・音声copy条件・出力ハッシュ・途中再開・ディスク見積りを同時検証。単純にファイルを削除して通したことにしない。

## 第5周: CI・本番保護・完了判定

**確認済み**
- 基準PR #36はOpen/Draft、HEAD `9369831`。当該SHAのCIと静的ビルドは成功、本番Pagesデプロイはスキップ。
- `server/playwright.config.ts` のWebKitはLinux上のPlaywrightであり、実iPhoneのブラウザー挙動・容量/音声/画面ロックを再現しきれない。
- Netlifyの隔離サイトで試験Dトップページは開けたが、MP3読込はタイムアウト。WebCodecs高速化は別フェーズ。

**Codexへの共通禁止事項**
- PR #36やmainの無断マージ、公開、課金、有料サービス登録、実Blomp接続/削除、ユーザー音源のコミットは禁止。
- 仕様変更・データ破壊・セキュリティ例外の導入は保留して所有者に確認。
- 全ての結果を「自動テスト済み」「Linux WebKit済み」「iPhone実機未検証」「実Blomp未検証」に区分する。
- タスクA→B→Cの順序。各タスクで5周（機能、互換、品質、復旧、セキュリティ/CI）を回して、独立した小さな変更として提出。

## 現状の総合判定

- 素材登録の小修正: 隔離ブランチに実装済み、CIとiPhone再確認が必要。
- 書き出しエンジン・長尺品質: **高優先、Codexに委譲**。
- IndexedDB復旧・iPhone容量: **中～高、状況を維持しつつ追加テスト**。
- Blomp実接続: **BLOCKED**。安全ガード/外部条件と所有者承認が揃うまで無効。
- 本番公開: **現時点では不許可**。CI成功と実用化完了を同一視しない。
