# Blomp 実用化の事前監査

2026-11-19の監査対象は Draft PR #36、ブランチ `feat/blomp-storage-phase1`、HEAD `006a80a6e2ac64d2baf436f91b2d17f285c65c70`。`main` は `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。元の作業ツリーは main 相当の `work` のため、対象ブランチを別に取得した。対象チェックアウトに AGENTS.md は見つからなかった。

## 5つの観点での事前監査

| 観点 | 確認した証拠と結果 |
| --- | --- |
| 仕様・完全性 | `server/storage/blomp-config.ts` と `blomp.ts` で既定OFF、固定エンドポイント、provider/location識別を確認。`server/api/main.ts`、原本アップロード、All Versions、FNF Showcase、`LocalExport.tsx` は既存経路。Blomp原本・完成品の受付、一覧、UI、永続台帳は実接続ゲート後。 |
| セキュリティ | `blomp-signing.ts` はJWTと所有者照合を署名前後に実施。公開ルートは未配備。公開前に永続カタログのRLS、共有レート制限、no-storeが必要。`blomp.ts` の検証用DELETEはadapterが生成した一意キーに限定。CLIの承認引数なしで `BLOMP_APPROVAL_REQUIRED` を確認。 |
| 安定性・復旧 | `blomp-verify.ts` の二重障害時に初期エラーがcleanup例外で隠れていた。安全な初期エラーコードを記録し、DELETEと不在確認を個別に出力するよう修正。二重障害とDELETE後もオブジェクトが見えるケースを追加テスト。途中素材と復旧は既存 `recovery-store.ts` と `export-queue.ts` を使用。 |
| 性能・費用 | Node 24.19.0、npm 11.9.0、AWS SDK 3.1161.0、Smithy NodeHttpHandler 4.14.1。SDKのHTTPS agentは環境プロキシを継承し、CLIのfetchは `--use-env-proxy`。接続5秒、要求とsocket idle各30秒、SDKは1回試行。Cloudの現行ポリシーにデータホストあり。通信成功は未確認。R2の `UploadService` はETagをMD5として照合しているため、そのまま接続できない。容量の裏付け、CORS、大容量通信の適格性は保留。 |
| 回帰・導入 | PR #36のHEADでCIとPagesワークフロー成功を確認。未マージPR #35、#34、#33、#32、#31、#30、#27、#11、#10、#8の変更パスを比較し、同一パスは#11のlockfileのみ。将来の統合では各PRのAPI・UI変更も再照合する。既存Node APIはSupabase JWTとPostgresを使用するため署名・認可の候補。稼働中の無料本番環境、利用枠とBlompへのegressは未確認。 |

環境変数の確認結果

| 変数 | 状態 |
| --- | --- |
| BLOMP_BUCKET | PRESENT |
| BLOMP_ACCESS_KEY_ID | PRESENT |
| BLOMP_SECRET_ACCESS_KEY | PRESENT |
| BLOMP_ENABLED | ABSENT |

ローカル差分で `npm test -- --maxWorkers=1` は55ファイル、485件成功、失敗・スキップ0件。Blomp単独再実行は6ファイル、86件成功で、全体485件に含まれる。typecheck、lint、API build、worker build、`git diff --check` は成功。ブラウザE2E、Blomp実接続、iPhone実機は今回未実施。PRのCIはリモートHEADの結果であり、ローカル差分には未実行。

## 公開資料の確認

| 項目 | 結果 |
| --- | --- |
| S3互換、署名形式の前提 | 公式サイトはS3互換と第三者クライアント連携を案内。WinSCPの案内にpath-style、us-east-1がある。個別のPUT、GET、HEADおよび署名付きGETは初回CLIによる実証待ち。 |
| Range、署名付きPUT、CORS | 公開資料でAxFluxoのオリジンからの動作を確定できない。サーバー署名付きGETとブラウザCORSは別の受入項目。 |
| Multipart、再開、abort | 公式フォーラムに分割と5 GBに関する説明がある。S3 APIでの作成、part署名、再開、完了、abortを個別に検証する必要がある。 |
| ETag、チェックサム | ETag=MD5、対応するチェックサムの種類とも未確認。既存R2の前提を流用しない。 |
| サイズ上限、転送量、頻度 | 公式フォーラムにはアプリ別の分割とプラン依存の帯域の記述。現行S3 APIでの正確な1要求・1オブジェクト上限、無料転送の計測期間、頻度制限、上限時の挙動は確認できない。 |
| 契約容量、実使用量、残量 | 公開プランは40 GB開始。対象アカウントの契約容量、実残量、公式usage API、未完了Multipart・ゴミ箱の算入は未確認。アプリ台帳だけでは外部消費を把握できないため、運用書き込みは停止状態。 |
| 維持条件、利用規約 | 公式サイト掲載規約は無料アカウントの1年間未アクセスを停止条件に記載。別の登録画面に2か月表記もあり、対象アカウントに適用される条件は未確認。第三者S3クライアントの案内はある。AxFluxoのアカウント共有型バックエンド利用に関する条件、無課金での上限挙動は未確定。 |

[公式プランとS3クライアント案内](https://www.blomp.com/) · [サイズと転送のサポート説明](https://support.blomp.com/viewtopic.php?t=1764) · [利用規約](https://www.blomp.com/terms-and-conditions/) · [登録画面の規約](https://bng3.blomp.com/register)

## 統合の受入条件

- Blompへの保存は、サーバーで所有者・ファイルID・保存先と容量予約を解決してから許可する。予約と完了反映は永続ストアで原子的に行い、再試行による重複計上を防ぐ。実使用量の取得が途絶えた場合や外部の消費を含めた安全な残量が不明の場合は受付を止める。
- CORSとMultipartが確認できた場合は、Safariから `Blob.slice` と低並列でデータを直接転送する。パートの再開情報を保持し、署名再発行時に再認可する。サイズとSHA-256が検証された成果物を公開する。
- CORSが使えない場合、署名付きURLのトップレベル遷移によるダウンロードを別途検証できる。ブラウザからの直接アップロードは保留し、端末保存を続ける。アップロードの代替は所有者の承認を得たクライアント運用か、無料枠を実証した有界の中継を別途評価する。

## 実機受入とロールバック

統合と個別承認が揃った後、iPhone Safariの検証環境で小さな非機密の動画・音声・画像を保存し、再読み込み後に一覧、SHA-256、ダウンロードを確認する。All VersionsとFNF Showcaseで端末書き出し後の保存と取得を確認し、転送の中断、キャンセル、再試行、端末ファイル保持を試す。Safariを閉じて開き直した場合は復旧を確認する。1 GB、2 GB、5 GBは、各回の空き容量・転送枠と個別承認が揃った場合のみ順に進める。公開環境に運用書き込みを有効化する前に、容量不明や容量不足で受付が停止することを確認する。

現時点のロールバックは、別チェックアウトの今回のCLI差分を取り消し、検証CLIを停止する。環境設定・DB・保存データの操作は不要。後続統合の導入時は受付を先に停止し、保存先付きメタデータと端末コピーを保持したままAPIとUIを前の版へ戻せることを受入条件にする。
