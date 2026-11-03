# Developer Studio 有効化準備の検証記録

2026-11-03 JST。branch `feat/developer-studio-access`、base main `279701a`。
本番設定・repository variablesは変更していない。新APIの本番接続先やDB/membership設定は未提供。
本番有効化完了ではなく、安全な段階有効化を準備する変更である。

| 検証                            | 結果                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------- |
| TypeScript / ESLint             | 成功、警告0                                                                       |
| 全unit/integration              | 34 files / 314 tests成功                                                          |
| 署名付きJWT/membership          | 実ES256署名、別署名、期限切れ、一般user、未登録、失効をprivate schemaで検証       |
| read-only services API          | 001のみで全media機能を未準備と返す。quota/budget・schema・FNF受付・容量保留を検証 |
| 既存動画UI Chromium             | 9/9成功（元のAV/FNF/preview/upload/session＋codec）                               |
| root ON build + access E2E      | build成功、10/10（PC/iPhoneサイズ）                                               |
| /axfluxo/ ON build + access E2E | build成功、10/10（PC/iPhoneサイズ）                                               |
| root OFF build + 既存全E2E      | build成功、118/118（PC/iPhoneサイズ）                                             |
| /axfluxo/ OFF build + 既存全E2E | build成功、118/118（PC/iPhoneサイズ）                                             |
| OFF access E2E root / basePath  | 各10/10成功（PC/iPhoneサイズ）                                                    |
| 最終認可unit再実行              | 2 files / 10 tests成功                                                            |
| 新API bundle                    | 成功                                                                              |
| git diff --check                | 成功                                                                              |

ON時のbrowser試験はAPI認可応答とSupabase sessionの合成fixtureを使う。
実本番の正規開発者ログインを確認したものではない。
server統合試験では実際に署名を検証し、user metadata/localStorageを権限として扱わない。
本番公開前preflightは実APIへ匿名GET/不正token GET/OPTIONSを送り401・CORS・no-storeを確認する実装。
実API未提供のため、この作業ではその本番接続preflightを実行していない（unitはtransport mock）。

## 追加E2Eの確認範囲

- OFFではAPIへ接続せず、新しいIDBを開かない。
- ONでも未認証/一般userの直接URLからeditorや素材をmountしない。
- 一般userのmetadata/localStorageにdeveloperと書いても昇格しない。
- server認可済みの場合だけ入口を表示し、44px以上の操作面で別タブにStudioを開く。
- 未適用のWorkflow画像編集DOMと文字を維持し、既存Workflowに戻って編集を続けられる。
- 2つのeditorを別タブで選択・起動し、iPhoneサイズで横にはみ出さない。
- 再読込、API失効、token更新失敗、接続失敗、前景復帰を安全に処理する。
- 同じownerのSIGNED_IN再通知と、一時的な接続失敗で未保存FNF入力DOMを保持し、serverへの再認可後に復帰する。
- backendが未準備なら素材・cloud同期・renderを正常動作として表示しない。
- FNFはtemplate/usernameだけを端末保存し、未送信range/譜面名を保存しない。

最初のOFF全E2Eは116成功/2失敗。旧動画診断画面の「保留中」表示と戻るリンクが不足していた。
既存テストを変更せず、APIに接続しない停止画面の互換表示を復元し、root・basePath版とも118件すべて成功した。
既存E2Eのsourceに削除・skip・期待値緩和はない。
OFFの全回帰と、ONの認可・公開導線試験を別artifactで実行するmatrixをCIへ追加する。
Pagesにuploadするのはrepository variablesで再buildしたartifactのみ。

## 未検証・本番有効化までの残作業

| 項目                                                         | 状態                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 実Developer API URL / HTTPS reverse proxy                    | 接続先未提供・未確認                                                                              |
| JWT issuer/audience/JWKS / private DB / developer membership | 本番設定・正規user UUID未確認。GitHub名から推定せず管理者が登録を確認する                         |
| 001〜007 migration                                           | この作業では本番適用なし。既存記録は未適用であり、現在の対象DBの適用状況は未確認                  |
| R2非公開原本 / 専用output bucket / quota / worker            | 接続情報なし。cloud上に新規作成していない                                                         |
| 書き出し・signed URL・保存確認後削除                         | fake/既存自動試験のみ。原本・未確認完成物を保持する                                               |
| Push / VAPID / PWA実通知                                     | 本番設定未確認。通知失敗時にrender結果を消す変更はない                                            |
| 実機iPhone Safari                                            | 未実施。入口タップ、keyboard/IME、横向き、スクロール、更新、背景/OSタブ破棄、元タブ復帰を確認する |
| 写真アプリ保存・巨大MP4 / Files / share cancel               | 実機未検証。共有開始/成功は保存完了にしない                                                       |
| 実provider IAM / conditional DELETE / CORS                   | 未検証。原本bucketへのDELETE不可を管理側で確認する                                                |
| GitHub CI                                                    | PR作成後に確認。ローカル結果と混同しない                                                          |

既存API・管理接続の場所とdeveloper登録状況を指定後、実アカウントの肯定/否定系を確認する。
その後、ユーザー承認を得てPhase A/Bのvariablesを設定・公開し、Phase C/Dは実接続と実機の証跡後に別々に有効化する。
有料契約・課金可能なリソース作成・本番データ変更は、このPRで承認済みとは扱わない。
main直接push、自動merge、本番deploy、本番migrationは実施しない。

## 変更ファイル

- `.env.example`
- `.github/workflows/ci.yml`
- `.github/workflows/pages.yml`
- `README.md`
- `developer.playwright.config.ts`
- `docs/video/developer-activation-verification.md`
- `docs/video/developer-activation.md`
- `package.json`
- `scripts/check-developer-api.mjs`
- `scripts/check-developer-config.mjs`
- `server/README.md`
- `server/api/app.ts`
- `server/api/developer-services.ts`
- `server/api/main.ts`
- `server/contracts/developer-services.ts`
- `server/tests/developer-access.test.ts`
- `src/app/developer/all-versions/page.tsx`
- `src/app/developer/fnf-showcase/page.tsx`
- `src/app/developer/library/page.tsx`
- `src/app/developer/preview/page.tsx`
- `src/app/developer/studio/page.tsx`
- `src/app/developer/video/page.tsx`
- `src/features/all-versions/AllVersionsEditor.tsx`
- `src/features/developer/CloudLibrary.tsx`
- `src/features/developer/DeveloperAccess.tsx`
- `src/features/developer/DeveloperEntry.tsx`
- `src/features/developer/DeveloperStudio.tsx`
- `src/features/developer/useDeveloperAccess.ts`
- `src/features/fnf-showcase/FnfShowcaseEditor.tsx`
- `src/features/workspace/WorkspaceShell.tsx`
- `src/services/video/api-client.ts`
- `src/services/video/developer-access.ts`
- `tests/developer-published/access.spec.ts`
- `tests/video/developer-access.test.ts`
