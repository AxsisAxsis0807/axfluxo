# 動画統合 V0 — 独立契約と試験基盤

2026-11-01 JST。開始時mainはGitHub APIで `367fb02570b4782aa5f51e892718fc473b376c59` と再確認し、同一HEADから `feat/video-v0` を作成。README、ADR 001–006を調査。リポジトリと祖先にAGENTS.mdなし。最初のgit fetchはproxy接続で失敗したためAPIで確認し、接続復旧後に再fetchする。

未マージPRはdraft #8（head `6b638020994fd94d78b9a97a1772b6599ff531c5`）のみ。固定入力・上流準備・作業版復帰は既存Workspace/runner/UIの変更。今回の変更は新規domain/service/test/docsだけで、PR #8の変更ファイルと重ならない。既存AssetRef・libraryReference・save receiptと新しい動画契約は相互変換しない。将来接続時は正確なversion/hashのadapter、上流実行の副作用境界、作業版/適用版/snapshotの区別を維持する。ADR番号007を使わず競合を避ける。

## V0の契約

- All Versionsは全clipを順序付き配列で保持。IDは一意。区間は原本時刻の半開区間 `[startUs,endUs)`、markerは原本時刻で両端を除く内部位置、昇順かつ重複禁止。区間の再利用は許可する。配列順だけが連結順。
- 時刻は0以上の安全な整数microseconds（最大2^53−1）。中間演算はBigInt。出力は60fps整数frame、最近傍・half-up。clipごとではなく累積microseconds境界を丸める。ゼロ長・0frame・合計overflowを拒否する。
- FNF設定はmode/paddingUsのみ。範囲の未送信値と譜面名はUIの一時フォーム。`toPersistentDocument` はallowlist投影し、strict schemaは混入を拒否する。送信済み値のみFNF実行snapshotへ固定する。FNF範囲は連結後のmicroseconds、昇順・非overlap・正長・文書内。隣接は許可。範囲ごとに名前1つ、大小文字違いの同名も拒否。
- 原本参照はlibrary/file/version/hashを必須にしlatest解決なし。原本metadataは別契約、`addOriginalVersion` は同じidentityをadd制約で拒否し上書きしない。bytes/hashの実測検証は将来のmedia adapter責務。V0にアップロード・ダウンロード・decoder・render実行はない。
- render jobは固定snapshotと状態、outputはjob参照・version/hash・fps/frameCount。成功前にoutputを公開しない。保存確認はunconfirmed/confirmed/failedを明示し、confirmedにはreceiptと固定参照が必要。端末ダウンロード完了は保存確認の代用にならない。
- 全schemaはstrictかつversion literal 1。未知versionを変換・上書きせず拒否。新規型の導入のみで既存文書形式・バックアップに差分なし。

## ローカルDB / migration / rollback

`openDeveloperDB()` を明示的に呼ぶ場合のみ `axfluxo-developer` v1を作成する。import時は開かない。storesはdocuments/originalVersions/snapshots/renderJobs/saveConfirmations（id keyPath）。原本追加はtransaction完了後のみ成功。blocked/VersionError/quota/abortは失敗とし、versionchangeでcloseする。既存4DBは一切開かず変更しない。

新DB初期作成のみ。既存DBのcopy/import/migrationなし。将来v2は追加store/indexと原子的upgradeを別レビューし、未知の新版を削除やdowngradeで回避しない。文書CAS、snapshotのdeep freeze、bytesの照合、job状態遷移と保存receiptの原子的対応は接続フェーズで実装する。V0は公開入口なし、rollbackは新機能呼出しを無効化するだけ。新旧DBと全行を保持する。

## APIとエラーの予定

既存APIに変更なし。本番HTTP endpointなし。追加済み関数: schema.parse/safeParse、toFrame、concatenateFrames、toPersistentDocument、openDeveloperDB、addOriginalVersion。

次フェーズ候補: saveDocument(expectedRevision)、createFnfSnapshot(submittedForm)、enqueueRender(snapshot)、commitRenderOutput(jobId, output)、confirmSavedOutput(outputId, receipt)、resolveExactMediaVersion(ref)。既存runnerへ暗黙登録せず能力注入と明示操作で接続する。

| code                                                   | 意味                           |
| ------------------------------------------------------ | ------------------------------ |
| VIDEO_INTERVAL                                         | 不正・ゼロ長・原本外区間       |
| VIDEO_CLIP_ORDER                                       | clip ID重複                    |
| VIDEO_MARKER                                           | marker端点・範囲外・重複・逆順 |
| VIDEO_TIME_OVERFLOW / VIDEO_ZERO_FRAMES                | 時刻合計上限 / 丸め後0frame    |
| VIDEO_RANGE_OVERLAP                                    | FNF範囲overlap・逆順・文書外   |
| VIDEO_NAME_COUNT                                       | 範囲数と名前数の不一致         |
| VIDEO_FILENAME / VIDEO_FILENAME_COLLISION              | 危険名 / 名前衝突              |
| VIDEO_JOB_OUTPUT                                       | jobとoutputの不整合            |
| VIDEO_IMMUTABLE_VERSION                                | 原本identity再登録             |
| VIDEO_STORAGE / VIDEO_STORAGE_BLOCKED / VIDEO_CONFLICT | 保存失敗 / blocked / CAS競合   |

Zodの標準issueは構造・型・未知schema versionを表す。上記semantic codeはcustom issue.message、時刻関数と原本追加ではError.message。HTTP用の統一error envelopeは未実装。将来VIDEO_SCHEMA_VERSION/VIDEO_HASH_MISMATCH/VIDEO_MISSING_VERSIONをadapter境界で割り当てる。

## 未確定事項と自律補完

正式なAll Versions/FNF外部仕様なし。V0では名前数＝提出範囲数、内部marker＝原本絶対時刻、範囲＝連結後時刻、60fps固定と判断。paddingUsは設定記録だけで、範囲の自動拡張は未実装。codec/container、音声同期、色空間、cloud認可、容量上限、snapshot保持期間、重複名のUnicode正規化は次フェーズ。クラウド契約・作成・本番migration・公開は行わない。

合成fixture方針は [fixtures.md](fixtures.md)、実行記録は [verification.md](verification.md)。
