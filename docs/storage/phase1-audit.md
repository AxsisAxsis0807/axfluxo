# Phase 1 五周監査・検証記録

基準main `1c88efb614e3d15ef9a8f371e8016076a8c7ef68`。
実行環境: managed Linux / Node24 / 既存lockfile。実キーなし、実provider未接続。
監査はこの差分の範囲。実サービス受入やiPhone試験の代わりにはしない。

## 第1周 — 最新仕様・範囲

発見: mainの既存UploadServiceはR2専用設定だけでなくETag=MD5にも依存。
未マージDrive/worker PRをmainに含まれると誤認すると基盤を壊す。
対応: Blompを別moduleに隔離。StoredPart型だけ共有し、既存MultipartStorageへの接続は保留。
動画export、Blitz、main API/worker、DB、既存参照を変更しない。provider/location付き新参照を準備。
再確認: 既存source/.github/storage configとの差分なし。受付flag/削除機構へのimportなし。

## 第2周 — セキュリティ・認証・秘密

発見: SDK raw error/stream途中errorには秘密やURLが含まれ得る。発行中にJWT/権限が失効する可能性。
対応: 固定error code、stream例外安全化、署名前後のJWT/catalog再確認。
再監査でJavaScriptの末尾anchorが終端改行を許す点を発見し、bucket/keyの制御文字を明示拒否。関連テストを追加して再実行。
任意key/URL/bucket/owner指定拒否、exact endpoint、region固定、短命署名、local rate制限。
テスト削除は同一adapterが生成した専用keyだけ。運用削除は提供しない。
再確認: JWT実署名/issuer/audience/期限/改竄/他owner/権限失効/SSRF入力/別bucket/ref拒否を追加テスト。
front source/配布物の秘密変数名・ダミー秘密値検査は実行記録参照。実秘密を用いた検出試験は行わない。
public署名APIは未配備。共有rate制限・永続catalog/RLS・HTTP no-storeは公開前の条件。

## 第3周 — 互換性・大容量・容量

発見: Range要求が無視される、HEADサイズ欠損、不正paginationを成功とすると危険。
対応: 206と数値Content-Range、非負safe integerサイズ、pagination進行/上限を検証。
MD5/conditional/checksum/CORS互換性は個別unverified。SDKはWHEN_REQUIRED。
接続/要求/idle timeout、retry1回。streamを優先し、テストuploadだけ64KiB上限。
再確認: 実SDK SigV4/固定host/path style/60秒/署名content-lengthを確認。
1/2/5GiBは署名metadataだけ。小容量バイトだけ隔離SDK transportを通した。
Blomp40GBとDrime20GBは独立、実使用量/無料制限が不明なため運用受付は未接続のまま。

## 第4周 — 復旧・整合性・回帰

発見: PUT/完了応答喪失後の無条件再試行やcleanup失敗の隠蔽は誤報になる。
対応: SDK自動retryを制限。完了喪失は固定errorで返しHEAD/実SHAによるcaller照合を要求。
検証ツールは同一実行objectだけfinally cleanupし、cleanup失敗は明示的失敗。
再確認: SHA不一致/署名URL403/通信切断/timeout/401/403/404/429/5xx/容量507/重複制限を隔離試験。
既存テストを削除/skip/緩和しない。全体回帰の失敗/実行制約は下の結果に分けて記録。

## 第5周 — 無料運用・本番保護・rollback・差分

発見: main pushはPagesを自動配信する。既存削除は物理権限分離必須。
対応: 作業branch/Draft PRのみ。workflow追加/dispatchなし。既存削除へ接続しない。
依存追加/課金/登録/カード/本番DB/デプロイ/mergeなし。
Blomp規約の1年未アクセス条件を記録。転送/API/ゴミ箱/維持条件の不明点は所有者確認が必要。
再確認: staged差分/秘密パターン/新規ファイル/既存機能不変を確認してcommitする。
rollbackは追加commitのrevertまたは検証停止。データ削除や移行を伴わない。

## 実行結果

最終実行結果は以下へ追記する。実行中/失敗/未検証をPASSへ置換しない。

- 新規Blomp 5 suites: **75 PASS**。SDK transportは隔離mock。実サービスの成功ではない。
- 初回全体Vitestは通常sandboxでHTTPのloopback通信が遮断され14件timeout、レンダー系4件も失敗。
  途中で停止し、ローカル通信可能な実行環境で同一suiteを再実行した。初回を成功として数えない。
- 初回Next buildはcompile後のTypeScript showConfig解析で停止。通信可能な実行環境で再実行。
- 初期単独型検査では新規mockの型エラーを検出し修正（SDK overload、TypedArray/Response型）。テスト期待値は緩和していない。
- `npm run verify:blomp --workspace server` は引数なしでBLOMP_APPROVAL_REQUIRED/exit1を確認。接続承認flagを付けていない。
  初回tsx CLIのIPC listenがsandboxで拒否されたため、node --import tsxに変更し同じsandboxで再確認した。

## 未検証・受入保留

Blomp実認証、bucket正式名、CORS/OPTIONS、GET/PUT/HEAD/Range/Multipartの実互換、署名の実受理、
MD5/ETag/checksum/conditional、無料枠の実制約/利用量、1/2/5GB実転送。
Drime実PAT/API/大容量/復旧/削除/usage/CORS。実機Safari/背景化/タブ破棄/メモリ・disk。
署名API実行環境・永続catalog/認可・共有rate limit・書込quota/冪等/実SHA公開判定。
Blomp実接続および削除には別承認が必要。Phase 2全体フローは未実装。
