# Blomp Phase 3 互換性検証と技術監査

## 作業基準と実サービスの状態

- `/workspace/axfluxo-blomp`、`feat/blomp-storage-phase1`、開始／現在のHEAD `006a80a6e2ac64d2baf436f91b2d17f285c65c70`。Node v24.19.0。Draft #36のheadをGitHubで確認し、前回の22ファイルの差分を保持。適用対象のAGENTS.mdは見つからなかった。
- `BLOMP_BUCKET` PRESENT、`BLOMP_ACCESS_KEY_ID` PRESENT、`BLOMP_SECRET_ACCESS_KEY` PRESENT、`BLOMP_ENABLED` ABSENT。
- Phase 1の7項目PASS（1024 B、4.240秒）は既報。Phase 3の実サービスは、無料契約状況、対象アカウントの空き容量、転送・リクエスト残枠、超過時に課金せず停止することを確認できる証拠がないため開始していない。公式の40 GBは開始容量の案内。
- Phase 3の実行回数0、HTTP 0、アップロード／応答0 B、生成キー0、開始Multipart 0。専用データの残存なし。署名付きPUT、認証付きGET、署名付きGET/HEAD、Range、HTTP／ブラウザCORS、Multipart開始・PART・ETag・ListParts・再開・完了・SHA-256、abort、期限切れ、DELETE、後処理と不在確認はすべて実サービスで **NOT RUN**。
- 判定は S3実サービス互換性 **NOT RUN（今回）**、ブラウザ直接転送 **UNVERIFIED**、ローカル実装 **PARTIAL**（実ブラウザ専用の通信監査は計画段階）、本番実用化 **BLOCKED**。Blompの既定OFF、16 MiBの直接素材取り込み上限、本番のアダプター停止を維持。

[Draft PR #36](https://github.com/AxsisAxsis0807/axfluxo/pull/36) · [Blomp公式プラン](https://www.blomp.com/) · [Blomp利用規約](https://www.blomp.com/terms-and-conditions/) · [転送条件の説明](https://support.blomp.com/viewtopic.php?t=1764)

## 専用CLIと実行手順

追加ファイルは `server/scripts/verify-blomp-compatibility.ts`、`server/storage/blomp-compatibility.ts`、`server/storage/blomp-compatibility-transport.ts`、`server/tests/blomp/compatibility.test.ts`、本記録。既存変更は `server/package.json` のコマンド登録と、`server/storage/blomp.ts` の既存HTTPSハンドラー再利用。Phase 1 CLI、公開ルート、R2、DB、UIは今回変更していない。

1. 対象の無料アカウントが設定済みのBlomp資格情報と対応すること、空き容量64 MiB以上、超過時に課金されず停止することを公式資料または対象アカウントの安全な読み取り情報で確認する。同じアカウントの並行利用による消費も考慮する。
2. 確認時刻（ISO UTCの `checkedAt`）、真であることを確認した `configuredAccountConfirmed`、`freePlan`、`noBillOnOverage`、根拠のある整数 `availableBytes` を、権限0600の作業外JSONへ記録する。資格情報、アカウント名、署名URLは記録しない。証拠の有効時間は15分。転送・リクエスト残枠は不明なら省略できる。既知の場合は `transferRemainingBytes` と `requestAllowance` を記録し、64 MiBと60件の下限を確認する。
3. 確認後、専用プロセスで一度だけ起動する。起動ゲートは承認フラグ2つ、ローカル証拠、既存Blomp設定を検証し、TLS検証が明示的に無効なら停止する。Phase 1 CLIを再実行しない。

```sh
BLOMP_PHASE3_EVIDENCE_FILE=/absolute/private/account-evidence.json \
BLOMP_ENABLED=true npm run verify:blomp-compatibility --workspace server -- \
  --approved-compatibility --approved-cleanup
```

固定ホストのpath-style・us-east-1・SigV4・SDK 1試行、接続5秒／要求・応答30秒。同じガードでSDK・署名済みHTTP・OPTIONSを数える。通常48回＋後処理用12回、転送64 MiBのうち1 MiBを後処理に確保する。HEADのContent-Lengthはメタデータとして扱う。成功したファイルGETはContent-Lengthが確定したHTTP応答だけを受け取り、XMLなども保守的にカウンターへ加算。予期しない応答は破棄する。カウンターは送信予約・読み取ったHTTP本文に基づく。HTTPヘッダー、TLS、カーネルの先読みによる生パケット計測は対象外。正常系モックでは34 HTTPリクエスト。想定正常データ転送は31 MiB + 2 KiB程度、これに小さな制御本文を加える。ブラウザの自発通信は当該CLIに含めない。

実行IDから `axfluxo/connection-tests/<id>/{single,multipart,cancel}.bin` を生成する。Multipartは最大2件で、サーバー応答でキーとUpload IDを確認して該当操作に結合する。指定キー以外と任意ID、一覧、リダイレクト、一括削除を拒否。開始結果が不明なら新規Multipartを停止し、未確定IDでabortしない。Abort後の `ListParts` は `NoSuchUpload` を確認し、HEADの対象不在とは別に記録する。完了応答喪失時は対象HEADのサイズ一致を確認できた場合だけ後処理へ進み、Completeは繰り返さない。PUT/PARTの応答が不明でサーバー側処理が継続し得る場合は、そのキーへの削除・abortを保留する。

モード0700の一時ディレクトリにジャーナルとチェックポイントを0600で書く。秘密や署名URLを含めない。中断試験ではPart 1を送信後、ローカルに記録した結果を読み直して同じUpload IDを照合し、Part 2だけを実行する。異常終了後はジャーナルを根拠にキーと確定IDを確認し、勝手に再実行・再削除しない。今回のゲート停止ではディレクトリも作成していない。

## 5周監査

| 周 | 確認方法・証拠 | 発見、重大度、修正／再検証 | 残件 |
| --- | --- | --- | --- |
| 1. 仕様・S3互換 | `blomp.ts`、`blomp-compatibility.ts`、AWS仕様、Phase 1結果。実SDKシリアライズを偽転送先に接続し、1 MiBのPUT、GET/HEAD、206、8+1 MiBのMultipart、署名有効期限と不透明ETagを検査。 | 高。Phase 2のPART署名を通常PUTの根拠にできない。専用CLIだけにPUT署名を追加。Rangeを200で返すケースをGET成功・Range失敗と分離。 | Blomp実互換は保留。HTTP CORSと実ブラウザの読取可否は別。 |
| 2. セキュリティ・承認 | `blomp-config.ts`、`server/api/blomp/router.ts` とMigration 008、`blomp-compatibility-transport.ts`、既存署名試験。 | 高。キーだけでは任意Upload IDの誤操作を防ぎ切れない。キー・IDの結合、固定ホスト、DELETEのcleanup限定、設定・承認と料金の起動ゲートを実装。無効TLS、別キー・別ID、無証拠、59回の残枠を隔離で拒否。 | 公開APIの既定OFF継続。資格情報・署名URLは出力しない。 |
| 3. 安定性・復旧 | `verify-blomp-compatibility.ts` と孤立関連テスト、Phase 2のlease・容量・所有者テスト。応答喪失、abort失敗、既存セッション照合を模擬。 | 高。Upload ID不明の後も別Multipartを始める経路を修正。作成不明なら再作成せず、完了応答喪失はHEADで照合し、abortの失敗時は再試行しない。 | 未確定データが生じた場合は安全な記録から個別確認。実Blompの遅延PARTの終了条件は未確認。 |
| 4. 性能・費用・容量 | 48/60リクエスト境界と64 MiB予算、通信ヘッダー、Nodeの読み取りストリーム、Phase 2の条件、事業者規約。 | 高。未確定ファイル長と無制限レスポンスは転送上限を保証できない。既知のContent-Lengthと毎回の予算予約を要求し、リダイレクト・過大応答・gzipを拒否。受信時もカウントし異常中断。 | 実際の帯域／残量／費用、iPhoneメモリ、長時間SHA-256は未計測。 |
| 5. 回帰・導入 | mainへのPR差分、前回監査、全Vitest、静的E2E、Chromium全体、WebKit実行ファイル、ビルド。 | 中。既存Chromiumの復旧キューで完了表示待ちが再現。テスト期待値やCIは変更なし。WebKit実行ファイルが見つからず、本体を実行できない。 | 全件数は下記。iPhone実機と本番導入は保留。 |

[AWSの署名付きURL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [Multipart制約](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) · [ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html) · [Complete](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) · [Abort](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)

## 月額0円の運用候補

| 候補 | 公式情報と制約 | 未確認・判定 |
| --- | --- | --- |
| 既存Node API／Blitz | 無料はカード不要、16歳以上。公開アプリは15分休止し、APIクライアントからは復帰できない。無料は全アプリで予約RAM 512 MB、10 GB、管理DB 1個、送信50 Mbit/s。Docker・HTTPS・暗号化環境変数を提供。現行規約の無料無期限はEU・EEA・英国・スイスの登録に限定。その他の新規アカウントは7日で、既存アカウントには経過措置がある。 | 既存アカウント適用条件、SDKからBlompへのegress、実CPU・要求期限・実際のDB接続と長時間SHA-256は未確認。通常のAPIから無人復帰できない。 |
| Render | 無料Node、0.1 CPU／512 MB、750時間/月、15分で休止。受信リクエストで復帰。支払手段がなければ転送枠超過時に停止。環境変数とDB接続を提供。無料DBは期限付きで、外部発信量が大きい無料サービスは停止の可能性。 | 年齢要件、対象者の無カード利用可否、egressの経路と転送・要求時間、DB保有、長時間SHA-256を実運用で満たせるか未確認。公式は無料インスタンスの本番運用を推奨していない。 |
| Koyeb | 無料instanceの案内とカード要求の記載がある。 | 無カード条件に合わない。対象年齢、Blompのegress、DB、CPU／要求時間と長時間検証は適合未確認。 |

採用先なし。既存Node APIは再利用の第一候補。料金・規約の調査にアカウント登録や試用開始は含めていない。

[Blitz規約](https://blitz.cloud/terms/) · [Blitzの年齢条件](https://blitz.cloud/privacy/) · [Blitz制限](https://blitz.cloud/docs/limits/) · [Blitz環境変数](https://blitz.cloud/docs/settings-and-files/) · [Render無料](https://render.com/docs/free) · [Render計算量](https://render.com/docs/compute-plans) · [Render規約](https://render.com/terms) · [Koyeb料金FAQ](https://www.koyeb.com/docs/faqs/pricing) · [Koyeb規約](https://www.koyeb.com/docs/legal/terms)

## 次のiPhone 16e受入とロールバック

1. 個別承認されたHTTPS検証環境と専用アカウントを用意する。公開サイトは更新せず、検証環境の実際のoriginとブラウザ版を記録する。GitHub Pagesのoriginは `https://axsisaxsis0807.github.io` で、`/axfluxo/` はパス。実ブラウザから発生するOPTIONS、PUT、GET、HEADを予算に含められるよう、専用の方式・承認が必要。
2. iPhone 16eのSafariで検証用ログインを行い、Blomp状態・空き・予約を確認。小さな専用動画・音声・画像をFilesから保存し、一覧反映と取得を確認する。All VersionsとFNF Showcaseで対応素材を開いて端末書き出しし、Filesへの端末保存後、同じ完成物をBlompへ明示保存して取得する。
3. 転送中に中断・再読み込みして同じファイルを再選択する。同名・別バイトの素材が拒否され、既存の完了パートが再送されないことを確認する。JavaScriptが本文、ETag、Content-Length、Content-Rangeを取得可能か実測する。ブラウザCORSの成功は実origin別に扱う。
4. 小容量 → 16 MiB前後 → 100 MiB前後 → 1 GB → 2 GB → 5 GB。各段階で実残量、転送枠、メモリ・発熱、端末空き、終了後照合、後処理の権限を確認し個別承認を得る。16 MiBを超える素材は今回の取り込み上限を維持し、端末にダウンロードして選択する。読み戻しが期限や無料枠に収まらない場合は公開を保留する。

ロールバックは専用CLIの使用を止め、Phase 3差分のみ取り消す。保存済みPhase 2差分とローカルデータを保持する。実通信試験を始めた場合は実行ジャーナルを保存し、承認された対象だけを照合する。将来の本番DB変更、コミット、PR更新、デプロイ、機能有効化はそれぞれ別承認。

## 回帰結果・変更パス

| 対象 | 成功 | 失敗 | 未実施 |
| --- | ---: | ---: | ---: |
| 全Vitest 57ファイル | 503 | 0 | 0 |
| 既存静的サイトE2E（認証モック、desktop/mobile） | 124 | 0 | 0 |
| Chromium動画全体 | 44 | 1 | 0 |
| WebKit動画 | 0 | 0 | 45 |
| 合計（重複する対象再実行を除く） | 671 | 1 | 45 |

Blomp単独104件（503件に含む）。Phase 3専用の9ケースを最終ガード修正後に個別再確認した。認証設定、署名、ネットワーク対象範囲、上限、明示後処理、モック正常系・障害系を検査。WebKitはPlaywright所定の実行ファイルが存在せず、今回は起動エラーを試験失敗件数に加えていない。Chrome/ChromiumではiPhone実機を代替できない。

Chromiumの全体再実行では、前回失敗したトリム、素材選択、端末書き出し、3ジョブ等を確認。残る復旧キュー1件は端末ファイルAの保存リンク待ちで失敗。全体終了後の単独再試験も同じ25秒待ちで失敗。再試験時はAが93%で映像または音声の生成失敗、Bは完了し保存リンク表示。変更前mainでも同じケースの失敗をPhase 2で確認済み。全体結果と対象再実行の結果は個別に扱う。

Node型検査、lint、API・workerビルド、Pages用静的配布と秘密情報の静的境界検査、diff whitespaceチェックが成功。Phase 3で本番API／UI／CI／DBスキーマに変更なし。現在の未コミット差分は28ファイル（前回22＋今回6）。#10、#30、#31、および#11のlockfileに既存差分とのパスの重複。Phase 3の新規のパス重複は確認されなかった。各PRの取り込み時には再照合する。

## 限定再承認後の更新

所有者のダッシュボード確認は40 GBプラン、使用量0 Byte、空き40 GB、期限Unlimited。公式規約には有料アカウントに切り替えた日からの課金、公式サポートには異常な帯域利用時にプラン変更を求める場合があるとの説明がある。対象アカウントのS3転送・リクエスト超過時に課金が発生しないことは確認できていない。自動承認レビューは、確認済みとして証拠ファイルを生成するコマンドを拒否した。コマンドは起動せず、実通信0、転送0 B、生成キー0、開始Multipart 0。全実サービス項目は引き続きNOT RUN。

不足が判明している残枠は拒否し、不明の数値は省略可能に変更した。無料プラン・容量と、超過時に課金されないことの確認は実行条件として保持する。隔離テストで残枠の省略、既知の不足、課金条件未確認の拒否、60リクエスト、64 MiB、専用キー・Upload ID、後処理の制限を再確認した。
