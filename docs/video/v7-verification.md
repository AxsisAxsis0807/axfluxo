# V7 検証記録

2026-11-02、managed Linux/Node 24、system Chromium。実providerに接続せず、ローカルDBと合成バイトで確認。
本番有効化は未完了。全flagは既定OFF。cloud作成・契約・本番migration・main push・merge・deployなし。

| 検証                             | 結果                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| TypeScript / ESLint              | 成功、警告0                                                  |
| 全unit/integration               | 全32 files / 304 tests成功。最終対象2 files / 18 testsも成功 |
| V7 native PostgreSQL             | 12/12成功（最終専用loopback DB、複数connection、RLSロール）  |
| root / `/axfluxo/` static export | 両方成功、既定flag OFF                                       |
| root / `/axfluxo/` 全E2E         | 各118/118成功（既存全回帰＋V7追加10）                        |
| 新API・render・削除・通知bundle  | 成功                                                         |
| 既存動画UI Chromium              | 8/8成功（All Versions/FNF/preview/upload/session）           |
| 実機iPhone Safari                | 未実施、下表を参照                                           |

追加自動試験は未認証、一般user、別owner、membership失効、期限切れ、identity不一致、
写真未確認拒否、同一キー重複と内容違い409、確認transaction途中障害、未確認31日保持、
原本/完成物metadata DELETE権限拒否、pin保持、legacy bucket保持、
provider DELETE応答喪失後の再開、deleting参照拒否、重複worker、quota一度だけ解放、
Push 410失効、503再試行・成功dedup、partial batch最新attempt判定、巨大MP4全量fetch回避、
共有cancel、signed URL identity/期限、allowlist endpoint、namespace分離を含む。

Chromium E2Eは日本語名、小File共有cancel、10GiB相当metadataの直接リンク、明示写真確認、
token更新失敗、Push拒否をmockで検証。巨大MP4の実バイト転送や写真アプリ保存を証明しない。
SWの更新メッセージと通知遷移はVMで検証し、manifestのroot/basePathと無cache設計は静的artifactで確認。
実browserのOS Push配信、SW更新中のプロセス破棄、ホーム画面追加の成否は未検証。

全E2Eの初回は公開認証build設定なしで開始したため途中停止。
CIと同じ公開Supabase設定でbuildし直し、認証通信は既存mockで実行する。実メール・実ユーザーは使わない。
既存テストの削除・skip・期待値緩和なし。

## 実機・provider受入表

| 項目                                        | 状態 / 必要な証跡                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| iPhone Safari・PWAで小MP4を写真へ保存       | 未検証。OS/version、共有先、写真で再生・長さ/音声確認、明示確認前後のserver状態                                  |
| 共有cancel / 巨大MP4→Files→写真             | 自動mockのみ。実容量・転送中断・空き容量不足・Safari再開が必要                                                   |
| 背景化・OSタブ破棄・再ログイン / 同期復帰   | pageshow/online/visibilityで再読込を実装。実機で受付job/完成物保持と復帰を確認する                               |
| ホーム画面Push許可・拒否・購読解除・失効    | 拒否/410の自動試験のみ。Apple配信・VAPID・画面消灯中受信は未検証                                                 |
| 通知tap / SW更新・新旧SW共存                | VM試験のみ。実機で未保存Workflowを維持し、保存後明示更新を確認する                                               |
| 専用R2 bucket権限・conditional DELETE・404  | fake/設定拒否試験のみ。原本bucketアクセス不可を管理側で確認し、専用テストobjectだけで検証する                    |
| R2のCORS / signed URL期限切れ               | GET/HEADを明示app originに限定する設定が必要。実provider未接続                                                   |
| WebKit自動試験                              | 既存構成あり。起動を試みたが実行ファイル未導入で起動不可（テスト本体未実行）。WebKitは実機Safariの代わりにしない |
| 更新Dockerfileのimage実build / cloud worker | bundle確認のみ。image再build・provider接続・本番worker起動は未実施                                               |

未検証項目を合格へ変更せず、本番enable前に管理者の別承認と証跡を追記する。
追加SQLはローカルの専用test DBだけに適用。rollbackは新入口/通知/削除worker/受付を独立停止し、
既存DB・原本・未確認完成物・job・checkpointを維持する。安全なlegacy移行と一時物GCは未実装で全件保持。

入口flag ONの追加ローカルbuildでも、未適用の画像編集テキストを入力して別タブを開き、
元のeditor DOMが接続されたまま・文字が保持され・編集を継続できることをChromiumで確認。
その後は既定OFFのroot/basePath buildへ戻す。実機のOSタブ破棄を再現した試験ではない。
