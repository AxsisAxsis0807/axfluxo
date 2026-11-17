# Drime後続フェーズ調査

2026-11-17。公開公式資料だけを参照。アカウント接続、PAT発行、API呼出し、設定変更なし。
Drime自体をS3互換endpointと仮定しない。REST制御APIと署名されたデータ転送先を区別する。

| 項目         | 資料から確認したこと                                                                          | 後続の確認/候補                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 認証         | 自分のツールはPAT、他人のDrime account連携はOAuth。Bearerで認証                               | 所有者PATを共有browserへ配布しない。多user時の所有権モデルを承認する                                         |
| 最小権限     | PATはAll/Read Only/Restricted。Restrictedはresource毎No Access/Read/Write、WriteはRead含む    | Allを避けFiles Write、必要時Folders Writeを候補にroutesと照合。ファイル作成と削除を分離できるか確認          |
| token寿命    | PATは削除まで有効と資料記載                                                                   | server Secretsのみ。失効/rotation時は受付保留、復旧データ保持                                                |
| upload       | 小容量multipart/form-dataとpresign、大容量はDrime制御APIでmultipartを作成/署名/完了/entry登録 | API入力schemaと実上限を固定後に別adapter。S3長期キーは不要と考えられるが未実証                               |
| resume       | uploaded-parts照会/abortが資料にある                                                          | jobにaccount/workspace/parent ID/upload ID/part番号/size/ETag/SHAを結合。完了応答喪失時のentry重複回避を確認 |
| download     | 公式indexにDownload File endpointあり                                                         | 詳細pageの取得に失敗。認証の必要性、redirect先allowlist、期限/Range、stream方式は未確認                      |
| file ID      | entry登録の段階がある。pathだけをIDにしない                                                   | provider + account/workspace + entry IDを保存。改名/移動の検証、他user ID拒否                                |
| checksum     | SHA-256 verify-integrity APIが資料にある                                                      | サーバー側実バイト検証方法/サイズ上限/遅延/権限を実試験。ETagをchecksumにしない                              |
| capacity     | GET /user/space-usage?workspaceId=0 にused/available                                          | 実値/単位/availableの意味/ゴミ箱・版・途中part計上/反映遅延は未検証                                          |
| trash/delete | indexにtrash/permanent deleteとrestoreがある                                                  | 詳細page取得に失敗。復旧期限/容量解放/権限は未確認。Phase 1は実装なし                                        |
| CORS         | guideは署名URLへのPUTを説明                                                                   | 実origin、OPTIONS、GET/HEAD/PUT、ETag公開、Range、URL再発行、Safari中断を実試験。実現可能とはまだ認定しない  |

想定rootは `AxFluxo/Temporary/{Segments,Checkpoints,Recovery,Staging}`。
APIでparent entry IDを確認してから確定する。パス名は権限分離ではない。
owner/job/renderer-version/source-hash/segment-rangeを保存し、異なる入力のcheckpointを再利用しない。
復旧に必要な区間は保持し、完成物のBlomp保存と実SHA検証後も参照確認なしに削除しない。
Drime20GBは所有者表示値。Blomp40GBと合算せず、unknown/limit時は受付を止める。

## 公式参照と取得制約

- [Introduction](https://docs.drime.cloud/introduction) / [公式index](https://docs.drime.cloud/llms.txt)
- [PAT認証・権限](https://docs.drime.cloud/authentication)
- [Upload guide](https://docs.drime.cloud/uploads-guide)
- [使用量API](https://docs.drime.cloud/api-reference/user/get-space-usage)
- [SHA-256整合性API](https://docs.drime.cloud/api-reference/files/verify-file-integrity)
- [指定されたPAT案内](https://drime.cloud/support/integrations-and-api/api-tokens)

index掲載の.mdページは取得失敗し、通常HTMLで上記主要pageを確認した。
Download/Deleteの詳細は再取得も失敗。無料枠のAPI利用可否、rate/transfer limit、維持条件、
利用規約のアプリ用途への適用、PATの各route権限は未確認。仕様不明を推測で埋めない。

## Blomp/AWS参照

- [Blomp公式](https://www.blomp.com/): S3、path-style、us-east-1、40GBの公開案内を確認。
- [S3設定の公式support link](https://support.blomp.com/viewtopic.php?t=6478): 403で本文取得不能。endpointは所有者指定を固定。CORS/conditional/multipart詳細の根拠にはしない。
- [Blomp規約](https://www.blomp.com/terms-and-conditions/): free accountの1年未アクセスによる停止条件がある。APIだけのアクセスが維持条件になるかは未確認。
- [AWS SDK v3 S3 considerations](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html): presignerとstream responseを確認。
- 実際の導入SDK 3.1161.0のtypes/署名生成を隔離テストで確認。AWS仕様に合うこととBlomp実互換を区別する。
